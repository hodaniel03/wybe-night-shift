# Wybe Night Shift – Ghosts

Agent for finalen søndag **8. november 2026 kl. 12:00–13:00, Europe/Oslo**.
Node 18+; ingen eksterne pakker. Lagets eksisterende nøkkel ligger i `.env` og skal holdes hemmelig.

## Søndag: start her

Kjør rundt **11:55**, med Mac-en på strøm og lokket åpent:

```bash
cd ~/vscode/wybe-night-shift
npm test
node run.js --check
./start-final.command
```

Launcheren holder Mac-en våken, venter til søndag kl. 12:00 i Oslo og starter **alle ti finaleskiftene**.
Agentene kjører parallelt, og hver agent sender handlinger fortløpende. Behold terminalen åpen.
`npm run final` gir samme finalekjøring, men launcheren sørger også for å holde maskinen våken.
Ingen finaleskift startes av `--check` eller `npm test`.

Status vises hvert 30. sekund. Skift-ID-er og fremdrift lagres i `logs/`.
Resultattabellen viser poeng, feil, sklitak, største handlingsgap og snitt uten dårligste skift.
Manglende finaleskift regnes som null.

## Ved avbrudd

Fortsett **de samme skiftene**:

```bash
caffeinate -dimsu node run.js --resume logs/final-shifts.json
```

`--resume` starter aldri nye skift. Hvis færre enn ti ble startet, kjør launcheren igjen;
den sammenholder den lagrede listen med serverens finaleskift og starter bare det som mangler.
Prosesslåser hindrer at samme lokale skift kjøres av to prosesser. Bruk denne prosjektmappen for finalen.

Hvis serveren kan ha mottatt `start_shift`, men både startsvar og gjenfinning av ID mislykkes,
beholder agenten startforsøket i journalen og varsler. Den gjentar ikke en usikker skiftstart automatisk.
Et mistet innbokssvar kan ikke gjenopprettes lokalt dersom serveren allerede har markert meldingene som lest.
Slike hendelser blir logget som advarsler.

## Øving

Øving stenger søndag 11:45. Øvingsresultater teller ikke i finalen.

```bash
node run.js --seed 2
node run.js --seed 601 --parallel 10 --quiet
```

Den siste kommandoen spiller ti forskjellige øvingsnetter, med maksimalt fire aktive samtidig.
`--count N` kjører øvingsskift sekvensielt. Finalen tillater bare ti parallelle skift.

## Hva som er sikret

- Finalestart har fast Oslo-tid, ti parallelle skift, varig skiftliste og gjenfinning av mistede startsvar.
- Nettfeil har korte tidsgrenser. Leveranser og skiftstarter gjentas ikke blindt ved ukjent utfall.
- Handlinger lagres før sending og svar lagres straks. Gjenopptakelse tar hensyn til delvis leverte varer.
- Nye oppdrag og avlysninger behandles underveis. Bare nattlederen kan endre eller avlyse et oppdrag.
- Tapte ting knyttes til riktig forespørsel; brett og bagasje knyttes til riktig rom.
- Allerede synlige gjenstander huskes, og gjenbrukbare varer som settes fra seg kan hentes igjen.
- Lange søk slipper fram hasteoppdrag. Agenten dokker ikke over oppdrag den nettopp har lest.
- Kart, rom og lager læres per natt. Våte gulv sjekkes jevnlig, og nye sølmeldinger utløser ny kontroll.
- Rapportering krever bekreftet utførelse; mislykkede rapporter beholdes for nytt forsøk uten ny levering.

Kjør `npm test` for regresjonstestene. Se [NOTES.md](NOTES.md) for tidligere observasjoner.
Øvingsmålinger er dokumentert i `validation/RESULTS.md`.

## Filer

| Fil | Rolle |
| --- | --- |
| `src/agent.js` | API, tilstand, tolkning, rutevalg og oppdrag |
| `run.js` | Oppstart, preflight, parallelle skift, journal, låser og resultat |
| `start-final.command` | Finalestart med dvalesperre |
| `test/` | Regresjoner og lokal simulering av ti parallelle finaleskift |
| `logs/` | Hemmeligholdte skift-ID-er, lagret tilstand og kjørelogger |

## Hvorfor antall skift kan øke uten flere poeng

Øvingslisten viser **beste enkeltskift**, ikke totalpoeng. Ti nye skift på 2000 poeng endrer ikke en eksisterende rekord på 2338. Agenten lærer kart og lager innenfor hver natt, men strategien forbedres først når koden eller policyen endres og forbedringen blir målt. Se `validation/RESULTS.md` for faktiske resultater.
