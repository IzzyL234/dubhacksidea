import type {CalendarIntent} from './calendar-language.ts';
import {parseCalendarTime,addDays} from './time.ts';
// Only a small, unambiguous creation grammar. Everything else stays with the model.
export function basicCalendarIntent(texts:string[],date:string|null):CalendarIntent|null{
 if(!date||texts.some(t=>/\b(?:every|weekly|daily|recurring|invite|guests?|delete|remove|move|rename|instead|actually|change|with|except|or|UTC|EST|EDT|CST|CDT|GMT)\b|https?:|@/i.test(t)))return null;
 const day='(?:next\\s+|this\\s+)?(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)|today|tomorrow|\\d{4}-\\d{2}-\\d{2}';
 const request=new RegExp('^(?:(?:please|can you|could you|would you|i want to|i would like to|i\'d like to)\\s+)*(?:schedule|book|add|create)\\s+(?:an?\\s+)?(.+?)\\s+(?:on\\s+)?('+day+')(.*)$','i');
 let title:string|null=null,tail='';let first=-1;
 for(let i=0;i<texts.length;i++){const m=texts[i]!.trim().match(request);if(m){first=i;title=m[1]!.replace(/\s+to (?:my|the) calendar$/i,'').trim();tail=m[3]??'';}}
 if(!title||title.length>160||/[|\r\n]/.test(title))return null;
 const details=[tail,...texts.slice(first+1)].join(' ').trim();
 const timePattern=/\b(1[0-2]|[1-9])(?::([0-5]\d))?\s*(am|pm)\b/gi;
 const times=[...details.matchAll(timePattern)];
 const durationPattern=/\b(?:for\s+)?(an?|one|\d+(?:\.5)?)\s*(hours?|hrs?|minutes?|mins?)\b/gi;
 const durations=[...details.matchAll(durationPattern)];
 if(times.length>1||durations.length>1)return null;
 const rest=details.replace(timePattern,'').replace(durationPattern,'').replace(/\b(?:at|for|starting|please|thanks)\b/gi,'').replace(/[\s,.!?]+/g,'');if(rest)return null;
 const clarify=(question:string):CalendarIntent=>({action:'clarify',title,start:null,end:null,question});
 if(!times.length)return clarify(`What time should “${title}” start on ${date}, and how long will it last? Please include a.m. or p.m.`);
 if(!durations.length)return clarify(`How long should “${title}” last?`);
 const t=times[0]!,d=durations[0]!,count=/^(a|an|one)$/i.test(d[1]!)?1:Number(d[1]);const minutes=count*(/^h/i.test(d[2]!)?60:1);
 if(!Number.isInteger(minutes)||minutes<1||minutes>1440)return null;
 const hour=Number(t[1])%12+(t[3]!.toLowerCase()==='pm'?12:0),minute=Number(t[2]??0),start=date+' '+String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0');
 // Calendar tools validate actual future times and daylight-saving transitions.
 try{parseCalendarTime(start);}catch{return null;}
 const total=hour*60+minute+minutes,end=addDays(date,Math.floor(total/1440))+' '+String(Math.floor(total%1440/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');
 return {action:'add',title,start,end,question:null};
}
