import { afterEach,expect,test } from "bun:test";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { busyIntervals,openWindows } from "../src/open-time.ts";
import { parseCalendarTime } from "../src/time.ts";
import { demoSchedule } from "../src/demo-schedule.ts";
import { CalendarCommands } from "../src/calendar-commands.ts";
import type { CalendarGateway,DemoEvent,EventInput } from "../src/calendar-types.ts";
import { StudyReminders } from "../src/proactive.ts";
const t=(s:string)=>parseCalendarTime(`2026-10-19 ${s}`);
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
test("finds gaps around commitments of any title, merges overlaps, and applies buffers",()=>{
  const gaps=openWindows([{start:t("09:00"),end:t("10:00")},{start:t("09:30"),end:t("10:30")},{start:t("12:00"),end:t("13:00")}],t("08:00"),1);
  expect(gaps.map(g=>[g.start,g.end])).toEqual([[t("10:40"),t("11:50")],[t("13:10"),t("20:00")]]);
  expect(gaps.every(g=>g.kind==="open")).toBe(true);
});
test("all-day busy events block the day; deadlines marked free and declined invitations do not",()=>{
  const events:DemoEvent[]=[{start:{date:"2026-10-19"},end:{date:"2026-10-20"}},
    {transparency:"transparent",start:{dateTime:new Date(t("10:00")).toISOString()},end:{dateTime:new Date(t("11:00")).toISOString()}},
    {attendees:[{self:true,responseStatus:"declined"}],start:{dateTime:new Date(t("12:00")).toISOString()},end:{dateTime:new Date(t("13:00")).toISOString()}}];
  expect(busyIntervals(events)).toHaveLength(1);expect(openWindows(busyIntervals(events),t("08:00"),1)).toHaveLength(0);
});
test("gap identity is stable as time passes and past/short openings disappear",()=>{
  const a=openWindows([],t("10:00"),1),b=openWindows([],t("11:00"),1);
  expect(a[0]?.key).toBe(b[0]?.key);expect(openWindows([],t("19:31"),1)).toHaveLength(0);
  expect(()=>openWindows([{start:NaN,end:t("12:00")}],t("08:00"))).toThrow();
});
test("Pacific conversions handle DST and reject invalid or ambiguous local times",()=>{
  expect(parseCalendarTime("2026-10-19 09:00")).toBe(Date.parse("2026-10-19T16:00:00Z"));
  expect(parseCalendarTime("2026-12-19 09:00")).toBe(Date.parse("2026-12-19T17:00:00Z"));
  expect(()=>parseCalendarTime("2026-03-08 02:30")).toThrow();
  expect(()=>parseCalendarTime("2026-11-01 01:30")).toThrow();
  expect(()=>parseCalendarTime("2026-02-30 12:00")).toThrow();
});
test("synthetic schedule has 25 labeled, guest-free events and stable unique IDs",()=>{
  const a=demoSchedule(Date.parse("2026-10-17T19:00:00Z")),b=demoSchedule(Date.parse("2026-10-17T20:00:00Z"));
  expect(a).toHaveLength(25);expect(a.map(e=>e.id)).toEqual(b.map(e=>e.id));expect(new Set(a.map(e=>e.id)).size).toBe(25);
  expect(a.every(e=>e.summary.startsWith("[DEMO]")&&!('attendees' in e))).toBe(true);
  expect(a[0]?.start.dateTime).toBe("2026-10-19T16:00:00.000Z");
});
test("calendar commands perform real gateway actions once and protect changed events",async()=>{
  const root=await mkdtemp(join(tmpdir(),"calendar-tools-"));dirs.push(root);let creates=0,patches=0;
  let event:DemoEvent={id:"event-one",etag:"v1",summary:"Math",start:{dateTime:new Date(t("09:00")).toISOString()}};
  const api:CalendarGateway={list:async()=>[event],busy:async()=>[],get:async()=>event,
    create:async(e:EventInput)=>{creates++;return e;},patch:async(_id,_etag,p)=>{patches++;event={...event,...p,etag:"v2"};return event;}};
  const c=new CalendarCommands(api,root,()=>t("08:00"));
  const add="add event Study math | 2026-10-19 14:00 | 2026-10-19 14:45";
  expect(await c.handle("a",add,"add")).toContain("Added");await c.handle("a",add,"add");expect(creates).toBe(1);
  expect(await c.handle("b","rename event 1 | New","rename-b")).toContain("calendar events first");
  await c.handle("a","calendar events","list");
  expect(await c.handle("a","rename event 1 | New","rename")).toContain("Updated");expect(patches).toBe(1);
  expect(await c.handle("a","move event 1 | 2026-10-19 15:00 | 2026-10-19 15:45","move")).toContain("changed");expect(patches).toBe(1);
  expect(await c.handle("a","add event Invalid | 2026-10-19 14:00 | 2026-10-19 13:00","bad")).toContain("future start");
});
test("open-time prompts work inside an existing gap, and confirmation freezes the session end",async()=>{
  const root=await mkdtemp(join(tmpdir(),"open-reminders-"));dirs.push(root);let now=t("12:00"),plannedEnd=0;const sent:string[]=[];
  const r=new StudyReminders({now:()=>now,events:async()=>openWindows([],now,1),send:async(_c,s)=>{sent.push(s);},busy:async()=>false,checkIn:async()=>false,active:async()=>true,
    start:async(_c,b)=>{plannedEnd=b.end;return{id:"session",reply:"Started"};}},join(root,"state.json"));
  await r.handle("a","reminders on","on");await r.tick();expect(sent[0]).toContain("free minutes now");
  await r.handle("a","yes","yes");expect(plannedEnd).toBe(t("12:45"));
  now=t("12:20");await r.tick();expect(sent).toHaveLength(1);
  now=t("12:45");await r.tick();expect(sent).toHaveLength(2);
});
