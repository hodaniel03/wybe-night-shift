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

## Stresstest og effektivitetsstudie, lørdag kveld

Den ferdige trallerettelsen (`stocked-v11-cart-06`) ga +49 poeng i snitt over åtte identiske scenarioer sammenlignet med forrige lagerstrategi. Snittet ble 2232,5, laveste resultat 1991 og beste 2433. Ingen programfeil, to sklitak og to ubekreftede ferdigrapporter. Sølvarianten ble ikke valgt: −35 poeng i snitt på dens åtte sammenligninger. Utvidet hittegodssøk ga −4 poeng i snitt på åtte scenarioer; rekord 2460 i ett av dem beviser ikke bedre generell kvalitet.

En lokal stresstest kjørte ti parallelle Agent-instanser gjennom 60 leveranser. Den injiserte 10 ratebegrensninger (429), 10 midlertidige serverfeil (503 på status) og 20 svar som gikk tapt etter at leveringen var utført. Alle 60 leveranser skjedde nøyaktig én gang. Totalt 280 simulerte API-kall; største lokale handlingsgap 1143 ms. Testen bruker en lokal fetch-erstatning, ingen finaleskift eller eksterne belastningskall. Den kan ikke garantere oppetid eller latenstid hos den ekte serveren.

Produksjonsprosjektet består 92 tester inkludert stresstesten. Arbeidskopien består 95 tester med ekstra forsøk på sluttbatteri og romavklaring. Disse ekstra strategiene er ikke produksjonsstandard.

Pågående kontrollert serie: `sweep-production-v021-09` spiller dagens installerte agent på seeds 47–54. `efficiency-study.js` venter til denne er ferdig, spiller `stocked` på samme åtte, deretter `efficient` på samme åtte. Sistnevnte prøver batterifeasible oppgaver etter 05:00 og én romavklaring via nattleder før vanlig resepsjonsoppslag. Hvis nattlederen ikke kan svare, slås dette forsøket av for resten av skiftet.

Etter sammenligningen velger skriptet kun en øvingsvariant: høyest målt snitt blant komplette feilfrie serier med minst like bra dårligste resultat og ikke flere ubekreftede ferdigrapporter enn produksjonsreferansen. Den prøves på nye seeds 55–70. Valget lagres i `efficiency-selection.json`. Det endrer ikke finalekonfigurasjonen automatisk. Alle kjøringer er practice, med maksimalt fire samtidige og felles 40 kall/s-begrenser.


Referansen på seeds 47–54 er fullført: snitt **1929**, svakeste **1383**, beste **2226**, null programfeil, ett sklitak og tre ubekreftede sølrapporter. Samme-seed-testen av `stocked` har startet.

`efficient` prøver også samlasting av opptil to allerede bestilte brett/bagasjer til samme etasje, med separat oppdragseierskap og journalføring, samt én forespørsel om nøyaktig sølsted til nattlederen. Avklaringsfunksjonene har vanlig oppslag/søk som fallback når nattlederen ikke kan svare. API-støtten for disse avklaringene er foreløpig ikke bekreftet. Sammenligningen måler effekten av den samlede kandidaten, ikke hvert tiltak isolert.


## Versjon 0.3.0: standardstrategien er oppdatert

Sammenligningen på seeds 47–54 er ferdig:

| Strategi | Snitt | Svakeste | Beste | Programfeil | Ubekreftede ferdigrapporter |
|---|---:|---:|---:|---:|---:|
| Tidligere produksjon | 1929 | 1383 | 2226 | 0 | 3 |
| Lager og verdi-prioritering | 2097,5 | 1927 | 2290 | 0 | 2 |
| Efficient, valgt standard | 2110,75 | 1941 | 2373 | 0 | 2 |

Ny standard forbedret snittet **9,4 %** på disse åtte scenarioene. Ytterligere 16 nye seeds (55–70) ga snitt 2084,125, svakeste 1630, beste 2469, null programfeil og én ubekreftet ferdigrapport. De 16 nye scenarioene er ikke en paret sammenligning mot gammel produksjon.

`src/policy.js` er en frosset kopi av den målte strategien, og `run.js` velger `efficient` som standard. `--strategy baseline` finnes for sammenligning. Strategien og lagerbudsjettet lagres; eldre tilstandsfiler uten strategifelt fortsetter som baseline. Installerte versjon 0.3.0 består 101 tester og API-preflight. Ingen finaleskift er startet.

Nattlederen svarte «exactly as written» på ekstra avklaringsforsøk; disse er derfor ikke en dokumentert kilde til forbedringen. Vanlig resepsjonsoppslag og søk brukes som fallback.

Neste kandidat, `adaptive`, er kun under testing: den fortsetter hittegodssøk på nye steder på andre forsøk og slipper fram også ikke-hastende, klare oppdrag ved en søkegrense. Åtte tidligere målte scenarioer brukes: 55, 58, 60, 61, 63, 65, 66, 68. Resultater i `sweep-adaptive-v031-13`.

Målelogger finnes i `/Users/hodanielkhuu/Documents/ChatGPT/Oslo Sprint Hackathon 2/wybe-hardening/validation/`.
