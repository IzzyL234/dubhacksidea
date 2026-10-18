import {parseCalendarTime} from "./time.ts";
import type {CalendarGateway,DemoEvent} from './calendar-types.ts';
export type UpcomingEvent={title:string;start:string;end:string;allDay:boolean};
export type CalendarSnapshot={status:'ready'|'unavailable';syncedAt:string|null;events:UpcomingEvent[]};
const eventMillis=(value:string,allDay:boolean)=>{try{return allDay?parseCalendarTime(value+" 00:00"):Date.parse(value);}catch{return NaN;}};
export function upcomingEvents(rows:DemoEvent[],now:number):UpcomingEvent[]{
 return rows.filter(e=>e.status!=='cancelled'&&!e.attendees?.some(a=>(a as {self?:boolean;responseStatus?:string})?.self&&(a as {responseStatus?:string}).responseStatus==='declined')).flatMap(e=>{
  const allDay=Boolean(e.start?.date&&!e.start.dateTime),start=allDay?e.start?.date:e.start?.dateTime,end=allDay?e.end?.date:e.end?.dateTime;
  if(!start||!end||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||eventMillis(end,allDay)<=now||eventMillis(end,allDay)<=eventMillis(start,allDay))return [];
  return [{title:(e.summary??'Untitled event').replace(/\s+/g,' ').trim().slice(0,160)||'Untitled event',start,end,allDay}];
 }).sort((a,b)=>eventMillis(a.start,a.allDay)-eventMillis(b.start,b.allDay)).slice(0,12);
}
export class DashboardCalendarSync {
 private running=false;
 constructor(private gateway:CalendarGateway,private url:string,private secret:string,private request:(url:string,init?:RequestInit)=>Promise<Response>=fetch,private now=Date.now){const u=new URL(url);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.username||u.password||!secret.startsWith('sb_secret_'))throw Error('Invalid calendar cache configuration');this.url=u.origin;}
 async sync():Promise<void>{if(this.running)return;this.running=true;try{
  const headers={apikey:this.secret,'Content-Type':'application/json'};
  const r=await this.request(this.url+'/rest/v1/dashboard_access?select=user_key&expires_at=gt.'+encodeURIComponent(new Date(this.now()).toISOString()),{headers,signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Dashboard connections unavailable');
  const users=await r.json() as {user_key:string}[];if(!Array.isArray(users))throw Error('Invalid connections');const keys=[...new Set(users.map(u=>u.user_key).filter(u=>/^[a-f0-9]{64}$/.test(u)))];if(!keys.length)return;
  let snapshot:CalendarSnapshot;try{snapshot={status:'ready',syncedAt:new Date(this.now()).toISOString(),events:upcomingEvents(await this.gateway.list(this.now(),this.now()+7*86400000),this.now())};}catch{snapshot={status:'unavailable',syncedAt:null,events:[]};}
  // Only the explicitly shared demo calendar is copied; never attendee/contact details.
  const saved=await this.request(this.url+'/rest/v1/dashboard_calendar?on_conflict=user_key',{method:'POST',headers:{...headers,Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(keys.map(user_key=>({user_key,status:snapshot.status,synced_at:snapshot.syncedAt,events:snapshot.events}))),signal:AbortSignal.timeout(10000),redirect:'error'});if(!saved.ok)throw Error('Dashboard calendar cache needs migration 011');
 }finally{this.running=false;}}
}
export function configuredDashboardCalendar(gateway:CalendarGateway):DashboardCalendarSync|null{return process.env.SUPABASE_URL&&process.env.SUPABASE_SECRET_KEY?new DashboardCalendarSync(gateway,process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY):null;}
export function calendarProjection(rows:unknown[],now:number):CalendarSnapshot{
 const row=(rows[0]??{}) as Record<string,any>;if(row.status!=='ready'||!Number.isFinite(Date.parse(row.synced_at))||now-Date.parse(row.synced_at)>5*60000)return {status:'unavailable',syncedAt:row.synced_at??null,events:[]};
 const events=Array.isArray(row.events)?row.events.filter((e:any)=>typeof e?.title==='string'&&typeof e?.allDay==='boolean'&&Number.isFinite(Date.parse(e.start))&&Number.isFinite(Date.parse(e.end))&&eventMillis(e.end,e.allDay)>now).slice(0,12).map((e:any)=>({title:e.title.slice(0,160),start:String(e.start),end:String(e.end),allDay:e.allDay})):[];
 return {status:'ready',syncedAt:row.synced_at,events};
}
