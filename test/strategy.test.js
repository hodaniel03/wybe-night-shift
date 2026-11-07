'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent, parseRequest } = require('../src/agent');

function agent() {
  return new Agent({ key: 'test', shift: 'test', log: () => {}, minGapMs: 0 });
}

function request(text, id = 'R-001') {
  return { id, text, at: '22:00:00', atS: 0, status: 'open', task: parseRequest(text), updates: [] };
}

function captureReports(a) {
  const reports = [];
  a.finish = async (r, outcome, note) => { reports.push({ id: r.id, outcome, note }); r.status = outcome; };
  return reports;
}

test('unstructured delivery and lost requests accept shifted room numbers', () => {
  assert.equal(parseRequest('356 wants a pillow.').room, 'room-356');
  assert.equal(parseRequest('Guest in 278 lost a wallet, maybe the lobby.').room, 'room-278');
});

test('fetch never substitutes another room’s tray and respects room tag boundaries', async () => {
  for (const objects of [['tray-202'], ['tray-2010', 'tray-201']]) {
    const a = agent();
    const req = request('Bring the tray from the kitchen pass to 201.');
    const reports = captureReports(a);
    const picked = [];
    let delivered;
    a.getCart = async () => true;
    a.goTo = async () => true;
    a.call = async () => ({ ok: true, result: { objects } });
    a.pickItem = async (item) => { picked.push(item); return true; };
    a.deliverCarried = async (r, room, items) => { delivered = { room, items }; };
    await a.handle_fetch(req);
    if (objects.length === 1) {
      assert.deepEqual(picked, []);
      assert.equal(reports[0].outcome, 'failed');
    } else {
      assert.deepEqual(picked, ['tray-201']);
      assert.deepEqual(delivered, { room: 'room-201', items: ['tray-201'] });
    }
  }
});

test('lost-item searches reject another owner’s ordinal, even when it is the only match', async () => {
  const a = agent();
  const req = request('Guest in 201 lost a wallet, maybe the lobby bar.');
  a.requests.set(req.id, req);
  const reports = captureReports(a);
  const picked = [];
  a.goTo = async (p) => { a.loc = p; return true; };
  a.call = async () => ({ ok: true, result: { found: ['wallet-2'] } });
  a.pickItem = async (item) => { picked.push(item); return true; };
  await a.handleLost(req);
  assert.deepEqual(picked, []);
  assert.deepEqual(reports, []);
  assert.equal(req.retried, true);
});

test('lost-item searches still return the matching ordinal to its owner', async () => {
  const a = agent();
  const first = request('Guest in 201 lost a wallet, maybe the lobby bar.');
  const req = request('Guest in 202 lost a wallet, maybe the lobby bar.', 'R-002');
  req.atS = 1;
  a.requests.set(first.id, first);
  a.requests.set(req.id, req);
  const reports = captureReports(a);
  const picked = [];
  a.goTo = async (p) => { a.loc = p; return true; };
  a.call = async (cmd) => ({ ok: true, result: cmd === 'scan' ? { found: ['wallet', 'wallet-2'] } : 'wallet-2.' });
  a.pickItem = async (item) => { picked.push(item); a.hands.push(item); return true; };
  a.resolveRoom = async () => 'room-202';
  a.knock = async () => ({ state: 'open' });
  a.placeInRoom = async (room, item) => { assert.equal(room, 'room-202'); assert.equal(item, 'wallet-2'); return true; };
  await a.handleLost(req);
  assert.deepEqual(picked, ['wallet-2']);
  assert.equal(reports[0].outcome, 'done');
});

test('tell completion requires success and a listener response', async () => {
  for (const response of [
    { ok: false, result: 'Cannot say that here.' },
    { ok: true, result: { heard: [] } },
    { ok: true, result: { heard: ['Nobody hears the robot.'] } },
    { ok: true, result: { heard: ['Ms Foss calls back: "Thanks!"'] } },
  ]) {
    const a = agent();
    const reports = captureReports(a);
    a.resolveRoom = async () => 'room-201';
    a.knock = async () => ({ state: 'open' });
    a.call = async () => response;
    await a.handleTell(request('Tell the guest in 201 the taxi is here.'));
    assert.equal(reports[0].outcome, response.result.heard?.[0]?.startsWith('Ms Foss') ? 'done' : 'failed');
  }
});

