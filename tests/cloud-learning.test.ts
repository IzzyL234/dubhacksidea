import {afterEach,expect,test} from 'bun:test';import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {StudySessions,type StudySession} from '../src/sessions.ts';import type {SessionFeedback} from '../src/feedback.ts';
import {SupabaseLearningStore,type LearningPair} from '../src/learning-store.ts';import {SupabaseEvents,type ProactivityEvent} from '../src/proactivity-store.ts';import {SmartPrompts} from '../src/smart-prompts.ts';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const user=createHash('sha256').update('private-chat').digest('hex');
function pair(id='11111111-1111-4111-8111-111111111111',rating=1):LearningPair{
 const session:StudySession={id:'past-'+id,user_id:user,started_at:'2026-10-17T19:00:00Z',ended_at:'2026-10-17T19:45:00Z',duration_mins:45,location:'library',study_space:'desk',environment:{clutter_score:3,lighting:'bright',ergonomics:7},environment_source:'self_report',status:'completed',feedback_id:id,is_synthetic:false};
 const feedback={id,conversation_key:user,reported_at:'2026-10-17T19:46:00Z',session_id:session.id,productivity_rating:rating,mood_rating:rating,distraction_rating:1,distraction_source:null,is_synthetic:false} as SessionFeedback;
 return {session_record:session,feedback_record:feedback};
}
async function root(){const d=await mkdtemp(join(tmpdir(),'cloud-learning-'));dirs.push(d);return d;}
async function ready(s:StudySessions){await s.handle('private-chat','start studying','start');await s.handle('private-chat','library desk 45','place');await s.handle('private-chat','workspace bright 3 7','env');}

test('natural study questions rank real personal history and do not invent current workspaces',async()=>{
 const d=await root();let exports=0;const rows=[pair()];
 const s=new StudySessions(join(d,'sessions'),{put:async()=>{},putModelParams:async()=>{exports++;}},join(d,'feedback'),'missing-demo-file',undefined,{load:async()=>rows});
 const result=await s.handle('private-chat','where should I study?','recommend-one');
 expect(result).toContain('1 completed linked check-in');expect(result).toContain('library desk');expect(result).toContain('estimated productivity');expect(result).not.toContain('cafe');expect(result).not.toContain('LinUCB');expect(await s.handle('private-chat','study recommendations','friendly')).toBe(result);expect(exports).toBe(0);
 rows[0]!.feedback_record.productivity_rating=5;rows[0]!.feedback_record.mood_rating=5;
 expect(await s.handle('private-chat','can you suggest a place to study','recommend-two')).not.toBe(result);
 expect(await s.handle('different-chat','where should I study?','other')).toContain('no completed linked sessions');
});
test('cloud history changes the next prediction and survives restart without local past sessions',async()=>{
 const d=await root();const rows=[pair()];const source={load:async()=>rows};const make=()=>new StudySessions(join(d,'sessions'),null,join(d,'feedback'),undefined,undefined,source);
 const s=make();await ready(s);const first=await s.handle('private-chat','study score','one');expect(first).toContain('1 of your linked check-ins');expect(first).toContain('Supabase history');
 expect(await make().handle('private-chat','study score','two')).toBe(first);rows.push(pair('22222222-2222-4222-8222-222222222222',5));
 const next=await s.handle('private-chat','study score','three');expect(next).toContain('2 of your linked check-ins');expect(next).not.toBe(first);expect(next).not.toContain('synthetic');
});
test('cross-user, synthetic and duplicate cloud records cannot inflate personal learning',async()=>{
 const d=await root(),good=pair(),other=pair('22222222-2222-4222-8222-222222222222',5),synthetic=pair('33333333-3333-4333-8333-333333333333',5);
 other.session_record.user_id='b'.repeat(64);other.feedback_record.conversation_key='b'.repeat(64);(synthetic.feedback_record as {is_synthetic:boolean}).is_synthetic=true;
 const s=new StudySessions(join(d,'sessions'),null,join(d,'feedback'),undefined,undefined,{load:async()=>[good,good,other,synthetic]});await ready(s);
 expect(await s.handle('private-chat','study score','score')).toContain('1 of your linked check-ins');
});
test('cloud outage reports local-only prediction rather than claiming cloud history was learned',async()=>{
 const d=await root();const s=new StudySessions(join(d,'sessions'),null,join(d,'feedback'),undefined,undefined,{load:async()=>{throw Error('offline');}});await ready(s);
 expect(await s.handle('private-chat','study score','score')).toContain('Cloud history unavailable');
});

