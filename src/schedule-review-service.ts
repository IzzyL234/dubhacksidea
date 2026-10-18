import {withReviewLock} from './review-links.ts';
import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {planScheduleReviews,applyScheduleReview,publicScheduleReview,type ScheduleReview} from './schedule-review.ts';
import type {CalendarGateway} from './calendar-types.ts';
import {formatTime} from './time.ts';
import type {TimeEstimate} from './study-time.ts';
type State={enabled:boolean;conversation:string;reviews:ScheduleReview[];notified:string[];lastNotification?:number;reviewLinks?:Record<string,string>};
type Dependencies={gateway:CalendarGateway;send:(chat:string,text:string)=>Promise<void>;allowed:(chat:string)=>Promise<boolean>;connected?:(chat:string)=>Promise<boolean>;estimate?:(chat:string,start:number,lengths:number[])=>Promise<TimeEstimate[]>;upload?:(owner:string,review:ScheduleReview)=>Promise<void>;now?:()=>number;reviewUrl:string};
const owner=(chat:string)=>createHash('sha256').update(chat).digest('hex');
export class ScheduleReviewService{
 private lock:Promise<unknown>=Promise.resolve();private now:()=>number;
 constructor(private deps:Dependencies,private directory=process.env.SCHEDULE_REVIEW_DIRECTORY??fileURLToPath(new URL('../data/schedule-reviews/',import.meta.url))){this.now=deps.now??Date.now;const u=new URL(deps.reviewUrl);if((u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))||u.username||u.password||u.search||u.hash)throw Error('Invalid review URL');}
 private serial<T>(fn:()=>Promise<T>){const next=this.lock.catch(()=>{}).then(()=>withReviewLock(this.directory,fn));this.lock=next;return next;}
 private async read(chat:string):Promise<State>{try{return JSON.parse(await readFile(join(this.directory,owner(chat)+'.json'),'utf8'));}catch(e){if((e as any).code!=='ENOENT')throw e;return {enabled:false,conversation:chat,reviews:[],notified:[]};}}
 private async save(s:State){await mkdir(this.directory,{recursive:true});const path=join(this.directory,owner(s.conversation)+'.json'),tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(s),{mode:0o600});await rename(tmp,path);}
 private async publish(s:State){if(!this.deps.upload)return;for(const p of s.reviews)await this.deps.upload(owner(s.conversation),p);}
 async handle(chat:string,text:string):Promise<string|null>{
  const command=text.trim().toLowerCase().replace(/[.!?]+$/,'');if(!/^(schedule review (on|off|status)|review schedule|(?:approve|skip) change [a-f0-9]{16})$/.test(command))return null;
  return this.serial(async()=>{
   const s=await this.read(chat);
   if(command==='schedule review on'){if(!await (this.deps.connected??this.deps.allowed)(chat))return 'Enable reminders for this chat first with reminders on. Schedule review follows the same quiet hours and waits during active sessions.';s.enabled=true;await this.save(s);return 'Schedule review is on for Hackathon Demo. I check for conflicts every minute and send at most one review every six hours. I only propose moving personal, non-recurring events created through this bot; meetings and tracked study sessions stay fixed. Nothing moves until you approve the private review page or text approve change with its review ID.';}
   if(command==='schedule review off'){s.enabled=false;await this.save(s);return 'Proactive schedule review is off. No calendar events were changed.';}
   if(command==='schedule review status')return `Schedule review is ${s.enabled?'on':'off'}. ${s.reviews.filter(p=>p.status==='pending'&&Date.parse(p.expiresAt)>this.now()).length} pending review(s). Calendar: Hackathon Demo.`;
   if(command==='review schedule'){await this.scan(s,false);return s.reviews.filter(p=>p.status==='pending'&&Date.parse(p.expiresAt)>this.now()).map(p=>this.message(p,s)).join('\n\n')||'No future calendar overlaps found in the next seven days. Nothing was changed.';}
   const id=command.split(' ').at(-1)!,p=s.reviews.find(p=>p.id===id);if(!p)return 'That review does not belong to this chat. Text review schedule to check your calendar.';
   if(p.status==='applied')return 'That approved change was already applied. No second change was made.';
   if(p.status!=='pending')return `That review is ${p.status}. Text review schedule for a fresh check.`;
   if(command.startsWith('skip')){p.status='skipped';await this.save(s);await this.publish(s);return 'Skipped that proposal. Your calendar is unchanged.';}
   if(!p.after)return 'This is a conflict alert, not an approved move. Resolve it in Google Calendar; I will not move meetings or classes for you.';
   try{p.status=await applyScheduleReview(this.deps.gateway,p,this.now());}catch(e){if((e as Error).message==='CALENDAR_WRITE_AUTH_REQUIRED'||[401,403].includes((e as any)?.response?.status))return 'Calendar editing needs authorization. Run bun calendar-write-auth.mjs, then resend this approval. Nothing was confirmed changed.';return 'I could not confirm that change. Resend the same approval to check safely; I will not create a duplicate event.';}
   await this.save(s);await this.publish(s).catch(()=>{});
   return p.status==='applied'?`Moved “${p.title}” to ${formatTime(Date.parse(p.after.start))}–${formatTime(Date.parse(p.after.end))} Pacific. Your dashboard will refresh shortly.`:'That proposal expired or the calendar changed. Nothing was moved. Text review schedule to check again.';
  });
 }
 private message(p:ScheduleReview,s:State){return `Calendar conflict: “${p.title}” overlaps ${p.conflicts.map(c=>'“'+c.title+'”').join(', ')} by ${p.overlapMinutes} minutes. ${p.after?'I found a free slot at '+formatTime(Date.parse(p.after.start))+'. May I move it?':'These events need your review; I have not proposed an automatic move.'}\nReview why: ${new URL('/review/'+p.id,this.deps.reviewUrl).href}#key=${s.reviewLinks?.[p.id]??''}\n${p.after?'Approve: approve change '+p.id+'\n':''}Skip: skip change ${p.id}\nThis private link lets you approve or deny this proposal. It expires with the review; do not forward it.`;}
 private async scan(s:State,notify:boolean){
  const events=await this.deps.gateway.list(this.now(),this.now()+7*86400000),plans=planScheduleReviews(events,this.now());
  for(const p of s.reviews)if(p.status==='pending'&&(!plans.some(x=>x.id===p.id)||Date.parse(p.expiresAt)<=this.now()))p.status='stale';
  for(const p of plans){if(s.reviews.some(x=>x.id===p.id))continue;
   if(p.after&&this.deps.estimate&&/study|homework|assignment|reading/i.test(p.title)){try{const length=(Date.parse(p.after.end)-Date.parse(p.after.start))/60000;const value=(await this.deps.estimate(s.conversation,Date.parse(p.after.start),[length]))[0];if(value&&[value.productivity,value.mood,value.observations].every(Number.isFinite)&&value.observations>0)p.model={productivity:value.productivity,mood:value.mood,observations:value.observations};}catch{}}
   s.reviews.push(p);
  }
  s.reviews=s.reviews.slice(-30);s.reviewLinks??={};for(const p of s.reviews)if(p.status==='pending'&&!s.reviewLinks[p.id])s.reviewLinks[p.id]=randomBytes(32).toString('base64url');s.reviewLinks=Object.fromEntries(Object.entries(s.reviewLinks).filter(([id])=>s.reviews.some(p=>p.id===id)));await this.save(s);
  // Persist privately before sending a link, so the review page can load it.
  await this.publish(s);
  if(!notify||this.now()-(s.lastNotification??0)<6*3600000)return;
  const p=s.reviews.find(p=>p.status==='pending'&&Date.parse(p.expiresAt)>this.now()&&!s.notified.includes(p.id));if(!p)return;
  // At-most-once automatic sending: a delivery failure can be recovered manually.
  s.notified=[...s.notified,p.id].slice(-100);s.lastNotification=this.now();await this.save(s);await this.deps.send(s.conversation,this.message(p,s));
 }
 async tick(){return this.serial(async()=>{let files:string[];try{files=await readdir(this.directory);}catch(e){if((e as any).code==='ENOENT')return;throw e;}
  for(const f of files){if(!/^[a-f0-9]{64}\.json$/.test(f))continue;const s=JSON.parse(await readFile(join(this.directory,f),'utf8')) as State;if(owner(s.conversation)+'.json'!==f)continue;if(s.enabled&&await this.deps.allowed(s.conversation))await this.scan(s,true);else await this.publish(s);}
 });}
}
export function configuredReviewUpload(){const base=process.env.SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY;if(!base||!key)return undefined;const url=new URL(base);if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.username||url.password||!key.startsWith('sb_secret_'))throw Error('Invalid schedule review backend');return async(user_key:string,p:ScheduleReview)=>{
 const response=await fetch(url.origin+'/rest/v1/schedule_reviews?on_conflict=user_key,id',{method:'POST',headers:{apikey:key,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({user_key,id:p.id,created_at:p.createdAt,review:publicScheduleReview(p)}),signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw Error('Schedule reviews need migration 012');
};}

