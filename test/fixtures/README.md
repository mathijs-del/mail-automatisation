# Fixtures

Eén bestand per mail, `.txt`, willekeurige bestandsnaam (bv. `01.txt`,
`02-financieel.txt`). `run-fixtures.js` leest alles in deze map.

Anonimiseer namen, telefoonnummers en e-mailadressen. Verenigingsnamen
mogen blijven staan — die zijn juist het signaal.

## Formaat

```
From: <voornaam of "Deelnemer A">
Subject: <onderwerp>

<de binnengekomen mail>

=== JOUW ANTWOORD ===
<het antwoord dat je daadwerkelijk hebt verstuurd>
```

## Voorbeeld

```
From: Deelnemer A
Subject: Vraag over de eerste clinic

Hoi! Ik ben ingeschreven bij Okeanos. Weten jullie al precies wanneer de
eerste clinic is? Ik zag iets over oktober maar wil het inplannen.

Groetjes

=== JOUW ANTWOORD ===
Hoi! Leuk dat je alvast plant. De eerste clinic voor Okeanos staat in het
weekend van 10-11 oktober, de precieze dag wordt nog per mail bevestigd
zodra de sportschool het definitief maakt. Zodra dat bekend is, hoor je het
meteen.

Groet, Mathijs
```

Streef naar 20, verspreid over categorieën: praktische vragen, inschrijving,
financieel, afmelding, matchmaking, een verenigingsbestuur, een leverancier,
wat ruis (nieuwsbrief-achtig). `run-fixtures.js` laat per mail zien wat de
AI zou concepteren naast wat je echt verstuurde — dat verschil is waar de
prompts op bijgesteld worden, niet in productie.
