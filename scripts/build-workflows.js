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
      // Only anthropic-version here. n8n's JSON body mode sets Content-Type
      // itself; adding our own produced a duplicate header and a 400.
      sendHeaders: true,
      headerParameters: {
        parameter: [
          { name: "anthropic-version", value: "2023-06-01" },
        ],
      },
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

return $input.all().map(item => {
  const msg = item.json;
  const headers = {};
  for (const h of (msg.payload && msg.payload.headers) || []) {
    headers[h.name.toLowerCase()] = h.value;
  }
  let body = findPlainText(msg.payload) || msg.snippet || '';
  // Cap runaway threads — the tail of a long quote adds cost without signal.
  if (body.length > 12000) body = body.slice(0, 12000) + '\\n\\n[...afgekapt]';

  return { json: {
    messageId: msg.id,
    threadId: msg.threadId,
    sender: headers.from || '',
    subject: headers.subject || '(geen onderwerp)',
    body,
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
for (const l of $('Fetch labels').all()) {
  if (l.json && l.json.name) idByName[l.json.name] = l.json.id;
}

// Pair each Claude response with its mail by index — a Gmail poll can return
// several new messages, and the HTTP node preserves item order.
const mails = $('Build triage request').all();

return $input.all().map((item, i) => {
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
      position: [200, 200],
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
      position: [1000, 0],
      name: "Apply labels",
    },
    {
      parameters: {
        operation: "append",
        documentId: sheetPicker(),
        sheetName: sheetPicker(),
        columns: {
          mappingMode: "defineBelow",
          value: {
            datum: "={{ $now.toISO() }}",
            afzender: "={{ $json.sender }}",
            categorie: "={{ $json.triage.categorie }}",
            urgentie: "={{ $json.triage.urgentie }}",
            concept_gemaakt: "={{ $json.triage.concept_toegestaan ? 'wacht' : 'nee' }}",
            waarschuwing: "={{ $json.triage.waarschuwing || '' }}",
            resultaat: "",
            messageId: "={{ $json.messageId }}",
            threadId: "={{ $json.threadId }}",
            subject: "={{ $json.subject }}",
            triage_json: "={{ $json.triageJson }}",
          },
        },
        options: {},
      },
      type: "n8n-nodes-base.googleSheets",
      typeVersion: 4.5,
      position: [1200, 0],
      name: "Append log row",
    },
  ];

  return {
    name: "gmail-adapter-triage",
    nodes,
    connections: connect([
      ["Gmail Trigger", ["Fetch labels", "Extract mail"]],
      ["Extract mail", "Build triage request"],
      ["Build triage request", "Claude triage"],
      ["Claude triage", "Map labels"],
      ["Map labels", "Apply labels"],
      ["Apply labels", "Append log row"],
    ]),
    settings: { executionOrder: "v1" },
  };
}

// --- gmail-adapter-drafts -------------------------------------------------
// Every 2 hours: pick up everything triage marked 'wacht', draft it, write the
// draft into the original thread. Batching is what keeps the Sonnet cost down;
// one cache write per batch instead of one per mail.

function buildDraftAdapter() {
  const pendingCode = `
// Only rows triage marked as awaiting a draft.
return $input.all()
  .filter(i => String(i.json.concept_gemaakt || '').trim() === 'wacht')
  .map(i => {
    let triage = {};
    try { triage = JSON.parse(i.json.triage_json); } catch (e) {}
    return { json: {
      channel: 'email',
      sender: i.json.afzender,
      subject: i.json.subject,
      body: i.json.body || i.json.subject,
      language_hint: triage.taal || 'nl',
      triage,
      messageId: i.json.messageId,
      threadId: i.json.threadId,
      rowNumber: i.json.row_number,
    } };
  });
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
      position: [600, 0],
      name: "ai-draft-core",
    },
    {
      parameters: {
        resource: "draft",
        operation: "create",
        subject: "=Re: {{ $('Pending drafts').item.json.subject }}",
        message: "={{ $json.draft_text }}",
        options: {
          threadId: "={{ $('Pending drafts').item.json.threadId }}",
          sendTo: "={{ $('Pending drafts').item.json.sender }}",
        },
      },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [800, 0],
      name: "Create draft",
    },
    {
      parameters: {
        operation: "addLabels",
        messageId: "={{ $('Pending drafts').item.json.messageId }}",
        labelIds: ["AI/Concept-klaar"],
      },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [1000, 0],
      name: "Label concept-klaar",
    },
    {
      parameters: {
        operation: "update",
        documentId: sheetPicker(),
        sheetName: sheetPicker(),
        columns: {
          mappingMode: "defineBelow",
          value: {
            row_number: "={{ $('Pending drafts').item.json.rowNumber }}",
            concept_gemaakt: "ja",
          },
        },
        options: {},
      },
      type: "n8n-nodes-base.googleSheets",
      typeVersion: 4.5,
      position: [1200, 0],
      name: "Mark done",
    },
  ];

  return {
    name: "gmail-adapter-drafts",
    nodes,
    connections: connect([
      ["Every 2 hours", "Read log"],
      ["Read log", "Pending drafts"],
      ["Pending drafts", "ai-draft-core"],
      ["ai-draft-core", "Create draft"],
      ["Create draft", "Label concept-klaar"],
      ["Label concept-klaar", "Mark done"],
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
