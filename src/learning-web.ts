import {buildInsights,type InsightObservation} from './insights.ts';
import {insightObservations} from './insights.ts';
import starterRows from '../data/seed_sessions.json';
// Read-only proxy: the existing expiring dashboard code remains the identity.
// The web server needs no Supabase service key and cannot select another user.
export async function learningDashboard(authorization:string|undefined,request:typeof fetch=fetch,base=process.env.SUPABASE_URL??'https://dhnmqgxjxwlfsmoaogvh.supabase.co'):Promise<Response>{
 const reply=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 if(!authorization||!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))return reply(401,{error:'Enter a dashboard code from your bot chat.'});
 let url:URL;try{url=new URL(base);if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.port)throw Error();}catch{return reply(503,{error:'Dashboard backend configuration needs attention.'});}
 try{
  const r=await request(url.origin+'/functions/v1/model-dashboard',{headers:{Authorization:authorization},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)});
  if(!r.ok)return reply(r.status===401?401:502,{error:r.status===401?'Dashboard code expired or disconnected. Request a new code from the bot.':'Dashboard connection is temporarily unavailable.'});
  const data=await r.json() as {model:unknown;history:any[];events:unknown[];insights?:unknown};if(!data?.model||!Array.isArray(data.history)||!Array.isArray(data.events))throw Error();
  if(!data.insights){
   const starter=insightObservations('0'.repeat(64),[],starterRows);
   const recent:InsightObservation[]=data.history.flatMap((h:any,i:number)=>[h.productivity,h.mood,h.distraction].every((v:any)=>Number.isInteger(v)&&v>=1&&v<=5)?[{id:'recent:'+i,place:h.place,productivity:h.productivity,mood:h.mood,distraction:h.distraction,attribution:null,synthetic:false}]:[]);
   const report=buildInsights([...starter,...recent]);
   // The legacy endpoint returns only the latest twelve personal check-ins and
   // omits attribution. Do not extrapolate them into a complete personal history.
   report.findings.push('This initial report uses combined learning history and your latest check-ins. Detailed attribution for older check-ins may be unavailable.');
   data.insights={...report,scheduled:false};
  }
  return reply(200,data);
 }catch{return reply(502,{error:'Dashboard connection is temporarily unavailable.'});}
}
