import {test,expect,afterEach} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StudySessions} from "../src/sessions.ts";
import type {CalendarGateway,EventInput} from "../src/calendar-types.ts";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function root(){const d=await mkdtemp(join(tmpdir(),"completed-calendar-"));dirs.push(d);return d;}
test("done logs actual elapsed interval once, independent of planned duration",async()=>{
 const dir=await root();let now=Date.parse("2026-10-17T19:00:00Z");const start=now;const events:EventInput[]=[];
 const gateway:CalendarGateway={list:async()=>[],busy:async()=>[],get:async()=>({}),patch:async()=>({}),create:async e=>{events.push(e);return e;}};
 const s=new StudySessions(dir,null,join(dir,"feedback"),undefined,undefined,null,()=>now);await s.handle("chat","start studying","start");await s.handle("chat","library desk 45","context");now+=32*60000;
 const result=await Promise.all([s.finishCalendar("chat",gateway),s.finishCalendar("chat",gateway)]);expect(result[0]).toContain("actual start");expect(events).toHaveLength(1);expect(Date.parse(events[0]!.start.dateTime)).toBe(start);expect(Date.parse(events[0]!.end.dateTime)).toBe(now);
 expect(await s.handle("chat","study status","status")).toContain("awaiting feedback");
});
test("failed completion booking can retry after restart without shifting the session times",async()=>{
 const dir=await root();let now=Date.parse("2026-10-17T19:00:00Z"),fail=true;const attempts:EventInput[]=[];
 const gateway:CalendarGateway={list:async()=>[],busy:async()=>[],get:async()=>({}),patch:async()=>({}),create:async e=>{attempts.push(e);if(fail)throw Error("network");return e;}};
 const make=()=>new StudySessions(dir,null,join(dir,"feedback"),undefined,undefined,null,()=>now);const s=make();await s.handle("chat","start studying","start");now+=20*60000;expect(await s.finishCalendar("chat",gateway)).toContain("session ended");fail=false;now+=10*60000;
 expect(await make().retryCalendar("chat",gateway)).toContain("added");expect(attempts[1]!.id).toBe(attempts[0]!.id);expect(attempts[1]!.end).toEqual(attempts[0]!.end);
});
