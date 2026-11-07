'use strict';

// Experimental practice-only policies. This module does not start shifts or edit
// the production Agent prototype. Apply configure(agent, { name }) to one instance.
const SUPPLIES = new Set(['towel', 'pillow', 'water-bottle', 'phone-charger', 'toiletry-kit', 'wet-floor-sign']);
const PRESETS = {
  value: { scheduling: true, maxSearchLocations: 3, maxExplorationDefers: 1 },
  value_scout: { scheduling: true, maxSearchLocations: 3, maxExplorationDefers: 1, readStaffNote: true, readManual: true },
  targeted: { scheduling: true, maxSearchLocations: 3, targetedNoise: true },
  batch: { scheduling: true, prefetch: true, forceBatchCart: true, maxPrefetch: 6 },
  batch3: { scheduling: true, prefetch: true, forceBatchCart: true, maxPrefetch: 6, maxSearchLocations: 3, maxExplorationDefers: 1 },
  stocked: { scheduling: true, prefetch: true, forceBatchCart: true, maxPrefetch: 6, maxSearchLocations: 3, maxExplorationDefers: 1, restock: true },
  efficient: { scheduling: true, prefetch: true, forceBatchCart: true, maxPrefetch: 6, maxSearchLocations: 3, maxExplorationDefers: 1, restock: true, finishOnRemainingBattery: true, managerLookup: true, heavyBatch: true, clarifySpills: true },
  endgame: { scheduling: true, prefetch: true, forceBatchCart: true, maxPrefetch: 6, maxSearchLocations: 3, maxExplorationDefers: 1, restock: true, finishOnRemainingBattery: true },
  coverage: { scheduling: true, prefetch: true, forceBatchCart: true, maxPrefetch: 6, maxSearchLocations: 3, maxExplorationDefers: 1, restock: true, expandLostRetry: true },
  cover_spills: { scheduling: true, prefetch: true, forceBatchCart: true, maxPrefetch: 6, maxSearchLocations: 3, maxExplorationDefers: 1, restock: true, coverSpills: true },
  balanced: { scheduling: true, prefetch: true, forceBatchCart: true, maxPrefetch: 6, maxSearchLocations: 4, maxExplorationDefers: 2, lowBattery: 10, chargeTo: 26 },
};

function seconds(clock) {
  const [h, m, s = 0] = String(clock || '22:00:00').split(':').map(Number);
  return ((h < 12 ? h + 24 : h) - 22) * 3600 + m * 60 + s;
}

function roomFor(agent, req) { return req.task.room || (req.task.name && agent.roomOf[req.task.name]) || null; }
function remainingItems(req) {
  return (req.task.items || []).flatMap(({ item, qty }) => Array(Math.max(0, Math.min(20, qty))).fill(item)).slice(req.delivered || 0);
}

function travel(agent, from, to) {
  if (!from || !to) return 180;
  if (from === to) return 0;
  const path = agent.plan(from, to, agent.cart !== null);
  return path ? path.cost : Infinity;
}

function availableSource(agent, item) {
  const candidates = [];
  if (agent.sources[item]) candidates.push(agent.sources[item]);
  if ((agent.parkedCart || []).includes(item) && agent.cartAt) candidates.push(agent.cartAt);
  for (const [place, n] of Object.entries((agent.looseSupplies && agent.looseSupplies[item]) || {})) if (n > 0) candidates.push(place);
  candidates.sort((a, b) => travel(agent, agent.loc, a) - travel(agent, agent.loc, b));
  return candidates[0] || 'storage';
}

