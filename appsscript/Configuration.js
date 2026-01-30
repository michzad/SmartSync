// Configuration.gs
var LIBRARY_VERSION = "1.4.6";

/** Contact info shown in Manual (e.g. email or "Contact: …"). Set by publisher. */
var PUBLISHER_CONTACT = "";
/** Full URL of the developer page. If empty, getManualData() uses web app URL + ?page=developer. */
var PUBLISHER_DEVELOPER_PAGE_URL = "";
/** Full URL of the Manual (web app). Used for the Manual link in Settings. Set by publisher. */
var PUBLISHER_MANUAL_URL = "";

var DEFAULT_CONFIG = {
  controlSheetName: "urls",
  controlTableName: "urls",
  logSheetName: "logs",
  logTableName: "logs_data",
  logLevel: "Basic",
  maxLogRows: 0,
  sleepTimeMs: 10,
  maxApiRetries: 3,
  grid: { frozenRows: 1 },
  headers: { id: "sheet_id", last_mod: "last_modified_datetime", last_upd: "last_update_datetime" },
  lastModSchedules: [],
  dataRanges: [],
  configFetcher: getDataRangesConfig
};
function getLibraryVersion() { return LIBRARY_VERSION; }

/**
 * Returns data for Manual/Developer pages: scriptId (from runtime), contactInfo, developerPageUrl.
 * Used only when the script runs as a web app (doGet) in the library project context.
 * @returns {{ scriptId: string, contactInfo: string, developerPageUrl: string }}
 */
function getManualData() {
  var scriptId = "";
  try { scriptId = ScriptApp.getScriptId(); } catch (err) { /* not in web app context */ }
  var contactInfo = (typeof PUBLISHER_CONTACT === "string") ? PUBLISHER_CONTACT : "";
  var developerPageUrl = (typeof PUBLISHER_DEVELOPER_PAGE_URL === "string" && PUBLISHER_DEVELOPER_PAGE_URL) ? PUBLISHER_DEVELOPER_PAGE_URL : "";
  if (!developerPageUrl) {
    try {
      var service = ScriptApp.getService();
      if (service) { developerPageUrl = service.getUrl() + "?page=developer"; }
    } catch (err) { /* ignore */ }
  }
  return { scriptId: scriptId, contactInfo: contactInfo, developerPageUrl: developerPageUrl };
}

/**
 * Returns the Manual URL for the link in Settings. Publisher sets PUBLISHER_MANUAL_URL in Configuration.js.
 * @returns {string}
 */
function getManualUrl() {
  return (typeof PUBLISHER_MANUAL_URL === "string") ? PUBLISHER_MANUAL_URL : "";
}

function getUserConfig() {
  try {
    var props = PropertiesService.getDocumentProperties();
    var savedJson = props.getProperty("USER_CONFIG");
    if (!savedJson) return DEFAULT_CONFIG;
    var saved = JSON.parse(savedJson);
    var out = {};
    for (var k in DEFAULT_CONFIG) out[k] = DEFAULT_CONFIG[k];
    if (saved.sleepTimeMs != null) out.sleepTimeMs = saved.sleepTimeMs;
    if (saved.maxApiRetries != null) out.maxApiRetries = saved.maxApiRetries;
    var logLevel = (saved.logLevel != null && typeof saved.logLevel === "string") ? saved.logLevel : DEFAULT_CONFIG.logLevel;
    if (["None", "Errors", "Warnings", "Basic", "All"].indexOf(logLevel) !== -1) out.logLevel = logLevel;
    else out.logLevel = DEFAULT_CONFIG.logLevel;
    var maxLogRowsVal = saved.maxLogRows;
    if (maxLogRowsVal != null) {
      var n = typeof maxLogRowsVal === "number" ? maxLogRowsVal : parseInt(maxLogRowsVal, 10);
      if (!isNaN(n) && n >= 0) out.maxLogRows = n;
      else out.maxLogRows = DEFAULT_CONFIG.maxLogRows;
    } else out.maxLogRows = DEFAULT_CONFIG.maxLogRows;
    out.grid = { frozenRows: DEFAULT_CONFIG.grid.frozenRows };
    out.lastModSchedules = Array.isArray(saved.lastModSchedules) ? saved.lastModSchedules : [];
    out.dataRanges = Array.isArray(saved.dataRanges) ? saved.dataRanges : [];
    if (saved.lastStatus && typeof saved.lastStatus === "object" && saved.lastStatus.control !== undefined) {
      out.lastStatus = saved.lastStatus;
    }
    return out;
  } catch (e) {
    console.warn("Config load: " + e.message);
    return DEFAULT_CONFIG;
  }
}

