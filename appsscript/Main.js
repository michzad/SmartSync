// Main.gs

/**
 * Returns true if runAutoSync should write to the log sheet for this result (logLevel: None/Errors/Warnings/Basic/All).
 * @param {Object} settings - User config with logLevel.
 * @param {boolean} hasError - Whether the sync had an error.
 * @param {string} logDetails - Details string (e.g. may contain "Skipped" for warnings).
 * @returns {boolean}
 */
function shouldLogInMain(settings, hasError, logDetails) {
  var level = settings && settings.logLevel ? settings.logLevel : "Basic";
  if (level === "None") return false;
  if (level === "Errors") return hasError === true;
  if (level === "Warnings") return hasError === true || (logDetails && (logDetails + "").indexOf("Skipped") !== -1);
  if (level === "Basic" || level === "All") return true;
  return true;
}

function doGet(e) {
  e = e || {};
  var params = e.parameter || {};
  if (params.page === "developer") {
    return HtmlService.createHtmlOutputFromFile("Developer")
      .setTitle("Smart Sync – Developer")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }
  return HtmlService.createHtmlOutputFromFile("Manual")
    .setTitle("Smart Sync User Manual")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu("Smart Sync").addItem("Run Auto Sync", "runAutoSync").addSeparator().addItem("Settings", "showSettings").addToUi();
  } catch (e) { console.log("UI menu not created."); }
}

function showSettings() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile("Settings").setTitle("Smart Sync Settings"));
}

/**
 * Check (Drive dates) then sync rows flagged by that check. Entry point for Execute and menu.
 * @returns {string}
 */
function runCheckAndSync() {
  var config = getUserConfig();
  var result = performCheck(config);
  if (!result || !result.success) {
    throw new Error("Check failed. Sync aborted.");
  }
  runAutoSync({ sinceLastCheck: true });
  var s = result.stats;
  return "Sync completed. Checked: " + s.checked + ", Changed: " + s.changed + ", Errors: " + s.errors;
}

function runAutoSync(options) {
  options = options || {};
  var settings = getUserConfig();
  for (var k in options) if (options.hasOwnProperty(k)) settings[k] = options[k];
  var sinceLastCheck = options.sinceLastCheck === true;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssId = ss.getId();
  var config = getDataRangesConfig(settings);
  validateConfig(config);
  var urlData = getTableDataByName(settings.controlTableName, settings.maxApiRetries);
  if (!urlData || urlData.length === 0) { console.warn("No data in control table."); return; }
  var h = settings.headers;
  var requiredKeys = [h.id, h.source_mod, h.last_sync, h.last_check, h.skip_reason];
  if (!requiredKeys.every(function(k) { return k && Object.prototype.hasOwnProperty.call(urlData[0], k); })) {
    throw new Error("Control table header consistency failed: expected columns " + requiredKeys.join(", ") + ". Recreate the control table from Settings.");
  }
  var targetState = fetchSmartTargetState(ssId, config, settings.maxApiRetries);
  var queue = buildSyncQueue(urlData, targetState, config, settings);
  if (sinceLastCheck && typeof getLastCheckPendingIds === "function") {
    var pendingIds = getLastCheckPendingIds();
    if (pendingIds.length > 0) {
      var pendingSet = {};
      for (var pi = 0; pi < pendingIds.length; pi++) pendingSet[pendingIds[pi]] = true;
      queue = queue.filter(function(item) { return pendingSet[item.sheetId]; });
    } else {
      queue = [];
    }
  }
  if (queue.length === 0) {
    console.log("All up to date.");
    if (typeof setLastSyncTimestamp === "function") setLastSyncTimestamp();
    return;
  }
  ensureInfrastructure(ssId, config, targetState, settings);
  ensureLogSheetViaApi(ssId, settings.logSheetName, settings.maxApiRetries);
  SpreadsheetApp.flush();
  var hadErrors = false;
  for (var i = 0; i < queue.length; i++) {
    var item = queue[i];
    console.log("Processing " + item.sheetId + " Mode: " + item.mode);
    try {
      var sourceValuesMap = readAndTrimSourceData(item.sheetId, config, settings.maxApiRetries);
      var result = masterSync(item.sheetId, config, item.mode, targetState, ssId, sourceValuesMap, settings);
      var analyzed = analyzeSyncResult(result);
      if (analyzed.hasError) hadErrors = true;
      if (shouldLogInMain(settings, analyzed.hasError, analyzed.logDetails)) {
        logResult(ss, settings.logSheetName, item, analyzed.hasError, analyzed.totalRows, analyzed.logDetails, settings.maxLogRows);
      }
      updateRowAfterSync(settings.controlSheetName, item.rowIndex, settings.headers, analyzed.hasError, analyzed.hasError ? analyzed.logDetails : "");
    } catch (e) {
      hadErrors = true;
      var critMsg = e && e.message ? e.message : String(e);
      console.error("FAILURE " + item.sheetId + ": " + critMsg);
      if (e && e.stack) console.error(e.stack);
      if (shouldLogInMain(settings, true, "CRITICAL: " + critMsg)) {
        logResult(ss, settings.logSheetName, item, true, 0, "CRITICAL: " + critMsg, settings.maxLogRows);
      }
      updateRowAfterSync(settings.controlSheetName, item.rowIndex, settings.headers, true, critMsg);
    }
    Utilities.sleep(settings.sleepTimeMs);
  }
  if (!hadErrors && typeof setLastSyncTimestamp === "function") {
    setLastSyncTimestamp();
  }
}

