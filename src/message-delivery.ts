import {mkdir,open} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
// Reserve before handling: a redelivery must not send the same reply again.
// If the process dies after reservation, the user can send a new message to retry.
export class MessageDelivery {
 constructor(private directory=fileURLToPath(new URL("../data/message-delivery/",import.meta.url))){}
 async claim(conversation:string,messageId:string):Promise<boolean>{
  await mkdir(this.directory,{recursive:true});
  const key=createHash("sha256").update(JSON.stringify([conversation,messageId])).digest("hex");
  try{const handle=await open(join(this.directory,key),"wx",0o600);await handle.close();return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")return false;throw error;}
 }
}