/**
 * Persists last-known status into USER_CONFIG so Settings can show it on load without calling getSystemStatus.
 * Called by the client after Check or after Create. Merges lastStatus into existing config; does not clear other fields.
 * @param {Object} status - Object from getSystemStatus (control, logs, setup, sourceFilesUrl?, logsUrl?).
 */
function persistLastStatus(status) {
  if (!status || typeof status !== "object") return;
  try {
    var props = PropertiesService.getDocumentProperties();
    var savedJson = props.getProperty("USER_CONFIG");
    var obj = savedJson ? JSON.parse(savedJson) : {};
    obj.lastStatus = status;
    props.setProperty("USER_CONFIG", JSON.stringify(obj));
  } catch (e) {
    console.warn("persistLastStatus: " + (e && e.message ? e.message : String(e)));
  }
}

function saveUserConfig(payload) {
  if (!payload) throw new Error("No data from settings form.");
  try {
    var toNum = function(val, def) { var p = parseInt(val, 10); return isNaN(p) ? def : p; };
    var logLevelVal = (payload.logLevel != null && typeof payload.logLevel === "string") ? payload.logLevel : DEFAULT_CONFIG.logLevel;
    if (["None", "Errors", "Warnings", "Basic", "All"].indexOf(logLevelVal) === -1) logLevelVal = DEFAULT_CONFIG.logLevel;
    var newConfig = {
      controlSheetName: DEFAULT_CONFIG.controlSheetName,
      controlTableName: DEFAULT_CONFIG.controlTableName,
      logSheetName: DEFAULT_CONFIG.logSheetName,
      logTableName: DEFAULT_CONFIG.logTableName,
      logLevel: logLevelVal,
      maxLogRows: (function() { var p = parseInt(payload.maxLogRows, 10); return (isNaN(p) || p < 0) ? 0 : p; })(),
      sleepTimeMs: toNum(payload.sleepTimeMs, DEFAULT_CONFIG.sleepTimeMs),
      maxApiRetries: toNum(payload.maxApiRetries, DEFAULT_CONFIG.maxApiRetries),
      grid: { frozenRows: DEFAULT_CONFIG.grid.frozenRows },
      headers: { id: DEFAULT_CONFIG.headers.id, last_mod: DEFAULT_CONFIG.headers.last_mod, last_upd: DEFAULT_CONFIG.headers.last_upd },
      lastModSchedules: [],
      dataRanges: []
    };
    if (payload.dataRangesJson) {
      try {
        var drRaw = JSON.parse(payload.dataRangesJson);
        if (Array.isArray(drRaw)) {
          for (var di = 0; di < drRaw.length; di++) {
            var entry = drRaw[di];
            var sn = entry && (entry.sourceName != null) ? String(entry.sourceName).trim() : "";
            var err = validateSourceName(sn);
            if (!err.valid) {
              throw new Error(err.message || "Invalid source name");
            }
            newConfig.dataRanges.push({
              sourceName: sn,
              range: entry && entry.range != null ? String(entry.range).trim() : "",
              not_empty_column: entry && entry.not_empty_column != null ? String(entry.not_empty_column).trim() : ""
            });
          }
        }
      } catch (e) {
        if (e.message && e.message.indexOf("Invalid source name") !== -1) throw e;
        console.warn("saveUserConfig: dataRangesJson parse failed: " + (e && e.message ? e.message : String(e)));
      }
    }
    if (payload.lmSchedulesJson) {
      try {
        var raw = JSON.parse(payload.lmSchedulesJson);
        if (Array.isArray(raw)) {
          newConfig.lastModSchedules = raw.map(function(s) {
            return { maxAgeDays: toNum(s.maxAgeDays, 0), intervalVal: Math.max(1, toNum(s.intervalVal, 1)), intervalUnit: s.intervalUnit || "Hours", active: s.active === true || s.active === "true" };
          });
        }
      } catch (e) {
        console.warn("saveUserConfig: lmSchedulesJson parse failed: " + (e && e.message ? e.message : String(e)));
      }
    }
    var props = PropertiesService.getDocumentProperties();
    var existingJson = props.getProperty("USER_CONFIG");
    if (existingJson) {
      try {
        var existing = JSON.parse(existingJson);
        if (existing.lastStatus && typeof existing.lastStatus === "object") newConfig.lastStatus = existing.lastStatus;
      } catch (e) { /* ignore */ }
    }
    props.setProperty("USER_CONFIG", JSON.stringify(newConfig));
    if (typeof updateCheckSchedule === "function") {
      try { updateCheckSchedule(newConfig); } catch (err) {
        console.warn("saveUserConfig: updateCheckSchedule failed: " + (err && err.message ? err.message : String(err)));
      }
    }
    return "Settings saved!";
  } catch (e) {
    console.error("saveUserConfig: " + (e && e.message ? e.message : String(e)));
    if (e && e.stack) console.error(e.stack);
    return "Error: " + (e && e.message ? e.message : String(e));
  }
}

