// LastModified.gs

/** Document Properties key for execution lock (value = start timestamp ms). */
var LOCK_KEY = "syncSchedule_running";
/** Lock considered stale after this ms (e.g. after crash). Must be > typical run duration. */
var LOCK_STALE_MS = 10 * 60 * 1000;
/** Tolerance in ms when comparing (now - lastRun) >= interval (avoids off-by-one). */
var DUE_TOLERANCE_MS = 10 * 1000;
/** ISO timestamp of last successful Check. */
var LAST_CHECK_KEY = "last_check_datetime";
/** ISO timestamp of last successful Sync. */
var LAST_SYNC_KEY = "last_sync_datetime";
/** JSON array of sheet IDs pending sync after last Check. */
var LAST_CHECK_PENDING_KEY = "last_check_pending_ids";
/** Last run time for the single sync schedule (ms). */
var SYNC_SCHEDULE_LAST_RUN_KEY = "syncSchedule_lastRun";

/**
 * Returns schedule interval length in milliseconds.
 * @param {{ intervalVal: number, intervalUnit: string }} schedule - Schedule entry.
 * @returns {number} Interval length in ms.
 */
function scheduleIntervalMs(schedule) {
  const val = Math.max(1, Number(schedule.intervalVal) || 1);
  const unit = schedule.intervalUnit || "Hours";
  let ms = 0;
  switch (unit) {
    case "Minutes":
      const minutes = val < 5 ? 1 : val < 10 ? 5 : val < 15 ? 10 : val < 30 ? 15 : 30;
      ms = minutes * 60 * 1000;
      break;
    case "Hours":
      ms = val * 60 * 60 * 1000;
      break;
    case "Days":
      ms = val * 24 * 60 * 60 * 1000;
      break;
    case "Weeks":
      ms = val * 7 * 24 * 60 * 60 * 1000;
      break;
    default:
      ms = val * 60 * 60 * 1000;
  }
  return ms;
}

/**
 * Normalizes saved schedules to a single entry (first active, else first).
 * @param {Array<Object>} schedules
 * @returns {Object|null}
 */
function getNormalizedSchedule(schedules) {
  const list = Array.isArray(schedules) ? schedules : [];
  if (list.length === 0) return null;
  return list.find(function(s) { return s.active; }) || list[0];
}

/**
 * @returns {string[]} Sheet IDs flagged for sync after the last successful Check.
 */
