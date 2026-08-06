// Parses test/fixtures/*.txt. Format:
//
//   From: <sender>
//   Subject: <subject>
//
//   <inbound body>
//
//   === JOUW ANTWOORD ===
//   <the reply actually sent>

const fs = require("fs");
const path = require("path");

const MARKER = "=== JOUW ANTWOORD ===";

function parseFixture(id, text) {
  const markerIndex = text.indexOf(MARKER);
  if (markerIndex === -1) {
    throw new Error(`${id}: mist "${MARKER}"`);
  }

  const head = text.slice(0, markerIndex).trim();
  const actualReply = text.slice(markerIndex + MARKER.length).trim();

  const fromMatch = head.match(/^From:\s*(.*)$/m);
  const subjectMatch = head.match(/^Subject:\s*(.*)$/m);
  if (!fromMatch || !subjectMatch) {
    throw new Error(`${id}: mist "From:" of "Subject:" regel`);
  }

  // Body is everything after the Subject line, minus the blank line that follows it.
  const subjectLineEnd = head.indexOf(subjectMatch[0]) + subjectMatch[0].length;
  const body = head.slice(subjectLineEnd).replace(/^\n+/, "").trim();

  return {
    id,
    from: fromMatch[1].trim(),
    subject: subjectMatch[1].trim(),
    body,
    actualReply,
  };
}

/**
 * @param {string} dir - test/fixtures/
 * @returns {object[]}
 */
function loadFixtures(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .map((f) => parseFixture(f.replace(/\.txt$/, ""), fs.readFileSync(path.join(dir, f), "utf8")));
}

module.exports = { loadFixtures, parseFixture };
