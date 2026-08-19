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

check("selects only rows awaiting a draft", () => {
  const triageJson = JSON.stringify({ taal: "en", vereniging: "Okeanos" });
  const out = runCodeNode(pendingCode, {
    input: [
      { json: { concept_gemaakt: "wacht", afzender: "a@b.nl", subject: "s1", messageId: "m1", threadId: "t1", triage_json: triageJson, row_number: 2 } },
      { json: { concept_gemaakt: "ja", afzender: "c@d.nl", subject: "s2", messageId: "m2", threadId: "t2", triage_json: triageJson, row_number: 3 } },
      { json: { concept_gemaakt: "nee", afzender: "e@f.nl", subject: "s3", messageId: "m3", threadId: "t3", triage_json: triageJson, row_number: 4 } },
    ],
  });
  assert.strictEqual(out.length, 1, `expected 1 pending row, got ${out.length}`);
  assert.strictEqual(out[0].json.messageId, "m1");
  assert.strictEqual(out[0].json.language_hint, "en");
  assert.strictEqual(out[0].json.channel, "email");
});

check("survives a corrupt triage_json cell", () => {
  const out = runCodeNode(pendingCode, {
    input: [{ json: { concept_gemaakt: "wacht", afzender: "a@b.nl", subject: "s", messageId: "m", threadId: "t", triage_json: "{broken", row_number: 2 } }],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].json.language_hint, "nl", "should fall back to nl");
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

console.log(`\n${passed} checks passed.\n`);
