# Validering 7. november 2026

Alle kjøringer her bruker **practice**. Ingen finaleforsøk er brukt.

## Hva topplisten viser

Serverfeltet heter `best_practice_score`: beste enkeltskift, ikke summen av skiftene.
Ved kontroll rundt kl. 12:20 Oslo hadde Ghosts 2338 poeng etter 95 skift, mens førsteplassen hadde 3448.
Flere skift øker ikke rekorden når alle de nye resultatene er lavere enn 2338.
Agenten oppdaterer kart og inventar under skiftet; den trener ikke automatisk en ny strategi mellom skift.

## Kontrollerte sammenligninger

| Versjon | Seed 2 | Seed 3 | Seed 401 | Seed 123 | Sum |
|---|---:|---:|---:|---:|---:|
| Opprinnelig v4-referanse | 1463 | 1615 | 2034 | 1208 | 6320 |
| Første kandidat, forkastet | 1324 | 1636 | 1911 | 1135 | 6006 |
| Rettet synlige funn, TTL 120 | 1579 | 1654 | 1903 | 2027 | 7163 |
| Sikret variant, TTL 300 | 1573 | 1621 | 1962 | 1949 | 7105 |

Siste rad forbedret gjennomsnittet 12,4 % fra den daværende v4-referansen. Den hadde null programfeil, ett sklitak totalt og største handlingsgap 2,578 sekunder. Sammenligningen gjelder v4, ikke den nyere v8 som senere ble funnet i originalprosjektet.

## Nye scenarioer og strategiforsøk

| Seed | Før passasjerettelsen | Passasjerettelse + verdi-prioritering |
|---|---:|---:|
| 101 | 967 | 1958 |
| 202 | 1968 | 2047 |
| 607 | 2030 | 2104 |
| 808 | 2103 | 2201 |

Disse endringene inneholder flere forbedringer samtidig; forskjellen isolerer ikke prioriteringsmodellen.
Ti fullførte skift i denne forsøksserien ga gjennomsnitt 2053,1 og beste 2204, altså ingen ny rekord over 2338.
Serien stoppet ved en midlertidig statusfeil. Kontrollprogrammet er etterpå rettet til å tåle slike spørringsfeil og gjenoppta planlagt testing.

## Observerte svakheter

- Både originalkjøringen og forsøkskjøringen hadde handlingspauser rundt 332–333 sekunder samtidig med nettverksfeil. Underliggende nettverks-/serverårsak er ikke fastslått. Dette overskrider 20-sekundersfristen betydelig.
- Seed 607 hadde en sølplassering og tilhørende `done` som serveren ikke godkjente; observert poengfall var 45. Slike rapporter markeres nå som ubekreftet og synliggjøres i resultatet.
- Stengninger gjelder passasjer mellom steder. Hele-korridor-modellen kunne gjøre tilgjengelige rom og tralla utilgjengelige i planleggeren. v8-rettelsen er tatt inn i den sikrede arbeidskopien og regresjonstestet.
- Lange søk, unødvendig lading sent på natten og manglende samordning av leveranser er fortsatt prioriterte områder for poengforbedring.

## Driftskontroller

Testene dekker blant annet ti parallelle, simulerte finaleskift; gjenfinning av mistet startsvar; samme skift ved gjenopptakelse; en reell prosessavslutning etter leveringskvittering; avlysninger før utsending; feil mottaker; alternative passasjer; midlertidige statusfeil; og forkastede `done`-rapporter.

Kjør `npm test`. Finaleklokken er søndag 8. november 12:00 Europe/Oslo. `node run.js --check` starter ingen skift.

## Lagerstrategi: kontroll 7. november kl. 14:40 Oslo

Den ferske resultatlisten viste Ghosts 2438 / 154 skift (plass 10), Bando 3320 / 168 og førsteplassen 3448. Dette er beste enkeltskift, ikke lagenes gjennomsnitt. Ingen seier er verifisert.

På åtte identiske seeds (101, 202, 607, 808, 20, 26, 30, 31) ga `stocked` 2131,875 i snitt mot `batch3` 2090,625: +41,25 poeng (+1,97 %). Seks ble bedre, to dårligere; største tilbakegang var 24 poeng. Svakeste skift økte fra 1473 til 1536, og beste fra 2426 til 2438. Kandidaten hadde null registrerte programfeil, to sklitak og én avvist ferdigrapport (søl, −30 poeng). Tallene dokumenterer en liten forbedring, ikke en vinnerstrategi.

`stocked` er fortsatt eksperimentell. En sammenligning mot de 26 øvrige scenarioene i batch3-serien kjører i `sweep-stocked-holdout-v10-05`. Dette er flere kjente seeds, holdt utenfor den første åtte-scenariotesten; de er ikke hemmelige finalescenarioer. Ikke aktiver som produksjonsstandard uten vurdering av disse resultatene.

Analysen av de åtte skiftene finner 112,4 simulerte minutter brukt på hittegodsoppdrag som ikke endte som fullført. Sølhendelsen i seed 607 viser at to beskjeder på samme etasje kan knyttes til feil våt flekk; tidspunkt for første observasjon er ikke sikkert tidspunkt for når sølet oppstod. Begge områdene trenger målrettet forbedring og ny testing.

## Trallekapasitet og gjentatte rombestillinger (pågående kontroll)

De 26 øvrige scenarioene med den første lagerstrategien ble fullført: +25,58 poeng i snitt, men én tilbakegang på 351 poeng. Loggen viste fire mislykkede henteoppdrag fordi tralla var full, og senere valg av gamle gjenstander til nye oppdrag for samme rom.

Rettelsen reserverer to tralleplasser i lagerstrategien. Ved eksplisitt «cart is full» kan grunnagenten sette fra seg én ubrukt vanlig lagervare og forsøke henting igjen; gjestegjenstander, nøkkelkort og varer som den aktive leveransen trenger, bevares. Nedlagte varer registreres for senere gjenbruk. Gjenstanden til et henteoppdrag lagres før henting, også når henting feiler. Nye oppdrag velger ikke tidligere tildelte gjenstander, og tvetydige valg avvises.

De to første målrettede gjentakelsene ga seed 22: 1666 → 1991 og seed 35: 2058 → 2091. Begge hadde null avviste ferdigrapporter og null programfeil. Åtte-scenarioserien er fortsatt i gang; dette er ikke et fullført gjennomsnittsresultat.

Grunnrettelsene testes separat fra to nye forsøksvarianter: `cover_spills` sikrer alle observerte våte flekker på etasjen, og `coverage` søker nye steder i andre hittegodsforsøk. Ingen av disse to variantene er produksjonsstandard. Hele testpakken består nå 91 tester.
