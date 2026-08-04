# Project Brief — THENEXT-GEN Gmail AI Draft Assistant

You are building an AI assistant that reads incoming Gmail, classifies it, and
writes reply drafts into the Gmail thread. A human always reviews and sends.
Nothing is ever sent automatically.

Read this entire document before writing any code. Start with Phase 0.

---

## 1. Business context

THENEXT-GEN runs multi-month (kick)boxing training programmes ("trajecten")
for Dutch student associations and hospitality workers, each ending in a fight
night gala. Roughly 10 cities, ~15 active or planned trajectories per season.

A trajectory has eight anchor dates: start of promotion, information session,
registration deadline, start of training, three central clinics, and the gala.
These dates differ per association and shift during the season.

The mailbox is Google Workspace. Volume is 25–75 inbound mails per day. The
dominant time sink is **practical participant questions**: dates, locations,
times, what to bring, how the programme works.

Languages: mostly Dutch, some English. Replies must match the sender's language.

---

## 2. What you are building

```
Gmail (new message)
  → classify (Claude Haiku)          — category, urgency, association
  → apply Gmail labels
  → if category allows a draft:
      load trajectory data + knowledge base
      → write reply (Claude Sonnet)
      → create Gmail draft inside the original thread
      → apply label
  → append a row to the log sheet
```

**Runtime:** n8n (self-hosted via Docker Compose, or n8n Cloud).
**Brain:** Claude API, direct HTTP calls.
**Data:** Google Sheets (structured trajectory data + log) and Google Drive
(knowledge base documents).

### Critical architectural requirement

WhatsApp will be added later through Trengo. Therefore the draft-generation
logic must be a **standalone, channel-agnostic n8n sub-workflow** that takes a
generic input and returns a generic output:

```
input:  { channel, sender, subject, body, language_hint }
output: { category, urgency, association, draft_text, warnings[], sources[] }
```

The Gmail workflow is only a thin adapter around it. Do not entangle Gmail
specifics with the AI logic.

---

## 3. What Mathijs must prepare (list this back to him in Phase 0)

### A. Google Sheet — new tab `AI_TRAJECTDATA`

There is an existing master planning sheet. **Do not read it directly.** It uses
free-text dates without years ("22 januari", "midden mei"), ambiguous ranges
("10/11 oktober", "31 okt/1 nov"), duplicate gala columns, and encodes status in
cell background colour — which the Sheets API does not return as data.

Instead, a new tab holds only active trajectories in strict format. One row per
trajectory:

| Column | Format | Notes |
|---|---|---|
| `vereniging` | text | exactly as participants say it |
| `stad` | text | |
| `sport` | `boksen` / `kickboksen` | |
| `status` | `werving` / `actief` / `afgerond` | replaces the colour coding |
| `start_promotie` | `YYYY-MM-DD` | |
| `informatiebijeenkomst` | `YYYY-MM-DD` | |
| `tijd_informatiebijeenkomst` | `HH:MM` | |
| `locatie_informatiebijeenkomst` | text | |
| `deadline_inschrijvingen` | `YYYY-MM-DD` | |
| `start_trainingen` | `YYYY-MM-DD` | |
| `clinic_1` / `clinic_2` / `clinic_3` | `YYYY-MM-DD` | one date only |
| `locatie_clinics` | text | |
| `gala_datum` | `YYYY-MM-DD` | single source, no duplicate column |
| `gala_locatie` | text | |
| `gym` | text | |
| `trainingsdagen` | text | e.g. `ma + do 19:00-20:30` |
| `trainingslocatie` | text | |
| `trajectmanager` | text | |
| `deelnamekosten` | text | |
| `bijzonderheden` | text | free text, deviations from the norm |

Every date cell must be a real ISO date or empty. Never a range, never a
month name, never a guess. **Empty is correct and safe; approximate is not.**

Ask Mathijs for the Sheet ID and the exact tab name.

### B. Google Drive folder — knowledge base

One folder (ask for the folder ID) containing six Google Docs:

| File | Contents |
|---|---|
| `01-praktische-faq` | what to bring, clothing, required fitness level, how a training looks, gear, showers, absence |
| `02-trajectopbouw` | how the programme is structured over the months, in plain language |
| `03-inschrijving-betaling` | registration process, Gravity Forms/Mollie, invoicing |
| `04-annulering-refund` | cancellation and refund policy |
| `05-gala-praktisch` | tickets, guests, dress code, timings, what happens on the night |
| `06-tone-of-voice` | **8–10 real replies Mathijs has actually sent**, verbatim |

`06` matters more than any prompt engineering. Tell him this explicitly. If it
is thin, output quality will be mediocre regardless of what you build.

### C. Gmail labels (created manually or by you via the Gmail API)

