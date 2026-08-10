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

```bash
npm run setup-labels -- --dry-run    # laat zien wat er zou gebeuren
npm run setup-labels                 # maakt ze echt aan
```

Maakt de negen `AI/*`-labels aan. Bestaande labels blijven ongemoeid, dus je
kunt het script gerust nog eens draaien.

### 5. n8n

1. In n8n: **Credentials** → een Gmail-credential (OAuth2) voor
   `info@thenext-gen.com`, en een Google Sheets-credential.
2. **Settings → Variables**: `ANTHROPIC_API_KEY`, `SHEET_ID`, `SHEET_TAB`,
   `LOG_SHEET_ID`, `LOG_SHEET_TAB`.
3. Importeer `workflows/ai-draft-core.json`. Noteer het workflow-ID uit de URL
   en zet dat als variabele `CORE_WORKFLOW_ID`.
4. Importeer de twee `gmail-adapter-*.json`.
5. Koppel in elke workflow de Gmail- en Sheets-nodes aan de juiste credential
   (import neemt credentials niet mee).

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