function estimate(agent, req) {
  const t = req.task;
  const age = Math.max(0, seconds(agent.clock) - (req.atS || 0)) / 60;
  const room = roomFor(agent, req);
  const destination = room ? agent.corridorOf(room) : 'front-desk';
  let service = 50, base = 40, decay = 1, probability = 1;
  let route = travel(agent, agent.loc, destination);
  if (!room && t.name) { route += 150; service += 30; }
  if (req.pendingReport || req.deliveryConfirmed) return { value: 5, minutes: 0.05, priority: 1000 };
  if (t.type === 'complaint') return { value: 5, minutes: 0.05, priority: 1000 };
  if (t.type === 'tell') {
    service = 20; base = 33;
    if (/taxi|is here|waiting|right away|urgent|asap|\bnow\b/i.test(req.text)) { base = 38; decay = 7; }
  } else if (t.type === 'inspect') { service = 50; base = 46; }
  else if (t.type === 'noise') { service = 55; base = 44; probability = req.defers ? 0.45 : 0.95; }
  else if (t.type === 'deliver') {
    const items = remainingItems(req);
    const need = new Map();
    for (const item of items) need.set(item, (need.get(item) || 0) + 1);
    const missing = [...need].filter(([item, count]) => agent.carrying(item) < count).map(([item]) => item);
    service = 15 + items.length * 20;
    base = 35; // observed rewards are per request; extra items increase service time
    if (missing.length) {
      const source = availableSource(agent, missing[0]);
      route = travel(agent, agent.loc, source) + travel(agent, source, destination);
      if (new Set(missing.map(item => availableSource(agent, item))).size > 1) route += 90;
    } else service = 15 + items.length * 10;
  } else if (t.type === 'fetch') {
    base = t.empty ? 65 : 44;
    service = t.empty ? 30 : 35;
    if (!req.picked || !agent.carrying(req.picked)) route = travel(agent, agent.loc, t.from) + travel(agent, t.from, destination);
    if (agent.cart === null) {
      const cartPlace = agent.cartAt || 'laundry';
      route = travel(agent, agent.loc, cartPlace) + travel(agent, cartPlace, req.picked ? destination : t.from) + (!req.picked ? travel(agent, t.from, destination) : 0);
      service += 10;
    }
    if (/tray|food|room service|dinner|breakfast/i.test(`${t.what || ''} ${req.text}`)) decay = 3;
  } else if (t.type === 'lost') {
    base = 66;
    const expected = agent.expectedLostItem ? agent.expectedLostItem(req) : t.key || t.item;
    const seen = agent.lostSightings && agent.lostSightings[expected];
    if (req.found && agent.carrying(req.found)) service = 30;
    else if (seen) { route = travel(agent, agent.loc, seen.place) + travel(agent, seen.place, destination); service = 45; }
    else {
      const first = (t.places || [])[0] || 'lobby';
      route = travel(agent, agent.loc, first) + travel(agent, first, destination);
      service = 65 * Math.min(agent.maxSearchLocations || 10, 5) + 60;
      probability = req.retried ? 0.3 : 0.65;
    }
  } else if (t.type === 'spill') {
    base = 75; service = 210;
    route = travel(agent, agent.loc, agent.target(req));
    probability = req.defers ? 0.6 : 0.9;
  } else { return { value: 0, minutes: 1, priority: -10 }; }
  const minutes = Math.max(0.35, (route + service) / 60);
  const value = Math.max(5, base - decay * (age + minutes)) * probability;
  const retryPenalty = req.defers ? 0.7 : 1;
  return { value, minutes, priority: retryPenalty * value / minutes + Math.min(5, age * 0.08) };
}

function eligible(agent, req, now) {
  if (req.cancelRequested) return false;
  const knownLost = req.task.type === 'lost' && agent.lostSightings && agent.lostSightings[agent.expectedLostItem(req)];
  if (req.notBefore > now && !knownLost) return false;
  if (req.needsAnswer && req.asked && !req.answered && now - req.askedAtS < 180) return false;
  const room = roomFor(agent, req);
  const needsRoom = ['deliver', 'tell', 'inspect', 'noise', 'fetch', 'lost'].includes(req.task.type);
  const corridor = room && agent.corridorOf(room);
  if (needsRoom && corridor && !agent.plan(agent.loc, agent.target(req), false)) return false;
  return true;
}

function batchCandidates(agent, req) {
  const room = roomFor(agent, req);
  if (!room) return [];
  const floor = room.slice(5, 6);
  const now = seconds(agent.clock);
  return agent.openRequests().filter(q => q !== req && q.task.type === 'deliver' && eligible(agent, q, now)
    && roomFor(agent, q)?.slice(5, 6) === floor && !agent.dnd.has(roomFor(agent, q)))
    .sort((a, b) => travel(agent, agent.target(req), agent.target(a)) - travel(agent, agent.target(req), agent.target(b)));
}

