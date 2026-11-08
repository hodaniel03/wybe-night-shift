# Finaleklar kontroll — 8. november 2026

## Strategivalg

Standardstrategien er fortsatt `efficient`, som tidligere forbedret snittet 9,4 % mot den eldre produksjonsreferansen på åtte like scenarioer. De siste forsøkene ga ikke en tydelig forbedring av kvaliteten på tvers av scenarioer, og erstatter derfor ikke denne før finalen.

| Måling, samme 16 scenarioer | Efficient | Tralle/lager-kandidat |
| --- | ---: | ---: |
| Gjennomsnitt | 2084,125 | 2087,1875 |
| Svakeste skift | 1630 | 1630 |
| Snitt av svakeste fire | 1712,5 | 1711,5 |
| Kjøringsfeil | 0 | 0 |
| Ubekreftede ferdigrapporter | 1 | 1 |

Tralle/lager-kandidaten fikk +2,125 på første åtte og +4 på åtte andre scenarioer. Samlet +3,0625 poeng (omtrent 0,15 %) er en liten observert forskjell, ikke dokumentasjon på vesentlig bedre finalekvalitet. Kartlegging i ledig tid fikk −2 i snitt på åtte scenarioer og svakeste resultat falt fra 1630 til 1622. Den tas heller ikke inn. Totalt 24 nye øvingsskift er fullført, uten kjøringsfeil. Ingen av disse er finaleskift.

## Oppstart i 0.3.2

Finalestarteren kontrollerer nå API-tilgang og skriving av sjekkpunkter **før** den venter til klokken 12. Feil oppdages dermed mens det fortsatt er tid til å rette dem. Denne kontrollen bruker bare `whoami` og `shifts` hos serveren; den starter ingen skift. Etter ventingen brukes eksisterende logikk for ti parallelle finaleskift og lagring av hver start-ID.

Automatisk dvalesperre og pauselogging fra 0.3.1 er beholdt. Mac-en må stå tilkoblet strøm med lokket åpent. Ingen programkode kan utføre spillhandlinger mens maskinen sover.

## Kjøring

Fra `/Users/hodanielkhuu/vscode/wybe-night-shift`:

```sh
./start-final.command
```

Kommandoen kan startes før klokken 12. Den sjekker oppsettet, venter til søndag 8. november klokken 12:00 Europe/Oslo og starter ti finaleskift. Ikke lukk terminalen.

Ved avbrudd etter at skift er startet:

```sh
node run.js --resume logs/final-shifts.json --quiet
```

Dette gjenopptar lagrede skift-ID-er. Dersom listen inneholder færre enn ti registrerte skift, har `--resume` som hensikt bare å fortsette dem; vanlig finalestarter sammenholder den eksisterende listen med serveren og starter de manglende innen finalevinduet.

Finalen stenger 13:00. Øving stenger 11:45. Ingen finaleforsøk er startet av arbeidet i denne kontrollen.

Målegrunnlag: `final-readiness-selection.json`, `sweep-finalist-14`, `sweep-survey-15` og `sweep-final-readiness-holdout-16` i arbeidskopiens validation-mappe.

## Faktisk sluttkontroll klokken 10:35 Oslo

- Installert versjon: 0.3.2. Originalprosjektets 104 tester besto, inkludert ti parallelle simulerte finaleskift, mistet startsvar, gjenopptakelse uten nye starter og tidlig avvisning av ugyldig API-nøkkel.
- `node run.js --check` bekreftet Node, API-nøkkel og atomisk lagring. Ingen skift ble startet.
- Serveren rapporterte 0 registrerte finaleskift og 4 aktive øvingsskift. Øvingsskiftene var startet klokken 10:27–10:35 og kommer ikke fra de avsluttede nattestene i denne chatten. Eierskap må avklares før eventuell automatisk finalestart fra denne chatten; bare én prosess skal styre hvert finaleskift.
- Mac-en rapporterte AC Power og lading ved kontrollen.
- `git diff --check` besto. Ingen commit eller push er utført.
