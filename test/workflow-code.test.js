#!/usr/bin/env node
// Exercises the JavaScript embedded in the generated workflows' Code nodes
// against realistic n8n inputs. These run inside n8n where they are painful
// to debug, so they are tested here instead.
//
//   node test/workflow-code.test.js

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const WF_DIR = path.join(__dirname, "..", "workflows");

function loadCode(workflow, nodeName) {
  const wf = JSON.parse(fs.readFileSync(path.join(WF_DIR, workflow), "utf8"));
  const node = wf.nodes.find((n) => n.name === nodeName);
  assert(node, `${workflow}: node "${nodeName}" not found`);
  return node.parameters.jsCode;
}

// Runs a Code node body with n8n's globals ($input, $, $now) mocked.
function runCodeNode(code, { input, refs = {}, now, claudeResponses }) {
  if (claudeResponses) refs = { ...refs, "Claude triage": claudeResponses };
  const $input = {
    all: () => input,
    first: () => input[0],
  };
  const $ = (nodeName) => {
    assert(refs[nodeName], `code referenced unknown node "${nodeName}"`);
    return {
      all: () => refs[nodeName],
      first: () => refs[nodeName][0],
      item: refs[nodeName][0],
    };
  };
  const fn = new Function("$input", "$", "$now", "Buffer", code);
  return fn($input, $, now, Buffer);
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\nExtract mail (gmail-adapter-triage)");

const extractCode = loadCode("gmail-adapter-triage.json", "Extract mail");
const b64url = (s) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

check("picks text/plain out of a multipart message", () => {
  const body = "Hoi, wanneer is de eerste clinic?\n\nGroeten, Sem";
  const out = runCodeNode(extractCode, {
    input: [{
      json: {
        id: "msg123", threadId: "thr456", snippet: "fallback",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            { name: "From", value: "Sem <sem@example.com>" },
            { name: "Subject", value: "Foto vraag" },
          ],
          parts: [
            { mimeType: "text/html", body: { data: b64url("<p>x</p>") } },
            { mimeType: "text/plain", body: { data: b64url(body) } },
          ],
        },
      },
    }],
  });
  assert.strictEqual(out[0].json.body, body);
  assert.strictEqual(out[0].json.sender, "Sem <sem@example.com>");
  assert.strictEqual(out[0].json.subject, "Foto vraag");
  assert.strictEqual(out[0].json.threadId, "thr456");
});

check("decodes base64url payloads containing non-ASCII", () => {
  const body = "Foto's van het gala — skøll, €170";
  const out = runCodeNode(extractCode, {
    input: [{
      json: {
        id: "m", threadId: "t", snippet: "",
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "From", value: "a@b.nl" }],
          body: { data: b64url(body) },
        },
      },
    }],
  });
  assert.strictEqual(out[0].json.body, body);
});

check("falls back to snippet when there is no text/plain part", () => {
  const out = runCodeNode(extractCode, {
    input: [{
      json: {
        id: "m", threadId: "t", snippet: "alleen HTML in deze mail",
        payload: {
          mimeType: "text/html",
          headers: [],
          body: { data: b64url("<p>hi</p>") },
        },
      },
    }],
  });
  assert.strictEqual(out[0].json.body, "alleen HTML in deze mail");
  assert.strictEqual(out[0].json.subject, "(geen onderwerp)");
});

check("truncates a runaway thread", () => {
  const out = runCodeNode(extractCode, {
    input: [{
      json: {
        id: "m", threadId: "t", snippet: "",
        payload: { mimeType: "text/plain", headers: [], body: { data: b64url("x".repeat(20000)) } },
      },
    }],
  });
  assert(out[0].json.body.length < 20000, "body should be truncated");
  assert(out[0].json.body.endsWith("[...afgekapt]"));
});

