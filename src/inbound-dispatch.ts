// Claim before canceling work: a duplicate transport delivery must not abort its original.
export function createInboundDispatch<T>(deps:{claim:(chat:string,id:string)=>Promise<boolean>;cancel:(chat:string)=>void;enqueue:(chat:string,work:()=>Promise<void>)=>Promise<void>;handle:(chat:string,message:T)=>Promise<void>;id:(message:T)=>string;isText:(message:T)=>boolean;onError:()=>void}){
 return async(chat:string,message:T)=>{
  if(!await deps.claim(chat,deps.id(message)))return false;
  if(deps.isText(message))deps.cancel(chat);
  void deps.enqueue(chat,()=>deps.handle(chat,message)).catch(deps.onError);
  return true;
 };
}
