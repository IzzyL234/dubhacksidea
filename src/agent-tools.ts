import {createHash} from 'node:crypto';
import type {CalendarGateway} from './calendar-types.ts';
import type {AgentTool,StudyChoice,ToolArgs} from './conversation-agent.ts';
import type {StudyBlock} from './study-events.ts';
import type {TimeEstimate} from './study-time.ts';
import {addDays,localDate,parseCalendarTime,formatTime,TIMEZONE} from './time.ts';
import {withReviewLock} from './review-links.ts';
import {fileURLToPath} from 'node:url';
type ToolsDeps={calendar:CalendarGateway;openings:()=>Promise<StudyBlock[]>;estimate:(chat:string,start:number,lengths:number[])=>Promise<TimeEstimate[]>;learning:(chat:string)=>Promise<unknown>;notes:(chat:string)=>Promise<unknown>;now?:()=>number;withCalendarLock?:<T>(work:()=>Promise<T>)=>Promise<T>};
export function createAgentTools(deps:ToolsDeps){
 const now=deps.now??Date.now;
 function dayBounds(date:string){const today=localDate(now());if(date<today||date>=addDays(today,7))throw Error('Date outside next seven days');return {start:parseCalendarTime(date+' 00:00'),end:parseCalendarTime(addDays(date,1)+' 00:00')};}
 return {
  async read(chat:string,name:AgentTool,args:ToolArgs):Promise<unknown>{
   if(name==='notes')return deps.notes(chat);
   if(name==='learning')return deps.learning(chat);
   if(name==='calendar'){
    const range=args.date?dayBounds(args.date):{start:now(),end:parseCalendarTime(addDays(localDate(now()),7)+' 00:00')};
    const events=await deps.calendar.list(Math.max(range.start,now()),range.end);
    return {timezone:TIMEZONE,scope:'The connected shared calendar only.',events:events.filter(e=>e.status!=='cancelled').slice(0,40).map(e=>({title:(e.summary??'Untitled').slice(0,160),start:e.start?.dateTime??e.start?.date??null,end:e.end?.dateTime??e.end?.date??null,allDay:!e.start?.dateTime}))};
   }
   if(name!=='openings')throw Error('Unknown read tool');
   if(args.date)dayBounds(args.date);
   const blocks=await deps.openings(),options:StudyChoice[]=[];
   const dates=args.date?[args.date]:Array.from({length:7},(_,i)=>addDays(localDate(now()),i));
   for(const date of dates){
    const earliest=parseCalendarTime(date+' '+(args.notBefore??'08:00')),latest=parseCalendarTime(date+' 22:00');
    for(const block of blocks){
     const start=Math.ceil(Math.max(block.start,earliest,now()+5*60000)/(5*60000))*5*60000,end=Math.min(block.end,latest);
     const lengths=(args.minutes?[args.minutes]:[25,30,45,60]).filter(m=>start+m*60000<=end);
     if(!lengths.length)continue;
     let estimates:TimeEstimate[]=[];try{estimates=await deps.estimate(chat,start,lengths);}catch{}
     for(const minutes of lengths){const e=estimates.find(e=>e.minutes===minutes&&[e.productivity,e.mood,e.observations].every(Number.isFinite)&&e.observations>0&&e.productivity>=1&&e.productivity<=5&&e.mood>=1&&e.mood<=5);
      options.push({id:createHash('sha256').update(`${start}:${minutes}`).digest('hex').slice(0,16),start,end:start+minutes*60000,minutes,productivity:e?.productivity??null,mood:e?.mood??null,observations:e?.observations??0});
     }
     if(options.length>=16)break;
    }
    if(options.length>=16)break;
   }
   return {timezone:TIMEZONE,scope:'Connected shared calendar; ten-minute event buffers. Default suggestions use 8 AM–10 PM Pacific.',options:options.slice(0,16),modelScope:'Personalized duration/outcome estimates are associations. Calendar availability determines the start time. Workspace is unknown.'};
  },
  async book(chat:string,planId:string,choice:StudyChoice):Promise<string>{return (deps.withCalendarLock??(work=>withReviewLock(process.env.SCHEDULE_REVIEW_DIRECTORY??fileURLToPath(new URL('../data/schedule-reviews/',import.meta.url)),work)))(async()=>{
   if(!Number.isInteger(choice.minutes)||choice.minutes<15||choice.minutes>120||!Number.isFinite(choice.start)||choice.end-choice.start!==choice.minutes*60000)throw Error('Invalid study choice');
   const request=createHash('sha256').update(chat+':'+planId).digest('hex'),id='agent'+request.slice(0,40);
   const matches=(event:Awaited<ReturnType<CalendarGateway['get']>>)=>event.id===id&&event.status!=='cancelled'&&event.extendedProperties?.private?.studyAgentRequest===request&&Date.parse(event.start?.dateTime??'')===choice.start&&Date.parse(event.end?.dateTime??'')===choice.end;
   try{const existing=await deps.calendar.get(id);if(matches(existing))return `Your study block is already booked for ${formatTime(choice.start)} to ${formatTime(choice.end)} Pacific. No second event was created.`;throw Error('Existing booking differs');}
   catch(e){if((e as {response?:{status?:number}})?.response?.status!==404)throw e;}
   if(choice.start<=now())throw Error('Study opening passed');
   const busy=await deps.calendar.busy(choice.start-10*60000,choice.end+10*60000);
   if(busy.some(b=>b.start<choice.end+10*60000&&b.end>choice.start-10*60000))throw Error('Calendar opening changed');
   const created=await deps.calendar.create({id,summary:'Study session',start:{dateTime:new Date(choice.start).toISOString(),timeZone:TIMEZONE},end:{dateTime:new Date(choice.end).toISOString(),timeZone:TIMEZONE},reminders:{useDefault:false},extendedProperties:{private:{studyAgentRequest:request}}});
   if(!matches(created))throw Error('Booking result not verified');
   return `Booked your ${choice.minutes}-minute study block for ${formatTime(choice.start)} to ${formatTime(choice.end)} Pacific. This reserves the time; tell me when you actually start studying so I can track the session.`;
  });}
 };
}