check("reads sender and subject from the simplified trigger shape", () => {
  // n8n's Gmail trigger returns flat fields when Simplify is on, or when the
  // Format option omits the raw payload. Either way the mail must survive.
  const out = runCodeNode(extractCode, {
    input: [{ json: {
      id: "m9", threadId: "t9",
      from: "Sem <sem@ex.nl>", subject: "Vraag over clinic",
      text: "Hoi, wanneer is clinic 1?", snippet: "Hoi, wanneer",
    } }],
  });
  assert.strictEqual(out[0].json.sender, "Sem <sem@ex.nl>");
  assert.strictEqual(out[0].json.subject, "Vraag over clinic");
  assert.strictEqual(out[0].json.body, "Hoi, wanneer is clinic 1?");
  assert.strictEqual(out[0].json.extractieLeeg, "");
});

check("flags a mail it could not read anything out of", () => {
  const out = runCodeNode(extractCode, {
    input: [{ json: { id: "m0", threadId: "t0" } }],
  });
  assert.strictEqual(out[0].json.extractieLeeg, "ja",
    "an unreadable trigger payload must be visible, not silently RUIS");
});

check("flattens a mailparser-style from object into a readable string", () => {
  // This is what n8n's simplified Gmail trigger actually returns.
  const out = runCodeNode(extractCode, {
    input: [{ json: {
      id: "m10", threadId: "t10",
      from: {
        value: [{ address: "mathijs@example.nl", name: "Mathijs Schoonhoven" }],
        text: "Mathijs Schoonhoven <mathijs@example.nl>",
      },
      subject: "Horeca Boxing Amsterdam",
      text: "Hi, Ik heb interesse om mee te doen.",
    } }],
  });
  assert.strictEqual(out[0].json.sender, "Mathijs Schoonhoven <mathijs@example.nl>",
    "sender must be a string, not raw JSON");
  assert.strictEqual(typeof out[0].json.sender, "string");
  assert.strictEqual(out[0].json.subject, "Horeca Boxing Amsterdam");
});

check("builds a from string when the object has no text field", () => {
  const out = runCodeNode(extractCode, {
    input: [{ json: {
      id: "m11", threadId: "t11",
      from: { value: [{ address: "a@b.nl", name: "Anna" }] },
      subject: "Vraag", text: "Hoi",
    } }],
  });
  assert.strictEqual(out[0].json.sender, "Anna <a@b.nl>");
});

console.log("\nMap labels (gmail-adapter-triage)");

const mapCode = loadCode("gmail-adapter-triage.json", "Map labels");
const mail = { messageId: "m1", threadId: "t1", sender: "a@b.nl", subject: "s", body: "b" };
// What Gmail's label list actually looks like: names paired with opaque IDs.
const LABELS = [
  "AI/1-Nu", "AI/2-Deze-week", "AI/3-FYI", "AI/Concept-klaar", "AI/Handmatig",
  "AI/Deelnemer", "AI/Vereniging", "AI/Partner", "AI/Financieel",
].map((name, i) => ({ json: { id: "Label_" + (100 + i), name } }));

const claudeResponse = (obj) => [{ json: { content: [{ type: "text", text: JSON.stringify(obj) }] } }];

check("pairs each response with its own mail in a batch", () => {
  const out = runCodeNode(mapCode, {
    input: LABELS,
    claudeResponses: [
      claudeResponse({ categorie: "DEELNEMER_PRAKTISCH", urgentie: "nu", vereniging: "Okeanos",
        taal: "nl", samenvatting: "x", concept_toegestaan: true, waarschuwing: null })[0],
      claudeResponse({ categorie: "RUIS", urgentie: "fyi", vereniging: null,
        taal: "nl", samenvatting: "y", concept_toegestaan: false, waarschuwing: null })[0],
    ],
    refs: {
      "Build triage request": [
        { json: { ...mail, messageId: "m1" } },
        { json: { ...mail, messageId: "m2" } },
      ],
    },
  });
  assert.strictEqual(out.length, 2, "should return one item per mail");
  assert.strictEqual(out[0].json.messageId, "m1");
  assert.strictEqual(out[1].json.messageId, "m2");
  assert(out[1].json.labels.includes("AI/Handmatig"), "second mail keeps its own triage");
});