test('noise handler does not claim completion when speech fails', async () => {
  const a = agent();
  const reports = captureReports(a);
  a.locateRoom = async () => 'corridor-2a';
  a.goTo = async () => true;
  a.lookAround = async () => ({ description: 'Loud music comes from room-201.' });
  a.knock = async () => ({ state: 'open' });
  a.call = async () => ({ ok: false, result: 'Nobody can hear you.' });
  await a.handle_noise(request('Complaint about noise near 201.'));
  assert.equal(reports[0].outcome, 'failed');
});

test('delivery retry resumes after the last confirmed placement', async () => {
  const a = agent();
  const req = request('201 wants a towel and a pillow.');
  const reports = captureReports(a);
  const placements = [];
  const saved = [];
  const collected = [];
  a.cart = [];
  a.resolveRoom = async () => 'room-201';
  a.findSource = async () => 'storage';
  a.collect = async (items) => { collected.push(items); return true; };
  a.knock = async () => ({ state: 'open' });
  a.save = () => saved.push(req.delivered);
  a.placeInRoom = async (room, item) => {
    placements.push(item);
    if (item === 'pillow') throw new Error('simulated crash');
    return true;
  };
  await assert.rejects(a.handleDeliver(req), /simulated crash/);
  assert.equal(req.delivered, 1);
  assert.deepEqual(saved, [1]);
  a.findSource = async (item) => { assert.equal(item, 'pillow'); return 'storage'; };
  a.placeInRoom = async (room, item) => { placements.push(item); return true; };
  await a.handleDeliver(req);
  assert.deepEqual(placements, ['towel', 'pillow', 'pillow']);
  assert.deepEqual(collected[1], ['pillow']);
  assert.equal(req.delivered, 2);
  assert.equal(reports[0].outcome, 'done');
});

test('idle checks actionable work auto-read while walking to the dock', async () => {
  const a = agent();
  a.unread = false;
  a.loc = 'lobby';
  const calls = [];
  a.goTo = async (p) => { a.loc = p; const req = request('201 wants a pillow.'); a.requests.set(req.id, req); return true; };
  a.call = async (cmd) => { calls.push(cmd); return { ok: true }; };
  a.syncStatus = async () => {};
  await a.idle();
  assert.equal(calls.includes('dock'), false);
});

test('idle checks actionable work auto-read by status before docking', async () => {
  const a = agent();
  a.unread = false;
  const calls = [];
  a.call = async (cmd) => { calls.push(cmd); return { ok: true }; };
  a.syncStatus = async () => { const req = request('201 wants a pillow.'); a.requests.set(req.id, req); };
  await a.idle();
  assert.equal(calls.includes('dock'), false);
});

test('lost search yields to a new urgent request and resumes without scanning the same place', async () => {
  const a = agent();
  const req = request('Guest in 201 lost a wallet, maybe the lobby bar.');
  const urgent = request('Tell the guest in 202 the taxi is here.', 'R-002');
  a.requests.set(req.id, req);
  const reports = captureReports(a);
  const scans = [];
  a.goTo = async (p) => { a.loc = p; return true; };
  a.call = async (cmd) => {
    if (cmd === 'scan') {
      scans.push(a.loc);
      if (scans.length === 1) { a.requests.set(urgent.id, urgent); return { ok: true, result: { found: [] } }; }
      return { ok: true, result: { found: ['wallet'] } };
    }
    return { ok: true, result: 'wallet.' };
  };
  a.pickItem = async (item) => { a.hands.push(item); return true; };
  a.resolveRoom = async () => 'room-201';
  a.knock = async () => ({ state: 'open' });
  a.placeInRoom = async () => true;
  await a.handleLost(req);
  assert.equal(scans.length, 1);
  assert.equal(req.searchScanned.length, 1);
  assert.deepEqual(reports, []);
  urgent.status = 'done';
  await a.handleLost(req);
  assert.equal(scans.length, 2);
  assert.notEqual(scans[0], scans[1]);
  assert.equal(reports[0].outcome, 'done');
});

test('leaving cart does not mistake one held towel for two needed towels', async () => {
  const a = agent();
  a.current = request('201 wants two towels.');
  a.hands = ['keycard', 'towel'];
  a.cart = ['towel'];
  let dropped = false;
  a.dropCart = async () => { dropped = true; return true; };
  assert.equal(await a.leaveCart(), false);
  assert.equal(a.hitBlock, true);
  assert.equal(dropped, false);
});

