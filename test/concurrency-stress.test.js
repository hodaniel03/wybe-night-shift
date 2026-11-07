'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Agent,RateLimiter}=require('../src/agent');

test('ten concurrent agents survive throttles, 503 queries and lost delivery receipts without duplicate effects', {timeout:30000}, async()=>{
 const previous=global.fetch, limiter=new RateLimiter({rate:40,burst:20});
 const states=new Map(), snapshots=new Map();const faults={throttle:0,query503:0,lostReceipt:0};let traffic=0;
 const reply=(result,status=200)=>new Response(JSON.stringify({ok:status===200,clock:'23:00:00',result,events:[]}),{status});
 global.fetch=async(url,opts)=>{
  assert.equal(url,'https://local-stress.invalid/');traffic++;
  const shift=opts.headers['X-Shift'],{cmd,args}=JSON.parse(opts.body),s=states.get(shift);
  assert.ok(s,'shift state must remain isolated');
  if(cmd==='pick'&&!s.throttled){s.throttled=true;faults.throttle++;return reply('Too many requests',429);}
  if(cmd==='status'&&!s.queryFailed){s.queryFailed=true;faults.query503++;return reply('Unavailable',503);}
  if(cmd==='status')return reply({location:'corridor-1a',battery:90,hands:s.hands.slice(),cart:null,score:s.delivered*30,unread_messages:0});
  if(cmd==='pick'){assert.equal(s.hands.length,0);s.hands.push(args.item);return reply('Picked up towel, in hand.');}
  if(cmd==='place'){
   assert.equal(s.hands.shift(),'towel');s.delivered++;
   if(s.delivered===1||s.delivered===4){faults.lostReceipt++;throw Error('Injected: receipt lost after server applied placement');}
   return reply('Placed towel inside room-101.');
  }
  if(cmd==='report')return reply('Noted. Thanks.');
  throw Error('Unexpected command '+cmd);
 };
 try{
  const agents=Array.from({length:10},(_,i)=>{
   const shift='stress-'+i;states.set(shift,{hands:[],delivered:0});
   const a=new Agent({key:'test-only',base:'https://local-stress.invalid/',shift,limiter,minGapMs:0,prepare:false,log:()=>{},onSave:s=>snapshots.set(shift,structuredClone(s))});
   a.loc='corridor-1a';a.unread=false;return a;
  });
  await Promise.all(agents.map(async a=>{
   for(let n=1;n<=6;n++){
    const req={id:'R-'+n,status:'open',updates:[],delivered:0,task:{type:'deliver',room:'room-101',items:[{item:'towel',qty:1}]}};
    a.requests.set(req.id,req);a.current=req;
    assert.equal(await a.pickItem('towel'),true);
    assert.equal(await a.placeInRoom('room-101','towel'),true);req.delivered=1;
    await a.finish(req,'done','Confirmed delivery');a.current=null;
   }
  }));
  assert.deepEqual(faults,{throttle:10,query503:10,lostReceipt:20});
  for(const a of agents){assert.equal(states.get(a.shift).delivered,6);assert.deepEqual(a.hands,[]);assert.equal(a.summary('over').requests.filter(r=>r.status==='done').length,6);assert.equal(snapshots.get(a.shift).shift,a.shift);}
  const maxGap=Math.max(...agents.map(a=>a.maxActionGapMs));assert.ok(maxGap<20000,`Local mock action gap ${maxGap}ms exceeded cadence`);
  console.log(JSON.stringify({stress:'local mock only',agents:10,deliveries:60,traffic,faults,maxActionGapMs:maxGap,duplicateDeliveries:0}));
 } finally {global.fetch=previous;}
});
