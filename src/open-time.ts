import { addDays, localDate, parseCalendarTime } from "./time.ts";
import type { StudyBlock } from "./study-events.ts";
import type { DemoEvent } from "./calendar-types.ts";
export type Busy = { start:number; end:number };
export function busyIntervals(events:DemoEvent[]):Busy[] {
  return events.filter(e=>e.status!=="cancelled"&&e.transparency!=="transparent"
    &&!e.attendees?.some(a=>Boolean((a as {self?:boolean}).self)&&(a as {responseStatus?:string}).responseStatus==="declined"))
    .map(e=>({start:e.start?.dateTime?Date.parse(e.start.dateTime):parseCalendarTime(`${e.start?.date} 00:00`),
      end:e.end?.dateTime?Date.parse(e.end.dateTime):parseCalendarTime(`${e.end?.date} 00:00`)}));
}
export function openWindows(busy:Busy[],now:number,days=7):StudyBlock[] {
  if(!Number.isInteger(days)||days<1||days>14)throw Error("Invalid planning horizon");
  for(const b of busy)if(!Number.isFinite(b.start)||!Number.isFinite(b.end)||b.end<=b.start)throw Error("Invalid busy interval");
  const start=parseCalendarTime(`${localDate(now)} 00:00`);
  const end=parseCalendarTime(`${addDays(localDate(now),days)} 00:00`);
  const intervals=busy.map(b=>({start:Math.max(start,b.start-10*60_000),end:Math.min(end,b.end+10*60_000)}))
    .filter(b=>b.start<b.end).sort((a,b)=>a.start-b.start);
  const result:StudyBlock[]=[];
  let cursor=start;
  const append=(a:number,b:number)=>{
    if(b-Math.max(a,now)<30*60_000)return;
    result.push({key:`open:${a}:${b}`,title:"Open time",start:a,end:b,kind:"open"});
  };
  // One continuous horizon: midnight is not an artificial end to an available study block.
  for(const interval of intervals){if(interval.start>cursor)append(cursor,interval.start);cursor=Math.max(cursor,interval.end);}
  if(cursor<end)append(cursor,end);
  return result;
}
