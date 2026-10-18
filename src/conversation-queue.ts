// One conversation stays ordered while unrelated chats can continue replying.
export class ConversationQueue{
 private pending=new Map<string,Promise<unknown>>();
 async enqueue<T>(chat:string,work:()=>Promise<T>):Promise<T>{
  const previous=this.pending.get(chat)??Promise.resolve();
  const next=previous.catch(()=>{}).then(work);this.pending.set(chat,next);
  try{return await next;}finally{if(this.pending.get(chat)===next)this.pending.delete(chat);}
 }
}
