#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { Agent, RateLimiter, startShift, apiCall } = require('./src/agent');

const FINAL_START = Date.parse('2026-11-08T11:00:00Z'); // 12:00 Europe/Oslo
const FINAL_END = Date.parse('2026-11-08T12:00:00Z');
const USAGE = `Bruk: node run.js [valg]
  --mode practice|final   standard practice; final kjører alltid 10 parallelt
  --seed N                første øvingsseed (1–999)
  --parallel N            N øvingsskift, opptil 4 samtidig
  --count N               N øvingsskift etter hverandre
  --wait-until HH:MM      klokkeslett i Europe/Oslo (final: søndag 8. november)
  --resume FIL|ID,ID      fortsett de samme skiftene; starter aldri nye
  --unknown skip|decline  standard decline
  --quiet                 bare fremdrift og resultat i terminalen
  --check                 sjekk oppsett og API; starter ingen skift
  --yes                   bekreft finalestart

Finale: node run.js --mode final --wait-until 12:00 --yes
Gjenoppta: node run.js --resume logs/final-shifts.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}`;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function parseArgs(argv) {
  const a = { mode: 'practice', count: 1, parallel: 0, quiet: false, unknown: 'decline', yes: false };
  const values = new Map([['--mode','mode'],['--seed','seed'],['--count','count'],['--parallel','parallel'],['--wait-until','waitUntil'],['--resume','resume'],['--unknown','unknown']]);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (seen.has(k)) throw new Error(`Argumentet ${k} er oppgitt to ganger.`);
    seen.add(k);
    if (values.has(k)) {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`Mangler verdi til ${k}.`);
      a[values.get(k)] = ['--seed','--count','--parallel'].includes(k) ? Number(v) : v;
    } else if (k === '--quiet') a.quiet = true;
    else if (k === '--yes') a.yes = true;
    else if (k === '--check') a.check = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`Ukjent argument: ${k}`);
  }
  if (!['practice', 'final'].includes(a.mode)) throw new Error('--mode må være practice eller final.');
  if (!['skip','decline'].includes(a.unknown)) throw new Error('--unknown må være skip eller decline.');
  for (const k of ['count','parallel']) {
    if ((k === 'parallel' && !seen.has('--parallel'))) continue;
    if (!Number.isInteger(a[k]) || a[k] < 1 || a[k] > 999) throw new Error(`--${k} må være et heltall mellom 1 og 999.`);
  }
  if (a.seed !== undefined && (!Number.isInteger(a.seed) || a.seed < 1 || a.seed > 999)) throw new Error('--seed må være et heltall mellom 1 og 999.');
  if (seen.has('--parallel') && seen.has('--count')) throw new Error('Bruk enten --parallel eller --count.');
  if (a.waitUntil && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(a.waitUntil)) throw new Error('--wait-until må være et gyldig HH:MM.');
  if (a.resume && (seen.has('--seed') || seen.has('--parallel') || seen.has('--count') || a.waitUntil)) throw new Error('--resume kan ikke kombineres med nye skift eller ventetid.');
  if (a.mode === 'final' && !a.resume) {
    if (a.seed !== undefined) throw new Error('--seed gjelder bare øving.');
    if (seen.has('--count')) throw new Error('Finalen må kjøre parallelt. Bruk --mode final --yes.');
    if (seen.has('--parallel') && a.parallel !== 10) throw new Error('Finalen består av nøyaktig 10 skift.');
    a.parallel = 10;
  }
  const total = a.parallel || a.count;
  if (a.seed !== undefined && a.seed + total - 1 > 999) throw new Error('Siste øvingsseed kan ikke være større enn 999.');
  return a;
}

function writeAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function validateInfos(infos) {
  if (!Array.isArray(infos) || !infos.length) throw new Error('Skiftlista er tom eller ugyldig.');
  const ids = new Set();
  for (const info of infos) {
    if (!info || typeof info.shift !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(info.shift)) throw new Error('Ugyldig skift-ID i skiftlista.');
    if (ids.has(info.shift)) throw new Error(`Skift ${info.shift} finnes flere ganger i lista.`);
    if (info.mode && !['practice','final'].includes(info.mode)) throw new Error('Ugyldig modus i skiftlista.');
    ids.add(info.shift);
  }
  const modes = new Set(infos.map(i => i.mode).filter(Boolean));
  if (modes.size > 1) throw new Error('Skiftlista blander øving og finale.');
  return infos;
}

