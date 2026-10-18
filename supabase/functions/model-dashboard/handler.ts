import demoRows from "../../../data/seed_sessions.json";
import {buildDashboardSnapshot} from '../../../src/dashboard-snapshot.ts';
type Settings={url:string;serviceKey:string;allowedOrigins:string[];now?:()=>number};
const sha=async(s:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(n=>n.toString(16).padStart(2,'0')).join('');
export function createDashboardHandler(settings:Settings,request:(url:string,init?:RequestInit)=>Promise<Response>=fetch){
 return async(req:Request):Promise<Response>=>{
  const origin=req.headers.get('origin');const allowed=!!origin&&settings.allowedOrigins.includes(origin);
  const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'private, no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  if(allowed){headers['Access-Control-Allow-Origin']=origin!;headers['Access-Control-Allow-Headers']='authorization,content-type';headers['Access-Control-Allow-Methods']='GET,OPTIONS';}
  const reply=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers});
  if(origin&&!allowed)return reply(403,{error:'This website is not connected to the dashboard.'});
  if(req.method==='OPTIONS')return new Response(null,{status:allowed?204:403,headers});
  if(req.method!=='GET')return reply(405,{error:'Read-only endpoint.'});
  let base:string;try{const p=new URL(settings.url);if(p.protocol!=='https:'||!p.hostname.endsWith('.supabase.co')||p.username||p.password||!settings.serviceKey)throw Error();base=p.origin;}catch{return reply(503,{error:'Dashboard backend needs configuration.'});}
  const token=req.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];if(!token)return reply(401,{error:'Enter a dashboard code from your bot chat.'});
  const apiHeaders:Record<string,string>={apikey:settings.serviceKey};if(settings.serviceKey.split('.').length===3)apiHeaders.Authorization='Bearer '+settings.serviceKey;
  const read=async(path:string)=>{const r=await request(`${base}/rest/v1/${path}`,{headers:apiHeaders,redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Data unavailable');const rows=await r.json();if(!Array.isArray(rows))throw Error('Invalid data');return rows;};
  try{
   const grants=await read(`dashboard_access?select=user_key,expires_at&token_hash=eq.${await sha(token)}&limit=1`),grant=grants[0];
   if(!grant||!/^[a-f0-9]{64}$/.test(grant.user_key)||!Number.isFinite(Date.parse(grant.expires_at))||Date.parse(grant.expires_at)<=(settings.now??Date.now)())return reply(401,{error:'Dashboard code expired or disconnected. Request a new code from the bot.'});
   const user=grant.user_key;
   const history=async()=>{const all:unknown[]=[];for(let offset=0;offset<10000;offset+=500){const page=await read(`study_learning_history?select=session_record,feedback_record&user_id=eq.${user}&order=feedback_id.asc&limit=500&offset=${offset}`);if(page.length>500)throw Error();all.push(...page);if(page.length<500)return all;}throw Error('History limit');};
   const result=await Promise.allSettled([history(),read(`proactivity_events?select=user_key,reported_at,action,reason,occurrence_count&user_key=eq.${user}&order=reported_at.desc&limit=15`),read(`study_sessions?select=user_id,is_synthetic,status,started_at,duration_mins,location,study_space,environment&user_id=eq.${user}&is_synthetic=eq.false&status=in.(active,awaiting_feedback)&order=started_at.desc&limit=1`)]);
   if(result.some(r=>r.status==='rejected'))return reply(502,{error:'Dashboard data is temporarily unavailable. Your existing data has not changed.'});
   const values=result.map(r=>(r as PromiseFulfilledResult<any[]>).value);return reply(200,buildDashboardSnapshot(user,values[0]!,values[1]!,values[2]!, (settings.now??Date.now)(),demoRows));
  }catch{return reply(502,{error:'Dashboard data is temporarily unavailable. Check backend setup or try again shortly.'});}
 };
}
