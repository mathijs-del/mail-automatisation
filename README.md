# THENEXT-GEN — Gmail AI conceptassistent

Leest binnenkomende mail in `info@thenext-gen.com`, classificeert die, en zet
een conceptantwoord klaar in dezelfde Gmail-thread. **Er wordt nooit iets
automatisch verstuurd.** Een mens leest en verstuurt altijd zelf.

---

## Hoe het werkt

```
Nieuwe mail
  → triage (Claude Haiku), direct           — categorie, urgentie, vereniging
  → Gmail-labels erop
  → logregel erbij
                                                  ↓
                                    elke 2 uur, gebundeld
                                                  ↓
  → trajectdata (live uit Sheets) + kennisbank
  → concept schrijven (Claude Sonnet)
  → concept in de originele thread
  → label AI/Concept-klaar
```

Triage draait **direct per mail**, zodat urgente post meteen zichtbaar is in
de inbox. Concepten worden **elke 2 uur gebundeld**, omdat dat het duurste
deel is: per batch wordt de kennisbank één keer in Claude's cache gezet in
plaats van per mail.

### Drie workflows

| Bestand | Wat het is |
|---|---|
| `workflows/ai-draft-core.json` | De "brein"-subworkflow. Kanaalonafhankelijk: krijgt `{channel, sender, subject, body, language_hint, triage}` en geeft `{category, urgency, association, draft_text, warnings[], sources[]}` terug. Weet niets van Gmail. |
| `workflows/gmail-adapter-triage.json` | Gmail-trigger, triage, labels, logregel. |
| `workflows/gmail-adapter-drafts.json` | Elke 2 uur: openstaande regels ophalen, `ai-draft-core` aanroepen, concept in de thread zetten. |

WhatsApp via Trengo kan later als tweede adapter naast de Gmail-adapters,
zonder dat er iets aan de kern verandert.

---

## Installatie

Nodig: Node 20 of hoger.

```bash
npm install
cp .env.example .env      # daarna .env invullen
```

### 1. Claude API-key

`platform.claude.com` → **API keys** → **Create key**. Zet er een spend limit
op. In `.env` als `ANTHROPIC_API_KEY`.

### 2. Trajectdata

Het tabblad `AI_Trajectdata` bevat één rij per traject, 22 kolommen. Zie
`knowledge/D-data/D3-trajectdata-uitleg.md` voor de invulregels. De
belangrijkste: **elke datumcel is een echte `YYYY-MM-DD` of leeg.** Nooit een
reeks, nooit een maandnaam, nooit een schatting. Leeg is veilig, een gok wordt
als feit doorgestuurd.

Sheet ID en tabnaam in `.env` als `SHEET_ID` en `SHEET_TAB`.

Controleer het tabblad met:

```bash
npm run validate-sheet                       # live uit Sheets
npm run validate-sheet -- --csv export.csv   # of op een CSV-export
```

Dat meldt niet-ISO datums, gala's in het verleden op rijen die `actief` staan,
clinics buiten de trainingsperiode, datums in de verkeerde volgorde, dubbele
verenigingen en ontbrekende locaties.

### 3. Logsheet

Een tabblad (mag hetzelfde spreadsheet zijn) met deze kolomkoppen:

```
datum | afzender | categorie | urgentie | concept_gemaakt | waarschuwing |
resultaat | messageId | threadId | subject | triage_json
```

In `.env` als `LOG_SHEET_ID` en `LOG_SHEET_TAB`.

`resultaat` vul je met de hand in, per concept:

| | |
|---|---|
| `O` | ongewijzigd verstuurd |
| `L` | licht aangepast |
| `H` | herschreven |
| `W` | weggegooid |

Dit is de kwaliteitsmeting én de leerlus — zie *Beter worden* onderaan.

### 4. Gmail-labels

Maak deze negen labels aan in Gmail (**Instellingen → Labels → Nieuw label
maken**). Typ de naam inclusief de `/`, dan maakt Gmail er vanzelf een
genest label van:

```
AI/1-Nu          AI/2-Deze-week    AI/3-FYI
AI/Concept-klaar AI/Handmatig
AI/Deelnemer     AI/Vereniging     AI/Partner      AI/Financieel
```

Er is ook een script, maar dat heeft een eigen OAuth-refreshtoken nodig —
met de hand aanmaken is sneller. Wil je het toch scripten:

```bash
npm run setup-labels -- --dry-run    # laat zien wat er zou gebeuren
npm run setup-labels                 # maakt ze echt aan
```

### 5. n8n

Er zijn geen n8n-variabelen nodig (die zitten niet in elk abonnement).
Alles wordt in de interface ingesteld.

**Credentials aanmaken:**

1. **Gmail OAuth2 API** — voor `info@thenext-gen.com`.
2. **Google Sheets OAuth2 API** — mag dezelfde Client ID/secret gebruiken.
3. **Header Auth**, met als naam `Anthropic API key`:
   - Name: `x-api-key`
   - Value: je Claude API-key

De API-key staat dus in een n8n-credential, nooit in de workflow-JSON.

**Importeren:**

1. Importeer `workflows/ai-draft-core.json` eerst.
2. Importeer daarna de twee `gmail-adapter-*.json`.
3. Loop per workflow de nodes langs die nog niet ingesteld zijn:
   - **Google Sheets**-nodes: kies het spreadsheet en het tabblad
     (`AI_Trajectdata` in de core, `AI_LOG` in de adapters).
   - **Gmail**-nodes: kies de Gmail-credential.
   - **HTTP Request**-nodes: kies de `Anthropic API key` credential.
   - **Execute Workflow**-node in `gmail-adapter-drafts`: kies
     `ai-draft-core` uit de lijst.

