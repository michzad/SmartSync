// SyncEngine.gs
// ==========================================
// SYNC ENGINE (CORE LOGIC)
// ==========================================

/**
 * Orchestrates sync for one source: processes each table and applies batch updates.
 * @param {string} sourceId - Source spreadsheet ID.
 * @param {Object} config - Table config from getDataRangesConfig (sourceName -> { range, not_empty_column, sheet_name }).
 * @param {string} mode - "append" | "sync" | "replace".
 * @param {Object} targetState - Fetched target state (sheets + values).
 * @param {string} destSsId - Destination spreadsheet ID.
 * @param {Map<string, Array<Array>>} sourceValuesMap - Table name -> rows.
 * @param {Object} settings - Full settings (maxApiRetries, grid, etc.).
 * @returns {Object} Map of tableName -> { status, count? }.
 */
function masterSync(sourceId, config, mode, targetState, destSsId, sourceValuesMap, settings) {
  const results = {};
  const requests = [];

  for (const [tableName, cfg] of Object.entries(config)) {
    const sourceRows = sourceValuesMap.get(tableName);

    if (!sourceRows || sourceRows.length === 0) {
      results[tableName] = { status: "Skipped", message: "Empty Source" };
      continue;
    }

    const tableRequests = processTableDataSync(
      tableName,
      cfg,
      sourceRows,
      targetState,
      sourceId,
      mode,
      settings
    );

    if (tableRequests.reqs.length > 0) {
      requests.push(...tableRequests.reqs);
      results[tableName] = tableRequests.result;
    } else {
      results[tableName] = { status: "Skipped", count: 0 };
    }
  }

  if (requests.length > 0) {
    const response = callWithRetry(() => Sheets.Spreadsheets.batchUpdate({ requests: requests }, destSsId), settings.maxApiRetries);
    if (response.replies) {
      response.replies.forEach(reply => {
        if (reply.addTable && reply.addTable.table) {
          const table = reply.addTable.table;
          const sId = table.range.sheetId;
          for (const info of targetState.sheets.values()) {
            if (info.sheetId === sId) {
              info.tableId = table.tableId;
              break;
            }
          }
        }
      });
    }
  }

  return results;
}

/**
 * Computes new data state and build update requests for one table.
 * @param {string} tableName - Destination table name.
 * @param {Object} cfg - { range, not_empty_column, sheet_name }.
 * @param {Array<Array>} sourceRows - Source rows (header + data).
 * @param {Object} targetState - sheets + values.
 * @param {string} sourceId - Source spreadsheet ID.
 * @param {string} mode - "append" | "sync" | "replace".
 * @param {Object} settings - Config.
 * @returns {{ reqs: Array<Object>, result: Object }}
 */
