import {test,expect,afterEach} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {requestedCalendarDate,respectRequestedCalendarDate} from "../src/calendar-language.ts";
import {CalendarCommands,isCalendarWriteRequest} from "../src/calendar-commands.ts";
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

test("ski-club follow-up stays in the event editor across restart and never searches study gaps",async()=>{
 const dir=await root(),at=Date.parse('2026-10-18T17:00:00Z');let writes=0;const created:any[]=[];
 const gateway={list:async()=>{throw Error('No listing needed')},busy:async()=>{throw Error('No free-study search allowed')},get:async()=>({}),patch:async()=>({}),create:async(e:any)=>{writes++;created.push(e);return e;}};
 const interpret=async(text:string,previous:string[],reference:number)=>{expect(reference).toBe(at);if(previous.length===0)return {action:'clarify' as const,title:'Ski club event',start:null,end:null,question:'What time and for how long?'};expect(previous).toEqual(['schedule ski club event next thurs']);expect(text).toBe('6 pm for an hour');return {action:'add' as const,title:'Ski club event',start:'2026-10-22 18:00',end:'2026-10-22 19:00',question:null};};
 const first=new CalendarCommands(gateway,dir,()=>at,interpret);expect(await first.shouldHandleTurn('chat','schedule ski club event next thurs')).toBe(true);expect(await first.handle('chat','schedule ski club event next thurs','first')).toContain('What time');
 const resumed=new CalendarCommands(gateway,dir,()=>at+60000,interpret);expect(await resumed.shouldHandleTurn('chat','6 pm for an hour')).toBe(true);expect(await resumed.handle('chat','6 pm for an hour','followup')).toContain('Ski club event');expect(created[0].start.dateTime).toBe('2026-10-23T01:00:00.000Z');expect(writes).toBe(1);expect(await resumed.shouldHandleTurn('chat','hi')).toBe(false);
});
test('explicit date anchors survive time-only replies and support corrections without substituting Sunday',()=>{
 const at=Date.parse('2026-10-18T17:00:00Z');expect(requestedCalendarDate(['schedule ski club next thurs','6 pm for an hour'],at)).toBe('2026-10-22');expect(requestedCalendarDate(['schedule ski club next thurs','actually Friday at 6'],at)).toBe('2026-10-23');expect(requestedCalendarDate(['schedule tomorrow','6 pm'],at)).toBe('2026-10-19');expect(isCalendarWriteRequest('can you schedule ski club next thurs')).toBe(true);expect(isCalendarWriteRequest('schedule review on')).toBe(false);expect(isCalendarWriteRequest('where should I study')).toBe(false);
});

test('a model-generated Sunday cannot override a Thursday event anchor',()=>{
 const r=respectRequestedCalendarDate({action:'add',title:'Ski club event',start:'2026-10-18 18:00',end:'2026-10-18 19:00',question:null},'2026-10-22');expect(r.action).toBe('clarify');expect(r.title).toBe('Ski club event');expect(r.question).toContain('2026-10-22');expect(isCalendarWriteRequest('schedule a study block for me')).toBe(false);
});
