#!/usr/bin/env node
'use strict';
// Practice-only rolling benchmark. Never calls start_shift with mode=final.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {writeAtomic,acquireLock} = require('../run');
const controlApi = require('../src/agent');
const ORIGINAL_ENV = '/Users/hodanielkhuu/vscode/wybe-night-shift/.env';
const PRACTICE_CLOSE = Date.parse('2026-11-08T10:45:00Z');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const sha256 = source => crypto.createHash('sha256').update(source).digest('hex');
const USAGE = `Practice-only rolling sweep (max four live shifts per team):
  node validation/sweep.js --seeds 1-999 --variant candidate --max-seeds 40
  node validation/sweep.js --seeds 101,105,201-210 --config validation/variants.js --variant value
  node validation/sweep.js --resume validation/sweep-.../manifest.json

  --seeds LIST            comma-separated seeds and inclusive ranges, each 1–999
  --max-seeds N           cap the number of seeds from LIST
  --variant NAME          result label; also passed to config.configure(agent,{name})
  --agent FILE            self-contained Agent module (default src/agent.js)
  --config FILE           self-contained module exporting options and/or configure
  --concurrency N         1–4 (default 4), accounting for the team's other live shifts
  --min-gap-ms N          per-agent pause (default Agent setting; 0 supported)
  --look-ttl N            trusted look lifetime in simulation seconds
  --max-search-locations N
  --stop-score N          score that triggers immediate board verification (default 3321)
  --capacity-wait N       seconds to wait if all capacity belongs to other runs (default 60)
  --compare FILE|DIR     compare the same seeds with a previous ranked.json
  --out DIR              results, snapshot, logs, state and ranked summaries
  --resume DIR|MANIFEST   continue the same seeds and same shift IDs after interruption

Stops allocating when Ghosts is verified strictly first on the practice leaderboard,
when the selected seeds are exhausted, on Ctrl+C, or at Sunday's 11:45 Oslo cutoff.
Existing shifts finish on Ctrl+C. The manifest can be resumed after a forced stop.`;

function seedList(value) {
  const seeds = [];
  for (const part of String(value || '').split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error('Seeds must be comma-separated integers/ranges.');
    const first = Number(m[1]), last = Number(m[2] || m[1]);
    if (first < 1 || last > 999 || first > last) throw new Error('Seed range must be between 1 and 999.');
    for (let s=first;s<=last;s++) {
      if (seeds.includes(s)) throw new Error(`Duplicate seed ${s}.`);
      seeds.push(s);
    }
  }
  return seeds;
}

function parseArgs(argv) {
  const a = {variant:'candidate',concurrency:4,stopScore:3321,capacityWait:60,agentFile:path.resolve(__dirname,'../src/agent.js'),agentOptions:{}};
  const seen = new Set();
  const valueKeys = {'--seeds':'seeds','--max-seeds':'maxSeeds','--variant':'variant','--agent':'agentFile','--config':'configFile','--concurrency':'concurrency','--min-gap-ms':'minGapMs','--look-ttl':'lookTtl','--max-search-locations':'maxSearchLocations','--stop-score':'stopScore','--capacity-wait':'capacityWait','--out':'out','--compare':'compare','--resume':'resume'};
  for (let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if (seen.has(flag)) throw new Error(`Repeated argument: ${flag}`);
    seen.add(flag);
    if (flag==='--help' || flag==='-h') {a.help=true;continue;}
    const key=valueKeys[flag], value=argv[++i];
    if (!key || !value || value.startsWith('--')) throw new Error(`Unknown argument or missing value: ${flag}`);
    a[key]=value;
  }
  if (a.help) return a;
  if (a.resume) {
    if (['--seeds','--max-seeds','--variant','--agent','--config','--min-gap-ms','--look-ttl','--max-search-locations','--out','--compare'].some(k=>seen.has(k))) throw new Error('Resume uses the saved seeds, options and source snapshots.');
  } else if (!a.seeds) throw new Error('Provide --seeds or --resume.');
  for (const [key,min,max] of [['concurrency',1,4],['maxSeeds',1,999],['minGapMs',0,1000],['lookTtl',1,3600],['maxSearchLocations',0,100],['stopScore',0,100000],['capacityWait',1,600]]) {
    if (a[key]===undefined) continue;
    a[key]=Number(a[key]);
    if (!Number.isInteger(a[key]) || a[key]<min || a[key]>max) throw new Error(`Invalid ${key}: expected integer ${min}–${max}.`);
  }
  if (a.seeds) a.seeds=seedList(a.seeds).slice(0,a.maxSeeds);
  for (const key of ['minGapMs','lookTtl','maxSearchLocations']) if (a[key]!==undefined) a.agentOptions[key]=a[key];
  if (!/^[a-zA-Z0-9_-]+$/.test(a.variant)) throw new Error('Variant label can only contain letters, numbers, underscores and hyphens.');
  return a;
}

