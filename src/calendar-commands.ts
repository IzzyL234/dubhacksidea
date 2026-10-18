import { createHash,randomUUID } from "node:crypto";
import { mkdir,readFile,writeFile,rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { CalendarGateway,DemoEvent,EventInput } from "./calendar-types.ts";
import { formatTime,parseCalendarTime,TIMEZONE } from "./time.ts";
type State={listedAt?:number;events:DemoEvent[];replies:{id:string;reply:string}[]};
export class CalendarCommands {
  private locks=new Map<string,Promise<unknown>>();
  constructor(private gateway:CalendarGateway,private directory=fileURLToPath(new URL("../data/calendar-commands/",import.meta.url)),private now=Date.now){}
  async handle(conversation:string,text:string,messageId:string):Promise<string|null>{
    const command=text.trim();
    if(!/^(calendar events|calendar help|add event(?:\s|$)|move event(?:\s|$)|rename event(?:\s|$))/i.test(command))return null;
    // Serialize each chat's read/write cycle, including replay checks and external writes.
    // Separate chats remain independent, and rejected requests do not poison the queue.
    const previous=this.locks.get(conversation)??Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>this.handleSerialized(conversation,text,messageId));
    this.locks.set(conversation,next);
    try{return await next;}
    finally{if(this.locks.get(conversation)===next)this.locks.delete(conversation);}
  }
  private async handleSerialized(conversation:string,text:string,messageId:string):Promise<string|null>{
    const command=text.trim();
    const path=join(this.directory,`${createHash("sha256").update(conversation).digest("hex")}.json`);
    await mkdir(this.directory,{recursive:true});let state:State={events:[],replies:[]};
    try{state=JSON.parse(await readFile(path,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    const old=state.replies.find(r=>r.id===messageId);if(old)return old.reply;
    let reply:string;
    try{
      if(/^calendar events$/i.test(command)){
        state.events=(await this.gateway.list(this.now(),this.now()+7*86400_000)).filter(e=>e.id&&e.status!=="cancelled").slice(0,20);state.listedAt=this.now();
        reply=state.events.length?"Hackathon Demo — next 7 days (Pacific):\n"+state.events.map((e,i)=>`${i+1}. ${e.summary??"Untitled"} — ${e.start?.dateTime?formatTime(Date.parse(e.start.dateTime)):e.start?.date+" (all day)"}`).join("\n"):"No events in Hackathon Demo in the next 7 days.";
      }else if(/^calendar help$/i.test(command))reply="I can add and edit Hackathon Demo events. Use calendar events for numbered events.\nadd event Study math | YYYY-MM-DD 14:00 | YYYY-MM-DD 14:45\nmove event 2 | YYYY-MM-DD 15:00 | YYYY-MM-DD 15:45\nrename event 2 | New title\nTimes are Pacific. Changes happen when you send the command.";
      else{
        const pieces=command.split("|").map(p=>p.trim());
        const add=pieces[0]?.match(/^add event (.+)$/i),move=pieces[0]?.match(/^move event (\d+)$/i),rename=pieces[0]?.match(/^rename event (\d+)$/i);
        const range=():Pick<EventInput,"start"|"end">=>{
          if(pieces.length!==3)throw Error("Use two dates/times separated by |. Text calendar help for examples.");
          const start=parseCalendarTime(pieces[1]!),end=parseCalendarTime(pieces[2]!);
          if(start<this.now()||end<=start||end-start>24*3600_000)throw Error("Use a future start and a later end, up to 24 hours apart.");
          return {start:{dateTime:new Date(start).toISOString(),timeZone:TIMEZONE},end:{dateTime:new Date(end).toISOString(),timeZone:TIMEZONE}};
        };
        if(add){
          const title=add[1]!.trim();if(title.length>160)throw Error("Use a title under 160 characters.");
          const requestKey=createHash("sha256").update(`${conversation}:${messageId}`).digest("hex");
          const created=await this.gateway.create({id:"agent"+requestKey.slice(0,40),summary:title,...range(),reminders:{useDefault:false},extendedProperties:{private:{studyAgentRequest:requestKey}}});
          reply=`Added “${created.summary??title}” to Hackathon Demo. Text calendar events to see it.`;
        }else if(move||rename){
          if(state.listedAt===undefined||this.now()-state.listedAt>15*60000)throw Error("Text calendar events first so I can identify which event you mean.");
          const selected=state.events[Number((move??rename)![1])-1];
          if(!selected?.id||!selected.etag)throw Error("Choose a number from your most recent calendar events list.");
          const fresh=await this.gateway.get(selected.id);
          if(fresh.status==="cancelled"||fresh.etag!==selected.etag)throw Error("That event changed. Text calendar events to refresh before editing it.");
          if(fresh.attendees?.length)throw Error("This demo editor supports events without guests. Use Google Calendar for this event.");
          let change:Partial<EventInput>;
          if(move)change=range();
          else{if(pieces.length!==2||!pieces[1]||pieces[1].length>160)throw Error("Use rename event 2 | New title (up to 160 characters).");change={summary:pieces[1]};}
          const updated=await this.gateway.patch(selected.id,selected.etag,change);
          reply=`Updated “${updated.summary??fresh.summary??"event"}” in Hackathon Demo. Text calendar events to refresh your list.`;
        }else throw Error("Text calendar help for add, move, and rename examples.");
      }
    }catch(e){
      const code=(e as {response?:{status?:number}}).response?.status;
      const message=e instanceof Error?e.message:"";
      if(message==="CALENDAR_WRITE_AUTH_REQUIRED"||code===403)reply="Calendar editing needs Google authorization. Run bun calendar-write-auth.mjs in your project terminal, then retry this command.";
      else if(code===412)reply="That event changed during editing. Text calendar events to refresh before trying again.";
      else if(code)throw Error("Calendar request failed");
      else if(message.startsWith("Use ")||message.startsWith("Text ")||message.startsWith("Choose ")||message.startsWith("That ")||message.startsWith("This demo"))return message;
      else throw e;
      // Do not cache failed write attempts: retry must work after authorization or a transient error.
      return reply;
    }
    state.replies=[...state.replies,{id:messageId,reply}].slice(-40);
    const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,path);return reply;
  }
}

