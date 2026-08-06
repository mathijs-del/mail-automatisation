// Live Google Sheets fetch. This is the only file that touches network
// credentials — sheetParser.js stays pure and testable without them.
//
// Auth: a service account key file (GOOGLE_APPLICATION_CREDENTIALS env var),
// shared as viewer on the AI_TRAJECTDATA sheet. Separate from the OAuth
// client n8n uses for Gmail — this script only ever reads.

const { google } = require("googleapis");

async function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return auth.getClient();
}

/**
 * @param {string} sheetId
 * @param {string} tabName
 * @returns {Promise<string[][]>} raw rows, header row first
 */
async function fetchTrajectRows(sheetId, tabName) {
  const authClient = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: tabName,
  });
  return res.data.values || [];
}

module.exports = { fetchTrajectRows };
