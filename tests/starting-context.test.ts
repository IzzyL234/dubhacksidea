import {afterEach,expect,test} from "bun:test";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {StudySessions,sessionContext,type StudySession} from "../src/sessions.ts";
import {features} from "../src/learning.ts";
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function setup(){const root=await mkdtemp(join(tmpdir(),"starting-context-"));dirs.push(root);let now=Date.parse("2026-10-17T19:00:00Z");const make=()=>new StudySessions(join(root,"sessions"),null,join(root,"feedback"),"unused-seed",async()=>({clutter_score:2,lighting:"bright" as const,ergonomics:8}),null,()=>now);return{root,make,sessions:make(),advance:(ms:number)=>{now+=ms;}};}
async function record(root:string){const [file]=await readdir(join(root,"sessions"));return JSON.parse(await readFile(join(root,"sessions",file!),"utf8")).sessions[0] as StudySession;}
test("manual start collects optional energy/noise, survives restart, and never changes learner features",async()=>{
 const {root,sessions,make}=await setup();expect(await sessions.handle("chat","start studying","start")).toContain("photo of your workspace");
 await sessions.handle("chat","library desk 45","place");await sessions.handle("chat","workspace bright 2 8","workspace");
 const before=features(sessionContext(await record(root))!);
 expect(await sessions.handle("chat","starting context 2 loud","starting")).toContain("don't change today's model score");
 const saved=await record(root);expect(saved).toMatchObject({starting_energy:2,starting_noise:"loud",starting_context_at:saved.started_at});
 expect(features(sessionContext(saved)!)).toEqual(before);expect(await make().handle("chat","study status","status")).toContain("Starting energy 2/5; noise loud");
});
test("invalid, missing, late and post-session starting context never fabricate baseline values",async()=>{
 const {root,sessions,advance}=await setup();expect(await sessions.handle("chat","starting context 2 loud","before")).toContain("Start a study");
 await sessions.handle("chat","start studying","start");expect((await record(root)).starting_energy).toBeNull();
 expect(await sessions.handle("chat","starting context 9 noisy","invalid")).toContain("Use starting context");expect((await record(root)).starting_energy).toBeNull();
 await sessions.handle("chat","starting context unknown unknown","unknown");expect((await record(root)).starting_energy).toBeNull();expect((await record(root)).starting_noise).toBe("unknown");
 advance(5*60_000+1);expect(await sessions.handle("chat","starting context 1 loud","late")).toContain("first 5 minutes");expect((await record(root)).starting_noise).toBe("unknown");
 await sessions.beginFeedback((await record(root)).user_id);expect(await sessions.handle("chat","starting context 3 quiet","after")).toContain("Start a study");
});
test("calendar-linked sessions collect the same optional starting context and duplicate replies are stable",async()=>{
 const {root,sessions}=await setup();expect((await sessions.startCalendar("chat","opening",45))?.reply).toContain("photo of your workspace");
 const reply=await sessions.handle("chat","starting context 5 quiet","baseline");expect(await sessions.handle("chat","starting context 5 quiet","baseline")).toBe(reply);expect(await record(root)).toMatchObject({starting_energy:5,starting_noise:"quiet",duration_mins:45});
});