```
AI/1-Nu            AI/2-Deze-week      AI/3-FYI
AI/Concept-klaar   AI/Handmatig
AI/Deelnemer       AI/Vereniging       AI/Partner       AI/Financieel
```

### D. Test fixtures

Ask him to export **20 real inbound emails plus the replies he actually sent**,
covering a spread of categories. Anonymise sender names. These become the
regression test set. Do not proceed past Phase 2 without them.

### E. Credentials

- Anthropic API key (`platform.claude.com`)
- Google Cloud OAuth client with Gmail, Sheets and Drive scopes
- n8n instance URL

Store nothing in the repo. Use `.env`, and commit `.env.example` only.

---

## 4. The two prompts

Put these in `prompts/` as separate files so they can be edited without
touching workflow code.

### 4.1 `prompts/triage.system.md` — Claude Haiku

```
You are the mail triage layer for THENEXT-GEN, a Dutch organisation that runs
multi-month (kick)boxing programmes for student associations and hospitality
workers, each ending in a fight night gala.

Classify the message. Respond with JSON only. No prose, no markdown fences.

{
  "categorie": "...",
  "urgentie": "nu" | "deze_week" | "fyi",
  "vereniging": "<name or null>",
  "taal": "nl" | "en",
  "samenvatting": "<max 15 words, Dutch>",
  "concept_toegestaan": true | false,
  "waarschuwing": "<string or null>"
}

CATEGORIES
DEELNEMER_PRAKTISCH   dates, locations, times, what to bring, level required,
                      how the programme works, training schedule
DEELNEMER_INSCHRIJF   signing up, availability, payment link problems
DEELNEMER_FINANCIEEL  invoices, refunds, payment plans, discounts
DEELNEMER_AFMELDING   quitting, cancelling
DEELNEMER_MEDISCH     injury, illness, medical clearance, medication, pregnancy
DEELNEMER_MATCHMAKING opponents, weight classes, whether they will fight
VERENIGING_BESTUUR    contact from an association board or committee
PARTNER_SPONSOR       sponsors, breweries, partnerships
HORECA_OUTREACH       replies to our hospitality outreach campaign
LEVERANCIER_LOCATIE   venues, catering, equipment, ring announcer, photographer
INTERN                colleagues, admin, bookkeeper
RUIS                  newsletters, spam, automated confirmations

concept_toegestaan = false for DEELNEMER_MEDISCH and RUIS. True otherwise.

Set "waarschuwing" to a short Dutch note when the message involves money,
a complaint or dissatisfaction, a request for an exception or promise, or
anything safety-related. Otherwise null. A draft is still produced; the
warning is shown to the human reviewer.

"vereniging" must be a name literally present in the message, or null.
Never infer it from the sender's domain or your own assumptions.
```

**User message:** `From: {from}\nSubject: {subject}\n\n{body}`

### 4.2 `prompts/draft.system.md` — Claude Sonnet

Send this as **two system blocks**. Block 1 is the instruction text below.
Block 2 is the trajectory data plus knowledge base, with
`"cache_control": {"type": "ephemeral"}` set on it.

```
You write reply drafts on behalf of Mathijs at THENEXT-GEN. Every draft you
write is read by a human before it is sent. Write it as if it will be sent,
but never invent anything.

RULES
1. Use only information from the TRAJECTORY DATA and KNOWLEDGE BASE below.
   If something is not there, it does not exist.
2. Never state a date, time, price or location that is not literally present
   in the trajectory data. Never calculate or infer a date. Copy dates
   verbatim. Convert ISO dates to natural Dutch or English phrasing
   ("2026-10-25" becomes "zondag 25 oktober"), but do not shift them.
3. If you cannot fully answer, write the part you can and append on its own
   line: [ONTBREEKT: <what you could not answer and why>]
4. If you make an assumption, for example about which association the sender
   belongs to, append: [AANNAME: <the assumption>]
5. Make no commitments: no exceptions, discounts, reserved places, guarantees
   or deadline extensions. If the sender asks for one, acknowledge the request
   and say Mathijs will come back to them personally.
6. Reply in the sender's language.

TONE
Personal and direct, like a human helping someone out. No marketing language,
no newsletter feel. Informal "je" in Dutch. Usually 4–8 sentences. Do not open
with "Bedankt voor je bericht". Sign off "Groet, Mathijs". Follow the examples
in the tone of voice document closely — they are the standard.

OUTPUT FORMAT
Return the email body only. Then a blank line, then three hyphens, then:
Bron: <which rows and documents you used>
Any [ONTBREEKT] or [AANNAME] markers go above the hyphens.
The human deletes everything from the hyphens down before sending.
```

**User message:**
```
Kanaal: {channel}
Van: {from}
Onderwerp: {subject}
Herkende vereniging: {vereniging or "onbekend"}
Waarschuwing voor reviewer: {waarschuwing or "geen"}

{body}
```

