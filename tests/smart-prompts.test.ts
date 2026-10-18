import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm,readFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SmartPrompts,freshReading} from "../src/smart-prompts.ts";
import {validateDecision} from "../src/proactive-decision.ts";
import {StudyReminders} from "../src/proactive.ts";
import type {LocationSnapshot} from "../src/photon-location.ts";
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const noon=Date.parse("2026-10-17T19:00:00Z");
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),"smart-prompts-"));dirs.push(dir);
 let now=noon,captured=noon,latitude=47,accuracy=20,modelCalls=0,fail=false,busy=false,starts=0;
 const facts:unknown[]=[],sent:string[]=[];
 const read=async():Promise<LocationSnapshot>=>({latitude,longitude:-122,accuracy,locationType:"shallow",locationTimestamp:new Date(captured),isLocatingInProgress:false});
 const decide=async(f:unknown)=>{modelCalls++;facts.push(f);if(fail)throw Error("unavailable");return {action:"offer_study" as const,reason:"useful_window" as const,confidence:.9};};
 const make=()=>new SmartPrompts({read,decide,now:()=>now},join(dir,"smart"));const smart=make();
 const block={key:"open:one",title:"Open time",kind:"open" as const,start:noon,end:noon+4*3600000};
 const reminders=new StudyReminders({events:async()=>[block],send:async(_c,t)=>{sent.push(t);},busy:async()=>busy,checkIn:async()=>false,active:async()=>true,
  start:async()=>{starts++;return{id:"one",reply:"Started"};},now:()=>now,evaluate:(c,b)=>smart.evaluate(c,b),confirm:(c,b)=>smart.confirm(c,b),audit:(c,r)=>smart.audit(c,r),outcome:(c,k)=>smart.outcome(c,k)},join(dir,"reminders.json"));
 await smart.handle("chat","+15555550123","remember place library");await smart.handle("chat","+15555550123","smart prompts on");
 return {dir,smart,make,reminders,block,facts,sent,read,get calls(){return modelCalls;},get starts(){return starts;},time:(minutes:number,fresh=true)=>{now=noon+minutes*60000;if(fresh)captured=now;},move:()=>{latitude=48;},inaccurate:()=>{accuracy=101;},fail:()=>{fail=true;},busy:(v:boolean)=>{busy=v;}};
}
test("freshness rejects stale, unlocated, expired and uncertain snapshots",()=>{
 const good={latitude:0,longitude:0,accuracy:20,locationType:"live",locationTimestamp:new Date(noon),isLocatingInProgress:false};
 expect(freshReading(good,noon)).not.toBeNull();
 for(const change of [{accuracy:undefined},{accuracy:101},{locationType:"legacy"},{isLocatingInProgress:true},{expiresAt:new Date(noon)},{locationTimestamp:new Date(noon-121000)},{locationTimestamp:new Date(noon+31000)}])expect(freshReading({...good,...change},noon)).toBeNull();
});
test("cached timestamps cannot establish dwell; fresh readings span three minutes; model sees no coordinates",async()=>{
 const s=await setup();expect((await s.smart.evaluate("chat",s.block)).allow).toBe(false);
 s.time(1,false);expect((await s.smart.evaluate("chat",s.block)).allow).toBe(false);
 s.time(2);await s.smart.evaluate("chat",s.block);expect(s.calls).toBe(0);
 s.time(3);expect((await s.smart.evaluate("chat",s.block)).allow).toBe(true);expect(s.calls).toBe(1);
 const facts=JSON.stringify(s.facts);expect(facts).not.toContain("latitude");expect(facts).not.toContain("15555550123");expect(facts).toContain("library");
 const log=await s.smart.handle("chat",undefined,"why quiet");expect(log).toContain("offer_study");expect(log).not.toContain("-122");
 expect(await s.smart.confirm("chat",s.block)).toBe(true);s.move();expect(await s.smart.confirm("chat",s.block)).toBe(false);
});
test("model failures fail closed, reserve budget, and restart loses dwell evidence",async()=>{
 const s=await setup();s.fail();await s.smart.evaluate("chat",s.block);s.time(1);await s.smart.evaluate("chat",s.block);s.time(3);
 expect((await s.smart.evaluate("chat",s.block)).allow).toBe(false);expect(s.calls).toBe(1);
 s.time(4);await s.smart.evaluate("chat",s.block);expect(s.calls).toBe(1);
 s.time(14);expect((await s.make().evaluate("chat",s.block)).reason).toBe("waiting_for_distinct_stable_readings");expect(s.calls).toBe(1);
});
test("scheduler keeps busy chats quiet, checks location again on yes, and creates no session after moving",async()=>{
 const s=await setup();await s.reminders.handle("chat","reminders on","on");s.busy(true);await s.reminders.tick();expect(s.calls).toBe(0);expect(s.sent).toHaveLength(0);
 s.busy(false);await s.reminders.tick();s.time(1);await s.reminders.tick();s.time(3);await s.reminders.tick();expect(s.sent).toHaveLength(1);
 s.move();expect(await s.reminders.handle("chat","yes","yes")).toContain("location changed");expect(s.starts).toBe(0);
});
test("skip cooldown survives restart and prevents another invitation",async()=>{
 const s=await setup();await s.reminders.handle("chat","reminders on","on");await s.reminders.tick();s.time(1);await s.reminders.tick();s.time(3);await s.reminders.tick();
 await s.reminders.handle("chat","skip","skip");s.time(30);await s.reminders.tick();expect(s.sent).toHaveLength(1);expect(s.calls).toBe(1);
 expect((await s.make().evaluate("chat",s.block)).reason).toBe("decision_cooldown");
 expect(await s.smart.handle("chat",undefined,"why quiet")).toContain("skipped_cooldown");
});
test("forget places removes coordinates from persisted settings",async()=>{
 const s=await setup();await s.smart.handle("chat",undefined,"forget places");
 const path=join(s.dir,"smart",(await readdir(join(s.dir,"smart")))[0]!);const state=JSON.parse(await readFile(path,"utf8"));expect(state.places).toEqual([]);
 expect((await s.smart.evaluate("chat",s.block)).reason).toBe("no_saved_places");
});
test("strict model decisions reject extra fields, invalid confidence and contradictory actions",()=>{
 for(const value of [{action:"send",reason:"useful_window",confidence:.9},{action:"offer_study",reason:"poor_timing",confidence:.9},{action:"stay_quiet",reason:"poor_timing",confidence:2},{action:"offer_study",reason:"useful_window",confidence:.9,text:"go"}])expect(()=>validateDecision(value)).toThrow();
});

 test("confirmed stable offer starts exactly once despite repeated yes",async()=>{
 const s=await setup();await s.reminders.handle("chat","reminders on","on");await s.reminders.tick();s.time(1);await s.reminders.tick();s.time(3);await s.reminders.tick();
 expect(await s.reminders.handle("chat","yes","yes")).toBe("Started");expect(await s.reminders.handle("chat","yes","yes")).toBe("Started");expect(s.starts).toBe(1);
 });
 test("failed model calls are capped at four per Pacific day",async()=>{
 const s=await setup();s.fail();
 for(const base of [0,14,28,42,56])for(const offset of [0,1,3]){s.time(base+offset);await s.smart.evaluate("chat",s.block);}
 expect(s.calls).toBe(4);expect(await s.smart.handle("chat",undefined,"why quiet")).toContain("daily_model_budget");
 });