function validateConfig(config) {
  if (!config || Object.keys(config).length === 0) throw new Error("Configuration is empty. Add Data Ranges in Settings.");
}

/**
 * Validates source name: whitelist a-z, A-Z, 0-9, _ only; 1-31 chars after trim.
 * @param {string} name - Raw source name.
 * @returns {{ valid: boolean, message?: string }}
 */
function validateSourceName(name) {
  var s = (name != null ? String(name) : "").trim();
  if (s.length === 0) return { valid: false, message: "Source name is required." };
  if (s.length > 31) return { valid: false, message: "Name may only contain letters (a–z, A–Z), digits (0–9), and underscore (_)." };
  if (!/^[a-zA-Z0-9_]+$/.test(s)) return { valid: false, message: "Name may only contain letters (a–z, A–Z), digits (0–9), and underscore (_)." };
  return { valid: true };
}

/**
 * Builds config map from settings.dataRanges for SyncEngine: { [sourceName]: { range, not_empty_column, sheet_name } }.
 * @param {Object} settings - Full config (getUserConfig) with dataRanges array.
 * @returns {Object} Map keyed by sourceName, same shape as former getSheetConfig result.
 */
function getDataRangesConfig(settings) {
  var arr = settings && settings.dataRanges ? settings.dataRanges : [];
  var config = {};
  for (var i = 0; i < arr.length; i++) {
    var r = arr[i];
    var sn = r && r.sourceName != null ? String(r.sourceName).trim() : "";
    if (!sn) continue;
    config[sn] = {
      range: r.range != null ? String(r.range).trim() : "",
      not_empty_column: r.not_empty_column != null ? String(r.not_empty_column).trim() : "",
      sheet_name: sn
    };
  }
  return config;
}

/**
 * Expected row-1 headers for each system component (for status check).
 */
var CONTROL_HEADER_ID = "sheet_id";
var LOG_HEADERS = ["Timestamp", "Sheet ID", "Mode", "Status", "Total Rows", "Details"];

/**
 * Returns per-component status: 'ok' | 'empty' | 'missing'.
 * control and logs: from spreadsheet (sheet/table existence and data).
 * setup (Data Ranges): from settings only (dataRanges array); no spreadsheet table/sheet lookup.
 *   ok = dataRanges has entries and all sourceNames valid; empty = no entries (dataRanges.length === 0); missing = no dataRanges or validation error.
 * @param {Object} clientConfig - Full config (e.g. getUserConfig) with dataRanges.
 * @returns {{ control: string, logs: string, setup: string, sourceFilesUrl?: string|null, logsUrl?: string|null }}
 */