async function targetedNoise(req) {
  const now = seconds(this.clock);
  const search = req.noiseSearch || { quiet: [], unreachable: [] };
  const quiet = new Set(search.quiet);
  const pending = new Set(search.unreachable);
  let candidates;
  if (req.noiseSearch) {
    // A quiet corridor does not need to be inspected again just because a
    // different corridor was closed. Keep only the places we could not inspect.
    candidates = [...pending].filter(place => this.plan(this.loc, place, false));
  } else {
    const corridor = await this.locateRoom(req.task.room);
    if (!corridor) return this.finish(req, 'failed', `Could not find ${req.task.room}.`);
    const floor = corridor.slice(9, 10);
    candidates = [corridor, ...Object.keys(this.g).filter(place => place !== corridor && new RegExp(`^corridor-${floor}[a-z]$`).test(place))];
    for (const place of candidates) pending.add(place);
  }
  req.noiseSearch = search;
  while (candidates.length) {
    candidates.sort((a, b) => travel(this, this.loc, a) - travel(this, this.loc, b));
    const corridor = candidates.shift();
    if (!(await this.goTo(corridor))) continue;
    const look = await this.lookAround();
    const desc = look.description || '';
    const source = desc.match(/(room-\d{3})/);
    if (source && /music|noise|loud|party|shout|bang|thump|laugh/i.test(desc)) {
      const room = source[1];
      const knock = await this.knock(room);
      if (knock.state !== 'open') { this.hitBlock = false; return this.finish(req, 'failed', `Noise comes from ${room} but nobody opened (${knock.text || knock.state}).`); }
      const said = await this.call('say', { text: 'Good evening. Sorry to disturb you, but other guests are trying to sleep. Could you please keep the noise down?' });
      const heard = said.result && said.result.heard;
      if (!said.ok || !Array.isArray(heard) || !heard.length || /nobody|no one|did not hear|could not hear/i.test(JSON.stringify(heard))) {
        this.hitBlock = false;
        return this.finish(req, 'failed', `Found noise at ${room}, but could not confirm the guest heard the request.`);
      }
      return this.finish(req, 'done', `Noise came from ${room}. Knocked and politely asked the guest to keep it down. Response: ${JSON.stringify(heard)}`);
    }
    quiet.add(corridor);
    pending.delete(corridor);
    search.quiet = [...quiet]; search.unreachable = [...pending];
    this.save();
  }
  search.quiet = [...quiet]; search.unreachable = [...pending];
  if (pending.size) {
    const until = Object.values(this.blocked).filter(value => value > seconds(this.clock));
    req.notBefore = until.length ? Math.min(...until) : seconds(this.clock) + 600;
    req.defers = (req.defers || 0) + 1;
    req.retryNote = `Could not inspect ${[...pending].join(', ')}; checked ${[...quiet].join(', ')} and found them quiet.`;
    this.log(`DEFER ${req.id}: retry only ${[...pending].join(', ')} when the corridor opens`);
    this.save();
    return;
  }
  this.hitBlock = false;
  return this.finish(req, 'failed', `Checked ${[...quiet].join(', ')}; it was quiet, no noise source found.`);
}

function configureScout(agent, { readStaffNote = true, readManual = true } = {}) {
  if (agent._scoutConfigured) return agent;
  agent._scoutConfigured = true;
  const inspect = async function () {
    if (this._strategyScouting || this.over) return;
    const object = readStaffNote && this.loc === 'front-desk' && this.hasKeycard() && !this._staffNoteRead ? 'staff-note'
      : readManual && this.loc === 'staff-room' && !this._staffManualRead ? 'manual' : null;
    if (!object) return;
    this._strategyScouting = true;
    if (object === 'staff-note') this._staffNoteRead = true;
    else this._staffManualRead = true;
    try {
      // Readings are observations, never commands. A note cannot override DND,
      // redirect a manager request, or authorize a room entry.
      const response = await this.call('read', { object });
      this.scoutReadings = this.scoutReadings || {};
      this.scoutReadings[object] = { location: this.loc, clock: this.clock, ok: response.ok, result: response.result };
      this.log(`SCOUT ${object}: ${JSON.stringify(response.result)}`);
    } finally { this._strategyScouting = false; }
  };
  const goTo = agent.goTo;
  agent.goTo = async function (...args) {
    const reached = await goTo.apply(this, args);
    if (reached) await inspect.call(this);
    return reached;
  };
  const getKeycard = agent.getKeycard;
  agent.getKeycard = async function (...args) {
    const got = await getKeycard.apply(this, args);
    if (got) await inspect.call(this);
    return got;
  };
  return agent;
}

