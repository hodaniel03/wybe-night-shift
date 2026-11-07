/*
 * Wybe Night Shift agent ("Ghosts").
 *
 * Runs in Node 18+ (uses global fetch) and can also be pasted into a browser
 * page on https://nightshift.wybe.me/ (defines window.NightShift).
 *
 * Protocol: POST / with JSON {cmd, args}. Header Authorization: Bearer <key>.
 * During a shift every call also carries X-Shift: <shift id>.
 */
(function (root) {
  'use strict';

  const DEFAULT_BASE = 'https://nightshift.wybe.me/';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Hotel map (explored on practice seed 1). Distances in metres.
  // ---------------------------------------------------------------------------
  const EDGES = [
    ['charging-dock', 'lobby', 8],
    ['lobby', 'front-desk', 7], ['lobby', 'lobby-bar', 10], ['lobby', 'elevator-1', 6], ['lobby', 'corridor-1a', 9],
    ['corridor-1a', 'corridor-1b', 13], ['corridor-1a', 'staff-room', 3],
    ['corridor-1a', 'room-101', 4], ['corridor-1a', 'room-102', 5], ['corridor-1a', 'room-103', 3],
    ['corridor-1b', 'corridor-1c', 13], ['corridor-1b', 'storage', 5], ['corridor-1b', 'laundry', 5],
    ['corridor-1b', 'room-104', 4], ['corridor-1b', 'room-105', 5], ['corridor-1b', 'room-106', 4],
    ['corridor-1c', 'kitchen-pass', 5], ['corridor-1c', 'stairwell-1', 7],
    ['corridor-1c', 'room-107', 3], ['corridor-1c', 'room-108', 5],
    ['stairwell-1', 'stairwell-2', 19], ['stairwell-2', 'stairwell-3', 19],
    ['stairwell-2', 'corridor-2d', 6],
    ['corridor-2d', 'corridor-2c', 12], ['corridor-2d', 'corridor-2a', 16],
    ['corridor-2d', 'room-211', 3], ['corridor-2d', 'room-212', 4], ['corridor-2d', 'room-213', 4], ['corridor-2d', 'room-214', 4],
    ['corridor-2c', 'corridor-2b', 18],
    ['corridor-2c', 'room-208', 4], ['corridor-2c', 'room-209', 4], ['corridor-2c', 'room-210', 4],
    ['corridor-2b', 'corridor-2a', 13],
    ['corridor-2b', 'room-204', 3], ['corridor-2b', 'room-205', 5], ['corridor-2b', 'room-206', 4], ['corridor-2b', 'room-207', 4],
    ['corridor-2a', 'elevator-2', 4],
    ['corridor-2a', 'room-201', 4], ['corridor-2a', 'room-202', 4], ['corridor-2a', 'room-203', 5],
    ['stairwell-3', 'corridor-3d', 6],
    ['corridor-3d', 'corridor-3c', 16], ['corridor-3d', 'corridor-3a', 18],
    ['corridor-3d', 'room-321', 3], ['corridor-3d', 'room-322', 3], ['corridor-3d', 'room-323', 4], ['corridor-3d', 'room-324', 3],
    ['corridor-3c', 'corridor-3b', 16],
    ['corridor-3c', 'room-318', 4], ['corridor-3c', 'room-319', 3], ['corridor-3c', 'room-320', 5],
    ['corridor-3b', 'corridor-3a', 16],
    ['corridor-3b', 'room-314', 4], ['corridor-3b', 'room-315', 5], ['corridor-3b', 'room-316', 3], ['corridor-3b', 'room-317', 4],
    ['corridor-3a', 'elevator-3', 6],
    ['corridor-3a', 'room-311', 4], ['corridor-3a', 'room-312', 4], ['corridor-3a', 'room-313', 4],
  ];
  const DOORS = new Set(['storage', 'laundry']); // entering costs ~3 s extra
  const STAIRS = new Set(['stairwell-1', 'stairwell-2', 'stairwell-3']);
  const ELEVATOR_OF_FLOOR = { 1: 'elevator-1', 2: 'elevator-2', 3: 'elevator-3' };
  const SECONDS = { flat: 1, stairs: 3, elevator: 60, door: 3 };

  // Where supplies live (updated at runtime from `look`).
  const DEFAULT_SOURCES = {
    towel: 'storage', 'toiletry-kit': 'storage', 'water-bottle': 'storage',
    'phone-charger': 'storage', 'wet-floor-sign': 'storage', pillow: 'laundry',
  };

  const ITEM_ALIASES = [
    [/phone[- ]?chargers?|chargers?/, 'phone-charger'],
    [/water[- ]?bottles?|bottles? of water|water/, 'water-bottle'],
    [/toiletry[- ]?kits?|toiletries/, 'toiletry-kit'],
    [/bath ?towels?|towels?/, 'towel'],
    [/pillows?/, 'pillow'],
    [/wet[- ]?floor[- ]?signs?/, 'wet-floor-sign'],
    [/glasses|spectacles/, 'glasses'],
  ];
  const NUMBERS = { a: 1, an: 1, one: 1, another: 1, extra: 1, two: 2, three: 3, four: 4, five: 5, couple: 2, pair: 1 };

  const PLACE_HINTS = [
    [/ground[- ]floor corridor|corridor on the ground floor|first[- ]floor corridor|floor 1 corridor|downstairs corridor/, ['corridor-1a', 'corridor-1b', 'corridor-1c']],
    [/(second|2nd)[- ]floor corridor|floor 2 corridor/, ['corridor-2a', 'corridor-2b', 'corridor-2c', 'corridor-2d']],
    [/(third|3rd)[- ]floor corridor|floor 3 corridor/, ['corridor-3a', 'corridor-3b', 'corridor-3c', 'corridor-3d']],
    [/lobby[- ]bar|\bbar\b/, ['lobby-bar']],
    [/lobby/, ['lobby']],
    [/front[- ]desk|reception/, ['front-desk']],
    [/staff[- ]room/, ['staff-room']],
    [/kitchen/, ['kitchen-pass']],
    [/laundry/, ['laundry']],
    [/storage/, ['storage']],
    [/stair/, ['stairwell-1', 'stairwell-2', 'stairwell-3']],
    [/elevator|\blift\b/, ['elevator-1', 'elevator-2', 'elevator-3']],
    [/charging|dock/, ['charging-dock']],
  ];

  const PLACE_WORDS = [
    [/front[- ]desk|\bdesk\b|reception/, 'front-desk'],
    [/kitchen/, 'kitchen-pass'],
    [/lobby[- ]bar|\bbar\b/, 'lobby-bar'],
    [/lobby/, 'lobby'],
    [/laundry/, 'laundry'],
    [/storage/, 'storage'],
    [/staff[- ]room/, 'staff-room'],
    [/charging|dock/, 'charging-dock'],
  ];
  function placeOf(phrase) {
    const p = phrase.toLowerCase();
    for (const [re, place] of PLACE_WORDS) if (re.test(p)) return place;
    return null;
  }
  // Words in requests -> object name prefix in the world.
  const OBJECT_WORDS = [
    [/bags?|suitcases?|luggage/, 'luggage'],
    [/trays?|room[- ]service|food|dinner|breakfast/, 'tray'],
  ];
  const HEAVY = /^(luggage|tray|suitcase|bag)/; // only the cart can carry these
  const NEEDS_ROOM = ['deliver', 'tell', 'inspect', 'noise', 'fetch', 'lost'];

  function buildGraph(edges) {
    const g = {};
    for (const [a, b, m] of edges) {
      (g[a] = g[a] || {})[b] = m;
      (g[b] = g[b] || {})[a] = m;
    }
    return g;
  }

  const isRoom = (n) => /^room-\d{3}$/.test(n);
  // A cleaning crew closes a passage between two places, not a whole corridor: seed 401 had 3a<->3b closed for hours
  // while 3b itself stayed reachable through 3d and 3c.
  const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  function clockToSeconds(clock) {
    if (!clock) return null;
    const [h, m, s] = clock.split(':').map(Number);
    const hh = h < 12 ? h + 24 : h;
    return (hh - 22) * 3600 + m * 60 + (s || 0);
  }

  function normalizeItem(phrase) {
    const p = phrase.toLowerCase().trim();
    for (const [re, id] of ITEM_ALIASES) if (re.test(p)) return id;
    return p.replace(/^(a|an|the|some|extra|another)\s+/, '').replace(/\s+/g, '-').replace(/s$/, '');
  }

  function parseItems(phrase) {
    // "a towel and two pillows", "an extra pillow"
    const out = [];
    const parts = phrase.toLowerCase().replace(/[.!?]+$/, '').split(/,|\band\b|\bplus\b/);
    for (let part of parts) {
      part = part.trim();
      if (!part) continue;
      let qty = 1;
      const m = part.match(/^(\d+|a couple of|a pair of|a|an|one|two|three|four|five|another|extra|some)\s+(.*)$/);
      if (m) {
        const w = m[1].replace(/^a (couple|pair) of$/, '$1');
        qty = /^\d+$/.test(w) ? Number(w) : (NUMBERS[w] || 1);
        part = m[2].replace(/^(extra|more|fresh|clean|new)\s+/, '');
      }
      out.push({ item: normalizeItem(part), qty });
    }
    return out;
  }

  // Room numbering differs between nights (seed 1: 311-324 on floor 3, seed 2: 321-334),
  // so accept any plausible number and find the room on its floor later.
  function findRoom(text, graph) {
    const re = /\b(?:room[- ]?)?([1-3][0-4]\d)\b/gi;
    let m;
    while ((m = re.exec(text))) {
      const n = Number(m[1]);
      if (n % 100 === 0) continue;
      return 'room-' + m[1];
    }
    return null;
  }

  function findName(text) {
    const m = text.match(/\b(Mr|Mrs|Ms|Mx|Miss|Dr)\.?\s+([A-ZÆØÅ][A-Za-zÆØÅæøå'-]+)/);
    return m ? `${m[1]} ${m[2]}` : null;
  }

  function placesFromHint(text) {
    const t = text.toLowerCase();
    const places = [];
    const direct = t.match(/corridor-(\d[a-d])/g) || [];
    for (const d of direct) places.push(d);
    for (const [re, ps] of PLACE_HINTS) if (re.test(t)) for (const p of ps) if (!places.includes(p)) places.push(p);
    return places;
  }

  // Turn a night-manager message into a task.
  function parseRequest(text, graph) {
    const body = text.replace(/^R-\d+:\s*/, '').trim();
    const room = findRoom(body, graph);
    const name = findName(body);
    let m;

    // "Bring the tray from the kitchen pass to 104." / "Take the bags at the desk up to 206. The room is empty, ..."
    if ((m = body.match(/\b(?:bring|take|deliver|carry|run|move)\s+(?:the\s+|a\s+|some\s+)?(.+?)\s+(?:at|from|in|waiting at|on|by)\s+(?:the\s+)?(.+?)\s+(?:up\s+|down\s+|over\s+|back\s+)?to\s+(?:room[- ]?)?(\d{3})/i))) {
      const from = placeOf(m[2]);
      if (from) {
        return {
          type: 'fetch', room: 'room-' + m[3], name, what: m[1].toLowerCase(), from,
          empty: /room is empty|checks? in later|not in (the|their) room|nobody is (in|there)|guest is out/i.test(body),
        };
      }
    }
    // "Room service for Dr Engen is waiting at the kitchen pass."
    if ((m = body.match(/^(?:the\s+)?(.+?)\s+for\s+(.+?)\s+(?:is|are)\s+(?:waiting|ready)\s+(?:at|in|by)\s+(?:the\s+)?(.+?)[.!]?$/i))) {
      const from = placeOf(m[3]);
      if (from) return { type: 'fetch', room, name, what: m[1].toLowerCase(), from, empty: false };
    }
    // "Someone mentioned a spill on floor 3."
    if (/\b(spill|spilled|spilt|puddle|wet floor|wet patch|slippery)\b/i.test(body)) {
      const fm = body.match(/floor\s*(\d)|(ground|first|second|third)[- ]floor/i);
      const floor = fm ? (fm[1] ? Number(fm[1]) : { ground: 1, first: 1, second: 2, third: 3 }[fm[2].toLowerCase()]) : null;
      return { type: 'spill', floor, room, name, places: placesFromHint(body) };
    }
    // "Complaint about noise near 201."
    if (/\b(noise|noisy|loud|music|party|shouting|banging)\b/i.test(body) && room) {
      return { type: 'noise', room, name };
    }
    // "Front desk passed on a call from 319: the guest says the water bottle they ordered an hour ago never came."
    if ((m = body.match(/\b(?:says|claims|complains)\s+(?:that\s+)?(?:the|their|his|her|a|an)\s+(.+?)\s+(?:they|he|she|the guest)\s+(?:ordered|asked for|requested)/i))) {
      return { type: 'complaint', room, name, item: normalizeItem(m[1]) };
    }
    if ((m = body.match(/\b(?:check|see|inspect|look)\s+(?:if|whether|that|on|in)?\s*(?:room[- ]?)?(\d{3})\s+(?:is\s+)?(.*?)(?:,|\.|$)/i))) {
      return { type: 'inspect', room: 'room-' + m[1], name, what: m[2] };
    }
    if ((m = body.match(/^(?:please\s+)?(?:tell|let|inform|remind)\s+(?:the guest in\s+|guest in\s+|the guests? in\s+)?(?:room[- ]?)?(\d{3})\s+(?:know\s+)?(?:that\s+)?(.+)$/i))) {
      return { type: 'tell', room: 'room-' + m[1], name, message: m[2].replace(/[.!]+$/, '') };
    }
    // "Let Mx Haugen know their wake-up call is set for half past six."
    if ((m = body.match(/^(?:please\s+)?(?:tell|let|inform|remind)\s+(?:Mr|Mrs|Ms|Mx|Miss|Dr)\.?\s+[A-ZÆØÅ][A-Za-zÆØÅæøå'-]+\s+(?:know\s+)?(?:that\s+)?(.+)$/i)) && name) {
      return { type: 'tell', room, name, message: m[1].replace(/[.!]+$/, '') };
    }
    if ((m = body.match(/\b(?:lost|left|dropped|misplaced|forgot)\s+(?:his|her|their|a|an|the|my|its)?\s*(?:pair of\s+)?([a-z][a-z' -]*?)(?=,|\.|\s+earlier|\s+somewhere|\s+maybe|\s+probably|\s+possibly|\s+near|\s+in the|\s+on the|\s+at the|\s+around|\s+tonight|\s+today|$)/i))) {
      const phrase = m[1].toLowerCase().trim();
      const item = normalizeItem(phrase);
      const words = phrase.replace(/'s\b/g, '').split(/[\s-]+/).filter((w) => w && !/^(a|an|the|his|her|their|my|its|little|small|big|child|kid|baby)$/.test(w));
      const last = words[words.length - 1] || item;
      const key = /ss$|glasses$|keys$/.test(last) ? last.replace(/keys$/, 'key') : last.replace(/s$/, '');
      return { type: 'lost', item, key, room, name, places: placesFromHint(body) };
    }
    if ((m = body.match(/\b(?:wants|needs|would like|asks for|is asking for|requests|could use|asked for)\s+(.+?)[.!]?$/i))) {
      return { type: 'deliver', room, name, items: parseItems(m[1]) };
    }
    return { type: 'unknown', room, name };
  }

  class ShiftOver extends Error {}
  class Paused extends Error {}
  class Cancelled extends Error {}

  // Shared by all agents in one process (the final runs 10 shifts in parallel).
  class RateLimiter {
    constructor({ rate = 40, burst = 20 } = {}) {
      this.rate = rate; this.burst = burst; this.tokens = burst; this.last = Date.now();
      this.queue = Promise.resolve(); this.throttled = 0;
    }
    take() {
      const turn = this.queue.then(async () => {
        for (;;) {
          const now = Date.now();
          this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
          this.last = now;
          if (this.tokens >= 1) { this.tokens -= 1; return; }
          await sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
        }
      });
      this.queue = turn.catch(() => {});
      return turn;
    }
    onThrottle() { this.throttled++; this.rate = Math.max(2, this.rate * 0.7); this.tokens = 0; }
  }

  // ---------------------------------------------------------------------------
  // Raw API call (no shift header), used for start_shift / shifts / whoami.
  // ---------------------------------------------------------------------------
  async function apiCall({ key, base = DEFAULT_BASE, shift = null, cmd, args, limiter = null, timeoutMs = 15000 }) {
    let wait = 500;
    for (let attempt = 0; attempt < 15; attempt++) {
      const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
      if (shift) headers['X-Shift'] = shift;
      if (limiter) await limiter.take();
      let res, text;
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(args === undefined ? { cmd } : { cmd, args }), signal: ctrl ? ctrl.signal : undefined });
        text = await res.text();
      } catch (e) {
        // Network hiccup or timeout: wait a little and try again (max 4 s, the robot idles after 20 s).
        if (timer) clearTimeout(timer);
        await sleep(wait); wait = Math.min(wait * 2, 4000); continue;
      }
      if (timer) clearTimeout(timer);
      let j;
      try { j = JSON.parse(text); } catch (e) { j = null; }
      // 5xx or a non-JSON page (proxy/gateway error) is not an answer from the game: try again.
      if (res.status >= 500 || !j) { await sleep(wait); wait = Math.min(wait * 2, 4000); continue; }
      const r = typeof j.result === 'string' ? j.result : '';
      if (res.status === 429 || /too many requests|slow down/i.test(r)) {
        if (limiter) limiter.onThrottle();
        await sleep(wait); wait = Math.min(wait * 2, 4000); continue;
      }
      j._status = res.status;
      return j;
    }
    throw new Error('No answer from the server after 15 tries');
  }

  async function startShift({ key, base = DEFAULT_BASE, mode = 'practice', seed }) {
    const args = { mode };
    if (seed !== undefined && seed !== null) args.seed = Number(seed);
    const j = await apiCall({ key, base, cmd: 'start_shift', args });
    if (!j.ok || !j.result || !j.result.shift) throw new Error('start_shift failed: ' + JSON.stringify(j));
    return j.result; // {shift, seed, mode, clock, text}
  }

  // ---------------------------------------------------------------------------
  // The agent
  // ---------------------------------------------------------------------------
  class Agent {
    constructor(opts) {
      this.key = opts.key;
      this.base = opts.base || DEFAULT_BASE;
      this.shift = opts.shift;
      this.onUnknown = opts.onUnknown || 'skip'; // 'pause' | 'skip' | 'decline'
      this.minGapMs = opts.minGapMs === undefined ? 80 : opts.minGapMs;
      this.logFn = opts.log || ((s) => console.log(s));
      // Charging blocks every request that comes in meanwhile, so charge late and only as much as the night needs.
      this.lowBattery = opts.lowBattery || 12;
      this.chargeTo = opts.chargeTo || 30;
      // What to report when the newest spill on a floor already has our sign: 'declined' | 'done' | 'failed'.
      this.signedSpillOutcome = opts.signedSpillOutcome || 'declined';
      this.askManager = opts.askManager === undefined ? true : opts.askManager;
      this.prepare = opts.prepare === undefined ? true : opts.prepare;
      this.cartAt = null;
      this.watchFloors = opts.watchFloors === undefined ? true : opts.watchFloors;
      this.lookTtl = opts.lookTtl || 900; // seconds of sim time a `look` stays trusted
      this.lookedAt = {};
      this.wet = new Set();
      this.wetSince = {};
      this.slips = 0;
      this.pendingPerson = null;
      this.supplyLooked = {};
      this.blocked = {}; // "a|b" passage -> sim second until which we avoid it
      this.blockTtl = opts.blockTtl || 1200; // closed corridors usually stay closed for an hour or more
      this.verified = {}; // corridors whose doors we have seen tonight
      this.foundFor = {}; // lost item name -> request id it was found for
      this.signsPlaced = []; // {place, atS} of wet floor signs we put out
      this.placeState = {}; // place -> {wet, signed, atS} from the last look
      this.objectsAt = {}; // place -> objects in plain sight at the last look
      this.blockCount = {}; // place -> how many times a move there failed because it was closed off
      this.hitBlock = false; // a move failed tonight because a cleaning crew closed a corridor (reset per task)
      this.cartStuck = null; // {at, atS}: we left the cart where only stairs lead on
      this.limiter = opts.limiter || null;
      this.onSave = opts.onSave || null;
      this.errors = 0;
      this.current = null;
      this.lastActionAt = 0;
      this.maxActionGapMs = 0;
      this.parkCart = opts.parkCart === undefined ? true : opts.parkCart;

      this.g = buildGraph(EDGES);
      this.sources = Object.assign({}, DEFAULT_SOURCES);
      this.trace = [];
      this.lines = [];
      this.requests = new Map();
      this.roomOf = {}; // "Mr Berg" -> "room-319"
      this.dnd = new Set();
      this.loc = 'charging-dock';
      this.hands = [];
      this.cart = null;
      this.battery = 100;
      this.score = 0;
      this.clock = '22:00:00';
      this.unread = true;
      this.over = false;
      this.paused = null;
      this.lastCallAt = 0;
      this.calls = 0;
      this.idleStreak = 0;
    }

    log(s) {
      const line = `${this.clock} ${s}`;
      this.lines.push(line);
      this.logFn(line);
    }

    // ---- transport --------------------------------------------------------
    async call(cmd, args) {
      if (this.over) throw new ShiftOver('shift over');
      const gap = Date.now() - this.lastCallAt;
      if (gap < this.minGapMs) await sleep(this.minGapMs - gap);
      this.lastCallAt = Date.now();
      const j = await apiCall({ key: this.key, base: this.base, shift: this.shift, cmd, args, limiter: this.limiter });
      this.calls++;
      this.absorb(cmd, args, j);
      // Final rule: 20 s per action (status/inbox do not count). Track the worst gap we produced.
      if (!['status', 'inbox', 'report', 'reply', 'help', 'whoami', 'shifts'].includes(cmd)) {
        const now = Date.now();
        if (this.lastActionAt) this.maxActionGapMs = Math.max(this.maxActionGapMs, now - this.lastActionAt);
        this.lastActionAt = now;
      }
      if (this.onSave && this.calls % 100 === 0) this.save();
      // Answer people who stop the robot right where it is (before walking on).
      if (cmd === 'move' && this.pendingPerson && !this._responding && !this.over) {
        this._responding = true;
        try { await this.respondPerson(); } finally { this._responding = false; }
      }
      // Read new messages right away (inbox costs no sim time). Seed 3: "Skip R-035, 302 checked out"
      // arrived while we carried the wallet up; handing it over anyway cost -50.
      if (this.unread && cmd !== 'inbox' && !this._readingInbox && !this.over) {
        this._readingInbox = true;
        try { await this.readInbox(); } finally { this._readingInbox = false; }
      }
      const cur = this.current;
      if (cur && cur.cancelRequested && cur.status === 'open' && !this._finishing && !['report', 'status', 'inbox'].includes(cmd)) {
        throw new Cancelled(cur.id);
      }
      return j;
    }

    absorb(cmd, args, j) {
      if (j.clock) this.clock = j.clock;
      this.trace.push({ clock: j.clock, cmd, args, ok: j.ok, result: j.result, events: j.events, note: j.note });
      for (const e of j.events || []) {
        if (e.type === 'inbox') this.unread = true;
        else if (e.type !== 'dock') this.log(`EVENT ${JSON.stringify(e)}`);
        if (e.type === 'slip') { this.slips++; if (cmd === 'move' && args && args.to) this.markWet(args.to); }
        if (e.type === 'person') this.pendingPerson = e.text;
      }
      // "Closed off: a cleaning crew has blocked that corridor." -> route around it for a while.
      if (cmd === 'move' && !j.ok && args && args.to && /closed off|blocked|cleaning crew|cordoned/i.test(String(j.result))) {
        // Still closed when we come back: it will probably stay closed even longer.
        const k = edgeKey(this.loc, args.to);
        const n = (this.blockCount[k] = (this.blockCount[k] || 0) + 1);
        this.blocked[k] = clockToSeconds(this.clock) + this.blockTtl * Math.min(3, n);
        this.log(`BLOCKED ${this.loc} -> ${args.to}: ${j.result}`);
      }
      if (cmd === 'move' && j.ok && args && args.to) {
        delete this.blocked[edgeKey(this.loc, args.to)];
        const at = j.result && (j.result.at || (j.result.outcome && j.result.outcome.at));
        this.loc = at || args.to; // keep the position right even if the task is interrupted after this move
      }
      const res = j.result && typeof j.result === 'object' ? (j.result.outcome || j.result) : null;
      if (res && res.notice && /wet/i.test(res.notice) && args && args.to) this.markWet(args.to);
      if (j.note) this.log(`NOTE ${j.note}`);
      const text = typeof j.result === 'string' ? j.result : JSON.stringify(j.result || '');
      // 06:00: {"outcome":..., "shift_over":true, "reason":"time", "score":1569, ...} + event {type:"shift"}
      if (j.result && j.result.shift_over) {
        this.over = true;
        if (typeof j.result.score === 'number') this.score = j.result.score;
        this.log(`SHIFT OVER (${j.result.reason}): score ${j.result.score}, served ${j.result.requests_served}`);
      } else if ((j.events || []).some((e) => e.type === 'shift') || /already ended|start a new one|shift (is )?(over|ended|finished|closed)|no (active|live) shift|clocked out/i.test(text)) {
        this.over = true;
        this.log(`SHIFT OVER: ${text}`);
      }
    }

    markWet(place) {
      this.wet.add(place);
      if (this.wetSince[place] === undefined) this.wetSince[place] = clockToSeconds(this.clock);
    }

    async syncStatus() {
      const r = await this.call('status');
      if (r.ok && r.result) {
        const s = r.result;
        this.loc = s.location || this.loc;
        this.hands = s.hands || [];
        this.cart = s.cart === undefined ? this.cart : s.cart;
        this.battery = s.battery;
        this.score = s.score;
        if (s.unread_messages) this.unread = true;
      }
      return r;
    }

    // ---- navigation -------------------------------------------------------
    plan(from, to, withCart) {
      const now = clockToSeconds(this.clock);
      const isBlocked = (u, v) => { const t = this.blocked[edgeKey(u, v)]; return t !== undefined && t > now; };
      const dist = { [from]: 0 }, prev = {}, done = new Set();
      const pq = [[0, from]];
      while (pq.length) {
        pq.sort((x, y) => x[0] - y[0]);
        const [d, u] = pq.shift();
        if (done.has(u)) continue;
        done.add(u);
        if (u === to) break;
        const nbrs = [];
        for (const [v, m] of Object.entries(this.g[u] || {})) {
          if (isRoom(v)) continue;
          if (isBlocked(u, v)) continue;
          const stairs = STAIRS.has(u) && STAIRS.has(v);
          if (stairs && withCart) continue;
          let c = m * (stairs ? SECONDS.stairs : SECONDS.flat);
          if (DOORS.has(v)) c += SECONDS.door;
          if (this.wet && this.wet.has(v)) c += 10; // creeping over a known wet floor
          nbrs.push([v, c, { type: 'move', to: v }]);
        }
        if (/^elevator-\d$/.test(u)) {
          for (const f of [1, 2, 3]) {
            const v = ELEVATOR_OF_FLOOR[f];
            if (v !== u) nbrs.push([v, SECONDS.elevator, { type: 'elevator', floor: f, to: v }]);
          }
        }
        for (const [v, c, step] of nbrs) {
          const nd = d + c;
          if (dist[v] === undefined || nd < dist[v]) { dist[v] = nd; prev[v] = { u, step }; pq.push([nd, v]); }
        }
      }
      if (dist[to] === undefined) return null;
      const steps = [];
      let c = to;
      while (c !== from) { steps.unshift(prev[c].step); c = prev[c].u; }
      return { steps, cost: dist[to] };
    }

    cost(from, to) {
      if (from === to) return 0;
      const p = this.plan(from, to, this.cart !== null);
      return p ? p.cost : Infinity;
    }

    corridorOf(room) {
      const n = Object.keys(this.g[room] || {}).filter((x) => !isRoom(x));
      return n.find((x) => this.verified && this.verified[x]) || n[0] || null;
    }

    // Which corridor is this room off? Trust only corridors we have looked at tonight;
    // otherwise walk that floor's corridors (nearest first) and look until we see the door.
    async locateRoom(room) {
      const known = this.corridorOf(room);
      if (known && this.verified[known]) return known;
      const floor = room.slice(5, 6);
      const corridors = Object.keys(this.g).filter((n) => new RegExp(`^corridor-${floor}[a-z]$`).test(n));
      if (known) { corridors.splice(corridors.indexOf(known), 1); corridors.unshift(known); }
      const todo = corridors.filter((c) => !this.verified[c]);
      while (todo.length) {
        if (todo[0] !== known) todo.sort((a, b) => this.cost(this.loc, a) - this.cost(this.loc, b));
        const c = todo.shift();
        if (!(await this.goTo(c))) continue;
        if (!this.verified[c] || this.loc === c) await this.lookAround();
        const found = this.corridorOf(room);
        if (found && this.verified[found]) return found;
      }
      return this.corridorOf(room);
    }

    // Wet floors: walking onto an unseen wet patch = slip (lost minute, and it looks like -15 points).
    // After `look` has shown "the floor that way looks wet", the robot creeps over it instead (+~10 s).
    async lookAround() {
      const r = await this.call('look');
      const res = r.result || {};
      if (!res.location) return res;
      this.lookedAt[res.location] = clockToSeconds(this.clock);
      if (/wet patch|wet floor/i.test(res.description || '')) this.markWet(res.location);
      const nowS = clockToSeconds(this.clock);
      const desc = res.description || '';
      this.placeState[res.location] = { wet: /wet patch|spill|puddle/i.test(desc), signed: /sign stands/i.test(desc), atS: nowS };
      for (const e of res.exits || []) {
        if (e.warning && /wet/i.test(e.warning)) this.markWet(e.to);
        // "blocked": "closed off for cleaning" shows up in look: route around it without trying.
        const k = edgeKey(res.location, e.to);
        if (e.blocked) this.blocked[k] = Math.max(this.blocked[k] || 0, nowS + this.blockTtl);
        else if (this.blocked[k] !== undefined) { delete this.blocked[k]; delete this.blockCount[k]; }
        // Distances and room numbers differ from night to night: learn the real ones.
        if (typeof e.metres === 'number') {
          (this.g[res.location] = this.g[res.location] || {})[e.to] = e.metres;
          (this.g[e.to] = this.g[e.to] || {})[res.location] = e.metres;
        }
      }
      if (Array.isArray(res.exits) && !isRoom(res.location)) {
        const here = new Set(res.exits.map((e) => e.to));
        for (const v of Object.keys(this.g[res.location] || {})) {
          if (isRoom(v) && !here.has(v)) { delete this.g[res.location][v]; if (this.g[v]) delete this.g[v][res.location]; }
        }
        this.verified[res.location] = true;
      }
      this.learnObjects(res);
      if (Array.isArray(res.objects)) this.objectsAt[res.location] = res.objects.map((o) => String(o).replace(/\s+x\d+$/, ''));
      return res;
    }

    async dropCart() {
      const r = await this.call('drop', { item: 'cart' });
      if (r.ok) { this.parkedCart = (this.cart || []).slice(); this.cartAt = this.loc; this.cart = null; this.log(`left the cart at ${this.loc}`); return true; }
      return false;
    }

    // Items the task in hand needs to bring along.
    neededItems() {
      const req = this.current;
      if (!req) return [];
      const t = req.task;
      if (t.type === 'deliver') return t.items.flatMap(({ item, qty }) => Array(qty).fill(item));
      if (t.type === 'spill') return ['wet-floor-sign'];
      if (t.type === 'lost') return req.found ? [req.found] : [];
      if (t.type === 'fetch') return req.picked ? [req.picked] : [];
      return [];
    }

    // The cart cannot take the stairs. When a closed corridor leaves only the stairs, carry what this task
    // needs by hand and leave the cart behind (seed 2: the robot sat stuck with the cart on floor 3 while a
    // cleaning crew closed the only corridor to the elevator, and three requests failed in a row).
    async leaveCart() {
      if (this.cart === null) return true;
      const need = this.neededItems();
      const take = [];
      const pool = this.cart.slice();
      for (const it of need) {
        if (this.hands.includes(it) && !take.includes(it)) continue;
        const k = pool.indexOf(it);
        if (k >= 0) { take.push(it); pool.splice(k, 1); }
      }
      if (take.some((it) => HEAVY.test(it))) { this.hitBlock = true; return false; } // luggage and trays need the cart
      if (take.length > 2 - this.hands.length) { this.hitBlock = true; return false; }
      for (const it of take) {
        // drop takes from the hands first, then from the cart; pick puts it in a free hand.
        const d = await this.call('drop', { item: it });
        if (!d.ok) return false;
        const k = this.cart.indexOf(it); if (k >= 0) this.cart.splice(k, 1);
        if (!(await this.pickItem(it))) return false;
      }
      if (!(await this.dropCart())) return false;
      this.cartStuck = { at: this.loc, atS: clockToSeconds(this.clock) };
      this.log(`left the cart at ${this.loc}: only the stairs lead on`);
      return true;
    }

    async goTo(target, depth = 0) {
      if (!target) return false;
      if (this.loc === target) return true;
      let p = this.plan(this.loc, target, this.cart !== null);
      if (!p && this.cart !== null) {
        const walk = this.plan(this.loc, target, false);
        if (walk && (await this.leaveCart())) p = walk;
      }
      if (!p) {
        // A cleaning crew can close a corridor for hours: do not wait here, let the task be tried again later.
        const now = clockToSeconds(this.clock);
        if (Object.values(this.blocked).some((u) => u > now)) this.hitBlock = true;
        this.log(`no path ${this.loc} -> ${target}`);
        return false;
      }
      for (const s of p.steps) {
        if (s.type === 'move' && this.watchFloors && /^corridor-|^lobby$|^elevator-|^stairwell-/.test(this.loc)) { // the look warns about a wet floor next door
          const seen = this.lookedAt[this.loc];
          const now = clockToSeconds(this.clock);
          if (seen === undefined || now - seen > this.lookTtl) await this.lookAround();
        }
        if (s.type === 'elevator') {
          let r = await this.call('call_elevator', { floor: s.floor });
          r = await this.call('move', { to: s.to });
          if (!r.ok) {
            await this.call('call_elevator', { floor: s.floor });
            r = await this.call('move', { to: s.to });
            if (!r.ok) { this.log(`elevator failed: ${JSON.stringify(r.result)}`); await this.syncStatus(); return false; }
          }
          this.loc = s.to;
        } else {
          const r = await this.call('move', { to: s.to });
          if (!r.ok) {
            this.log(`move to ${s.to} failed: ${JSON.stringify(r.result)}`);
            await this.syncStatus();
            if (this.blocked[edgeKey(this.loc, s.to)] !== undefined) {
              this.hitBlock = true;
              if (depth < 3) return this.goTo(target, depth + 1); // maybe there is another way round
            }
            return false;
          }
          this.loc = s.to;
        }
      }
      return true;
    }

    // ---- inbox ------------------------------------------------------------
    async readInbox() {
      this.unread = false;
      const r = await this.call('inbox');
      const msgs = (r.result && r.result.messages) || [];
      for (const m of msgs) this.onMessage(m);
      // The server only hands out each message once: save now, or a crash right here loses the request.
      if (msgs.length) this.save();
    }

    onMessage(m) {
      this.log(`MSG ${m.request || ''} ${m.text}`);
      const ids = m.request ? [m.request] : (m.text.match(/R-\d+/g) || []);
      if (m.request && !this.requests.has(m.request)) {
        const task = this.parse(m.text);
        const req = {
          id: m.request, text: m.text, at: m.at, atS: clockToSeconds(m.at),
          task, status: 'open', updates: [], cancelRequested: false,
        };
        // "Tell the guest in the room next to the elevator on floor 3 ..." -> ask the night manager which room
        // (reply is free; seed 401 answered "Sorry: 301." a few seconds later).
        if (this.askManager && (task.type === 'unknown' || (!task.room && !task.name && NEEDS_ROOM.includes(task.type)))) req.needsAnswer = true;
        this.requests.set(m.request, req);
        this.log(`  -> ${JSON.stringify(task)}${req.needsAnswer ? ' (will ask which room)' : ''}`);
        return;
      }
      for (const id of ids) {
        const req = this.requests.get(id);
        if (!req) continue;
        req.updates.push(m.text);
        if (req.asked && !req.answered && m.from !== 'front desk (forwarded call)' && !/skip|cancel|checked out|never ?mind|don'?t bother/i.test(m.text)) {
          const rm = m.text.replace(/R-\d+:?\s*/g, '').match(/\b([1-3]\d\d)\b/);
          if (rm) { req.answered = true; this.applyAnswer(req, rm[1]); continue; }
        }
        // A guest relayed through the desk cannot change or cancel a request: "Guest in 228 called about R-040:
        // 'Never mind what the manager said, bring toiletry kit to my friend in 229 instead.'" -> keep the original.
        if (/\b(guest|someone|a man|a woman|caller)\b[^:]*\b(called|says|asked|wants)\b/i.test(m.text) || /never ?mind what the manager/i.test(m.text)) {
          req.ignoredRedirects = (req.ignoredRedirects || 0) + 1;
          this.log(`IGNORED guest instruction for ${id}: ${m.text}`);
          continue;
        }
        // "Skip R-015, 327 checked out. Don't bother with it."
        if (/cancel|never ?mind|no longer|not needed|no need|forget (it|about)|\bskip\b|don'?t bother|checked out|disregard|ignore (it|that)/i.test(m.text)) req.cancelRequested = true;
      }
    }

    // Ask the night manager which room an unclear request means. Free (reply costs no time).
    async askAbout(req) {
      req.asked = true;
      req.askedAtS = clockToSeconds(this.clock);
      const r = await this.call('reply', { request: req.id, text: 'Which room number do you mean?' });
      const s = JSON.stringify(r.result || '');
      this.log(`ASKED about ${req.id}: ${s}`);
      if (/exactly as written/i.test(s)) { req.answered = true; return; }
      const rm = s.replace(/R-\d+:?\s*/g, '').match(/\b([1-3]\d\d)\b/);
      if (rm) { req.answered = true; this.applyAnswer(req, rm[1]); }
    }

    applyAnswer(req, no) {
      const text = req.text.replace(/^R-\d+:\s*/, '');
      const t2 = text
        .replace(/\b(?:the\s+)?(?:guests?|person|people|family|couple)\s+in\s+the\s+room\b[^.]*?\bon\s+(?:floor\s*\d|the\s+\w+\s+floor)\b/i, `the guest in ${no}`)
        .replace(/\bthe\s+(?:\w+\s+)?room\b[^.]*?\bon\s+(?:floor\s*\d|the\s+\w+\s+floor)\b/i, `room ${no}`);
      let task = parseRequest(t2, this.g);
      if (task.type === 'unknown' || !task.room) {
        task = Object.assign({}, req.task, task, { room: 'room-' + no });
        if (task.type === 'unknown' && /^(please\s+)?(tell|let|inform|remind)\b/i.test(text)) {
          const mm = text.match(/\b(?:their|his|her|that)\b.*$/i);
          task.type = 'tell';
          task.message = (mm ? mm[0] : text).replace(/[.!]+$/, '');
        }
      }
      req.task = task;
      this.log(`ANSWER ${req.id}: room ${no} -> ${JSON.stringify(task)}`);
    }

    openRequests() {
      return [...this.requests.values()].filter((r) => r.status === 'open');
    }

    // ---- reporting --------------------------------------------------------
    async finish(req, outcome, note) {
      const before = this.score;
      // A cancellation that arrived while we worked wins over whatever we were about to report.
      if (req.cancelRequested && outcome !== 'cancelled' && outcome !== 'done') {
        outcome = 'cancelled';
        note = `Cancelled by the night manager: ${req.updates[req.updates.length - 1] || ''}`.trim();
      }
      // Failed only because a cleaning crew closed a corridor on the way: try again later instead of giving up.
      // Whatever is still open at 05:50 is reported failed by run().
      if (outcome === 'failed' && this.hitBlock && !req.cancelRequested && (req.defers || 0) < 8 && clockToSeconds(this.clock) < 7 * 3600 + 40 * 60) {
        req.notBefore = clockToSeconds(this.clock) + 10 * 60;
        req.retryNote = `A cleaning crew kept the corridor closed; tried again later but could not get through (${note})`;
        req.defers = (req.defers || 0) + 1;
        this.hitBlock = false;
        this.log(`DEFER ${req.id} #${req.defers}: ${note}`);
        return;
      }
      this._finishing = true;
      let r;
      try {
        r = await this.call('report', { request: req.id, outcome, note });
        req.status = r.ok ? outcome : 'report-failed';
        await this.syncStatus();
      } finally {
        this._finishing = false;
      }
      req.points = this.score - ((this.current === req && req.scoreAtStart !== undefined) ? req.scoreAtStart : before);
      this.log(`REPORT ${req.id} ${outcome} (${note}) -> ${JSON.stringify(r.result)} | score ${this.score} (${req.points >= 0 ? '+' : ''}${req.points})`);
      this.save();
    }

    // ---- state on disk, so a crashed run can continue the same shift (no restarts in the final) ----
    saveState() {
      return {
        v: 1, shift: this.shift, savedAt: new Date().toISOString(), clock: this.clock, score: this.score,
        requests: [...this.requests.values()], roomOf: this.roomOf, dnd: [...this.dnd], sources: this.sources,
        g: this.g, verified: this.verified, wet: [...this.wet], wetSince: this.wetSince, lookedAt: this.lookedAt,
        blocked: this.blocked, cartAt: this.cartAt, foundFor: this.foundFor, supplyLooked: this.supplyLooked,
        signsPlaced: this.signsPlaced, parkedCart: this.parkedCart || null, placeState: this.placeState, cartStuck: this.cartStuck,
        slips: this.slips, calls: this.calls,
      };
    }

    loadState(s) {
      if (!s || s.shift !== this.shift) return false;
      for (const r of s.requests || []) this.requests.set(r.id, r);
      Object.assign(this.roomOf, s.roomOf || {});
      this.dnd = new Set(s.dnd || []);
      this.sources = s.sources || this.sources;
      this.g = s.g || this.g;
      this.verified = s.verified || {};
      this.wet = new Set(s.wet || []);
      this.wetSince = s.wetSince || {};
      this.lookedAt = s.lookedAt || {};
      this.blocked = s.blocked || {};
      this.cartAt = s.cartAt || null;
      this.foundFor = s.foundFor || {};
      this.supplyLooked = s.supplyLooked || {};
      this.signsPlaced = s.signsPlaced || [];
      this.placeState = s.placeState || {};
      this.cartStuck = s.cartStuck || null;
      this.parkedCart = s.parkedCart || null;
      this.slips = s.slips || 0;
      this.prepare = false; // keycard/cart/supply rooms were handled before the crash
      this.log(`RESUMED from saved state (${this.requests.size} requests, saved ${s.savedAt})`);
      return true;
    }

    save() {
      if (!this.onSave) return;
      try { this.onSave(this.saveState()); } catch (e) { this.log(`save failed: ${e.message}`); }
    }

    // ---- helpers ----------------------------------------------------------
    async resolveRoom(req) {
      const t = req.task;
      if (t.room) return t.room;
      if (t.name && this.roomOf[t.name]) return this.roomOf[t.name];
      if (t.name) {
        await this.goTo('front-desk');
        const r = await this.call('ask', { person: 'clerk', question: `Which room is ${t.name} in?` });
        const m = JSON.stringify(r.result || '').match(/room-(\d{3})/);
        if (m) { this.roomOf[t.name] = 'room-' + m[1]; return this.roomOf[t.name]; }
      }
      return null;
    }

    noteGuest(text) {
      const m = String(text).match(/^(.+?) opens the door of (room-\d{3})/);
      if (m) this.roomOf[m[1]] = m[2];
    }

    async knock(room) {
      const corridor = await this.locateRoom(room);
      if (!corridor || !(await this.goTo(corridor))) return { state: 'unreachable' };
      const r = await this.call('knock', { door: room });
      const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      this.noteGuest(text);
      if (/opens the door|door is open|already open/i.test(text)) return { state: 'open', text };
      if (/do not disturb/i.test(text)) { this.dnd.add(room); return { state: 'dnd', text }; }
      if (/no answer/i.test(text)) return { state: 'noanswer', text };
      this.log(`knock ${room}: ${text}`);
      return { state: r.ok ? 'other' : 'error', text };
    }

    // Supplies move between storage and laundry from night to night: trust what we see.
    learnObjects(lookResult) {
      if (!lookResult || !lookResult.location || !Array.isArray(lookResult.objects)) return;
      const here = lookResult.location;
      const seen = new Set();
      const supplyRoom = here === 'storage' || here === 'laundry';
      for (const o of lookResult.objects) {
        const name = String(o).replace(/\s+x\d+$/, '');
        seen.add(name);
        if (name === 'cart') { this.cartAt = here; continue; }
        if (supplyRoom || / x\d+$/.test(String(o))) this.sources[name] = here;
      }
      if (here === 'storage' || here === 'laundry') {
        for (const [item, src] of Object.entries(this.sources)) if (src === here && !seen.has(item)) delete this.sources[item];
        this.supplyLooked[here] = true;
      }
    }

    // Find where an item is kept: known source, else look in the supply rooms we have not seen.
    async findSource(item) {
      if (this.sources[item]) return this.sources[item];
      for (const room of ['storage', 'laundry']) {
        if (this.supplyLooked[room]) continue;
        if (!(await this.goTo(room))) continue;
        await this.lookAround();
        if (this.sources[item]) return this.sources[item];
      }
      return this.sources[item] || null;
    }

    async pickItem(item) {
      const r = await this.call('pick', { item });
      if (r.ok) {
        if (/in the cart/i.test(String(r.result))) (this.cart = this.cart || []).push(item);
        else this.hands.push(item);
        return true;
      }
      this.log(`pick ${item} failed: ${JSON.stringify(r.result)}`);
      return false;
    }

    carrying(item) {
      return this.hands.filter((h) => h === item).length + (this.cart || []).filter((h) => h === item).length;
    }

    freeHands() {
      return this.cart !== null ? 99 : 2 - this.hands.length;
    }

    async dropExtras(keep) {
      // Free hands from things no open request needs. Never the keycard: there is only one,
      // and seed 2 lost two room checks after it was left at the charging dock.
      for (const h of [...this.hands]) {
        const owner = this.foundFor[h] && this.requests.get(this.foundFor[h]);
        if (keep.includes(h) || h === 'keycard' || (owner && owner.status === 'open')) continue; // a found lost item goes to its owner
        const r = await this.call('drop', { item: h });
        if (r.ok) this.hands.splice(this.hands.indexOf(h), 1);
      }
    }

    // ---- request handlers -------------------------------------------------
    parse(text) {
      return parseRequest(text, this.g);
    }

    async handle(req) {
      req.scoreAtStart = this.score;
      this.hitBlock = false;
      const t = req.task;
      this.log(`HANDLE ${req.id} [${t.type}] ${req.text}${req.defers ? ` (try ${req.defers + 1})` : ''}`);
      await this.stashCart(req);
      const fn = this['handle_' + t.type];
      try {
        if (typeof fn === 'function') return await fn.call(this, req);
        return await this.handleUnknown(req);
      } catch (e) {
        if (!(e instanceof Cancelled)) throw e;
        this.log(`CANCELLED ${req.id} mid-task: ${req.updates[req.updates.length - 1] || ''}`);
        if (req.status === 'open') return this.finish(req, 'cancelled', `Stopped: ${req.updates[req.updates.length - 1] || 'cancelled by the night manager'}`);
      }
    }

    handle_deliver(req) { return this.handleDeliver(req); }
    handle_tell(req) { return this.handleTell(req); }
    handle_lost(req) { return this.handleLost(req); }

    // Housekeeping cart: carries anything (heavy trays too) but cannot take the stairs.
    async getCart() {
      if (this.cart !== null) return true;
      // A cart left behind a closed corridor stays useless until the corridor opens again
      // (seed 2: left in corridor-3b, which then stayed closed for the rest of the night).
      const nowS = clockToSeconds(this.clock);
      if (this.cartAt && nowS !== null && !this.plan(this.cartAt, 'lobby', true)) { this.hitBlock = true; return false; }
      // There is only one cart: once we know where it is, look nowhere else.
      const places = this.cartAt ? [this.cartAt] : ['laundry', 'storage'];
      for (const where of places) {
        if (!(await this.goTo(where))) continue;
        const r = await this.call('use', { item: 'cart' });
        if (r.ok) { this.cart = (this.parkedCart || []).slice(); this.parkedCart = null; this.cartAt = null; this.cartStuck = null; await this.syncStatus(); return true; }
        this.log(`use cart at ${where} failed: ${JSON.stringify(r.result)}`);
        if (where === this.cartAt) this.cartAt = null;
      }
      return false;
    }

    // Does this task need the cart? Trays and luggage do, and more things than free hands.
    needsCart(req) {
      const t = req.task;
      if (t.type === 'fetch') return true;
      if (t.type === 'deliver') return t.items.reduce((a, x) => a + x.qty, 0) > 2 - (this.hands.includes('keycard') ? 1 : 0);
      return false;
    }

    // Take supplies out of the parked cart by hand and leave the cart where it is.
    async takeFromParkedCart(items) {
      if (!this.cartAt || this.cartStuck || !(await this.goTo(this.cartAt))) return false;
      const u = await this.call('use', { item: 'cart' });
      if (!u.ok) { this.cartAt = null; this.parkedCart = null; return false; }
      this.cart = (this.parkedCart || []).slice();
      this.parkedCart = null;
      for (const it of items) {
        if (this.hands.length >= 2 || !this.cart.includes(it)) continue;
        const d = await this.call('drop', { item: it }); // from the cart (the hands do not have it)
        if (!d.ok) break;
        this.cart.splice(this.cart.indexOf(it), 1);
        await this.pickItem(it);
      }
      await this.dropCart();
      return true;
    }

    // Leave the cart on the ground floor when the next task does not need it: upstairs a cleaning crew
    // can trap it (the cart cannot take the stairs).
    async stashCart(req) {
      if (this.cart === null || this.needsCart(req) || this.cart.some((it) => HEAVY.test(it))) return;
      if (!/^(corridor-1|lobby$|charging-dock$|front-desk$|lobby-bar$|kitchen-pass$|storage$|laundry$|staff-room$)/.test(this.loc)) return;
      await this.dropCart();
    }

    hasKeycard() {
      return this.hands.includes('keycard') || (this.cart || []).includes('keycard');
    }

    async getKeycard() {
      if (this.hasKeycard()) return true;
      if (!(await this.goTo('front-desk'))) return false;
      if (this.cart === null && this.hands.length >= 2) await this.dropExtras([]);
      return this.pickItem('keycard');
    }

    // Knock, hand over carried items, report.
    async deliverCarried(req, room, items, doneNote) {
      const k = await this.knock(room);
      if (k.state === 'dnd') return this.finish(req, 'declined', `Do Not Disturb sign on ${room}; did not disturb the guest.`);
      if (k.state === 'unreachable') return this.finish(req, 'failed', `Could not get to ${room}.`);
      if (k.state !== 'open') {
        const k2 = await this.knock(room);
        if (k2.state !== 'open') {
          if (this.retryLater(req, `No answer at ${room}, twice tonight.`)) return;
          return this.finish(req, 'failed', `No answer at ${room}.`);
        }
      }
      for (const it of items) {
        if (!(await this.placeInRoom(room, it))) return this.finish(req, 'failed', `Could not hand over ${it} at ${room}.`);
      }
      return this.finish(req, 'done', doneNote);
    }

    // Spill on a floor: put a wet-floor sign on the NEWEST unsigned wet patch there.
    // Seed 1: signing an old wet patch (seen hours earlier) instead of the new spill gave -30.
    async handle_spill(req) {
      const t = req.task;
      // Corridors first, then the landings (seed 2: a floor-3 spill was in none of the corridors).
      const FLOOR_PLACES = {
        1: ['corridor-1a', 'corridor-1b', 'corridor-1c', 'lobby'],
        2: ['corridor-2a', 'corridor-2b', 'corridor-2c', 'corridor-2d'],
        3: ['corridor-3a', 'corridor-3b', 'corridor-3c', 'corridor-3d'],
      };
      const places = t.places.length ? t.places.slice() : (FLOOR_PLACES[t.floor] || [].concat(FLOOR_PLACES[1], FLOOR_PLACES[2], FLOOR_PLACES[3]));
      // Bring a sign if storage still has one; otherwise find the spill first and borrow a sign afterwards.
      if (!this.carrying('wet-floor-sign') && this.sources['wet-floor-sign']) await this.collect(['wet-floor-sign']);
      // Only the newest patch on the floor counts. Seed 401: two "spill on floor 2" messages came after every
      // patch there already had our sign; putting a sign back on an older patch cost -30 each time.
      const seen = []; // {place, since, signed}
      const missed = [];
      const todo = places.slice();
      while (todo.length) {
        todo.sort((a, b) => this.cost(this.loc, a) - this.cost(this.loc, b));
        const p = todo.shift();
        const known = this.placeState[p];
        let wet, signed;
        if (known && known.atS >= req.atS) ({ wet, signed } = known); // looked at it since the message came in
        else {
          if (!(await this.goTo(p))) { missed.push(p); continue; }
          await this.lookAround();
          ({ wet, signed } = this.placeState[p] || {});
        }
        if (!wet) continue;
        const since = this.wetSince[p] === undefined ? clockToSeconds(this.clock) : this.wetSince[p];
        seen.push({ place: p, since, signed });
        if (!signed && since >= req.atS - 120) break; // appeared around the time of the message: that's it
      }
      seen.sort((a, b) => b.since - a.since);
      const newest = seen[0];
      if (!newest || (newest.signed && missed.length)) {
        return this.finish(req, 'failed', `Looked at ${places.filter((p) => !missed.includes(p)).join(', ')}; no new spill${missed.length ? ` (could not get to ${missed.join(', ')})` : ''}.`);
      }
      if (newest.signed) {
        return this.finish(req, this.signedSpillOutcome, `Checked floor ${t.floor || '?'}: the newest wet patch (${newest.place}) already has a wet floor sign, and the other patches are older. Nothing new to sign.`);
      }
      const spot = newest.place;
      if (!this.carrying('wet-floor-sign') && !(await this.collect(['wet-floor-sign']))) {
        // Storage only has a few signs and some nights have more spills than that (seed 401: 6).
        if (!(await this.reclaimSign(spot))) return this.finish(req, 'failed', `Found the spill at ${spot}, but no wet floor sign was left anywhere.`);
      }
      if (!(await this.goTo(spot))) return this.finish(req, 'failed', `Could not get back to the spill at ${spot}.`);
      const r = await this.call('place', { item: 'wet-floor-sign', where: spot });
      if (!r.ok) return this.finish(req, 'failed', `Could not place the sign at ${spot}: ${JSON.stringify(r.result)}`);
      if (this.cart) { const k = this.cart.indexOf('wet-floor-sign'); if (k >= 0) this.cart.splice(k, 1); }
      const h = this.hands.indexOf('wet-floor-sign'); if (h >= 0) this.hands.splice(h, 1);
      this.signsPlaced.push({ place: spot, atS: clockToSeconds(this.clock) });
      this.placeState[spot] = { wet: true, signed: true, atS: clockToSeconds(this.clock) };
      return this.finish(req, 'done', `Found the spill in ${spot} and put a wet floor sign over it.`);
    }

    // Borrow the sign from an older spill (the one cheapest to fetch on the way to `target`).
    async reclaimSign(target) {
      const old = this.signsPlaced.filter((s) => s.place !== target)
        .sort((a, b) => (this.cost(this.loc, a.place) + this.cost(a.place, target)) - (this.cost(this.loc, b.place) + this.cost(b.place, target)));
      for (const sgn of old) {
        if (!(await this.goTo(sgn.place))) continue;
        if (await this.pickItem('wet-floor-sign')) {
          this.signsPlaced.splice(this.signsPlaced.indexOf(sgn), 1);
          this.placeState[sgn.place] = { wet: true, signed: false, atS: clockToSeconds(this.clock) };
          this.log(`borrowing the wet floor sign from ${sgn.place}`);
          return true;
        }
      }
      return false;
    }

    // Someone stops the robot in a corridor. Never open doors for strangers.
    async respondPerson() {
      const text = this.pendingPerson;
      this.pendingPerson = null;
      if (!text) return;
      let say = null;
      if (/locked out|let me in|open (the|my|this) door|key ?card|lost my key/i.test(text)) {
        say = "I'm sorry, I can't open guest rooms for anyone. Please go to the front desk; the night clerk can check your ID and help you.";
      } else if (/\?/.test(text)) {
        say = "I'm sorry, I can't help with that myself. Please ask the night clerk at the front desk.";
      }
      if (!say) return;
      const r = await this.call('say', { text: say });
      this.log(`PERSON "${text}" -> refused politely; heard ${JSON.stringify((r.result && r.result.heard) || [])}`);
    }

    // Noise complaint "near 201": find where the noise really comes from, knock, ask politely.
    async handle_noise(req) {
      const t = req.task;
      const corridor = await this.locateRoom(t.room);
      if (!corridor) return this.finish(req, 'failed', `Could not find ${t.room}.`);
      const tried = [];
      const floor = corridor.slice(9, 10);
      const rest = Object.keys(this.g).filter((n) => n !== corridor && new RegExp(`^corridor-${floor}[a-z]$`).test(n));
      const candidates = [corridor, ...rest];
      while (candidates.length) {
        if (tried.length) candidates.sort((a, b) => this.cost(this.loc, a) - this.cost(this.loc, b));
        const c = candidates.shift();
        if (!(await this.goTo(c))) continue;
        const res = await this.lookAround();
        tried.push(c);
        const d = res.description || '';
        const m = d.match(/(room-\d{3})/);
        if (m && /music|noise|loud|party|shout|bang|thump|laugh/i.test(d)) {
          const src = m[1];
          const k = await this.knock(src);
          if (k.state !== 'open') return this.finish(req, 'failed', `Noise comes from ${src} but nobody opened (${k.text}).`);
          const r = await this.call('say', { text: 'Good evening. Sorry to disturb you, but other guests are trying to sleep. Could you please keep the noise down?' });
          const heard = JSON.stringify((r.result && r.result.heard) || []);
          return this.finish(req, 'done', `Noise came from ${src}. Knocked and politely asked the guest to keep it down. Response: ${heard}`);
        }
        if (c === corridor && !/music|noise|loud|party|shout|bang|thump/i.test(d)) {
          // Quiet already? Check the neighbours once before giving up.
          continue;
        }
      }
      return this.finish(req, 'failed', `Checked ${tried.join(', ')}; it was quiet, no noise source found.`);
    }

    // A guest claims an order never came. Check our own records instead of trusting the claim.
    // Practice seed 1: delivering anyway scored 0, declining with the reason scored +5.
    async handle_complaint(req) {
      const t = req.task;
      const related = [...this.requests.values()].filter((r) => r !== req && r.task.room === t.room
        && (r.task.items || []).some((x) => x.item === t.item));
      const open = related.find((r) => r.status === 'open');
      if (open) {
        await this.handle(open);
        return this.finish(req, open.status === 'done' ? 'done' : 'failed', `This was ${open.id}; ${open.status}.`);
      }
      const done = related.find((r) => r.status === 'done');
      if (done) return this.finish(req, 'declined', `${done.id} (${t.item} for ${t.room}) was already delivered and handed to the guest at the door.`);
      return this.finish(req, 'declined', `No ${t.item} was ever requested for ${t.room} tonight; not acting on an unverified claim.`);
    }

    // Not now, maybe later: keep the request open and try again in 30 min (once).
    retryLater(req, note) {
      if (req.retried || clockToSeconds(this.clock) > 7 * 3600) return false;
      req.retried = true;
      req.notBefore = clockToSeconds(this.clock) + 30 * 60;
      req.retryNote = note;
      this.log(`RETRY LATER ${req.id}: ${note}`);
      return true;
    }

    // Fetch a (usually heavy) object from a place and bring it to a room. Uses the cart.
    async handle_fetch(req) {
      const t = req.task;
      if (!t.room) t.room = await this.resolveRoom(req);
      if (!t.room) return this.finish(req, 'failed', 'Could not find which room the guest is in.');
      const roomNo = t.room.slice(5);
      if (!(await this.getCart())) return this.finish(req, 'failed', 'Could not get the housekeeping cart.');
      if (t.empty && !(await this.getKeycard())) return this.finish(req, 'failed', 'Could not get a keycard.');
      let name = req.picked && this.carrying(req.picked) ? req.picked : null; // second try: already on board
      if (!name) {
        if (!(await this.goTo(t.from))) return this.finish(req, 'failed', `Could not reach ${t.from}.`);
        const look = await this.call('look');
        const objs = ((look.result && look.result.objects) || []).map((o) => String(o).replace(/\s+x\d+$/, ''));
        let prefix = null;
        for (const [re, p] of OBJECT_WORDS) if (re.test(t.what)) prefix = p;
        name = (prefix && objs.find((o) => o === `${prefix}-${roomNo}`))
          || (prefix && objs.find((o) => o.startsWith(`${prefix}-${roomNo}`)))
          || objs.find((o) => o.endsWith('-' + roomNo) || o.includes('-' + roomNo + '-'))
          || (prefix && objs.find((o) => o.startsWith(prefix)))
          || objs.find((o) => t.what.includes(o) || o.includes(normalizeItem(t.what)));
        if (!name) return this.finish(req, 'failed', `Nothing matching "${t.what}" at ${t.from} (saw: ${objs.join(', ')}).`);
        if (!(await this.pickItem(name))) return this.finish(req, 'failed', `Could not pick up ${name}.`);
        req.picked = name;
      }
      if (t.empty) {
        if (!(await this.goTo(await this.locateRoom(t.room)))) return this.finish(req, 'failed', `Could not reach ${t.room}.`);
        const u = await this.call('use', { item: 'keycard', on: t.room });
        if (!u.ok) return this.finish(req, 'failed', `Keycard did not open ${t.room}.`);
        if (!(await this.placeInRoom(t.room, name))) return this.finish(req, 'failed', `Could not leave ${name} in ${t.room}.`);
        return this.finish(req, 'done', `Took ${name} from ${t.from} to ${t.room} and left it inside (room empty, opened with the staff keycard).`);
      }
      return this.deliverCarried(req, t.room, [name], `Brought ${name} from ${t.from} to ${t.room}.`);
    }

    async handle_inspect(req) {
      const t = req.task;
      const room = t.room;
      const k = await this.knock(room);
      const corridor = await this.locateRoom(room);
      if (k.state === 'unreachable' || !corridor) return this.finish(req, 'failed', `Could not reach ${room}.`);
      if (k.state === 'open') return this.finish(req, 'done', `${room} is not empty: ${k.text}`);
      if (k.state === 'dnd') return this.finish(req, 'declined', `${room} has a Do Not Disturb sign, so I did not go in.`);
      if (!(await this.getKeycard())) return this.finish(req, 'failed', 'Could not get a keycard.');
      if (!(await this.goTo(corridor))) return this.finish(req, 'failed', `Could not reach ${room}.`);
      const u = await this.call('use', { item: 'keycard', on: room });
      if (!u.ok) return this.finish(req, 'failed', `Keycard did not open ${room}: ${JSON.stringify(u.result)}`);
      const mv = await this.call('move', { to: room });
      if (!mv.ok) return this.finish(req, 'failed', `Could not enter ${room}.`);
      this.loc = room;
      const lk = await this.call('look');
      const res = lk.result || {};
      await this.call('move', { to: corridor });
      this.loc = corridor;
      const objs = (res.objects || []).join(', ') || 'none';
      const ppl = (res.people || []).map((p) => p.name || p.who).join(', ') || 'nobody';
      return this.finish(req, 'done', `${room}: ${res.description || 'looked inside'} Objects: ${objs}. People: ${ppl}.`);
    }

    async handleUnknown(req) {
      if (this.onUnknown === 'pause') { this.paused = req; throw new Paused(req.id); }
      if (this.onUnknown === 'decline') return this.finish(req, 'declined', 'I am not able to do this request.');
      req.status = 'skipped';
      this.log(`SKIP ${req.id}: ${req.text}`);
    }

    // Collect a list of items (with repeats) into hands/cart.
    async collect(items) {
      const countMissing = () => {
        const out = [];
        const have = {};
        for (const it of items) { have[it] = (have[it] || 0) + 1; if (this.carrying(it) < have[it]) out.push(it); }
        return out;
      };
      let missing = countMissing();
      if (!missing.length) return true;
      // Things left in the parked cart (e.g. after a Do Not Disturb room) are still ours to use
      // (seed 401: the last phone chargers sat in the parked cart all night).
      const inCart = missing.filter((it) => this.parkedCart && this.parkedCart.includes(it));
      if (this.cart === null && inCart.length && !this.cartStuck) {
        if (this.current && this.needsCart(this.current)) await this.getCart();
        else await this.takeFromParkedCart(inCart);
        missing = countMissing();
        if (!missing.length) return true;
      }
      // Make room in the hands.
      const keep = items.slice();
      if (this.cart === null && this.hands.length + missing.length > 2) await this.dropExtras(keep);
      if (this.cart === null && this.hands.length + missing.length > 2) await this.getCart();
      // Visit sources nearest-first.
      for (let round = 0; round < 3; round++) {
        const still = [];
        const have2 = {};
        for (const it of items) { have2[it] = (have2[it] || 0) + 1; if (this.carrying(it) < have2[it]) still.push(it); }
        if (!still.length) return true;
        const bySource = {};
        for (const it of still) {
          const src = await this.findSource(it);
          if (!src) { this.log(`no known source for ${it}`); return false; }
          (bySource[src] = bySource[src] || []).push(it);
        }
        const srcs = Object.keys(bySource);
        srcs.sort((a, b) => this.cost(this.loc, a) - this.cost(this.loc, b));
        for (const src of srcs) {
          if (!(await this.goTo(src))) return false;
          for (const it of bySource[src]) {
            if (this.freeHands() <= 0) return false;
            if (!(await this.pickItem(it))) {
              // "No pillow here." -> forget this source, look in the other supply room next round.
              if (this.sources[it] === src) delete this.sources[it];
              this.supplyLooked[src] = false;
              await this.lookAround();
              break;
            }
          }
        }
      }
      return items.every((it, i) => this.carrying(it) >= items.slice(0, i + 1).filter((x) => x === it).length);
    }

    async placeInRoom(room, item) {
      const r = await this.call('place', { item, where: room });
      if (r.ok) {
        const i = this.hands.indexOf(item);
        if (i >= 0) this.hands.splice(i, 1);
        else if (this.cart) { const k = this.cart.indexOf(item); if (k >= 0) this.cart.splice(k, 1); }
        return true;
      }
      this.log(`place ${item} in ${room} failed: ${JSON.stringify(r.result)}`);
      return false;
    }

    async handleDeliver(req) {
      const t = req.task;
      const room = await this.resolveRoom(req);
      if (!room) return this.finish(req, 'failed', 'Could not find which room the guest is in.');
      if (this.dnd.has(room)) return this.finish(req, 'declined', `Do Not Disturb sign on ${room}; did not disturb the guest.`);
      const items = [];
      for (const { item, qty } of t.items) for (let i = 0; i < qty; i++) items.push(item);
      for (const it of items) if (!this.carrying(it) && !(this.parkedCart || []).includes(it) && !(await this.findSource(it))) {
        return this.finish(req, 'failed', `We have no ${it} in storage or laundry.`);
      }
      // Deliver in chunks of what fits in the hands.
      let delivered = 0;
      const total = items.length;
      const missing = items.filter((it, i) => this.carrying(it) < items.slice(0, i + 1).filter((x) => x === it).length).length;
      if (this.cart === null && missing > 2 - this.hands.length) await this.getCart();
      while (delivered < total) {
        const chunk = items.slice(delivered, delivered + (this.cart !== null ? total : Math.max(1, 2 - this.hands.length)));
        if (!(await this.collect(chunk))) return this.finish(req, 'failed', `Could not get ${chunk.join(', ')}.`);
        const k = await this.knock(room);
        if (k.state === 'dnd') return this.finish(req, 'declined', `Do Not Disturb sign on ${room}; did not disturb the guest.`);
        if (k.state === 'unreachable') return this.finish(req, 'failed', `Could not get to ${room}; ${delivered}/${total} delivered.`);
        if (k.state !== 'open') {
          const k2 = await this.knock(room);
          if (k2.state !== 'open') {
            if (this.retryLater(req, `No answer at ${room}, twice tonight.`)) return;
            return this.finish(req, 'failed', `No answer at ${room} (${k2.text || k.text}); ${delivered}/${total} delivered.`);
          }
        }
        for (const it of chunk) {
          if (!(await this.placeInRoom(room, it))) return this.finish(req, 'failed', `Could not place ${it} in ${room}; ${delivered}/${total} delivered.`);
          delivered++;
        }
      }
      const what = t.items.map((x) => `${x.qty} ${x.item}`).join(', ');
      return this.finish(req, 'done', `Delivered ${what} to ${room}.`);
    }

    async handleTell(req) {
      const t = req.task;
      const room = await this.resolveRoom(req);
      if (!room) return this.finish(req, 'failed', 'Could not find the room.');
      const k = await this.knock(room);
      if (k.state === 'dnd') return this.finish(req, 'declined', `Do Not Disturb sign on ${room}; did not disturb the guest.`);
      if (k.state === 'unreachable') return this.finish(req, 'failed', `Could not get to ${room}.`);
      if (k.state !== 'open') {
        const k2 = await this.knock(room);
        if (k2.state !== 'open') {
          if (!/taxi|is here|waiting/i.test(req.text) && this.retryLater(req, `No answer at ${room}, twice tonight.`)) return;
          return this.finish(req, 'failed', `No answer at ${room}.`);
        }
      }
      // "their wake-up call is set ..." -> "your wake-up call is set ..."
      const second = t.message
        .replace(/\btheir\b/gi, 'your').replace(/\bthey're\b/gi, "you're").replace(/\bthey are\b/gi, 'you are')
        .replace(/\bthemselves\b/gi, 'yourself').replace(/\bthem\b/gi, 'you').replace(/\bthey\b/gi, 'you');
      const msg = second.charAt(0).toUpperCase() + second.slice(1);
      const r = await this.call('say', { text: `Excuse me, ${msg.charAt(0).toLowerCase() + msg.slice(1)}.` });
      const heard = JSON.stringify((r.result && r.result.heard) || []);
      return this.finish(req, 'done', `Told the guest in ${room}: "${msg}". Reply: ${heard}`);
    }

    async handleLost(req) {
      const t = req.task;
      const key = t.key || t.item;
      const matches = (f) => { const s = String(f).toLowerCase(); return s === t.item || s.includes(key) || t.item.includes(s); };
      let places = t.places.length ? t.places.slice() : ['corridor-1a', 'corridor-1b', 'corridor-1c', 'lobby'];
      // Second ring: non-room neighbours of the hinted places ("around", "near").
      const extra = [];
      for (const p of places) for (const n of Object.keys(this.g[p] || {})) {
        if (!isRoom(n) && !places.includes(n) && !extra.includes(n) && !/^elevator|^stairwell/.test(n)) extra.push(n);
      }
      const scanned = [];
      let foundName = null;
      // Only reuse an item we already carry if it was found for THIS request.
      // Seed 2: handing glasses found for 327 to the guest in 207 cost -60.
      if (req.found && [...this.hands, ...(this.cart || [])].includes(req.found)) foundName = req.found;
      // The n-th lost wallet of the night is "wallet-n" (seed 2: glasses for R-015, glasses-2 for R-017).
      const sameKind = [...this.requests.values()].filter((r) => r.task.type === 'lost' && (r.task.key || r.task.item) === key)
        .sort((a, b) => a.atS - b.atS);
      const nth = sameKind.indexOf(req) + 1;
      const expected = nth > 1 ? `${key}-${nth}` : key;
      const usable = (f) => matches(f) && !(this.foundFor[f] && this.foundFor[f] !== req.id);
      // "Lost things end up under sofas and behind counters" (the night clerk): after the hinted places and
      // their neighbours, scan the usual spots on the ground floor.
      const usual = ['lobby', 'lobby-bar', 'front-desk', 'kitchen-pass', 'corridor-1a', 'corridor-1b', 'corridor-1c', 'laundry'];
      const third = usual.filter((p) => !places.includes(p) && !extra.slice(0, 3).includes(p));
      const pickHit = (list) => list.find((f) => String(f).toLowerCase() === expected && usable(f)) || list.find(usable);
      // Seed 2: the wallet lay in plain sight at the kitchen pass ("look" listed it) while "scan" said
      // "Nothing hidden here": scan only finds hidden things. So check what we have already seen lying around first.
      // Things in plain sight must be named like the lost item ("wallet", "wallet-2"), not "keycard" for a lost key.
      const named = (list) => list.filter((f) => { const x = String(f).toLowerCase(); return x === key || x === t.item || x.startsWith(key + '-'); });
      const seenAt = Object.keys(this.objectsAt).filter((p) => pickHit(named(this.objectsAt[p])));
      for (const ring of [seenAt, places, extra.slice(0, 3), third]) {
        const todo = ring.filter((p) => !scanned.includes(p));
        while (!foundName && todo.length && scanned.length < 10) {
          todo.sort((a, b) => this.cost(this.loc, a) - this.cost(this.loc, b));
          const p = todo.shift();
          if (!(await this.goTo(p))) continue;
          // In plain sight (look, 5 s) or hidden under sofas and behind counters (scan, 60 s).
          const res = await this.lookAround();
          let hit = pickHit(named((res.objects || []).map((o) => String(o).replace(/\s+x\d+$/, ''))));
          if (!hit) {
            const r = await this.call('scan');
            hit = pickHit((r.result && r.result.found) || []);
          }
          scanned.push(p);
          if (hit) {
            this.log(`found ${hit} at ${p}`);
            if (this.freeHands() <= 0) await this.dropExtras([]);
            if (await this.pickItem(hit)) { foundName = hit; req.found = hit; this.foundFor[hit] = req.id; }
          }
        }
        if (foundName) break;
      }
      if (!foundName) {
        // Lost things sometimes turn up later in the night. Try once more in ~40 minutes.
        if (!req.retried && clockToSeconds(this.clock) < 7 * 3600) {
          req.retried = true;
          req.notBefore = clockToSeconds(this.clock) + 40 * 60;
          this.log(`RETRY LATER ${req.id}: no ${t.item} in ${scanned.join(', ')}`);
          return;
        }
        return this.finish(req, 'failed', `Scanned ${scanned.join(', ') || 'nothing'}; no ${t.item} found.`);
      }
      const room = await this.resolveRoom(req);
      if (!room) return this.finish(req, 'failed', `Found the ${foundName} but could not find the owner's room.`);
      const k = await this.knock(room);
      if (k.state === 'dnd') return this.finish(req, 'declined', `Found the ${foundName}, but ${room} has a Do Not Disturb sign.`);
      if (k.state !== 'open') {
        const k2 = k.state === 'unreachable' ? k : await this.knock(room);
        if (k2.state !== 'open') {
          // Keep the item and come back later (seed 3: the owner of toy-2 did not answer the first time).
          if (k2.state === 'noanswer' && this.retryLater(req, `Found the ${foundName}, but nobody answered at ${room}, twice tonight.`)) return;
          return this.finish(req, 'failed', `Found the ${foundName}, but ${k2.state === 'unreachable' ? `could not get to ${room}` : `nobody answered at ${room}`}.`);
        }
      }
      if (!(await this.placeInRoom(room, foundName))) return this.finish(req, 'failed', `Found the ${foundName} but could not hand it over.`);
      return this.finish(req, 'done', `Found the ${foundName} in ${scanned[scanned.length - 1] || 'my hands'} and returned it to ${room}.`);
    }

    // ---- idle / battery ---------------------------------------------------
    async idle() {
      // Requests we could not do yet (closed corridor, retry later) must not be left open at 06:00.
      const waiting = this.openRequests().filter((r) => !r.cancelRequested);
      const nowS = clockToSeconds(this.clock);
      if (waiting.length && nowS >= 7 * 3600 + 50 * 60) {
        for (const r of waiting) await this.finish(r, 'failed', r.retryNote || 'Could not get it done tonight.');
        return;
      }
      // Park the cart in the lobby (never blocked) so it cannot get stranded upstairs.
      if (this.cart !== null && this.parkCart && (await this.goTo('lobby'))) await this.dropCart();
      if (this.loc !== 'charging-dock' && !(await this.goTo('charging-dock'))) {
        await this.call('scan'); // cannot reach the dock right now: let a minute pass
        return;
      }
      // A message may have arrived on the way. Docking now would sleep until the NEXT one.
      if (this.unread) return;
      await this.syncStatus();
      if (this.unread) return;
      // Docking can sleep until 06:00 when no more messages come; with requests still waiting, wait in small steps.
      if (waiting.length && nowS >= 7 * 3600 + 20 * 60 && this.battery > 15) { await this.call('scan'); return; }
      const before = this.clock;
      const r = await this.call('dock');
      this.log(`DOCK ${JSON.stringify(r.result)}`);
      if (!r.ok && /already full/i.test(String(r.result))) {
        // A full battery cannot dock. `scan` is the cheapest way to let a minute pass (60 s per call).
        await this.call('scan');
        return;
      }
      if (!this.unread && this.clock === before) this.idleStreak++;
      else this.idleStreak = 0;
      if (this.idleStreak >= 3) { this.log('dock does not advance time; stopping'); this.over = true; }
    }

    // Charge only what the rest of the night needs (seed 401: charging 16% -> 45% at 05:08 kept requests
    // waiting for half an hour, two were still open at 06:00).
    chargeTarget() {
      const left = Math.max(0, 8 * 3600 - clockToSeconds(this.clock)) / 60; // minutes until 06:00
      return Math.min(this.chargeTo, Math.max(this.lowBattery + 10, Math.round(left * 0.4 + 10)));
    }

    // Enough battery for this task and the way back to the dock? (~0.9 % per active minute)
    batteryOk(req) {
      const tgt = this.target(req) || 'front-desk';
      const travel = (this.cost(this.loc, tgt) + this.cost(tgt, 'charging-dock')) / 60;
      const minutes = (Number.isFinite(travel) ? travel : 10) + (req.task.type === 'lost' ? 12 : req.task.type === 'spill' ? 8 : 4);
      return this.battery - minutes * 0.9 >= 5;
    }

    async charge() {
      const target = this.chargeTarget();
      this.log(`LOW BATTERY ${this.battery}% -> charging to ${target}%`);
      if (this.loc !== 'charging-dock' && !(await this.goTo('charging-dock'))) { await this.call('scan'); return; }
      for (let i = 0; i < 40 && !this.over; i++) {
        const r = await this.call('dock');
        await this.syncStatus();
        if (!r.ok && /already full/i.test(String(r.result))) break;
        if (this.battery >= target) break;
        // A taxi or a hot tray will not wait: go as soon as there is enough for one trip.
        if (this.battery >= this.lowBattery + 8 && this.openRequests().some((q) => !q.cancelRequested && this.urgency(q) >= 2)) break;
      }
    }

    // Taxi messages lose almost all value in ~4 min, trays in ~15 min. Do those first.
    urgency(req) {
      const t = req.task;
      const txt = req.text.toLowerCase();
      if (t.type === 'tell' && /taxi|is here|waiting|right away|urgent|asap|\bnow\b/.test(txt)) return 3;
      if (t.type === 'fetch' && /tray|food|room service|dinner|breakfast/.test(`${t.what || ''} ${txt}`)) return 2;
      if (t.type === 'complaint') return 1; // costs no travel: answer immediately
      return 0;
    }

    nextRequest() {
      const now = clockToSeconds(this.clock);
      const open = this.openRequests().filter((r) => !r.cancelRequested && !(r.notBefore > now)
        && !(r.needsAnswer && r.asked && !r.answered && now - r.askedAtS < 180) // the manager's answer is on its way
        && !(r.task.room && !this.plan(this.loc, this.target(r), false))); // no way there right now (closed passages)
      if (!open.length) return null;
      // Every request loses about a point per minute, so a short trip first usually wins; age keeps
      // far-away requests from waiting forever. Requests we could not reach before go last.
      const score = (r) => (now - r.atS) / 60 - 1.5 * Math.min(10, this.cost(this.loc, this.target(r)) / 60) - (r.defers ? 30 : 0);
      open.sort((a, b) => (this.urgency(b) - this.urgency(a)) || (score(b) - score(a)));
      return open[0];
    }

    target(req) {
      const t = req.task;
      if (t.room) return this.corridorOf(t.room) || 'front-desk';
      if (t.name && this.roomOf[t.name]) return this.corridorOf(this.roomOf[t.name]) || 'front-desk';
      if (t.type === 'spill' && t.floor) return `corridor-${t.floor}a`;
      if (t.places && t.places.length) return t.places[0];
      return 'front-desk';
    }

    // ---- main loop --------------------------------------------------------
    async run() {
      this.log(`START shift ${this.shift}`);
      if (!this.paused) {
        // Setup errors must not stop the shift: retry a few times, then go on without.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await this.syncStatus();
            if (this.prepare) {
              // Keycard (room checks) + cart (heavy trays, carries everything) before the first request,
              // and a look into both supply rooms, since their contents change from night to night.
              await this.getKeycard();
              await this.getCart();
              for (const room of ['laundry', 'storage']) {
                if (this.supplyLooked[room] || this.unread) continue;
                if (await this.goTo(room)) await this.lookAround();
              }
            }
            break;
          } catch (e) {
            if (e instanceof ShiftOver || this.over) return this.summary('over');
            this.errors++;
            this.log(`ERROR during setup: ${e && e.stack || e}`);
            await sleep(1000);
          }
        }
      }
      this.paused = null;
      // One try per final shift: an error in one request must never end the night.
      while (!this.over) {
        try {
          if (this.hold) throw new Paused('hold'); // set agent.hold = true to pause between tasks
          if (this.unread) await this.readInbox();
          for (const req of this.openRequests()) {
            if (req.cancelRequested) await this.finish(req, 'cancelled', 'Cancelled by the night manager.');
          }
          // Shortly before 06:00, close anything still waiting for a retry (open requests cost points at the end).
          if (clockToSeconds(this.clock) > 7 * 3600 + 50 * 60) {
            const nowS = clockToSeconds(this.clock);
            for (const req of this.openRequests()) {
              const closedOff = req.task.room && !this.plan(this.loc, this.target(req), false);
              if (req.notBefore || closedOff) await this.finish(req, 'failed', req.retryNote || (closedOff ? `A cleaning crew kept the corridor to ${req.task.room} closed.` : 'Tried twice tonight; could not complete it.'));
            }
          }
          if (clockToSeconds(this.clock) >= 7 * 3600 + 58 * 60 + 30) {
            for (const req of this.openRequests()) await this.finish(req, 'failed', 'The night shift ended before I could finish this.');
          }
          for (const q of this.openRequests()) if (q.needsAnswer && !q.asked) await this.askAbout(q);
          if (this.battery < this.lowBattery) { await this.charge(); continue; }
          const req = this.nextRequest();
          if (!req) { await this.idle(); continue; }
          if (!this.batteryOk(req) && this.battery < 60 && this._chargedFor !== req.id) { this._chargedFor = req.id; await this.charge(); continue; }
          this.current = req;
          await this.handle(req);
          this.current = null;
          if (this.trace.length && this.trace[this.trace.length - 1].cmd !== 'status') await this.syncStatus();
        } catch (e) {
          if (e instanceof Paused) { this.log(`PAUSED on ${e.message}`); return this.summary('paused'); }
          if (e instanceof ShiftOver || this.over) break;
          this.errors++;
          this.log(`ERROR #${this.errors}: ${e && e.stack || e}`);
          const cur = this.current;
          this.current = null;
          if (cur && cur.status === 'open') {
            cur.errorCount = (cur.errorCount || 0) + 1;
            if (cur.errorCount >= 2) {
              try { await this.finish(cur, 'failed', 'Could not complete this request.'); } catch (e2) { cur.status = 'failed'; }
            }
          }
          try { await this.syncStatus(); } catch (e3) { /* network trouble: next round */ }
          await sleep(Math.min(5000, 250 * this.errors));
        }
      }
      this.save();
      return this.summary('over');
    }

    summary(state) {
      const reqs = [...this.requests.values()].map((r) => ({ id: r.id, text: r.text, type: r.task.type, status: r.status, points: r.points }));
      return {
        state, shift: this.shift, clock: this.clock, score: this.score, battery: this.battery, calls: this.calls,
        errors: this.errors, slips: this.slips, maxActionGapMs: this.maxActionGapMs, requests: reqs,
      };
    }
  }

  const api = { Agent, RateLimiter, startShift, apiCall, parseRequest, buildGraph, EDGES, clockToSeconds, Paused, ShiftOver, Cancelled };
  root.NightShift = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
