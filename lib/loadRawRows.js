// Shared by scripts/validate-sheet.js and test/run-fixtures.js: either
// read a local CSV export (offline, no credentials) or fetch AI_TRAJECTDATA
// live via the Sheets API.

const fs = require("fs");
const { parseCsv } = require("./csv");

/**
 * @param {{csvPath?: string, sheetId?: string, sheetTab?: string}} opts
 * @returns {Promise<string[][]>}
 */
async function loadRawRows({ csvPath, sheetId, sheetTab }) {
  if (csvPath) {
    const text = fs.readFileSync(csvPath, "utf8");
    return parseCsv(text);
  }
  if (!sheetId || !sheetTab) {
    throw new Error(
      "Geen --csv opgegeven en SHEET_ID/SHEET_TAB ontbreken in .env."
    );
  }
  const { fetchTrajectRows } = require("./sheetClient");
  return fetchTrajectRows(sheetId, sheetTab);
}

module.exports = { loadRawRows };
