// Turns parsed AI_TRAJECTDATA rows into the readable block that goes into
// the draft prompt's second system block, alongside the knowledge base.
// Dates stay in ISO form here — draft.system.md rule 2 makes humanising
// them (without shifting them) the model's job, not this code's.

const FIELD_LABELS = [
  ["stad", "stad"],
  ["status", "status"],
  ["start_promotie", "start_promotie"],
  ["informatiebijeenkomst", "informatiebijeenkomst"],
  ["tijd_informatiebijeenkomst", "tijd_informatiebijeenkomst"],
  ["locatie_informatiebijeenkomst", "locatie_informatiebijeenkomst"],
  ["deadline_inschrijvingen", "deadline_inschrijvingen"],
  ["start_trainingen", "start_trainingen"],
  ["clinic_1", "clinic_1"],
  ["clinic_2", "clinic_2"],
  ["clinic_3", "clinic_3"],
  ["locatie_clinics", "locatie_clinics"],
  ["gala_datum", "gala_datum"],
  ["gala_locatie", "gala_locatie"],
  ["gym", "gym"],
  ["trainingsdagen", "trainingsdagen"],
  ["trainingslocatie", "trainingslocatie"],
  ["trajectmanager", "trajectmanager"],
  ["deelnamekosten", "deelnamekosten"],
  ["bijzonderheden", "bijzonderheden"],
];

/**
 * @param {object[]} trajectories - output of rowsToTrajectories().trajectories
 * @returns {string}
 */
function trajectoriesToText(trajectories) {
  const blocks = trajectories.map((t) => {
    const sportLabel = t.sport ? ` (${t.sport})` : "";
    const lines = [`### ${t.vereniging}${sportLabel}`];
    for (const [field, label] of FIELD_LABELS) {
      const value = t[field];
      if (value !== "") {
        lines.push(`${label}: ${value}`);
      }
    }
    return lines.join("\n");
  });

  return `TRAJECTORY DATA (bron: AI_TRAJECTDATA)\n\n${blocks.join("\n\n")}`;
}

module.exports = { trajectoriesToText };