### 4.3 Warning banner

When `waarschuwing` is not null, the draft written into Gmail must start with:

```
⚠ {waarschuwing} — extra checken voordat je verstuurt
```

on its own line, above the reply. This is a reviewer cue, not a block.

---

## 5. Claude API details

Endpoint `POST https://api.anthropic.com/v1/messages`
Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`

- Triage: `claude-haiku-4-5-20251001`, `max_tokens: 300`, temperature 0
- Drafting: `claude-sonnet-5`, `max_tokens: 1000`, temperature 0.3

Verify current model IDs, pricing and the exact prompt-caching syntax against
`https://platform.claude.com/docs` before finalising — do not rely on memory.

Prompt caching is essential here: the trajectory data and knowledge base are
identical on every call, and cache hits cost a fraction of normal input.

Target: roughly €0.30–0.50 per day at 50 mails. If your cost estimate lands
materially above that, something is wrong with how context is being sent —
investigate before shipping.

---

## 6. Deliverables

```
/prompts/            triage.system.md, draft.system.md
/workflows/          n8n workflow JSON, importable
                     - ai-draft-core.json      (channel-agnostic sub-workflow)
                     - gmail-adapter.json      (Gmail trigger, labels, drafts)
/test/
  fixtures/          the 20 anonymised real emails
  run-fixtures.js    runs the full pipeline offline, no Gmail, no n8n
  report.md          generated: per fixture the draft, warnings, token cost
/scripts/
  setup-labels.js    creates the Gmail labels via API
  validate-sheet.js  checks AI_TRAJECTDATA for malformed dates, warns on gaps
README.md            setup from zero, in Dutch
.env.example
```

**`test/run-fixtures.js` is the most important file.** It must let Mathijs
change a prompt and immediately see how all 20 emails would be answered,
without touching n8n or Gmail. Prompt iteration happens here, not in
production.

`scripts/validate-sheet.js` should be runnable any time and flag: non-ISO
dates, gala dates in the past on rows marked `actief`, clinics that fall
outside the training period, and missing locations. Wrong data is the most
likely cause of a wrong draft, so make it easy to catch.

---

## 7. Build order

**Phase 0 — before writing code.** Read this brief, then ask Mathijs the open
questions (see below). Confirm the plan in a short summary. Do not skip this.

**Phase 1 — data layer.** Sheet reader, Drive knowledge base loader,
`validate-sheet.js`. Verify against his real sheet that the parsed output is
exactly right.

**Phase 2 — AI layer offline.** The two prompts plus `run-fixtures.js`, running
against the 20 fixtures. Iterate on the prompts until output quality is good.
No n8n, no Gmail, no side effects.

**Phase 3 — n8n triage only.** Classify and label real mail. No drafts. Let it
run for a few days so the category distribution can be checked against reality.

**Phase 4 — drafts on.** Enable Gmail draft creation. Start with
DEELNEMER_PRAKTISCH only, then widen based on the log.

Do not build phases 3 and 4 before phase 2 produces good output on fixtures.

---

## 8. Hard constraints

- **Never send email.** Only `gmail.drafts.create`, with `threadId` set so the
  draft appears inside the original thread. If you find yourself reaching for
  a send endpoint, stop and ask.
- No auto-archiving, no deleting, no auto-replies, no out-of-office behaviour.
- Never write to the master planning sheet. Read `AI_TRAJECTDATA` only, and
  append-only to the log sheet.
- No secrets in the repo or in workflow JSON. Use n8n credentials and `.env`.
- No vector database, no embeddings, no RAG framework. The full knowledge base
  fits in context and is cached. Keep it that way.
- Log every run to the log sheet:
  `datum | afzender | categorie | urgentie | concept_gemaakt | waarschuwing | resultaat`
  `resultaat` is filled in by hand: O (sent unchanged), L (lightly edited),
  H (rewritten), W (discarded).

---

## 9. Questions to ask Mathijs in Phase 0

1. n8n self-hosted or Cloud? If self-hosted, is it already running, and where?
2. Google Sheet ID and exact tab name for `AI_TRAJECTDATA`, plus the Drive
   folder ID for the knowledge base.
3. Which mailbox(es) — only `mathijs@thenext-gen.com`, or shared ones such as
   `info@`?
4. Are Eline, Tijn and Koen also in these mailboxes? Drafts written by AI in a
   shared mailbox need a clear visual marker so nobody sends one blind.
5. Have the 20 fixture emails been exported yet? Nothing past Phase 2 works
   without them.
6. Is `06-tone-of-voice` written, and does it contain real sent replies rather
   than idealised examples?

Ask these before writing code. Ask more if something in this brief is
ambiguous — an assumption baked into the workflow is expensive to remove later.
