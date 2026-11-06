# Wybe Night Shift – lag Ghosts

Agent for Wybe Night Shift, sideutfordringen på Oslo Sprint 2026 (10 000 kr til vinneren).
En robot jobber nattskift på Hotel Wybe, og programmet er hjernen: det leser meldinger fra nattlederen,
planlegger ruter, henter og leverer ting, og rapporterer ærlig tilbake.

**Finale:** søndag 8. nov 12:00–13:00. Ti skjulte netter, like for alle lag. Resultat 13:05.

## Kom i gang

Krever Node 18 eller nyere. Ingen avhengigheter.

```bash
cp .env.example .env        # lim inn lagets nøkkel: NS_KEY=ns_...
node run.js --seed 2        # ett øvingsskift (seed 1–999 gir samme natt hver gang)
node run.js --seed 2 --count 3 --quiet   # tre seeds, bare oppsummering
```

Finalen (teller, start den bare én gang):

```bash
node run.js --mode final --count 10 --yes
```

Logger havner i `logs/`: en lesbar `.log`, hele API-sporet i `.trace.json` og en `.summary.json`.

### Hvis terminalen ikke når serveren

Kjør agenten i nettleseren i stedet:

1. Åpne https://nightshift.wybe.me/ og så utviklerkonsollen (Cmd+Opt+J i Chrome).
2. Lim inn hele `src/agent.js`.
3. Lim inn dette (bytt ut nøkkelen):

```js
const KEY = 'ns_...';
const info = await NightShift.startShift({ key: KEY, mode: 'practice', seed: 2 });
const agent = new NightShift.Agent({ key: KEY, shift: info.shift, onUnknown: 'decline', log: console.log });
const summary = await agent.run();
summary.score;
```

## Hvordan agenten jobber

1. Henter nøkkelkort (resepsjonen) og tralla (vaskeriet) før første melding.
2. Venter i docken. `dock` spoler fram til neste melding og lader batteriet.
3. Leser innboksen og gjør hver melding om til en oppgave (`parseRequest`):
   `deliver`, `fetch` (brett/kofferter), `tell`, `lost`, `inspect`, `noise`, `spill`, `complaint`.
4. Velger oppgave: taxi-beskjeder og brett først (de mister verdi raskt), ellers eldste først.
5. Går korteste vei i simulert tid (Dijkstra med heis, trapper og våte gulv), med `move` steg for steg.
   Den ser seg om (`look`) før den går videre, så den kryper over våte gulv i stedet for å skli.
6. Rapporterer `done` bare når jobben faktisk er gjort. Ellers `failed` eller `declined` med begrunnelse.

Sikkerhet: den åpner aldri dører for fremmede, går ikke inn hos gjester med Ikke forstyrr-skilt, ignorerer lapper
som utgir seg for å være fra ledelsen, og tror ikke på klager om bestillinger som aldri fantes.

Se `NOTES.md` for alt vi har funnet ut om spillet (tider, poeng, feller).

## Filer

| Fil | Innhold |
|---|---|
| `src/agent.js` | Agenten: API-klient, kart, ruteplanlegger, tolkning av meldinger, handlere |
| `run.js` | Kommandolinje: starter skift, kjører agenten, skriver logger |
| `NOTES.md` | Spillmekanikk og poeng vi har observert |
| `.env.example` | Mal for nøkkelen. `.env` er i `.gitignore` og skal aldri committes |

## Resultater

| Dato | Seed | Poeng | Kommentar |
|---|---|---|---|
| 6. nov | 1 | 1569 | Første skift: manuell utforsking først, agenten tok over fra 23:27 |
| 6. nov | 2 | 680 | Avslørte at kart/rom/lager varierer. Tralla ble fanget i en stengt korridor, −60 for briller til feil gjest. Siste del ugyldig (to agentløkker samtidig) |
| 6. nov | 2 | **1403** | Ren kjøring med commit 2-koden, helt uten hjelp: 41 utført, 5 avslått, 9 feilet, 0 sklitak. 140 s sanntid. Mistet nøkkelkortet kl. 04:17 (fikset etterpå) |