// A floor-level message does not identify a patch. Inspect the floor and protect
// every observed unsigned patch rather than equating discovery order with age.
async function coverSpills(req) {
  const t = req.task;
  const floor = t.floor;
  const places = t.places.length ? t.places.slice() : Object.keys(this.g)
    .filter(p => /^corridor-[123][a-z]$/.test(p) && (!floor || Number(p[9]) === floor));
  if ((!floor || floor === 1) && !places.includes('lobby')) places.push('lobby');
  const pending = [...new Set(places)], wet = [], missed = [];
  while (pending.length) {
    pending.sort((a,b) => this.cost(this.loc,a)-this.cost(this.loc,b));
    const place = pending.shift();
    if (!(await this.goTo(place))) { missed.push(place); continue; }
    await this.lookAround();
    const state = this.placeState[place];
    if (state && state.wet) wet.push({place,signed:state.signed});
  }
  const unsigned = wet.filter(p=>!p.signed);
  if (!unsigned.length) return this.finish(req, missed.length ? 'failed' : 'declined',
    `Checked the accessible floor: ${wet.length ? 'observed wet patches already have signs' : 'no wet patches found'}.${missed.length ? ` Could not inspect ${missed.join(', ')}.` : ''}`);
  // Collect in one trip when possible. Partial collection is still usable.
  await this.collect(unsigned.map(()=> 'wet-floor-sign'));
  const protectedPlaces = wet.filter(p=>p.signed).map(p=>p.place);
  while (unsigned.length) {
    unsigned.sort((a,b)=>this.cost(this.loc,a.place)-this.cost(this.loc,b.place));
    const {place} = unsigned.shift();
    if (!this.carrying('wet-floor-sign')) {
      // Reuse an older sign only outside the floor being secured.
      const prior = this.signsPlaced.filter(s=>!wet.some(w=>w.place===s.place))
        .sort((a,b)=>(this.cost(this.loc,a.place)+this.cost(a.place,place))-(this.cost(this.loc,b.place)+this.cost(b.place,place)));
      for (const old of prior) {
        if (!(await this.goTo(old.place))) continue;
        if (!(await this.pickItem('wet-floor-sign'))) continue;
        this.signsPlaced = this.signsPlaced.filter(s=>s.place!==old.place);
        if (this.placeState[old.place]) this.placeState[old.place].signed = false;
        break;
      }
    }
    if (!this.carrying('wet-floor-sign') || !(await this.goTo(place))) { missed.push(place); continue; }
    const result = await this.call('place',{item:'wet-floor-sign',where:place});
    if (!result.ok) { missed.push(place); continue; }
    const hand = this.hands.indexOf('wet-floor-sign');
    if (hand>=0) this.hands.splice(hand,1);
    else if (this.cart) { const i=this.cart.indexOf('wet-floor-sign'); if(i>=0)this.cart.splice(i,1); }
    this.signsPlaced.push({place,atS:seconds(this.clock)});
    this.placeState[place]={wet:true,signed:true,atS:seconds(this.clock)};
    protectedPlaces.push(place);this.save();
  }
  return this.finish(req,missed.length?'failed':'done',
    `Inspected floor ${floor||'?'} and protected wet patches at ${protectedPlaces.join(', ') || 'none'}.${missed.length ? ` Could not secure or inspect ${missed.join(', ')}.` : ''}`);
}

