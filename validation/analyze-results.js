#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
function sec(clock) { if (!clock) return null; const [h,m,s=0]=clock.split(':').map(Number); return ((h-22+24)%24)*3600+m*60+s; }
function analyze(file) {
 const summary=JSON.parse(fs.readFileSync(file,'utf8')); const stem=file.replace(/\.summary\.json$/,'');
 const requests=new Map((summary.requests||[]).map(r=>[r.id,{...r,activeSeconds:0,attempts:0}]));
 let active=null,start=0;
 function close(at) { if(active&&requests.has(active)) requests.get(active).activeSeconds+=Math.max(0,at-start);active=null; }
 for(const line of fs.readFileSync(stem+'.log','utf8').split(/\r?\n/)) {
  const m=/^(\d\d:\d\d:\d\d) (.*)$/.exec(line);if(!m)continue;const at=sec(m[1]),body=m[2];
  const begin=/^HANDLE (R-\d+) /.exec(body);if(begin){close(at);active=begin[1];start=at;const r=requests.get(active);if(r)r.attempts++;continue;}
  const end=/^(?:REPORT|DEFER|RETRY LATER|YIELD|CANCELLED) (R-\d+)\b/.exec(body);if(end&&end[1]===active)close(at);
  if(/^SHIFT OVER|^LOW BATTERY|^DOCK /.test(body))close(at);
 }
 close(sec(summary.clock)||8*3600);
 if(fs.existsSync(stem+'.trace.json'))for(const r of JSON.parse(fs.readFileSync(stem+'.trace.json','utf8'))){
  if(r.cmd==='inbox')for(const m of r.result?.messages||[]){const q=requests.get(m.request);if(q&&q.arrivalSeconds===undefined){q.arrivalSeconds=sec(m.at);q.message=m.text;}}
  if(r.cmd==='report'){const q=requests.get(r.args?.request);if(q){q.reportSeconds=sec(r.clock);q.latencySeconds=q.reportSeconds-q.arrivalSeconds;}}
 }
 return {file,score:summary.score,seed:summary.seed ?? Number(path.basename(file).match(/^seed(\d+)/)?.[1]),requests:[...requests.values()]};
}
function discover(input) {const s=fs.statSync(input);return s.isDirectory()?fs.readdirSync(input).filter(f=>f.endsWith('.summary.json')).map(f=>path.join(input,f)):[input];}
function summarize(runs) {
 const types={};for(const run of runs)for(const r of run.requests){const t=types[r.type] ||= {type:r.type,total:0,done:0,points:0,activeSeconds:0,donePoints:0,doneSeconds:0,failedSeconds:0,attempts:0};t.total++;t.done+=r.status==='done';t.points+=r.points||0;t.activeSeconds+=r.activeSeconds;t.attempts+=r.attempts;if(r.status==='done'){t.donePoints+=r.points||0;t.doneSeconds+=r.activeSeconds;}else t.failedSeconds+=r.activeSeconds;}
 return Object.values(types).map(t=>({...t,meanDonePoints:t.donePoints/Math.max(1,t.done),meanDoneMinutes:t.doneSeconds/60/Math.max(1,t.done),donePointsPerMinute:t.donePoints/(t.doneSeconds/60||1),overallPointsPerMinute:t.points/(t.activeSeconds/60||1),failedMinutes:t.failedSeconds/60})).sort((a,b)=>b.overallPointsPerMinute-a.overallPointsPerMinute);
}
if(require.main===module){const args=process.argv.slice(2);const json=args.includes('--json');const inputs=args.filter(a=>a!=='--json');const files=inputs.flatMap(discover);const runs=files.map(analyze);const types=summarize(runs);if(json)console.log(JSON.stringify({runs,types},null,2));else{console.table(types.map(t=>({type:t.type,total:t.total,done:t.done,meanPts:+t.meanDonePoints.toFixed(1),doneMin:+t.meanDoneMinutes.toFixed(2),ptsPerMin:+t.overallPointsPerMinute.toFixed(2),wastedMin:+t.failedMinutes.toFixed(1)})));const slow=runs.flatMap(run=>run.requests.map(r=>({seed:run.seed,file:run.file,id:r.id,type:r.type,status:r.status,points:r.points||0,minutes:+(r.activeSeconds/60).toFixed(2),attempts:r.attempts,text:r.text}))).sort((a,b)=>b.minutes-a.minutes);console.table(slow.slice(0,20));}}
module.exports={analyze,summarize};
