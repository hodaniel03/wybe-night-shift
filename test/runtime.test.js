'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const {startRuntimeGuard}=require('../src/runtime');
const {apiCall,RetryableApiError}=require('../src/agent');

test('a deadline exhausted in the limiter never dispatches an uncertain mutation',async()=>{
 const oldNow=Date.now,oldFetch=global.fetch;let now=1000,calls=0;Date.now=()=>now;global.fetch=async()=>{calls++;throw Error('must not send');};
 try{await assert.rejects(apiCall({key:'test',cmd:'place',args:{item:'towel',where:'room-201'},retryBudgetMs:7000,limiter:{take:async()=>{now+=8000;}}}),RetryableApiError);assert.equal(calls,0);}
 finally{Date.now=oldNow;global.fetch=oldFetch;}
});

test('runtime monitor records real elapsed pause and cleans up exactly once',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wybe-runtime-'));const file=path.join(dir,'events.jsonl');let now=0,tick,cancelled=0;const warnings=[];
 const stop=startRuntimeGuard({file,platform:'linux',now:()=>now,warn:m=>warnings.push(m),schedule:f=>(tick=f,1),cancel:()=>cancelled++});
 try{now=5000;tick();assert.equal(warnings.length,0);now+=98000;tick();assert.match(warnings[0],/98\.0/);stop();stop();assert.equal(cancelled,1);
  const events=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(events.map(e=>e.type),['runtime-start','execution-gap','runtime-stop']);assert.equal(events[1].gapMs,98000);
 }finally{stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Mac runner owns a sleep assertion, warns on battery, and releases its child',()=>{
 const child=new EventEmitter();let killed=0;child.unref=()=>{};child.kill=()=>{killed++;child.emit('exit',0,'SIGTERM');};const warnings=[];let args;
 const stop=startRuntimeGuard({platform:'darwin',warn:m=>warnings.push(m),schedule:()=>1,cancel:()=>{},spawnProcess:(...a)=>(args=a,child),readPower:(cmd,argv,opts,cb)=>cb(null,"Now drawing from 'Battery Power'\n")});
 assert.equal(args[0],'/usr/bin/caffeinate');assert.deepEqual(args[1],['-dimsu','-w',String(process.pid)]);assert.ok(warnings.some(m=>m.includes('bruker batteri')));
 stop();assert.equal(killed,1);assert.equal(warnings.filter(m=>m.includes('stoppet før')).length,0);
});