test('cached cloud observations survive an outage without losing partial-session learning',async()=>{
 const d=await root();let offline=false;const partial=pair();partial.session_record.location=null;partial.session_record.study_space=null;partial.session_record.environment={};
 const source={load:async()=>{if(offline)throw Error('offline');return [partial];}};
 const make=()=>new StudySessions(join(d,'sessions'),null,join(d,'feedback'),'unused',undefined,source);
 await ready(make());const before=await make().proactiveOptions('private-chat','library',60);expect(before.observations).toBe(1);expect(before.partialObservations).toBe(1);
 offline=true;const after=await make().proactiveOptions('private-chat','library',60);expect(after.observations).toBe(1);expect(after.cloudUnavailable).toBe(true);expect(after.partialObservations).toBe(1);
});
test('history GET is user-filtered and backend credentials never enter the URL',async()=>{
 let url='',init:RequestInit|undefined;const store=new SupabaseLearningStore('https://example.supabase.co','sb_secret_test',async(u,o)=>{url=String(u);init=o;return new Response(JSON.stringify([pair()]));});
 expect(await store.load(user)).toHaveLength(1);expect(url).toContain('eq.'+user);expect(url).not.toContain('sb_secret');expect(init?.method).toBeUndefined();
 await expect(store.load('private-chat')).rejects.toThrow('Invalid user key');expect(()=>new SupabaseLearningStore('https://other.example','sb_secret_test')).toThrow();
});
test('event outbox survives failed upload/restart; coalesced updates reuse the same event ID',async()=>{
 const d=await root();const attempted:ProactivityEvent[]=[],accepted:ProactivityEvent[]=[];let fail=true;
 const deps={read:async()=>({locationType:'live',isLocatingInProgress:false}),decide:async()=>({action:'stay_quiet' as const,reason:'poor_timing' as const,confidence:.9}),events:{put:async(e:ProactivityEvent)=>{attempted.push(e);if(fail)throw Error('offline');accepted.push(e);}}};
 const smart=new SmartPrompts(deps,d);await smart.handle('private-chat','+15555550123','smart prompts on');await smart.audit('private-chat','no_eligible_opening');
 await expect(smart.syncPending()).rejects.toThrow('offline');fail=false;const restarted=new SmartPrompts(deps,d);expect(await restarted.syncPending()).toBe(1);expect(accepted[0]?.id).toBe(attempted[0]?.id);expect(await restarted.syncPending()).toBe(0);
 await restarted.audit('private-chat','no_eligible_opening');await restarted.syncPending();expect(accepted[1]?.id).toBe(accepted[0]?.id);expect(accepted[1]?.occurrence_count).toBe(2);
 const payload=JSON.stringify(accepted);expect(payload).not.toContain('private-chat');expect(payload).not.toContain('15555550123');expect(payload).not.toContain('latitude');
});
test('unsynced events survive display-log truncation',async()=>{
 const d=await root();let uploaded=0;const smart=new SmartPrompts({read:async()=>({locationType:'live',isLocatingInProgress:false}),decide:async()=>({action:'stay_quiet',reason:'poor_timing',confidence:.9}),events:{put:async()=>{uploaded++;}}},d);
 await smart.handle('private-chat','+15555550123','smart prompts on');for(let i=0;i<105;i++)await smart.audit('private-chat','reason_'+i);expect(await smart.syncPending(200)).toBe(105);expect(uploaded).toBe(105);
});
test('event writes whitelist fields and retry with stable primary keys',async()=>{
 let body:Record<string,unknown>={};const sink=new SupabaseEvents('https://example.supabase.co','sb_secret_test',async(_u,init)=>{body=JSON.parse(String(init?.body));return new Response(null,{status:201});});
 const e={id:'11111111-1111-4111-8111-111111111111',user_key:user,reported_at:new Date().toISOString(),action:'stay_quiet' as const,reason:'no_eligible_opening',occurrence_count:1,latitude:47,phone:'private'};
 await sink.put(e);expect(body).not.toHaveProperty('latitude');expect(body).not.toHaveProperty('phone');expect(body.id).toBe(e.id);
});

