import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
type Reply={id:string;text:string;expires:number};
export class DashboardAccess {
 private locks=new Map<string,Promise<unknown>>();private base:string;
 constructor(url:string,private key:string,private request:(url:string,init?:RequestInit)=>Promise<Response>=fetch,private directory=fileURLToPath(new URL('../data/dashboard/',import.meta.url)),private now=Date.now){const p=new URL(url);if(p.protocol!=='https:'||!p.hostname.endsWith('.supabase.co')||p.username||p.password||!key.startsWith('sb_secret_'))throw Error('Invalid dashboard connection');this.base=p.origin;}
 async handle(conversation:string,text:string,messageId:string):Promise<string|null>{
 const command=text.trim().toLowerCase().replace(/[.!?]+$/,'');if(!['dashboard code','connect dashboard','disconnect dashboard'].includes(command))return null;
 const user=createHash('sha256').update(conversation).digest('hex'),id=createHash('sha256').update(messageId).digest('hex');const previous=this.locks.get(user)??Promise.resolve();
 const operation=previous.catch(()=>{}).then(async()=>{
  const path=join(this.directory,user+'.json');let replies:Reply[]=[];try{replies=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const cached=replies.find(r=>r.id===id&&r.expires>this.now());if(cached)return cached.text;
  const revoke=command==='disconnect dashboard',token=revoke?'':randomBytes(32).toString('base64url'),expires=this.now()+86400000;
  const response=await this.request(`${this.base}/rest/v1/dashboard_access${revoke?'?user_key=eq.'+user:'?on_conflict=user_key'}`,{method:revoke?'DELETE':'POST',headers:{apikey:this.key,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},redirect:'error',signal:AbortSignal.timeout(10000),...(revoke?{}:{body:JSON.stringify({user_key:user,token_hash:createHash('sha256').update(token).digest('hex'),expires_at:new Date(expires).toISOString()})})});
  if(!response.ok)return 'Dashboard connection is not ready. Ask the team to check migration 009 and the Supabase connection.';
  const reply=revoke?'Dashboard access disconnected. Your existing sessions and ratings are unchanged.':`Your private read-only dashboard code (expires in 24 hours):\n${token}\nPaste it into the Framer learning panel. A new code replaces the previous one. Text disconnect dashboard to revoke it. Treat this code like a password.`;
  await mkdir(this.directory,{recursive:true});const tmp=path+'.tmp';await writeFile(tmp,JSON.stringify([...replies.filter(r=>r.expires>this.now()).slice(-19),{id,text:reply,expires}]),{mode:0o600});await rename(tmp,path);return reply;
 });this.locks.set(user,operation);try{return await operation;}finally{if(this.locks.get(user)===operation)this.locks.delete(user);}
 }
}
export function configuredDashboardAccess():DashboardAccess|null{return process.env.SUPABASE_URL&&process.env.SUPABASE_SECRET_KEY?new DashboardAccess(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY):null;}
