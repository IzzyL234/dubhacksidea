import {cloud} from 'spectrum-ts';
import {createGrpcClient,type AdvancedIMessage} from '@photon-ai/advanced-imessage/grpc';
type Receipt={id:string;at:number;outbound:boolean};
// A scoped backup for the already-connected chat, not a second messaging bot.
export class InboxRecovery {
 private busy=false;private cursor:number;private seen=new Set<string>();
 constructor(private deps:{recipient:()=>Promise<string|null>;list:(chat:string,after:number)=>Promise<Receipt[]>;deliver:(chat:string,id:string)=>Promise<void>;now?:()=>number},since=(deps.now??Date.now)()){this.cursor=since;}
 async tick(){if(this.busy)return;this.busy=true;try{
  const chat=await this.deps.recipient();if(!chat)return;
  const rows=(await this.deps.list(chat,this.cursor-1000)).filter(r=>!r.outbound&&r.at>=this.cursor-1000).sort((a,b)=>a.at-b.at);
  for(const row of rows){if(this.seen.has(row.id))continue;await this.deps.deliver(chat,row.id);this.seen.add(row.id);}
  if(rows.length)this.cursor=Math.max(this.cursor,...rows.map(r=>r.at));
  if(this.seen.size>2000)this.seen=new Set([...this.seen].slice(-1000));
 }finally{this.busy=false;}}
}
export function photonInboxList(){
 let clients:AdvancedIMessage[]=[],expires=0;
 return async(chat:string,after:number):Promise<Receipt[]>=>{
  if(Date.now()>=expires){
   const id=process.env.PROJECT_ID??process.env.SPECTRUM_PROJECT_ID,secret=process.env.PROJECT_SECRET??process.env.SPECTRUM_PROJECT_SECRET;
   if(!id||!secret)throw Error('Photon configuration unavailable');
   const data=await cloud.issueImessageTokens(id,secret);
   const configs=data.type==='shared'?[{address:process.env.SPECTRUM_IMESSAGE_ADDRESS??'imessage.spectrum.photon.codes:443',token:data.token}]:Object.entries(data.auth).map(([line,token])=>({address:`${line}.imsg.photon.codes:443`,token}));
   await Promise.allSettled(clients.map(c=>c.close()));clients=configs.map(c=>createGrpcClient({...c,tls:true,timeout:10000,retry:false}));expires=Date.now()+15*60000;
  }
  const rows:Receipt[]=[];let succeeded=false;
  for(const client of clients){try{
   let pageToken:string|undefined;
   for(let page=0;page<5;page++){
    const result=await client.messages.listInChat(chat,{after:new Date(after),isFromMe:false,pageSize:100,...(pageToken?{pageToken}:{})});
    rows.push(...result.messages.map(m=>({id:m.guid,at:m.dateCreated.getTime(),outbound:m.isFromMe})));pageToken=result.nextPageToken;
    if(!pageToken)break;if(page===4)throw Error('Recovery page limit');
   }
   succeeded=true;
  }catch{/* Other configured lines may not own this chat. */}}
  if(!succeeded)throw Error('Photon inbox recovery unavailable');return rows;
 };
}