function getLastCheckPendingIds() {
  const json = PropertiesService.getDocumentProperties().getProperty(LAST_CHECK_PENDING_KEY);
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/**
 * Persists last successful Sync timestamp (ISO).
 */
function setLastSyncTimestamp() {
  PropertiesService.getDocumentProperties().setProperty(LAST_SYNC_KEY, new Date().toISOString());
}

/**
 * Lists spreadsheets modified after isoDateTime (RFC 3339). Empty isoDateTime → empty map.
 * @param {string|null} isoDateTime
 * @returns {Object<string, string>} fileId → modifiedTime
 */
function listModifiedSpreadsheetsSince(isoDateTime) {
  const map = {};
  if (!isoDateTime) return map;
  let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and modifiedTime > '" + isoDateTime + "'";
  let pageToken = null;
  do {
    const resp = Drive.Files.list({
      q: q,
      fields: "nextPageToken, files(id, modifiedTime)",
      pageSize: 1000,
      pageToken: pageToken
    });
    (resp.files || []).forEach(function(f) { map[f.id] = f.modifiedTime; });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return map;
}

/**
 * Compares stored TEXT date with Drive modifiedTime (5s tolerance).
 * @param {string} existingDateStr
 * @param {Date} newRawDate
 * @param {Date|null} existingDateObj
 * @param {string} newFormattedDate
 * @returns {boolean}
 */
function isModifiedDateDifferent(existingDateStr, newRawDate, existingDateObj, newFormattedDate) {
  if (existingDateStr !== newFormattedDate) {
    if (existingDateObj && !isNaN(existingDateObj.getTime())) {
      return Math.abs(newRawDate.getTime() - existingDateObj.getTime()) > 5000;
    }
    return true;
  }
  return false;
}

/**
 * MAIN SCHEDULE ORCHESTRATOR
 * Runs date check first, then synchronization (only rows from last check).
 */
function processScheduledWorkflow() {
  console.log("Schedule: Step 1 - Checking dates");
  updateLastModified();

  console.log("Schedule: Step 2 - Data synchronization");

  try {
    runAutoSync({ sinceLastCheck: true });
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    if (errMsg.includes("is not defined")) {
      console.error("CRITICAL ERROR: 'runAutoSync' is missing from the Library (Main.gs).");
    } else {
      console.error("Error during synchronization step:", errMsg);
    }
    if (e && e.stack) console.error(e.stack);
  }
}

/**
 * Entry point for time-based triggers.
 */
function scheduledLastModifiedCheck() {
  processScheduledWorkflow();
}

/**
 * Runs performCheck when the single active schedule is due.
 */
function updateLastModified() {
  const props = PropertiesService.getDocumentProperties();
  const now = Date.now();

  const runningVal = props.getProperty(LOCK_KEY);
  if (runningVal) {
    const started = parseInt(runningVal, 10);
    if (!isNaN(started) && (now - started) < LOCK_STALE_MS) {
      console.log("Schedule: another run in progress, skipping.");
      return;
    }
  }

  props.setProperty(LOCK_KEY, String(now));

  try {
    const config = getUserConfig();
    const schedule = getNormalizedSchedule(config.lastModSchedules);

    if (!schedule || !schedule.active) {
      console.log("No active schedule defined.");
      return;
    }

    const lastRunStr = props.getProperty(SYNC_SCHEDULE_LAST_RUN_KEY);
    const lastRun = lastRunStr ? parseInt(lastRunStr, 10) : NaN;
    const intervalMs = scheduleIntervalMs(schedule);
    const isDue = isNaN(lastRun) || (now - lastRun) >= (intervalMs - DUE_TOLERANCE_MS);

    if (!isDue) {
      console.log("Schedule: not due, skipping check.");
      return;
    }

    const result = performCheck(config);
    if (result && result.success) {
      props.setProperty(SYNC_SCHEDULE_LAST_RUN_KEY, String(now));
    }
  } finally {
    props.deleteProperty(LOCK_KEY);
  }
}

/**
 * Manual Check from Settings Execute or schedule Run button.
 * @returns {string}
 */
function runSingleScheduleCheck() {
  const config = getUserConfig();
  const result = performCheck(config);
  if (!result || !result.success) {
    throw new Error("Check failed. See execution log for details.");
  }
  return "Check completed. Checked: " + result.stats.checked + ", Changed: " + result.stats.changed + ", Errors: " + result.stats.errors;
}

/**
 * Writes one column of control table data via Sheets API.
 */
function writeControlColumn(ssId, tableName, colIdx, values, lastRow) {
  const colLetter = columnToLetter(colIdx + 1);
  const range = tableName + "!" + colLetter + "2:" + colLetter + lastRow;
  Sheets.Spreadsheets.Values.update(
    { values: values },
    ssId,
    range,
    { valueInputOption: "USER_ENTERED" }
  );
}

/**
 * Checks sources via Drive API; updates source_last_modified_date, last_check_date, skip_reason.
 * last_successful_sync_date is only set after successful sync. Non-empty skip_reason skips the row.
 * @param {Object} config
 * @returns {{ success: boolean, stats: { checked: number, changed: number, errors: number } }}
 */
function performCheck(config) {
  const TABLE_NAME = config.controlTableName || "urls";
  const h = config.headers || {};
  const ID_HEADER = h.id || "sheet_id";
  const SRC_HEADER = h.source_mod || "source_last_modified_date";
  const SYNC_HEADER = h.last_sync || "last_successful_sync_date";
  const CHECK_HEADER = h.last_check || "last_check_date";
  const SKIP_HEADER = h.skip_reason || "skip_reason";

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const SS_ID = ss.getId();
  const TIMEZONE = ss.getSpreadsheetTimeZone();
  const props = PropertiesService.getDocumentProperties();

  const stats = { checked: 0, changed: 0, errors: 0 };
  const failResult = { success: false, stats: stats };

  let rows = [];
  try {
    const response = Sheets.Spreadsheets.Values.get(SS_ID, TABLE_NAME);
    rows = response.values || [];
  } catch (e) {
    console.error("Sheets API error: Ensure 'Google Sheets API' is enabled in the Library.", e && e.message ? e.message : e);
    if (e && e.stack) console.error(e.stack);
    return failResult;
  }

  if (rows.length < 2) return { success: true, stats: stats };

  const headerRow = rows[0];
  const idIdx = headerRow.indexOf(ID_HEADER);
  const srcIdx = headerRow.indexOf(SRC_HEADER);
  const syncIdx = headerRow.indexOf(SYNC_HEADER);
  const checkIdx = headerRow.indexOf(CHECK_HEADER);
  const skipIdx = headerRow.indexOf(SKIP_HEADER);

  if (idIdx === -1 || srcIdx === -1 || checkIdx === -1 || skipIdx === -1) {
    console.error("Control table headers not found. Expected: " + ID_HEADER + ", " + SRC_HEADER + ", " + CHECK_HEADER + ", " + SKIP_HEADER);
    return failResult;
  }

  const lastCheckIso = props.getProperty(LAST_CHECK_KEY);
  const modifiedMap = lastCheckIso ? listModifiedSpreadsheetsSince(lastCheckIso) : null;
  const dataRows = rows.slice(1);
  const pendingIds = [];
  const checkTimeFormatted = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");

  const srcResults = [];
  const checkResults = [];
  const skipResults = [];

  dataRows.forEach(function(row) {
    const cell = function(idx) {
      return (row[idx] != null ? String(row[idx]) : "");
    };

    const input = cell(idIdx);
    const existingSrc = typeof normalizeControlDateCell === "function"
      ? normalizeControlDateCell(cell(srcIdx))
      : cell(srcIdx).trim();
    const existingSync = typeof normalizeControlDateCell === "function"
      ? normalizeControlDateCell(syncIdx !== -1 ? cell(syncIdx) : "")
      : (syncIdx !== -1 ? cell(syncIdx).trim() : "");
    const existingSkip = cell(skipIdx).trim();

    if (!input) {
      srcResults.push([existingSrc]);
      checkResults.push([cell(checkIdx)]);
      skipResults.push([existingSkip]);
      return;
    }

    if (typeof isRowSkipped === "function" && isRowSkipped(existingSkip)) {
      srcResults.push([existingSrc]);
      checkResults.push([cell(checkIdx)]);
      skipResults.push([existingSkip]);
      return;
    }

    const fileId = extractIdFromUrl(input);
    let shouldCheck = false;

    if (!lastCheckIso) {
      shouldCheck = true;
    } else if (!existingSrc) {
      shouldCheck = true;
    } else if (modifiedMap && modifiedMap[fileId]) {
      shouldCheck = true;
    }

    if (!shouldCheck) {
      srcResults.push([existingSrc]);
      checkResults.push([checkTimeFormatted]);
      skipResults.push([""]);
      if (typeof getSyncNeed === "function" && getSyncNeed(existingSrc, existingSync, "") === "need_work") {
        pendingIds.push(fileId);
      }
      return;
    }

    stats.checked++;
    let existingDateObj = existingSrc ? new Date(existingSrc) : null;

    try {
      let modifiedTime = modifiedMap && modifiedMap[fileId] ? modifiedMap[fileId] : null;
      if (!modifiedTime) {
        const file = Drive.Files.get(fileId, { fields: "modifiedTime" });
        modifiedTime = file.modifiedTime;
      }

      const newRawDate = new Date(modifiedTime);
      const newFormattedDate = Utilities.formatDate(newRawDate, TIMEZONE, "yyyy-MM-dd HH:mm:ss");
      const isDifferent = isModifiedDateDifferent(existingSrc, newRawDate, existingDateObj, newFormattedDate);
      const finalSrc = isDifferent ? newFormattedDate : existingSrc;

      if (isDifferent) stats.changed++;

      srcResults.push([finalSrc]);
      checkResults.push([checkTimeFormatted]);
      skipResults.push([""]);

      if (typeof getSyncNeed === "function" && getSyncNeed(finalSrc, existingSync, "") === "need_work") {
        pendingIds.push(fileId);
      }
    } catch (e) {
      stats.errors++;
      const errMsg = e && e.message ? e.message : String(e);
      if (errMsg.includes("Drive is not defined")) {
        console.error("CRITICAL: 'Drive API' is not enabled in the Library project (Resources > Services).");
      } else {
        console.warn("Drive API error for " + input + ": " + errMsg);
      }
      if (e && e.stack) console.error(e.stack);
      srcResults.push([""]);
      checkResults.push([""]);
      skipResults.push([typeof driveCheckErrorMessage === "function" ? driveCheckErrorMessage(e) : errMsg]);
    }
  });

  try {
    writeControlColumn(SS_ID, TABLE_NAME, srcIdx, srcResults, rows.length);
    writeControlColumn(SS_ID, TABLE_NAME, checkIdx, checkResults, rows.length);
    writeControlColumn(SS_ID, TABLE_NAME, skipIdx, skipResults, rows.length);
  } catch (e) {
    console.error("Sheets API write error:", e && e.message ? e.message : String(e));
    if (e && e.stack) console.error(e.stack);
    return failResult;
  }

  props.setProperty(LAST_CHECK_KEY, new Date().toISOString());
  props.setProperty(LAST_CHECK_PENDING_KEY, JSON.stringify(pendingIds));

  const logLevel = config.logLevel || "Basic";
  const shouldLogSchedule = logLevel === "All" ||
    ((logLevel === "Errors" || logLevel === "Warnings") && stats.errors > 0);
  if (config.logSheetName && shouldLogSchedule) {
    const logItem = { sheetId: "SYSTEM (Drive API)", mode: "Check Dates" };
    const logDetails = "Since last check, Checked: " + stats.checked + ", Changed: " + stats.changed + ", Errors: " + stats.errors + ", Pending sync: " + pendingIds.length;
    try {
      logResult(ss, config.logSheetName, logItem, stats.errors > 0, stats.checked, logDetails, config.maxLogRows);
    } catch (e) {
      console.warn("Log write failed: " + (e && e.message ? e.message : String(e)));
      if (e && e.stack) console.error(e.stack);
    }
  }

  return { success: true, stats: stats };
}

/**
 * Creates a single time-based trigger from the saved schedule.
 */
function updateCheckSchedule(config) {
  const schedule = getNormalizedSchedule(config.lastModSchedules || []);
  const clientHandlerFunction = "scheduledLastModifiedCheck";

  try {
    const triggers = ScriptApp.getProjectTriggers();
    for (const t of triggers) {
      if (t.getHandlerFunction() === clientHandlerFunction) {
        ScriptApp.deleteTrigger(t);
      }
    }

    const props = PropertiesService.getDocumentProperties();
    props.deleteProperty(SYNC_SCHEDULE_LAST_RUN_KEY);
    const all = props.getProperties();
    for (const key in all) {
      if (key.indexOf("syncSchedule_lastRun_") === 0) props.deleteProperty(key);
    }

    if (!schedule || !schedule.active) return;

    const builder = ScriptApp.newTrigger(clientHandlerFunction).timeBased();
    const val = Math.max(1, schedule.intervalVal);

    switch (schedule.intervalUnit) {
      case "Minutes":
        if (val < 5) builder.everyMinutes(1);
        else if (val < 10) builder.everyMinutes(5);
        else if (val < 15) builder.everyMinutes(10);
        else if (val < 30) builder.everyMinutes(15);
        else builder.everyMinutes(30);
        break;
      case "Hours": builder.everyHours(val); break;
      case "Days": builder.everyDays(val); break;
      case "Weeks": builder.everyWeeks(val); break;
      default: builder.everyHours(val);
    }
    builder.create();
  } catch (e) {
    console.error("Trigger error:", e && e.message ? e.message : String(e));
    if (e && e.stack) console.error(e.stack);
  }
}