check("maps a participant question to urgency + Deelnemer labels", () => {
  const out = runCodeNode(mapCode, {
    input: LABELS,
    claudeResponses: claudeResponse({
      categorie: "DEELNEMER_PRAKTISCH", urgentie: "nu", vereniging: "Okeanos",
      taal: "nl", samenvatting: "x", concept_toegestaan: true, waarschuwing: null,
    }),
    refs: { "Build triage request": [{ json: mail }] },
  });
  assert.deepStrictEqual(out[0].json.labels, ["AI/1-Nu", "AI/Deelnemer"]);
  assert.deepStrictEqual(out[0].json.labelIds, ["Label_100", "Label_105"],
    "Gmail needs IDs, not names");
  assert.deepStrictEqual(out[0].json.ontbrekendeLabels, []);
  assert.strictEqual(out[0].json.triage.vereniging, "Okeanos");
});

check("adds AI/Handmatig when no draft is allowed", () => {
  const out = runCodeNode(mapCode, {
    input: LABELS,
    claudeResponses: claudeResponse({
      categorie: "DEELNEMER_MEDISCH", urgentie: "nu", vereniging: null,
      taal: "nl", samenvatting: "x", concept_toegestaan: false, waarschuwing: "medisch",
    }),
    refs: { "Build triage request": [{ json: mail }] },
  });
  assert(out[0].json.labels.includes("AI/Handmatig"));
});

check("does not duplicate AI/Handmatig for RUIS", () => {
  const out = runCodeNode(mapCode, {
    input: LABELS,
    claudeResponses: claudeResponse({
      categorie: "RUIS", urgentie: "fyi", vereniging: null,
      taal: "nl", samenvatting: "x", concept_toegestaan: false, waarschuwing: null,
    }),
    refs: { "Build triage request": [{ json: mail }] },
  });
  const count = out[0].json.labels.filter((l) => l === "AI/Handmatig").length;
  assert.strictEqual(count, 1, `expected one AI/Handmatig, got ${count}`);
});

check("falls back to manual review when triage returns invalid JSON", () => {
  const out = runCodeNode(mapCode, {
    input: LABELS,
    claudeResponses: [{ json: { content: [{ type: "text", text: "not json at all" }] } }],
    refs: { "Build triage request": [{ json: mail }] },
  });
  assert.strictEqual(out[0].json.triage.concept_toegestaan, false);
  assert(out[0].json.labels.includes("AI/Handmatig"));
  assert(out[0].json.triage.waarschuwing);
});

check("drops a label that does not exist in Gmail instead of failing", () => {
  const out = runCodeNode(mapCode, {
    // Gmail only has the urgency label; AI/Deelnemer was never created.
    input: [{ json: { id: "Label_100", name: "AI/1-Nu" } }],
    claudeResponses: claudeResponse({
      categorie: "DEELNEMER_PRAKTISCH", urgentie: "nu", vereniging: null,
      taal: "nl", samenvatting: "x", concept_toegestaan: true, waarschuwing: null,
    }),
    refs: { "Build triage request": [{ json: mail }] },
  });
  assert.deepStrictEqual(out[0].json.labelIds, ["Label_100"]);
  assert.deepStrictEqual(out[0].json.ontbrekendeLabels, ["AI/Deelnemer"],
    "missing label should be reported, not silently lost");
});

console.log("\nBuild context (ai-draft-core)");

const buildCtxCode = loadCode("ai-draft-core.json", "Build context");

check("renders trajectory rows and skips empty fields", () => {
  const out = runCodeNode(buildCtxCode, {
    input: [
      { json: { vereniging: "Okeanos", sport: "kickboksen", stad: "", gala_datum: "2026-12-09", bijzonderheden: "" } },
      { json: { vereniging: "", sport: "" } },
    ],
    refs: {
      Constants: [{ json: { knowledge: "KB-INHOUD" } }],
      Input: [{ json: { channel: "email", sender: "a@b.nl", subject: "s", body: "b" } }],
    },
  });
  const ctx = out[0].json.contextBlock;
  assert(ctx.includes("### Okeanos (kickboksen)"), "header missing");
  assert(ctx.includes("gala_datum: 2026-12-09"), "date missing");
  assert(!ctx.includes("stad:"), "empty field should be omitted");
  assert(!ctx.includes("### \n"), "blank vereniging row should be dropped");
  assert(ctx.includes("KB-INHOUD"), "knowledge base not appended");
  assert.strictEqual(out[0].json.channel, "email", "input fields must pass through");
});

