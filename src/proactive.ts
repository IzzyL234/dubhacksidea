import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudyBlock } from "./study-events.ts";

type Delivery = { block: StudyBlock; startAttempted?: boolean; sessionId?: string; endAttempted?: boolean };
type State = {
  conversation?: string; enabled: boolean; quietEnabled?:boolean; quietStart: number; quietEnd: number;
  events: Record<string,Delivery>; pending?: {key:string;expires:number;kind?:"place"}; lastPrompt?:number; snoozeUntil?:number;
  replies:{id:string;conversation:string;reply:string}[];
};
export type ReminderDependencies = {
  events: (now:number)=>Promise<StudyBlock[]>;
  send: (conversation:string,text:string)=>Promise<void>;
  busy: (conversation:string)=>Promise<boolean>;
  start: (conversation:string,block:StudyBlock)=>Promise<{id:string;reply:string}|null>;
  active: (conversation:string,id:string)=>Promise<boolean>;
  checkIn: (conversation:string)=>Promise<boolean>;
  observe?:(conversation:string)=>Promise<{allow:boolean;message?:string;kind?:"place"}>;
  evaluate?:(conversation:string,block:StudyBlock)=>Promise<{allow:boolean;message?:string;kind?:"place"}>;
  resolvePlace?:(conversation:string,accept:boolean)=>Promise<string>;
  confirm?:(conversation:string,block:StudyBlock)=>Promise<boolean>;
  audit?:(conversation:string,reason:string)=>Promise<void>;
  outcome?:(conversation:string,kind:"accepted"|"skipped")=>Promise<void>;
  now?:()=>number;
};
export function isQuiet(now:number,start:number,end:number,timezone="America/Los_Angeles"):boolean {
  const hour=Number(new Intl.DateTimeFormat("en-US",{timeZone:timezone,hour:"numeric",hourCycle:"h23"}).format(new Date(now)));
  return start<end ? hour>=start&&hour<end : hour>=start||hour<end;
}
export class StudyReminders {
  private lock:Promise<unknown>=Promise.resolve();
  private now:()=>number;
  constructor(private deps:ReminderDependencies,
    private path=fileURLToPath(new URL("../data/reminders/state.json",import.meta.url))) {this.now=deps.now??Date.now;}
  private async serialized<T>(action:()=>Promise<T>):Promise<T> {
    const next=this.lock.catch(()=>{}).then(action);this.lock=next;return next;
  }
  private async read():Promise<State>{
    try{return JSON.parse(await readFile(this.path,"utf8"));}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {enabled:false,quietEnabled:false,quietStart:22,quietEnd:8,events:{},replies:[]};throw e;}
  }
  private async save(state:State){
    await mkdir(dirname(this.path),{recursive:true});const tmp=`${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmp,JSON.stringify(state),{mode:0o600});await rename(tmp,this.path);
  }
  async enabledFor(conversation:string):Promise<boolean>{return this.serialized(async()=>{const s=await this.read();return s.enabled&&s.conversation===conversation;});}
  private async audit(conversation:string,reason:string){try{await this.deps.audit?.(conversation,reason);}catch{}}
  private async outcome(conversation:string,kind:"accepted"|"skipped"){try{await this.deps.outcome?.(conversation,kind);}catch{}}
  async handle(conversation:string,text:string,messageId:string):Promise<string|null>{
    return this.serialized(async()=>{
      const command=text.trim().toLowerCase().replace(/[.!?]+$/,"");
      if(!/^(reminders (?:on|off|status)|quiet hours(?: .*)?|yes|skip)$/.test(command))return null;
      const state=await this.read();
      const previous=state.replies.find(r=>r.id===messageId&&r.conversation===conversation);if(previous)return previous.reply;
      const owner=state.conversation===conversation;
      let reply:string|null=null;
      if(command==="reminders on"){
        if(state.enabled&&!owner)reply="This demo calendar is already connected to another chat. Turn reminders off there before connecting this one.";
        else{
          if(!owner){state.events={};delete state.pending;delete state.lastPrompt;}
          state.conversation=conversation;state.enabled=true;
          reply=`Open-time suggestions are on for this chat. I look for 30+ free minutes between Hackathon Demo commitments, at any hour with 10-minute buffers. Quiet hours: ${state.quietEnabled===true?`${state.quietStart}:00–${state.quietEnd}:00 Pacific`:"off"}. Keep the bot running. Text reminders off to stop.`;
        }
      }else if(command==="reminders off"){
        if(owner){state.enabled=false;delete state.pending;reply="Study reminders are off.";}
        else reply="Study reminders aren't connected to this chat.";
      }else if(command==="reminders status")reply=state.enabled&&owner
        ?`Study reminders are on. Quiet hours: ${state.quietEnabled===true?`${state.quietStart}:00–${state.quietEnd}:00 Pacific`:"off"}. Polling every minute while the bot runs.`
        :"Study reminders are off for this chat. Text reminders on to connect the demo calendar.";
      else if(command.startsWith("quiet hours")){
        const hours=command.match(/^quiet hours (\d{1,2}) (\d{1,2})$/);
        if(!owner)reply="Text reminders on first.";
        else if(command==="quiet hours off"){state.quietEnabled=false;reply="Quiet hours are off. Study suggestions can happen at any hour, subject to calendar availability and prompt limits.";}
        else if(!hours||Number(hours[1])>23||Number(hours[2])>23||hours[1]===hours[2]||Number(hours[1])===Number(hours[2]))reply="Use quiet hours 22 8 (24-hour start and end, different hours from 0–23).";
        else{state.quietEnabled=true;state.quietStart=Number(hours[1]);state.quietEnd=Number(hours[2]);reply=`Quiet hours set to ${state.quietStart}:00–${state.quietEnd}:00 Pacific.`;}
      }else if(state.enabled&&owner&&state.pending){
        // "skip" can also be an answer in the existing distraction-source check-in.
        if(await this.deps.checkIn(conversation))return null;
        const pending=state.pending;
        if(pending.kind==="place"){
          reply=await this.deps.resolvePlace?.(conversation,command==="yes")??"Place confirmation unavailable. Nothing was saved.";
          if(command==="skip")state.snoozeUntil=this.now()+60*60_000;
          delete state.pending;
        }
        else if(command==="skip"){delete state.pending;state.snoozeUntil=this.now()+60*60_000;await this.save(state);await this.outcome(conversation,"skipped");reply="Skipped this study block. No session was created.";}
        else if(this.now()>pending.expires){delete state.pending;reply="That study prompt has expired. Text start studying if you're starting now.";}
        else{
          // Re-read Calendar before confirmation so a canceled or rescheduled event cannot start a stale session.
          const fresh=(await this.deps.events(this.now())).find(b=>b.key===pending.key);
          if(!fresh||this.now()<fresh.start||this.now()>=fresh.end||(fresh.kind==="open"&&fresh.end-this.now()<30*60_000)){delete state.pending;reply="That calendar opening changed or ended. Text open time for new options, or start studying to begin manually.";}
          else if(await this.deps.busy(conversation))reply="You already have an unfinished session or check-in. Finish it first, or text discard session.";
          else{
            if(this.deps.confirm&&!await this.deps.confirm(conversation,fresh)){delete state.pending;await this.save(state);return "Your location changed or is no longer fresh. No session was created. Text start studying to begin manually.";}
            const planned=fresh.kind==="open"?{...fresh,start:this.now(),end:this.now()+Math.min(45,Math.floor((fresh.end-this.now())/60_000))*60_000}:fresh;
            const started=await this.deps.start(conversation,planned);
            if(!started)reply="You already have an unfinished study session. Text study status.";
            else{
              state.events[pending.key]??={block:fresh,startAttempted:true};
              state.events[pending.key]!.sessionId=started.id;state.events[pending.key]!.block=planned;
              delete state.pending;await this.save(state);await this.outcome(conversation,"accepted");reply=started.reply;
            }
          }
        }
      }
      if(reply!==null){state.replies=[...state.replies,{id:messageId,conversation,reply}].slice(-80);await this.save(state);}
      return reply;
    });
  }
  async tick():Promise<void>{
    return this.serialized(async()=>{
      const state=await this.read();if(!state.enabled||!state.conversation)return;
      const now=this.now();
      if(state.quietEnabled===true&&isQuiet(now,state.quietStart,state.quietEnd)){await this.audit(state.conversation,"quiet_hours");return;}
      if(state.pending&&state.pending.expires<now)delete state.pending;
      // Building recognition is independent of Calendar and never starts a study session.
      if(this.deps.observe&&!state.pending&&!await this.deps.busy(state.conversation)&&now>=(state.snoozeUntil??0)
        &&(state.lastPrompt===undefined||now-state.lastPrompt>=10*60_000)){
        const day=new Date(now).toLocaleDateString("en-CA",{timeZone:"America/Los_Angeles"});
        const count=Object.values(state.events).filter(d=>d.startAttempted&&new Date(d.block.start).toLocaleDateString("en-CA",{timeZone:"America/Los_Angeles"})===day).length;
        if(count<2){
          const gate=await this.deps.observe(state.conversation);
          if(gate.allow&&gate.kind==="place"&&gate.message&&!(state.quietEnabled===true&&isQuiet(this.now(),state.quietStart,state.quietEnd))&&!await this.deps.busy(state.conversation)){
            const key=`place:${now}`,block:StudyBlock={key,title:"Place confirmation",start:now,end:now+10*60_000};
            state.events[key]={block,startAttempted:true};state.pending={key,expires:block.end,kind:"place"};state.lastPrompt=now;
            await this.save(state);await this.deps.send(state.conversation,gate.message);return;
          }
        }
      }
      const blocks=(await this.deps.events(now)).sort((a,b)=>a.start-b.start);
      const current=new Map(blocks.map(b=>[b.key,b]));
      if(state.pending&&(state.pending.expires<now||(state.pending.kind!=="place"&&!current.has(state.pending.key))))delete state.pending;
      for(const [key,delivery]of Object.entries(state.events)){
        if(delivery.block.end<now-14*86400_000){delete state.events[key];continue;}
        const fresh=current.get(key);if(fresh&&!delivery.sessionId)delivery.block=fresh;
      }
      // End prompt applies only to the exact session created by this calendar confirmation.
      for(const delivery of Object.values(state.events)){
        if(!delivery.sessionId||delivery.endAttempted||(!current.has(delivery.block.key)&&delivery.block.kind!=="open")
          ||now<delivery.block.end||now-delivery.block.end>15*60_000)continue;
        if(!await this.deps.active(state.conversation,delivery.sessionId)||await this.deps.checkIn(state.conversation))continue;
        delivery.endAttempted=true;state.lastPrompt=now;
        await this.save(state); // Reserve before send: delivery uncertainty must not cause repeat texts after restart.
        await this.deps.send(state.conversation,"Your calendar study block has ended. When you're finished, text done for your quick check-in. If you're still studying, keep going—I'll stay quiet.");
        return;
      }
      if(state.pending||await this.deps.busy(state.conversation)){await this.audit(state.conversation,state.pending?"pending_prompt":"unfinished_session_or_checkin");await this.save(state);return;}
      if(now<(state.snoozeUntil??0)){await this.audit(state.conversation,"skipped_cooldown");await this.save(state);return;}
      if(state.lastPrompt!==undefined&&now-state.lastPrompt<10*60_000){await this.audit(state.conversation,"prompt_cooldown");await this.save(state);return;}
      const today=new Date(now).toLocaleDateString("en-CA",{timeZone:"America/Los_Angeles"});
      const attemptsToday=Object.values(state.events).filter(d=>d.startAttempted&&new Date(d.block.start).toLocaleDateString("en-CA",{timeZone:"America/Los_Angeles"})===today).length;
      if(attemptsToday>=2){await this.audit(state.conversation,"daily_prompt_budget");await this.save(state);return;}
      const block=blocks.find(b=>now>=b.start&&(b.kind==="open"?b.end-now>=30*60_000:now-b.start<=5*60_000)&&now<b.end&&!state.events[b.key]?.startAttempted);
      if(!block){await this.audit(state.conversation,"no_eligible_opening");await this.save(state);return;}
      const gate=this.deps.evaluate?await this.deps.evaluate(state.conversation,block):{allow:true,message:undefined};
      if(!gate.allow){await this.save(state);return;}
      if(this.deps.evaluate){
        const fresh=(await this.deps.events(this.now())).find(b=>b.key===block.key);
        if(!fresh||fresh.end-this.now()<30*60_000||await this.deps.busy(state.conversation)||(state.quietEnabled===true&&isQuiet(this.now(),state.quietStart,state.quietEnd))){
          await this.audit(state.conversation,"context_changed_before_send");await this.save(state);return;
        }
      }
      state.events[gate.kind==="place"?`place:${now}:${block.key}`:block.key]={block:{...block,start:now},startAttempted:true};
      state.pending={key:block.key,expires:Math.min(block.end,now+10*60_000),...(gate.kind?{kind:gate.kind}:{})};state.lastPrompt=now;
      await this.save(state);
      await this.deps.send(state.conversation,gate.message??(block.kind==="open"
        ?`Your demo calendar has ${Math.floor((block.end-now)/60_000)} free minutes now. Want to start a ${Math.min(45,Math.floor((block.end-now)/60_000))}-minute study session and add it to Hackathon Demo? Reply yes or skip. I'll only follow up if you start.`
        :`Ready for your calendar block “${block.title}”? Reply yes to start a study session and add it to Hackathon Demo, or skip. I'll only follow up if you start.`));
    });
  }
}
