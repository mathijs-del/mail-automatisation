// Warning banner, CLAUDE.md §4.3: a reviewer cue prepended to the draft
// when triage flagged a waarschuwing — never a block, always still a draft.

function applyWarningBanner(waarschuwing, draftText) {
  if (!waarschuwing) return draftText;
  return `⚠ ${waarschuwing} — extra checken voordat je verstuurt\n${draftText}`;
}

module.exports = { applyWarningBanner };
