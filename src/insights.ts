import {LOCATIONS} from './learning.ts';
import {addDays,localDate,localParts} from './time.ts';
export type InsightObservation={id:string;place:string|null;productivity:number;mood:number;distraction:number;attribution:'interruption'|'setup'|'unsure'|null;synthetic:boolean};
export type InsightsReport={generatedAt:string;period:string;nextRefresh:string;total:number;personal:number;synthetic:number;places:{place:string;count:number;averageDistraction:number;highDistraction:number;interruptions:number;setup:number;unsure:number;productivity:number;mood:number}[];findings:string[]};
export function insightPeriod(now:number){return Number(localParts(now).hour)>=20?localDate(now):addDays(localDate(now),-1);}
export function insightObservations(user:string,pairs:unknown[],seed:unknown[]):InsightObservation[]{
 if(!/^[a-f0-9]{64}$/.test(user))throw Error('Invalid owner');const out:InsightObservation[]=[],seen=new Set<string>();
 const add=(id:string,place:unknown,p:unknown,m:unknown,d:unknown,a:unknown,synthetic:boolean)=>{
  if(seen.has(id)||![p,m,d].every(v=>typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=5))return;seen.add(id);
  out.push({id,place:LOCATIONS.includes(place as any)?place as string:null,productivity:p as number,mood:m as number,distraction:d as number,attribution:['interruption','setup','unsure'].includes(String(a))?a as InsightObservation['attribution']:null,synthetic});
 };
 for(const raw of seed){const r=raw as any;if(typeof r?.id==='string')add('seed:'+r.id,r.location,r.user_productivity_rating,r.user_mood_rating,r.user_distraction_rating,r.distraction_attribution,true);}
 for(const raw of pairs){const s=(raw as any)?.session_record,f=(raw as any)?.feedback_record;if(!s||!f||s.user_id!==user||f.conversation_key!==user||s.is_synthetic!==false||f.is_synthetic!==false||s.status!=='completed'||s.feedback_id!==f.id||f.session_id!==s.id||typeof f.id!=='string')continue;
  add('personal:'+f.id,s.location,f.productivity_rating,f.mood_rating,f.distraction_rating,f.distraction_attribution??(['phone','other'].includes(f.distraction_source)?'interruption':f.distraction_source==='surroundings'?'setup':null),false);
 }
 return out;
}
export function buildInsights(observations:InsightObservation[],now=Date.now()):InsightsReport{
 const places=[...LOCATIONS,'unknown'].flatMap(place=>{const rows=observations.filter(r=>(r.place??'unknown')===place);if(!rows.length)return [];
  const average=(key:'distraction'|'productivity'|'mood')=>Math.round(rows.reduce((sum,r)=>sum+r[key],0)/rows.length*100)/100;
  const high=rows.filter(r=>r.distraction>=4);
  return [{place,count:rows.length,averageDistraction:average('distraction'),highDistraction:high.length,interruptions:high.filter(r=>r.attribution==='interruption').length,setup:high.filter(r=>r.attribution==='setup').length,unsure:high.filter(r=>r.attribution===null||r.attribution==='unsure').length,productivity:average('productivity'),mood:average('mood')}];
 }).sort((a,b)=>b.averageDistraction-a.averageDistraction||a.place.localeCompare(b.place));
 const named=places.filter(p=>p.place!=='unknown'&&p.count>=3),findings:string[]=[];
 if(named.length){const most=named[0]!;findings.push(`${most.place.replaceAll('_',' ')} has the highest observed distraction average: ${most.averageDistraction.toFixed(1)}/5 across ${most.count} sessions. This is an association, not proof the place caused distraction.`);}
 const high=observations.filter(r=>r.distraction>=4),interruptions=high.filter(r=>r.attribution==='interruption').length;
 if(high.length)findings.push(`${interruptions} of ${high.length} high-distraction check-ins were attributed to interruptions rather than the setup. These observations receive less weight when learning productivity and mood associations.`);
 const unknown=places.find(p=>p.place==='unknown');if(unknown)findings.push(`${unknown.count} session(s) have no place category. Automatic location matching and the end-of-session fallback question help link future ratings to places.`);
 if(!observations.length)findings.push('Complete a study check-in with productivity, mood and distraction ratings to start building insights.');
 return {generatedAt:new Date(now).toISOString(),period:insightPeriod(now),nextRefresh:'Daily at 8 PM Pacific while the bot runs',total:observations.length,personal:observations.filter(r=>!r.synthetic).length,synthetic:observations.filter(r=>r.synthetic).length,places,findings};
}