console.log("\nShape output (ai-draft-core)");

const shapeCode = loadCode("ai-draft-core.json", "Shape output");

check("prepends the warning banner and collects markers", () => {
  const draft = "Hi Sem,\n\nHier is het antwoord.\n\n[ONTBREEKT: prijs onbekend]\n\n---\nBron: A3";
  const out = runCodeNode(shapeCode, {
    input: [{ json: { content: [{ type: "text", text: draft }], usage: { input_tokens: 10 } } }],
    refs: {
      "Build context": [{ json: { triage: {
        categorie: "DEELNEMER_FINANCIEEL", urgentie: "nu", vereniging: "Okeanos",
        waarschuwing: "Gaat over geld",
      } }, }],
    },
  });
  const o = out[0].json;
  assert(o.draft_text.startsWith("⚠ Gaat over geld — extra checken"), "banner missing");
  assert.strictEqual(o.category, "DEELNEMER_FINANCIEEL");
  assert.strictEqual(o.association, "Okeanos");
  assert(o.warnings.includes("Gaat over geld"));
  assert(o.warnings.some((w) => w.startsWith("[ONTBREEKT")), "ONTBREEKT marker not collected");
  assert(o.sources.some((s) => s.includes("Bron: A3")), "source not extracted");
});

check("omits the banner when there is no warning", () => {
  const out = runCodeNode(shapeCode, {
    input: [{ json: { content: [{ type: "text", text: "Hi Sem,\n\nKort antwoord." }] } }],
    refs: {
      "Build context": [{ json: { triage: {
        categorie: "DEELNEMER_PRAKTISCH", urgentie: "fyi", vereniging: null, waarschuwing: null,
      } }, }],
    },
  });
  assert(!out[0].json.draft_text.startsWith("⚠"), "banner should be absent");
  assert.deepStrictEqual(out[0].json.warnings, []);
});

console.log("\nPending drafts (gmail-adapter-drafts)");

const pendingCode = loadCode("gmail-adapter-drafts.json", "Pending drafts");

// A log row as the Sheets node hands it over, minutes old so it passes the
// age guard. Override per test.
const sheetTime = (hoursAgo) =>
  new Date(Date.now() - hoursAgo * 3600000).toISOString().slice(0, 19).replace("T", " ");

const logRow = (over = {}) => ({
  json: {
    datum: sheetTime(0.5),
    afzender: "a@b.nl",
    categorie: "DEELNEMER_PRAKTISCH",
    concept_gemaakt: "wacht",
    subject: "Vraag over clinic",
    messageId: "m1",
    threadId: "t1",
    triage_json: JSON.stringify({ taal: "nl", vereniging: "Okeanos" }),
    ...over,
  },
});

check("selects only rows awaiting a draft", () => {
  const out = runCodeNode(pendingCode, {
    input: [
      logRow({ messageId: "m1", triage_json: JSON.stringify({ taal: "en" }) }),
      logRow({ concept_gemaakt: "ja", messageId: "m2" }),
      logRow({ concept_gemaakt: "nee", messageId: "m3" }),
    ],
  });
  assert.strictEqual(out.length, 1, `expected 1 pending row, got ${out.length}`);
  assert.strictEqual(out[0].json.messageId, "m1");
  assert.strictEqual(out[0].json.language_hint, "en");
  assert.strictEqual(out[0].json.channel, "email");
});

check("survives a corrupt triage_json cell", () => {
  const out = runCodeNode(pendingCode, {
    input: [logRow({ triage_json: "{broken" })],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].json.language_hint, "nl", "should fall back to nl");
});