function getSystemStatus(clientConfig) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = clientConfig || getUserConfig();
  var setupStatus = "missing";
  if (cfg.dataRanges && Array.isArray(cfg.dataRanges)) {
    if (cfg.dataRanges.length === 0) {
      setupStatus = "empty";
    } else {
      var allValid = true;
      for (var i = 0; i < cfg.dataRanges.length; i++) {
        var r = cfg.dataRanges[i];
        var sn = r && r.sourceName != null ? String(r.sourceName).trim() : "";
        if (!validateSourceName(sn).valid) { allValid = false; break; }
      }
      setupStatus = allValid ? "ok" : "missing";
    }
  }
  var links = getSheetLinks(cfg);
  var out = {
    control: checkComponentStatus(ss, cfg.controlSheetName, function(row1) { return row1 && row1.indexOf(cfg.headers && cfg.headers.id ? cfg.headers.id : CONTROL_HEADER_ID) !== -1; }, true),
    logs: checkComponentStatus(ss, cfg.logSheetName, function(row1) { return row1 && LOG_HEADERS.every(function(h) { return row1.indexOf(h) !== -1; }); }, false),
    setup: setupStatus
  };
  if (links) {
    out.sourceFilesUrl = links.sourceFilesUrl;
    out.logsUrl = links.logsUrl;
  }
  return out;
}

/**
 * Returns URLs to open the control (Source Files) and logs sheets in the spreadsheet. Used by Settings sidebar links.
 * @param {Object} clientConfig - Full config (e.g. getUserConfig). If null/undefined, getUserConfig() is used.
 * @returns {{ sourceFilesUrl: string|null, logsUrl: string|null }}
 */
function getSheetLinks(clientConfig) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var baseUrl = ss.getUrl();
  var cfg = clientConfig || getUserConfig();
  var sourceFilesUrl = null;
  var logsUrl = null;
  var controlSheet = cfg.controlSheetName ? ss.getSheetByName(cfg.controlSheetName) : null;
  var logSheet = cfg.logSheetName ? ss.getSheetByName(cfg.logSheetName) : null;
  if (controlSheet) sourceFilesUrl = baseUrl + "#gid=" + controlSheet.getSheetId();
  if (logSheet) logsUrl = baseUrl + "#gid=" + logSheet.getSheetId();
  return { sourceFilesUrl: sourceFilesUrl, logsUrl: logsUrl };
}

/**
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} sheetName
 * @param {function(Array<string>): boolean} headerOk - returns true if row 1 is valid (table exists).
 * @param {boolean} useEmptyState - if true (control/setup), return 'empty' when table exists but no data rows; if false (logs), never return 'empty'.
 * @returns {'ok'|'empty'|'missing'}
 */
function checkComponentStatus(ss, sheetName, headerOk, useEmptyState) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return "missing";
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return "missing";
  var row1 = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(c) { return c !== null && c !== undefined ? String(c).trim() : ""; });
  if (!headerOk(row1)) return "missing";
  if (useEmptyState && sheet.getLastRow() === 1) return "empty";
  return "ok";
}

/** @deprecated Use getSystemStatus for green/red/yellow. Returns booleans for backward compatibility. */
function checkSystemHealth(clientConfig) {
  var status = getSystemStatus(clientConfig);
  return {
    control: status.control === "ok",
    logs: status.logs === "ok",
    setup: status.setup === "ok"
  };
}

/**
 * Default header row for control (urls) sheet: sheet_id, last_modified_datetime, last_update_datetime (from config.headers).
 */
function getControlDefaultHeaders(config) {
  var h = (config && config.headers) ? config.headers : DEFAULT_CONFIG.headers;
  return [h.id || CONTROL_HEADER_ID, h.last_mod || DEFAULT_CONFIG.headers.last_mod, h.last_upd || DEFAULT_CONFIG.headers.last_upd];
}

/**
 * Control sheet column count (sheet_id, last_modified_datetime, last_update_datetime).
 */
var CONTROL_COL_COUNT = 3;
/**
 * Log sheet column count (LOG_HEADERS length).
 */
var LOG_COL_COUNT = 6;

/**
 * Thin wrapper: calls ensureTablesExist, returns getSystemStatus or { status, tableError } on error.
 * @param {Object} clientConfig
 * @returns {{ control: string, logs: string, setup: string }}|{{ status: Object, tableError: string }}
 */
