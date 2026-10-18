import {mkdirSync,writeFileSync,readFileSync,unlinkSync,statSync} from "node:fs";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";
export class AlreadyRunning extends Error {}
function alive(pid:number):boolean{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==="EPERM";}}
export function acquireInstance(path:string,isAlive=alive):()=>void{
 mkdirSync(dirname(path),{recursive:true});const token=randomUUID(),body=JSON.stringify({pid:process.pid,token});
 for(let attempt=0;attempt<3;attempt++){
  try{writeFileSync(path,body,{flag:"wx",mode:0o600});return ()=>{try{if(readFileSync(path,"utf8")===body)unlinkSync(path);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}};}
  catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  let current:string;try{current=readFileSync(path,"utf8");}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}
  try{const lease=JSON.parse(current) as {pid:number};if(Number.isInteger(lease.pid)&&lease.pid>0&&isAlive(lease.pid))throw new AlreadyRunning("The study bot is already running. No second copy was started.");}
  catch(e){if(e instanceof AlreadyRunning)throw e;if(Date.now()-statSync(path).mtimeMs<5000)throw new AlreadyRunning("The study bot is starting in another process. No second copy was started.");}
  try{if(readFileSync(path,"utf8")===current)unlinkSync(path);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 }
 throw new AlreadyRunning("Another study bot is starting. No second copy was started.");
}
