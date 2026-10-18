import {test,expect,afterEach} from "bun:test";
import {mkdtemp,rm,readFile,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SessionContext,validateExtra} from "../src/session-context.ts";
import type {SessionFeedback} from "../src/feedback.ts";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function root(){const d=await mkdtemp(join(tmpdir(),"session-context-"));dirs.push(d);return d;}
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const now=Date.parse("2026-10-17T19:00:00Z");
const record:SessionFeedback={id:"feedback-one",conversation_key:hash("chat"),session_id:"session-one",reported_at:new Date(now).toISOString(),productivity_rating:4,mood_rating:5,distraction_rating:2,distraction_source:null,is_synthetic:false};
const tags={sentiment:"positive" as const,social:"with_others" as const,socialEffect:"helpful" as const,factors:["social_support" as const]};
test("optional context is linked only after confirmation and raw text is not stored",async()=>{
 const dir=await root();let calls=0;const make=()=>new SessionContext(dir,async()=>{calls++;return tags;},()=>now);
 const flow=make();await flow.arm(record);expect(await flow.question("chat")).toContain("Anything else");expect(await flow.question("chat")).toBeNull();
 expect(await flow.handle("chat","My friends Alice and Ben helped me focus","note")).toContain("Reply yes");expect((await flow.summary("chat")).confirmedNotes).toBe(0);
 const restarted=make();expect(await restarted.handle("chat","yes","confirm")).toContain("unchanged");expect((await restarted.summary("chat")).recent[0]).toMatchObject({productivity:4,mood:5,socialEffect:"helpful"});
 expect((await restarted.summary("other")).confirmedNotes).toBe(0);await restarted.handle("chat","yes","confirm");expect((await restarted.summary("chat")).confirmedNotes).toBe(1);expect(calls).toBe(1);
 const file=(await readdir(dir)).find(n=>n===hash("chat")+".json")!;const text=await readFile(join(dir,file),"utf8");expect(text).not.toContain("Alice");expect(text).not.toContain("Ben");
});
test("skip preserves ratings, does not create a learning note or rearm on cloud retry",async()=>{
 const flow=new SessionContext(await root(),async()=>tags,()=>now);await flow.arm(record);await flow.question("chat");expect(await flow.handle("chat","skip","skip")).toContain("already saved");await flow.arm(record);expect(await flow.question("chat")).toBeNull();expect((await flow.summary("chat")).confirmedNotes).toBe(0);
});
test("corrections and failed interpretations never become learned context",async()=>{
 let calls=0;const flow=new SessionContext(await root(),async()=>{if(++calls===1)throw Error("offline");return tags;},()=>now);await flow.arm(record);await flow.question("chat");expect(await flow.handle("chat","A difficult task","one")).toContain("couldn't");await flow.handle("chat","Friends helped","two");await flow.handle("chat","no","no");expect((await flow.summary("chat")).confirmedNotes).toBe(0);expect(await flow.handle("chat","Friends distracted me","three")).toContain("skip");
});
test("ordinary commands bypass optional notes and expired notes do not consume chat",async()=>{
 const dir=await root();let time=now;const flow=new SessionContext(dir,async()=>tags,()=>time);await flow.arm(record);await flow.question("chat");expect(await flow.handle("chat","add math tomorrow","command")).toBeNull();expect((await flow.summary("chat")).confirmedNotes).toBe(0);
 await flow.arm({...record,id:"two"});time+=25*3600000;expect(await flow.handle("chat","hello","late")).toBeNull();
});
test("invented fields, ratings and unrecognized tags are rejected",()=>{
 expect(()=>validateExtra({...tags,productivity:1})).toThrow();expect(()=>validateExtra({...tags,socialEffect:"bad"})).toThrow();expect(()=>validateExtra({...tags,factors:["diagnosis"]})).toThrow();
});