/**
 * Zwraca Source_ID z wiersza destination: obsługuje zarówno tablicę obiektów (row.Source_ID), jak i tablicę tablic (row[0]).
 * @param {Object|Array} row - Wiersz z targetState.values (obiekt z kluczami lub tablica).
 * @returns {string|null} Wartość Source_ID lub null.
 */
function getSourceIdFromRow(row) {
  if (!row) return null;
  if (typeof row === "object" && !Array.isArray(row) && row.Source_ID != null) return String(row.Source_ID);
  if (Array.isArray(row) && row[0] != null) return String(row[0]);
  return null;
}

/**
 * Określa potrzebę synchronizacji dla wiersza tabeli kontrolnej.
 * @param {string} sourceModValue - source_last_modified_date
 * @param {string} lastSyncValue - last_successful_sync_date
 * @param {string} skipReason - skip_reason (non-empty → skip)
 * @returns {"no_action"|"need_work"}
 */
function getSyncNeed(sourceModValue, lastSyncValue, skipReason) {
  if (typeof isRowSkipped === "function" && isRowSkipped(skipReason)) {
    return "no_action";
  }
  var src = typeof normalizeControlDateCell === "function"
    ? normalizeControlDateCell(sourceModValue)
    : (sourceModValue != null ? String(sourceModValue).trim() : "");
  var sync = typeof normalizeControlDateCell === "function"
    ? normalizeControlDateCell(lastSyncValue)
    : (lastSyncValue != null ? String(lastSyncValue).trim() : "");
  if (!src) return "no_action";
  if (!sync) return "need_work";
  var modDate = new Date(src);
  var syncDate = new Date(sync);
  if (isValidDate(modDate) && isValidDate(syncDate) && syncDate < modDate) return "need_work";
  return "no_action";
}

/**
 * Buduje kolejkę sync/append: krok 1 – kandydaci z urls (getSyncNeed); krok 2 – porównanie z destination (match → sync, brak matcha → append). Bez prune.
 * @param {Array<Object>} urlData - Dane tabeli kontrolnej urls.
 * @param {Object} targetState - Stan destination (sheets, values).
 * @param {Object} config - Konfiguracja tabel (getDataRangesConfig).
 * @param {Object} settings - Ustawienia (headers).
 * @returns {Array<{sheetId: string, rawId: string, mode: string, rowIndex: number}>} Kolejka: sync, potem append.
 */
function buildSyncQueue(urlData, targetState, config, settings) {
  var h = settings.headers;
  var candidates = [];

  for (var i = 0; i < urlData.length; i++) {
    var row = urlData[i];
    var rawId = row[h.id];
    if (!rawId) continue;
    if (typeof isRowSkipped === "function" && isRowSkipped(row[h.skip_reason])) continue;
    var need = getSyncNeed(row[h.source_mod], row[h.last_sync], row[h.skip_reason]);
    if (need === "no_action") continue;
    candidates.push({ sheetId: extractIdFromUrl(rawId), rawId: rawId, rowIndex: row._rowIndex });
  }

  var destIds = new Set();
  for (var k in config) {
    var sheetName = config[k].sheet_name;
    var data = targetState.values.get(sheetName) || [];
    var isArrayOfArrays = data.length > 0 && Array.isArray(data[0]);
    var startIdx = isArrayOfArrays ? 1 : 0;
    for (var j = startIdx; j < data.length; j++) {
      var id = getSourceIdFromRow(data[j]);
      if (id) destIds.add(id);
    }
  }

  var queue = [];
  var c;
  for (var ci = 0; ci < candidates.length; ci++) {
    c = candidates[ci];
    if (destIds.has(c.sheetId)) queue.push({ sheetId: c.sheetId, rawId: c.rawId, mode: "sync", rowIndex: c.rowIndex });
  }
  for (ci = 0; ci < candidates.length; ci++) {
    c = candidates[ci];
    if (!destIds.has(c.sheetId)) queue.push({ sheetId: c.sheetId, rawId: c.rawId, mode: "append", rowIndex: c.rowIndex });
  }
  return queue;
}
