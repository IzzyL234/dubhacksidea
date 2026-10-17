export async function jsonRequest(url,options={},request=fetch) {
  const r=await request(url,{...options,signal:AbortSignal.timeout(20000)});
  if(!r.ok) throw new Error(`Provider request failed (${r.status})`);
  return r.json();
}
export class Calendar {
  constructor(env=process.env,request=fetch) {this.env=env;this.request=request;}
  get enabled() {return !!(this.env.GOOGLE_CLIENT_ID&&this.env.GOOGLE_CLIENT_SECRET&&this.env.GOOGLE_REFRESH_TOKEN);}
  async call(path,body) {
    if(!this.enabled) throw new Error('Google Calendar is not configured');
    const token=await jsonRequest('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID,client_secret:this.env.GOOGLE_CLIENT_SECRET,refresh_token:this.env.GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'})},this.request);
    return jsonRequest(`https://www.googleapis.com/calendar/v3/${path}`,{method:'POST',headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(body)},this.request);
  }
  async busy(start,end) {
    const id=this.env.GOOGLE_CALENDAR_ID||'primary';
    const result=await this.call('freeBusy',{timeMin:start,timeMax:end,items:[{id}]});
    if(!result.calendars?.[id] || result.calendars[id].errors?.length) throw new Error('Calendar availability could not be verified');
    return result.calendars[id].busy;
  }
  async create(event) {
    return this.call(`calendars/${encodeURIComponent(this.env.GOOGLE_CALENDAR_ID||'primary')}/events`,{id:event.id.replaceAll('-',''),summary:event.title,start:{dateTime:event.start},end:{dateTime:event.end}});
  }
}
export async function extractImage(base64,env=process.env,request=fetch) {
  if(!env.VISION_ACCESS_TOKEN || !env.GOOGLE_CLOUD_PROJECT) throw new Error('Cloud Vision is not configured; paste flyer text instead');
  if(typeof base64!=='string'||base64.length>6_000_000||!/^[A-Za-z0-9+/=]+$/.test(base64)) throw new Error('Invalid image; use JPEG or PNG under 4 MB');
  const result=await jsonRequest('https://vision.googleapis.com/v1/images:annotate',{method:'POST',headers:{Authorization:`Bearer ${env.VISION_ACCESS_TOKEN}`,'x-goog-user-project':env.GOOGLE_CLOUD_PROJECT,'Content-Type':'application/json'},body:JSON.stringify({requests:[{image:{content:base64},features:[{type:'TEXT_DETECTION'}]}]})},request);
  if(result.responses?.[0]?.error) throw new Error('Image extraction failed');
  return result.responses?.[0]?.fullTextAnnotation?.text || result.responses?.[0]?.textAnnotations?.[0]?.description || '';
}