function readKey() {
  if (process.env.NS_KEY) return process.env.NS_KEY;
  if (!fs.existsSync(ORIGINAL_ENV)) throw new Error('Missing NS_KEY.');
  const match=fs.readFileSync(ORIGINAL_ENV,'utf8').match(/^\s*NS_KEY\s*=\s*(.*?)\s*$/m);
  const key=match && match[1].replace(/^['"]|['"]$/g,'');
  if (!key) throw new Error('Missing NS_KEY.');
  return key;
}

function leaderboardStatus(reply,team='Ghosts') {
  const teams=reply && reply.ok && reply.result && reply.result.teams;
  if (!Array.isArray(teams)) throw new Error('Invalid leaderboard reply.');
  const own=teams.find(row=>row.team===team);
  const score=own && own.best_practice_score;
  const others=teams.filter(row=>row.team!==team).map(row=>row.best_practice_score);
  const valid=own && Number.isFinite(score) && others.every(Number.isFinite);
  return {team,score:valid?score:null,leader:teams[0] && teams[0].team,leaderScore:teams[0] && teams[0].best_practice_score,
    verifiedFirst:!!(valid && teams[0]===own && others.length && others.every(s=>score>s))};
}

function summarizeResults(results,requested) {
  const completed=results.filter(r=>r.state==='over'&&Number.isFinite(r.score));
  const scores=completed.map(r=>r.score).sort((a,b)=>a-b);
  const mean=a=>a.length?a.reduce((n,v)=>n+v,0)/a.length:null;
  return {requested,recorded:results.length,completed:scores.length,complete:scores.length===requested,
    average:mean(scores),worst:scores[0]??null,best:scores.at(-1)??null,dropWorst:mean(scores.length>1?scores.slice(1):scores),
    falseDone:results.reduce((n,r)=>n+(r.falseDone||0),0),slips:results.reduce((n,r)=>n+(r.slips||0),0),errors:results.reduce((n,r)=>n+(r.errors||0),0)};
}

function compareResults(results,baseline) {
  const valid=rows=>rows.filter(r=>r.state==='over'&&Number.isFinite(r.score));
  const old=new Map(valid(baseline).map(r=>[r.seed,r]));
  const current=valid(results);
  const common=current.filter(r=>old.has(r.seed)).map(r=>({seed:r.seed,baseline:old.get(r.seed).score,current:r.score,delta:r.score-old.get(r.seed).score})).sort((a,b)=>a.seed-b.seed);
  return {common:common.length,averageDelta:common.length?common.reduce((n,r)=>n+r.delta,0)/common.length:null,worstDelta:common.length?Math.min(...common.map(r=>r.delta)):null,
    baselineOnly:[...old.keys()].filter(seed=>!current.some(r=>r.seed===seed)),currentOnly:current.filter(r=>!old.has(r.seed)).map(r=>r.seed),seeds:common};
}

function requestDensity(agent) {
  const requests=agent.requests && typeof agent.requests.values==='function'?[...agent.requests.values()]:null;
  if (!requests) return {requestCount:null,firstHourRequests:null,firstHourTypes:null};
  const first=requests.filter(r=>Number.isFinite(r.atS)&&r.atS<3600);
  const types={};for(const r of first){const type=r.task && r.task.type || 'unknown';types[type]=(types[type]||0)+1;}
  return {requestCount:requests.length,firstHourRequests:first.length,firstHourTypes:types};
}

function auditTrace(trace) {
  const falseDoneReports=[],negativeScoreDeltas=[];
  let previous=null;
  for (const row of trace || []) {
    if (row.cmd==='report' && row.args && row.args.outcome==='done' && row.result!=='Noted. Thanks.') falseDoneReports.push({clock:row.clock,args:row.args,result:row.result});
    const score=row.result && typeof row.result==='object' && row.result.score;
    if (Number.isFinite(score)) {
      if (previous!==null && score<previous) negativeScoreDeltas.push({clock:row.clock,cmd:row.cmd,delta:score-previous,score});
      previous=score;
    }
  }
  return {falseDone:falseDoneReports.length,falseDoneReports,negativeScoreDeltas,negativeScoreDeltaTotal:negativeScoreDeltas.reduce((n,e)=>n+e.delta,0)};
}

function validateOptions(options) {
  if (!options || typeof options!=='object' || Array.isArray(options)) throw new Error('Config options must be an object.');
  for (const key of ['key','base','shift','limiter','log','onSave','__proto__','constructor','prototype']) if (Object.hasOwn(options,key)) throw new Error(`Config must not override transport option ${key}.`);
  return JSON.parse(JSON.stringify(options));
}

function setup(options) {
  if (options.resume) {
    const file=path.resolve(options.resume);
    const dir=fs.statSync(file).isDirectory()?file:path.dirname(file);
    const manifestFile=fs.statSync(file).isDirectory()?path.join(file,'manifest.json'):file;
    const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    if (manifest.version!==1 || manifest.mode!=='practice' || !Array.isArray(manifest.entries)) throw new Error('Not a practice sweep manifest.');
    if (manifest.entries.some(e=>!Number.isInteger(e.seed)||e.seed<1||e.seed>999)) throw new Error('Invalid saved seed.');
    if (new Set(manifest.entries.map(e=>e.seed)).size!==manifest.entries.length) throw new Error('Duplicate saved seeds.');
    for (const [name,expected] of [['agent.snapshot.js',manifest.sourceHash],['config.snapshot.js',manifest.configHash]]) {
      if (expected && sha256(fs.readFileSync(path.join(dir,name)))!==expected) throw new Error(`Snapshot checksum mismatch: ${name}`);
    }
    return {dir,manifestFile,manifest};
  }
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const dir=path.resolve(options.out || path.join(__dirname,`sweep-${options.variant}-${stamp}-${process.pid}`));
  fs.mkdirSync(dir,{recursive:true});
  const manifestFile=path.join(dir,'manifest.json');
  if (fs.existsSync(manifestFile)) throw new Error('Output already contains a sweep. Use --resume.');
  const source=fs.readFileSync(path.resolve(options.agentFile));
  fs.writeFileSync(path.join(dir,'agent.snapshot.js'),source);
  let configHash=null;
  if (options.configFile) {
    const config=fs.readFileSync(path.resolve(options.configFile));
    fs.writeFileSync(path.join(dir,'config.snapshot.js'),config);configHash=sha256(config);
  }
  if (options.compare) {
    const target=path.resolve(options.compare);
    const file=fs.statSync(target).isDirectory()?path.join(target,'ranked.json'):target;
    const comparison=JSON.parse(fs.readFileSync(file,'utf8'));
    const rows=Array.isArray(comparison)?comparison:comparison.results;
    if (!Array.isArray(rows)) throw new Error('Comparison requires ranked results with seed and score.');
    writeAtomic(path.join(dir,'comparison.snapshot.json'),rows);
  }
  const manifest={version:1,mode:'practice',variant:options.variant,createdAt:new Date().toISOString(),sourceHash:sha256(source),configHash,compare:!!options.compare,node:process.versions.node,
    agentOptions:validateOptions(options.agentOptions || {}),entries:options.seeds.map(seed=>({seed,status:'queued'})),stopReason:null};
  writeAtomic(manifestFile,manifest);
  return {dir,manifestFile,manifest};
}

async function runSweep(options,deps={}) {
  const {dir,manifestFile,manifest}=setup(options);
  const api=deps.api || controlApi, key=deps.key || readKey(), base=deps.base || process.env.NS_BASE || undefined;
  const now=deps.now || Date.now, pause=deps.sleep || sleep, log=deps.log || console.log;
  const candidate=deps.api || require(path.join(dir,'agent.snapshot.js'));
  if (typeof candidate.Agent!=='function') throw new Error('Agent module must export Agent.');
  const config=manifest.configHash?require(path.join(dir,'config.snapshot.js')):{};
  const configOptions=validateOptions(config.agentOptions || config.options || (typeof config.configure==='function'?{}:config));
  const agentOptions={...configOptions,...manifest.agentOptions};
  const logsDir=deps.lockDir || path.resolve(__dirname,'../logs');
  fs.mkdirSync(logsDir,{recursive:true});
  const releaseSweep=acquireLock(path.join(logsDir,'practice-sweep.lock'));
  const limiter=new api.RateLimiter({rate:40,burst:20});
  const baseline=manifest.compare?JSON.parse(fs.readFileSync(path.join(dir,'comparison.snapshot.json'),'utf8')):null;
  const running=new Map();
  let stopReason=null, blockedSince=null, board=null, team='Ghosts';
  const persist=()=>{manifest.updatedAt=new Date(now()).toISOString();manifest.stopReason=stopReason;writeAtomic(manifestFile,manifest);};
  const ranked=()=>{
    const results=manifest.entries.filter(e=>e.summary).map(e=>({seed:e.seed,shift:e.info.shift,variant:manifest.variant,sourceHash:manifest.sourceHash,...e.summary})).sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity));
    writeAtomic(path.join(dir,'ranked.json'),{variant:manifest.variant,mode:'practice',sourceHash:manifest.sourceHash,options:agentOptions,board,aggregate:summarizeResults(results,manifest.entries.length),comparison:baseline?compareResults(results,baseline):null,results});
    return results;
  };
  const read=async(cmd)=>{
    const deadline=now()+10*60*1000;
    for (;;) {
      try {
        const r=await api.apiCall({key,base,cmd,limiter});
        if (!r.ok) throw new Error(`Read ${cmd} was refused.`);
        return r;
      } catch (e) {
        const transient=e.retryable || /API .*unavailable|rate limited|server after .*tries/i.test(e.message || '');
        if (!transient || now()>=deadline || now()>=PRACTICE_CLOSE) throw e;
        log(`Temporary ${cmd} failure; keeping existing shifts alive and retrying the query.`);
        await pause(Math.min(5000,Math.max(1,deadline-now())));
      }
    }
  };
  const remoteShifts=async()=>{
    const r=await read('shifts');
    if (!Array.isArray(r.result && r.result.shifts)) throw new Error('Invalid shifts reply.');
    return r.result.shifts;
  };
  const checkBoard=async()=>{
    try {
      const reply=await read('leaderboard');board={...leaderboardStatus(reply,team),checkedAt:new Date(now()).toISOString()};
      writeAtomic(path.join(dir,'leaderboard.json'),{...reply,verification:board});
      if (board.verifiedFirst) {stopReason='verified-practice-first';log(`VERIFIED FIRST: ${team} ${board.score} > every other team.`);}
      return board;
    } catch(e) {log(`Leaderboard verification unavailable: ${e.message}`);return null;}
  };
  const recoverStart=async(entry,remote)=>{
    const before=new Set(entry.startIntent.beforeIds);
    const added=remote.filter(s=>s.mode==='practice'&&!before.has(s.shift));
    if (added.length!==1) throw new Error(`Unresolved start for seed ${entry.seed}: ${added.length} new practice IDs. No replacement start was sent.`);
    entry.info={...added[0],seed:entry.seed,mode:'practice'};entry.status='running';delete entry.startIntent;persist();
  };
  const runEntry=entry=>{
    const id=entry.info.shift;
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || entry.info.mode!=='practice') throw new Error('Invalid/non-practice shift ID.');
    const release=acquireLock(path.join(logsDir,`${id}.lock`));
    const prefix=path.join(dir,`seed${entry.seed}`);
    const out=fs.createWriteStream(prefix+'.log',{flags:'a',mode:0o600});
    out.on('error',e=>{stopReason='log-error';log(`Log error: ${e.message}`);});
    const agent=new candidate.Agent({...agentOptions,key,base,shift:id,limiter,onUnknown:'decline',
      log:line=>out.write(line+'\n'),onSave:state=>writeAtomic(prefix+'.state.json',state)});
    const started=now();
    writeAtomic(prefix+'.shift.json',{...entry.info,seed:entry.seed,mode:'practice',variant:manifest.variant,sourceHash:manifest.sourceHash,configHash:manifest.configHash,options:agentOptions});
    const p=Promise.resolve().then(async()=>{
      try {
        if (typeof config.configure==='function') config.configure(agent,{name:manifest.variant,seed:entry.seed,mode:'practice'});
        if (fs.existsSync(prefix+'.state.json')) agent.loadState(JSON.parse(fs.readFileSync(prefix+'.state.json','utf8')));
        log(`START ${manifest.variant} seed ${entry.seed} ${id}${entry.resumed?' (resume)':''}`);
        entry.status='running';persist();
        const summary=entry.info.status==='ended' && Number.isFinite(entry.info.score)?{state:'over',score:entry.info.score,recoveredFromServer:true}:await agent.run();
        entry.summary={...summary,...auditTrace(agent.trace),...requestDensity(agent),realSeconds:(now()-started)/1000};
        entry.status=summary.state==='over'?'completed':summary.state || 'paused';
        if (entry.status!=='completed') stopReason=`shift-${entry.status}`;
      } catch(e) {
        agent.save();entry.status='crash';entry.summary={...agent.summary('crash'),...auditTrace(agent.trace),...requestDensity(agent),error:String(e),realSeconds:(now()-started)/1000};stopReason='shift-crash';
      } finally {
        writeAtomic(prefix+'.summary.json',entry.summary || {state:'crash'});
        writeAtomic(prefix+'.trace.json',agent.trace || []);
        out.end();release();persist();ranked();
      }
      log(`DONE seed ${entry.seed}: score=${entry.summary.score}, state=${entry.status}, gap=${entry.summary.maxActionGapMs || 0}ms`);
      if (entry.summary.score>=options.stopScore) log(`Score threshold ${options.stopScore} reached; verifying the live leaderboard.`);
      await checkBoard();ranked();persist();
    }).finally(()=>running.delete(id));
    running.set(id,{agent,promise:p});
  };
  const onSignal=signal=>{stopReason=stopReason || `signal-${signal}`;persist();log(`Stopping new starts; ${running.size} existing shifts finish. Resume: node validation/sweep.js --resume ${manifestFile}`);};
  const onInt=()=>onSignal('SIGINT'),onTerm=()=>onSignal('SIGTERM');
  process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
  try {
    const who=await read('whoami');
    team=who.result && who.result.team;
    if (typeof team!=='string') throw new Error('Could not establish team identity.');
    log(`Practice sweep: ${team}; ${manifest.variant}; ${manifest.entries.length} seeds. Manifest: ${manifestFile}`);
    let remote=await remoteShifts();
    for (const entry of manifest.entries) {
      if (entry.status==='starting') await recoverStart(entry,remote);
      if (entry.info && entry.status!=='completed') {
        const row=remote.find(s=>s.shift===entry.info.shift);
        if (!row) throw new Error(`Saved shift ${entry.info.shift} was not returned by the server. No replacement start was sent.`);
        entry.info={...entry.info,...row};entry.resumed=true;
        if (running.size>=options.concurrency) await Promise.race([...running.values()].map(r=>r.promise));
        runEntry(entry);
      }
    }
    await checkBoard();
    while (running.size || (!stopReason && manifest.entries.some(e=>e.status==='queued'))) {
      if (now()>=PRACTICE_CLOSE && !stopReason) {stopReason='practice-cutoff';persist();log('Practice closed at Sunday 11:45 Europe/Oslo; no more starts.');}
      if (!stopReason && running.size<options.concurrency) {
        const next=manifest.entries.find(e=>e.status==='queued');
        if (next) {
          const capacity=await read('whoami');
          const live=capacity.result && capacity.result.live_shifts;
          if (!Number.isInteger(live) || live<0) throw new Error('Cannot verify team live-shift capacity.');
          if (live>=4) {
            if (!running.size) {
              blockedSince=blockedSince ?? now();
              if (now()-blockedSince>=options.capacityWait*1000) {stopReason='capacity-timeout';persist();continue;}
            }
            await Promise.race([...running.values()].map(r=>r.promise).concat(pause(1000)));continue;
          }
          remote=await remoteShifts();
          // Journal the non-idempotent start before transmitting it.
          next.status='starting';next.startIntent={at:new Date(now()).toISOString(),beforeIds:remote.map(s=>s.shift)};persist();
          try {
            if (now()>=PRACTICE_CLOSE) {next.status='queued';delete next.startIntent;stopReason='practice-cutoff';persist();continue;}
            await limiter.take();
            next.info={...await api.startShift({key,base,mode:'practice',seed:next.seed}),seed:next.seed,mode:'practice'};
            next.status='running';delete next.startIntent;blockedSince=null;persist();
          } catch(e) {
            if (e.name==='AmbiguousAction') {
              let resolved=false;
              for (let poll=0;poll<5;poll++) {
                if (poll) await pause(1000);
                try {await recoverStart(next,await remoteShifts());resolved=true;break;} catch(_) {}
              }
              if (!resolved) {stopReason='ambiguous-start';persist();log(`Ambiguous start seed ${next.seed}; saved without a replacement POST.`);continue;}
            } else {
              next.status='queued';delete next.startIntent;persist();
              if (/four practice|already running|end one first/i.test(e.message || '')) {
                blockedSince=blockedSince ?? now();
                if (now()-blockedSince>=options.capacityWait*1000) {stopReason='capacity-timeout';persist();}
                else await pause(1000);
                continue;
              }
              stopReason='start-error';persist();log(`Start refused: ${e.message}`);continue;
            }
          }
          runEntry(next);continue;
        }
      }
      if (running.size) await Promise.race([...running.values()].map(r=>r.promise).concat(pause(1000)));
      else break;
    }
    stopReason=stopReason || 'seeds-exhausted';persist();const results=ranked();
    const aggregate=summarizeResults(results,manifest.entries.length);
    log(`STOP ${stopReason}; ${aggregate.completed}/${aggregate.requested} complete; average=${aggregate.average ?? '-'}; worst=${aggregate.worst ?? '-'}; best=${aggregate.best ?? '-'}; falseDone=${aggregate.falseDone}; ${dir}`);
    return {dir,manifestFile,stopReason,board,aggregate:summarizeResults(results,manifest.entries.length),comparison:baseline?compareResults(results,baseline):null,results};
  } catch(e) {
    stopReason=stopReason || 'coordinator-error';persist();log(`Coordinator stopped new starts: ${e.message}`);
    await Promise.allSettled([...running.values()].map(r=>r.promise));
    ranked();persist();throw e;
  } finally {process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);releaseSweep();}
}

async function main(argv=process.argv.slice(2)) {
  const options=parseArgs(argv);
  if (options.help) {console.log(USAGE);return;}
  return runSweep(options);
}
module.exports={seedList,parseArgs,leaderboardStatus,auditTrace,summarizeResults,compareResults,requestDensity,runSweep,main,PRACTICE_CLOSE};
if (require.main===module) main().catch(e=>{console.error(e.message || e);process.exitCode=1;});
