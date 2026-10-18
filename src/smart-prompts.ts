import {chooseNearby,type NearbyPlace} from "./nearby-places.ts";
import { createHash,randomUUID } from "node:crypto";
import { mkdir,readFile,writeFile,rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localDate,formatTime } from "./time.ts";
import type { LocationSnapshot } from "./photon-location.ts";
import type { StudyBlock } from "./study-events.ts";
import { validateDecision,type DecisionFacts,type PromptDecision } from "./proactive-decision.ts";

const labels=["library","cafe","home","dorm_room","classroom"] as const;
type Label=typeof labels[number];
type Place={id?:string;name?:string;label:Label;latitude:number;longitude:number;radius:number};
type Audit={at:number;action:"stay_quiet"|"offer_study"|"offer_place"|"accepted"|"skipped";reason:string;count:number;place?:Label};
type State={discovery?:boolean;lookupAfter?:number;lookupDay?:string;lookupCount?:number;candidate?:{place:NearbyPlace;expires:number};dismissed?:string[];enabled:boolean;address?:string;places:Place[];audit:Audit[];outcomes:{at:number;kind:"accepted"|"skipped"}[];
  reviewAfter?:number;modelDay?:string;modelCalls?:number;offer?:{key:string;place:string;expires:number}};
type Sample={at:number;latitude:number;longitude:number;place:string};
type Presence={place:Place;stableMinutes:number;ageSeconds:number;accuracy:number};
export type Gate={allow:boolean;reason:string;message?:string;kind?:"place"};
export type SmartDependencies={lookup?:(point:{latitude:number;longitude:number})=>Promise<NearbyPlace[]>;read:(address:string)=>Promise<LocationSnapshot>;decide:(facts:DecisionFacts)=>Promise<PromptDecision>;now?:()=>number};
const keyFor=(s:string)=>createHash("sha256").update(s).digest("hex");
const timestamp=(value:string|Date|undefined)=>value instanceof Date?value.getTime():value?Date.parse(value):NaN;
export function distanceMeters(a:{latitude:number;longitude:number},b:{latitude:number;longitude:number}):number {
  const rad=Math.PI/180,dLat=(b.latitude-a.latitude)*rad,dLon=(b.longitude-a.longitude)*rad;
  const x=Math.sin(dLat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dLon/2)**2;
  return 6371000*2*Math.asin(Math.min(1,Math.sqrt(x)));
}
export function freshReading(s:LocationSnapshot,now:number):{latitude:number;longitude:number;accuracy:number;at:number}|null {
  const at=timestamp(s.locationTimestamp),expires=timestamp(s.expiresAt);
  if(!Number.isFinite(s.latitude)||!Number.isFinite(s.longitude)||Math.abs(s.latitude!)>90||Math.abs(s.longitude!)>180
    ||!Number.isFinite(at)||now-at>120000||at-now>30000||s.isLocatingInProgress
    ||!["live","shallow"].includes(s.locationType)||!Number.isFinite(s.accuracy)||s.accuracy!<=0||s.accuracy!>100
    ||(Number.isFinite(expires)&&expires<=now))return null;
  return {latitude:s.latitude!,longitude:s.longitude!,accuracy:s.accuracy!,at};
}
export class SmartPrompts {
  private samples=new Map<string,Sample[]>();
  private locks=new Map<string,Promise<unknown>>();
  private now:()=>number;
  constructor(private deps:SmartDependencies,private directory=fileURLToPath(new URL("../data/proactivity/",import.meta.url))){this.now=deps.now??Date.now;}
  private async locked<T>(key:string,action:()=>Promise<T>):Promise<T>{
    const before=this.locks.get(key)??Promise.resolve();const next=before.catch(()=>{}).then(action);this.locks.set(key,next);
    try{return await next;}finally{if(this.locks.get(key)===next)this.locks.delete(key);}
  }
  private async read(key:string):Promise<State>{try{return JSON.parse(await readFile(join(this.directory,`${key}.json`),"utf8"));}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {enabled:false,places:[],audit:[],outcomes:[]};throw e;}}
  private async save(key:string,state:State){await mkdir(this.directory,{recursive:true});const path=join(this.directory,`${key}.json`),tmp=`${path}.${randomUUID()}.tmp`;
    await writeFile(tmp,JSON.stringify(state),{mode:0o600});await rename(tmp,path);}
  private log(state:State,action:Audit["action"],reason:string,place?:Label){
    const last=state.audit.at(-1);if(last&&last.action===action&&last.reason===reason&&last.place===place&&this.now()-last.at<15*60000){last.count++;return;}
    state.audit=[...state.audit,{at:this.now(),action,reason,count:1,...(place?{place}:{})}].slice(-100);
  }
  async handle(conversation:string,address:string|undefined,text:string):Promise<string|null>{
    const command=text.trim().toLowerCase();
    if(!/^(remember place(?: .*)?|forget places|smart prompts (?:on|off)|place discovery (?:on|off)|proactivity (?:status|log)|why quiet)$/.test(command))return null;
    const key=keyFor(conversation);
    return this.locked(key,async()=>{
      const state=await this.read(key);let reply:string;
      if(command.startsWith("remember place")){
        const label=command.slice("remember place ".length) as Label;
        if(!labels.includes(label))return "Use remember place library (or cafe, home, dorm_room, classroom) while physically there.";
        if(!address)return "I couldn't identify your iMessage address.";
        let point;try{point=freshReading(await this.deps.read(address),this.now());}catch{return "I couldn't read your shared location. Check live location status first.";}
        if(!point)return "I need a location captured within 2 minutes with reported accuracy of 100 meters or better. Wait for a fresh location and try again.";
        state.places=state.places.filter(p=>p.label!==label);state.places.push({label,latitude:point.latitude,longitude:point.longitude,radius:200});
        this.samples.delete(key);delete state.offer;state.reviewAfter=0;
        reply=`Saved your current location as ${label.replaceAll("_"," ")}, using a 200-meter region. Its coordinates stay in your private local place settings. Text smart prompts on to use it, or forget places to remove saved places.`;
      }else if(command==="forget places"){
        state.places=[];delete state.candidate;delete state.offer;this.samples.delete(key);reply="Saved place coordinates removed. Smart suggestions will stay quiet until you save a place again.";
      }else if(command.startsWith("place discovery ")){state.discovery=command.endsWith("on");if(!state.discovery)delete state.candidate;reply=state.discovery?"Nearby place discovery is on. Approximate coordinates are sent to OpenStreetMap Overpass to look up libraries and cafes. I ask before saving a place.":"Nearby place discovery is off. Only your saved places will be used.";
      }else if(command==="smart prompts on"){
        if(!address)return "I couldn't identify your iMessage address.";
        state.enabled=true;state.discovery??=true;state.address=address;this.samples.delete(key);
        reply=`Smart prompts are on. Saved places: ${state.places.map(p=>p.label).join(", ")||"none—I can suggest a nearby library or cafe for confirmation"}. Fresh, stable location and a calendar opening must pass checks before Grok considers a suggestion. Nearby discovery sends approximate coordinates to OpenStreetMap Overpass; text place discovery off to disable it. Text why quiet for reasons.`;
      }else if(command==="smart prompts off"){
        state.enabled=false;delete state.address;delete state.candidate;delete state.offer;this.samples.delete(key);reply="Smart prompts are off. Saved places remain; use forget places to remove them.";
      }else if(command==="proactivity status"){
        reply=`Smart prompts: ${state.enabled?"on":"off"}. Saved places: ${state.places.map(p=>p.label).join(", ")||"none"}. Checks: location age ≤2 minutes, accuracy ≤100 m, three or more distinct readings spanning 3 minutes near a saved place. Text why quiet for recent reasons.`;
      }else reply=state.audit.length?"Recent proactive decisions:\n"+state.audit.slice(-5).map(a=>`${formatTime(a.at)}: ${a.action} — ${a.reason}${a.count>1?` (${a.count} checks)`:""}`).join("\n"):"No decisions logged yet. Smart prompts must be on, reminders enabled, and the bot running.";
      await this.save(key,state);return reply;
    });
  }
  async audit(conversation:string,reason:string):Promise<void>{
    const key=keyFor(conversation);await this.locked(key,async()=>{const state=await this.read(key);if(!state.enabled)return;this.log(state,"stay_quiet",reason);await this.save(key,state);});
  }
  async outcome(conversation:string,kind:"accepted"|"skipped"):Promise<void>{
    const key=keyFor(conversation);await this.locked(key,async()=>{const state=await this.read(key);if(!state.enabled)return;
      state.outcomes=[...state.outcomes.filter(o=>this.now()-o.at<7*86400_000),{at:this.now(),kind}].slice(-50);
      if(kind==="skipped")state.reviewAfter=this.now()+60*60000;delete state.offer;this.log(state,kind,kind==="skipped"?"user_skipped":"user_confirmed");await this.save(key,state);});
  }
  private async presence(key:string,state:State):Promise<Presence|string>{
    if(!state.address)return "sender_not_connected";
    let reading;try{reading=freshReading(await this.deps.read(state.address),this.now());}catch{this.samples.delete(key);return "location_unavailable";}
    if(!reading){this.samples.delete(key);return "location_stale_or_inaccurate";}
    const place=state.places.find(p=>distanceMeters(p,reading)+reading.accuracy<=p.radius);
    if(!place)return this.discover(key,state,reading);
    let samples=(this.samples.get(key)??[]).filter(s=>s.place===(place.id??place.label)&&reading.at-s.at<=5*60000&&s.at<=reading.at);
    if(samples.some(s=>distanceMeters(s,reading)>75))samples=[];
    if(!samples.some(s=>s.at===reading.at))samples.push({...reading,place:place.id??place.label});
    samples=samples.slice(-8);this.samples.set(key,samples);
    const span=reading.at-(samples[0]?.at??reading.at);
    if(samples.length<3||span<3*60000)return "waiting_for_distinct_stable_readings";
    return {place,stableMinutes:Math.floor(span/60000),ageSeconds:Math.max(0,Math.round((this.now()-reading.at)/1000)),accuracy:reading.accuracy};
  }
  private async discover(key:string,state:State,reading:{latitude:number;longitude:number;accuracy:number;at:number}):Promise<string>{
    if(!state.discovery||!this.deps.lookup){this.samples.delete(key);return "outside_saved_place";}
    let samples=(this.samples.get(key)??[]).filter(s=>s.place==="unknown"&&reading.at-s.at<=5*60000&&s.at<=reading.at);
    if(samples.some(s=>distanceMeters(s,reading)>75))samples=[];
    if(!samples.some(s=>s.at===reading.at))samples.push({...reading,place:"unknown"});
    this.samples.set(key,samples.slice(-8));
    if(samples.length<3||reading.at-samples[0]!.at<3*60000)return "waiting_for_unknown_place_dwell";
    if(this.now()<(state.lookupAfter??0))return "place_lookup_cooldown";
    const day=localDate(this.now());if(state.lookupDay!==day){state.lookupDay=day;state.lookupCount=0;}
    if((state.lookupCount??0)>=4)return "daily_place_lookup_budget";
    state.lookupCount=(state.lookupCount??0)+1;state.lookupAfter=this.now()+15*60000;await this.save(key,state);
    let places:NearbyPlace[];try{places=await this.deps.lookup(reading);}catch{return "nearby_lookup_unavailable";}
    const place=chooseNearby(places,reading);
    if(!place||state.dismissed?.includes(place.id)||state.places.some(s=>s.id===place.id)||distanceMeters(place,reading)+reading.accuracy>200)return "no_clear_nearby_study_place";
    state.candidate={place,expires:this.now()+10*60000};this.log(state,"offer_place","confirm_nearby_place",place.label);return "place_confirmation_ready";
  }
  async resolvePlace(conversation:string,accept:boolean):Promise<string>{
    const key=keyFor(conversation);return this.locked(key,async()=>{
      const state=await this.read(key),candidate=state.candidate;
      if(!candidate||candidate.expires<this.now()||!state.enabled){delete state.candidate;await this.save(key,state);return "That place suggestion expired. Nothing was saved.";}
      if(!accept){state.dismissed=[...(state.dismissed??[]),candidate.place.id].slice(-100);state.reviewAfter=this.now()+60*60000;delete state.candidate;await this.save(key,state);return "Skipped that place. I won't suggest it again. No session was started.";}
      let reading;try{reading=state.address?freshReading(await this.deps.read(state.address),this.now()):null;}catch{reading=null;}
      if(!reading||distanceMeters(reading,candidate.place)+reading.accuracy>200){delete state.candidate;await this.save(key,state);return "Your location changed or isn't fresh enough. Nothing was saved.";}
      state.places=[...state.places.filter(p=>p.id!==candidate.place.id),{...candidate.place,radius:200}].slice(-30);
      delete state.candidate;this.samples.delete(key);this.log(state,"accepted","place_confirmed",candidate.place.label);await this.save(key,state);
      return `Saved “${candidate.place.name}” as a study spot. Future visits will be recognized automatically. No study session was started.`;
    });
  }
  async evaluate(conversation:string,block:StudyBlock):Promise<Gate>{
    const key=keyFor(conversation);return this.locked(key,async()=>{
      const state=await this.read(key);if(!state.enabled)return {allow:true,reason:"calendar_only"};
      const quiet=async(reason:string):Promise<Gate>=>{this.log(state,"stay_quiet",reason);await this.save(key,state);return{allow:false,reason};};
      if(!state.places.length&&(!state.discovery||!this.deps.lookup))return quiet("no_saved_places");
      if(state.candidate&&state.candidate.expires<this.now())delete state.candidate;
      if(this.now()<(state.reviewAfter??0))return quiet("decision_cooldown");
      const presence=await this.presence(key,state);if(typeof presence==="string"){
        if(presence==="place_confirmation_ready"&&state.candidate){await this.save(key,state);return {allow:true,kind:"place",reason:"confirm_nearby_place",message:`Looks like you're near “${state.candidate.place.name}”. Save this as a study spot? Reply yes or skip. Nearby names are from OpenStreetMap; I can't tell whether you're inside.`};}
        return quiet(presence);
      }
      const freeMinutes=Math.floor((block.end-this.now())/60000);if(freeMinutes<30)return quiet("not_enough_open_time");
      const day=localDate(this.now());if(state.modelDay!==day){state.modelDay=day;state.modelCalls=0;}
      if((state.modelCalls??0)>=4)return quiet("daily_model_budget");
      state.modelCalls=(state.modelCalls??0)+1;state.reviewAfter=this.now()+10*60000;
      await this.save(key,state); // Reserve the model budget before an external call.
      const recent=state.outcomes.filter(o=>this.now()-o.at<24*3600_000);
      let decision:PromptDecision;
      try{decision=validateDecision(await this.deps.decide({place:presence.place.label,stableMinutes:presence.stableMinutes,
        locationAgeSeconds:presence.ageSeconds,accuracyMeters:presence.accuracy,freeMinutes,plannedMinutes:Math.min(45,freeMinutes),
        acceptedRecently:recent.filter(o=>o.kind==="accepted").length,skippedRecently:recent.filter(o=>o.kind==="skipped").length}));}
      catch{return quiet("model_unavailable_or_invalid");}
      if(decision.action!=="offer_study"||decision.confidence<0.75)return quiet(`model_${decision.reason}`);
      state.offer={key:block.key,place:presence.place.id??presence.place.label,expires:this.now()+10*60000};this.log(state,"offer_study",decision.reason,presence.place.label);await this.save(key,state);
      return {allow:true,reason:decision.reason,message:`You've stayed near your saved ${presence.place.label.replaceAll("_"," ")} spot and your demo calendar has ${freeMinutes} free minutes. Want a ${Math.min(45,freeMinutes)}-minute study session? Reply yes or skip.`};
    });
  }
  async confirm(conversation:string,block:StudyBlock):Promise<boolean>{
    const key=keyFor(conversation);return this.locked(key,async()=>{
      const state=await this.read(key);if(!state.enabled)return true;
      if(!state.offer||state.offer.key!==block.key||state.offer.expires<this.now())return false;
      const presence=await this.presence(key,state);
      const valid=typeof presence!=="string"&&(presence.place.id??presence.place.label)===state.offer.place;
      if(!valid){this.log(state,"stay_quiet","location_changed_before_confirmation");await this.save(key,state);}
      return valid;
    });
  }
}
