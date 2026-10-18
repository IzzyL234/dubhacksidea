import type {StudyBlock} from './study-events.ts';
import {localDate,addDays,formatTime,localParts} from './time.ts';
export type TimeEstimate={minutes:number;productivity:number;mood:number;utility:number;observations:number};
export function isStudyTimeRequest(text:string):boolean{
 return /(?:when\s+(?:(?:should|can|could|would)\s+(?:i|we)|(?:do you|would you)\s+(?:suggest|recommend)).*(?:study|studying)|(?:recommend|suggest|find|pick|choose).*(?:time|slot|opening|opportunity|window).*(?:study|studying)|(?:best|good)\s+time.*(?:study|studying)|(?:study|studying).*(?:what time|when should|recommend.*time)|(?:recommend|suggest|find|pick|choose).*(?:study|studying).*time)/i.test(text);
}
export async function studyTimeReply(text:string,blocks:StudyBlock[],estimate:(start:number,minutes:number[])=>Promise<TimeEstimate[]>,now=Date.now()):Promise<string>{
 const date=/\btomorrow\b/i.test(text)?addDays(localDate(now),1):/\b(today|tonight)\b/i.test(text)?localDate(now):null;
 const windows=blocks.map(b=>({...b,start:Math.ceil(Math.max(b.start,now+5*60000)/(5*60000))*5*60000})).filter(b=>b.end-b.start>=25*60000&&(!date||localDate(b.start)===date)&&(!/\btonight\b/i.test(text)||Number(localParts(b.start).hour)>=17)).sort((a,b)=>a.start-b.start);
 const block=windows[0];if(!block)return 'I couldn’t find a suitable study opening'+(date?' on '+date:' in the next seven days')+' in Hackathon Demo, allowing buffers. I haven’t booked anything.';
 const lengths=[25,45,60].filter(m=>block.start+m*60000<=block.end);
 let estimates:TimeEstimate[]=[];try{estimates=await estimate(block.start,lengths);}catch{/* A model outage must not erase a real calendar opening. */}
 const ranked=estimates.filter(e=>lengths.includes(e.minutes)&&[e.utility,e.productivity,e.mood].every(Number.isFinite)&&e.observations>0).sort((a,b)=>b.utility-a.utility||Math.abs(a.minutes-45)-Math.abs(b.minutes-45));
 const best=ranked[0],minutes=best?.minutes??(lengths.includes(45)?45:lengths[0]!),end=block.start+minutes*60000;
 const stamp=(t:number)=>{const p=localParts(t);return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;};
 return `I’d suggest ${formatTime(block.start)} for ${minutes} minutes (Pacific). Your Hackathon Demo calendar has an opening until ${formatTime(block.end)}.\n`+(best?`Your model estimates productivity ${best.productivity.toFixed(1)}/5 and mood ${best.mood.toFixed(1)}/5 for that session length. Calendar availability determines the start time; the model helps choose the length. Workspace details are unknown.\n`:'I chose a practical session length; a personal model estimate is unavailable right now.\n')+`To book this exact suggestion, send:\nadd event Study | ${stamp(block.start)} | ${stamp(end)}`;
}