function processTableDataSync(tableName, cfg, sourceRows, targetState, sourceId, mode, settings) {
  const sheetName = cfg.sheet_name;
  const sheetInfo = targetState.sheets.get(sheetName);

  if (!sheetInfo) {
    throw new Error("Infrastructure missing for sheet '" + sheetName + "'. Setup phase failed.");
  }

  const requests = [];
  let currentData = targetState.values.get(sheetName) || [];
  let headers = [];
  let width = 0;

  const isArrayOfObjects = currentData.length > 0 &&
    typeof currentData[0] === "object" &&
    currentData[0] !== null &&
    !Array.isArray(currentData[0]);

  if (isArrayOfObjects) {
    const requiredKeys = ["Source_ID"].concat(sourceRows[0] || []);
    for (let r = 0; r < currentData.length; r++) {
      const row = currentData[r];
      for (let k = 0; k < requiredKeys.length; k++) {
        const key = requiredKeys[k];
        if (!Object.prototype.hasOwnProperty.call(row, key)) {
          throw new Error("Target sheet '" + sheetName + "' row " + (r + 1) + " missing required column '" + key + "'.");
        }
      }
    }
    headers = requiredKeys.slice();
    width = headers.length;
    const rowsAsArrays = currentData.map(row =>
      headers.map(col => (row[col] !== undefined && row[col] !== null ? row[col] : ""))
    );
    currentData = [headers].concat(rowsAsArrays);
  } else {
    if (currentData.length === 0 && sourceRows.length > 0) {
      headers = ["Source_ID"].concat(sourceRows[0] || []);
      width = headers.length;
    } else {
      headers = currentData[0] || [];
      width = headers.length;
      if (currentData.length > 0) {
        const firstCol = headers[0] != null ? String(headers[0]).trim() : "";
        const expectedCols = (sourceRows[0] && sourceRows[0].length) ? sourceRows[0].length + 1 : 1;
        if (firstCol !== "Source_ID" || headers.length !== expectedCols) {
          throw new Error("Target sheet '" + sheetName + "' header consistency failed: expected first column 'Source_ID' and " + expectedCols + " columns.");
        }
        const targetHeaderNames = headers.slice(1);
        const sourceHeaderNames = sourceRows[0] || [];
        for (var i = 0; i < targetHeaderNames.length; i++) {
          var targetVal = (targetHeaderNames[i] != null ? String(targetHeaderNames[i]).trim() : "");
          var sourceVal = (sourceHeaderNames[i] != null ? String(sourceHeaderNames[i]).trim() : "");
          if (targetVal !== sourceVal) {
            throw new Error("Source header mismatch in table '" + sheetName + "': column " + (i + 1) + " expected '" + targetVal + "', got '" + sourceVal + "'.");
          }
        }
      }
    }
  }

  const normalize = (row) => {
    const padded = [sourceId, ...row];
    if (padded.length > width) return padded.slice(0, width);
    while (padded.length < width) padded.push("");
    return padded;
  };

  let fullTableData = [];
  let rowsToWrite = [];
  let startRowIndex = 0;
  let affectedCount = 0;

  if (mode === "replace") {
    const newRows = sourceRows.slice(1).map(normalize);
    fullTableData = [headers, ...newRows];
    rowsToWrite = fullTableData;
    startRowIndex = 0;
    affectedCount = newRows.length;
  } else if (mode === "sync") {
    const keepRows = currentData.length > 0
      ? currentData.filter((r, i) => i === 0 || r[0] !== sourceId)
      : [];
    const newRows = sourceRows.slice(1).map(normalize);
    fullTableData = currentData.length === 0
      ? [headers, ...newRows]
      : [...keepRows, ...newRows];
    rowsToWrite = fullTableData;
    startRowIndex = 0;
    affectedCount = newRows.length;
  } else if (mode === "append") {
    const newRows = sourceRows.slice(1).map(normalize);
    affectedCount = newRows.length;
    if (currentData.length === 0) {
      fullTableData = [headers, ...newRows];
      rowsToWrite = fullTableData;
      startRowIndex = 0;
    } else {
      fullTableData = [...currentData, ...newRows];
      rowsToWrite = newRows;
      startRowIndex = currentData.length;
    }
  }

  if (affectedCount === 0 && mode === "append") {
    return { reqs: [], result: { status: "Skipped", count: 0 } };
  }

  const isNewSheetNoTable = !sheetInfo.tableId;
  if (isNewSheetNoTable && fullTableData.length > 0) {
    const requiredCols = headers.length;
    if (requiredCols > sheetInfo.grid.columnCount) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: sheetInfo.sheetId,
            gridProperties: { columnCount: requiredCols + 1 }
          },
          fields: "gridProperties(columnCount)"
        }
      });
      sheetInfo.grid.columnCount = requiredCols + 1;
    }
    const columnProperties = headers.map((colName, i) => ({
      columnIndex: i,
      columnName: String(colName),
      columnType: "TEXT"
    }));
    requests.push({
      addTable: {
        table: {
          name: tableName,
          range: {
            sheetId: sheetInfo.sheetId,
            startRowIndex: 0,
            endRowIndex: fullTableData.length,
            startColumnIndex: 0,
            endColumnIndex: headers.length
          },
          columnProperties: columnProperties
        }
      }
    });
    sheetInfo.tableId = "PENDING";
  }

  const gridReq = calculateGridExpansion(sheetInfo, fullTableData.length, width, settings);
  if (gridReq) requests.push(gridReq);

  const writeReqs = buildWriteRequests(sheetInfo.sheetId, rowsToWrite, startRowIndex, mode);
  requests.push(...writeReqs);

  targetState.values.set(sheetName, fullTableData);

  if (sheetInfo.tableId && sheetInfo.tableId !== "PENDING") {
    requests.push({
      updateTable: {
        table: {
          tableId: sheetInfo.tableId,
          range: {
            sheetId: sheetInfo.sheetId,
            startRowIndex: 0,
            endRowIndex: fullTableData.length,
            startColumnIndex: 0,
            endColumnIndex: width
          }
        },
        fields: "range"
      }
    });
  }

  return {
    reqs: requests,
    result: { status: mode, count: affectedCount }
  };
}

/**
 * Ensures sheets exist for all configured tables. Call once per run before processing any files.
 * Creates only missing sheets (addSheet); header and table are written with first data in processTableDataSync.
 * @param {string} ssId - Spreadsheet ID.
 * @param {Object} config - Table config from getDataRangesConfig.
 * @param {Object} targetState - Mutable state (sheets + values).
 * @param {Object} settings - Config (grid.frozenRows, maxApiRetries).
 */
