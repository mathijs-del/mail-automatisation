---
eigenaar: Operations Manager
laatst bijgewerkt: 2026-08-04
---

# Kennisbank THENEXT-GEN — index

## Waarom deze structuur

De oude documenten (Handboek Operations, Company Journey, Customer Journey,
Kennisbank Deelnemers, Asana taken) waren **chronologisch** geordend: week 0,
fase 1, fase 2. Dat werkt om één keer door te lezen.

Vragen komen echter **thematisch** binnen: "wat kost het", "wanneer is mijn
tweede clinic", "wie mail ik over de ring". Daarom is alles hier per onderwerp
geordend, en per doelgroep gescheiden.

## Het belangrijkste principe: één eigenaar per feit

Elk feit staat in **precies één bestand**. Andere bestanden verwijzen ernaar,
maar herhalen het niet.

In de oude opzet stond bijvoorbeeld de clinic-opbouw in het Handboek (§2.5.4 en
§4.1), in de Company Journey en in de Kennisbank Deelnemers. Ze spraken elkaar
al tegen: het Handboek zegt dat er bij clinic 1 gespard wordt in rondes van
1 minuut, de Kennisbank Deelnemers zegt 1,5 minuut. Zolang beide bestaan kiest
een AI er willekeurig één, en weet een nieuwe medewerker niet welke klopt.

Herhaal dus nooit een feit dat elders staat. Verwijs.

## Wie leest wat

| Map | Doelgroep | Gebruikt door |
|---|---|---|
| `A-deelnemers/` | deelnemers | **mailbot** + medewerkersproject |
| `B-intern/` | medewerkers | medewerkersproject |
| `C-communicatie/` | medewerkers | **mailbot** (alleen C1) + project |
| `D-data/` | beide | beide |

De mailbot krijgt alleen `A-*`, `C1`, `D1` en `D2` mee, plus de live
trajectdata uit Sheets. Interne procedures horen niet in een concept aan een
deelnemer.

## Inhoud

**A — Deelnemersinformatie**
- `A1-traject-en-fases.md` — opbouw van het traject, alle fases
- `A2-clinics-en-matchmaking.md` — de drie clinics, ambitie tot de ring, matchmaking
- `A3-materialen-en-kosten.md` — pakketten, prijzen, bestellen, betalen
- `A4-trainingen-en-gezondheid.md` — trainingen, aanwezigheid, blessures, voeding
- `A5-gala-en-ring.md` — teamkleding, VA-nummer, ringspeaker, de gala-avond
- `A6-veelgestelde-vragen.md` — losse FAQ die nergens anders past

**B — Interne procedures**
- `B1-rollen-en-escalatie.md` — wie doet wat, wie beslist wat
- `B2-draaiboek-per-fase.md` — chronologisch werkoverzicht (de oude Company Journey)
- `B3-contacten-en-leveranciers.md` — alle externe partijen op één plek
- `B4-systemen-en-tools.md` — ActiveCampaign, Teamy, Tikkie, website, Asana

**C — Communicatie**
- `C1-tone-of-voice.md` — hoe wij schrijven, met echte voorbeelden
- `C2-templates-appjes.md` — kant-en-klare WhatsApp-teksten
- `C3-communicatieflows.md` — welke mail wanneer (de oude Customer Journey)

**D — Feiten en definities**
- `D1-normen-en-kengetallen.md` — alle getallen op één plek
- `D2-begrippenlijst.md` — VA-nummer, WMTA, Teamy, staredown, tok
- `D3-trajectdata-uitleg.md` — hoe de live datumsheet werkt

**Los**
- `01-ONTBREEKT.md` — wat er nog niet gedocumenteerd is. Lees dit.
- `PROJECT-INSTRUCTIES.md` — tekst voor het Claude Project

## Onderhoudsregels

1. Datums staan **nooit** in deze bestanden. Die staan in de live sheet
   `AI_TRAJECTDATA`. Zie `D3`.
2. Elk bestand heeft bovenaan een eigenaar en een datum. Werk die bij.
3. Verandert een feit? Wijzig het in het eigenaarsbestand, nergens anders.
4. Nieuw feit? Bepaal eerst welk bestand eigenaar is. Twijfel je, dan hoort
   het waarschijnlijk in `D1`.
