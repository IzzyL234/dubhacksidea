import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store,SupabaseStore} from './store.js';
import {Calendar} from './integrations.js';
import {Agent} from './service.js';

export function createApp(agent,token) {
  let serial=Promise.resolve();
  const routes={ '/api/slots':'candidates','/api/sessions':'session','/api/ratings':'rate','/api/decisions':'decision','/api/proposals':'propose','/api/confirm':'confirm','/api/tick':'tick','/api/ack':'ack','/api/messages':'message','/api/flyer':'flyer'};
  return createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if(!/^127\.0\.0\.1(?::\d+)?$|^localhost(?::\d+)?$/.test(req.headers.host??'')) {res.writeHead(403);return res.end('{"error":"Local access only"}');}
      const path=new URL(req.url,'http://localhost').pathname;
      const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if(req.method==='GET'&&files[path]) {res.setHeader('Content-Type',files[path][1]);return res.end(readFileSync(new URL(`../public/${files[path][0]}`,import.meta.url)));}
      const supplied=Buffer.from((req.headers.authorization??'').replace(/^Bearer /,'')),expected=Buffer.from(token);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)) {res.writeHead(401);return res.end('{"error":"Enter your app token"}');}
      if(req.method==='GET'&&path==='/api/status') return res.end(JSON.stringify(await agent.status()));
      if(req.method!=='POST'||!routes[path]) {res.writeHead(404);return res.end('{"error":"Not found"}');}
      if(!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
      let body='';for await(const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>6_500_000) {res.writeHead(413);return res.end('{"error":"Request too large"}');}}
      const input=JSON.parse(body||'{}');
      // Serialize writes: confirmation, message dedupe, and prompt generation cannot race in one process.
      const operation=serial.then(()=>agent[routes[path]](input)); serial=operation.catch(()=>{});
      res.end(JSON.stringify(await operation));
    } catch(error) {res.writeHead(400);res.end(JSON.stringify({error:error.message}));}
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const token=process.env.APP_TOKEN||randomBytes(24).toString('hex');
  if(!!process.env.SUPABASE_URL!==!!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Set both Supabase variables');
  const store=process.env.SUPABASE_URL?new SupabaseStore(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY):new Store(process.env.DB_PATH);
  const agent=new Agent(store,new Calendar());
  const server=createApp(agent,token);
  const timer=setInterval(()=>agent.tick().catch(()=>console.error('Proactive check failed; check storage connectivity')),60000);
  server.listen(Number(process.env.PORT||3000),'127.0.0.1',()=>{console.log(`Daywise: http://127.0.0.1:${process.env.PORT||3000}`);if(!process.env.APP_TOKEN)console.log(`App token: ${token}`);});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);server.close(()=>{store.close();process.exit();});});
}