function readManifest(file) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const infos = Array.isArray(obj) ? obj : obj.shifts;
  if (Array.isArray(infos) && infos.length) validateInfos(infos);
  else if (!obj || obj.version !== 2 || !Array.isArray(infos)) throw new Error('Ugyldig skiftliste.');
  return { version: 2, mode: obj.mode || (infos[0] && infos[0].mode), expected: obj.expected || infos.length, shifts: infos, pendingStart: obj.pendingStart || null };
}

// Exclusive lock per shift; stale locks from a killed process are removed automatically.
function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let old;
      try { old = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (_) { throw new Error(`Uleselig lås: ${file}. Kontroller at ingen agent kjører før låsen fjernes.`); }
      let alive = true;
      try { process.kill(old.pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
      if (alive) throw new Error(`En agent kjører allerede (PID ${old.pid}): ${file}`);
      fs.unlinkSync(file);
      continue;
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    let released = false;
    const release = () => { if (!released) { released = true; try { fs.unlinkSync(file); } catch (_) {} } };
    process.once('exit', release);
    return () => { process.removeListener('exit', release); release(); };
  }
  throw new Error(`Kunne ikke låse ${file}`);
}

function waitTarget(hhmm, mode, now = Date.now()) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm || '');
  if (!m) throw new Error('--wait-until må være HH:MM.');
  const date = mode === 'final' ? '2026-11-08' : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
  // Resolve Oslo's UTC offset on that date, independent of the host's timezone.
  const noon = Date.parse(`${date}T12:00:00Z`);
  const tz = new Intl.DateTimeFormat('en-US', { timeZone:'Europe/Oslo', timeZoneName:'shortOffset' }).formatToParts(noon).find(p => p.type === 'timeZoneName').value;
  const om = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tz);
  const offset = om ? (om[1] === '+' ? 1 : -1) * (Number(om[2]) * 60 + Number(om[3] || 0)) : 0;
  return Date.parse(`${date}T${m[1].padStart(2,'0')}:${m[2]}:00Z`) - offset * 60000;
}

async function waitUntil(hhmm, mode) {
  const target = waitTarget(hhmm, mode);
  console.log(`Venter til ${new Date(target).toISOString()} (${hhmm} Europe/Oslo).`);
  for (;;) {
    const left = target - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(left, 1000));
  }
}

function assertFinalWindow(now = Date.now()) {
  if (now < FINAL_START || now >= FINAL_END) throw new Error('Nye finaleskift kan bare startes søndag 8. november kl. 12:00–13:00 Europe/Oslo. Bruk --wait-until 12:00 før start.');
}

async function listShifts({key,base}) {
  const reply = await apiCall({key,base,cmd:'shifts',timeoutMs:4000});
  if (!reply.ok || !reply.result || !Array.isArray(reply.result.shifts)) throw new Error('Serveren returnerte ingen gyldig skiftliste.');
  return reply.result.shifts;
}

function mergeFinalShifts(manifest, remote) {
  const finals = remote.filter(i => i.mode === 'final');
  if (finals.length > 10) throw new Error('Serveren viser mer enn 10 finaleskift; avklar skiftlista før videre start.');
  for (const info of finals) {
    const existing = manifest.shifts.find(i => i.shift === info.shift);
    if (existing) Object.assign(existing,info);
    else manifest.shifts.push({...info});
  }
  if (manifest.shifts.length > 10) throw new Error('Skiftlista har mer enn 10 finaleskift.');
  if (manifest.shifts.length) validateInfos(manifest.shifts);
  if (manifest.pendingStart) {
    const before = new Set(manifest.pendingStart.beforeIds || []);
    if (finals.some(i => !before.has(i.shift))) manifest.pendingStart = null;
  }
  return manifest;
}

