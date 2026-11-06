#!/usr/bin/env node
/*
 * Kjør Night Shift-agenten fra terminalen.
 *
 *   node run.js --seed 7                # ett øvingsskift på seed 7
 *   node run.js --seed 1 --count 3      # seed 1, 2 og 3
 *   node run.js --mode final --yes      # finalen (søndag 12:00–13:00)
 *
 * Nøkkelen leses fra .env (NS_KEY=...). Logger havner i logs/.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Agent, startShift, apiCall } = require('./src/agent');

const USAGE = `Bruk: node run.js [--mode practice|final] [--seed N] [--count N] [--unknown skip|decline] [--quiet] [--yes]

  --mode     practice (standard) eller final
  --seed     1–999, gjentar samme natt (kun practice)
  --count    antall skift etter hverandre (seed øker med 1 hver gang)
  --unknown  hva agenten gjør med forespørsler den ikke forstår (standard: decline)
  --quiet    bare oppsummering, ikke hver linje
  --yes      kreves for --mode final, så ingen starter finalen ved et uhell`;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function parseArgs(argv) {
  const a = { mode: 'practice', seed: undefined, count: 1, quiet: false, unknown: 'decline', yes: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--mode') a.mode = argv[++i];
    else if (k === '--seed') a.seed = Number(argv[++i]);
    else if (k === '--count') a.count = Number(argv[++i]);
    else if (k === '--unknown') a.unknown = argv[++i];
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--yes') a.yes = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else { console.error(`Ukjent argument: ${k}`); a.help = true; }
  }
  return a;
}

async function main() {
  loadEnv(path.join(__dirname, '.env'));
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }
  const key = process.env.NS_KEY;
  const base = process.env.NS_BASE || undefined; // kun for testing mot en lokal mock
  if (!key) {
    console.error('Mangler NS_KEY. Kopier .env.example til .env og lim inn lagets nøkkel.');
    process.exit(1);
  }
  if (args.mode === 'final' && !args.yes) {
    console.error('Finalen teller. Legg til --yes hvis dere virkelig vil starte den.');
    process.exit(1);
  }

  const who = await apiCall({ key, base, cmd: 'whoami' });
  console.log(`Lag: ${who.result && who.result.team} (${who.result && who.result.shifts_played} skift spilt)`);

  const logsDir = path.join(__dirname, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const results = [];
  let seed = args.seed;

  for (let i = 0; i < args.count; i++) {
    let info;
    try {
      info = await startShift({ key, base, mode: args.mode, seed: args.mode === 'practice' ? seed : undefined });
    } catch (e) {
      console.error(`Kunne ikke starte skift: ${e.message || e}`);
      break;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logBase = path.join(logsDir, `${stamp}-${args.mode}-seed${info.seed === undefined ? 'x' : info.seed}`);
    const out = fs.createWriteStream(logBase + '.log');
    console.log(`\n== Starter ${args.mode}-skift ${info.shift} (seed ${info.seed}) ==`);
    const agent = new Agent({
      key,
      base,
      shift: info.shift,
      onUnknown: args.unknown,
      log: (line) => { out.write(line + '\n'); if (!args.quiet) console.log(line); },
    });
    const t0 = Date.now();
    const summary = await agent.run();
    out.end();
    fs.writeFileSync(logBase + '.trace.json', JSON.stringify(agent.trace, null, 1));
    fs.writeFileSync(logBase + '.summary.json', JSON.stringify(summary, null, 2));
    const secs = Math.round((Date.now() - t0) / 1000);
    const byStatus = {};
    for (const r of summary.requests) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    console.log(`== Ferdig: ${summary.score} poeng | ${summary.requests.length} forespørsler ${JSON.stringify(byStatus)} | ${agent.slips} sklitak | ${summary.calls} kall | ${secs} s ==`);
    results.push({ seed: info.seed, score: summary.score });
    if (seed !== undefined) seed++;
  }

  if (results.length > 1) {
    const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
    console.log(`\nSnitt over ${results.length} skift: ${avg.toFixed(1)} poeng  ${JSON.stringify(results)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
