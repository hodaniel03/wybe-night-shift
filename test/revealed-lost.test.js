'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Agent, parseRequest} = require('../src/agent');

test('a previously revealed lost item remains collectable when later scans reveal nothing', async () => {
  const a = new Agent({key:'test', shift:'test', log:()=>{}, minGapMs:0});
  const first = {id:'R-001', text:'Guest in 201 lost a wallet, maybe the lobby bar.', atS:0, status:'open', updates:[], task:parseRequest('Guest in 201 lost a wallet, maybe the lobby bar.')};
  const second = {id:'R-002', text:'Guest in 202 lost a wallet, maybe the lobby.', atS:1, status:'open', updates:[], task:parseRequest('Guest in 202 lost a wallet, maybe the lobby.')};
  first.task.places = ['lobby-bar'];
  a.requests.set(first.id,first); a.requests.set(second.id,second);
  const visible = new Map([['lobby-bar',new Set()]]);
  const picked = [], reported = [];
  let scanCount = 0;
  a.goTo = async place => {a.loc=place; return true;};
  a.call = async cmd => {
    if(cmd==='scan') {
      scanCount++;
      // Observed server behavior: scan reveals hidden objects once, then found is empty.
      if(scanCount===1) {visible.get('lobby-bar').add('wallet');visible.get('lobby-bar').add('wallet-2');return {ok:true,result:{found:['wallet','wallet-2']}};}
      return {ok:true,result:{found:[]}};
    }
    if(cmd==='look') return {ok:true,result:{location:a.loc,objects:[...(visible.get(a.loc)||[])]}};
    throw new Error(`Unexpected ${cmd}`);
  };
  a.lookAround = async () => ({location:a.loc,objects:[...(visible.get(a.loc)||[])]});
  a.pickItem = async item => {
    if(!visible.get(a.loc)?.has(item)) return false;
    visible.get(a.loc).delete(item);picked.push(item);a.hands.push(item);return true;
  };
  a.resolveRoom = async req => req.task.room;
  a.knock = async () => ({state:'open'});
  a.placeInRoom = async (room,item) => {a.hands.splice(a.hands.indexOf(item),1);return true;};
  a.finish = async (req,outcome) => {req.status=outcome;reported.push(outcome);};
  await a.handleLost(first);
  a.loc='lobby';
  await a.handleLost(second);
  assert.deepEqual(picked,['wallet','wallet-2']);
  assert.deepEqual(reported,['done','done']);
});

test('a new exact sighting wakes a deferred search even when its location was already scanned',async()=>{
 const a=new Agent({key:'test',shift:'test',log:()=>{},maxSearchLocations:1});a.clock='01:00:00';
 const req={id:'R-001',text:'R-001: 201 lost wallet.',atS:0,at:'22:00:00',status:'open',updates:[],notBefore:20000,searchScanned:['lobby'],task:{type:'lost',room:'room-201',key:'wallet',item:'wallet',places:['lobby']}};
 a.requests.set(req.id,req);a.lostSightings={wallet:{place:'lobby',atS:10800}};
 assert.equal(a.nextRequest(),req);
 const picked=[];a.goTo=async p=>{a.loc=p;return true;};a.call=async(cmd,args)=>cmd==='look'&&!args?{ok:true,result:{objects:['wallet']}}:{ok:true,result:'wallet.'};
 a.pickItem=async item=>{picked.push(item);a.hands.push(item);return true;};a.knock=async()=>({state:'open'});a.placeInRoom=async()=>true;a.finish=async(r,outcome)=>{r.status=outcome;};
 await a.handleLost(req);assert.deepEqual(picked,['wallet']);assert.equal(req.status,'done');
});
