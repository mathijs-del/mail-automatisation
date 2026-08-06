// Wraps the two Claude API calls (triage + draft). No n8n, no Gmail — this
// is the channel-agnostic "brain" the sub-workflow will call into later.
// See CLAUDE.md §4/§5 for the exact rules and model choices this encodes.

const Anthropic = require("@anthropic-ai/sdk");
const AnthropicClient = Anthropic.default || Anthropic;

const TRIAGE_MODEL = "claude-haiku-4-5-20251001";
const DRAFT_MODEL = "claude-sonnet-5";

const CATEGORIES = [
  "DEELNEMER_PRAKTISCH",
  "DEELNEMER_INSCHRIJF",
  "DEELNEMER_FINANCIEEL",
  "DEELNEMER_AFMELDING",
  "DEELNEMER_MEDISCH",
  "DEELNEMER_MATCHMAKING",
  "VERENIGING_BESTUUR",
  "PARTNER_SPONSOR",
  "HORECA_OUTREACH",
  "LEVERANCIER_LOCATIE",
  "INTERN",
  "RUIS",
];

// Enforced via structured outputs rather than trusted from prompt text alone
// ("Respond with JSON only") — guarantees valid, parseable triage output.
const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    categorie: { type: "string", enum: CATEGORIES },
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

let client;
function getClient() {
  if (!client) client = new AnthropicClient();
  return client;
}

/**
 * @param {{from: string, subject: string, body: string}} email
 * @param {string} systemPrompt - contents of prompts/triage.system.md
 */
async function triage(email, systemPrompt) {
  const response = await getClient().messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 300,
    temperature: 0,
    system: systemPrompt,
    output_config: { format: { type: "json_schema", schema: TRIAGE_SCHEMA } },
    messages: [{
      role: "user",
      content: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body}`,
    }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  return { result: JSON.parse(textBlock.text), usage: response.usage };
}

/**
 * @param {{channel: string, from: string, subject: string, body: string, vereniging: string|null, waarschuwing: string|null}} email
 * @param {string} systemPromptText - contents of prompts/draft.system.md
 * @param {string} contextBlock - trajectory data + knowledge base, concatenated
 */
async function draft(email, systemPromptText, contextBlock) {
  const response = await getClient().messages.create({
    model: DRAFT_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: [
      { type: "text", text: systemPromptText },
      {
        type: "text",
        text: contextBlock,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{
      role: "user",
      content:
        `Kanaal: ${email.channel}\n` +
        `Van: ${email.from}\n` +
        `Onderwerp: ${email.subject}\n` +
        `Herkende vereniging: ${email.vereniging || "onbekend"}\n` +
        `Waarschuwing voor reviewer: ${email.waarschuwing || "geen"}\n\n` +
        email.body,
    }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  return { text: textBlock ? textBlock.text : "", usage: response.usage };
}

module.exports = { triage, draft, TRIAGE_SCHEMA, CATEGORIES, TRIAGE_MODEL, DRAFT_MODEL };
