#!/usr/bin/env node
// Runs the full pipeline (triage + draft) against every fixture in
// test/fixtures/. No Gmail, no n8n. Writes test/report.md. This is where
// prompt iteration happens — edit prompts/*.md, re-run, compare the diff.
//
// Usage:
//   node test/run-fixtures.js --csv pad/naar/export.csv   (trajectdata offline)
//   node test/run-fixtures.js                               (trajectdata live, via .env)
//
// Needs ANTHROPIC_API_KEY in .env either way — this is the one script that
// makes real API calls and costs real money.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { loadRawRows } = require("../lib/loadRawRows");
const { rowsToTrajectories, validateTrajectories } = require("../lib/sheetParser");
const { trajectoriesToText } = require("../lib/trajectContext");
const { loadKnowledgeBase } = require("../lib/knowledge");
const { loadFixtures } = require("../lib/fixtures");
const { applyWarningBanner } = require("../lib/draftFormat");
const claude = require("../lib/claude");

// $/MTok, standaardprijzen (niet de introductieprijs van Sonnet 5 t/m 2026-08-31)
// — anders flatteren we het kostenbeeld met een tijdelijke korting.
const PRICING = {
  [claude.TRIAGE_MODEL]: { input: 1.0, output: 5.0 },
  [claude.DRAFT_MODEL]: { input: 3.0, output: 15.0, cacheWrite1h: 6.0, cacheRead: 0.3 },
};

function costUsd(usage, model) {
  const p = PRICING[model];
  const inputTok = usage.input_tokens || 0;
  const outputTok = usage.output_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return (
    (inputTok / 1e6) * p.input +
    (outputTok / 1e6) * p.output +
    (p.cacheWrite1h ? (cacheCreate / 1e6) * p.cacheWrite1h : 0) +
    (p.cacheRead ? (cacheRead / 1e6) * p.cacheRead : 0)
  );
}

function buildReport(results, totalCost) {
  const lines = [
    "# Fixture report",
    "",
    `Gegenereerd: ${new Date().toISOString()}`,
    `Fixtures: ${results.length} — totale kosten: €${totalCost.toFixed(4)}`,
    "",
  ];

  for (const r of results) {
    lines.push(`## ${r.fixture.id} — ${r.fixture.subject}`);
    lines.push("");
    lines.push(`**Van:** ${r.fixture.from}`);
    lines.push(
      `**Triage:** ${r.triage.categorie} · ${r.triage.urgentie} · ` +
      `vereniging=${r.triage.vereniging ?? "null"} · taal=${r.triage.taal} · ` +
      `concept_toegestaan=${r.triage.concept_toegestaan}`
    );
    if (r.triage.waarschuwing) {
      lines.push(`**Waarschuwing:** ${r.triage.waarschuwing}`);
    }
    lines.push(`**Kosten:** €${r.cost.toFixed(4)}`);
    lines.push("");
    lines.push("**Binnengekomen mail:**");
    lines.push("```");
    lines.push(r.fixture.body);
    lines.push("```");
    lines.push("");

    if (r.bannered !== null) {
      lines.push("**AI-concept:**");
      lines.push("```");
      lines.push(r.bannered);
      lines.push("```");
    } else {
      lines.push(`_Geen concept gegenereerd — categorie ${r.triage.categorie} staat geen concept toe._`);
    }
    lines.push("");
    lines.push("**Wat jij echt verstuurde:**");
    lines.push("```");
    lines.push(r.fixture.actualReply);
    lines.push("```");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const csvIndex = process.argv.indexOf("--csv");
  const csvPath = csvIndex !== -1 ? process.argv[csvIndex + 1] : undefined;

  const rawRows = await loadRawRows({
    csvPath,
    sheetId: process.env.SHEET_ID,
    sheetTab: process.env.SHEET_TAB,
  });
  const { trajectories, schemaIssues } = rowsToTrajectories(rawRows);
  const { errors } = validateTrajectories(trajectories);

  if (schemaIssues.length > 0) {
    console.error(`Schema-problemen in AI_TRAJECTDATA: ${schemaIssues.join("; ")}`);
  }
  if (errors.length > 0) {
    console.error(
      `${errors.length} fout(en) in AI_TRAJECTDATA (draai npm run validate-sheet voor details) — ga toch door.`
    );
  }

  const knowledgeDir = path.join(__dirname, "..", "knowledge");
  const contextBlock =
    trajectoriesToText(trajectories) + "\n\n---\n\nKENNISBANK\n\n" + loadKnowledgeBase(knowledgeDir);

  const triagePrompt = fs.readFileSync(
    path.join(__dirname, "..", "prompts", "triage.system.md"), "utf8"
  );
  const draftPrompt = fs.readFileSync(
    path.join(__dirname, "..", "prompts", "draft.system.md"), "utf8"
  );

  const fixturesDir = path.join(__dirname, "fixtures");
  const fixtures = loadFixtures(fixturesDir);
  if (fixtures.length === 0) {
    console.error(`Geen fixtures gevonden in ${fixturesDir}. Zie test/fixtures/README.md.`);
    process.exit(1);
  }

  const results = [];
  let totalCost = 0;

  for (const fx of fixtures) {
    process.stdout.write(`${fx.id}: triage... `);
    const { result: triageResult, usage: triageUsage } = await claude.triage(
      { from: fx.from, subject: fx.subject, body: fx.body },
      triagePrompt
    );

    let draftUsage = { input_tokens: 0, output_tokens: 0 };
    let bannered = null;

    if (triageResult.concept_toegestaan) {
      process.stdout.write("concept... ");
      const draftResult = await claude.draft(
        {
          channel: "email",
          from: fx.from,
          subject: fx.subject,
          body: fx.body,
          vereniging: triageResult.vereniging,
          waarschuwing: triageResult.waarschuwing,
        },
        draftPrompt,
        contextBlock
      );
      draftUsage = draftResult.usage;
      bannered = applyWarningBanner(triageResult.waarschuwing, draftResult.text);
    }

    const cost =
      costUsd(triageUsage, claude.TRIAGE_MODEL) + costUsd(draftUsage, claude.DRAFT_MODEL);
    totalCost += cost;
    console.log(`klaar (€${cost.toFixed(4)})`);

    results.push({ fixture: fx, triage: triageResult, bannered, cost });
  }

  const reportPath = path.join(__dirname, "report.md");
  fs.writeFileSync(reportPath, buildReport(results, totalCost));

  const avgCost = totalCost / fixtures.length;
  console.log(`\n${fixtures.length} fixtures verwerkt. Totale kosten: €${totalCost.toFixed(4)}.`);
  console.log(`Gemiddeld €${avgCost.toFixed(4)}/mail — bij ~35 concepten/dag ruwweg €${(avgCost * 35).toFixed(2)}/dag.`);
  console.log(`Rapport: ${reportPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("run-fixtures mislukt:", err.message);
    process.exit(1);
  });
}

module.exports = { buildReport, costUsd, main };
