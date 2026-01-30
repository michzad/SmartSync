// Helpers.gs - API and utilities

function callWithRetry(apiFn, maxRetries) {
  if (maxRetries == null) maxRetries = 3;
  for (var i = 0; i <= maxRetries; i++) {
    try {
      return apiFn();
    } catch (e) {
      var errMsg = e && e.message ? e.message : String(e);
      if (i === maxRetries) {
        console.error("callWithRetry: all " + (maxRetries + 1) + " attempts failed: " + errMsg);
        if (e && e.stack) console.error(e.stack);
        throw e;
      }
      var msg = (errMsg || '').toLowerCase();
      if (msg.indexOf('429') !== -1 || msg.indexOf('500') !== -1 || msg.indexOf('rate limit') !== -1) {
        console.warn("callWithRetry: attempt " + (i + 1) + "/" + (maxRetries + 1) + " failed (retrying): " + errMsg);
        Utilities.sleep(Math.pow(2, i) * 1000);
        continue;
      }
      console.error("callWithRetry: attempt " + (i + 1) + " failed (no retry): " + errMsg);
      if (e && e.stack) console.error(e.stack);
      throw e;
    }
  }
}

function getTableDataByName(targetTableName, maxRetries) {
  if (maxRetries == null) maxRetries = 3;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssId = ss.getId();
  try {
    var response = callWithRetry(function() {
      return Sheets.Spreadsheets.get(ssId, { fields: 'sheets(properties,tables)' });
    }, maxRetries);
    var foundTable = null, sheetName = '';
    if (response.sheets) {
      for (var i = 0; i < response.sheets.length; i++) {
        var sheet = response.sheets[i];
        if (sheet.tables) {
          for (var j = 0; j < sheet.tables.length; j++) {
            if (sheet.tables[j].name === targetTableName) {
              foundTable = sheet.tables[j];
              sheetName = sheet.properties.title;
              break;
            }
          }
          if (foundTable) break;
        }
      }
    }
    if (!foundTable) {
      console.warn('Table not found: ' + targetTableName);
      return null;
    }
    var rangeData = foundTable.range;
    var headerRowIndex = (rangeData.startRowIndex || 0) + 1;
    var startCol = (rangeData.startColumnIndex || 0) + 1;
    var endRow = rangeData.endRowIndex || headerRowIndex;
    var endCol = rangeData.endColumnIndex || startCol;
    var a1Range = "'" + sheetName + "'!" + convertToA1(headerRowIndex, startCol, endRow, endCol);
    var valueResponse = callWithRetry(function() {
      return Sheets.Spreadsheets.Values.get(ssId, a1Range);
    }, maxRetries);
    var values = valueResponse.values;
    if (!values || values.length === 0) return [];
    var headers = values[0];
    var dataRows = values.slice(1);
    return dataRows.map(function(row, i) {
      var obj = { _rowIndex: headerRowIndex + 1 + i };
      headers.forEach(function(h, idx) { obj[h] = row[idx] !== undefined ? row[idx] : ''; });
      return obj;
    });
  } catch (e) {
    var errMsg = e && e.message ? e.message : String(e);
    console.error('getTableData error for ' + targetTableName + ': ' + errMsg);
    if (e && e.stack) console.error(e.stack);
    return null;
  }
}

function trimTrailingEmptyRows(rows, notEmptyHeader) {
  if (!rows || rows.length <= 1) return rows;
  if (!notEmptyHeader) return rows;
  var checkIndex = rows[0].indexOf(notEmptyHeader);
  if (checkIndex === -1) return rows;
  var cutOff = rows.length;
  for (var i = rows.length - 1; i > 0; i--) {
    var val = rows[i][checkIndex];
    if (val === undefined || val === '' || val === null) cutOff--;
    else break;
  }
  return rows.slice(0, cutOff);
}

/**
 * Row count is sync-dependent: totalRequiredRows (header + data) only. No buffer.
 */
function calculateGridExpansion(sheetInfo, totalRequiredRows, width, settings) {
  if (totalRequiredRows > sheetInfo.grid.rowCount || width > sheetInfo.grid.columnCount) {
    var newRowCount = Math.max(totalRequiredRows, sheetInfo.grid.rowCount);
    var newColCount = Math.max(width, sheetInfo.grid.columnCount);
    sheetInfo.grid.rowCount = newRowCount;
    sheetInfo.grid.columnCount = newColCount;
    return {
      updateSheetProperties: {
        properties: { sheetId: sheetInfo.sheetId, gridProperties: { rowCount: newRowCount, columnCount: newColCount } },
        fields: 'gridProperties(rowCount,columnCount)'
      }
    };
  }
  return null;
}