// A timed-out POST may already have allocated a shift. Recover its ID through `shifts`;
// never send that start again merely because its response was lost.
async function startSafely({key,base,mode,seed,manifest,listFile}) {
  const before = await listShifts({key,base});
  const beforeIds = new Set(before.map(i => i.shift));
  manifest.pendingStart = {index:manifest.shifts.length,seed,at:new Date().toISOString(),beforeIds:[...beforeIds]};
  writeAtomic(listFile,manifest);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const info = await startShift({key,base,mode,seed});
      return {...info,mode};
    } catch (e) {
      const ambiguous = e.ambiguous || e.name === 'AmbiguousAction' || e.constructor.name === 'AmbiguousAction';
      if (ambiguous) {
        for (let poll = 0; poll < 6; poll++) {
          if (poll) await sleep(1500);
          let after;
          try { after = await listShifts({key,base}); } catch (_) { continue; }
          const added = after.filter(i => i.mode === mode && !beforeIds.has(i.shift));
          if (added.length === 1) return {...added[0],seed,mode};
          if (added.length > 1) throw new Error('Flere skift dukket opp under start. Ingen nye startforsøk blir sendt.');
        }
        throw new Error('Ukjent utfall av start_shift. Startforsøket er lagret; kjør samme kommando igjen for å hente skift-ID fra serveren.');
      }
      // A JSON refusal confirms that no shift was allocated.
      manifest.pendingStart = null;
      writeAtomic(listFile,manifest);
      if (!/not.*open|opens? at|not.*started|already running|end one first|four practice/i.test(e.message || '') || attempt === 4) throw e;
      await sleep(1000);
      manifest.pendingStart = {index:manifest.shifts.length,seed,at:new Date().toISOString(),beforeIds:[...beforeIds]};
      writeAtomic(listFile,manifest);
    }
  }
}

function summarize(results, expected = results.length) {
  const scores = results.map(r => Number.isFinite(r.summary && r.summary.score) ? r.summary.score : 0);
  while (scores.length < expected) scores.push(0);
  const avg = scores.reduce((a,b) => a+b,0) / Math.max(1,scores.length);
  const sorted = scores.slice().sort((a,b) => a-b);
  const dropWorst = sorted.length > 1 ? sorted.slice(1).reduce((a,b) => a+b,0)/(sorted.length-1) : avg;
  return { avg, dropWorst, scores };
}

async function runOne({ key, base, info, args, logsDir, stamp, limiter, quiet }) {
  const id = info.shift;
  const release = acquireLock(path.join(logsDir, `${id}.lock`));
  const logBase = path.join(logsDir, `${stamp}-${info.mode || args.mode}-${id}`);
  const statePath = path.join(logsDir, `${id}.state.json`);
  const out = fs.createWriteStream(logBase + '.log', { flags:'a', mode:0o600 });
  out.on('error', e => console.error(`Loggfeil: ${e.message}`));
  const agent = new Agent({ key, base, shift:id, onUnknown:args.unknown, limiter,
    log: line => { out.write(line+'\n'); if (!quiet) console.log(line); },
    onSave: s => writeAtomic(statePath,s) });
  const t0 = Date.now();
  try {
    if (fs.existsSync(statePath)) agent.loadState(JSON.parse(fs.readFileSync(statePath,'utf8')));
    let summary;
    try { summary = info.status === 'ended' && Number.isFinite(info.score) ? {...agent.summary('over'), score:info.score} : await agent.run(); }
    catch (e) { agent.log(`CRASH ${e && e.stack || e}`); agent.save(); summary = Object.assign(agent.summary('crash'),{error:String(e)}); }
    summary.realSeconds = Math.round((Date.now()-t0)/1000);
    summary.seed = info.seed;
    writeAtomic(logBase+'.trace.json',agent.trace);
    writeAtomic(logBase+'.summary.json',summary);
    return { info, summary };
  } finally { out.end(); release(); }
}

