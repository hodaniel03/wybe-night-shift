#!/usr/bin/env node
/*
 * Kjør Night Shift-agenten fra terminalen.
 *
 *   node run.js --seed 7                         # ett øvingsskift (seed 7)
 *   node run.js --seed 101 --parallel 10         # 10 øvingsnetter samtidig (seed 101–110), som en mini-finale
 *   node run.js --mode final --parallel 10 --wait-until 12:00 --yes   # FINALEN
 *   node run.js --resume logs/<...>-shifts.json  # fortsett skift etter krasj/nettbrudd
 *
 * Finaleregler (Wybe): 10 hemmelige skift, alle startes 12:00 og kan kjøre parallelt, ett forsøk per skift,
 * maks 45 min per skift, alt stopper 13:00, 20 s per handling. Rangering: snitt av 10 skift minus det dårligste.
 *
 * Nøkkelen leses fra .env (NS_KEY=...). Logger og lagret tilstand havner i logs/.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Agent, RateLimiter, startShift, apiCall } = require('./src/agent');

const USAGE = `Bruk: node run.js [valg]

  --mode practice|final   standard practice
  --seed N                første seed (practice). Uten seed: tilfeldig natt
  --parallel N            kjør N skift samtidig (practice: seed, seed+1, ...; final: 10)
  --count N               kjør N skift etter hverandre (gammel måte)
  --wait-until HH:MM      vent til klokka er HH:MM før start (f.eks. 12:00 for finalen)
  --resume FIL|ID,ID      fortsett allerede startede skift (FIL = logs/...-shifts.json)
  --unknown skip|decline  ukjente forespørsler (standard: decline)
  --quiet                 ikke skriv hver linje (alltid stille ved --parallel)
  --yes                   kreves for --mode final`;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function parseArgs(argv) {
  const a = { mode: 'practice', seed: undefined, count: 1, parallel: 0, quiet: false, unknown: 'decline', yes: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--mode') a.mode = argv[++i];
    else if (k === '--seed') a.seed = Number(argv[++i]);
    else if (k === '--count') a.count = Number(argv[++i]);
    else if (k === '--parallel') a.parallel = Number(argv[++i]);
    else if (k === '--wait-until') a.waitUntil = argv[++i];
    else if (k === '--resume') a.resume = argv[++i];
    else if (k === '--unknown') a.unknown = argv[++i];
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--yes') a.yes = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else { console.error(`Ukjent argument: ${k}`); a.help = true; }
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

function writeAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

async function waitUntil(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) throw new Error(`--wait-until må være HH:MM, fikk ${hhmm}`);
  const target = new Date();
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  for (;;) {
    const left = target - Date.now();
    if (left <= 0) { process.stdout.write('\n'); return; }
    process.stdout.write(`\rVenter til ${hhmm} ... ${Math.ceil(left / 1000)} s igjen   `);
    await sleep(Math.min(left, 1000));
  }
}

// start_shift with retries: the final only opens at 12:00, and the network may hiccup.
async function startWithRetry({ key, base, mode, seed, retryForMs }) {
  const until = Date.now() + retryForMs;
  for (;;) {
    try {
      return await startShift({ key, base, mode, seed });
    } catch (e) {
      const msg = String(e.message || e);
      if (/no more|all .*started|already started|limit|already running|end one first/i.test(msg) || Date.now() > until) throw e;
      console.error(`start_shift feilet (${msg.slice(0, 160)}), prøver igjen om 3 s`);
      await sleep(3000);
    }
  }
}

function summarize(results) {
  const scores = results.map((r) => (r.summary && r.summary.score) || 0);
  const avg = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
  const sorted = scores.slice().sort((a, b) => a - b);
  const dropWorst = sorted.length > 1 ? sorted.slice(1).reduce((a, b) => a + b, 0) / (sorted.length - 1) : avg;
  return { avg, dropWorst, scores };
}

async function runOne({ key, base, info, args, logsDir, stamp, limiter, quiet }) {
  const id = info.shift;
  const tag = info.seed !== undefined && info.seed !== null ? `seed${info.seed}` : id.slice(-6);
  const logBase = path.join(logsDir, `${stamp}-${args.mode}-${tag}`);
  const statePath = path.join(logsDir, `${id}.state.json`);
  const out = fs.createWriteStream(logBase + '.log', { flags: 'a' });
  const agent = new Agent({
    key, base, shift: id, onUnknown: args.unknown, limiter,
    log: (line) => { out.write(line + '\n'); if (!quiet) console.log(line); },
    onSave: (s) => writeAtomic(statePath, s),
  });
  if (args.resume && fs.existsSync(statePath)) {
    try { agent.loadState(JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch (e) { console.error(`Kunne ikke lese ${statePath}: ${e.message}`); }
  }
  const t0 = Date.now();
  let summary;
  try {
    summary = await agent.run();
  } catch (e) {
    agent.log(`CRASH ${e && e.stack || e}`);
    summary = Object.assign(agent.summary('crash'), { error: String(e) });
  }
  summary.realSeconds = Math.round((Date.now() - t0) / 1000);
  summary.seed = info.seed;
  out.end();
  try {
    fs.writeFileSync(logBase + '.trace.json', JSON.stringify(agent.trace));
    fs.writeFileSync(logBase + '.summary.json', JSON.stringify(summary, null, 2));
  } catch (e) { console.error(`Kunne ikke skrive logg: ${e.message}`); }
  return { info, agent, summary };
}

function printTable(results) {
  console.log('\n  skift      seed  poeng  utført avslått feilet  sklitak feil  maks-gap   tid');
  for (const r of results) {
    const s = r.summary || {};
    const by = {};
    for (const q of s.requests || []) by[q.status] = (by[q.status] || 0) + 1;
    const seed = s.seed === undefined || s.seed === null ? '-' : s.seed;
    console.log(`  ${String(r.info.shift).slice(-8)}  ${String(seed).padStart(4)}  ${String(s.score).padStart(5)}  ${String(by.done || 0).padStart(6)} ${String(by.declined || 0).padStart(7)} ${String(by.failed || 0).padStart(6)}  ${String(s.slips || 0).padStart(7)} ${String(s.errors || 0).padStart(4)}  ${String(Math.round((s.maxActionGapMs || 0) / 1000)).padStart(6)} s  ${String(s.realSeconds).padStart(4)} s  ${s.state}`);
  }
  const { avg, dropWorst } = summarize(results);
  console.log(`\n  Snitt: ${avg.toFixed(1)}   Snitt uten dårligste (slik finalen rangeres): ${dropWorst.toFixed(1)}\n`);
}

async function main() {
  loadEnv(path.join(__dirname, '.env'));
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }
  const key = process.env.NS_KEY;
  const base = process.env.NS_BASE || undefined; // kun for testing mot en lokal mock
  if (!key) { console.error('Mangler NS_KEY. Kopier .env.example til .env og lim inn lagets nøkkel.'); process.exit(1); }
  if (args.mode === 'final' && !args.yes && !args.resume) {
    console.error('Finalen teller og har ingen omstart. Legg til --yes hvis dere virkelig vil starte den.');
    process.exit(1);
  }

  const logsDir = path.join(__dirname, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = stampNow();

  const who = await apiCall({ key, base, cmd: 'whoami' });
  console.log(`Lag: ${who.result && who.result.team} (${who.result && who.result.shifts_played} skift spilt)`);

  // ---- which shifts to run ----
  let infos = [];
  if (args.resume) {
    if (fs.existsSync(args.resume)) infos = JSON.parse(fs.readFileSync(args.resume, 'utf8'));
    else infos = args.resume.split(',').map((s) => ({ shift: s.trim(), mode: args.mode }));
    console.log(`Fortsetter ${infos.length} skift: ${infos.map((i) => i.shift.slice(-8)).join(', ')}`);
  } else if (args.parallel) {
    // Start shifts and run them as they start. Practice allows 4 live shifts per team, so a "busy" answer
    // just means: wait until one of ours finishes, then start the next.
    if (args.waitUntil) await waitUntil(args.waitUntil);
    const n = args.parallel;
    const listFile = path.join(logsDir, `${stamp}-${args.mode}-shifts.json`);
    console.log(`Skiftliste: ${path.relative(process.cwd(), listFile)}  (bruk --resume på denne hvis noe krasjer)`);
    const limiter = new RateLimiter({ rate: 40, burst: 20 });
    const running = new Set();
    const results = [];
    let next = 0;
    let stop = false;
    const t0 = Date.now();
    const ticker = setInterval(() => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} min] ${running.size} kjører, ${results.length}/${n} ferdige`), 30000);
    while ((next < n && !stop) || running.size) {
      if (next < n && !stop) {
        const seed = args.mode === 'practice' && args.seed !== undefined ? args.seed + next : undefined;
        let info = null;
        try {
          info = await startWithRetry({ key, base, mode: args.mode, seed, retryForMs: args.mode === 'final' ? 10 * 60 * 1000 : 15000 });
        } catch (e) {
          const msg = String(e.message || e);
          if (/already running|end one first/i.test(msg) && running.size) { await Promise.race(running); continue; }
          if (/already running|end one first/i.test(msg)) { console.error('Serveren sier at for mange skift kjører (ikke våre). Venter 10 s.'); await sleep(10000); continue; }
          console.error(`\n!!! Kunne ikke starte skift ${next + 1}: ${msg}\n`);
          if (args.mode === 'final') console.error('!!! Et finaleskift som aldri startes gir 0. Kjør samme finale-kommando igjen for å starte resten.');
          stop = true;
          continue;
        }
        infos.push(info);
        writeAtomic(listFile, infos); // saved at once, so --resume works even if we crash right now
        next++;
        console.log(`Startet ${args.mode}-skift ${next}/${n}: ${info.shift}${info.seed !== undefined ? ` (seed ${info.seed})` : ''}`);
        const p = runOne({ key, base, info, args, logsDir, stamp, limiter, quiet: true })
          .catch((e) => ({ info, summary: { state: 'crash', score: 0, error: String(e) } }))
          .then((r) => { results.push(r); running.delete(p); });
        running.add(p);
        continue;
      }
      await Promise.race(running);
    }
    clearInterval(ticker);
    results.sort((a, b) => infos.indexOf(a.info) - infos.indexOf(b.info));
    printTable(results);
    if (limiter.throttled) console.log(`(Serveren ba oss senke farten ${limiter.throttled} ganger.)`);
    return;
  } else {
    if (args.waitUntil) await waitUntil(args.waitUntil);
    infos.push(await startWithRetry({ key, base, mode: args.mode, seed: args.seed, retryForMs: args.mode === 'final' ? 10 * 60 * 1000 : 15000 }));
    writeAtomic(path.join(logsDir, `${stamp}-${args.mode}-shifts.json`), infos);
  }
  if (!infos.length) { console.error('Ingen skift å kjøre.'); process.exit(1); }

  // ---- run ----
  if (args.count > 1 && !args.parallel && !args.resume) {
    // Old sequential mode: one after another.
    const results = [];
    let seed = args.seed;
    for (let i = 0; i < args.count; i++) {
      const info = i === 0 ? infos[0] : await startWithRetry({ key, base, mode: args.mode, seed, retryForMs: 15000 });
      results.push(await runOne({ key, base, info, args, logsDir, stamp, limiter: null, quiet: args.quiet }));
      if (seed !== undefined) seed++;
    }
    printTable(results);
    return;
  }
  if (infos.length === 1) {
    const r = await runOne({ key, base, info: infos[0], args, logsDir, stamp, limiter: null, quiet: args.quiet });
    printTable([r]);
    return;
  }

  const limiter = new RateLimiter({ rate: 40, burst: 20 });
  const runs = infos.map((info) => runOne({ key, base, info, args, logsDir, stamp, limiter, quiet: true }));
  const started = Date.now();
  const ticker = setInterval(() => {
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`[${mins} min] ${runs.length} skift kjører ... (detaljer i logs/)`);
  }, 30000);
  const settled = await Promise.allSettled(runs);
  clearInterval(ticker);
  const results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { info: infos[i], summary: { state: 'crash', score: 0, error: String(s.reason) } }));
  printTable(results);
  if (limiter.throttled) console.log(`(Serveren ba oss senke farten ${limiter.throttled} ganger.)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
