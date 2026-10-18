import type {StudySession} from './sessions.ts';
import type {SessionFeedback} from './feedback.ts';
export type LearningPair={session_record:StudySession;feedback_record:SessionFeedback};
export interface StudyHistorySource{load(userKey:string):Promise<LearningPair[]>;}
export class SupabaseLearningStore implements StudyHistorySource{
 private url:string;
 constructor(url:string,private secret:string,private request:(url:string,init?:RequestInit)=>Promise<Response>=fetch){const parsed=new URL(url);if(parsed.protocol!=='https:'||!parsed.hostname.endsWith('.supabase.co')||parsed.username||parsed.password||!secret.startsWith('sb_secret_'))throw Error('Invalid learning store configuration');this.url=parsed.origin;}
 async load(userKey:string):Promise<LearningPair[]>{
  if(!/^[a-f0-9]{64}$/.test(userKey))throw Error('Invalid user key');const rows:LearningPair[]=[];
  for(let offset=0;offset<10000;offset+=500){
   const query=new URLSearchParams({select:'session_record,feedback_record',user_id:`eq.${userKey}`,order:'feedback_id.asc',limit:'500',offset:String(offset)});
   const r=await this.request(`${this.url}/rest/v1/study_learning_history?${query}`,{headers:{apikey:this.secret},redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!r.ok)throw Error('Cloud learning history unavailable');const page=await r.json();if(!Array.isArray(page)||page.length>500)throw Error('Invalid learning history');rows.push(...page);if(page.length<500)return rows;
  }
  throw Error('Learning history exceeds replay limit');
 }
}
export function configuredLearningStore():StudyHistorySource|null{return process.env.SUPABASE_URL&&process.env.SUPABASE_SECRET_KEY?new SupabaseLearningStore(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY):null;}