function printTable(results, expected) {
  console.log('\n  skift       seed  poeng  utført avslått feilet  sklitak feil  maks-gap   tid');
  for (const r of results) {
    const s = r.summary || {}, by = {};
    for (const q of s.requests || []) by[q.status] = (by[q.status] || 0)+1;
    console.log(`  ${String(r.info.shift).slice(-8)}  ${String(s.seed ?? '-').padStart(5)}  ${String(s.score ?? '?').padStart(5)}  ${String(by.done || 0).padStart(6)} ${String(by.declined || 0).padStart(7)} ${String(by.failed || 0).padStart(6)}  ${String(s.slips || 0).padStart(7)} ${String(s.errors || 0).padStart(4)}  ${String(((s.maxActionGapMs || 0)/1000).toFixed(1)).padStart(6)} s  ${String(s.realSeconds || 0).padStart(4)} s  ${s.state}`);
  }
  for (const r of results) if (r.summary && r.summary.unconfirmedReports) console.error(`!!! ${r.info.shift}: ${r.summary.unconfirmedReports} done-rapporter ble ikke godkjent av serveren. Se skiftloggen.`);
  const {avg,dropWorst} = summarize(results,expected);
  if (results.length < expected) console.error(`!!! ${expected-results.length} manglende skift er regnet som 0.`);
  console.log(`\nSnitt: ${avg.toFixed(1)}. Snitt uten dårligste: ${dropWorst.toFixed(1)}.`);
}