function buildWriteRequests(sheetId, rowsToWrite, startRowIndex, mode) {
  var reqs = [];
  if (rowsToWrite.length === 0) return reqs;
  if (mode === 'replace' && startRowIndex === 0) {
    reqs.push({ updateCells: { range: { sheetId: sheetId }, fields: 'userEnteredValue' } });
  }
  var rowsData = rowsToWrite.map(function(row) {
    return {
      values: row.map(function(cell) {
        if (cell === null || cell === undefined) return { userEnteredValue: { stringValue: '' } };
        if (typeof cell === 'number') return { userEnteredValue: { numberValue: cell } };
        if (typeof cell === 'boolean') return { userEnteredValue: { boolValue: cell } };
        return { userEnteredValue: { stringValue: String(cell) } };
      })
    };
  });
  reqs.push({
    updateCells: {
      range: { sheetId: sheetId, startRowIndex: startRowIndex, startColumnIndex: 0 },
      rows: rowsData,
      fields: 'userEnteredValue'
    }
  });
  return reqs;
}

/**
 * Appends a log row. Timestamp uses "yyyy-MM-dd HH:mm:ss" (spreadsheet timezone) for consistency with control sheet datetime columns.
 */
/**
 * Appends one log row to the log sheet. If maxLogRows > 0 and data rows exceed it, deletes oldest data rows.
 * @param {SpreadsheetApp.Spreadsheet} ss - Active spreadsheet.
 * @param {string} logSheetName - Name of the log sheet.
 * @param {Object} item - { sheetId, mode }.
 * @param {boolean} hasError - Whether the run had an error.
 * @param {number} totalRows - Total rows synced.
 * @param {string} details - Log details string.
 * @param {number} [maxLogRows] - Max data rows to keep (0 or omitted = no limit).
 */
function logResult(ss, logSheetName, item, hasError, totalRows, details, maxLogRows) {
  var logSheet = ss.getSheetByName(logSheetName);
  if (!logSheet) return;
  var timestampStr = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm:ss");
  logSheet.appendRow([timestampStr, item.sheetId, item.mode, hasError ? "ERROR" : "SUCCESS", totalRows, details]);
  if (!maxLogRows || maxLogRows <= 0) return;
  var lastRow = logSheet.getLastRow();
  if (lastRow <= 1) return;
  var dataRows = lastRow - 1;
  if (dataRows <= maxLogRows) return;
  var numToDelete = dataRows - maxLogRows;
  var lastCol = logSheet.getLastColumn();
  if (lastCol < 1) return;
  var endDeleteRow = 1 + numToDelete;
  logSheet.getRange(2, 1, endDeleteRow, lastCol).deleteCells(SpreadsheetApp.Dimension.ROWS);
}

function updateTimestamp(sheetName, rowIndex, hasError, headers) {
  updateTimestampInTable(sheetName, rowIndex, headers.last_upd, hasError ? 'Error' : new Date());
}

/**
 * Writes last_update_datetime (or targetHeader) in the same format as last_modified_datetime:
 * "yyyy-MM-dd HH:mm:ss" (spreadsheet timezone), or the string "Error" when hasError.
 * Keeps both datetime columns consistent with the script.
 */
function updateTimestampInTable(sheetName, rowIndex, targetHeader, customValue) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIndex = headers.indexOf(targetHeader) + 1;
  if (colIndex <= 0) return;
  var valueToSet;
  if (customValue === undefined || customValue === null) {
    valueToSet = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm:ss");
  } else if (typeof customValue === "object" && customValue instanceof Date) {
    valueToSet = Utilities.formatDate(customValue, ss.getSpreadsheetTimeZone(), "yyyy-MM-dd HH:mm:ss");
  } else {
    valueToSet = String(customValue);
  }
  sheet.getRange(rowIndex, colIndex).setValue(valueToSet);
}

function ensureLogSheetViaApi(ssId, sheetName, maxRetries) {
  if (maxRetries == null) maxRetries = 3;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(sheetName)) return;
  try {
    callWithRetry(function() {
      return Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: sheetName, gridProperties: { frozenRowCount: 1 } } } }] }, ssId);
    }, maxRetries);
    var headers = ['Timestamp', 'Sheet ID', 'Mode', 'Status', 'Total Rows', 'Details'];
    Sheets.Spreadsheets.Values.update({ values: [headers] }, ssId, "'" + sheetName + "'!A1:F1", { valueInputOption: 'RAW' });
  } catch (e) {
    console.error('ensureLogSheetViaApi: ' + (e && e.message ? e.message : String(e)));
    if (e && e.stack) console.error(e.stack);
  }
}

function analyzeSyncResult(resultObj) {
  var hasError = false, totalRows = 0, detailsArr = [];
  if (!resultObj) return { hasError: true, totalRows: 0, logDetails: 'No result' };
  for (var k in resultObj) {
    var outcome = resultObj[k];
    if (outcome.status === 'Error') {
      hasError = true;
      detailsArr.push(k + ': ERR[' + (outcome.message || 'Unknown') + ']');
    } else {
      totalRows += (outcome.count || 0);
      detailsArr.push(k + ': ' + outcome.status + '(' + (outcome.count || 0) + ')');
    }
  }
  return { hasError: hasError, totalRows: totalRows, logDetails: detailsArr.join('; ') };
}

function extractIdFromUrl(url) {
  if (!url) return '';
  var match = (url + '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : url;
}

function isValidDate(d) {
  return d instanceof Date && !isNaN(d.getTime());
}

function convertToA1(row1, col1, row2, col2) {
  return columnToLetter(col1) + row1 + ':' + columnToLetter(col2) + row2;
}

function columnToLetter(column) {
  var temp, letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}
