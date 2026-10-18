import {afterEach,expect,test} from "bun:test";
import {mkdtemp,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {StudySessions} from "../src/sessions.ts";
import {StudyReminders} from "../src/proactive.ts";
import {bookStudyEvent,studyEventId} from "../src/study-calendar.ts";
import type {CalendarGateway,DemoEvent} from "../src/calendar-types.ts";
import {openWindows,busyIntervals} from "../src/open-time.ts";
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const noon=Date.parse("2026-10-17T19:00:00Z");
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),"book-study-"));dirs.push(dir);let now=noon,fail="",creates=0,attempts=0;
 const events=new Map<string,DemoEvent>();
 const gateway:CalendarGateway={list:async()=>[...events.values()],busy:async()=>busyIntervals([...events.values()]),get:async id=>events.get(id)!,patch:async()=>({}),create:async e=>{
   attempts++;if(fail==="auth")throw Error("CALENDAR_WRITE_AUTH_REQUIRED");if(events.has(e.id!))return events.get(e.id!)!;
   events.set(e.id!,e);creates++;if(fail==="timeout"){fail="";throw Error("response lost");}return e;
 }};
 const make=()=>new StudySessions(join(dir,"sessions"),null,join(dir,"feedback"),"unused",undefined,null,()=>now);
 const s=make(),plan={gateway,start:noon,end:noon+45*60000};
 return{dir,make,s,plan,gateway,events,get creates(){return creates;},get attempts(){return attempts;},fail:(value:string)=>{fail=value;},time:(t:number)=>{now=t;}};
}
async function doc(dir:string){const [file]=await readdir(join(dir,"sessions"));return JSON.parse(await readFile(join(dir,"sessions",file!),"utf8"));}
test("yes starts one tracked session and creates one verified calendar event",async()=>{
 const x=await setup();const block={key:"opening",title:"Open time",start:noon,end:x.plan.end,kind:"open" as const};
 const r=new StudyReminders({now:()=>noon,events:async()=>[block],send:async(_c,text)=>{expect(text).toContain("add it to Hackathon Demo");},busy:c=>x.s.hasUnfinished(c),checkIn:async()=>false,active:(c,id)=>x.s.isActive(c,id),start:(c,b)=>x.s.startCalendar(c,b.key,(b.end-b.start)/60000,{gateway:x.gateway,start:b.start,end:b.end})},join(x.dir,"reminders.json"));
 await r.handle("chat","reminders on","on");await r.tick();expect(x.creates).toBe(0);
 const result=await r.handle("chat","yes","yes");expect(result).toContain("Added it to Hackathon Demo");await r.handle("chat","yes","yes");
 expect(x.creates).toBe(1);expect((await doc(x.dir)).sessions).toHaveLength(1);const event=[...x.events.values()][0]!;
 expect(event.id).toMatch(/^[a-v0-9]{5,1024}$/);expect(event.attendees).toBeUndefined();expect(event.start?.dateTime).toBe(new Date(noon).toISOString());
});
test("concurrent duplicate starts and confirmed retries never create duplicate events",async()=>{
 const x=await setup();await Promise.all([x.s.startCalendar("chat","one",45,x.plan),x.s.startCalendar("chat","one",45,x.plan)]);
 expect(x.creates).toBe(1);expect(await x.make().retryCalendar("chat",x.gateway)).toContain("already added");expect(x.attempts).toBe(1);
});
test("missing write permission leaves a tracked session and a durable, explicit retry",async()=>{
 const x=await setup();x.fail("auth");const result=await x.s.startCalendar("chat","one",45,x.plan);
 expect(result?.reply).toContain("calendar booking was not confirmed");expect(result?.reply).toContain("calendar-write-auth.mjs");expect(await x.s.hasUnfinished("chat")).toBe(true);expect(x.creates).toBe(0);
 x.fail("");expect(await x.make().retryCalendar("chat",x.gateway)).toContain("original session time was kept");expect(x.creates).toBe(1);
});
test("uncertain network response recovers the original event after restart without shifting its time",async()=>{
 const x=await setup();x.fail("timeout");expect((await x.s.startCalendar("chat","one",45,x.plan))?.reply).toContain("may already exist");expect(x.creates).toBe(1);
 x.time(noon+3*60000);expect(await x.make().retryCalendar("chat",x.gateway)).toContain("added to Hackathon Demo");expect(x.creates).toBe(1);
 expect([...x.events.values()][0]?.start?.dateTime).toBe(new Date(noon).toISOString());
});
test("conflicts, changed events, busy sessions, skips, and expired retries cannot silently book",async()=>{
 const x=await setup();x.events.set("other",{id:"other",start:{dateTime:new Date(noon+10*60000).toISOString()},end:{dateTime:new Date(noon+20*60000).toISOString()}});
 expect((await x.s.startCalendar("chat","one",45,x.plan))?.reply).toContain("conflicting commitment");expect(x.creates).toBe(0);
 expect(await x.s.startCalendar("chat","another",45,x.plan)).toBeNull();
 x.events.clear();x.time(x.plan.end+1);expect(await x.s.retryCalendar("chat",x.gateway)).toContain("block has ended");expect(x.creates).toBe(0);
 await expect(bookStudyEvent({...x.gateway,create:async e=>({...e,status:"cancelled"})},"session",x.plan)).rejects.toThrow("CHANGED");
 expect(studyEventId("session")).toBe(studyEventId("session"));
});
test("manual start remains separate from calendar booking",async()=>{
 const x=await setup();await x.s.handle("chat","start studying","manual");expect(await x.s.retryCalendar("chat",x.gateway)).toContain("No active study session has a calendar booking");expect(x.creates).toBe(0);
});
test("24-hour openings cross midnight; quiet hours are opt-in and can be disabled",async()=>{
 const night=Date.parse("2026-10-18T06:50:00Z"); // 11:50 PM Pacific
 const gaps=openWindows([],night);expect(gaps[0]!.end-night).toBeGreaterThan(30*60000);
 const x=await setup();let sends=0;const path=join(x.dir,"reminders.json");
 // A legacy default quiet window must no longer impose an automatic nightly cutoff.
 await writeFile(path,JSON.stringify({conversation:"chat",enabled:true,quietStart:22,quietEnd:8,events:{},replies:[]}));
 const make=()=>new StudyReminders({now:()=>night,events:async()=>gaps,send:async()=>{sends++;},busy:async()=>false,checkIn:async()=>false,active:async()=>true,start:async()=>null},path);
 await make().handle("chat","quiet hours 22 8","quiet");await make().tick();expect(sends).toBe(0);
 expect(await make().handle("chat","quiet hours off","off")).toContain("any hour");await make().tick();expect(sends).toBe(1);
});
test("legacy quiet defaults do not block an overnight invitation",async()=>{
 const x=await setup();const night=Date.parse("2026-10-18T06:00:00Z");let sends=0;const path=join(x.dir,"legacy-reminders.json");
 await writeFile(path,JSON.stringify({conversation:"chat",enabled:true,quietStart:22,quietEnd:8,events:{},replies:[]}));
 const r=new StudyReminders({now:()=>night,events:async()=>openWindows([],night),send:async()=>{sends++;},busy:async()=>false,checkIn:async()=>false,active:async()=>true,start:async()=>null},path);
 await r.tick();expect(sends).toBe(1);
});
