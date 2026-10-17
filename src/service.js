import {randomUUID} from 'node:crypto';
import {text,number,interval,overlaps,decide,recommend,parseFlyer} from './agent.js';
import {extractImage} from './integrations.js';

export class Agent {
  constructor(store,calendar,{now=()=>new Date(),env=process.env}={}) {this.store=store;this.calendar=calendar;this.now=now;this.env=env;}
  async status() {
    const sessions=await this.store.list('sessions');
    return {sessions,events:await this.store.list('events'),prompts:await this.store.list('prompts'),decisions:await this.store.list('decisions'),integrations:{calendar:this.calendar.enabled,storage:this.env.SUPABASE_URL?'Supabase':'SQLite',images:!!this.env.VISION_ACCESS_TOKEN},rated:sessions.filter(s=>s.rating).length};
  }
  async busy(start,end) {
    const local=(await this.store.list('events')).filter(e=>e.status==='confirmed'||e.status==='syncing');
    return this.calendar.enabled ? [...local,...await this.calendar.busy(start,end)] : local;
  }
  async candidates(input) {
    const duration=number(input.minutes??50,15,180,'minutes');
    const offset=number(input.offsetMinutes??0,-840,840,'UTC offset minutes');
    const now=this.now(), end=new Date(+now+48*3600000);
    const busy=await this.busy(now.toISOString(),end.toISOString());
    const slots=[];
    for(let t=Math.ceil(+now/1800000)*1800000;t+duration*60000<=+end;t+=1800000) {
      const local=new Date(t+offset*60000),hour=local.getUTCHours();
      if(hour<8 || hour+duration/60>22) continue;
      const slot={start:new Date(t).toISOString(),end:new Date(t+duration*60000).toISOString(),localHour:hour};
      if(!busy.some(b=>overlaps(slot,b))) slots.push(slot);
    }
    return {slots:recommend(await this.store.list('sessions'),slots).slice(0,8),availabilitySource:this.calendar.enabled?'Google Calendar + local commitments':'Local demo commitments only'};
  }
  async session(input) {
    const times=interval(input.start,input.end);
    return this.store.put('sessions',{...times,title:text(input.title,'title',160),localHour:number(input.localHour,0,23,'local hour'),createdAt:this.now().toISOString()});
  }
  async rate(input) {
    const session=(await this.store.list('sessions')).find(s=>s.id===input.id);
    if(!session) throw new Error('Session not found');
    if(Date.parse(session.end)>+this.now()) throw new Error('Rate a session after it ends');
    const rating=number(input.rating,1,5,'rating');
    if(!Number.isInteger(rating)) throw new Error('Rating must be a whole number');
    return this.store.put('sessions',{...session,rating});
  }
  async decision(input) {
    let conflict=false;
    if(input.start||input.end) {const times=interval(input.start,input.end);conflict=(await this.busy(times.start,times.end)).some(b=>overlaps(times,b));}
    const result=decide({...input,conflict});
    return this.store.put('decisions',{...result,title:text(input.title,'title',160),createdAt:this.now().toISOString()});
  }
  async propose(input) {
    const times=interval(input.start,input.end);
    if(Date.parse(times.start)<+this.now()) throw new Error('Choose a future time');
    return this.store.put('events',{...times,title:text(input.title,'title',160),status:'proposed',study:input.study===true,localHour:input.study===true?number(input.localHour,0,23,'local hour'):null});
  }
  async confirm(input) {
    const event=(await this.store.list('events')).find(e=>e.id===input.id);
    if(!event) throw new Error('Proposal not found');
    if(event.status==='confirmed') return this.finishStudy(event);
    if(event.status==='syncing') throw new Error('Calendar write pending or uncertain; inspect Google Calendar before retrying');
    if(Date.parse(event.start)<+this.now()) throw new Error('Proposal has expired');
    if((await this.busy(event.start,event.end)).some(b=>overlaps(event,b))) throw new Error('Time is now busy; choose another slot');
    if(this.calendar.enabled) {
      // Persist before external write. Never blindly retry a possibly successful network write.
      await this.store.put('events',{...event,status:'syncing'});
      const remote=await this.calendar.create(event);
      return this.finishStudy(await this.store.put('events',{...event,status:'confirmed',calendarId:remote.id,calendarUrl:remote.htmlLink}));
    }
    return this.finishStudy(await this.store.put('events',{...event,status:'confirmed',localOnly:true}));
  }
  async finishStudy(event) {
    if(event.study && !(await this.store.list('sessions')).some(s=>s.id===event.id)) await this.store.put('sessions',{id:event.id,title:event.title,start:event.start,end:event.end,localHour:event.localHour,createdAt:this.now().toISOString()});
    return event;
  }
  async tick() {
    const now=+this.now(),prompts=await this.store.list('prompts');
    for(const s of await this.store.list('sessions')) {
      const ended=Date.parse(s.end), start=Date.parse(s.start);
      const type=!s.rating && ended<=now && now-ended<86400000 ? 'rating' : start>now&&start-now<=15*60000 ? 'reminder' : null;
      if(!type) continue;
      const id=`${type}-${s.id}`;
      if(prompts.some(p=>p.id===id)) continue;
      await this.store.put('prompts',{id,sessionId:s.id,type,text:type==='rating'?`How was ${s.title}? Reply: rate ${s.id} 1-5`:`${s.title} starts in ${Math.ceil((start-now)/60000)} minutes. Ready for a focus block?`,createdAt:this.now().toISOString(),expiresAt:new Date(now+3600000).toISOString(),delivered:false});
    }
    return (await this.store.list('prompts')).filter(p=>!p.delivered&&Date.parse(p.expiresAt)>now);
  }
  async ack(input) {
    const p=(await this.store.list('prompts')).find(p=>p.id===input.id);
    if(!p) throw new Error('Prompt not found');
    return this.store.put('prompts',{...p,delivered:true});
  }
  async message(input) {
    const id=text(input.id,'message id',200),command=text(input.text);
    const prior=(await this.store.list('messages')).find(m=>m.id===id);
    if(prior) return prior;
    let reply;
    const rating=command.match(/^rate\s+(\S+)\s+([1-5])$/i);
    const study=command.match(/^study\s+(\d+)$/i);
    if(rating) {await this.rate({id:rating[1],rating:+rating[2]});reply='Rating saved. Your next recommendations will use this feedback.';}
    else if(study) {const result=await this.candidates({minutes:+study[1],offsetMinutes:input.offsetMinutes??0});reply=result.slots.length?`Suggested study times (UTC): ${result.slots.slice(0,3).map(s=>s.start).join(', ')}. Open the dashboard to review and confirm.`:'No free study slot in the next 48 hours.';}
    else if(/^yes\?/i.test(command)) {const v=command.slice(4).trim().split(/\s+/).map(Number);if(v.length!==6) throw new Error('Use yes? academic social wellbeing career cost energy (each 0–10)');const r=decide({academic:v[0],social:v[1],wellbeing:v[2],career:v[3],cost:v[4],energy:v[5]});reply=`${r.recommendation} (${r.score}/100). ${r.explanation} This text command does not check an event time; use the dashboard for calendar conflict checks.`;}
    else reply='Daywise: study 50 | rate SESSION_ID 1-5 | yes? 8 6 7 9 3 7. Use the dashboard for event review and calendar confirmation.';
    return this.store.put('messages',{id,reply,createdAt:this.now().toISOString()});
  }
  async flyer(input) {return parseFlyer(input.image?await extractImage(input.image,this.env):input.text);}
}
