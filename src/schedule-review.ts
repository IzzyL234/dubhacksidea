import {createHash} from 'node:crypto';
import type {CalendarGateway,DemoEvent} from './calendar-types.ts';
import {busyIntervals} from './open-time.ts';
import {localDate,parseCalendarTime,TIMEZONE} from './time.ts';

export type ScheduleReview={id:string;createdAt:string;expiresAt:string;status:'pending'|'applied'|'skipped'|'stale';title:string;conflicts:{title:string;start:string;end:string}[];before:{start:string;end:string};after:null|{start:string;end:string};overlapMinutes:number;shiftMinutes:number|null;reason:string;model:null|{productivity:number;mood:number;observations:number};eventId:string;etag:string};
const minute=60000;
const stamp=(n:number)=>new Date(n).toISOString();
const title=(e:DemoEvent)=>(e.summary??'Untitled event').replace(/\s+/g,' ').trim().slice(0,160);
function interval(e:DemoEvent){return {start:e.start?.dateTime?Date.parse(e.start.dateTime):parseCalendarTime(e.start?.date+' 00:00'),end:e.end?.dateTime?Date.parse(e.end.dateTime):parseCalendarTime(e.end?.date+' 00:00')};}
function visible(e:DemoEvent){return e.status!=='cancelled'&&e.transparency!=='transparent'&&!e.attendees?.some((a:any)=>a?.self&&a.responseStatus==='declined');}
// Only explicit personal appointments created through the bot may be proposed for
// movement. Running study sessions, invited meetings and recurring events stay fixed.
export function movable(e:DemoEvent){return !!(visible(e)&&e.id&&e.etag&&e.start?.dateTime&&e.end?.dateTime&&e.extendedProperties?.private?.studyAgentRequest&&!e.extendedProperties?.private?.studyAgentSession&&!e.attendees?.length&&!e.recurringEventId&&!e.recurrence?.length);}
export function planScheduleReviews(events:DemoEvent[],now:number):ScheduleReview[]{
 const rows=events.filter(visible).map(event=>({event,...interval(event)}));
 if(rows.some(x=>!Number.isFinite(x.start)||!Number.isFinite(x.end)||x.end<=x.start))throw Error('Invalid calendar interval');
 const reviews:ScheduleReview[]=[];
 for(const row of rows){
  if(!row.event.id||!row.event.etag||row.start<=now+15*minute||row.start>now+7*86400000)continue;
  const clashes=rows.filter(x=>x.event.id!==row.event.id&&x.start<row.end&&x.end>row.start);
  if(!clashes.length)continue;
  // One review per pair; prefer moving the eligible personal appointment.
  if(!movable(row.event)&&clashes.some(x=>movable(x.event)))continue;
  if(!movable(row.event)&&clashes.some(x=>String(x.event.id)<String(row.event.id)))continue;
  const duration=row.end-row.start,day=localDate(row.start),candidates:number[]=[];
  if(movable(row.event)&&duration>=5*minute&&duration<=240*minute){
   const lower=Math.max(now+15*minute,parseCalendarTime(day+' 08:00')),upper=parseCalendarTime(day+' 22:00');
   for(let start=Math.ceil(lower/(5*minute))*5*minute;start+duration<=upper;start+=5*minute){
    if(!rows.some(x=>x.event.id!==row.event.id&&x.start-10*minute<start+duration&&x.end+10*minute>start))candidates.push(start);
   }
  }
  candidates.sort((a,b)=>Math.abs(a-row.start)-Math.abs(b-row.start)||a-b);
  const start=candidates[0];
  // Union overlapping minutes instead of double-counting simultaneous conflicts.
  const spans=clashes.map(x=>({start:Math.max(x.start,row.start),end:Math.min(x.end,row.end)})).sort((a,b)=>a.start-b.start);
  let overlap=0,end=-Infinity;for(const span of spans){overlap+=Math.max(0,span.end-Math.max(span.start,end));end=Math.max(end,span.end);}
  const fingerprint=JSON.stringify([row.event.id,row.event.etag,clashes.map(x=>[x.event.id,x.event.etag,x.start,x.end]).sort(),start??null]);
  reviews.push({id:createHash('sha256').update(fingerprint).digest('hex').slice(0,16),createdAt:stamp(now),expiresAt:stamp(Math.min(now+24*3600000,row.start-5*minute,start===undefined?Infinity:start-5*minute)),status:'pending',title:title(row.event),eventId:row.event.id,etag:row.event.etag,
   before:{start:stamp(row.start),end:stamp(row.end)},after:start===undefined?null:{start:stamp(start),end:stamp(start+duration)},conflicts:clashes.map(x=>({title:title(x.event),start:stamp(x.start),end:stamp(x.end)})),overlapMinutes:Math.round(overlap/minute),shiftMinutes:start===undefined?null:Math.round(Math.abs(start-row.start)/minute),model:null,
   reason:start===undefined?'A calendar overlap needs your review. No safe automatic move is available for these events.':'Remove the overlap while preserving the event duration. This is the closest available same-day slot between 8 AM and 10 PM Pacific, with 10-minute buffers.'});
 }
 return reviews.sort((a,b)=>Date.parse(a.before.start)-Date.parse(b.before.start)).slice(0,10);
}
export function publicScheduleReview(p:ScheduleReview){const {eventId,etag,...safe}=p;return safe;}
export async function applyScheduleReview(gateway:CalendarGateway,p:ScheduleReview,now:number):Promise<'applied'|'stale'>{
 if(!p.after||p.status!=='pending'||Date.parse(p.expiresAt)<=now||Date.parse(p.after.start)<=now+5*minute)return 'stale';
 const fresh=await gateway.get(p.eventId);
 // Recover a successful patch whose response was lost before local persistence.
 if(fresh.extendedProperties?.private?.scheduleReview===p.id&&fresh.start?.dateTime&&Date.parse(fresh.start.dateTime)===Date.parse(p.after.start)&&Date.parse(fresh.end?.dateTime??'')===Date.parse(p.after.end))return 'applied';
 if(!movable(fresh)||fresh.etag!==p.etag||Date.parse(fresh.start?.dateTime??'')!==Date.parse(p.before.start)||Date.parse(fresh.end?.dateTime??'')!==Date.parse(p.before.end))return 'stale';
 const start=Date.parse(p.after.start),end=Date.parse(p.after.end);
 const others=await gateway.list(Math.min(start,Date.parse(p.before.start))-10*minute,Math.max(end,Date.parse(p.before.end))+10*minute);
 if(!busyIntervals(others.filter(e=>e.id!==p.eventId)).some(b=>b.start<Date.parse(p.before.end)&&b.end>Date.parse(p.before.start)))return 'stale';
 if(busyIntervals(others.filter(e=>e.id!==p.eventId)).some(b=>b.start-10*minute<end&&b.end+10*minute>start))return 'stale';
 try{
  const changed=await gateway.patch(p.eventId,p.etag,{start:{dateTime:p.after.start,timeZone:TIMEZONE},end:{dateTime:p.after.end,timeZone:TIMEZONE},extendedProperties:{private:{...fresh.extendedProperties?.private,scheduleReview:p.id}}});
  if(changed.id!==p.eventId||Date.parse(changed.start?.dateTime??'')!==start||Date.parse(changed.end?.dateTime??'')!==end)throw Error('Unverified calendar update');
  return 'applied';
 }catch(e){if((e as any)?.response?.status===412)return 'stale';throw e;}
}
