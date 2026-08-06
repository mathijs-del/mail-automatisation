// Loads the knowledge-base files the mailbot is allowed to use, per
// knowledge/00-INDEX.md: "De mailbot krijgt alleen A-*, C1, D1 en D2 mee."
// B-* (internal procedures) never reaches a participant-facing draft.

const fs = require("fs");
const path = require("path");

const MAILBOT_FILES = [
  "A-deelnemers/A1-traject-en-fases.md",
  "A-deelnemers/A2-clinics-en-matchmaking.md",
  "A-deelnemers/A3-materialen-en-kosten.md",
  "A-deelnemers/A4-trainingen-en-gezondheid.md",
  "A-deelnemers/A5-gala-en-ring.md",
  "A-deelnemers/A6-veelgestelde-vragen.md",
  "C-communicatie/C1-tone-of-voice.md",
  "D-data/D1-normen-en-kengetallen.md",
  "D-data/D2-begrippenlijst.md",
];

/**
 * @param {string} knowledgeDir - path to the knowledge/ directory
 * @returns {string} concatenated markdown, one section per file, each
 *   labelled with its filename so the model can cite its source.
 */
function loadKnowledgeBase(knowledgeDir) {
  const missing = [];
  const sections = MAILBOT_FILES.map((rel) => {
    const full = path.join(knowledgeDir, rel);
    if (!fs.existsSync(full)) {
      missing.push(rel);
      return null;
    }
    const content = fs.readFileSync(full, "utf8").trim();
    return `<!-- BRON: ${rel} -->\n${content}`;
  }).filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Kennisbank-bestanden ontbreken: ${missing.join(", ")}`);
  }

  return sections.join("\n\n---\n\n");
}

module.exports = { loadKnowledgeBase, MAILBOT_FILES };
