// Pure parsing + validation for the AI_TRAJECTDATA tab (CLAUDE.md §3A).
// No I/O here on purpose: sheetClient.js and scripts/validate-sheet.js
// both feed raw rows into rowsToTrajectories(), so the same rules apply
// whether the data came from a live Sheets fetch or a CSV export.

const SPEC_COLUMNS = [
  "vereniging",
  "stad",
  "sport",
  "status",
  "start_promotie",
  "informatiebijeenkomst",
  "tijd_informatiebijeenkomst",
  "locatie_informatiebijeenkomst",
  "deadline_inschrijvingen",
  "start_trainingen",
  "clinic_1",
  "clinic_2",
  "clinic_3",
  "locatie_clinics",
  "gala_datum",
  "gala_locatie",
  "gym",
  "trainingsdagen",
  "trainingslocatie",
  "trajectmanager",
  "deelnamekosten",
  "bijzonderheden",
];

const DATE_FIELDS = [
  "start_promotie",
  "informatiebijeenkomst",
  "deadline_inschrijvingen",
  "start_trainingen",
  "clinic_1",
  "clinic_2",
  "clinic_3",
  "gala_datum",
];

// Order dates are expected to occur in, for the chronology check.
const CHRONOLOGY_ORDER = [
  ["start_promotie", "start promotie"],
  ["informatiebijeenkomst", "informatiebijeenkomst"],
  ["deadline_inschrijvingen", "deadline inschrijvingen"],
  ["start_trainingen", "start trainingen"],
  ["clinic_1", "clinic 1"],
  ["clinic_2", "clinic 2"],
  ["clinic_3", "clinic 3"],
  ["gala_datum", "gala datum"],
];

const LOCATION_FIELDS = [
  "locatie_informatiebijeenkomst",
  "locatie_clinics",
  "trainingslocatie",
];

const VALID_SPORT = new Set(["boksen", "kickboksen"]);
const VALID_STATUS = new Set(["werving", "actief", "afgerond"]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * @param {string[][]} rawRows - header row followed by data rows
 * @returns {{ trajectories: object[], schemaIssues: string[] }}
 */
function rowsToTrajectories(rawRows) {
  const schemaIssues = [];
  if (rawRows.length === 0) {
    return { trajectories: [], schemaIssues: ["Tab is leeg — geen headerrij gevonden."] };
  }

  const header = rawRows[0].map((h) => h.trim());
  const missing = SPEC_COLUMNS.filter((c) => !header.includes(c));
  const unknown = header.filter((h) => h !== "" && !SPEC_COLUMNS.includes(h));

  if (missing.length > 0) {
    schemaIssues.push(`Ontbrekende kolommen: ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    schemaIssues.push(`Onbekende kolommen (worden genegeerd): ${unknown.join(", ")}`);
  }

  const trajectories = rawRows.slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r, idx) => {
      const obj = { _row: idx + 2 }; // +2: 1-indexed + header row
      header.forEach((col, i) => {
        if (SPEC_COLUMNS.includes(col)) {
          obj[col] = (r[i] ?? "").trim();
        }
      });
      // Any spec column absent from this sheet's header still exists as "" on
      // every object, so downstream code never has to check for undefined.
      SPEC_COLUMNS.forEach((c) => {
        if (!(c in obj)) obj[c] = "";
      });
      return obj;
    });

  return { trajectories, schemaIssues };
}

/**
 * @param {object[]} trajectories - output of rowsToTrajectories().trajectories
 * @returns {{ errors: {row:number, vereniging:string, message:string}[], warnings: {row:number, vereniging:string, message:string}[] }}
 */
function validateTrajectories(trajectories) {
  const errors = [];
  const warnings = [];
  const seenVereniging = new Map();

  const err = (t, message) => errors.push({ row: t._row, vereniging: t.vereniging || "(geen naam)", message });
  const warn = (t, message) => warnings.push({ row: t._row, vereniging: t.vereniging || "(geen naam)", message });

  const today = new Date().toISOString().slice(0, 10);

  for (const t of trajectories) {
    if (!t.vereniging) {
      err(t, "vereniging ontbreekt — rij kan niet gebruikt worden.");
      continue;
    }

    seenVereniging.set(t.vereniging, (seenVereniging.get(t.vereniging) || 0) + 1);

    // Date format
    for (const field of DATE_FIELDS) {
      const v = t[field];
      if (v !== "" && !isValidIsoDate(v)) {
        err(t, `${field} = "${v}" is geen geldige ISO-datum (YYYY-MM-DD). Nooit een reeks of maandnaam.`);
      }
    }

    if (t.tijd_informatiebijeenkomst !== "" && !TIME_RE.test(t.tijd_informatiebijeenkomst)) {
      err(t, `tijd_informatiebijeenkomst = "${t.tijd_informatiebijeenkomst}" moet HH:MM zijn.`);
    }

    if (t.sport !== "" && !VALID_SPORT.has(t.sport)) {
      err(t, `sport = "${t.sport}" moet leeg, "boksen" of "kickboksen" zijn.`);
    }

    if (t.status !== "" && !VALID_STATUS.has(t.status)) {
      err(t, `status = "${t.status}" moet leeg, "werving", "actief" of "afgerond" zijn.`);
    }

    // Gala in the past on an active row
    if (t.status === "actief" && isValidIsoDate(t.gala_datum) && t.gala_datum < today) {
      warn(t, `status is "actief" maar gala_datum (${t.gala_datum}) ligt in het verleden — traject waarschijnlijk "afgerond"?`);
    }

    // Clinics outside the training period
    if (isValidIsoDate(t.start_trainingen) && isValidIsoDate(t.gala_datum)) {
      for (const clinic of ["clinic_1", "clinic_2", "clinic_3"]) {
        const v = t[clinic];
        if (isValidIsoDate(v) && (v < t.start_trainingen || v > t.gala_datum)) {
          warn(t, `${clinic} (${v}) valt buiten de trainingsperiode (${t.start_trainingen} – ${t.gala_datum}).`);
        }
      }
    }

    // Chronology across all present dates
    const present = CHRONOLOGY_ORDER
      .map(([field, label]) => [field, label, t[field]])
      .filter(([, , v]) => isValidIsoDate(v));
    for (let i = 1; i < present.length; i++) {
      const [, prevLabel, prevDate] = present[i - 1];
      const [, curLabel, curDate] = present[i];
      if (curDate < prevDate) {
        warn(t, `${curLabel} (${curDate}) ligt vóór ${prevLabel} (${prevDate}) — check de volgorde.`);
      }
    }

    // Missing locations
    for (const field of LOCATION_FIELDS) {
      if (t[field] === "") {
        warn(t, `${field} is leeg.`);
      }
    }
  }

  for (const [naam, count] of seenVereniging) {
    if (count > 1) {
      warnings.push({ row: "-", vereniging: naam, message: `komt ${count}x voor in de tab — mogelijk een dubbele rij.` });
    }
  }

  return { errors, warnings };
}

module.exports = {
  SPEC_COLUMNS,
  DATE_FIELDS,
  rowsToTrajectories,
  validateTrajectories,
  isValidIsoDate,
};
