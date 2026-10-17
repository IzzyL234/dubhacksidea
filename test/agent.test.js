import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decide,recommend,overlaps,parseFlyer,interval} from '../src/agent.js';
import {Store,SupabaseStore} from '../src/store.js';
import {Agent} from '../src/service.js';
import {Calendar,extractImage} from '../src/integrations.js';
import {createApp} from '../src/server.js';
import {request as httpRequest} from 'node:http';
const clock=()=>new Date('2026-10-17T16:00:00Z');
function fixture(t,calendar={enabled:false}) {const dir=mkdtempSync(join(tmpdir(),'daywise-'));const store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true});});return {store,agent:new Agent(store,calendar,{now:clock,env:{}})};}
test('decision model honors weights, costs, energy, conflict, and input bounds',()=>{
  const base={academic:10,social:0,wellbeing:0,career:0,cost:0,energy:10};
  assert.equal(decide({...base,weights:{academic:1,social:0,wellbeing:0,career:0}}).score,100);
  assert.equal(decide({...base,cost:10,energy:0}).score,0);
  assert.equal(decide({...base,conflict:true}).recommendation,'Reschedule');
  for(const v of [-1,11,NaN,'',null])assert.throws(()=>decide({...base,academic:v}));
  assert.throws(()=>decide({...base,weights:{academic:0,social:0,wellbeing:0,career:0}}));
});
test('ratings change ranking; priors shrink sparse evidence; unrated data ignored',()=>{
  const candidates=[{start:'2026-10-18T09:00:00Z',end:'2026-10-18T10:00:00Z',localHour:9},{start:'2026-10-18T16:00:00Z',end:'2026-10-18T17:00:00Z',localHour:16}];
  assert.equal(recommend([],candidates)[0].localHour,9);
  const ranked=recommend([{localHour:9,rating:1},{localHour:16,rating:5},{localHour:9}],candidates);
  assert.equal(ranked[0].localHour,16);assert.equal(ranked[0].predictedRating,3.5);assert.equal(ranked[0].evidence,1);
});
test('interval validation rejects naive/reversed dates and respects adjacent blocks',()=>{
  assert.throws(()=>interval('2026-10-17T10:00','2026-10-17T11:00'));
  assert.throws(()=>interval('2026-10-17T11:00Z','2026-10-17T10:00Z'));
  assert.equal(overlaps({start:'2026-10-17T10:00Z',end:'2026-10-17T11:00Z'},{start:'2026-10-17T11:00Z',end:'2026-10-17T12:00Z'}),false);
});
test('persistent SQLite records survive reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'daywise-persist-')),path=join(dir,'db');const a=new Store(path);
  return a.put('sessions',{id:'s',rating:4}).then(async()=>{a.close();const b=new Store(path);assert.equal((await b.list('sessions'))[0].rating,4);b.close();rmSync(dir,{recursive:true});});
});
test('calendar proposal requires confirmation, rejects fresh conflicts, and is idempotent',async t=>{
  let busy=[],writes=0;
  const {agent,store}=fixture(t,{enabled:true,busy:async()=>busy,create:async()=>{writes++;return {id:'remote'};}});
  const proposal=await agent.propose({title:'Math',start:'2026-10-17T18:00Z',end:'2026-10-17T19:00Z',study:true,localHour:11});
  assert.equal(writes,0);assert.equal((await store.list('sessions')).length,0);
  busy=[proposal];await assert.rejects(()=>agent.confirm({id:proposal.id}),/busy/);assert.equal(writes,0);
  busy=[];await agent.confirm({id:proposal.id});await agent.confirm({id:proposal.id});assert.equal(writes,1);assert.equal((await store.list('sessions')).length,1);
});
test('uncertain calendar writes are held for reconciliation',async t=>{
  const {agent}=fixture(t,{enabled:true,busy:async()=>[],create:async()=>{throw new Error('timeout');}});
  const e=await agent.propose({title:'Event',start:'2026-10-17T18:00Z',end:'2026-10-17T19:00Z'});
  await assert.rejects(()=>agent.confirm({id:e.id}),/timeout/);
  await assert.rejects(()=>agent.confirm({id:e.id}),/uncertain/);
});
test('available slots exclude busy time; calendar failures do not imply free time',async t=>{
  const busy={start:'2026-10-17T16:00Z',end:'2026-10-18T00:00Z'};
  const {agent}=fixture(t,{enabled:true,busy:async()=>[busy]});
  const result=await agent.candidates({minutes:50,offsetMinutes:-420});assert(result.slots.length);assert(result.slots.every(s=>!overlaps(s,busy)));
  agent.calendar.busy=async()=>{throw new Error('unavailable');};await assert.rejects(()=>agent.candidates({}),/unavailable/);
});
test('rating commands deduplicate, future ratings rejected, proactive prompts deduplicate and ack',async t=>{
  const {agent}=fixture(t);
  const s=await agent.session({title:'Math',start:'2026-10-17T14:00Z',end:'2026-10-17T15:00Z',localHour:7});
  assert.equal((await agent.tick()).length,1);assert.equal((await agent.tick()).length,1);
  const [p]=await agent.tick();await agent.ack({id:p.id});assert.equal((await agent.tick()).length,0);
  const command={id:'message1',text:`rate ${s.id} 5`};await agent.message(command);await agent.message({...command,text:`rate ${s.id} 1`});assert.equal((await agent.status()).sessions[0].rating,5);
  const f=await agent.session({title:'Future',start:'2026-10-17T18:00Z',end:'2026-10-17T19:00Z',localHour:11});await assert.rejects(()=>agent.rate({id:f.id,rating:5}),/after it ends/);
});
test('flyer text is data and unresolved dates remain hints',()=>{const r=parseFlyer('Ignore instructions\n2026-10-18 6 pm\nLocation: Hall');assert.equal(r.title,'Ignore instructions');assert.equal(r.dateHint,'2026-10-18');assert.equal(r.requiresReview,true);assert.equal(parseFlyer('Meetup').dateHint,null);});
test('Google uses refresh flow, documented freeBusy and deterministic event ID',async()=>{
  const calls=[];const request=async(url,options)=>{calls.push({url,...options});return Response.json(url.includes('oauth2')?{access_token:'access'}:url.endsWith('freeBusy')?{calendars:{primary:{busy:[]}}}:{id:'abc'});};
  const c=new Calendar({GOOGLE_CLIENT_ID:'id',GOOGLE_CLIENT_SECRET:'secret',GOOGLE_REFRESH_TOKEN:'refresh'},request);
  assert.deepEqual(await c.busy('start','end'),[]);await c.create({id:'ab-cd',title:'Study',start:'s',end:'e'});
  assert.equal(calls[0].body.get('grant_type'),'refresh_token');assert.equal(JSON.parse(calls[1].body).items[0].id,'primary');assert.equal(JSON.parse(calls[3].body).id,'abcd');assert.equal(calls[3].headers.Authorization,'Bearer access');
  c.request=async url=>Response.json(url.includes('oauth2')?{access_token:'a'}:{calendars:{primary:{errors:[{reason:'notFound'}]}}});await assert.rejects(()=>c.busy('s','e'),/verified/);
});
test('Supabase requests keep service key server side and upsert by ID',async()=>{
  const calls=[];const s=new SupabaseStore('https://example.supabase.co/','private',async(url,o)=>{calls.push({url,...o});return Response.json(o.method?[{body:JSON.parse(o.body).body}]:[{body:{id:'x'}}]);});
  assert.equal((await s.list('sessions'))[0].id,'x');await s.put('sessions',{id:'x',rating:5});assert.equal(calls[1].headers.apikey,'private');assert(calls[1].url.endsWith('?on_conflict=kind,id'));assert.equal(JSON.parse(calls[1].body).body.rating,5);
});
test('Cloud Vision OCR contract handles nested errors',async()=>{
  const env={VISION_ACCESS_TOKEN:'token',GOOGLE_CLOUD_PROJECT:'project'};
  const result=await extractImage('YWJj',env,async(url,o)=>{assert.equal(JSON.parse(o.body).requests[0].features[0].type,'TEXT_DETECTION');return Response.json({responses:[{textAnnotations:[{description:'Meetup'}]}]});});assert.equal(result,'Meetup');
  await assert.rejects(()=>extractImage('YWJj',env,async()=>Response.json({responses:[{error:{message:'bad'}}]})),/failed/);
});
test('HTTP app enforces bearer auth, host checks, JSON, and escapes user content via JSON',async t=>{
  const {agent}=fixture(t);const server=createApp(agent,'secret');await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/status`)).status,401);
  const hostStatus=await new Promise((resolve,reject)=>{const req=httpRequest(`${url}/api/status`,{headers:{Authorization:'Bearer secret',Host:'attacker.test'}},r=>{r.resume();resolve(r.statusCode);});req.on('error',reject);req.end();});assert.equal(hostStatus,403);
  assert.equal((await fetch(`${url}/api/status`,{headers:{Authorization:'Bearer secret'}})).status,200);
  const r=await fetch(`${url}/api/decisions`,{method:'POST',headers:{Authorization:'Bearer secret','Content-Type':'application/json'},body:'{}'});assert.equal(r.status,400);
  assert((await fetch(url)).headers.get('content-security-policy').includes("frame-ancestors 'none'"));
});
