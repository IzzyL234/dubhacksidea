import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyReminders, isQuiet, type ReminderDependencies } from "../src/proactive.ts";
import { studyBlock, type StudyBlock } from "../src/study-events.ts";
import { StudySessions } from "../src/sessions.ts";

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const noon=Date.parse("2026-10-17T19:00:00Z"); // Noon Pacific, independent of host timezone.
async function setup(){
  const root=await mkdtemp(join(tmpdir(),"study-reminders-"));dirs.push(root);
  let now=noon,busy=false,draft=false,active=true,failSend=false,failCalendar=false,reads=0;
  let blocks:StudyBlock[]=[{key:"calendar:one",title:"Study math",start:noon,end:noon+45*60000}];
  const sent:{conversation:string;text:string}[]=[],started:string[]=[];
  const deps:ReminderDependencies={now:()=>now,events:async()=>{reads++;if(failCalendar)throw Error("calendar unavailable");return blocks;},
    send:async(conversation,text)=>{sent.push({conversation,text});if(failSend)throw Error("ambiguous delivery");},
    busy:async()=>busy,checkIn:async()=>draft,active:async()=>active,
    start:async(_conversation,block)=>{started.push(block.key);busy=true;return{id:"session-one",reply:"Started your session"};},
  };
  const make=()=>new StudyReminders(deps,join(root,"state.json"));
  return {root,make,reminders:make(),sent,started,get reads(){return reads;},
    time:(value:number)=>{now=value;},blocks:(value:StudyBlock[])=>{blocks=value;},busy:(value:boolean)=>{busy=value;},
    draft:(value:boolean)=>{draft=value;},active:(value:boolean)=>{active=value;},failSend:(value:boolean)=>{failSend=value;},failCalendar:(value:boolean)=>{failCalendar=value;}};
}
test("only timed, uncanceled study titles with usable durations are eligible; recurring instances stay distinct",()=>{
  const e={id:"instance-one",summary:"Study math",start:{dateTime:"2026-10-17T12:00:00-07:00"},end:{dateTime:"2026-10-17T12:45:00-07:00"}};
  expect(studyBlock("calendar",e)?.start).toBe(noon);
  expect(studyBlock("calendar",{...e,id:"instance-two"})?.key).not.toBe(studyBlock("calendar",e)?.key);
  expect(studyBlock("calendar",{...e,summary:"Math class"})).toBeNull();
  expect(studyBlock("calendar",{...e,status:"cancelled"})).toBeNull();
  expect(studyBlock("calendar",{...e,start:{}})).toBeNull();
  expect(studyBlock("calendar",{...e,end:{dateTime:"2026-10-17T12:01:00-07:00"}})).toBeNull();
});
test("disabled reminders never read Calendar; one chat binding survives restart and off stops polling",async()=>{
  const s=await setup();await s.reminders.tick();expect(s.reads).toBe(0);
  await s.reminders.handle("a","reminders on","on");
  expect(await s.reminders.handle("b","reminders on","on-b")).toContain("another chat");
  await s.make().tick();expect(s.sent[0]?.conversation).toBe("a");
  await s.reminders.handle("a","reminders off","off");
  const reads=s.reads;await s.make().tick();expect(s.reads).toBe(reads);
});
test("start prompts and end prompts are sent once across restart; yes alone creates the linked session",async()=>{
  const s=await setup();await s.reminders.handle("a","reminders on","on");
  await s.reminders.tick();await s.make().tick();expect(s.sent).toHaveLength(1);expect(s.started).toHaveLength(0);
  expect(await s.make().handle("a","yes","yes")).toContain("Started");
  await s.make().handle("a","yes","yes");expect(s.started).toHaveLength(1);
  s.time(noon+45*60000);await s.make().tick();await s.make().tick();
  expect(s.sent).toHaveLength(2);expect(s.sent[1]?.text).toContain("text done");
});
test("skip and unconfirmed prompts never produce sessions or end followups",async()=>{
  const s=await setup();await s.reminders.handle("a","reminders on","on");await s.reminders.tick();
  expect(await s.reminders.handle("a","skip","skip")).toContain("Skipped");
  s.time(noon+45*60000);await s.reminders.tick();expect(s.started).toHaveLength(0);expect(s.sent).toHaveLength(1);
});
test("busy sessions, rating drafts, and completed linked sessions suppress unnecessary prompts",async()=>{
  const s=await setup();await s.reminders.handle("a","reminders on","on");s.busy(true);await s.reminders.tick();expect(s.sent).toHaveLength(0);
  s.busy(false);await s.reminders.tick();s.draft(true);
  expect(await s.reminders.handle("a","skip","source-answer")).toBeNull();
  s.draft(false);await s.reminders.handle("a","yes","yes");s.active(false);
  s.time(noon+45*60000);await s.reminders.tick();expect(s.sent).toHaveLength(1);
});
test("quiet hours use Pacific time through DST and suppress both polling and prompts",async()=>{
  expect(isQuiet(Date.parse("2026-10-18T05:00:00Z"),22,8)).toBe(true); // 10 PM PDT
  expect(isQuiet(Date.parse("2026-12-18T06:00:00Z"),22,8)).toBe(true); // 10 PM PST
  expect(isQuiet(noon,22,8)).toBe(false);
  const s=await setup();await s.reminders.handle("a","reminders on","on");s.time(Date.parse("2026-10-18T05:00:00Z"));await s.reminders.tick();expect(s.reads).toBe(0);
  expect(await s.reminders.handle("a","quiet hours 9 17","hours")).toContain("9:00");s.time(noon);await s.reminders.tick();expect(s.reads).toBe(0);
  expect(await s.reminders.handle("a","quiet hours 8 08","invalid")).toContain("different hours");
});
test("canceled/rescheduled events are revalidated at yes; late starts do not create stale reminders",async()=>{
  const s=await setup();await s.reminders.handle("a","reminders on","on");await s.reminders.tick();
  s.blocks([]);expect(await s.reminders.handle("a","yes","yes")).toContain("changed or ended");expect(s.started).toHaveLength(0);
  const late=await setup();await late.reminders.handle("a","reminders on","on");late.time(noon+6*60000);await late.reminders.tick();expect(late.sent).toHaveLength(0);
});
test("ambiguous send failures are reserved before sending and never spam on retry",async()=>{
  const s=await setup();await s.reminders.handle("a","reminders on","on");s.failSend(true);
  await expect(s.reminders.tick()).rejects.toThrow("delivery");
  s.failSend(false);await s.make().tick();expect(s.sent).toHaveLength(1);
});
test("calendar outages do not fabricate sessions and simultaneous ticks cannot duplicate a prompt",async()=>{
  const s=await setup();await s.reminders.handle("a","reminders on","on");s.failCalendar(true);
  await expect(s.reminders.tick()).rejects.toThrow("calendar");expect(s.sent).toHaveLength(0);
  s.failCalendar(false);await Promise.all([s.reminders.tick(),s.reminders.tick()]);expect(s.sent).toHaveLength(1);
});
test("calendar-confirmed sessions persist with an idempotent event identity and do not replace manual sessions",async()=>{
  const root=await mkdtemp(join(tmpdir(),"calendar-session-"));dirs.push(root);
  const make=()=>new StudySessions(join(root,"sessions"),null);
  const s=make();const first=await s.startCalendar("a","event-instance",45);
  expect(first?.id).toStartWith("cal_");expect(await s.hasUnfinished("a")).toBe(true);
  expect((await make().startCalendar("a","event-instance",45))?.id).toBe(first?.id);
  expect(await s.startCalendar("a","another-instance",45)).toBeNull();
  expect(await s.handle("a","library desk","context")).toContain("Context saved");
  expect(await s.isActive("a",first!.id)).toBe(true);
});