async function preflight({key,base,logsDir}) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18 || typeof globalThis.fetch !== 'function') throw new Error('Node 18 eller nyere med innebygd fetch er påkrevd.');
  if (!key) throw new Error('Mangler NS_KEY.');
  const probe = path.join(logsDir,`.preflight-${process.pid}-${Date.now()}.json`);
  try {
    writeAtomic(probe,{check:true});
    if (!JSON.parse(fs.readFileSync(probe,'utf8')).check) throw new Error('Kunne ikke lese tilbake testfilen.');
  } finally {
    for (const file of [probe,`${probe}.${process.pid}.tmp`]) {
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  const who = await apiCall({key,base,cmd:'whoami',timeoutMs:4000});
  if (!who.ok || !who.result || typeof who.result.team !== 'string') throw new Error('Kunne ikke bekrefte lag og API-nøkkel.');
  const shifts = await listShifts({key,base});
  const finalRegistered = shifts.filter(i => i.mode === 'final').length;
  const liveShifts = Number.isFinite(who.result.live_shifts) ? who.result.live_shifts : shifts.filter(i => i.status !== 'ended').length;
  console.log(`Oppsett OK: Node ${process.versions.node}, fetch, API-nøkkel og atomisk lagring i logs/.`);
  console.log(`Lag: ${who.result.team}. Aktive skift: ${liveShifts}. Registrerte finaleskift: ${finalRegistered}/10.`);
  console.log('Finale: søndag 8. november 2026 kl. 12:00–13:00 Europe/Oslo.');
  console.log('Start før kl. 12:00: ./start-final.command');
  console.log('Eller: caffeinate -dimsu node run.js --mode final --wait-until 12:00 --yes');
  console.log('Sjekken startet ingen skift og ventet ikke på finalen.');
  return {check:true,team:who.result.team,liveShifts,finalRegistered};
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return; }
  loadEnv(path.join(__dirname,'.env'));
  const key = process.env.NS_KEY, base = process.env.NS_BASE || undefined;
  if (!key) throw new Error('Mangler NS_KEY. Kopier .env.example til .env og lim inn lagets nøkkel.');
  if (args.mode === 'final' && !args.yes && !args.resume && !args.check) throw new Error('Finalen teller og har ingen omstart. Legg til --yes for å starte.');
  const logsDir = path.join(__dirname,'logs');
  fs.mkdirSync(logsDir,{recursive:true});
  if (args.check) return preflight({key,base,logsDir});
  const stamp = stampNow();
  let manifest, listFile;
  if (args.resume) {
    if (fs.existsSync(args.resume)) { listFile = path.resolve(args.resume); manifest = readManifest(listFile); }
    else {
      if (/[/.\\]/.test(args.resume)) throw new Error(`Skiftlista finnes ikke: ${args.resume}`);
      manifest = {version:2,mode:args.mode,shifts:validateInfos(args.resume.split(',').map(shift => ({shift:shift.trim(),mode:args.mode}))) };
    }
    args.mode = manifest.mode || args.mode;
    manifest.expected = args.mode === 'final' ? 10 : manifest.shifts.length;
  } else {
    listFile = path.join(logsDir,args.mode === 'final' ? 'final-shifts.json' : `${stamp}-practice-shifts.json`);
    manifest = args.mode === 'final' && fs.existsSync(listFile) ? readManifest(listFile) : {version:2,mode:args.mode,expected:args.parallel || args.count,shifts:[],pendingStart:null};
    if (args.mode === 'final') manifest.expected = 10;
  }
  const releaseFinal = args.mode === 'final' ? acquireLock(path.join(logsDir,'final-run.lock')) : () => {};
  try {
    if (args.waitUntil) await waitUntil(args.waitUntil,args.mode);
    if (!args.resume && args.mode === 'final') assertFinalWindow();
    if (args.mode === 'final') {
      mergeFinalShifts(manifest,await listShifts({key,base}));
      if (listFile) writeAtomic(listFile,manifest);
    }
    if (args.resume && !manifest.shifts.length) throw new Error('Ingen startede skift å fortsette.');
    console.log(`Skiftliste: ${listFile || manifest.shifts.map(i => i.shift).join(',')}`);
    const limiter = new RateLimiter({rate:40,burst:20});
    const results = [], running = new Set();
    const startRun = info => {
      const p = runOne({key,base,info,args,logsDir,stamp,limiter,quiet:args.quiet || manifest.expected > 1})
        .catch(e => ({info,summary:{state:'crash',score:0,error:String(e)}}))
        .then(r => { results.push(r); running.delete(p); if (r.summary.state === 'crash') { console.error(`!!! Skift ${info.shift} stoppet: ${r.summary.error}. Fortsett med --resume ${listFile || info.shift}`); process.exitCode = 1; } });
      running.add(p);
    };
    manifest.shifts.forEach(startRun);
    let stop = !!args.resume;
    const concurrency = args.mode === 'final' ? 10 : args.parallel ? Math.min(4,args.parallel) : 1;
    const ticker = setInterval(() => console.log(`${running.size} skift kjører, ${results.length}/${manifest.expected} ferdige.`),30000);
    try {
      while ((!stop && manifest.shifts.length < manifest.expected) || running.size) {
        if (!stop && manifest.shifts.length < manifest.expected && running.size < concurrency) {
          const index = manifest.shifts.length;
          const seed = args.mode === 'practice' && args.seed !== undefined ? args.seed+index : undefined;
          try {
            if (args.mode === 'final') assertFinalWindow();
            if (manifest.pendingStart) throw new Error('Et tidligere startforsøk har ukjent utfall. Ikke start på nytt før skiftlista er avklart.');
            const info = await startSafely({key,base,mode:args.mode,seed,manifest,listFile});
            if (manifest.shifts.some(i => i.shift === info.shift)) throw new Error(`Serveren returnerte samme skift-ID to ganger: ${info.shift}`);
            manifest.shifts.push(info);
            manifest.pendingStart = null;
            writeAtomic(listFile,manifest);
            console.log(`Startet ${args.mode} ${manifest.shifts.length}/${manifest.expected}: ${info.shift}${seed !== undefined ? ` (seed ${seed})` : ''}`);
            startRun(info);
          } catch (e) {
            console.error(`!!! Kunne ikke starte skift ${index+1}: ${e.message}`);
            stop = true;
            process.exitCode = 1;
          }
          continue;
        }
        if (running.size) await Promise.race(running);
      }
    } finally { clearInterval(ticker); }
    results.sort((a,b) => manifest.shifts.indexOf(a.info)-manifest.shifts.indexOf(b.info));
    printTable(results,manifest.expected);
    writeAtomic(path.join(logsDir,`${stamp}-${args.mode}-results.json`),{mode:args.mode,expected:manifest.expected,results,...summarize(results,manifest.expected)});
    if (limiter.throttled) console.log(`Serveren ba om lavere fart ${limiter.throttled} ganger.`);
    return results;
  } finally { releaseFinal(); }
}

module.exports = {parseArgs,writeAtomic,readManifest,validateInfos,acquireLock,waitTarget,assertFinalWindow,summarize,mergeFinalShifts,startSafely,preflight,main,FINAL_START,FINAL_END};
if (require.main === module) main().catch(e => {console.error(e.message || e);process.exitCode=1;});