check("drafts only the categories on the fase 4 allowlist", () => {
  const out = runCodeNode(pendingCode, {
    input: [
      logRow({ categorie: "DEELNEMER_PRAKTISCH", messageId: "m1" }),
      logRow({ categorie: "DEELNEMER_FINANCIEEL", messageId: "m2" }),
      logRow({ categorie: "VERENIGING_BESTUUR", messageId: "m3" }),
      logRow({ categorie: "PARTNER_SPONSOR", messageId: "m4" }),
    ],
  });
  assert.deepStrictEqual(out.map((o) => o.json.messageId), ["m1"],
    "fase 4 starts with DEELNEMER_PRAKTISCH only");
});

check("ignores rows older than the age guard", () => {
  const out = runCodeNode(pendingCode, {
    input: [
      logRow({ datum: sheetTime(2), messageId: "recent" }),
      logRow({ datum: sheetTime(24 * 9), messageId: "oud" }),
    ],
  });
  assert.deepStrictEqual(out.map((o) => o.json.messageId), ["recent"],
    "widening the allowlist must not dump weeks of backlog into drafts");
});

check("still picks up a row with an unreadable datum", () => {
  const out = runCodeNode(pendingCode, { input: [logRow({ datum: "" })] });
  assert.strictEqual(out.length, 1, "a bad date must not silently skip a mail");
});

check("skips a row without a messageId", () => {
  const out = runCodeNode(pendingCode, { input: [logRow({ messageId: "" })] });
  assert.strictEqual(out.length, 0, "without an id the mail cannot be fetched or updated");
});

console.log("\nExtract body (gmail-adapter-drafts)");

const extractBodyCode = loadCode("gmail-adapter-drafts.json", "Extract body");

const pendingItem = (over = {}) => ({
  json: {
    channel: "email", sender: "sem@ex.nl", subject: "Vraag over clinic",
    language_hint: "nl", triage: { taal: "nl" },
    messageId: "m1", threadId: "t1", conceptLabelId: "Label_103", ...over,
  },
});

check("re-fetches the body the log sheet does not store", () => {
  const body = "Hoi, wanneer is clinic 1?";
  const out = runCodeNode(extractBodyCode, {
    input: [{ json: { id: "m1", threadId: "t1", payload: {
      mimeType: "text/plain", headers: [], body: { data: b64url(body) },
    } } }],
    refs: { "Pending drafts": [pendingItem()] },
  });
  assert.strictEqual(out[0].json.body, body,
    "the draft must be written from the mail, not from the subject line");
  assert.strictEqual(out[0].json.threadId, "t1", "pending fields must pass through");
  assert.strictEqual(out[0].json.conceptLabelId, "Label_103");
  assert.strictEqual(out[0].json.bodyLeeg, "");
});

check("matches each fetched message to its own log row by id", () => {
  const out = runCodeNode(extractBodyCode, {
    // Gmail returned them in the other order than the sheet did.
    input: [
      { json: { id: "m2", payload: { mimeType: "text/plain", headers: [], body: { data: b64url("tweede") } } } },
      { json: { id: "m1", payload: { mimeType: "text/plain", headers: [], body: { data: b64url("eerste") } } } },
    ],
    refs: { "Pending drafts": [
      pendingItem({ messageId: "m1", subject: "Eerste" }),
      pendingItem({ messageId: "m2", subject: "Tweede" }),
    ] },
  });
  assert.strictEqual(out[0].json.subject, "Tweede");
  assert.strictEqual(out[0].json.body, "tweede");
  assert.strictEqual(out[1].json.subject, "Eerste");
  assert.strictEqual(out[1].json.body, "eerste");
});

check("does not stack Re: on a subject that already has one", () => {
  const fetched = [{ json: { id: "m1", snippet: "x" } }];
  const plain = runCodeNode(extractBodyCode, {
    input: fetched, refs: { "Pending drafts": [pendingItem({ subject: "Clinic" })] },
  });
  const already = runCodeNode(extractBodyCode, {
    input: fetched, refs: { "Pending drafts": [pendingItem({ subject: "Re: Clinic" })] },
  });
  assert.strictEqual(plain[0].json.replySubject, "Re: Clinic");
  assert.strictEqual(already[0].json.replySubject, "Re: Clinic");
});

