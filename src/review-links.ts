import {mkdir,open,readFile,readdir,rename,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {applyScheduleReview,publicScheduleReview,type ScheduleReview} from './schedule-review.ts';
import type {CalendarGateway} from './calendar-types.ts';

// Shared by the website and messaging process. Never steal an existing lock:
// after a crash, stop both processes before removing the leftover lock file.
export async function withReviewLock<T>(directory:string,work:()=>Promise<T>):Promise<T>{
 await mkdir(directory,{recursive:true});const path=join(directory,'.review-lock');
 for(let attempt=0;;attempt++){
  try{const lock=await open(path,'wx',0o600);await lock.writeFile(String(process.pid));await lock.close();break;}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   if(attempt>=100)throw Error('REVIEW_BUSY');await new Promise(resolve=>setTimeout(resolve,100));
  }
 }
 try{return await work();}finally{await unlink(path);}
}
type ReviewState={conversation:string;reviews:ScheduleReview[];reviewLinks?:Record<string,string>;[key:string]:unknown};
const digest=(value:string)=>createHash('sha256').update(value).digest();
export class ReviewLinks{
 constructor(private gateway:CalendarGateway,private directory:string,private now=Date.now,private upload?: (owner:string,review:ScheduleReview)=>Promise<void>){}
 async sync(){
  if(!this.upload)return {uploaded:0,pending:0};
  const rows=await withReviewLock(this.directory,async()=>{
   const rows:{owner:string;review:ScheduleReview}[]=[];
   for(const file of await readdir(this.directory)){
    if(!/^[a-f0-9]{64}\.json$/.test(file))continue;
    const state=JSON.parse(await readFile(join(this.directory,file),'utf8')) as ReviewState;
    if(digest(state.conversation).toString('hex')+'.json'!==file)continue;
    for(const review of state.reviews)rows.push({owner:file.slice(0,-5),review});
   }
   return rows;
  });
  let uploaded=0,pending=0;
  for(const row of rows){try{await this.upload(row.owner,row.review);uploaded++;}catch{pending++;}}
  return {uploaded,pending};
 }
 async request(id:string,token:string,action?:'approve'|'deny'):Promise<Response>{
  const reply=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
  if(!/^[a-f0-9]{16}$/.test(id)||!/^Bearer [A-Za-z0-9_-]{43}$/.test(token))return reply(401,{error:'Open the private review link from your bot message.'});
  let changed:{owner:string;review:ScheduleReview}|undefined;
  try{const response=await withReviewLock(this.directory,async()=>{
   const files=await readdir(this.directory);
   for(const file of files){
    if(!/^[a-f0-9]{64}\.json$/.test(file))continue;
    const state=JSON.parse(await readFile(join(this.directory,file),'utf8')) as ReviewState;
    if(digest(state.conversation).toString('hex')+'.json'!==file)continue;
    const expected=state.reviewLinks?.[id];if(!expected||!timingSafeEqual(digest(expected),digest(token.slice(7))))continue;
    const review=state.reviews.find(r=>r.id===id);if(!review)return reply(404,{error:'Review unavailable.'});
    if(Date.parse(review.expiresAt)<=this.now())return reply(410,{error:'This review link expired. Text review schedule for a fresh check.'});
    if(action&&review.status==='pending'){
     review.status=action==='deny'?'skipped':await applyScheduleReview(this.gateway,review,this.now());
     const path=join(this.directory,file),temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,path);
     changed={owner:file.slice(0,-5),review};
    }
    return reply(200,{review:publicScheduleReview(review)});
   }
   return reply(401,{error:'Review link unavailable. Request a fresh review from your bot.'});
  });
   // Calendar execution and its local receipt are already committed. A failed
   // dashboard upload must not turn a successful approval into an error.
   if(changed&&this.upload)await this.upload(changed.owner,changed.review).catch(()=>{});
   return response;
  }catch{return reply(503,{error:'Could not confirm the review. Retry the same link; the event version is checked before changing anything.'});}
 }
}
