import type {EventInput} from "../src/calendar-types.ts";
import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm,readFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {StudySessions,type StudySession} from "../src/sessions.ts";
import {SmartPrompts} from "../src/smart-prompts.ts";
import {StudyReminders} from "../src/proactive.ts";
import {decidePrompt,coordinatorProvider,validateSelectedOption,type DecisionFacts} from "../src/proactive-decision.ts";
import type {LearningPair} from "../src/learning-store.ts";
import type {SessionFeedback} from "../src/feedback.ts";
const dirs:string[]=[];
const savedEnv={...process.env};
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});for(const key of ["GEMINI_API_KEY","GEMINI_MODEL","XAI_API_KEY","STUDY_COORDINATOR_PROVIDER","STUDY_DEMO_SEEDS"]){if(savedEnv[key]===undefined)delete process.env[key];else process.env[key]=savedEnv[key];}});
const noon=Date.parse("2026-10-17T19:00:00Z");const user=createHash("sha256").update("chat").digest("hex");
async function root(){const d=await mkdtemp(join(tmpdir(),"study-coordinator-"));dirs.push(d);return d;}
function histories(preferShort:boolean):LearningPair[]{
 return Array.from({length:80},(_,i)=>{const minutes=i%2===0?25:45;const rating=(minutes===25)===preferShort?5:1;const id=`11111111-1111-4111-8111-${String(i).padStart(12,"0")}`;
 const session:StudySession={id:`session-${i}`,user_id:user,started_at:new Date(noon).toISOString(),ended_at:new Date(noon+minutes*60000).toISOString(),duration_mins:minutes,location:"library",study_space:"desk",environment:{clutter_score:2,lighting:"bright",ergonomics:8},environment_source:"self_report",status:"completed",feedback_id:id,is_synthetic:false};
 const feedback:SessionFeedback={id,conversation_key:user,reported_at:new Date(noon+minutes*60000).toISOString(),session_id:session.id,productivity_rating:rating,mood_rating:rating,distraction_rating:1,distraction_source:null,is_synthetic:false};return{session_record:session,feedback_record:feedback};});
}
function sessions(d:string,rows:LearningPair[],now=()=>noon){return new StudySessions(join(d,"sessions"),null,join(d,"feedback"),"missing-seeds-on-purpose",undefined,{load:async()=>rows},now);}
const facts:DecisionFacts={place:"library",stableMinutes:3,locationAgeSeconds:0,accuracyMeters:10,freeMinutes:90,plannedMinutes:45,acceptedRecently:0,skippedRecently:0};
test("real linked feedback changes ranked session lengths, without demo seeds or model writes",async()=>{
 process.env.STUDY_DEMO_SEEDS="true";const a=await root(),b=await root();
 const short=await sessions(a,histories(true)).proactiveOptions("chat","library",90);const long=await sessions(b,histories(false)).proactiveOptions("chat","library",90);
 expect(short.observations).toBe(80);expect(short.options[0]?.minutes).toBe(25);expect(long.options[0]?.minutes).toBe(45);
 expect(short.currentWorkspaceKnown).toBe(false);expect(short.options[0]?.basis).toBe("historical");expect(short.options[0]?.uncertainty).toBeGreaterThan(0);
 expect(JSON.stringify(short)).not.toContain("conversation_key");expect(JSON.stringify(short)).not.toContain("session-0");
});
test("unknown locations/history never invent workspace scores, and users remain isolated",async()=>{
 const d=await root(),s=sessions(d,histories(true));
 const cold=await s.proactiveOptions("other-chat","library",35);expect(cold.observations).toBe(0);expect(cold.options.every(o=>o.predictedProductivity===null&&o.basis==="unknown")).toBe(true);
 const otherPlace=await s.proactiveOptions("chat","cafe",35);expect(otherPlace.options.every(o=>o.basis==="unknown")).toBe(true);expect(otherPlace.options.every(o=>o.minutes<=35)).toBe(true);
});
test("the selected learned duration survives confirmation and reaches the session executor",async()=>{
 const d=await root();let now=noon,startedMinutes=0,bookedMinutes=0;const study=sessions(d,histories(true),()=>now);
 const smart=new SmartPrompts({now:()=>now,read:async()=>({latitude:47,longitude:-122,accuracy:10,locationType:"live",locationTimestamp:new Date(now),isLocatingInProgress:false}),learn:(c,p,m)=>study.proactiveOptions(c,p,m),decide:async f=>({action:"offer_study",reason:"useful_window",confidence:.9,optionId:f.learning!.options[0]!.id})},join(d,"smart"));
 await smart.handle("chat","test-address","remember place library");await smart.handle("chat","test-address","smart prompts on");
 const gateway={list:async()=>[],busy:async()=>[],get:async()=>({}),patch:async()=>({}),create:async(e:EventInput)=>{bookedMinutes=(Date.parse(e.end.dateTime)-Date.parse(e.start.dateTime))/60000;return e;}};
 const block={key:"gap",title:"Open time",kind:"open" as const,start:noon,end:noon+120*60000};const sent:string[]=[];
 const make=()=>new StudyReminders({now:()=>now,events:async()=>[block],send:async(_c,t)=>{sent.push(t);},busy:c=>study.hasUnfinished(c),checkIn:async()=>false,active:(c,id)=>study.isActive(c,id),evaluate:(c,b)=>smart.evaluate(c,b),confirm:(c,b)=>smart.confirm(c,b),start:async(c,b)=>{startedMinutes=(b.end-b.start)/60000;return study.startCalendar(c,b.key,startedMinutes,{gateway,start:b.start,end:b.end});}},join(d,"reminders.json"));
 await make().handle("chat","reminders on","on");await make().tick();now+=60000;await make().tick();now+=120000;await make().tick();
 expect(sent).toHaveLength(1);expect(sent[0]).toContain("25-minute");expect(sent[0]).toContain("Today's workspace may differ");
 await make().handle("chat","yes","accept");expect(startedMinutes).toBe(25);expect(bookedMinutes).toBe(25);
 const [file]=await readdir(join(d,"sessions"));const doc=JSON.parse(await readFile(join(d,"sessions",file!),"utf8"));expect(doc.sessions[0].duration_mins).toBe(25);expect(doc.sessions[0].study_space).toBeNull();
});
test("coordinator cannot select invented, oversized or contradictory actions",async()=>{
 const d=await root(),learning=await sessions(d,[]).proactiveOptions("chat","library",35);
 expect(()=>validateSelectedOption({action:"offer_study",reason:"useful_window",confidence:.9,optionId:"invented"},{...facts,learning})).toThrow();
 expect(()=>validateSelectedOption({action:"offer_study",reason:"useful_window",confidence:.9,optionId:learning.options[0]!.id},{...facts,freeMinutes:10,learning})).toThrow();
});
test("Gemini is one bounded request with learned options; blocked output never falls back to another provider",async()=>{
 process.env.STUDY_COORDINATOR_PROVIDER="gemini";process.env.GEMINI_API_KEY="test-only";process.env.GEMINI_MODEL="test-model";
 const d=await root(),learning=await sessions(d,histories(true)).proactiveOptions("chat","library",90);let calls=0;
 const request=(async(url,init)=>{calls++;expect(String(url)).not.toContain("test-only");expect((init?.headers as Record<string,string>)["x-goog-api-key"]).toBe("test-only");const body=JSON.parse(String(init?.body));expect(JSON.parse(body.contents[0].parts[0].text).learning.observations).toBe(80);return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{thought:true,text:"private thinking"},{text:JSON.stringify({action:"offer_study",reason:"useful_window",confidence:.9,optionId:learning.options[0]!.id})}]}}]});}) as typeof fetch;
 const decision=await decidePrompt({...facts,learning},request);expect(decision.optionId).toBe(learning.options[0]!.id);expect(calls).toBe(1);
 await expect(decidePrompt({...facts,learning},async()=>Response.json({candidates:[{finishReason:"SAFETY"}]}))).rejects.toThrow("Incomplete");
 expect(coordinatorProvider()).toBe("gemini");
});
test("Grok uses the same learned schema and explicit provider selection wins",async()=>{
 process.env.STUDY_COORDINATOR_PROVIDER="grok";process.env.XAI_API_KEY="test-only";process.env.GEMINI_API_KEY="test-gemini";process.env.GEMINI_MODEL="test-model";
 expect(coordinatorProvider()).toBe("grok");
 const decision=await decidePrompt(facts,(async(url,init)=>{expect(String(url)).toBe("https://api.x.ai/v1/responses");const body=JSON.parse(String(init?.body));expect(body.text.format.schema.required).toContain("optionId");return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:'{"action":"stay_quiet","reason":"uncertain_context","confidence":0.8,"optionId":null}'}]}]});}) as typeof fetch);expect(decision.action).toBe("stay_quiet");
 process.env.STUDY_COORDINATOR_PROVIDER="unsupported";expect(()=>coordinatorProvider()).toThrow();
});
