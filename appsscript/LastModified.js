// LastModified.gs

/** Document Properties key for execution lock (value = start timestamp ms). */
var LOCK_KEY = "syncSchedule_running";
/** Lock considered stale after this ms (e.g. after crash). Must be > typical run duration. */
var LOCK_STALE_MS = 10 * 60 * 1000;
/** Tolerance in ms when comparing (now - lastRun) >= interval (avoids off-by-one). */
var DUE_TOLERANCE_MS = 10 * 1000;

/**
 * Returns schedule interval length in milliseconds.
 * Uses same mapping as updateCheckSchedule (Minutes: val < 5 → 1, < 10 → 5, < 15 → 10, < 30 → 15, else 30).
 * @param {{ intervalVal: number, intervalUnit: string }} schedule - One entry from lastModSchedules.
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
 * MAIN SCHEDULE ORCHESTRATOR
 * Runs date check first, then synchronization.
 */
function processScheduledWorkflow() {
  console.log("Schedule: Step 1 - Checking dates");
  updateLastModified();

  console.log("Schedule: Step 2 - Data synchronization");

  try {
    runAutoSync();
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
 * Reviews schedules from config; runs one performCheck with max window for all "due" schedules.
 * Uses Document Properties for lock (syncSchedule_running) and last run per schedule (syncSchedule_lastRun_0, ...).
 */
function updateLastModified() {
  const props = PropertiesService.getDocumentProperties();
  const now = Date.now();

  /** If lock exists and is not stale, another run is in progress – skip without changing any lastRun. */
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
    const schedules = config.lastModSchedules || [];

    if (schedules.length === 0) {
      console.log("No schedules defined.");
      return;
    }

    const dueIndices = [];
    for (let i = 0; i < schedules.length; i++) {
      const s = schedules[i];
      if (!s.active) continue;
      const lastRunStr = props.getProperty("syncSchedule_lastRun_" + i);
      const lastRun = lastRunStr ? parseInt(lastRunStr, 10) : NaN;
      const intervalMs = scheduleIntervalMs(s);
      const isDue = isNaN(lastRun) || (now - lastRun) >= (intervalMs - DUE_TOLERANCE_MS);
      if (isDue) dueIndices.push(i);
    }

    if (dueIndices.length === 0) {
      console.log("Schedule: no schedule due, skipping check.");
      return;
    }

    let maxDaysAllowed = -1;
    dueIndices.forEach((i) => {
      const s = schedules[i];
      if (s.maxAgeDays === 0 || s.maxAgeDays === "0") maxDaysAllowed = 999999;
      else if (Number(s.maxAgeDays) > maxDaysAllowed) maxDaysAllowed = Number(s.maxAgeDays);
    });
    if (maxDaysAllowed < 0) maxDaysAllowed = 999999;

    performCheck(config, maxDaysAllowed);

    dueIndices.forEach((i) => {
      props.setProperty("syncSchedule_lastRun_" + i, String(now));
    });
  } finally {
    props.deleteProperty(LOCK_KEY);
  }
}

/**
 * Called manually from UI Settings (Check & Create Missing).
 */
function runSingleScheduleCheck(maxAgeDays) {
  const config = getUserConfig();
  let limit = 999999;
  if (maxAgeDays !== 0 && maxAgeDays !== "0" && maxAgeDays !== "" && maxAgeDays !== undefined) {
    limit = Number(maxAgeDays);
  }
  console.log("Manual run for max age: " + limit + " days");
  performCheck(config, limit);
  return "Check completed (Max age: " + (maxAgeDays === 0 ? "All" : maxAgeDays + " days") + ")";
}

/**
 * Core logic: Check file modification dates via Drive API.
 * Uses Library-level Advanced Services.
 */
function performCheck(config, maxDaysAllowed) {
  const TABLE_NAME = config.controlTableName || "urls";
  const ID_HEADER = config.headers.id || "sheet_id";
  const DATE_HEADER = config.headers.last_mod || "last_modified_datetime";

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const SS_ID = ss.getId();
  const TIMEZONE = ss.getSpreadsheetTimeZone();

  let stats = { checked: 0, changed: 0, errors: 0 };

  let rows = [];
  try {
    const response = Sheets.Spreadsheets.Values.get(SS_ID, TABLE_NAME);
    rows = response.values || [];
  } catch (e) {
    console.error("Sheets API error: Ensure 'Google Sheets API' is enabled in the Library.", e && e.message ? e.message : e);
    if (e && e.stack) console.error(e.stack);
    return;
  }

  if (rows.length < 2) return;

  const headers = rows[0];
  const idIdx = headers.indexOf(ID_HEADER);
  const dateIdx = headers.indexOf(DATE_HEADER);

  if (idIdx === -1 || dateIdx === -1) {
    console.error("Headers not found: " + ID_HEADER + " or " + DATE_HEADER);
    return;
  }

  const now = new Date();
  const dataRows = rows.slice(1);

  const results = dataRows.map((row) => {
    const input = row[idIdx];
    const existingDateStr = row[dateIdx];

    if (!input) return [existingDateStr || ""];

    let shouldCheck = true;
    let existingDateObj = null;

    if (existingDateStr && existingDateStr !== "Error" && existingDateStr !== "") {
      existingDateObj = new Date(existingDateStr);
      if (!isNaN(existingDateObj.getTime())) {
        const diffDays = (now - existingDateObj) / (1000 * 60 * 60 * 24);
        if (diffDays > maxDaysAllowed) shouldCheck = false;
      }
    }

    if (!shouldCheck) return [existingDateStr || ""];

    stats.checked++;

    try {
      const fileId = input.includes("/d/") ? input.split("/d/")[1].split("/")[0] : input;

      const file = Drive.Files.get(fileId, { fields: "modifiedTime" });
      const newRawDate = new Date(file.modifiedTime);
      const newFormattedDate = Utilities.formatDate(newRawDate, TIMEZONE, "yyyy-MM-dd HH:mm:ss");

      let isDifferent = false;
      if (existingDateStr !== newFormattedDate) {
        if (existingDateObj && !isNaN(existingDateObj.getTime())) {
          const diffMs = Math.abs(newRawDate.getTime() - existingDateObj.getTime());
          if (diffMs > 5000) isDifferent = true;
        } else {
          isDifferent = true;
        }
      }

      if (isDifferent) {
        stats.changed++;
        return [newFormattedDate];
      } else {
        return [existingDateStr || ""];
      }
    } catch (e) {
      stats.errors++;
      const errMsg = e && e.message ? e.message : String(e);
      if (errMsg.includes("Drive is not defined")) {
        console.error("CRITICAL: 'Drive API' is not enabled in the Library project (Resources > Services).");
        if (e && e.stack) console.error(e.stack);
        return ["Config Error"];
      }
      console.warn("Drive API error for " + input + ": " + errMsg);
      if (e && e.stack) console.error(e.stack);
      return ["Error"];
    }
  });

  const colLetter = columnToLetter(dateIdx + 1);
  const range = TABLE_NAME + "!" + colLetter + "2:" + colLetter + (rows.length + 1);

  try {
    Sheets.Spreadsheets.Values.update(
      { values: results },
      SS_ID,
      range,
      { valueInputOption: "USER_ENTERED" }
    );
  } catch (e) {
    console.error("Sheets API write error:", e && e.message ? e.message : String(e));
    if (e && e.stack) console.error(e.stack);
  }

  /** Log only when logLevel allows schedule-triggered logs: Errors/Warnings only if hasError; Basic/None skip; All always. */
  const logLevel = config.logLevel || "Basic";
  const shouldLogSchedule = logLevel === "All" ||
    ((logLevel === "Errors" || logLevel === "Warnings") && stats.errors > 0);
  if (config.logSheetName && shouldLogSchedule) {
    const logItem = { sheetId: "SYSTEM (Drive API)", mode: "Check Dates" };
    const logDetails = "Range: " + (maxDaysAllowed > 9000 ? "All" : maxDaysAllowed + " days") + ", Checked: " + stats.checked + ", Changed: " + stats.changed + ", Errors: " + stats.errors;
    try {
      logResult(ss, config.logSheetName, logItem, stats.errors > 0, stats.checked, logDetails, config.maxLogRows);
    } catch (e) {
      console.warn("Log write failed: " + (e && e.message ? e.message : String(e)));
      if (e && e.stack) console.error(e.stack);
    }
  }
}

/**
 * Creates triggers from saved user schedules.
 */
function updateCheckSchedule(config) {
  const schedules = config.lastModSchedules || [];
  const clientHandlerFunction = "scheduledLastModifiedCheck";

  try {
    const triggers = ScriptApp.getProjectTriggers();
    for (const t of triggers) {
      if (t.getHandlerFunction() === clientHandlerFunction) {
        ScriptApp.deleteTrigger(t);
      }
    }

    /** Clear last-run timestamps so changed/removed schedules do not use stale times. */
    const props = PropertiesService.getDocumentProperties();
    const all = props.getProperties();
    for (const key in all) {
      if (key.indexOf("syncSchedule_lastRun_") === 0) props.deleteProperty(key);
    }

    schedules.forEach(s => {
      if (s.active) {
        const builder = ScriptApp.newTrigger(clientHandlerFunction).timeBased();
        const val = Math.max(1, s.intervalVal);

        switch (s.intervalUnit) {
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
        }
        builder.create();
      }
    });
  } catch (e) {
    console.error("Trigger error:", e && e.message ? e.message : String(e));
    if (e && e.stack) console.error(e.stack);
  }
}
