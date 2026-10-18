import {learningDashboard} from './learning-web.ts';
import {scheduleReviewProjection} from './schedule-review-public.ts';
type Options={request?:typeof fetch;reviewBackend?:string};
const reply=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
// Hosted entry point deliberately excludes the local server's shared-calendar,
// OAuth and legacy demo routes. History still requires the private dashboard code.
export async function hostedWeb(request:Request,options:Options={}):Promise<Response>{
 const url=new URL(request.url),route=url.searchParams.get('route');
 const path=route?'/api/'+route:url.pathname,authorization=request.headers.get('authorization')??'';
 if(path==='/api/learning/dashboard')return request.method==='GET'?learningDashboard(authorization,options.request):reply(405,{error:'Read-only dashboard endpoint.'});
 const match=path.match(/^\/api\/learning\/reviews\/([a-f0-9]{16})(?:\/(approve|deny))?$/);
 if(match){
  if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))return reply(401,{error:'Open your private calendar review link.'});
  if(!['GET','POST'].includes(request.method)||(request.method==='POST')!==Boolean(match[2]))return reply(405,{error:'Use an explicit review action.'});
  const origin=request.headers.get('origin');if(origin&&origin!==url.origin)return reply(403,{error:'Open the review on the Daywise website.'});
  const configured=options.reviewBackend??process.env.REVIEW_BACKEND_URL;if(!configured)return reply(503,{error:'Calendar approval is not connected to this hosted site yet. You can still approve or skip in your bot chat.'});
  let backend:URL;try{backend=new URL(configured);if(backend.protocol!=='https:'||backend.username||backend.password||backend.search||backend.hash||backend.pathname!=='/'||backend.port)throw Error();}catch{return reply(503,{error:'The team needs to check the calendar approval connection.'});}
  try{
   const result=await (options.request??fetch)(backend.origin+path,{method:request.method,headers:{Authorization:authorization},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(24000)});
   const data=await result.json();if(!result.ok)return reply(result.status===401?401:result.status===410?410:503,{error:result.status===410?'This review expired. Text review schedule for a fresh check.':'Could not load or confirm the review. Retry the same link or use your bot chat.'});
   const review=scheduleReviewProjection([data])[0];if(!review||review.id!==match[1])throw Error();
   return reply(200,{review});
  }catch{return reply(503,{error:'The calendar worker is temporarily unavailable. Retry the same link; no duplicate event will be created.'});}
 }
 if(path==='/api/auth/status'&&request.method==='GET')return reply(200,{authenticated:false,liveGoogleConnected:false,privateDashboard:true});
 return reply(404,{error:'This action runs through your bot. Connect a private dashboard code to view your calendar and history.'});
}
