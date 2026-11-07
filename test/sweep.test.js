'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {parseArgs,seedList,leaderboardStatus,auditTrace,summarizeResults,compareResults,requestDensity,runSweep,PRACTICE_CLOSE}=require('../validation/sweep');

function fixture(args=[],extra={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wybe-sweep-'));
  const source=path.join(dir,'fixture-agent.js');fs.writeFileSync(source,'// injected fixture Agent');
  const out=path.join(dir,'output');
  const options=parseArgs(['--seeds','1-8','--agent',source,'--out',out,...args]);
  const state={starts:[],shifts:[],maxLive:0,external:0,events:[],best:0,attempts:0,...extra};
  class RateLimiter {async take(){}}
  class Agent {
    constructor(opts){this.opts=opts;this.trace=[];this.score=0;}
    log(){}
    save(){this.opts.onSave({shift:this.opts.shift});}
    loadState(s){assert.equal(s.shift,this.opts.shift);state.loaded=(state.loaded||0)+1;}
    summary(status){return {state:status,score:this.score,errors:0,slips:0,maxActionGapMs:5};}
    async run(){
      state.attempts++;
      const info=state.shifts.find(s=>s.shift===this.opts.shift);
      if(state.failOnce && state.attempts===1)throw Error('fixture crash');
      await new Promise(r=>setTimeout(r,info.seed===1?40:5));
      this.score=state.winning && info.seed===2?4000:info.seed*100;
      this.trace=[{cmd:'status',result:{score:100}},{cmd:'status',result:{score:80}},
        {cmd:'report',args:{outcome:'done'},result:info.seed===2?'Noted.':'Noted. Thanks.'}];
      info.status='ended';info.score=this.score;state.best=Math.max(state.best,this.score);state.events.push(['done',info.seed]);
      return this.summary('over');
    }
  }
  const api={Agent,RateLimiter,
    async apiCall({cmd}){
      const live=state.shifts.filter(s=>s.status!=='ended').length+state.external;
      state.maxLive=Math.max(state.maxLive,live);
      if(cmd==='whoami')return {ok:true,result:{team:'Ghosts',live_shifts:live}};
      if(cmd==='shifts')return {ok:true,result:{shifts:state.shifts.map(s=>({...s}))}};
      if(cmd==='leaderboard'){
        const teams=[{team:'Bando',best_practice_score:3320},{team:'Ghosts',best_practice_score:state.best}].sort((a,b)=>b.best_practice_score-a.best_practice_score);
        return {ok:true,result:{teams}};
      }
      throw Error('unexpected '+cmd);
    },
    async startShift({mode,seed}){
      assert.equal(mode,'practice');
      assert.ok(state.shifts.filter(s=>s.status!=='ended').length+state.external<4);
      state.starts.push(seed);state.events.push(['start',seed]);
      const info={shift:'s-'+state.starts.length,seed,mode,status:'running'};state.shifts.push(info);
      state.maxLive=Math.max(state.maxLive,state.shifts.filter(s=>s.status!=='ended').length+state.external);
      if(state.ambiguousOnce && state.starts.length===1){const e=Error('response lost');e.name='AmbiguousAction';throw e;}
      return {...info};
    }};
  const deps={api,key:'fixture-secret',now:()=>Date.parse('2026-11-07T12:00:00Z'),sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,1))),lockDir:path.join(dir,'locks'),log:()=>{}};
  return {dir,out,options,state,deps,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

test('sweep seed ranges and options reject invalid or dangerous invocation',()=>{
  assert.deepEqual(seedList('1-3,10,20-21'),[1,2,3,10,20,21]);
  for(const args of [[],['--seeds','0'],['--seeds','1-1000'],['--seeds','3-1'],['--seeds','1,1'],['--seeds','1','--concurrency','5'],['--mode','final'],['--resume','x','--seeds','1']])assert.throws(()=>parseArgs(args));
  assert.deepEqual(parseArgs(['--seeds','1-9','--max-seeds','2','--min-gap-ms','0']).seeds,[1,2]);
  assert.equal(parseArgs(['--seeds','1','--min-gap-ms','0']).agentOptions.minGapMs,0);
});

test('leaderboard verifies strict first place and refuses ties or unverified data',()=>{
  const board=teams=>({ok:true,result:{teams}});
  assert.equal(leaderboardStatus(board([{team:'Ghosts',best_practice_score:3321},{team:'Bando',best_practice_score:3320}])).verifiedFirst,true);
  assert.equal(leaderboardStatus(board([{team:'Ghosts',best_practice_score:3320},{team:'Bando',best_practice_score:3320}])).verifiedFirst,false);
  assert.equal(leaderboardStatus(board([{team:'Bando',best_practice_score:3320},{team:'Ghosts',best_practice_score:3321}])).verifiedFirst,false);
  assert.throws(()=>leaderboardStatus({ok:false}));
});

test('trace audit detects rejected done reports and negative observed score deltas',()=>{
  const audit=auditTrace([{cmd:'status',result:{score:100}},{cmd:'report',args:{outcome:'done'},result:'Noted.'},{cmd:'status',result:{score:70}},{cmd:'report',args:{outcome:'done'},result:'Noted. Thanks.'}]);
  assert.equal(audit.falseDone,1);assert.equal(audit.negativeScoreDeltaTotal,-30);
});

test('rolling pool respects other team shifts and starts next seed as soon as capacity frees',async()=>{
  const f=fixture([], {external:1});
  try{
    const result=await runSweep(f.options,f.deps);
    assert.equal(result.stopReason,'seeds-exhausted');
    assert.deepEqual(f.state.starts,[1,2,3,4,5,6,7,8]);
    assert.equal(f.state.maxLive,4);
    assert.ok(f.state.events.findIndex(e=>e[0]==='start'&&e[1]===4)<f.state.events.findIndex(e=>e[0]==='done'&&e[1]===1));
    assert.equal(result.results.find(s=>s.seed===2).falseDone,1);
    assert.equal(result.results[0].negativeScoreDeltaTotal,-20);
    const meta=JSON.parse(fs.readFileSync(path.join(f.out,'seed1.shift.json'),'utf8'));
    assert.equal(meta.mode,'practice');assert.equal(meta.seed,1);assert.ok(meta.sourceHash);
    assert.equal(fs.readFileSync(path.join(f.out,'manifest.json'),'utf8').includes('fixture-secret'),false);
  }finally{f.cleanup();}
});

test('verified first place drains current shifts and stops allocating more seeds',async()=>{
  const f=fixture([], {winning:true});
  try{
    const result=await runSweep(f.options,f.deps);
    assert.equal(result.stopReason,'verified-practice-first');assert.equal(result.board.verifiedFirst,true);
    assert.equal(f.state.starts.length,4);assert.equal(result.results.length,4);
  }finally{f.cleanup();}
});

test('ambiguous start is reconciled without a second start for the same seed',async()=>{
  const f=fixture(['--max-seeds','1'], {ambiguousOnce:true});
  try{
    const result=await runSweep(f.options,f.deps);
    assert.deepEqual(f.state.starts,[1]);assert.equal(result.results.length,1);
  }finally{f.cleanup();}
});

test('crashed sweep resumes same active ID and checkpoint without allocating replacement',async()=>{
  const f=fixture(['--max-seeds','1'], {failOnce:true});
  try{
    const first=await runSweep(f.options,f.deps);
    assert.equal(first.stopReason,'shift-crash');assert.deepEqual(f.state.starts,[1]);
    const result=await runSweep(parseArgs(['--resume',first.manifestFile]),f.deps);
    assert.equal(result.results[0].state,'over');assert.deepEqual(f.state.starts,[1]);assert.equal(f.state.loaded,1);
  }finally{f.cleanup();}
});

test('practice cutoff allocates zero shifts',async()=>{
  const f=fixture();
  try{
    f.deps.now=()=>PRACTICE_CLOSE;
    const result=await runSweep(f.options,f.deps);
    assert.equal(result.stopReason,'practice-cutoff');assert.equal(f.state.starts.length,0);
  }finally{f.cleanup();}
});

test('external capacity wait is bounded and retains queued seeds for resume',async()=>{
  const f=fixture(['--capacity-wait','1'], {external:4});
  try{
    let elapsed=0;f.deps.now=()=>Date.parse('2026-11-07T12:00:00Z')+elapsed;f.deps.sleep=async ms=>{elapsed+=ms;};
    const result=await runSweep(f.options,f.deps);
    assert.equal(result.stopReason,'capacity-timeout');assert.equal(f.state.starts.length,0);
    const m=JSON.parse(fs.readFileSync(result.manifestFile,'utf8'));assert.ok(m.entries.every(e=>e.status==='queued'));
  }finally{f.cleanup();}
});


test('holdout metrics include average and worst, and compare only identical completed seeds',()=>{
  const rows=[{seed:1,state:'over',score:100},{seed:2,state:'over',score:300},{seed:3,state:'crash',score:1000}];
  const stats=summarizeResults(rows,4);
  assert.equal(stats.average,200);assert.equal(stats.worst,100);assert.equal(stats.dropWorst,300);assert.equal(stats.complete,false);
  const comparison=compareResults(rows,[{seed:1,state:'over',score:120},{seed:2,state:'over',score:200},{seed:4,state:'over',score:400}]);
  assert.equal(comparison.averageDelta,40);assert.equal(comparison.worstDelta,-20);assert.deepEqual(comparison.baselineOnly,[4]);
  assert.deepEqual(requestDensity({requests:new Map([[1,{atS:20,task:{type:'tell'}}],[2,{atS:4000,task:{type:'deliver'}}]])}),{requestCount:2,firstHourRequests:1,firstHourTypes:{tell:1}});
});

test('temporary coordinator status failures do not abandon the queued seed series',async()=>{
 const f=fixture(['--max-seeds','2']);const call=f.deps.api.apiCall;let failures=2;
 f.deps.api.apiCall=async args=>{if(args.cmd==='whoami'&&failures-->0){const e=Error('API whoami unavailable within 7000ms');e.retryable=true;throw e;}return call(args);};
 try{const result=await runSweep(f.options,f.deps);assert.equal(result.aggregate.completed,2);assert.equal(result.stopReason,'seeds-exhausted');assert.deepEqual(f.state.starts,[1,2]);}finally{f.cleanup();}
});
