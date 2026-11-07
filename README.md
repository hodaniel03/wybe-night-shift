# Wybe Night Shift – lag Ghosts

Agent for Wybe Night Shift, sideutfordringen på Oslo Sprint 2026 (10 000 kr til vinneren).
En robot jobber nattskift på Hotel Wybe, og programmet er hjernen: det leser meldinger fra nattlederen,
planlegger ruter, henter og leverer ting, og rapporterer ærlig tilbake.

**Finale:** søndag 8. nov 12:00–13:00. Ti skjulte netter, like for alle lag. Resultat 13:05.

## FINALEN søndag 8. nov (les dette)

Regler: 10 hemmelige skift, alle kan startes 12:00 og kjøre parallelt. Ett forsøk per skift, ingen omstart.
Maks 45 min per skift, alt stopper 13:00. 20 s per handling, ellers står roboten. Rangering: snitt av de 10
skiftene der det dårligste strykes. Øving stenger 11:45. Øvingstavla teller ikke.

1. Mac på strøm og stabilt nett (ha mobil-hotspot klar). Slå av dvale: `caffeinate -dimsu &`
2. Rundt 11:55, i mappa `~/vscode/wybe-night-shift`:

```bash
node run.js --mode final --parallel 10 --wait-until 12:00 --yes
```

   Den venter til 12:00, starter alle 10 skiftene, lagrer skiftlista i `logs/` og kjører dem samtidig.
   En hel natt tar et par minutter. Til slutt skrives en tabell med poeng og snitt uten dårligste.
3. **Hvis noe krasjer** (nett, strøm, Ctrl+C): kjør med en gang

```bash
node run.js --resume logs/<tidspunkt>-final-shifts.json
```

   Agentene fortsetter de samme skiftene fra lagret tilstand. Skift som allerede er ferdige avsluttes med en gang.
4. Har ikke alle 10 startet (feilmelding «Kunne ikke starte skift»): kjør samme finale-kommando igjen
   uten `--wait-until`. Den starter de som mangler. Kjør så `--resume` på den nye lista.

## Kom i gang (øving)

Krever Node 18 eller nyere. Ingen avhengigheter.

```bash
cp .env.example .env                      # lim inn lagets nøkkel: NS_KEY=ns_...
node run.js --seed 2                      # ett øvingsskift (seed 1–999 gir samme natt hver gang)
node run.js --seed 101 --parallel 10      # mini-finale: 10 netter (øving tillater 4 samtidig, resten venter)
```

Logger havner i `logs/`: en lesbar `.log`, hele API-sporet i `.trace.json`, en `.summary.json` og
`<skift>.state.json` (brukes av `--resume`).

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
4. Velger oppgave: taxi-beskjeder og brett først (de mister verdi raskt). Ellers veies alder mot reisevei, siden hver
   oppgave mister ca. ett poeng i minuttet. Uklare oppdrag («rommet ved heisen») spør den nattlederen om (`reply`, gratis).
5. Går korteste vei i simulert tid (Dijkstra med heis, trapper og våte gulv), med `move` steg for steg.
   Den ser seg om (`look`) før den går videre, så den kryper over våte gulv i stedet for å skli.
6. Rapporterer `done` bare når jobben faktisk er gjort. Ellers `failed` eller `declined` med begrunnelse.
7. Leser innboksen så fort en melding kommer, også midt i en oppgave. Blir oppgaven avlyst («Skip R-035, 302 checked
   out»), stopper den og rapporterer `cancelled` (seed 3: å levere likevel kostet −50).
8. Tåler feil: en feil i én forespørsel stopper aldri natta, nettfeil og 5xx prøves på nytt, og tilstanden lagres
   til disk etter hver rapport.
9. Stengt korridor: oppdraget utsettes og prøves igjen senere (ikke `failed` med en gang). Det som fortsatt står åpent
   kl. 05:50, rapporteres `failed`, så ingenting står ubesvart kl. 06:00.
10. Batteri: lader i docken når det ikke er noe å gjøre, og ellers bare så mye som resten av natta trenger.

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
| 6. nov | 3 | 1496 | Fra terminalen. −50 for lommebok til gjest som hadde sjekket ut (fikset: leser innboksen midt i oppgaver) |
| 6. nov | 2 | **1403** | Ren kjøring med commit 2-koden, helt uten hjelp: 41 utført, 5 avslått, 9 feilet, 0 sklitak. 140 s sanntid. Mistet nøkkelkortet kl. 04:17 (fikset etterpå) |

Lørdag natt, samme tre netter med hver versjon (deterministisk, så tallene kan sammenlignes direkte):

| Versjon | Seed 401 | Seed 2 | Seed 3 | Sum |
|---|---|---|---|---|
| v2 (commit 61ec9b9) | 1881 | 1345 | 1557 | 4783 |
| v3 (spør nattlederen, søl-regel, utsett ved stengt korridor, batteri) | 2000 | 1219 | 1646 | 4865 |
| v4 (tralla blir i 1. etg., ett tralle-sted, korteste vei først, færre `look`) | **2096** | **1422** | **1604** | **5122** |