Import neemt credentials nooit mee — dat koppelen blijft handwerk.

---

## Concepten aanzetten (fase 4)

`gmail-adapter-drafts` begint bewust klein. Bovenin de node **Pending drafts**
staan twee instellingen:

```js
const TOEGESTANE_CATEGORIEEN = ['DEELNEMER_PRAKTISCH'];
const MAX_LEEFTIJD_UREN = 72;
```

- **`TOEGESTANE_CATEGORIEEN`** — alleen deze categorieën krijgen een concept.
  Praktische deelnemersvragen zijn de grootste stapel én het minst riskant, dus
  daar begin je. Zie in `AI_LOG` hoe vaak de `resultaat`-kolom `O` of `L` is;
  staat dat goed, zet er dan één categorie bij. `['*']` zet alles aan waar
  triage `concept_gemaakt = wacht` voor heeft gezet.
- **`MAX_LEEFTIJD_UREN`** — rijen ouder dan drie dagen worden overgeslagen.
  Zonder die grens zou het uitbreiden van de lijst hierboven ineens weken oude,
  allang met de hand beantwoorde mail alsnog van een concept voorzien.

Een rij die buiten de lijst valt blijft op `wacht` staan en kost niets: hij
wordt in een Code-node weggefilterd, vóór er een Claude-aanroep is.

Wat de workflow per ronde doet:

1. `AI_LOG` lezen, de rijen op `wacht` pakken die aan bovenstaande voldoen.
2. De mail zelf **opnieuw bij Gmail ophalen**. Het logsheet bewaart geen
   berichttekst — een volledig mailbody per rij maakt een sheet die elke twee
   uur gelezen wordt onwerkbaar.
3. `ai-draft-core` aanroepen.
4. Het concept in de originele thread zetten (`threadId`), label
   `AI/Concept-klaar` erop, en de rij op `concept_gemaakt = ja` zetten.

**Let op de handtekening.** Een concept dat via de API is aangemaakt krijgt je
Gmail-handtekening er niet automatisch onder — Gmail voegt die alleen toe aan
een concept dat je zelf in de browser begint. Het concept eindigt dus bij de
afsluitzin. Controleer dat bij het eerste concept en plak de handtekening er
handmatig onder voordat je verstuurt.

---

## Prompts aanpassen

De twee prompts staan als losse bestanden in `prompts/`, los van de
workflowcode:

- `prompts/triage.system.md` — classificatie (Haiku)
- `prompts/draft.system.md` — het concept schrijven (Sonnet)

Na elke wijziging in `prompts/` of `knowledge/`:

```bash
npm run build-workflows
```

De kennisbank en beide prompts worden **in de workflow-JSON ingebakken**.
n8n Cloud kan deze repo niet lezen, en een byte-stabiel contextblok is precies
wat Claude's prompt-cache nodig heeft om te werken. Importeer daarna de
gewijzigde workflow opnieuw in n8n.

Trajectdata wordt **niet** ingebakken: die wordt live uit Sheets gelezen bij
elke run. Een wijziging in `AI_Trajectdata` werkt dus meteen, zonder rebuild.

---

## Kwaliteit testen zonder n8n of Gmail

```bash
npm run run-fixtures                        # trajectdata live
npm run run-fixtures -- --csv export.csv    # of uit een CSV
```

Draait de volledige pijplijn over alles in `test/fixtures/` en schrijft
`test/report.md`: per mail het AI-concept naast het antwoord dat echt is
verstuurd, plus de kosten. **Hier hoor je aan prompts te sleutelen, niet in
productie.** Pas een prompt aan, draai opnieuw, vergelijk.

Dit is de enige opdracht die echt geld kost. Reken op ongeveer €0,02 per mail.

Nieuwe fixtures toevoegen: zie `test/fixtures/README.md`.

```bash
npm test    # controleert de JavaScript in de workflow-nodes
```

---

## Beter worden

De kennisbank is wat de kwaliteit bepaalt, niet de prompt.
`knowledge/C-communicatie/C1-tone-of-voice.md` is daarbinnen het
belangrijkste bestand: de voorbeelden daarin zijn de norm.

De leerlus loopt via de `resultaat`-kolom in het logsheet. Concepten die je
op `L` of `H` zet zijn de interessante: daar week het concept af van wat je
zelf zou sturen. Herhaalt zo'n afwijking zich, dan hoort het patroon als
voorbeeld in `C1` — precies zoals de acht echte threads in
`knowledge/E-fixtures/` daar terecht zijn gekomen.

Bewust géén fine-tuning en géén vectordatabase. Bij dit volume verdient geen
van beide zichzelf terug, en een handmatig samengesteld voorbeeldbestand dat
het model elke run vers meeleest is eenvoudiger, controleerbaar en aantoonbaar
effectief.

---

## Harde grenzen

- **Nooit mail versturen.** Alleen `gmail.drafts.create`, altijd met
  `threadId`, zodat het concept in de originele thread verschijnt.
- Niet archiveren, niet verwijderen, geen automatische antwoorden.
- Nooit naar het oude planbestand schrijven. `AI_TRAJECTDATA` wordt alleen
  gelezen; het logsheet alleen aangevuld.
- Geen secrets in de repo of in workflow-JSON. Alles via n8n-credentials en
  `.env`.
- Bij `DEELNEMER_MEDISCH` en `RUIS` wordt géén concept gemaakt; die krijgen
  `AI/Handmatig`.
- De mailbot krijgt alleen `A-*`, `C1`, `D1` en `D2` uit de kennisbank mee.
  Interne procedures (`B-*`) horen niet in een concept aan een deelnemer.
