import type {DecisionFacts} from './proactive-decision.ts';
export type ProactivityEvent={id:string;user_key:string;reported_at:string;action:'stay_quiet'|'offer_study'|'offer_place'|'accepted'|'skipped';reason:string;occurrence_count:number;place_category?:string;decision_context?:DecisionFacts;related_decision_id?:string};
export interface EventSink{put(event:ProactivityEvent):Promise<void>;}
export class SupabaseEvents implements EventSink{
 private url:string;
 constructor(url:string,private secret:string,private request:(url:string,init?:RequestInit)=>Promise<Response>=fetch){const p=new URL(url);if(p.protocol!=='https:'||!p.hostname.endsWith('.supabase.co')||p.username||p.password||!secret.startsWith('sb_secret_'))throw Error('Invalid event store configuration');this.url=p.origin;}
 async put(event:ProactivityEvent):Promise<void>{
  if(!/^[a-f0-9]{64}$/.test(event.user_key)||!/^[a-f0-9-]{36}$/i.test(event.id)||!['stay_quiet','offer_study','offer_place','accepted','skipped'].includes(event.action)||!/^\w{1,80}$/.test(event.reason))throw Error('Invalid event');
  if(!Number.isInteger(event.occurrence_count)||event.occurrence_count<1||!Number.isFinite(Date.parse(event.reported_at)))throw Error('Invalid event count or timestamp');
  const places=['library','cafe','home','dorm_room','classroom','campus_building'];
  if(event.place_category&&!places.includes(event.place_category))throw Error('Invalid category');
  if(event.related_decision_id&&!/^[a-f0-9-]{36}$/i.test(event.related_decision_id))throw Error('Invalid related decision');
  let context:Record<string,unknown>|undefined;
  if(event.decision_context){const f=event.decision_context;if(!places.includes(f.place))throw Error('Invalid context');context={place:f.place};for(const k of ['stableMinutes','locationAgeSeconds','accuracyMeters','freeMinutes','plannedMinutes','acceptedRecently','skippedRecently'] as const){if(typeof f[k]!=='number'||!Number.isFinite(f[k])||f[k]<0)throw Error('Invalid context');context[k]=f[k];}}
  const body={id:event.id,user_key:event.user_key,reported_at:event.reported_at,action:event.action,reason:event.reason,occurrence_count:event.occurrence_count,...(event.place_category?{place_category:event.place_category}:{}),...(context?{decision_context:context}:{}),...(event.related_decision_id?{related_decision_id:event.related_decision_id}:{})};
  const r=await this.request(`${this.url}/rest/v1/proactivity_events?on_conflict=id`,{method:'POST',headers:{apikey:this.secret,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},redirect:'error',signal:AbortSignal.timeout(10000),body:JSON.stringify(body)});
  if(!r.ok)throw Error('Event upload unavailable');
 }
}
export function configuredEventSink():EventSink|null{return process.env.SUPABASE_URL&&process.env.SUPABASE_SECRET_KEY?new SupabaseEvents(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY):null;}
