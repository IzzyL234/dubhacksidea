import type {ExtraContext} from './session-context.ts';
export type ContextRecord = {feedbackId:string;sessionId:string;at:string;productivity:number;mood:number;context:ExtraContext};
export interface ContextSink {put(conversationKey:string, entry:ContextRecord):Promise<void>}
export class SupabaseContext implements ContextSink {
 private base:string;
 constructor(url:string,private secret:string,private request:typeof fetch=fetch){
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||!parsed.hostname.endsWith('.supabase.co')||parsed.username||parsed.password)throw Error('Use your Supabase project HTTPS URL');
  if(!secret.startsWith('sb_secret_'))throw Error('Use your Supabase backend Secret key');
  this.base=parsed.origin;
 }
 async put(conversationKey:string,entry:ContextRecord){
  if(!/^[a-f0-9]{64}$/.test(conversationKey))throw Error('Invalid conversation key');
  const response=await this.request(this.base+'/rest/v1/study_session_context?on_conflict=feedback_id',{
   method:'POST',headers:{apikey:this.secret,'Content-Type':'application/json',Prefer:'resolution=ignore-duplicates,return=minimal'},
   body:JSON.stringify({feedback_id:entry.feedbackId,session_id:entry.sessionId,conversation_key:conversationKey,reported_at:entry.at,
    sentiment:entry.context.sentiment,social:entry.context.social,social_effect:entry.context.socialEffect,factors:entry.context.factors}),
   redirect:'error',signal:AbortSignal.timeout(10000)
  });
  if(!response.ok)throw Error('Confirmed context sync unavailable (HTTP '+response.status+')');
 }
}
export function configuredContextSink():ContextSink|null{
 const url=process.env.SUPABASE_URL?.trim(),key=process.env.SUPABASE_SECRET_KEY?.trim();
 return url&&key?new SupabaseContext(url,key):null;
}