check("flags a mail it could not read a body out of", () => {
  const out = runCodeNode(extractBodyCode, {
    input: [{ json: { id: "m1" } }],
    refs: { "Pending drafts": [pendingItem({ subject: "Clinic" })] },
  });
  assert.strictEqual(out[0].json.bodyLeeg, "ja");
  assert.strictEqual(out[0].json.body, "Clinic", "falls back to the subject rather than nothing");
});

console.log("\nResolve label (gmail-adapter-drafts)");

const resolveLabelCode = loadCode("gmail-adapter-drafts.json", "Resolve label");

check("resolves AI/Concept-klaar to its Gmail id", () => {
  const out = runCodeNode(resolveLabelCode, {
    input: LABELS,
    refs: { "Pending drafts": [pendingItem({ conceptLabelId: undefined })] },
  });
  assert.strictEqual(out[0].json.conceptLabelId, "Label_103",
    "Gmail's modify endpoint 400s on a label name");
  assert.strictEqual(out[0].json.messageId, "m1", "pending fields must survive");
});

check("leaves the label id empty when the label does not exist", () => {
  const out = runCodeNode(resolveLabelCode, {
    input: [{ json: { id: "Label_1", name: "Inbox" } }],
    refs: { "Pending drafts": [pendingItem({ conceptLabelId: undefined })] },
  });
  assert.strictEqual(out[0].json.conceptLabelId, "",
    "a missing label must not fail the draft run");
});

console.log("\nMerge draft (gmail-adapter-drafts)");

const mergeDraftCode = loadCode("gmail-adapter-drafts.json", "Merge draft");

check("re-attaches the mail's ids to the core's generic output", () => {
  const out = runCodeNode(mergeDraftCode, {
    input: [
      { json: { draft_text: "Concept 1", warnings: [], sources: [] } },
      { json: { draft_text: "Concept 2", warnings: [], sources: [] } },
    ],
    refs: { "Extract body": [
      pendingItem({ messageId: "m1", threadId: "t1", replySubject: "Re: Een" }),
      pendingItem({ messageId: "m2", threadId: "t2", replySubject: "Re: Twee" }),
    ] },
  });
  assert.strictEqual(out[0].json.threadId, "t1");
  assert.strictEqual(out[0].json.draft_text, "Concept 1");
  assert.strictEqual(out[1].json.threadId, "t2");
  assert.strictEqual(out[1].json.draft_text, "Concept 2");
  assert.strictEqual(out[1].json.replySubject, "Re: Twee");
});

console.log("\nBuild done row (gmail-adapter-drafts)");

const doneRowCode = loadCode("gmail-adapter-drafts.json", "Build done row");

check("emits only the match key and the column to update", () => {
  const out = runCodeNode(doneRowCode, {
    input: [],
    refs: { "Build afterwork": [
      { json: { messageId: "m1", conceptLabelId: "Label_103", concept_gemaakt: "ja" } },
    ] },
  });
  assert.deepStrictEqual(Object.keys(out[0].json), ["messageId", "concept_gemaakt"],
    "auto-mapping writes every key, so only these two may be present");
  assert.strictEqual(out[0].json.concept_gemaakt, "ja");
});

console.log("\nDraft workflow wiring");

const draftWf = JSON.parse(
  fs.readFileSync(path.join(WF_DIR, "gmail-adapter-drafts.json"), "utf8"));
const draftNode = (name) => draftWf.nodes.find((n) => n.name === name);

check("never uses a Gmail send operation", () => {
  for (const n of draftWf.nodes) {
    const op = (n.parameters || {}).operation || "";
    assert(!/^send/i.test(op), `node "${n.name}" uses operation "${op}"`);
  }
  assert.strictEqual(draftNode("Create draft").parameters.resource, "draft");
  assert.strictEqual(draftNode("Create draft").parameters.operation, "create");
});

check("writes the draft into the original thread", () => {
  const opts = draftNode("Create draft").parameters.options;
  assert(opts.threadId, "without threadId the draft lands outside the conversation");
});

