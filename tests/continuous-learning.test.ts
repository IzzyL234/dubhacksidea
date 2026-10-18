import {test,expect,afterEach} from "bun:test";
import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {StudySessions,learningContext,sessionContext} from "../src/sessions.ts";
import {FeedbackFlow} from "../src/feedback.ts";
import {StudyLearner,seedObservation,features} from "../src/learning.ts";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
const base=Date.parse("2026-10-18T19:00:00Z");
const starter={id:"one",timestamp:new Date(base).toISOString(),duration_mins:45,location:"library",study_space:"desk",peceptron_tags:{clutter_score:2,lighting:"bright",ergonomics:8},user_productivity_rating:2,user_mood_rating:2};
async function setup(){const dir=await mkdtemp(join(tmpdir(),"continuous-learning-"));dirs.push(dir);let now=base;const seeds=join(dir,"seed.json");await writeFile(seeds,JSON.stringify([starter]));const sessions=join(dir,"sessions"),feedback=join(dir,"feedback");const make=()=>new StudySessions(sessions,null,join(feedback,"records"),seeds,async()=>({lighting:"bright",clutter_score:2,ergonomics:null}),null,()=>now).enableDemoPrior();const s=make();const flow=new FeedbackFlow(feedback,null,{begin:key=>s.beginFeedback(key),afterSave:r=>s.completeFeedback(r)});return {dir,s,flow,make,sessions,feedback,time:(value:number)=>{now=value;}};}
test("a partial session updates immediately with equal demo and real base weight",async()=>{
 const t=await setup();await t.s.handle("chat","start studying","start");await t.s.photo("chat","photo","image/jpeg",async()=>new Uint8Array([1]));t.time(base+20*60000);
 await t.flow.handle("chat","done","done");await t.flow.handle("chat","5","p");await t.flow.handle("chat","5","m");await t.flow.handle("chat","1","d");
 const cache=JSON.parse(await readFile(join(t.sessions,"models-v2",hash("chat")+".json"),"utf8"));expect(cache.personalObservations).toBe(1);expect(cache.demoObservations).toBe(1);expect(cache.completeProfiles).toBe(0);expect(cache.model.observations_count).toBe(2);expect(cache.model.user_id).toStartWith("study-ts-v2:");
 const doc=JSON.parse(await readFile(join(t.sessions,hash("chat")+".json"),"utf8")),session=doc.sessions[0];expect(session.location).toBeNull();expect(session.environment.ergonomics).toBeNull();expect(sessionContext(session)).toBeNull();
 const expected=new StudyLearner();expected.observe({...seedObservation(starter),id:"demo:one"});expected.observe({...learningContext(session)!,id:session.feedback_id,user_productivity_rating:5,user_mood_rating:5});const actual=StudyLearner.fromState(cache.model)!.learner;
 expect(actual.predict(learningContext(session)!).predictedProductivity).toBeCloseTo(expected.predict(learningContext(session)!).predictedProductivity,12);
 await t.s.handle("chat","start studying","next");const reply=await t.s.photo("chat","photo-next","image/jpeg",async()=>new Uint8Array([1]));expect(reply).toContain("1 real session(s) + 1 demo example(s)");expect(reply).toContain("equal base weight");
});
test("daily rebuild survives restart, deduplicates replay and reuses corrected ratings",async()=>{
 const t=await setup();await t.s.handle("chat","start studying","start");t.time(base+20*60000);await t.flow.handle("chat","done","done");await t.flow.handle("chat","5","p");await t.flow.handle("chat","5","m");await t.flow.handle("chat","1","d");
 expect((await t.s.rebuildDaily()).rebuilt).toBe(1);expect((await t.make().rebuildDaily()).rebuilt).toBe(0);
 const before=JSON.parse(await readFile(join(t.sessions,"models-v2",hash("chat")+".json"),"utf8"));const id=before.model.observed_ids.find((id:string)=>!id.startsWith("demo:"));const path=join(t.feedback,"records",id+".json");const record=JSON.parse(await readFile(path,"utf8"));record.productivity_rating=1;record.mood_rating=1;await writeFile(path,JSON.stringify(record));t.time(base+86400000);
 expect((await t.make().rebuildDaily()).rebuilt).toBe(1);const after=JSON.parse(await readFile(join(t.sessions,"models-v2",hash("chat")+".json"),"utf8"));expect(after.personalObservations).toBe(1);expect(after.model.observations_count).toBe(2);expect(after.model.productivity_weights).not.toEqual(before.model.productivity_weights);
});
test("missing features have explicit flags and never masquerade as home or poor seating",()=>{
 const partial={timestamp:new Date(base).toISOString(),duration_mins:null,location:null,study_space:null,environment:{lighting:null,clutter_score:null,ergonomics:null}};
 const x=features(partial);expect(x.slice(-6)).toEqual([1,1,1,1,1,1]);const known=features({...seedObservation(starter)});expect(known.slice(-6)).toEqual([0,0,0,0,0,0]);expect(x.length).toBe(known.length);
});
