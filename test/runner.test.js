'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {parseArgs,readManifest,acquireLock,waitTarget,assertFinalWindow,summarize,mergeFinalShifts,FINAL_START,FINAL_END} = require('../run');

test('final defaults to ten parallel shifts and rejects accidental sequential execution', () => {
  assert.equal(parseArgs(['--mode','final','--yes']).parallel,10);
  assert.throws(() => parseArgs(['--mode','final','--count','10','--yes']),/parallelt/);
  assert.throws(() => parseArgs(['--mode','final','--parallel','4','--yes']),/10/);
});

test('CLI rejects missing, malformed, conflicting and out-of-range arguments', () => {
  for (const args of [['--parallel','0'],['--parallel','NaN'],['--count','-1'],['--mode','bogus'],['--seed'],['--seed','999','--parallel','2'],['--wait-until','24:99'],['--resume','s-1','--parallel','2'],['--parallel','2','--count','2'],['--bogus']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--seed','101','--parallel','10']).seed,101);
});

test('final time resolves to Sunday noon Oslo independently of machine timezone', () => {
  assert.equal(waitTarget('12:00','final',Date.parse('2026-11-07T09:00:00Z')),FINAL_START);
  assert.throws(() => assertFinalWindow(FINAL_START-1));
  assert.doesNotThrow(() => assertFinalWindow(FINAL_START));
  assert.throws(() => assertFinalWindow(FINAL_END));
});

test('ranking includes zeroes for unstarted finals before dropping the worst', () => {
  const r = summarize([{summary:{score:900}},{summary:{score:1800}}],10);
  assert.deepEqual(r.scores,[900,1800,0,0,0,0,0,0,0,0]);
  assert.equal(r.avg,270);
  assert.equal(r.dropWorst,300);
});

test('manifest supports original arrays and validates duplicate IDs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wybe-manifest-'));
  try {
    const file = path.join(dir,'shifts.json');
    fs.writeFileSync(file,JSON.stringify([{shift:'w2-test',mode:'final'}]));
    assert.equal(readManifest(file).mode,'final');
    fs.writeFileSync(file,JSON.stringify([{shift:'w2-test'},{shift:'w2-test'}]));
    assert.throws(() => readManifest(file),/flere ganger/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('live locks prevent duplicate control and dead process locks are recoverable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wybe-lock-'));
  try {
    const file = path.join(dir,'shift.lock');
    const release = acquireLock(file);
    assert.throws(() => acquireLock(file),/kjører allerede/);
    release();
    fs.writeFileSync(file,JSON.stringify({pid:2147483647}));
    acquireLock(file)();
    assert.equal(fs.existsSync(file),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('remote final reconciliation recovers a lost start response without duplicating IDs', () => {
  const m = {shifts:[{shift:'s-1',mode:'final'}],pendingStart:{beforeIds:['s-1']}};
  mergeFinalShifts(m,[{shift:'s-2',mode:'final',status:'active'},{shift:'s-1',mode:'final',status:'ended',score:900},{shift:'p-1',mode:'practice'}]);
  assert.deepEqual(m.shifts.map(i => i.shift),['s-1','s-2']);
  assert.equal(m.shifts[0].score,900);
  assert.equal(m.pendingStart,null);
});

test('runner starts ten finals concurrently, recovers an ambiguous start and resumes without new starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wybe-runner-'));
  try {
    fs.mkdirSync(path.join(dir,'src'));
    fs.copyFileSync(path.join(__dirname,'../run.js'),path.join(dir,'run.js'));
    fs.copyFileSync(path.join(__dirname,'../src/policy.js'),path.join(dir,'src/policy.js'));
    fs.writeFileSync(path.join(dir,'src/agent.js'),`
      const fs=require('fs');
      const state={starts:0,active:0,maxActive:0,shifts:[],seeds:[],reads:[]};
      class Agent {
        constructor(o){this.o=o;this.trace=[];this.log=()=>{};}
        loadState(){} save(){}
        summary(state){return {state,score:1000,requests:[]};}
        async run(){state.active++;state.maxActive=Math.max(state.maxActive,state.active);await new Promise(r=>setTimeout(r,50));state.active--;return this.summary('over');}
      }
      class RateLimiter { constructor(){this.throttled=0;} }
      async function apiCall({cmd}){state.reads.push(cmd);return {ok:true,result:cmd==='whoami'?{team:'Ghosts',live_shifts:0}:{shifts:state.shifts}};}
      async function startShift({mode,seed}){
        const info={shift:'s-'+(++state.starts),mode,status:'active',seed};state.shifts.push(info);if(seed!==undefined)state.seeds.push(seed);
        if(state.starts===3){const e=new Error('response lost');e.name='AmbiguousAction';throw e;}
        return info;
      }
      module.exports={Agent,RateLimiter,apiCall,startShift,state};
    `);
    const script = `
      process.env.NS_KEY='test-key';
      Date.now=()=>Date.parse('2026-11-08T11:00:00Z');
      const fs=require('fs');const r=require('./run');const {state}=require('./src/agent');
      (async()=>{
      Date.now=()=>Date.parse('2026-11-07T11:00:00Z');
      const check=await r.main(['--check','--mode','final','--wait-until','12:00']);
      if(!check.check||check.team!=='Ghosts'||state.starts!==0)throw Error('preflight started a shift');
      if(fs.readdirSync('logs').length!==0)throw Error('preflight left state or lock files');
      if(state.reads.join(',')!=='whoami,shifts')throw Error('preflight made unexpected calls');
      Date.now=()=>Date.parse('2026-11-08T11:00:00Z');
      await r.main(['--mode','final','--yes','--quiet']);
      if(state.starts!==10||state.maxActive!==10)throw Error(JSON.stringify(state));
      await r.main(['--resume','logs/final-shifts.json','--quiet']);
      if(state.starts!==10)throw Error('resume started a new shift');
      state.maxActive=0;await r.main(['--seed','201','--parallel','10','--quiet']);
      if(state.maxActive!==4)throw Error('practice concurrency '+state.maxActive);
      state.maxActive=0;await r.main(['--seed','301','--count','3','--quiet']);
      if(state.maxActive!==1)throw Error('sequential concurrency '+state.maxActive);
      fs.writeFileSync('result.json',JSON.stringify(state));})().catch(e=>{console.error(e);process.exit(1)});
    `;
    execFileSync(process.execPath,['-e',script],{cwd:dir,timeout:10000,stdio:'pipe'});
    const result = JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
    assert.equal(result.starts,23);
    assert.equal(result.maxActive,1);
    assert.deepEqual(result.seeds,[201,202,203,204,205,206,207,208,209,210,301,302,303]);
    const manifest=readManifest(path.join(dir,'logs/final-shifts.json'));
    assert.equal(manifest.shifts.length,10);
    assert.equal(manifest.pendingStart,null);
    assert.equal(fs.existsSync(path.join(dir,'logs/final-run.lock')),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
