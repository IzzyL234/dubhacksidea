import {test,expect,afterEach} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CalendarCommands} from "../src/calendar-commands.ts";
import {StudySessions} from "../src/sessions.ts";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function root(){const d=await mkdtemp(join(tmpdir(),"natural-calendar-"));dirs.push(d);return d;}
const now=Date.parse("2026-10-17T19:00:00Z");
test("clarification survives restart and duplicate natural requests create once",async()=>{
 const dir=await root();let writes=0,parses=0;
 const gateway={list:async()=>[],busy:async()=>[],get:async()=>({}),patch:async()=>({}),create:async(e:any)=>{writes++;return e;}};
 const interpret=async(text:string,previous:string[])=>{parses++;if(text==="tomorrow at 3pm for an hour"){expect(previous).toEqual(["schedule math"]);return {action:"add" as const,title:"Math",start:"2026-10-18 15:00",end:"2026-10-18 16:00",question:null};}return {action:"clarify" as const,title:null,start:null,end:null,question:"When and for how long?"};};
 expect(await new CalendarCommands(gateway,dir,()=>now,interpret).handle("chat","schedule math","one")).toContain("When");expect(writes).toBe(0);
 const c=new CalendarCommands(gateway,dir,()=>now,interpret);
 const replies=await Promise.all([c.handle("chat","tomorrow at 3pm for an hour","two"),c.handle("chat","tomorrow at 3pm for an hour","two")]);
 expect(replies[0]).toContain("Added");expect(replies[1]).toBe(replies[0]);expect(writes).toBe(1);expect(parses).toBe(2);
});
test("invalid natural event dates never reach Calendar and unrelated chat passes through",async()=>{
 const dir=await root();let writes=0;const gateway={list:async()=>[],busy:async()=>[],get:async()=>({}),patch:async()=>({}),create:async(e:any)=>{writes++;return e;}};
 const c=new CalendarCommands(gateway,dir,()=>now,async text=>text==="hello"?{action:"none",title:null,start:null,end:null,question:null}:{action:"add",title:"Past",start:"2020-01-01 10:00",end:"2020-01-01 11:00",question:null});
 expect(await c.handle("chat","hello","one")).toBeNull();expect(await c.handle("chat","schedule past","two")).toContain("future");expect(writes).toBe(0);
});
test("energy is asked only after successful photo analysis, once across restart",async()=>{
 const dir=await root();const make=()=>new StudySessions(dir,null,join(dir,"feedback"),"unused",async()=>({clutter_score:2,lighting:"bright",ergonomics:8}),null,()=>now);
 const s=make();expect(await s.handle("chat","start studying","start")).toContain("photo");expect(await s.nextEnergyQuestion("chat")).toBeNull();
 await s.photo("chat","photo","image/jpeg",async()=>new Uint8Array([1]));expect(await s.nextEnergyQuestion("chat")).toContain("energy");expect(await make().nextEnergyQuestion("chat")).toBeNull();
 expect(await make().answerEnergy("chat","3","energy")).toContain("3/5");
});
