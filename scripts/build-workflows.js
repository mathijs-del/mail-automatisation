#!/usr/bin/env node
// Generates the importable n8n workflow JSON in workflows/.
//
// The knowledge base and both prompts are embedded into the generated
// JSON rather than fetched at runtime: n8n Cloud cannot read this private
// repo, and a byte-stable context block is what makes Claude's prompt
// cache actually hit. Trajectory data is NOT embedded — it is read live
// from Sheets on every run, so edits to AI_Trajectdata take effect on the
// next run with no rebuild.
//
// Re-run after changing anything in knowledge/ or prompts/, then re-import
// the affected workflow in n8n.
//
//   node scripts/build-workflows.js

const fs = require("fs");
const path = require("path");
const { loadKnowledgeBase } = require("../lib/knowledge");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "workflows");

const TRIAGE_MODEL = "claude-haiku-4-5-20251001";
const DRAFT_MODEL = "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const knowledge = loadKnowledgeBase(path.join(ROOT, "knowledge"));
const triagePrompt = fs.readFileSync(path.join(ROOT, "prompts", "triage.system.md"), "utf8");
const draftPrompt = fs.readFileSync(path.join(ROOT, "prompts", "draft.system.md"), "utf8");

// Category -> Gmail label. Urgency labels are separate; see URGENCY_LABELS.
const CATEGORY_LABELS = {
  DEELNEMER_PRAKTISCH: "AI/Deelnemer",
  DEELNEMER_INSCHRIJF: "AI/Deelnemer",
  DEELNEMER_FINANCIEEL: "AI/Financieel",
  DEELNEMER_AFMELDING: "AI/Deelnemer",
  DEELNEMER_MEDISCH: "AI/Deelnemer",
  DEELNEMER_MATCHMAKING: "AI/Deelnemer",
  VERENIGING_BESTUUR: "AI/Vereniging",
  PARTNER_SPONSOR: "AI/Partner",
  HORECA_OUTREACH: "AI/Partner",
  LEVERANCIER_LOCATIE: "AI/Partner",
  INTERN: "AI/Handmatig",
  RUIS: "AI/Handmatig",
};

const URGENCY_LABELS = {
  nu: "AI/1-Nu",
  deze_week: "AI/2-Deze-week",
  fyi: "AI/3-FYI",
};

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    categorie: { type: "string", enum: Object.keys(CATEGORY_LABELS) },
    urgentie: { type: "string", enum: ["nu", "deze_week", "fyi"] },
    vereniging: { anyOf: [{ type: "string" }, { type: "null" }] },
    taal: { type: "string", enum: ["nl", "en"] },
    samenvatting: { type: "string" },
    concept_toegestaan: { type: "boolean" },
    waarschuwing: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: [
    "categorie", "urgentie", "vereniging", "taal",
    "samenvatting", "concept_toegestaan", "waarschuwing",
  ],
  additionalProperties: false,
};

// --- shared node builders -------------------------------------------------

// The API key is NOT put in the workflow JSON. It lives in an n8n
// "Header Auth" credential (name: x-api-key, value: the key), which the
// HTTP nodes reference below. n8n Variables are a paid-plan feature, so
// everything else is a node setting the user picks in the UI.
const ANTHROPIC_CREDENTIAL_NAME = "Anthropic API key";

function anthropicHeaders() {
  return {
    parameters: {
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      // Headers as a single JSON field rather than a keypair list: n8n
      // silently dropped the keypair form on import, leaving the node with no
      // anthropic-version header and a 400 from the API. Content-Type is not
      // set here — n8n's JSON body mode adds it, and a duplicate also 400s.
      sendHeaders: true,
      specifyHeaders: "json",
      jsonHeaders: '{"anthropic-version": "2023-06-01"}',
    },
    credentials: {
      httpHeaderAuth: { name: ANTHROPIC_CREDENTIAL_NAME },
    },
  };
}

// Rendered as a picker in n8n. Leaving the value empty makes the node show
// as unconfigured, which is the intended prompt to choose the sheet.
function sheetPicker() {
  return { __rl: true, value: "", mode: "list", cachedResultName: "" };
}

