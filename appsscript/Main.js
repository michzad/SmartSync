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

function runAutoSync(options) {
  options = options || {};
  var settings = getUserConfig();
  for (var k in options) if (options.hasOwnProperty(k)) settings[k] = options[k];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssId = ss.getId();
  var config = getDataRangesConfig(settings);
  validateConfig(config);
  var urlData = getTableDataByName(settings.controlTableName, settings.maxApiRetries);
  if (!urlData || urlData.length === 0) { console.warn("No data in control table."); return; }
  var h = settings.headers;
  var requiredKeys = [h.id, h.last_mod, h.last_upd];
  if (!requiredKeys.every(function(k) { return Object.prototype.hasOwnProperty.call(urlData[0], k); })) {
    throw new Error("Control table header consistency failed: expected columns " + requiredKeys.join(", ") + ". Check the urls sheet row 1.");
  }
  var targetState = fetchSmartTargetState(ssId, config, settings.maxApiRetries);
  var queue = buildSyncQueue(urlData, targetState, config, settings);
  if (queue.length === 0) { console.log("All up to date."); return; }
  ensureInfrastructure(ssId, config, targetState, settings);
  ensureLogSheetViaApi(ssId, settings.logSheetName, settings.maxApiRetries);
  SpreadsheetApp.flush();
  for (var i = 0; i < queue.length; i++) {
    var item = queue[i];
    console.log("Processing " + item.sheetId + " Mode: " + item.mode);
    try {
      var sourceValuesMap = readAndTrimSourceData(item.sheetId, config, settings.maxApiRetries);
      var result = masterSync(item.sheetId, config, item.mode, targetState, ssId, sourceValuesMap, settings);
      var analyzed = analyzeSyncResult(result);
      if (shouldLogInMain(settings, analyzed.hasError, analyzed.logDetails)) {
        logResult(ss, settings.logSheetName, item, analyzed.hasError, analyzed.totalRows, analyzed.logDetails, settings.maxLogRows);
      }
      updateTimestamp(settings.controlSheetName, item.rowIndex, analyzed.hasError, settings.headers);
    } catch (e) {
      console.error("FAILURE " + item.sheetId + ": " + (e && e.message ? e.message : String(e)));
      if (e && e.stack) console.error(e.stack);
      if (shouldLogInMain(settings, true, "CRITICAL: " + e.message)) {
        logResult(ss, settings.logSheetName, item, true, 0, "CRITICAL: " + e.message, settings.maxLogRows);
      }
      updateTimestamp(settings.controlSheetName, item.rowIndex, true, settings.headers);
    }
    Utilities.sleep(settings.sleepTimeMs);
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
 * Określa potrzebę synchronizacji dla wiersza tabeli kontrolnej (błędy + daty).
 * Zwraca "no_action" (błąd lub źródło aktualne) albo "need_work" (trzeba sync lub append; sync vs append ustala porównanie z destination).
 * @param {string} lastModValue - last_modified_datetime from control table.
 * @param {string} lastUpdValue - last_update_datetime from control table.
 * @returns {"no_action"|"need_work"} "no_action" gdy błąd lub modyfikacja <= last update; "need_work" gdy trzeba odświeżyć lub dodać.
 */
function getSyncNeed(lastModValue, lastUpdValue) {
  var updStr = (lastUpdValue != null && typeof lastUpdValue === "string") ? lastUpdValue.trim() : "";
  if (updStr === "Error" || updStr === "") {
    return updStr === "Error" ? "no_action" : "need_work";
  }
  var modDate = new Date(lastModValue);
  var updDate = new Date(lastUpdValue);
  if (isValidDate(modDate) && isValidDate(updDate) && updDate < modDate) return "need_work";
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
    var need = getSyncNeed(row[h.last_mod], row[h.last_upd]);
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
