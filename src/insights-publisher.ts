import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildInsights,insightObservations,insightPeriod} from './insights.ts';
import type {StudyHistorySource} from './learning-store.ts';
export class InsightsPublisher{
 private running=false;
 constructor(private source:StudyHistorySource,private seed:unknown[],private base:string,private secret:string,private request:(url:string,init?:RequestInit)=>Promise<Response>=fetch,private now=Date.now,private directory=fileURLToPath(new URL('../data/insights/',import.meta.url))){const u=new URL(base);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.username||u.password||!secret.startsWith('sb_secret_'))throw Error('Invalid insights configuration');this.base=u.origin;}
 async tick(){if(this.running)return;this.running=true;try{
  const headers={apikey:this.secret,'Content-Type':'application/json'},r=await this.request(this.base+'/rest/v1/dashboard_access?select=user_key',{headers,signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Insights owners unavailable');
  const owners=await r.json();if(!Array.isArray(owners))throw Error('Invalid owners');
  for(const user of [...new Set(owners.map((r:any)=>r.user_key).filter((v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)))]){
   const path=join(this.directory,String(user)+'.json'),period=insightPeriod(this.now());let previous:any=null;try{previous=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as any).code!=='ENOENT')throw e;}
   if(previous?.period===period)continue;
   // A cloud outage must not replace personal evidence with starter-only findings.
   const pairs=await this.source.load(String(user)),report=buildInsights(insightObservations(String(user),pairs,this.seed),this.now());
   const saved=await this.request(this.base+'/rest/v1/study_insights?on_conflict=user_key',{method:'POST',headers:{...headers,Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({user_key:user,generated_at:report.generatedAt,report}),signal:AbortSignal.timeout(10000),redirect:'error'});if(!saved.ok)throw Error('Insights need migration 013');
   await mkdir(this.directory,{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify({period}),{mode:0o600});await rename(tmp,path);
  }
 }finally{this.running=false;}}
}
