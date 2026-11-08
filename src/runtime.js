'use strict';
const fs=require('node:fs');
const {spawn,execFile}=require('node:child_process');

// Sleep pauses JavaScript itself. A guard can report the gap after wake, but
// cannot execute actions while the lid has put the laptop to sleep.
function startRuntimeGuard({file,now=Date.now,warn=console.error,platform=process.platform,
  spawnProcess=spawn,readPower=execFile,schedule=setInterval,cancel=clearInterval,
  intervalMs=5000,pauseLimitMs=15000}={}) {
 let stopped=false,child=null,last=now();
 const record=(type,details={},message)=>{
  const event={at:new Date(now()).toISOString(),type,...details};
  if(file)try{fs.appendFileSync(file,JSON.stringify(event)+'\n',{mode:0o600});}catch(e){warn(`Runtime-logg kunne ikke skrives: ${e.message}`);}
  if(message)warn(`[${event.at}] ${message}`);
 };
 record('runtime-start',{pid:process.pid,platform});
 const timer=schedule(()=>{
  const current=now(),gap=current-last;last=current;
  if(gap>pauseLimitMs)record('execution-gap',{gapMs:gap},`PAUSE: programmet fikk ikke kjøretid på ${(gap/1000).toFixed(1)} s. Mulig dvale eller prosesspause; sjekk strøm og åpent lokk.`);
 },intervalMs);
 if(timer&&typeof timer.unref==='function')timer.unref();
 if(platform==='darwin'){
  record('power-guidance',{},'Hold Mac-en på strøm med lokket åpent. Dvalesperren kan ikke garantere kjøring med lukket lokk.');
  try{
   child=spawnProcess('/usr/bin/caffeinate',['-dimsu','-w',String(process.pid)],{stdio:'ignore'});
   child.once('error',e=>record('keep-awake-error',{message:e.message},`Dvalesperren kunne ikke startes: ${e.message}`));
   child.once('exit',(code,signal)=>{if(!stopped)record('keep-awake-exit',{code,signal},'Dvalesperren stoppet før agenten var ferdig.');});
   if(typeof child.unref==='function')child.unref();
  }catch(e){record('keep-awake-error',{message:e.message},`Dvalesperren kunne ikke startes: ${e.message}`);}
  readPower('/usr/bin/pmset',['-g','batt'],{timeout:1500},(error,stdout)=>{
   if(stopped)return;
   if(error){record('power-check-unavailable',{message:error.message});return;}
   const source=/Now drawing from '([^']+)'/.exec(stdout||'')?.[1]||'unknown';
   record('power-source',{source},source==='Battery Power'?'Mac-en bruker batteri. Koble til strøm og hold lokket åpent under skiftet.':undefined);
  });
 }
 const stop=()=>{
  if(stopped)return;stopped=true;cancel(timer);
  if(child)try{child.kill();}catch{}
  record('runtime-stop');process.off('exit',stop);
 };
 process.once('exit',stop);
 return stop;
}
module.exports={startRuntimeGuard};
