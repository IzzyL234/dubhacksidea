import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import type {CalendarGateway,DemoEvent} from './calendar-types.ts';
import {addDays,localDate,parseCalendarTime,formatTime} from './time.ts';

type State={brief:boolean;checkins:boolean;receipts:Record<string,{at:number;status:'attempted'|'sent'}>};
type Deps={calendar:CalendarGateway;recipient:()=>Promise<string|null>;allowed:(chat:string)=>Promise<boolean>;busy:(chat:string)=>Promise<boolean>;send:(chat:string,text:string)=>Promise<void>;opportunity?:(chat:string,date:string)=>Promise<string|null>;now?:()=>number};
const title=(e:DemoEvent)=>(e.summary??'Untitled event').replace(/\s+/g,' ').slice(0,120);
const attending=(e:DemoEvent)=>e.status!=='cancelled'&&e.transparency!=='transparent'&&!e.attendees?.some(a=>(a as {self?:boolean;responseStatus?:string}).self&&(a as {responseStatus?:string}).responseStatus==='declined');
export class DailyBrief {
 private lock:Promise<unknown>=Promise.resolve();private now:()=>number;
 constructor(private deps:Deps,private directory=fileURLToPath(new URL('../data/daily-brief/',import.meta.url))){this.now=deps.now??Date.now;}
 private serial<T>(work:()=>Promise<T>){const p=this.lock.catch(()=>{}).then(work);this.lock=p;return p;}
 private path(chat:string){return this.directory+'/'+createHash('sha256').update(chat).digest('hex')+'.json';}
 private async read(chat:string):Promise<State>{try{return JSON.parse(await readFile(this.path(chat),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {brief:true,checkins:true,receipts:{}};throw e;}}
 private async save(chat:string,s:State){const path=this.path(chat);await mkdir(dirname(path),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(s),{mode:0o600});await rename(tmp,path);}
 async handle(chat:string,text:string){return this.serial(async()=>{
  const cmd=text.trim().toLowerCase().replace(/[.!?]+$/,'');if(!/^(morning brief(?: on| off| status)?|event checkins (?:on|off|status))$/.test(cmd))return null;
  if(await this.deps.recipient()!==chat)return 'These notifications use the chat connected to the shared calendar. Text reminders on here first to connect it.';
  const s=await this.read(chat),brief=cmd.startsWith('morning brief'),key=brief?'brief':'checkins';
  if(cmd.endsWith(' on')||cmd.endsWith(' off')){s[key]=cmd.endsWith(' on');await this.save(chat,s);return `${brief?'Morning briefs':'Event check-ins'} are ${s[key]?'on':'off'}. ${brief?'The daily brief is at 8:30 a.m. Pacific.':'Check-ins arrive 10 minutes before timed events.'}`;}
  if(cmd.endsWith('status'))return `Morning brief: ${s.brief?'on':'off'} at 8:30 a.m. Pacific. Event check-ins: ${s.checkins?'on':'off'}, 10 minutes before timed events. The bot must stay running; reminders off pauses both.`;
  try{return await this.brief(chat,this.now());}catch{return 'I could not read your calendar for the brief just now. Please try again shortly.';}
 });}
 private async brief(chat:string,now:number){
  const date=localDate(now),events=(await this.deps.calendar.list(parseCalendarTime(date+' 00:00'),parseCalendarTime(addDays(date,1)+' 00:00'))).filter(attending);
  const upcoming=events.filter(e=>!e.end?.dateTime||Date.parse(e.end.dateTime)>now).sort((a,b)=>String(a.start?.dateTime??a.start?.date).localeCompare(String(b.start?.dateTime??b.start?.date)));
  const lines=upcoming.slice(0,5).map(e=>`• ${e.start?.dateTime?formatTime(Date.parse(e.start.dateTime)):'All day'}: ${title(e)}`);
  let opportunity:string|null=null;try{opportunity=await this.deps.opportunity?.(chat,date)??null;}catch{/* Availability failure must not invent an opening. */}
  return `Good morning! Here is your brief for ${date} (Pacific), from your connected calendar.\n\n${lines.length?lines.join('\n'):'There are no remaining events on this calendar today.'}${upcoming.length>5?`\nThere are ${upcoming.length-5} more events.`:''}${opportunity?'\n\n'+opportunity:''}\n\nWant help planning around these? Tell me what you need to get done.`;
 }
 async tick(){return this.serial(async()=>{
  const chat=await this.deps.recipient();if(!chat||!await this.deps.allowed(chat))return;
  const now=this.now(),date=localDate(now),s=await this.read(chat);
  for(const [key,r] of Object.entries(s.receipts))if(now-r.at>8*86400000)delete s.receipts[key];
  // Claim before sending: an uncertain messaging response must not send duplicates on restart.
  const send=async(key:string,text:string)=>{if(s.receipts[key])return;s.receipts[key]={at:now,status:'attempted'};await this.save(chat,s);await this.deps.send(chat,text);s.receipts[key]!.status='sent';await this.save(chat,s);};
  const morning=parseCalendarTime(date+' 08:30');
  if(s.brief&&now>=morning&&now<morning+90*60000&&!s.receipts['brief:'+date]){
   const text=await this.brief(chat,now);await send('brief:'+date,text);
  }
  if(!s.checkins||await this.deps.busy(chat))return;
  const events=(await this.deps.calendar.list(now,now+11*60000)).filter(attending);
  const due=events.filter(e=>e.id&&e.start?.dateTime&&Date.parse(e.start.dateTime)>now&&Date.parse(e.start.dateTime)-now<=10*60000);
  const unsent=due.filter(e=>!s.receipts['event:'+e.id+':'+e.start!.dateTime]);
  if(!unsent.length)return;
  const keys=unsent.map(e=>'event:'+e.id+':'+e.start!.dateTime);
  for(const key of keys)s.receipts[key]={at:now,status:'attempted'};
  await this.save(chat,s);
  await this.deps.send(chat,`Quick check-in: ${unsent.slice(0,5).map(e=>`${title(e)} starts at ${formatTime(Date.parse(e.start!.dateTime!))} Pacific`).join('; ')}.${unsent.length>5?' More events also start in the next 10 minutes.':''} Are you ready, or would you like me to review your schedule? I have not changed anything.`);
  for(const key of keys)s.receipts[key]!.status='sent';await this.save(chat,s);
 });}
}
