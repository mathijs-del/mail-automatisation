// Minimal RFC4180 CSV parser: quoted fields, embedded commas, "" escaping,
// and quoted newlines. Good enough for Sheets exports; no external dependency.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // Normalise line endings so \r\n inside/outside quotes behaves the same.
  const s = text.replace(/\r\n/g, "\n");

  while (i < s.length) {
    const c = s[i];

    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  // Flush the last field/row (files without a trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop a single trailing all-empty row caused by a final newline.
  if (rows.length > 0 && rows[rows.length - 1].every((v) => v === "")) {
    rows.pop();
  }

  return rows;
}

module.exports = { parseCsv };