// The request body is assembled in a preceding Code node, never inlined into
// the jsonBody expression. Inlining it puts the mail's own {{ }} placeholders
// inside n8n's outer {{ }} expression, and the nested braces make n8n's parser
// fail with "invalid syntax".
function anthropicHttpNode(name, position, timeout) {
  return {
    parameters: {
      method: "POST",
      url: ANTHROPIC_URL,
      ...anthropicHeaders().parameters,
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify($json.requestBody) }}",
      options: { timeout },
    },
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
    name,
    credentials: anthropicHeaders().credentials,
  };
}

// Builds the triage request per incoming mail. Runs for all items, so a batch
// of new mail is handled in one pass.
function buildTriageRequestCode() {
  return `
const SYSTEM = ${JSON.stringify(triagePrompt)};
const SCHEMA = ${JSON.stringify(TRIAGE_SCHEMA)};

return $input.all().map(item => {
  const mail = item.json;
  return { json: { ...mail, requestBody: {
    model: ${JSON.stringify(TRIAGE_MODEL)},
    max_tokens: 300,
    temperature: 0,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: 'From: ' + mail.sender + '\\nSubject: ' + mail.subject + '\\n\\n' + mail.body,
    }],
  } } };
});
`.trim();
}

// Shared by both Gmail adapters: the trigger and message:get return the same
// awkward mix of shapes, and getting this wrong silently empties the mail.
const MAIL_HELPERS = `
// Gmail returns the body base64url-encoded, possibly nested in parts.
function decode(data) {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function findPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decode(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const found = findPlainText(part);
    if (found) return found;
  }
  return '';
}
// An address field can be a plain string OR a mailparser-style object
// ({value:[{address,name}], text}). Taking the object verbatim wrote raw
// JSON into the log and sent "[object Object]" to the classifier.
function asAddress(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v.text === 'string' && v.text) return v.text;
  const first = Array.isArray(v.value) ? v.value[0] : null;
  if (first) return first.name ? first.name + ' <' + first.address + '>' : (first.address || '');
  return '';
}
function asText(v) {
  if (!v) return '';
  return typeof v === 'string' ? v : (typeof v.text === 'string' ? v.text : '');
}
// Cap runaway threads — the tail of a long quote adds cost without signal.
function mailBody(msg) {
  let body = findPlainText(msg.payload) || asText(msg.text) || asText(msg.textAsHtml) || msg.snippet || '';
  if (body.length > 12000) body = body.slice(0, 12000) + '\\n\\n[...afgekapt]';
  return body;
}
`.trim();

function codeNode(name, position, jsCode) {
  return {
    parameters: { jsCode },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    name,
  };
}

// `to` may be a single node name or an array, for parallel branches.
function connect(pairs) {
  const out = {};
  for (const [from, to] of pairs) {
    const targets = Array.isArray(to) ? to : [to];
    out[from] = { main: [targets.map((node) => ({ node, type: "main", index: 0 }))] };
  }
  return out;
}

// --- ai-draft-core --------------------------------------------------------
// Channel-agnostic. Input:  { channel, sender, subject, body, language_hint, triage? }
//                  Output: { category, urgency, association, draft_text, warnings[], sources[] }