test('model decision and later acceptance remain linked without sending coordinates to the event store',async()=>{
 const d=await root();let now=Date.parse('2026-10-17T19:00:00Z');const events:ProactivityEvent[]=[];
 const smart=new SmartPrompts({now:()=>now,events:{put:async(e)=>{events.push(e);}},read:async()=>({latitude:47,longitude:-122,accuracy:10,locationType:'live',locationTimestamp:new Date(now),isLocatingInProgress:false}),decide:async()=>({action:'offer_study',reason:'useful_window',confidence:.9})},d);
 await smart.handle('private-chat','+15555550123','remember place library');await smart.handle('private-chat','+15555550123','smart prompts on');
 const block={key:'gap',title:'Open time',start:now,end:now+120*60000,kind:'open' as const};await smart.evaluate('private-chat',block);now+=60000;await smart.evaluate('private-chat',block);now+=120000;await smart.evaluate('private-chat',block);
 await smart.outcome('private-chat','accepted');await smart.syncPending();const offer=events.find(e=>e.action==='offer_study'),accepted=events.find(e=>e.action==='accepted');
 expect(offer?.decision_context?.plannedMinutes).toBe(45);expect(accepted?.related_decision_id).toBe(offer?.id);expect(JSON.stringify(events)).not.toContain('latitude');
});

test('a new coalesced event written during upload is retained for the next flush',async()=>{
 const d=await root();let release:()=>void=()=>{},started:()=>void=()=>{};const block=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
 const smart=new SmartPrompts({read:async()=>({locationType:'live',isLocatingInProgress:false}),decide:async()=>({action:'stay_quiet',reason:'poor_timing',confidence:.9}),events:{put:async()=>{started();await block;}}},d);
 await smart.handle('private-chat','+15555550123','smart prompts on');await smart.audit('private-chat','no_eligible_opening');const flush=smart.syncPending();await entered;
 await smart.audit('private-chat','no_eligible_opening');release();await flush;expect(await smart.syncPending()).toBe(1);expect(await smart.syncPending()).toBe(0);
});

test('agent place evidence changes with owned ratings and keeps partially known recorded profiles',async()=>{
 const d=await root(),row=pair();row.session_record.environment.ergonomics=null;
 const s=new StudySessions(join(d,'sessions'),null,join(d,'feedback'),'missing-seed',undefined,{load:async()=>[row]});
 const low=await s.placeRecommendations('private-chat');expect(low.personalObservations).toBe(1);expect(low.places[0]?.place).toBe('library');expect(low.places[0]?.matchingPersonalSessions).toBe(1);expect(low.places[0]?.basis).toBe('personal_history');
 row.feedback_record.productivity_rating=5;row.feedback_record.mood_rating=5;
 const high=await s.placeRecommendations('private-chat');expect(high.places[0]!.productivity).toBeGreaterThan(low.places[0]!.productivity);expect((await s.placeRecommendations('other-chat')).places).toHaveLength(0);expect(JSON.stringify(high)).not.toContain(user);
});
test('agent place evidence does not fabricate a favorite from ratings without recorded place',async()=>{
 const d=await root(),row=pair();row.session_record.location=null;
 const s=new StudySessions(join(d,'sessions'),null,join(d,'feedback'),'missing-seed',undefined,{load:async()=>[row]});const r=await s.placeRecommendations('private-chat');expect(r.personalObservations).toBe(1);expect(r.places).toHaveLength(0);
});

test('starter place candidates remain available with partial personal ratings and share the combined trained model',async()=>{
 const d=await root(),row=pair();row.session_record.location=null;row.session_record.study_space=null;
 const s=new StudySessions(join(d,'sessions'),null,join(d,'feedback'),undefined,undefined,{load:async()=>[row]}).enableDemoPrior();
 const before=await s.placeRecommendations('private-chat');expect(before.personalObservations).toBe(1);expect(before.starterObservations).toBeGreaterThan(0);expect(before.places.length).toBeGreaterThan(1);expect(before.modelObservations).toBe(before.starterObservations+1);expect(before.places.every(p=>p.matchingPersonalSessions===0&&p.matchingStarterSessions>0&&p.basis==='starter_history')).toBe(true);
 row.feedback_record.productivity_rating=5;row.feedback_record.mood_rating=5;const after=await s.placeRecommendations('private-chat');const place=before.places[0]!.place;expect(after.places.find(p=>p.place===place)!.productivity).not.toBe(before.places[0]!.productivity);
});
