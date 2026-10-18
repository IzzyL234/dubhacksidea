export type ActivityItem={at:string;action:string;reason:string;count:number;title:string;detail:string};
type Row=Record<string,any>;
const explanations:Record<string,[string,string]>={
 location_stale_or_inaccurate:['Waiting for a reliable location','The location reading was too old or imprecise.'],
 location_service_error:['Location service unavailable','Photon did not return a usable location.'],
 waiting_for_distinct_stable_readings:['Checking whether you have settled','Waiting for distinct readings at the same place.'],
 unfinished_session_or_checkin:['Study session in progress','An active session or unfinished check-in prevented another study invitation.'],
 calendar_opening_changed:['Calendar changed','The previously suggested opening is no longer available.'],
 study_block_ended:['Study block ended','The planned block ended and a check-in reminder was prepared.'],
 arrival_checkin_reserved:['Prepared an arrival check-in','A stable arrival made a short check-in eligible.'],
 no_meaningful_change:['No new action needed','Calendar, session and model signals have not meaningfully changed.'],
 no_eligible_opening:['No suitable calendar opening','No current calendar opening met the minimum study length.'],
 no_current_calendar_opening:['No suitable calendar opening','No current calendar opening met the minimum study length.'],
 prompt_cooldown:['Giving you space','A recent prompt is still within the notification cooldown.'],
 quiet_hours:['Quiet hours','Notifications are paused by your quiet-hours preference.'],
 model_poor_timing:['Chose to wait','The coordinator judged the current opportunity to be poor timing.'],
 model_uncertain_context:['Chose to wait','The coordinator did not have enough confidence to interrupt.'],
 model_recent_decline:['Respecting a recent decline','The coordinator chose not to repeat a recent suggestion.'],
 model_unavailable_or_invalid:['Decision temporarily unavailable','The coordinator request failed or returned an invalid decision.'],
};
export function dashboardActivity(user:string,rows:unknown[]):ActivityItem[]{
 const ordered=rows.filter((raw):raw is Row=>{const e=raw as Row;return e?.user_key===user&&typeof e.reason==='string'&&/^[a-zA-Z0-9_]{1,80}$/.test(e.reason)&&Number.isFinite(Date.parse(e.reported_at))&&['stay_quiet','offer_study','offer_place','accepted','skipped','arrival_checkin'].includes(e.action);}).sort((a,b)=>Date.parse(b.reported_at)-Date.parse(a.reported_at)).slice(0,50);
 const result:ActivityItem[]=[],groups=new Map<string,ActivityItem>();
 for(const e of ordered){
  const count=Number.isSafeInteger(e.occurrence_count)&&e.occurrence_count>0?e.occurrence_count:1;
  const f=e.decision_context,free=Number.isFinite(f?.freeMinutes)&&f.freeMinutes>=0&&f.freeMinutes<=10080?Math.floor(f.freeMinutes):null,minutes=Number.isFinite(f?.plannedMinutes)&&f.plannedMinutes>=1&&f.plannedMinutes<=1440?Math.floor(f.plannedMinutes):null;
  let [title,detail]=explanations[e.reason]??['Chose to wait','No useful interruption was selected for this check.'];
  if(e.action==='offer_study'){title='Study opportunity found';detail=(free!==null?`Found ${free} free minutes in the calendar. `:'Found an opportunity to ask about studying. ')+(minutes!==null?`Suggested a ${minutes}-minute session.`:'Suggested a short study session.');}
  if(e.action==='offer_place'){title='Asked about a study spot';detail='A detected place was offered for your confirmation.';}
  if(e.action==='accepted'){title='Suggestion accepted';detail='You confirmed the preceding suggestion.';}
  if(e.action==='skipped'){title='Suggestion skipped';detail='You declined the suggestion; the agent will give you space.';}
  const item={at:e.reported_at,action:e.action,reason:e.reason,count,title,detail};
  const groupable=e.action==='stay_quiet'&&!['arrival_checkin_reserved','study_block_ended','calendar_opening_changed'].includes(e.reason);
  const key=`${e.reason}:${Math.floor(Date.parse(e.reported_at)/(30*60000))}`;
  const old=groupable?groups.get(key):undefined;
  if(old)old.count=Math.min(Number.MAX_SAFE_INTEGER,old.count+count);else{result.push(item);if(groupable)groups.set(key,item);}
 }
 return result.slice(0,30);
}