test('fetch and lost confirmed placements report completion without fetching or scanning again', async () => {
  for (const text of ['Bring the tray from the kitchen pass to 201.', 'Guest in 201 lost a wallet, maybe the lobby.']) {
    const a = agent();
    const req = request(text);
    req.deliveryConfirmed = { room: 'room-201', item: req.task.type === 'fetch' ? 'tray-201' : 'wallet' };
    const reports = captureReports(a);
    a.call = async () => { throw new Error('completed delivery must not perform another action'); };
    a.getCart = async () => { throw new Error('completed delivery must not fetch again'); };
    await (req.task.type === 'fetch' ? a.handle_fetch(req) : a.handleLost(req));
    assert.equal(reports[0].outcome, 'done');
  }
});

test('named deliveries persist the resolved room before placing items', async () => {
  const a = agent();
  const req = request('Ms Foss would like a pillow.');
  captureReports(a);
  a.resolveRoom = async () => 'room-201';
  a.findSource = async () => 'storage';
  a.collect = async () => true;
  a.knock = async () => ({ state: 'open' });
  a.placeInRoom = async () => { assert.equal(req.task.room, 'room-201'); return true; };
  await a.handleDeliver(req);
  assert.equal(req.task.room, 'room-201');
});

test('lost retries recover a found item from the parked cart', async () => {
  const a = agent();
  const req = request('Guest in 201 lost a wallet, maybe the lobby.');
  req.found = 'wallet';
  a.requests.set(req.id, req);
  a.cartAt = 'lobby';
  a.parkedCart = ['wallet'];
  let recovered = false;
  a.getCart = async () => { recovered = true; a.cart = a.parkedCart; a.parkedCart = null; a.cartAt = null; return true; };
  a.call = async () => { throw new Error('owned wallet must not be scanned for again'); };
  a.resolveRoom = async () => 'room-201';
  a.knock = async () => ({ state: 'open' });
  a.placeInRoom = async () => true;
  const reports = captureReports(a);
  await a.handleLost(req);
  assert.equal(recovered, true);
  assert.equal(reports[0].outcome, 'done');
});

test('lost searches preserve other item sightings and use the exact known location first', async () => {
  const a = agent();
  const first = request('Guest in 201 lost a wallet, maybe the lobby bar.');
  first.task.places = ['lobby-bar'];
  const second = request('Guest in 202 lost a wallet, maybe the lobby.', 'R-002');
  second.atS = 1;
  a.requests.set(first.id, first);
  a.requests.set(second.id, second);
  const reports = captureReports(a);
  const scans = [];
  const picks = [];
  a.goTo = async (place) => { a.loc = place; return true; };
  a.call = async (cmd) => {
    if (cmd === 'scan') {
      scans.push(a.loc);
      return { ok: true, result: { found: scans.length === 1 ? ['wallet', 'wallet-2', 'glasses'] : ['wallet-2', 'glasses'] } };
    }
    return { ok: true, result: 'item.' };
  };
  a.pickItem = async (item) => { picks.push(item); a.hands.push(item); return true; };
  a.resolveRoom = async (req) => req.task.room;
  a.knock = async () => ({ state: 'open' });
  a.placeInRoom = async (room, item) => { a.hands.splice(a.hands.indexOf(item), 1); return true; };
  await a.handleLost(first);
  assert.deepEqual(scans, ['lobby-bar']);
  assert.equal(a.lostSightings['wallet-2'].place, 'lobby-bar');
  assert.equal(a.lostSightings.glasses.place, 'lobby-bar');
  assert.equal(a.lostSightings.wallet, undefined);
  a.loc = 'lobby'; // the new request's hint is now cheaper than the known item location
  await a.handleLost(second);
  assert.deepEqual(scans, ['lobby-bar', 'lobby-bar']);
  assert.deepEqual(picks, ['wallet', 'wallet-2']);
  assert.equal(a.lostSightings['wallet-2'], undefined);
  assert.equal(a.lostSightings.glasses.place, 'lobby-bar');
  assert.deepEqual(reports.map(r => r.outcome), ['done', 'done']);
});

