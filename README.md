# SmartSync

Google Apps Script library for syncing data from source spreadsheets into a central spreadsheet, with last-modified date checks and scheduled triggers.

## Project structure

| File | Purpose |
|------|--------|
| **appsscript.json** | Apps Script manifest (timeZone, webapp, Sheets/Drive APIs, runtimeVersion) |
| **.clasp.json** | clasp config (scriptId, rootDir: ".") |
| **CLASP_SETUP.md** | clasp setup and deploy instructions |
| **CODE_REVIEW.md** | Code review notes (integrity, inconsistencies, structure) — **read this first** |
| **Configuration.js** | Default config, getUserConfig, saveUserConfig, getDataRangesConfig, dataRanges, provisionSystem |
| **deploy.ps1** | PowerShell: clasp push + create-deployment with version from Configuration.js |
| **Developer.html** | Developer page (script location, deployment, edit vars); served via doGet ?page=developer |
| **Helpers.js** | Retry wrapper, table data, trim, grid expansion, write requests, log, timestamp, columnToLetter |
| **LastModified.js** | Schedule workflow, date check (performCheck), triggers (updateCheckSchedule) |
| **Main.js** | doGet, onOpen, showSettings, runAutoSync, buildSyncQueue |
| **Manual.html** | User manual / installation (library ID, client code, setup steps) |
| **Settings.html** | Settings sidebar UI (system components, schedules, control columns, advanced options) |
| **SyncEngine.js** | masterSync, processTableDataSync, ensureInfrastructure, fetchSmartTargetState, readAndTrimSourceData |
| **todo.md** | TODO / notes (e.g. dates and column type) |

## Fixes applied from review

1. **LastModified.gs – performCheck:** Headers are taken from the first row (`rows[0]`) instead of the full `rows` array, so header column indices are correct.
2. **LastModified.gs:** Duplicate `columnToLetter` removed; only the implementation in Helpers.gs is used.
3. **Comments and logs:** Schedule-related messages in LastModified.gs use English for consistency with CODE_REVIEW.md.

## Client setup

Users add this project as a library (Script ID and identifier as in Manual.html) and paste the client wrapper from Manual.html into their spreadsheet’s `Code.gs`. The wrapper exposes `runLibrary()` so that Settings.html and triggers can call library functions.

**Important:** Library code runs in the **client project's execution context**. The **client** Apps Script project must enable the same advanced services (Sheets API, Drive API) in **Resources > Advanced Google Services** and in the Google Cloud Console for that project. Enabling them only in the library is not enough.

## Dependencies

- Google Sheets API (Advanced Service)
- Drive API (Advanced Service) for last-modified checks

Enable both in **each** Apps Script project that uses the library (the library project and every client project): **Resources > Advanced Google Services** and in the Google Cloud Console for the same project.