function configureStocked(agent) {
  const reserve = {'towel':2, 'water-bottle':2, pillow:1, 'toiletry-kit':1, 'phone-charger':1, 'wet-floor-sign':1};
  const idle = agent.idle, saveState = agent.saveState, loadState = agent.loadState;
  agent.saveState = function () {
    const state = saveState.call(this);
    return {...state, strategyState:{...(state.strategyState || {}), stockedPicks:this._stockedPicks || 0}};
  };
  agent.loadState = function (state) {
    const result = loadState.call(this, state);
    if (result) this._stockedPicks = (state.strategyState && state.strategyState.stockedPicks) || 0;
    return result;
  };
  agent.idle = async function () {
    if (this.nextRequest()) return;
    const now = seconds(this.clock);
    const ground = !/^room-|^(?:corridor-|elevator-|stairwell-)[23]/.test(this.loc);
    if (this.battery < 75 || now > 6*3600 || !ground || (this._stockedPicks || 0) >= 30 || this.cartStuck) return idle.call(this);
    // Observed capacity is eight cart items. Reserve two slots for incoming
    // trays/bags; a full speculative cart caused four missed jobs on seed 22.
    if ((this.cart || this.parkedCart || []).length >= 6) return idle.call(this);
    const available = item => this.carrying(item) + (this.cart === null ? (this.parkedCart || []).filter(x => x === item).length : 0);
    const missing = Object.entries(reserve).filter(([item, count]) => available(item) < count && this.sources[item]);
    if (!missing.length) return idle.call(this);
    if (this.cart === null) {
      if (this.cartAt && /^(?:corridor-|elevator-|stairwell-)[23]/.test(this.cartAt)) return idle.call(this);
      if (!(await this.getCart())) return idle.call(this);
      return; // re-evaluate new manager messages before choosing a supply trip
    }
    missing.sort((a,b) => travel(this,this.loc,this.sources[a[0]])-travel(this,this.loc,this.sources[b[0]]));
    const item = missing[0][0], source = this.sources[item];
    if (source !== this.loc) {
      const plan = this.plan(this.loc,source,true);
      if (!plan || !plan.steps.length) return idle.call(this);
      await this.goTo(plan.steps[0].to); // at most one route segment before checking new work
      return;
    }
    if (this.nextRequest()) return;
    if (await this.pickItem(item)) {
      this._stockedPicks = (this._stockedPicks || 0) + 1;
      this.log(`RESTOCK: reserved ${item} during idle time (${this._stockedPicks}/30 pickups)`);
    } else {
      if (this.sources[item] === source) delete this.sources[item];
      this.supplyLooked[source] = false;
      await this.lookAround();
    }
    this.save();
  };
  return agent;
}

