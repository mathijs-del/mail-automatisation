#!/usr/bin/env node
// Creates the nine AI/* Gmail labels (CLAUDE.md §3C) via the Gmail API.
// Idempotent: existing labels are left alone, so it is safe to re-run.
//
// Usage:
//   node scripts/setup-labels.js --dry-run   (show what would happen)
//   node scripts/setup-labels.js
//
// Auth: OAuth credentials for the mailbox itself (info@thenext-gen.com).
// See README.md. This script only ever creates labels — it never reads,
// sends, modifies or deletes mail.

require("dotenv").config();
const { google } = require("googleapis");

const LABELS = [
  "AI/1-Nu",
  "AI/2-Deze-week",
  "AI/3-FYI",
  "AI/Concept-klaar",
  "AI/Handmatig",
  "AI/Deelnemer",
  "AI/Vereniging",
  "AI/Partner",
  "AI/Financieel",
];

async function getGmailClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error(
      "GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET en GMAIL_REFRESH_TOKEN moeten in .env staan.\n" +
      "Zie README.md voor het ophalen van een refresh token."
    );
  }
  const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("DRY RUN — er wordt niets aangemaakt.\n");
    console.log(`Zou ${LABELS.length} labels controleren/aanmaken:`);
    LABELS.forEach((l) => console.log(`  ${l}`));
    return;
  }

  const gmail = await getGmailClient();

  const existing = await gmail.users.labels.list({ userId: "me" });
  const existingNames = new Set((existing.data.labels || []).map((l) => l.name));

  let created = 0;
  let skipped = 0;

  for (const name of LABELS) {
    if (existingNames.has(name)) {
      console.log(`  bestaat al  ${name}`);
      skipped++;
      continue;
    }
    await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    console.log(`  aangemaakt  ${name}`);
    created++;
  }

  console.log(`\nKlaar: ${created} aangemaakt, ${skipped} bestonden al.`);
}

main().catch((err) => {
  console.error("Labels aanmaken mislukt:", err.message);
  process.exit(1);
});