function provisionSystem(clientConfig) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssId = ss.getId();
  var cfg = clientConfig || DEFAULT_CONFIG;
  var maxRetries = (cfg.maxApiRetries != null) ? cfg.maxApiRetries : 3;
  var tableError = null;
  try {
    ensureTablesExist(ss, ssId, cfg, maxRetries);
  } catch (e) {
    tableError = e && e.message ? e.message : String(e);
    console.error("provisionSystem ensureTablesExist: " + tableError);
    if (e && e.stack) console.error(e.stack);
  }
  var status = getSystemStatus(cfg);
  if (tableError) return { status: status, tableError: tableError };
  return status;
}

/**
 * Column names for table columnProperties (control, logs).
 */
var CONTROL_TABLE_COL_NAMES = ["sheet_id", "last_modified_datetime", "last_update_datetime"];
var LOG_TABLE_COL_NAMES = ["Timestamp", "Sheet ID", "Mode", "Status", "Total Rows", "Details"];

/**
 * Returns true if in meta there is a sheet with title sheetName that has a table with name tableName.
 * @param {Object} meta - Spreadsheets.get response (sheets with properties.title, tables).
 * @param {string} sheetName
 * @param {string} tableName
 * @returns {boolean}
 */
function tableExistsInMeta(meta, sheetName, tableName) {
  if (!meta.sheets) return false;
  for (var i = 0; i < meta.sheets.length; i++) {
    var s = meta.sheets[i];
    if (!s.properties || s.properties.title !== sheetName) continue;
    if (!s.tables || s.tables.length === 0) return false;
    for (var j = 0; j < s.tables.length; j++) {
      var t = s.tables[j];
      if ((t.name && t.name === tableName) || (t.displayName && t.displayName === tableName)) return true;
    }
    return false;
  }
  return false;
}

/**
 * Ensures named Tables (Sheets API) exist for control, logs, setup. One function: 1) check if table exists (meta);
 * 2) if not: ensure sheet exists (create if missing), error if sheet has data; 3) create table (headers from columnProperties).
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} ssId
 * @param {Object} cfg - config with sheet names, table names.
 * @param {number} maxRetries
 * @throws {Error} with message listing failures (sheet has data, or addTable failed).
 */
function ensureTablesExist(ss, ssId, cfg, maxRetries) {
  var meta = callWithRetry(function() {
    return Sheets.Spreadsheets.get(ssId, { fields: "sheets(properties(sheetId,title),tables)" });
  }, maxRetries);
  if (!meta.sheets) return;
  var components = [
    { sheetName: cfg.controlSheetName, tableName: cfg.controlTableName, colCount: CONTROL_COL_COUNT, colNames: CONTROL_TABLE_COL_NAMES },
    { sheetName: cfg.logSheetName, tableName: cfg.logTableName, colCount: LOG_COL_COUNT, colNames: LOG_TABLE_COL_NAMES }
  ];
  var errors = [];
  components.forEach(function(c) {
    if (tableExistsInMeta(meta, c.sheetName, c.tableName)) return;
    var sheet = ss.getSheetByName(c.sheetName);
    var sheetId;
    if (!sheet) {
      var addSheetRes = callWithRetry(function() {
        return Sheets.Spreadsheets.batchUpdate({
          requests: [{ addSheet: { properties: { title: c.sheetName, gridProperties: { frozenRowCount: 1 } } } }]
        }, ssId);
      }, maxRetries);
      if (!addSheetRes.replies || !addSheetRes.replies[0].addSheet || addSheetRes.replies[0].addSheet.properties.sheetId == null) {
        errors.push(c.tableName + ": failed to create sheet");
        return;
      }
      sheetId = addSheetRes.replies[0].addSheet.properties.sheetId;
    } else {
      if (sheet.getLastRow() > 1) {
        errors.push(c.sheetName + ": sheet has data, cannot create table");
        return;
      }
      sheetId = sheet.getSheetId();
    }
    /* last_modified_datetime and last_update_datetime use TEXT so the script's "yyyy-MM-dd HH:mm:ss" string displays as-is (consistent format). */
    var colProps = [];
    var dateTimeColNames = ["last_modified_datetime", "last_update_datetime"];
    for (var k = 0; k < c.colCount; k++) {
      var colName = (c.colNames && c.colNames[k]) ? c.colNames[k] : "Column " + (k + 1);
      var colType = (dateTimeColNames.indexOf(colName) !== -1) ? "TEXT" : "TEXT";
      colProps.push({
        columnIndex: k,
        columnName: colName,
        columnType: colType
      });
    }
    try {
      callWithRetry(function() {
        return Sheets.Spreadsheets.batchUpdate({
          requests: [{
            addTable: {
              table: {
                name: c.tableName,
                range: {
                  sheetId: sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: c.colCount
                },
                columnProperties: colProps
              }
            }
          }]
        }, ssId);
      }, maxRetries);
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      errors.push(c.tableName + ": " + msg);
      console.error("ensureTablesExist addTable " + c.tableName + " failed: " + msg);
      if (e && e.stack) console.error(e.stack);
    }
  });
  if (errors.length > 0) {
    throw new Error("Table creation failed: " + errors.join("; "));
  }
}