function configure(agent, options = {}) {
  if (typeof options === 'string') options = { name: options };
  const name = options.name || 'balanced';
  if (!PRESETS[name]) throw new Error(`Unknown strategy variant: ${name}`);
  const policy = { ...PRESETS[name], ...options };
  if (agent.strategyVariant) throw new Error('An agent can have only one experimental strategy variant');
  agent.strategyVariant = name;
  for (const key of ['maxSearchLocations', 'lowBattery', 'chargeTo']) if (policy[key] !== undefined) agent[key] = policy[key];
  if (policy.scheduling) agent.nextRequest = function () {
    const now = seconds(this.clock);
    const open = this.openRequests().filter(r => eligible(this, r, now));
    open.sort((a, b) => estimate(this, b).priority - estimate(this, a).priority || a.atS - b.atS);
    if (policy.finishOnRemainingBattery && now >= 7*3600) {
      const feasible = open.find(r => this.batteryOk(r));
      if (feasible) return feasible;
    }
    return open[0] || null;
  };
  if (policy.maxExplorationDefers !== undefined) {
    const finish = agent.finish;
    agent.finish = async function (req, outcome, note) {
      if (outcome === 'failed' && ['noise', 'lost', 'spill'].includes(req.task.type) && (req.defers || 0) >= policy.maxExplorationDefers) {
        this.hitBlock = false;
      }
      return finish.call(this, req, outcome, note);
    };
  }
  if (policy.restock) configureStocked(agent);
  if (policy.coverSpills) agent.handle_spill = coverSpills;
  if (policy.expandLostRetry) agent.expandLostRetry = true;
  if (policy.finishOnRemainingBattery) agent.finishOnRemainingBattery = true;
  if (policy.clarifySpills) {
    const handleSpill = agent.handle_spill;
    agent.handle_spill = async function (req) {
      if (!req.task.places.length && !req.spillClarificationAsked && !this._spillClarificationUnavailable) {
        req.spillClarificationAsked = true;this.save();
        const reply = await this.call('reply',{request:req.id,text:'Which corridor or exact location is the spill in?'});
        const text = JSON.stringify(reply.result || '');
        const places = [...new Set(text.match(/corridor-[123][a-z]|\blobby\b/g)||[])];
        const compatible = places.filter(p=>!req.task.floor || (p==='lobby'?1:Number(p[9]))===req.task.floor);
        if (reply.ok && places.length===1 && compatible.length===1) {req.task.places=compatible;this.save();}
        else this._spillClarificationUnavailable=true;
        this.log(`SPILL CLARIFICATION ${req.id}: ${text}`);
      }
      return handleSpill.call(this,req);
    };
  }
  if (policy.heavyBatch) {
    const pickItem = agent.pickItem;
    agent.pickItem = async function (item) {
      const req = this.current;
      const ok = await pickItem.call(this,item);
      if (!ok || this._heavyBatch || !req || req.task.type !== 'fetch' || !/^(tray|luggage|bag|suitcase)-/.test(item)
        || this.cart === null || this.loc !== req.task.from || this.cart.length >= 7) return ok;
      // Make the primary pickup durable before starting another request's pickup.
      req.picked = item; this.save();
      const room = roomFor(this,req);
      const pending = this.openRequests().filter(r=>r!==req && r.task.type==='fetch' && !r.cancelRequested
        && !r.picked && !(r.notBefore>seconds(this.clock)) && r.task.from===this.loc
        && roomFor(this,r) && room && roomFor(this,r)[5]===room[5] && !this.dnd.has(roomFor(this,r))
        && this.plan(this.loc,this.corridorOf(roomFor(this,r)),true)).slice(0,2);
      if (!pending.length) return ok;
      this._heavyBatch = true;
      try {
        const looked = await this.call('look');
        const objects = ((looked.result && looked.result.objects)||[]).map(o=>String(o).replace(/\s+x\d+$/,''));
        for (const other of pending) {
          if (this.cart.length >= 7 || req.cancelRequested || other.cancelRequested) break;
          const destination = roomFor(this,other);
          const prefix = /tray|room service/i.test(other.task.what||'') ? 'tray' : 'luggage';
          const name = this.selectFetchItem(other,objects,prefix,destination.slice(5));
          if (!name) continue;
          other.task.room = destination;other.expectedFetch = name;this.save();
          const previous = this.current;
          this.current = other; // journal the pickup against its actual owner
          try {
            if (await pickItem.call(this,name)) {other.picked=name;this.save();this.log(`HEAVY BATCH ${req.id}: collected ${name} for ${other.id}`);}
          } catch(e) {
            if (!other.cancelRequested) throw e;
            await this.finish(other,'cancelled','Stopped this pickup after the manager cancelled it.');
          } finally {this.current=previous;}
        }
      } finally {this._heavyBatch=false;}
      return ok;
    };
  }
  if (policy.managerLookup) {
    const resolveRoom = agent.resolveRoom;
    agent.resolveRoom = async function (req) {
      const t = req.task;
      if (!t.room && t.name && !this.roomOf[t.name] && !req.asked && !this._managerLookupUnavailable) {
        // Try the existing clarification command once; physical desk lookup
        // remains the fallback if the manager cannot resolve a named guest.
        await this.askAbout(req);
        if (req.task.room) { this.roomOf[t.name] = req.task.room; return req.task.room; }
        this._managerLookupUnavailable = true;
      }
      return resolveRoom.call(this,req);
    };
  }
  if (policy.targetedNoise) agent.handle_noise = targetedNoise;
  if (policy.readStaffNote || policy.readManual) configureScout(agent, { readStaffNote: !!policy.readStaffNote, readManual: !!policy.readManual });
  if (policy.prefetch) {
    const collect = agent.collect;
    agent.collect = async function (items) {
      const req = this.current;
      if (!req || req.task.type !== 'deliver') return collect.call(this, items);
      const candidates = batchCandidates(this, req).slice(0, 3);
      if (policy.forceBatchCart && this.cart === null && candidates.length >= 2 && /^charging-dock$|^lobby|^front-desk$|^storage$|^laundry$|^corridor-1/.test(this.loc)) await this.getCart();
      const ok = await collect.call(this, items);
      if (!ok || this.cart === null || !candidates.length) return ok;
      if (this.openRequests().some(q => q !== req && eligible(this, q, seconds(this.clock)) && this.urgency(q) >= 2)) return ok;
      const demand = new Map();
      for (const item of items) demand.set(item, (demand.get(item) || 0) + 1);
      let picked = 0;
      for (const other of candidates) for (const item of remainingItems(other)) {
        if (!SUPPLIES.has(item) || this.sources[item] !== this.loc || picked >= (policy.maxPrefetch || 6)) continue;
        demand.set(item, (demand.get(item) || 0) + 1);
        if (this.carrying(item) >= demand.get(item)) continue;
        if (!(await this.pickItem(item))) { if (this.sources[item] === this.loc) delete this.sources[item]; continue; }
        picked++;
        this.save();
      }
      if (picked) this.log(`BATCH ${req.id}: prefetched ${picked} supplies for nearby pending deliveries`);
      return ok;
    };
  }
  return agent;
}

module.exports = { configure, configureScout, configureStocked, coverSpills, estimate, eligible, batchCandidates, PRESETS };
