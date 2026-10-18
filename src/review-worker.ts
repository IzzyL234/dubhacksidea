import {createServer} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ReviewLinks} from './review-links.ts';
import {demoCalendar} from './calendar-api.ts';
// Put only this capability-protected worker behind HTTPS for hosted reviews.
// The full local web server includes development/OAuth routes and stays local.
const reviews=new ReviewLinks(demoCalendar,process.env.SCHEDULE_REVIEW_DIRECTORY??join(fileURLToPath(new URL('..',import.meta.url)),'data','schedule-reviews'));
export const reviewWorker=createServer(async(req,res)=>{
 const path=new URL(req.url??'/', 'http://worker.local').pathname,match=path.match(/^\/api\/learning\/reviews\/([a-f0-9]{16})(?:\/(approve|deny))?$/),method=req.method??'GET';
 let response:Response;
 if(!match)response=Response.json({error:'Not found.'},{status:404});
 else if(!['GET','POST'].includes(method)||(method==='POST')!==Boolean(match[2]))response=Response.json({error:'Method unavailable.'},{status:405});
 else response=await reviews.request(match[1]!,req.headers.authorization??'',match[2] as 'approve'|'deny'|undefined);
 res.writeHead(response.status,{...Object.fromEntries(response.headers),'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(await response.text());
});
if(process.argv[1]===fileURLToPath(import.meta.url))reviewWorker.listen(Number(process.env.REVIEW_WORKER_PORT??3003),'127.0.0.1',()=>console.log('Private calendar review worker listening on loopback.'));
