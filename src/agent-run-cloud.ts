export type AgentRun={id:string;at:number;tools:{tool:string;ok:boolean}[];outcome:string};
export interface AgentRunSink{put(owner:string,runs:AgentRun[]):Promise<void>}
export class SupabaseAgentRuns implements AgentRunSink{
 private base:string;
 constructor(url:string,private secret:string,private request:typeof fetch=fetch){const u=new URL(url);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.username||u.password||!secret.startsWith('sb_secret_'))throw Error('Invalid agent audit connection');this.base=u.origin;}
 async put(owner:string,runs:AgentRun[]){
  if(!/^[a-f0-9]{64}$/.test(owner))throw Error('Invalid agent audit owner');
  const rows=runs.map(r=>({id:r.id,user_key:owner,reported_at:new Date(r.at).toISOString(),outcome:r.outcome.slice(0,40),steps:r.tools.map(t=>({tool:t.tool,ok:t.ok}))}));
  const response=await this.request(this.base+'/rest/v1/agent_runs?on_conflict=id',{method:'POST',headers:{apikey:this.secret,'Content-Type':'application/json',Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify(rows),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Agent traces queued; check migration 015');
 }
}
export function configuredAgentRunSink():AgentRunSink|null{return process.env.SUPABASE_URL&&process.env.SUPABASE_SECRET_KEY?new SupabaseAgentRuns(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY):null;}
