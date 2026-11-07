'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Agent}=require('../src/agent');const {applyPolicy}=require('../src/policy');const {parseArgs,readManifest}=require('../run');
const make=()=>new Agent({key:'test',shift:'same-shift',log:()=>{}});

test('new runs use the validated policy and explicit rollback remains available',()=>{
 assert.equal(parseArgs([]).strategy,'efficient');assert.equal(parseArgs(['--strategy','baseline']).strategy,'baseline');
 assert.throws(()=>parseArgs(['--strategy','experimental']));
 const a=applyPolicy(make(),'efficient');assert.equal(a.maxSearchLocations,3);assert.equal(a.finishOnRemainingBattery,true);
 assert.equal(a.saveState().strategy,'efficient');assert.equal(applyPolicy(make(),'baseline').saveState().strategy,'baseline');
});

test('policy checkpoint preserves the idle stocking budget and request ownership across resume',()=>{
 const a=applyPolicy(make(),'efficient');a._stockedPicks=17;a.requests.set('R-001',{id:'R-001',status:'open',task:{type:'fetch'},expectedFetch:'tray-201',picked:'tray-201'});
 const saved=a.saveState(),b=applyPolicy(make(),saved.strategy);b.loadState(saved);
 assert.equal(b._stockedPicks,17);assert.equal(b.policyName,'efficient');assert.equal(b.requests.get('R-001').picked,'tray-201');
});

test('manifest retains the chosen policy and treats pre-policy runs as baseline',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wybe-policy-'));const file=path.join(dir,'manifest.json');
 try{for(const strategy of ['efficient','baseline',undefined]){fs.writeFileSync(file,JSON.stringify({version:2,mode:'practice',strategy,shifts:[{shift:'same-shift'}]}));assert.equal(readManifest(file).strategy,strategy||'baseline');}}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