test('previously revealed lost items visible in look are collected even when scans no longer reveal them', async () => {
  for (const cached of [false, true]) {
    const a = agent();
    const first = request('Guest in 201 lost a wallet, maybe the lobby.');
    first.status = 'done';
    const req = request('Guest in 202 lost a wallet, maybe the lobby bar.', 'R-002');
    req.atS = 1;
    req.task.places = cached ? ['lobby'] : ['lobby-bar'];
    a.requests.set(first.id, first);
    a.requests.set(req.id, req);
    if (cached) a.lostSightings = { 'wallet-2': { place: 'lobby-bar', atS: 0 } };
    const reports = captureReports(a);
    const visits = [];
    const picks = [];
    let scans = 0;
    a.loc = 'lobby';
    a.goTo = async (p) => { visits.push(p); a.loc = p; return true; };
    a.call = async (cmd, args) => {
      if (cmd === 'scan') { scans++; return { ok: true, result: { found: [] } }; }
      if (cmd === 'look' && !args) return { ok: true, result: { objects: a.loc === 'lobby-bar' ? ['wallet-2', 'glasses'] : [] } };
      return { ok: true, result: 'wallet-2.' };
    };
    a.pickItem = async (item) => { picks.push(item); a.hands.push(item); return true; };
    a.resolveRoom = async () => 'room-202';
    a.knock = async () => ({ state: 'open' });
    a.placeInRoom = async () => true;
    await a.handleLost(req);
    assert.equal(visits[0], 'lobby-bar');
    assert.deepEqual(picks, ['wallet-2']);
    assert.equal(scans, 0, 'already visible exact item needs no repeated scan');
    assert.equal(reports[0].outcome, 'done');
    assert.equal(a.lostSightings['wallet-2'], undefined);
    assert.equal(a.lostSightings.glasses.place, 'lobby-bar');
  }
});

test('dropped ordinary supplies rescue a later delivery after storage is exhausted', async () => {
  const a = agent();
  const calls = [];
  a.hands = ['keycard', 'toiletry-kit'];
  a.loc = 'charging-dock';
  a.call = async (cmd, args) => { calls.push({ cmd, args, at: a.loc }); return { ok: true, result: 'Done.' }; };
  await a.dropExtras([]);
  assert.deepEqual(a.hands, ['keycard']);
  assert.deepEqual(a.looseSupplies, { 'toiletry-kit': { 'charging-dock': 1 } });
  a.sources = {};
  a.supplyLooked = { storage: true, laundry: true };
  a.loc = 'lobby';
  a.resolveRoom = async () => 'room-201';
  a.goTo = async (place) => { a.loc = place; return true; };
  a.findSource = async () => { throw new Error('the dropped kit must be recovered before asking for fresh stock'); };
  a.knock = async () => ({ state: 'open' });
  const reports = captureReports(a);
  await a.handleDeliver(request('201 wants a toiletry kit.'));
  assert.equal(reports[0].outcome, 'done');
  assert.deepEqual(calls.filter(x => x.cmd === 'pick').map(x => x.at), ['charging-dock']);
  assert.equal(a.looseSupplies['toiletry-kit'], undefined);
});

test('stale dropped supply locations are invalidated and fresh stock remains a fallback', async () => {
  const a = agent();
  a.hands = ['keycard'];
  a.looseSupplies = { 'toiletry-kit': { 'charging-dock': 2 } };
  const picks = [];
  a.goTo = async (place) => { a.loc = place; return true; };
  a.call = async (cmd, args) => {
    assert.equal(cmd, 'pick');
    picks.push(a.loc);
    return a.loc === 'charging-dock' ? { ok: false, result: 'No toiletry-kit here.' } : { ok: true, result: 'Picked it up.' };
  };
  a.findSource = async () => 'storage';
  assert.equal(await a.collect(['toiletry-kit']), true);
  assert.deepEqual(picks, ['charging-dock', 'storage']);
  assert.equal(a.looseSupplies['toiletry-kit'], undefined);
  assert.equal(a.carrying('toiletry-kit'), 1);
});

test('dropped lost items and heavy objects never enter the ordinary supply cache', async () => {
  const a = agent();
  a.hands = ['wallet', 'tray-201'];
  a.call = async () => ({ ok: true, result: 'Dropped.' });
  await a.dropExtras([]);
  assert.deepEqual(a.looseSupplies || {}, {});
});

test('cart is retained before a heavy payload is picked up when the route becomes blocked', async () => {
  const a = agent();
  a.current = request('Bring the tray from the kitchen pass to 201.');
  a.cart = [];
  a.hands = ['keycard'];
  let dropped = false;
  a.dropCart = async () => { dropped = true; return true; };
  assert.deepEqual(a.neededItems(), [], 'the heavy item has not been picked up yet');
  assert.equal(await a.leaveCart(), false);
  assert.equal(a.hitBlock, true);
  assert.equal(dropped, false);
  assert.deepEqual(a.cart, []);
});