function ensureInfrastructure(ssId, config, targetState, settings) {
  const sheetCreationRequests = [];
  const createdSheetNames = new Set();

  for (const [tableName, cfg] of Object.entries(config)) {
    const sheetName = cfg.sheet_name;
    if (!targetState.sheets.has(sheetName) && !createdSheetNames.has(sheetName)) {
      console.log("[Setup] Queueing creation for missing sheet: \"" + sheetName + "\"");
      sheetCreationRequests.push({
        addSheet: {
          properties: {
            title: sheetName,
            gridProperties: { frozenRowCount: settings.grid.frozenRows }
          }
        }
      });
      createdSheetNames.add(sheetName);
    }
  }

  if (sheetCreationRequests.length > 0) {
    const response = callWithRetry(() => Sheets.Spreadsheets.batchUpdate({ requests: sheetCreationRequests }, ssId), settings.maxApiRetries);

    response.replies.forEach(reply => {
      const props = reply.addSheet.properties;
      targetState.sheets.set(props.title, {
        sheetId: props.sheetId,
        tableId: null,
        grid: props.gridProperties
      });
      targetState.values.set(props.title, []);
    });
    console.log("[Setup] Sheet creation complete. Header and table are written with first data in processTableDataSync.");
  }
}

/**
 * Fetches sheet metadata and values for sheets from config. Uses getTableDataByName(tableName) per config entry; fallback A:columnToLetter when table not found.
 * @param {string} ssId - Spreadsheet ID.
 * @param {Object} config - Table config from getDataRangesConfig (sourceName -> { range, not_empty_column, sheet_name }).
 * @param {number} maxRetries - Retry count.
 * @returns {{ sheets: Map, values: Map }}
 */
function fetchSmartTargetState(ssId, config, maxRetries) {
  const meta = callWithRetry(() => Sheets.Spreadsheets.get(ssId, {
    fields: "sheets(properties(sheetId,title,gridProperties),tables)"
  }), maxRetries);

  const state = { sheets: new Map(), values: new Map() };

  meta.sheets.forEach(s => {
    const tableId = (s.tables && s.tables.length > 0) ? s.tables[0].tableId : null;
    state.sheets.set(s.properties.title, {
      sheetId: s.properties.sheetId,
      tableId: tableId,
      grid: s.properties.gridProperties
    });
  });

  for (const [tableName, cfg] of Object.entries(config)) {
    const sheetName = cfg.sheet_name;
    if (!state.sheets.has(sheetName)) continue;
    const sheetInfo = state.sheets.get(sheetName);
    const objData = getTableDataByName(tableName, maxRetries, ssId, meta);
    if (objData !== null) {
      state.values.set(sheetName, objData);
    } else {
      const endCol = (sheetInfo && sheetInfo.grid && sheetInfo.grid.columnCount) ? sheetInfo.grid.columnCount : 26;
      const range = "'" + sheetName + "'!A:" + columnToLetter(endCol);
      try {
        const resp = callWithRetry(() => Sheets.Spreadsheets.Values.get(ssId, range), maxRetries);
        state.values.set(sheetName, resp.values || []);
      } catch (e) {
        var errMsg = e && e.message ? e.message : String(e);
        console.warn("Smart fetch fallback for " + sheetName + ": " + errMsg);
        if (e && e.stack) console.error(e.stack);
      }
    }
  }
  return state;
}

/**
 * Reads source ranges and trims trailing empty rows per config.
 * @param {string} sourceId - Source spreadsheet ID.
 * @param {Object} config - Table config (range, not_empty_column).
 * @param {number} maxRetries - Retry count.
 * @returns {Map<string, Array<Array>>} Table name -> rows.
 */
function readAndTrimSourceData(sourceId, config, maxRetries) {
  const configEntries = Object.entries(config);
  const ranges = configEntries.map(([, cfg]) => cfg.range);

  const response = callWithRetry(() => Sheets.Spreadsheets.Values.batchGet(sourceId, { ranges: ranges }), maxRetries);
  const rawValues = response.valueRanges || [];

  const resultMap = new Map();
  configEntries.forEach((entry, index) => {
    const [tableName, cfg] = entry;
    const rows = (rawValues[index] && rawValues[index].values) ? rawValues[index].values : [];
    const trimmed = trimTrailingEmptyRows(rows, cfg.not_empty_column);
    resultMap.set(tableName, trimmed);
  });

  return resultMap;
}
