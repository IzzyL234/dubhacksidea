import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SessionContext} from '../src/session-context.ts';
import {SupabaseContext} from '../src/session-context-cloud.ts';
const tags={sentiment:'negative' as const,social:'with_others' as const,socialEffect:'unclear' as const,factors:['task_difficulty' as const]};
test('unconfirmed notes never upload; confirmed tags retry across restarts without duplicates',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'context-cloud-'));let fail=true,calls=0;
 const sink={async put(key:string,entry:any){calls++;expect(key).toBe(createHash('sha256').update('chat').digest('hex'));expect(entry.context).toEqual(tags);if(fail)throw Error('offline');}};
 try{
  const make=()=>new SessionContext(dir,async()=>tags,Date.now,sink);const flow=make();
  await flow.arm({id:'f',conversation_key:createHash('sha256').update('chat').digest('hex'),session_id:'s',reported_at:new Date().toISOString(),productivity_rating:2,mood_rating:2,distraction_rating:1,distraction_source:null,is_synthetic:false});
  await flow.handle('chat','The assignment was hard','note');expect(await flow.flush()).toEqual({uploaded:0,pending:0});expect(calls).toBe(0);
  await flow.handle('chat','yes','confirm');expect(await flow.flush()).toEqual({uploaded:0,pending:1});fail=false;
  expect(await make().flush()).toEqual({uploaded:1,pending:0});expect(await make().flush()).toEqual({uploaded:0,pending:0});expect(calls).toBe(2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('cloud projection contains only confirmed tags and links, never raw text or inferred ratings',async()=>{
 let payload:any;
 const sink=new SupabaseContext('https://example.supabase.co','sb_secret_test',async(url,init)=>{
  expect(String(url)).toContain('study_session_context?on_conflict=feedback_id');payload=JSON.parse(String(init?.body));return new Response(null,{status:201});
 });
 await sink.put('a'.repeat(64),{feedbackId:'f',sessionId:'s',at:new Date().toISOString(),productivity:2,mood:2,context:tags});
 expect(Object.keys(payload).sort()).toEqual(['conversation_key','factors','feedback_id','reported_at','sentiment','session_id','social','social_effect']);
 expect(payload).not.toHaveProperty('productivity');
});
test('coordinator evidence omits sparse and old groups, and keeps numerical ratings unchanged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'context-evidence-'));let now=Date.now();
 try{
  const flow=new SessionContext(dir,async()=>tags,()=>now,null);
  for(let i=0;i<3;i++){
   await flow.arm({id:'f'+i,conversation_key:createHash('sha256').update('chat').digest('hex'),session_id:'s'+i,reported_at:new Date(now).toISOString(),productivity_rating:i+1,mood_rating:4,distraction_rating:1,distraction_source:null,is_synthetic:false});
   await flow.handle('chat','The task was hard','n'+i);await flow.handle('chat','yes','y'+i);
   if(i<2)expect((await flow.summary('chat')).patterns).toEqual([]);
  }
  const result=await flow.summary('chat');expect(result.patterns.find(p=>p.label==='factor:task_difficulty')).toEqual({label:'factor:task_difficulty',sessions:3,averageProductivity:2,averageMood:4});
  expect(result.recent.map(e=>e.productivity)).toEqual([1,2,3]);expect(result.interpretation).toContain('not controlled comparisons');
  expect((await flow.summary('other')).patterns).toEqual([]);now+=91*86400000;expect((await flow.summary('chat')).patterns).toEqual([]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
