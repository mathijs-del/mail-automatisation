#!/usr/bin/env node
// Validates AI_TRAJECTDATA. Run any time — flags non-ISO dates, gala dates
// in the past on "actief" rows, clinics outside the training period, and
// missing locations. See CLAUDE.md §6.
//
// Usage:
//   node scripts/validate-sheet.js --csv pad/naar/export.csv   (offline)
//   node scripts/validate-sheet.js                              (live, via .env)

require("dotenv").config();
const { loadRawRows } = require("../lib/loadRawRows");
const { rowsToTrajectories, validateTrajectories } = require("../lib/sheetParser");

function printReport(schemaIssues, errors, warnings, trajectories) {
  console.log(`\nAI_TRAJECTDATA — ${trajectories.length} traject(en) gevonden.\n`);

  if (schemaIssues.length > 0) {
    console.log("SCHEMA");
    schemaIssues.forEach((m) => console.log(`  ! ${m}`));
    console.log("");
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log("Geen problemen gevonden.\n");
    return;
  }

  if (errors.length > 0) {
    console.log(`FOUTEN (${errors.length}) — moeten opgelost worden:`);
    errors.forEach((e) => console.log(`  rij ${e.row} [${e.vereniging}]  ${e.message}`));
    console.log("");
  }

  if (warnings.length > 0) {
    console.log(`WAARSCHUWINGEN (${warnings.length}) — controleren:`);
    warnings.forEach((w) => console.log(`  rij ${w.row} [${w.vereniging}]  ${w.message}`));
    console.log("");
  }
}

async function main() {
  const csvIndex = process.argv.indexOf("--csv");
  const csvPath = csvIndex !== -1 ? process.argv[csvIndex + 1] : undefined;
  if (csvIndex !== -1 && !csvPath) {
    console.error("--csv heeft een bestandspad nodig.");
    process.exit(2);
  }

  const rawRows = await loadRawRows({
    csvPath,
    sheetId: process.env.SHEET_ID,
    sheetTab: process.env.SHEET_TAB,
  }).catch((err) => {
    console.error(
      `${err.message}\nGebruik: node scripts/validate-sheet.js --csv pad/naar/export.csv`
    );
    process.exit(2);
  });
  const { trajectories, schemaIssues } = rowsToTrajectories(rawRows);
  const { errors, warnings } = validateTrajectories(trajectories);

  printReport(schemaIssues, errors, warnings, trajectories);

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Validatie mislukt:", err.message);
  process.exit(2);
});