check("no Sheets node relies on a defineBelow mapping", () => {
  for (const n of draftWf.nodes.filter((x) => x.type.endsWith("googleSheets"))) {
    const mode = ((n.parameters || {}).columns || {}).mappingMode;
    assert(mode !== "defineBelow",
      `node "${n.name}" uses defineBelow, which does not survive import`);
  }
  const done = draftNode("Mark done").parameters.columns;
  assert.deepStrictEqual(done.matchingColumns, ["messageId"]);
});

check("every node sits on the single linear chain", () => {
  // A node on a parallel branch may not have run when another reads from it —
  // that is what broke "Fetch labels" in the triage adapter.
  const targets = new Set();
  for (const conn of Object.values(draftWf.connections)) {
    for (const group of conn.main) {
      assert(group.length === 1, "no node may fan out to two branches");
      for (const t of group) targets.add(t.node);
    }
  }
  assert.strictEqual(targets.size, draftWf.nodes.length - 1,
    "every node except the trigger must be reachable exactly once");
});

console.log("\nBuild triage request (gmail-adapter-triage)");

const buildReqCode = loadCode("gmail-adapter-triage.json", "Build triage request");

check("builds a body that survives braces in the mail text", () => {
  const out = runCodeNode(buildReqCode, {
    input: [{ json: {
      messageId: "m1", threadId: "t1", sender: "Sem <sem@ex.nl>",
      subject: "Vraag {met accolades}",
      body: "Wanneer is clinic 1? {{ niet interpreteren }}",
    } }],
  });
  const rb = out[0].json.requestBody;
  assert.strictEqual(rb.model, "claude-haiku-4-5-20251001");
  assert(rb.messages[0].content.includes("{{ niet interpreteren }}"), "body text must survive verbatim");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(rb)), "body must serialise");
  assert.strictEqual(out[0].json.messageId, "m1", "mail fields must pass through");
});

check("builds one request per mail in a batch", () => {
  const out = runCodeNode(buildReqCode, {
    input: [
      { json: { messageId: "m1", sender: "a@b.nl", subject: "s1", body: "b1" } },
      { json: { messageId: "m2", sender: "c@d.nl", subject: "s2", body: "b2" } },
    ],
  });
  assert.strictEqual(out.length, 2);
  assert(out[1].json.requestBody.messages[0].content.includes("b2"));
});

console.log("\nBuild log row (gmail-adapter-triage)");

const logCode = loadCode("gmail-adapter-triage.json", "Build log row");

check("emits exactly the AI_LOG column names for auto-mapping", () => {
  const out = runCodeNode(logCode, {
    input: [],
    refs: { "Map labels": [{ json: {
      messageId: "m1", threadId: "t1", sender: "sem@ex.nl", subject: "Clinic vraag",
      triage: { categorie: "DEELNEMER_PRAKTISCH", urgentie: "nu",
        concept_toegestaan: true, waarschuwing: null },
      triageJson: '{"categorie":"DEELNEMER_PRAKTISCH"}',
    } }] },
  });
  assert.deepStrictEqual(Object.keys(out[0].json), [
    "datum", "afzender", "categorie", "urgentie", "concept_gemaakt",
    "waarschuwing", "resultaat", "messageId", "threadId", "subject", "triage_json",
  ], "keys must match the sheet headers exactly, in order");
  assert.strictEqual(out[0].json.concept_gemaakt, "wacht",
    "a draftable mail must be queued for the drafts workflow");
  assert.strictEqual(out[0].json.waarschuwing, "");
  assert.strictEqual(out[0].json.resultaat, "");
});

check("marks a no-draft mail as nee, not wacht", () => {
  const out = runCodeNode(logCode, {
    input: [],
    refs: { "Map labels": [{ json: {
      messageId: "m2", threadId: "t2", sender: "a@b.nl", subject: "Blessure",
      triage: { categorie: "DEELNEMER_MEDISCH", urgentie: "nu",
        concept_toegestaan: false, waarschuwing: "medisch" },
      triageJson: "{}",
    } }] },
  });
  assert.strictEqual(out[0].json.concept_gemaakt, "nee");
  assert.strictEqual(out[0].json.waarschuwing, "medisch");
});

console.log(`\n${passed} checks passed.\n`);
