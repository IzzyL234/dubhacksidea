import {test,expect,afterEach} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {SmartPrompts} from "../src/smart-prompts.ts";
import {StudyReminders} from "../src/proactive.ts";
import {MessageDelivery} from "../src/message-delivery.ts";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function root(){const d=await mkdtemp(join(tmpdir(),"arrival-"));dirs.push(d);return d;}
test("arrival check-in requires dwell, works without Calendar, and does not start or save a spot",async()=>{
 const dir=await root();let now=Date.parse("2026-10-17T19:00:00Z"),starts=0,calls=0;const sent:string[]=[];
 const smart=new SmartPrompts({coordinatorPlaces:true,now:()=>now,read:async()=>({latitude:47,longitude:-122,accuracy:10,locationType:"live",locationTimestamp:new Date(now),isLocatingInProgress:false}),decide:async facts=>{calls++;expect(JSON.stringify(facts)).not.toContain("latitude");return facts.placeEvidence?.arrivalCheckInEligible?{action:"check_in",reason:"uncertain_context",confidence:.9,optionId:null}:{action:"stay_quiet",reason:"poor_timing",confidence:.9,optionId:null};}},join(dir,"smart"));
 await smart.handle("chat","+15555550123","smart prompts on");
 const reminders=new StudyReminders({coordinate:(c,b,a)=>smart.evaluate(c,b,a),events:async()=>{throw Error("calendar offline");},busy:async()=>false,checkIn:async()=>false,active:async()=>false,start:async()=>{starts++;return null;},send:async(_c,t)=>{sent.push(t);},now:()=>now},join(dir,"reminders.json"));
 await reminders.handle("chat","reminders on","enable");
 for(const minutes of [0,1,3]){now=Date.parse("2026-10-17T19:00:00Z")+minutes*60000;await reminders.tick();}
 expect(sent).toHaveLength(1);expect(sent[0]).toContain("What are you working on");expect(starts).toBe(0);expect(await reminders.handle("chat","yes","yes")).toBeNull();
 now+=11*60000;await reminders.tick();expect(sent).toHaveLength(1);expect(calls).toBeGreaterThan(0);
 expect(await smart.handle("chat",undefined,"proactivity status")).toContain("Saved places: none");
});
test("redelivered messages are handled once across concurrent instances and restarts",async()=>{
 const dir=await root();const a=new MessageDelivery(dir),b=new MessageDelivery(dir);
 expect((await Promise.all([a.claim("chat","done"),b.claim("chat","done")])).filter(Boolean)).toHaveLength(1);
 expect(await new MessageDelivery(dir).claim("chat","done")).toBe(false);expect(await a.claim("other","done")).toBe(true);expect(await a.claim("chat","new")).toBe(true);
});
test("an intermittent stale snapshot suppresses sending but does not erase recent dwell evidence",async()=>{
 const dir=await root();const base=Date.parse("2026-10-17T19:00:00Z");let now=base,captured=base,calls=0;
 const smart=new SmartPrompts({coordinatorPlaces:true,now:()=>now,read:async()=>({latitude:47,longitude:-122,accuracy:10,locationType:"shallow",locationTimestamp:new Date(captured),isLocatingInProgress:false}),decide:async()=>{calls++;return {action:"check_in",reason:"uncertain_context",confidence:.9,optionId:null};}},dir);
 await smart.handle("chat","+15555550123","smart prompts on");await smart.evaluate("chat");now=base+60000;captured=now;await smart.evaluate("chat");
 now=base+150000;captured=base;expect((await smart.evaluate("chat")).reason).toBe("location_stale_or_inaccurate");expect(calls).toBe(0);
 now=base+210000;captured=now;expect((await smart.evaluate("chat")).kind).toBe("checkin");expect(calls).toBe(1);
});