/**
 * Creates only the logs sheet and table. Used by Settings "Create" in Logs section.
 * @param {Object} clientConfig - Full config (e.g. getUserConfig). If null, getUserConfig() is used.
 * @returns {{ control: string, logs: string, setup: string }}|{{ status: Object, tableError: string }}
 */
function provisionLogsOnly(clientConfig) {
  var cfg = clientConfig || getUserConfig();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssId = ss.getId();
  var maxRetries = (cfg.maxApiRetries != null) ? cfg.maxApiRetries : 3;
  var tableError = null;
  try {
    ensureLogsTableExist(ss, ssId, cfg, maxRetries);
  } catch (e) {
    tableError = e && e.message ? e.message : String(e);
    console.error("provisionLogsOnly ensureLogsTableExist: " + tableError);
    if (e && e.stack) console.error(e.stack);
  }
  var status = getSystemStatus(cfg);
  if (tableError) return { status: status, tableError: tableError };
  return status;
}

/**
 * Ensures the logs sheet and named table exist (Sheets API). Same single-component logic as ensureTablesExist for logs.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} ssId
 * @param {Object} cfg - config with logSheetName, logTableName.
 * @param {number} maxRetries
 */
function ensureLogsTableExist(ss, ssId, cfg, maxRetries) {
  var c = {
    sheetName: cfg.logSheetName,
    tableName: cfg.logTableName,
    colCount: LOG_COL_COUNT,
    colNames: LOG_TABLE_COL_NAMES
  };
  var meta = callWithRetry(function() {
    return Sheets.Spreadsheets.get(ssId, { fields: "sheets(properties(sheetId,title),tables)" });
  }, maxRetries);
  if (meta.sheets && tableExistsInMeta(meta, c.sheetName, c.tableName)) return;
  var sheet = ss.getSheetByName(c.sheetName);
  var sheetId;
  if (!sheet) {
    var addSheetRes = callWithRetry(function() {
      return Sheets.Spreadsheets.batchUpdate({
        requests: [{ addSheet: { properties: { title: c.sheetName, gridProperties: { frozenRowCount: 1 } } } }]
      }, ssId);
    }, maxRetries);
    if (!addSheetRes.replies || !addSheetRes.replies[0].addSheet || addSheetRes.replies[0].addSheet.properties.sheetId == null) {
      throw new Error(c.tableName + ": failed to create sheet");
    }
    sheetId = addSheetRes.replies[0].addSheet.properties.sheetId;
  } else {
    if (sheet.getLastRow() > 1) {
      throw new Error(c.sheetName + ": sheet has data, cannot create table");
    }
    sheetId = sheet.getSheetId();
  }
  var colProps = [];
  for (var k = 0; k < c.colCount; k++) {
    colProps.push({
      columnIndex: k,
      columnName: (c.colNames && c.colNames[k]) ? c.colNames[k] : "Column " + (k + 1),
      columnType: "TEXT"
    });
  }
  callWithRetry(function() {
    return Sheets.Spreadsheets.batchUpdate({
      requests: [{
        addTable: {
          table: {
            name: c.tableName,
            range: {
              sheetId: sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: c.colCount
            },
            columnProperties: colProps
          }
        }
      }]
    }, ssId);
  }, maxRetries);
}
