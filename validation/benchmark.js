'use strict';
const fs = require('node:fs');
const path = require('node:path');
const original = '/Users/hodanielkhuu/vscode/wybe-night-shift';
const variant = process.argv[2] || 'candidate';
const seeds = process.argv.slice(3).map(Number);
if (!seeds.length || seeds.some(s => !Number.isInteger(s) || s < 1 || s > 999)) throw Error('Provide practice seeds');
const { Agent, startShift, RateLimiter } = require(variant.startsWith('baseline') ? './baseline-agent.js' : '../src/agent.js');
const env = fs.readFileSync(path.join(original, '.env'), 'utf8');
const key = process.env.NS_KEY || env.match(/^NS_KEY\s*=\s*(.*?)\s*$/m)?.[1].replace(/^['"]|['"]$/g, '');
const limiter = new RateLimiter();
const dir = path.join(__dirname, `${variant}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(variant.startsWith('baseline') ? path.join(__dirname,'baseline-agent.js') : path.join(__dirname,'../src/agent.js'),path.join(dir,'agent.snapshot.js'));
fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({variant,mode:'practice',seeds,node:process.versions.node,sourceHash:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dir,'agent.snapshot.js'))).digest('hex'),options:{maxSearchLocations:process.env.SEARCH_LOCATIONS ? Number(process.env.SEARCH_LOCATIONS) : 10}},null,2));
const results = [];
async function one(seed) {
 const info = await startShift({ key, mode: 'practice', seed });
 fs.writeFileSync(path.join(dir, `seed${seed}.shift.json`), JSON.stringify(info));
 const out = fs.createWriteStream(path.join(dir, `seed${seed}.log`));
 const agent = new Agent({ key, shift: info.shift, limiter, ...(process.env.SEARCH_LOCATIONS ? {maxSearchLocations:Number(process.env.SEARCH_LOCATIONS)} : {}), onUnknown: 'decline', log: line => out.write(line + '\n'), onSave: state => fs.writeFileSync(path.join(dir, `seed${seed}.state.json`), JSON.stringify(state)) });
 const start = Date.now();
 console.log(`START ${variant} seed ${seed} ${info.shift}`);
 let summary;
 try { summary = await agent.run(); } catch(e) { summary = {...agent.summary('crash'), error: String(e)}; }
 summary.realSeconds = (Date.now()-start)/1000;
 fs.writeFileSync(path.join(dir, `seed${seed}.summary.json`), JSON.stringify(summary,null,2));
 fs.writeFileSync(path.join(dir, `seed${seed}.trace.json`), JSON.stringify(agent.trace));
 out.end();
 results.push({seed,...summary});
 console.log(`DONE ${variant} seed ${seed}: score=${summary.score}, state=${summary.state}, errors=${summary.errors}, slips=${summary.slips}, gap=${summary.maxActionGapMs}ms, time=${summary.realSeconds}s`);
}
(async()=>{
 for (let i=0;i<seeds.length;i+=4) await Promise.all(seeds.slice(i,i+4).map(one));
 fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(results,null,2));
 console.log(`RESULTS ${dir}`);
})().catch(e=>{ console.error(e.message); process.exitCode=1; });