function buildCore() {
  const buildContextCode = `
// Turn the AI_Trajectdata rows into the text block that goes in system block 2,
// then append the knowledge base. Dates stay ISO here — humanising them without
// shifting them is the model's job (draft prompt rule 2).
const FIELDS = [
  'stad','status','start_promotie','informatiebijeenkomst','tijd_informatiebijeenkomst',
  'locatie_informatiebijeenkomst','deadline_inschrijvingen','start_trainingen',
  'clinic_1','clinic_2','clinic_3','locatie_clinics','gala_datum','gala_locatie',
  'gym','trainingsdagen','trainingslocatie','trajectmanager','deelnamekosten','bijzonderheden',
];

const rows = $input.all().map(i => i.json).filter(r => (r.vereniging || '').trim() !== '');

const blocks = rows.map(r => {
  const sport = (r.sport || '').trim();
  const lines = ['### ' + r.vereniging + (sport ? ' (' + sport + ')' : '')];
  for (const f of FIELDS) {
    const v = (r[f] === undefined || r[f] === null) ? '' : String(r[f]).trim();
    if (v !== '') lines.push(f + ': ' + v);
  }
  return lines.join('\\n');
});

const KNOWLEDGE = $('Constants').first().json.knowledge;

const contextBlock =
  'TRAJECTORY DATA (bron: AI_TRAJECTDATA)\\n\\n' + blocks.join('\\n\\n') +
  '\\n\\n---\\n\\nKENNISBANK\\n\\n' + KNOWLEDGE;

const input = $('Input').first().json;
const triage = input.triage || {};

// Assembled here rather than in the HTTP node's jsonBody: the mail body can
// contain braces, and nesting those inside n8n's {{ }} breaks its parser.
const requestBody = {
  model: DRAFT_MODEL_ID,
  max_tokens: 4000,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'medium' },
  system: [
    { type: 'text', text: DRAFT_PROMPT },
    { type: 'text', text: contextBlock, cache_control: { type: 'ephemeral', ttl: '1h' } },
  ],
  messages: [{
    role: 'user',
    content:
      'Kanaal: ' + (input.channel || 'email') + '\\n' +
      'Van: ' + (input.sender || '') + '\\n' +
      'Onderwerp: ' + (input.subject || '') + '\\n' +
      'Herkende vereniging: ' + (triage.vereniging || 'onbekend') + '\\n' +
      'Waarschuwing voor reviewer: ' + (triage.waarschuwing || 'geen') + '\\n\\n' +
      (input.body || ''),
  }],
};

return [{ json: { ...input, triage, contextBlock, requestBody } }];
`.trim();

  const shapeOutputCode = `
// Warning banner (CLAUDE.md §4.3) — a reviewer cue, never a block.
const item = $input.first().json;
const triage = $('Build context').first().json.triage;
const raw = (item.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

let draftText = raw;
if (triage.waarschuwing) {
  draftText = '⚠ ' + triage.waarschuwing + ' — extra checken voordat je verstuurt\\n' + raw;
}

// Everything from the '---' line down is reviewer metadata, not part of the mail.
const sources = [];
const sep = raw.lastIndexOf('\\n---');
if (sep !== -1) {
  const tail = raw.slice(sep + 4).trim();
  if (tail) sources.push(tail);
}

const warnings = [];
if (triage.waarschuwing) warnings.push(triage.waarschuwing);
for (const m of raw.matchAll(/\\[(ONTBREEKT|AANNAME):[^\\]]*\\]/g)) warnings.push(m[0]);

return [{ json: {
  category: triage.categorie,
  urgency: triage.urgentie,
  association: triage.vereniging,
  draft_text: draftText,
  warnings,
  sources,
  usage: item.usage || {},
} }];
`.trim();

  const nodes = [
    {
      parameters: { workflowInputs: { values: [
        { name: "channel" }, { name: "sender" }, { name: "subject" },
        { name: "body" }, { name: "language_hint" }, { name: "triage" },
      ] } },
      type: "n8n-nodes-base.executeWorkflowTrigger",
      typeVersion: 1.1,
      position: [0, 0],
      name: "Input",
    },
    codeNode("Constants", [200, 0],
      `return [{ json: { knowledge: ${JSON.stringify(knowledge)} } }];`),
    {
      parameters: {
        documentId: sheetPicker(),
        sheetName: sheetPicker(),
        options: {},
      },
      type: "n8n-nodes-base.googleSheets",
      typeVersion: 4.5,
      position: [400, 0],
      name: "Read AI_Trajectdata",
    },
    codeNode("Build context", [600, 0],
      `const DRAFT_MODEL_ID = ${JSON.stringify(DRAFT_MODEL)};\n` +
      `const DRAFT_PROMPT = ${JSON.stringify(draftPrompt)};\n` +
      buildContextCode),
    anthropicHttpNode("Claude draft", [800, 0], 180000),
    codeNode("Shape output", [1000, 0], shapeOutputCode),
  ];

  return {
    name: "ai-draft-core",
    nodes,
    connections: connect([
      ["Input", "Constants"],
      ["Constants", "Read AI_Trajectdata"],
      ["Read AI_Trajectdata", "Build context"],
      ["Build context", "Claude draft"],
      ["Claude draft", "Shape output"],
    ]),
    settings: { executionOrder: "v1" },
  };
}