test('floor warnings are checked when leaving a supply room for a corridor', async () => {
  const a = new Agent({key:'test',shift:'test',log:()=>{},prepare:false});
  a.loc='laundry';a.cart=null;a.clock='04:00:00';
  const calls=[];
  a.lookAround=async()=>{calls.push('look');a.lookedAt[a.loc]=21600;return {};};
  a.call=async(cmd,args)=>{calls.push(cmd);return {ok:true,result:{at:args.to}};};
  assert.equal(await a.goTo('corridor-1b'),true);
  assert.deepEqual(calls,['look','move']);
});

test('a nested complaint fulfillment owns cancellation and action journal context', async()=>{
 const a=new Agent({key:'test',shift:'test',log:()=>{}});
 const original={id:'R-001',text:'R-001: 201 wants water.',atS:0,status:'open',updates:[],task:{type:'deliver',room:'room-201',items:[{item:'water-bottle',qty:1}]}};
 const complaint={id:'R-002',text:'Complaint',atS:1,status:'open',updates:[],task:{type:'complaint',room:'room-201',item:'water-bottle'}};
 a.requests.set(original.id,original);a.requests.set(complaint.id,complaint);a.current=complaint;
 a.stashCart=async()=>{};a.handle_deliver=async req=>{assert.equal(a.current,original);req.status='done';};
 a.finish=async(req,outcome)=>{req.status=outcome;};
 await a.handle(complaint);
 assert.equal(a.current,complaint);assert.equal(complaint.status,'done');
});

test('known Do Not Disturb rooms are never entered for empty-room fetches',async()=>{
 const a=new Agent({key:'test',shift:'test',log:()=>{}});a.dnd.add('room-201');
 const req={id:'R-001',task:{type:'fetch',room:'room-201',empty:true,from:'front-desk',what:'bags'},status:'open'};
 let result; a.finish=async(r,outcome)=>{result=outcome;}; a.getCart=async()=>{throw Error('must refuse before fetching');};
 await a.handle_fetch(req);assert.equal(result,'declined');
});

test('closing one passage preserves alternate access to the same corridor and cart',()=>{
 const {edgeKey}=require('../src/agent');const a=new Agent({key:'test',shift:'test',log:()=>{}});a.clock='01:00:00';a.loc='corridor-3a';
 a.blocked[edgeKey('corridor-3a','corridor-3b')]=20000;
 const route=a.plan('corridor-3a','corridor-3b',true);
 assert.ok(route);assert.equal(route.steps[0].to,'corridor-3d');assert.equal(route.steps.at(-1).to,'corridor-3b');
 assert.ok(a.plan('corridor-3b','lobby',true));
});

test('a failed move records the blocked passage instead of making its destination inaccessible',()=>{
 const {edgeKey}=require('../src/agent');const a=new Agent({key:'test',shift:'test',log:()=>{}});a.loc='corridor-2a';a.clock='01:00:00';
 a.absorb('move',{to:'corridor-2b'},{ok:false,clock:'01:00:02',result:'Closed off: a cleaning crew has blocked that corridor.',events:[]});
 assert.ok(a.blocked[edgeKey('corridor-2a','corridor-2b')]);assert.equal(a.blocked['corridor-2b'],undefined);assert.ok(a.plan('corridor-2a','corridor-2b',false));
});

test('legacy whole-corridor checkpoint blocks are re-observed on resume',()=>{
 const {edgeKey}=require('../src/agent');const a=new Agent({key:'test',shift:'test',log:()=>{}});const saved=a.saveState();
 saved.blocked={'corridor-3b':20000,[edgeKey('corridor-2a','corridor-2b')]:20000};a.loadState(saved);
 assert.equal(a.blocked['corridor-3b'],undefined);assert.equal(a.blocked[edgeKey('corridor-2a','corridor-2b')],20000);
});

test('a ground-floor spill invalidates the lobby and supply-room floor checks',()=>{
 const a=new Agent({key:'test',shift:'test',log:()=>{}});a.lookedAt={lobby:1,laundry:1,storage:1,'corridor-1a':1,'corridor-2a':1};
 a.onMessage({from:'night manager',request:'R-001',at:'01:00:00',text:'R-001: Someone mentioned a spill on floor 1.'});
 assert.equal(a.lookedAt.lobby,undefined);assert.equal(a.lookedAt.laundry,undefined);assert.equal(a.lookedAt.storage,undefined);assert.equal(a.lookedAt['corridor-1a'],undefined);assert.equal(a.lookedAt['corridor-2a'],1);
});
