import {createHash} from 'node:crypto';
import {demoCalendar} from '../src/calendar-api.ts';
import {localDate,addDays,parseCalendarTime,formatTime} from '../src/time.ts';
const now=Date.now(),tag='daywise-review-preview-v1';
const events=await demoCalendar.list(now,now+7*86400000);
const existing=events.filter(e=>e.extendedProperties?.private?.reviewPreview===tag);
if(existing.length){
 if(existing.length!==2)throw Error('A partial walkthrough exists. Review it in Calendar before adding another.');
 console.log('The walkthrough events already exist. Text review schedule to your bot.');
}else{
 let windowStart:number|undefined;
 for(let day=0;day<5&&windowStart===undefined;day++)for(let hour=9;hour<=17;hour++){
  const at=parseCalendarTime(addDays(localDate(now),day)+' '+String(hour).padStart(2,'0')+':00');
  if(at<now+2*3600000)continue;
  if(events.every(e=>{const a=e.start?.dateTime?Date.parse(e.start.dateTime):parseCalendarTime(e.start?.date+' 00:00'),b=e.end?.dateTime?Date.parse(e.end.dateTime):parseCalendarTime(e.end?.date+' 00:00');return e.status==='cancelled'||e.transparency==='transparent'||b<=at||a>=at+3*3600000;})){windowStart=at;break;}
 }
 if(windowStart===undefined)throw Error('No clear three-hour window found; no events were added.');
 const start=windowStart+3600000;
 for(const [kind,title,a,b] of [['study','Study math',start,start+3600000],['meeting','Project meeting',start+30*60000,start+90*60000]] as const){
  await demoCalendar.create({id:createHash('sha256').update(tag+localDate(start)+kind).digest('hex').slice(0,32),summary:title,description:'Calendar review walkthrough: a study block overlapping a project meeting.',start:{dateTime:new Date(a).toISOString(),timeZone:'America/Los_Angeles'},end:{dateTime:new Date(b).toISOString(),timeZone:'America/Los_Angeles'},extendedProperties:{private:{reviewPreview:tag,...(kind==='study'?{studyAgentRequest:'review-preview'}:{})}}});
 }
 console.log('Added Study math at '+formatTime(start)+' and Project meeting at '+formatTime(start+30*60000)+'. Text review schedule to your bot. No move was approved.');
}
