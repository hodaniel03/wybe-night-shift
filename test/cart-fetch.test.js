'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Agent, parseRequest}=require('../src/agent');
const make=()=>new Agent({key:'test',shift:'test',log:()=>{},minGapMs:0});
const req=(id,text)=>({id,task:parseRequest(text),status:'open',text,atS:0});

test('a full cart frees one spare supply, preserves it for reuse, then picks the requested bag',async()=>{
 const a=make();a.loc='front-desk';a.hands=['keycard'];a.cart=['towel','water-bottle'];const calls=[];
 a.current=req('R-001','Take the bags at the desk up to 201. The room is empty, the guest checks in later.');
 let full=true;a.call=async(cmd,args)=>{calls.push([cmd,args.item]);if(cmd==='drop'){full=false;return{ok:true};}return full?{ok:false,result:'The cart is full.'}:{ok:true,result:'Picked up luggage-201, in the cart.'};};
 assert.equal(await a.pickItem('luggage-201'),true);
 assert.deepEqual(calls,[['pick','luggage-201'],['drop','towel'],['pick','luggage-201']]);
 assert.deepEqual(a.cart,['water-bottle','luggage-201']);assert.equal(a.looseSupplies.towel['front-desk'],1);
 const b=make();b.loadState(a.saveState());assert.equal(b.looseSupplies.towel['front-desk'],1);
});

test('full-cart recovery preserves current delivery items, keycard and guest property',async()=>{
 const a=make();a.cart=['keycard','towel','wallet','luggage-201'];a.current=req('R-002','202 wants a towel.');
 a.call=async(cmd)=>{assert.equal(cmd,'pick');return{ok:false,result:'The cart is full.'};};
 assert.equal(await a.pickItem('water-bottle'),false);assert.deepEqual(a.cart,['keycard','towel','wallet','luggage-201']);
});

test('a lost pickup reply is never treated as a capacity rejection',async()=>{
 const a=make();a.cart=['towel'];let calls=0;a.call=async()=>{calls++;throw Error('uncertain transport');};
 await assert.rejects(a.pickItem('luggage-201'),/uncertain/);assert.equal(calls,1);assert.deepEqual(a.cart,['towel']);
});

test('repeat room-service orders reject the older order even after pickup failed and resume',()=>{
 const a=make();const old=req('R-025','Bring the tray from the kitchen pass to 205.');old.expectedFetch='tray-205';old.status='failed';a.requests.set(old.id,old);
 const b=make();b.loadState(a.saveState());const next=req('R-052','Bring the tray from the kitchen pass to 205.');
 assert.equal(b.selectFetchItem(next,['tray-205','tray-205-8'],'tray','205'),'tray-205-8');
 assert.equal(b.selectFetchItem(next,['tray-205'],'tray','205'),null);
});

test('luggage request tag selects the new bags among several older orders',()=>{
 const a=make(),r=req('R-054','Take the bags at the desk up to 203. The room is empty, the guest checks in later.');
 assert.equal(a.selectFetchItem(r,['luggage-203-19','luggage-203-21','luggage-203-54'],'luggage','203'),'luggage-203-54');
 assert.equal(a.selectFetchItem(r,['luggage-203-19','luggage-203-21'],'luggage','203'),null);
 r.expectedFetch='luggage-203-54';assert.equal(a.selectFetchItem(r,['luggage-203-19'],'luggage','203'),null);
});

test('ambiguous trays are not guessed and room boundaries remain exact',()=>{
 const a=make(),r=req('R-010','Bring the tray from the kitchen pass to 201.');
 assert.equal(a.selectFetchItem(r,['tray-201','tray-201-2'],'tray','201'),null);
 assert.equal(a.selectFetchItem(r,['tray-2010','tray-201'],'tray','201'),'tray-201');
});