// --- gmail-adapter-triage -------------------------------------------------
// Runs per incoming mail. Labels immediately so urgent mail is visible in the
// inbox right away; drafting is batched separately (see gmail-adapter-drafts).

function buildTriageAdapter() {
  const extractCode = `
${MAIL_HELPERS}

return $input.all().map(item => {
  const msg = item.json;

  // The Gmail trigger's shape varies with the Simplify toggle and the Format
  // option, so read every variant rather than assuming the raw payload is
  // there. Getting this wrong silently empties sender/subject/body, and
  // triage then classifies an empty mail as RUIS.
  const headers = {};
  for (const h of (msg.payload && msg.payload.headers) || []) {
    headers[h.name.toLowerCase()] = h.value;
  }
  // Simplified output puts the same values at the top level, or under .headers.
  const flat = msg.headers && !Array.isArray(msg.headers) ? msg.headers : {};

  const sender = asAddress(headers.from || msg.from || flat.from || flat.From);
  const subject = asText(headers.subject || msg.subject || flat.subject || flat.Subject);
  const body = mailBody(msg);

  return { json: {
    messageId: msg.id,
    threadId: msg.threadId,
    sender,
    subject: subject || '(geen onderwerp)',
    body,
    // Surfaced so a misread trigger payload is visible in the log instead of
    // quietly turning every mail into RUIS.
    extractieLeeg: (!sender && !subject && !body) ? 'ja' : '',
  } };
});
`.trim();

  const mapLabelsCode = `
const CATEGORY_LABELS = ${JSON.stringify(CATEGORY_LABELS, null, 2)};
const URGENCY_LABELS = ${JSON.stringify(URGENCY_LABELS, null, 2)};

// Gmail's API takes label IDs, not names, so resolve them from the live label
// list. A name that has no matching label is dropped with a warning rather
// than failing the whole mail.
const idByName = {};
for (const l of $input.all()) {
  if (l.json && l.json.name) idByName[l.json.name] = l.json.id;
}

// Pair each Claude response with its mail by index — a Gmail poll can return
// several new messages, and the HTTP node preserves item order.
const mails = $('Build triage request').all();
const responses = $('Claude triage').all();

return responses.map((item, i) => {
  const mail = mails[i] ? mails[i].json : {};
  const text = (item.json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

  let triage;
  try {
    triage = JSON.parse(text);
  } catch (e) {
    // Never drop a mail because triage failed — fall back to manual review.
    triage = {
      categorie: 'INTERN', urgentie: 'deze_week', vereniging: null, taal: 'nl',
      samenvatting: 'Triage mislukt, handmatig bekijken',
      concept_toegestaan: false, waarschuwing: 'Triage gaf geen geldige JSON terug',
    };
  }

  const labels = [URGENCY_LABELS[triage.urgentie], CATEGORY_LABELS[triage.categorie]].filter(Boolean);
  if (!triage.concept_toegestaan && !labels.includes('AI/Handmatig')) labels.push('AI/Handmatig');

  const labelIds = labels.map(n => idByName[n]).filter(Boolean);
  const ontbrekend = labels.filter(n => !idByName[n]);

  return { json: {
    messageId: mail.messageId, threadId: mail.threadId, sender: mail.sender,
    subject: mail.subject, body: mail.body,
    triage, labels, labelIds,
    ontbrekendeLabels: ontbrekend,
    triageJson: JSON.stringify(triage),
  } };
});
`.trim();

  const nodes = [
    {
      parameters: { pollTimes: { item: [{ mode: "everyMinute" }] }, simple: false, filters: {}, options: {} },
      type: "n8n-nodes-base.gmailTrigger",
      typeVersion: 1.2,
      position: [0, 0],
      name: "Gmail Trigger",
    },
    {
      parameters: { resource: "label", operation: "getAll", returnAll: true },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [800, 0],
      name: "Fetch labels",
      // One call per run; the label set is tiny and rarely changes.
      executeOnce: true,
    },
    codeNode("Extract mail", [200, 0], extractCode),
    codeNode("Build triage request", [400, 0], buildTriageRequestCode()),
    anthropicHttpNode("Claude triage", [600, 0], 60000),
    codeNode("Map labels", [800, 0], mapLabelsCode),
    {
      parameters: {
        operation: "addLabels",
        messageId: "={{ $json.messageId }}",
        labelIds: "={{ $json.labelIds }}",
      },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [1200, 0],
      name: "Apply labels",
    },
    // Emits keys that exactly match the AI_LOG column headers, so the Sheets
    // node can auto-map. A defineBelow mapping does not survive import — it
    // arrives with an empty "Values to Send" and the node refuses to run.
    codeNode("Build log row", [1400, 0], `
const rows = $('Map labels').all();

return rows.map(r => {
  const j = r.json;
  const t = j.triage || {};
  return { json: {
    // Local Amsterdam time, sortable: '2026-08-19 10:05:32'. UTC in the sheet
    // does not line up with what Gmail shows and made rows look mismatched.
    datum: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }),
    afzender: j.sender || '',
    categorie: t.categorie || '',
    urgentie: t.urgentie || '',
    // 'wacht' is what gmail-adapter-drafts picks up every 2 hours.
    concept_gemaakt: t.concept_toegestaan ? 'wacht' : 'nee',
    waarschuwing: t.waarschuwing || '',
    resultaat: '',
    messageId: j.messageId || '',
    threadId: j.threadId || '',
    subject: j.subject || '',
    triage_json: j.triageJson || '',
  } };
});
`.trim()),
    {
      parameters: {
        operation: "append",
        documentId: sheetPicker(),
        sheetName: sheetPicker(),
        columns: { mappingMode: "autoMapInputData", matchingColumns: [] },
        options: {},
      },
      type: "n8n-nodes-base.googleSheets",
      typeVersion: 4.5,
      position: [1600, 0],
      name: "Append log row",
    },
  ];

  return {
    name: "gmail-adapter-triage",
    nodes,
    connections: connect([
      ["Gmail Trigger", "Extract mail"],
      ["Extract mail", "Build triage request"],
      ["Build triage request", "Claude triage"],
      ["Claude triage", "Fetch labels"],
      ["Fetch labels", "Map labels"],
      ["Map labels", "Apply labels"],
      ["Apply labels", "Build log row"],
      ["Build log row", "Append log row"],
    ]),
    settings: { executionOrder: "v1" },
  };
}

