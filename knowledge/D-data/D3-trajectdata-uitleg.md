---
eigenaar: Operations Manager
laatst bijgewerkt: 2026-08-04
---

# Trajectdata — hoe het werkt

## Waarom datums niet in de kennisbank staan

Datums verschillen per vereniging en schuiven tijdens het seizoen. Zodra een
datum in een kennisbankbestand staat, veroudert hij en gaat er vroeg of laat
een verkeerde clinicdatum naar een deelnemer.

Daarom: **alle datums staan in het tabblad `AI_TRAJECTDATA`.** Nergens anders.
Ook niet in mailtemplates, ook niet als voorbeeld.

## Verhouding tot het oude planbestand

Het bestaande planoverzicht blijft bestaan als menselijk planbord. Het is
alleen niet geschikt als AI-bron, omdat:

- datums er zonder jaartal staan ("22 januari", "midden mei")
- er dubbele datums in staan ("10/11 oktober", "31 okt/1 nov")
- er twee gala-kolommen zijn die uiteen kunnen lopen
- status wordt aangegeven met celkleur, en de Sheets API geeft geen kleuren
  terug — groen en wit zijn voor een AI identiek

`AI_TRAJECTDATA` is de opgeschoonde versie: alleen actieve trajecten, alleen
ISO-datums, status als tekstkolom.

## Regels voor invullen

1. Datums altijd als `YYYY-MM-DD`. Nooit een maandnaam, nooit een reeks.
2. Weet je een datum nog niet? Laat de cel **leeg**. Leeg is veilig, een
   schatting niet — die wordt namelijk als feit uitgestuurd.
3. Status is een tekstkolom: `werving`, `actief` of `afgerond`. Niet een kleur.
4. Eén gala-kolom. Verwijder de duplicaat.
5. Nieuw traject getekend? Vul de rij in zodra de acht ankerdata bekend zijn.

## Dezelfde data voedt de Asana-planning

De acht ankerdata in dit tabblad (start promotie, informatiebijeenkomst,
deadline inschrijvingen, start trainingen, clinic 1–3, gala) zijn exact de
data die de Asana-trajectplanning nodig heeft. Eén tabblad voedt beide.
