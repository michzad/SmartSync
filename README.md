# SmartSync

Google Apps Script library for syncing data from source spreadsheets into a central spreadsheet, with last-modified date checks and scheduled triggers.

This project was created with **vibe coding** using [Cursor](https://cursor.com).

## Features

- **Sync** data from multiple source spreadsheets into one destination
- **Last-modified checks** via Drive API (optional scheduled triggers)
- **Control table** (e.g. `urls`) with sheet IDs, last-modified and last-update columns
- **Configurable data ranges** per source (name, range, optional trim column)
- **Logging** with configurable level and max rows
- **Settings sidebar** for setup, schedules, and advanced options

## Requirements

- Google Sheets (spreadsheet as library host or client)
- **Google Sheets API** and **Drive API** (Advanced Services) enabled in each Apps Script project that uses the library

## Library installation (publishers / developers)

**Manual setup:**

1. Create a new Apps Script project: go to [script.google.com](https://script.google.com) → **New project**, or from any Google Sheet → **Extensions** → **Apps Script** (this creates a script bound to that sheet; for a standalone library, use script.google.com).
2. In the Apps Script editor, create the following files and copy the content from this repo into each:
   - **Script files:** `Main.js`, `SyncEngine.js`, `Configuration.js`, `Helpers.js`, `LastModified.js` (content from `appsscript/` in the repo).
   - **HTML files:** `Settings.html`, `Manual.html`, `Developer.html`.
   - **Manifest:** In the editor, open **Project settings** (gear icon); you can edit `appsscript.json` via **View** → **Show manifest file**, or set time zone, web app, and enable **Google Sheets API** and **Drive API** under **Resources** → **Advanced Google Services** (and in Google Cloud Console for this project).
3. Deploy as needed: **Deploy** → **New deployment** (e.g. web app for Manual/Developer).

**Alternative:** To push from the repo instead of copying by hand, use [clasp](https://github.com/google/clasp): set `scriptId` and `rootDir: "appsscript"` in `.clasp.json`, then run `.\deploy.ps1` from the project root to push and update the deployment.

## Client installation (spreadsheet users)

For adding SmartSync as a library to your spreadsheet:

1. Open your spreadsheet → **Extensions** → **Apps Script**.
2. **+** next to **Libraries** → paste the SmartSync **Script ID** (from the Manual or your publisher) → **Look up** → add **SmartSync** (identifier), select latest version → **Add**.
3. Enable **Google Sheets API** and **Drive API** in the **client** project: **Resources** → **Advanced Google Services** → turn both ON; then open the Google Cloud Console link and enable the same APIs for this project.
4. Paste the client wrapper from the Manual into your script’s `Code.gs` (the snippet that defines `onOpen`, `runAutoSync`, `showSettings`, `runLibrary`, etc.).

**Important:** Library code runs in the **client project’s context**. The **client** script must enable the same advanced services; enabling them only in the library project is not enough.

## Usage

- **Menu:** **Smart Sync** → **Run Auto Sync** (sync now), **Settings** (sidebar).
- **Control sheet:** Put source sheet IDs or URLs in the `sheet_id` column; run **Check** (last-modified) then **Sync** as needed.
- **Settings:** Configure data ranges, sync schedules, logs, and performance options.

## Project structure

| Location   | File               | Purpose |
|-----------|--------------------|--------|
| root      | `.clasp.json`      | clasp config (`scriptId`, `rootDir: "appsscript"`) |
| root      | `deploy.ps1`       | Push and create deployment with version from `appsscript/Configuration.js` |
| root      | `todo.md`          | Notes / TODO |
| `appsscript/` | `appsscript.json` | Manifest (timeZone, webapp, Sheets/Drive APIs) |
| `appsscript/` | `Main.js`        | Entry: `doGet`, `onOpen`, `showSettings`, `runAutoSync`, `buildSyncQueue` |
| `appsscript/` | `SyncEngine.js`  | Sync engine: `masterSync`, `processTableDataSync`, `ensureInfrastructure`, etc. |
| `appsscript/` | `Configuration.js` | Config, `getUserConfig`, `saveUserConfig`, `getDataRangesConfig`, `provisionSystem` |
| `appsscript/` | `Helpers.js`     | Retry, table data, trim, grid, write requests, log, `columnToLetter` |
| `appsscript/` | `LastModified.js` | Schedules, `performCheck`, triggers |
| `appsscript/` | `Settings.html`   | Settings sidebar UI |
| `appsscript/` | `Manual.html`     | User manual / client setup |
| `appsscript/` | `Developer.html`  | Developer page (`?page=developer`) |

Only the contents of `appsscript/` are pushed to Apps Script (`clasp push`).

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