// --- gmail-adapter-drafts -------------------------------------------------
// Every 2 hours: pick up everything triage marked 'wacht', draft it, write the
// draft into the original thread. Batching is what keeps the Sonnet cost down;
// one cache write per batch instead of one per mail.

const CONCEPT_LABEL = "AI/Concept-klaar";

function buildDraftAdapter() {
  const pendingCode = `
// --- Fase 4-instelling ----------------------------------------------------
// Begin met alleen praktische deelnemersvragen (CLAUDE.md §7). Uitbreiden doe
// je hier: zet er een categorie bij zodra AI_LOG laat zien dat die goed gaat.
// ['*'] zet alle categorieen aan die triage al op 'wacht' zet.
const TOEGESTANE_CATEGORIEEN = ['DEELNEMER_PRAKTISCH'];

// Rijen ouder dan dit worden niet meer opgepakt. Zonder deze grens zou het
// uitbreiden van de lijst hierboven ineens weken oude, allang met de hand
// beantwoorde mail alsnog van een concept voorzien.
const MAX_LEEFTIJD_UREN = 72;
// --------------------------------------------------------------------------

const nu = Date.now();

function binnenTermijn(waarde) {
  // Sheets geeft 'YYYY-MM-DD HH:MM:SS' terug, soms al als Date.
  const d = waarde instanceof Date ? waarde : new Date(String(waarde || '').replace(' ', 'T'));
  if (isNaN(d.getTime())) return true;   // onleesbare datum: liever wel oppakken
  return (nu - d.getTime()) / 3600000 <= MAX_LEEFTIJD_UREN;
}

return $input.all()
  .filter(i => String(i.json.concept_gemaakt || '').trim() === 'wacht')
  // Zonder messageId kunnen we de mail niet ophalen en de rij niet terugvinden.
  .filter(i => String(i.json.messageId || '').trim() !== '')
  .filter(i => TOEGESTANE_CATEGORIEEN.includes('*') ||
               TOEGESTANE_CATEGORIEEN.includes(String(i.json.categorie || '').trim()))
  .filter(i => binnenTermijn(i.json.datum))
  .map(i => {
    let triage = {};
    try { triage = JSON.parse(i.json.triage_json); } catch (e) {}
    return { json: {
      channel: 'email',
      sender: String(i.json.afzender || ''),
      subject: String(i.json.subject || ''),
      language_hint: triage.taal || 'nl',
      triage,
      messageId: String(i.json.messageId),
      threadId: String(i.json.threadId || ''),
    } };
  });
`.trim();

  // The log sheet deliberately has no body column — a full mail body per row
  // would make a sheet that is re-read every 2 hours unusable. The body is
  // re-fetched from Gmail here instead.
  const extractBodyCode = `
${MAIL_HELPERS}

const pending = $('Pending drafts').all().map(p => p.json);
const byId = {};
for (const p of pending) byId[p.messageId] = p;

return $input.all().map((item, i) => {
  const msg = item.json;
  const base = byId[msg.id] || pending[i] || {};
  const body = mailBody(msg);

  // Re: Re: Re: — Gmail already threads on threadId, the prefix is cosmetic.
  const subject = base.subject || '';
  const replySubject = /^\\s*re\\s*:/i.test(subject) ? subject : 'Re: ' + subject;

  return {
    json: { ...base, body: body || subject, replySubject, bodyLeeg: body ? '' : 'ja' },
    pairedItem: { item: i },
  };
});
`.trim();

  const resolveLabelCode = `
// Gmail's API takes label IDs, not names. Passing the name straight through is
// what made the triage workflow's label node return a 400.
const idByName = {};
for (const l of $input.all()) {
  if (l.json && l.json.name) idByName[l.json.name] = l.json.id;
}
const conceptLabelId = idByName[${JSON.stringify(CONCEPT_LABEL)}] || '';

return $('Pending drafts').all().map(p => ({ json: { ...p.json, conceptLabelId } }));
`.trim();

  // ai-draft-core returns only the generic contract, so the mail's own ids are
  // re-attached here by position rather than through $('...').item — a Code
  // node upstream can leave n8n unable to resolve that pairing at all.
  const mergeDraftCode = `
const mails = $('Extract body').all();

return $input.all().map((item, i) => {
  const mail = mails[i] ? mails[i].json : {};
  return {
    json: { ...mail, ...item.json },
    pairedItem: { item: i },
  };
});
`.trim();

  const afterworkCode = `
// One item per created draft, carrying everything the label node and the sheet
// update still need.
return $('Merge draft').all().map(m => ({ json: {
  messageId: m.json.messageId,
  conceptLabelId: m.json.conceptLabelId || '',
  concept_gemaakt: 'ja',
} }));
`.trim();

  const nodes = [
    {
      parameters: { rule: { interval: [{ field: "hours", hoursInterval: 2 }] } },
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      position: [0, 0],
      name: "Every 2 hours",
    },
    {
      parameters: {
        documentId: sheetPicker(),
        sheetName: sheetPicker(),
        options: {},
      },
      type: "n8n-nodes-base.googleSheets",
      typeVersion: 4.5,
      position: [200, 0],
      name: "Read log",
    },
    codeNode("Pending drafts", [400, 0], pendingCode),
    {
      parameters: { resource: "label", operation: "getAll", returnAll: true },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [600, 0],
      name: "Fetch labels",
      executeOnce: true,
    },
    codeNode("Resolve label", [800, 0], resolveLabelCode),
    {
      parameters: {
        operation: "get",
        messageId: "={{ $json.messageId }}",
        simple: false,
        options: {},
      },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [1000, 0],
      name: "Fetch message",
    },
    codeNode("Extract body", [1200, 0], extractBodyCode),
    {
      parameters: {
        workflowId: { __rl: true, value: "", mode: "list", cachedResultName: "" },
        workflowInputs: {
          mappingMode: "defineBelow",
          value: {
            channel: "={{ $json.channel }}",
            sender: "={{ $json.sender }}",
            subject: "={{ $json.subject }}",
            body: "={{ $json.body }}",
            language_hint: "={{ $json.language_hint }}",
            triage: "={{ $json.triage }}",
          },
        },
        options: { waitForSubWorkflow: true },
      },
      type: "n8n-nodes-base.executeWorkflow",
      typeVersion: 1.2,
      position: [1400, 0],
      name: "ai-draft-core",
    },
    codeNode("Merge draft", [1600, 0], mergeDraftCode),
    {
      parameters: {
        resource: "draft",
        operation: "create",
        subject: "={{ $json.replySubject }}",
        emailType: "text",
        message: "={{ $json.draft_text }}",
        options: {
          // threadId is what puts the draft inside the original conversation.
          // Never a send operation — CLAUDE.md §8.
          threadId: "={{ $json.threadId }}",
          sendTo: "={{ $json.sender }}",
        },
      },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [1800, 0],
      name: "Create draft",
    },
    codeNode("Build afterwork", [2000, 0], afterworkCode),
    {
      parameters: {
        operation: "addLabels",
        messageId: "={{ $json.messageId }}",
        labelIds: "={{ $json.conceptLabelId ? [$json.conceptLabelId] : [] }}",
      },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [2200, 0],
      name: "Label concept-klaar",
    },
    // Same auto-map trick as the triage adapter: a defineBelow mapping does not
    // survive import and leaves the node with an empty "Values to Send".
    // The row is found by messageId, so no row number has to be tracked.
    codeNode("Build done row", [2400, 0], `
return $('Build afterwork').all().map(a => ({ json: {
  messageId: a.json.messageId,
  concept_gemaakt: 'ja',
} }));
`.trim()),
    {
      parameters: {
        operation: "update",
        documentId: sheetPicker(),
        sheetName: sheetPicker(),
        columns: { mappingMode: "autoMapInputData", matchingColumns: ["messageId"] },
        options: {},
      },
      type: "n8n-nodes-base.googleSheets",
      typeVersion: 4.5,
      position: [2600, 0],
      name: "Mark done",
    },
  ];

  return {
    name: "gmail-adapter-drafts",
    nodes,
    connections: connect([
      ["Every 2 hours", "Read log"],
      ["Read log", "Pending drafts"],
      ["Pending drafts", "Fetch labels"],
      ["Fetch labels", "Resolve label"],
      ["Resolve label", "Fetch message"],
      ["Fetch message", "Extract body"],
      ["Extract body", "ai-draft-core"],
      ["ai-draft-core", "Merge draft"],
      ["Merge draft", "Create draft"],
      ["Create draft", "Build afterwork"],
      ["Build afterwork", "Label concept-klaar"],
      ["Label concept-klaar", "Build done row"],
      ["Build done row", "Mark done"],
    ]),
    settings: { executionOrder: "v1" },
  };
}

// --- write ----------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ["ai-draft-core.json", buildCore()],
  ["gmail-adapter-triage.json", buildTriageAdapter()],
  ["gmail-adapter-drafts.json", buildDraftAdapter()],
];

for (const [file, wf] of outputs) {
  const full = path.join(OUT_DIR, file);
  fs.writeFileSync(full, JSON.stringify(wf, null, 2) + "\n", "utf8");
  const kb = (fs.statSync(full).size / 1024).toFixed(0);
  console.log(`  ${file}  (${wf.nodes.length} nodes, ${kb} kB)`);
}

console.log(`\nKennisbank ingebed: ${(knowledge.length / 1024).toFixed(1)} kB tekst.`);
console.log("Herimporteer de workflows in n8n na elke wijziging in knowledge/ of prompts/.");
