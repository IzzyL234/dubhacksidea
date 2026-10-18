import {decisionTrigger,reserveDecision,failedDecision,signalDigest,type CoordinatorMemory} from "./coordinator-memory.ts";
import {GeminiHttpError} from "./gemini.ts";
import type {LearningSummary} from "./study-options.ts";
import {readdir} from "node:fs/promises";
import type {EventSink} from "./proactivity-store.ts";
import {locationFailureReply,locationFailureKind} from "./photon-location.ts";
import {matchesCampusPlace} from "./uw-buildings.ts";
import {chooseNearby,type NearbyPlace} from "./nearby-places.ts";
import { createHash,randomUUID } from "node:crypto";
import { mkdir,readFile,writeFile,rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localDate,formatTime } from "./time.ts";
import type { LocationSnapshot } from "./photon-location.ts";
import type { StudyBlock } from "./study-events.ts";
import { validateDecision,validateSelectedOption,coordinatorProvider,type DecisionFacts,type PromptDecision } from "./proactive-decision.ts";

const labels=["library","cafe","home","dorm_room","classroom","campus_building"] as const;
type Label=typeof labels[number];
type Place={id?:string;name?:string;label:Label;latitude:number;longitude:number;radius:number};
type Audit={id?:string;context?:DecisionFacts;relatedDecisionId?:string;at:number;action:"stay_quiet"|"offer_study"|"offer_place"|"accepted"|"skipped";reason:string;count:number;place?:Label};
type State={coordinatorMemory?:CoordinatorMemory;recentSamples?:Sample[];signalRegion?:{latitude:number;longitude:number;id:string};arrival?:{place:string;at:number;latitude:number;longitude:number};pendingEvents?:Record<string,Audit>;discovery?:boolean;lookupAfter?:number;lookupDay?:string;lookupCount?:number;candidate?:{place:NearbyPlace;expires:number};dismissed?:string[];enabled:boolean;address?:string;places:Place[];audit:Audit[];outcomes:{at:number;kind:"accepted"|"skipped"}[];
  reviewAfter?:number;modelDay?:string;modelCalls?:number;offer?:{key:string;place:string;expires:number;decisionId?:string;minutes?:number;optionId?:string;region?:{latitude:number;longitude:number;radius:number}}};
type Sample={at:number;latitude:number;longitude:number;place:string};
type RuntimePlace=Omit<Place,"label">&{label:Label|"unknown"};
type Presence={confirmed?:boolean;homeStatus?:"at_saved_home"|"away_from_saved_home"|"unknown";place:RuntimePlace;stableMinutes:number;ageSeconds:number;accuracy:number};
export type Gate={allow:boolean;reason:string;message?:string;kind?:"place"|"checkin";plannedMinutes?:number};
export type SmartDependencies={eventDriven?:boolean;sessionState?:(conversation:string)=>Promise<unknown>;coordinatorPlaces?:boolean;learn?:(conversation:string,place:string,freeMinutes:number)=>Promise<LearningSummary>;events?:EventSink|null;localBuildings?:boolean;lookup?:(point:{latitude:number;longitude:number;accuracy?:number})=>Promise<NearbyPlace[]>;read:(address:string)=>Promise<LocationSnapshot>;decide:(facts:DecisionFacts)=>Promise<PromptDecision>;now?:()=>number};
const keyFor=(s:string)=>createHash("sha256").update(s).digest("hex");
const atPlace=(place:{id?:string;latitude:number;longitude:number;radius?:number},reading:{latitude:number;longitude:number;accuracy:number})=>place.id?.startsWith("uw:")?matchesCampusPlace(place.id,reading):distanceMeters(place,reading)+reading.accuracy<=(place.radius??200);
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
  private async read(key:string):Promise<State>{try{const state=JSON.parse(await readFile(join(this.directory,`${key}.json`),"utf8")) as State;if(this.deps.eventDriven&&!this.samples.has(key))this.samples.set(key,(state.recentSamples??[]).filter(p=>this.now()-p.at<=5*60000&&p.at<=this.now()));return state;}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {enabled:false,places:[],audit:[],outcomes:[]};throw e;}}
  private async save(key:string,state:State){if(this.deps.eventDriven)state.recentSamples=(this.samples.get(key)??[]).filter(p=>this.now()-p.at<=5*60000);for(const a of state.audit){if(!a.id){a.id=randomUUID();(state.pendingEvents??={})[a.id]={...a};}}await mkdir(this.directory,{recursive:true});const path=join(this.directory,`${key}.json`),tmp=`${path}.${randomUUID()}.tmp`;
    await writeFile(tmp,JSON.stringify(state),{mode:0o600});await rename(tmp,path);}
  private log(state:State,action:Audit["action"],reason:string,place?:Label,context?:DecisionFacts,relatedDecisionId?:string):Audit{
    const last=state.audit.at(-1);
    if(last&&last.action===action&&last.reason===reason&&last.place===place&&!context&&!relatedDecisionId&&this.now()-last.at<15*60000){last.count++;last.id??=randomUUID();(state.pendingEvents??={})[last.id]={...last};return last;}
    const audit:Audit={id:randomUUID(),at:this.now(),action,reason,count:1,...(place?{place}:{}),...(context?{context}:{}),...(relatedDecisionId?{relatedDecisionId}:{})};
    state.audit=[...state.audit,audit].slice(-100);(state.pendingEvents??={})[audit.id!]={...audit};return audit;
  }
  async syncPending(limit=20):Promise<number>{
    if(!this.deps.events)return 0;let names:string[]=[];try{names=await readdir(this.directory);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}let uploaded=0;
    for(const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const key=name.slice(0,-5);
      const pending=await this.locked(key,async()=>Object.entries((await this.read(key)).pendingEvents??{}).slice(0,Math.max(0,limit-uploaded)));
      for(const [id,a]of pending){
        await this.deps.events.put({id,user_key:key,reported_at:new Date(a.at).toISOString(),action:a.action,reason:a.reason,occurrence_count:a.count,...(a.place?{place_category:a.place}:{}),...(a.context?{decision_context:a.context}:{}),...(a.relatedDecisionId?{related_decision_id:a.relatedDecisionId}:{})});
        await this.locked(key,async()=>{const state=await this.read(key);if(state.pendingEvents?.[id]?.count===a.count)delete state.pendingEvents[id];await this.save(key,state);});uploaded++;
      }
      if(uploaded>=limit)return uploaded;
    }return uploaded;
  }
  async handle(conversation:string,address:string|undefined,text:string):Promise<string|null>{
    const command=text.trim().toLowerCase().replace(/[.!?]+$/,"");
    if(!/^(remember place(?: .*)?|forget places|smart prompts (?:on|off)|place discovery (?:on|off)|proactivity (?:status|log)|why quiet|where am i|campus location|detect building)$/.test(command))return null;
    const key=keyFor(conversation);
    return this.locked(key,async()=>{
      const state=await this.read(key);let reply:string;
      if(["where am i","campus location","detect building"].includes(command)){
        if(!address||!this.deps.lookup)return "Campus lookup isn't connected.";
        let reading;try{reading=freshReading(await this.deps.read(address),this.now());}catch(error){return locationFailureReply(error);}
        if(!reading)return "Your shared location needs a fresh timestamp and accuracy of 100 meters or better.";
        const places=await this.deps.lookup(reading),place=places.length===1?places[0]:null;
        return place?`Your latest location is near UW's ${place.name}. This is a building estimate; nothing was saved and no session started. Building data: UW Engineering Services.`:"I couldn't identify a clear UW Seattle building from your latest location. GPS may be between buildings or too imprecise.";
      }else if(command.startsWith("remember place")){
        const label=command.slice("remember place ".length) as Label;
        if(!labels.includes(label))return "Use remember place library (or cafe, home, dorm_room, classroom) while physically there.";
        if(!address)return "I couldn't identify your iMessage address.";
        let point;try{point=freshReading(await this.deps.read(address),this.now());}catch(error){return locationFailureReply(error);}
        if(!point)return "I need a location captured within 2 minutes with reported accuracy of 100 meters or better. Wait for a fresh location and try again.";
        state.places=state.places.filter(p=>p.label!==label);state.places.push({label,latitude:point.latitude,longitude:point.longitude,radius:200});
        this.samples.delete(key);delete state.offer;state.reviewAfter=0;
        reply=`Saved your current location as ${label.replaceAll("_"," ")}, using a 200-meter region. Its coordinates stay in your private local place settings. Text smart prompts on to use it, or forget places to remove saved places.`;
      }else if(command==="forget places"){
        state.places=[];delete state.candidate;delete state.offer;this.samples.delete(key);reply="Saved place coordinates removed. The coordinator can still consider stable unconfirmed locations; home proximity is now unknown.";
      }else if(command.startsWith("place discovery ")){state.discovery=command.endsWith("on");if(!state.discovery)delete state.candidate;reply=state.discovery?"UW building discovery is on. Building matching runs locally using UW Engineering Services data. The coordinator may offer studying directly or ask before optionally saving a place.":"Nearby place discovery is off. Building lookups are disabled; the coordinator can still consider an unnamed stable area.";
      }else if(command==="smart prompts on"){
        if(!address)return "I couldn't identify your iMessage address.";
        state.enabled=true;state.discovery??=true;state.address=address;this.samples.delete(key);
        reply=`Smart prompts are on. Saved places: ${state.places.map(p=>p.label).join(", ")||"none—I can recognize UW Seattle buildings for confirmation"}. Fresh, stable location and a calendar opening must pass checks before the coordinator considers a suggestion. UW building recognition runs locally using campus footprints. It does not require a calendar opening. Text place discovery off to disable discovery. Text why quiet for reasons.`;
      }else if(command==="smart prompts off"){
        state.enabled=false;delete state.address;delete state.candidate;delete state.offer;this.samples.delete(key);reply="Smart prompts are off. Saved places remain; use forget places to remove them.";
      }else if(command==="proactivity status"){
        reply=`Smart prompts: ${state.enabled?"on":"off"}. Coordinator: ${coordinatorProvider()}. Learning observations in last evaluated context: ${[...state.audit].reverse().find(a=>a.context?.learning)?.context?.learning?.observations??"not evaluated yet"}. Saved places: ${state.places.map(p=>p.label).join(", ")||"none"}. Checks: location age ≤2 minutes, accuracy ≤100 m, three or more distinct readings spanning 3 minutes in one area; a saved study spot is optional. Text why quiet for recent reasons.`;
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
      const decisionId=state.offer?.decisionId;if(kind==="skipped")state.reviewAfter=this.now()+60*60000;delete state.offer;this.log(state,kind,kind==="skipped"?"user_skipped":"user_confirmed",undefined,undefined,decisionId);await this.save(key,state);});
  }
  private async presence(key:string,state:State):Promise<Presence|string>{
    if(!state.address)return "sender_not_connected";
    let reading;try{reading=freshReading(await this.deps.read(state.address),this.now());}catch(error){this.samples.delete(key);return `location_${locationFailureKind(error)}`;}
    if(!reading){this.samples.set(key,(this.samples.get(key)??[]).filter(sample=>this.now()-sample.at<=5*60000));return "location_stale_or_inaccurate";}
    const place=state.places.find(p=>atPlace(p,reading));
    if(!place)return this.discover(key,state,reading);
    let samples=(this.samples.get(key)??[]).filter(s=>s.place===(place.id??place.label)&&reading.at-s.at<=5*60000&&s.at<=reading.at);
    if(samples.some(s=>distanceMeters(s,reading)>75))samples=[];
    if(!samples.some(s=>s.at===reading.at))samples.push({...reading,place:place.id??place.label});
    samples=samples.slice(-8);this.samples.set(key,samples);
    const span=reading.at-(samples[0]?.at??reading.at);
    if(samples.length<3||span<3*60000)return "waiting_for_distinct_stable_readings";
    return {place,stableMinutes:Math.floor(span/60000),ageSeconds:Math.max(0,Math.round((this.now()-reading.at)/1000)),accuracy:reading.accuracy};
  }
  private async coordinatorPresence(key:string,state:State):Promise<Presence|string>{
    if(!state.address)return "sender_not_connected";
    let reading;try{reading=freshReading(await this.deps.read(state.address),this.now());}catch(error){this.samples.delete(key);return `location_${locationFailureKind(error)}`;}
    if(!reading){this.samples.set(key,(this.samples.get(key)??[]).filter(sample=>this.now()-sample.at<=5*60000));return "location_stale_or_inaccurate";}
    const homes=state.places.filter(p=>p.label==="home"||p.label==="dorm_room");
    const homeStatus=homes.some(p=>atPlace(p,reading))?"at_saved_home":homes.length&&homes.every(p=>distanceMeters(p,reading)-reading.accuracy>p.radius)?"away_from_saved_home":"unknown";
    const saved=state.places.find(p=>atPlace(p,reading));
    if(saved){const result=await this.presence(key,state);return typeof result==="string"?result:{...result,confirmed:true,homeStatus};}
    let samples=(this.samples.get(key)??[]).filter(s=>s.place==="unsaved"&&reading.at-s.at<=5*60000&&s.at<=reading.at);
    if(samples.some(s=>distanceMeters(s,reading)>75))samples=[];
    if(!samples.some(s=>s.at===reading.at))samples.push({...reading,place:"unsaved"});
    samples=samples.slice(-8);this.samples.set(key,samples);
    if(samples.length<3||reading.at-samples[0]!.at<3*60000)return "waiting_for_distinct_stable_readings";
    let place:RuntimePlace={id:"unconfirmed",label:"unknown",latitude:reading.latitude,longitude:reading.longitude,radius:200};
    if(state.candidate&&(state.candidate.expires<this.now()||!atPlace(state.candidate.place,reading)))delete state.candidate;
    if(state.discovery&&this.deps.lookup){
      const day=localDate(this.now());if(state.lookupDay!==day){state.lookupDay=day;state.lookupCount=0;}
      const mayLookup=this.deps.localBuildings||((this.now()>=(state.lookupAfter??0))&&(state.lookupCount??0)<4);
      if(state.candidate){place={...state.candidate.place,radius:200};}
      else if(mayLookup){
        state.lookupCount=(state.lookupCount??0)+1;state.lookupAfter=this.now()+15*60000;
        try{
          const places=await this.deps.lookup(reading);
          const found=places[0]?.id.startsWith("uw:")?(places.length===1?places[0]:null):chooseNearby(places,reading);
          if(found&&atPlace(found,reading)){
            place={...found,radius:200};
            if(!state.dismissed?.includes(found.id))state.candidate={place:found,expires:this.now()+10*60000};
          }
        }catch{/* A missing map label must not fabricate a place or block coordinator reasoning. */}
      }
    }
    return {place,confirmed:false,homeStatus,stableMinutes:Math.floor((reading.at-samples[0]!.at)/60000),ageSeconds:Math.max(0,Math.round((this.now()-reading.at)/1000)),accuracy:reading.accuracy};
  }
  private async discover(key:string,state:State,reading:{latitude:number;longitude:number;accuracy:number;at:number}):Promise<string>{
    if(!state.discovery||!this.deps.lookup){this.samples.delete(key);return "outside_saved_place";}
    let samples=(this.samples.get(key)??[]).filter(s=>s.place==="unknown"&&reading.at-s.at<=5*60000&&s.at<=reading.at);
    if(samples.some(s=>distanceMeters(s,reading)>75))samples=[];
    if(!samples.some(s=>s.at===reading.at))samples.push({...reading,place:"unknown"});
    this.samples.set(key,samples.slice(-8));
    if(samples.length<3||reading.at-samples[0]!.at<3*60000)return "waiting_for_unknown_place_dwell";
    if(!this.deps.localBuildings&&this.now()<(state.lookupAfter??0))return "place_lookup_cooldown";
    const day=localDate(this.now());if(state.lookupDay!==day){state.lookupDay=day;state.lookupCount=0;}
    if(!this.deps.localBuildings&&(state.lookupCount??0)>=4)return "daily_place_lookup_budget";
    state.lookupCount=(state.lookupCount??0)+1;state.lookupAfter=this.now()+15*60000;await this.save(key,state);
    let places:NearbyPlace[];try{places=await this.deps.lookup(reading);}catch{return "nearby_lookup_unavailable";}
    const place=places[0]?.id.startsWith("uw:")?(places.length===1?places[0]:null):chooseNearby(places,reading);
    if(!place||state.dismissed?.includes(place.id)||state.places.some(s=>s.id===place.id)||!atPlace(place,reading))return "no_clear_nearby_study_place";
    state.candidate={place,expires:this.now()+10*60000};this.log(state,"offer_place","confirm_nearby_place",place.label);return "place_confirmation_ready";
  }
  async resolvePlace(conversation:string,accept:boolean):Promise<string>{
    const key=keyFor(conversation);return this.locked(key,async()=>{
      const state=await this.read(key),candidate=state.candidate;
      if(!candidate||candidate.expires<this.now()||!state.enabled){delete state.candidate;await this.save(key,state);return "That place suggestion expired. Nothing was saved.";}
      if(!accept){state.dismissed=[...(state.dismissed??[]),candidate.place.id].slice(-100);state.reviewAfter=this.now()+60*60000;delete state.candidate;await this.save(key,state);return "Skipped that place. I won't suggest it again. No session was started.";}
      let reading;try{reading=state.address?freshReading(await this.deps.read(state.address),this.now()):null;}catch{reading=null;}
      if(!reading||!atPlace(candidate.place,reading)){delete state.candidate;await this.save(key,state);return "Your location changed or isn't fresh enough. Nothing was saved.";}
      state.places=[...state.places.filter(p=>p.id!==candidate.place.id),{...candidate.place,radius:200}].slice(-30);
      delete state.candidate;this.samples.delete(key);this.log(state,"accepted","place_confirmed",candidate.place.label);await this.save(key,state);
      return `Saved “${candidate.place.name}” as a study spot. Future visits will be recognized automatically. No study session was started.`;
    });
  }
  async observe(conversation:string):Promise<Gate>{
    const key=keyFor(conversation);return this.locked(key,async()=>{
      const state=await this.read(key);if(!state.enabled)return {allow:false,reason:"smart_prompts_off"};
      if(this.now()<(state.reviewAfter??0))return {allow:false,reason:"decision_cooldown"};
      const presence=await this.presence(key,state);
      if(presence==="place_confirmation_ready"&&state.candidate){await this.save(key,state);return this.placeQuestion(state.candidate.place);}
      const reason=typeof presence==="string"?presence:"known_place_ready";this.log(state,"stay_quiet",reason);await this.save(key,state);return {allow:false,reason};
    });
  }
  private placeQuestion(place:NearbyPlace):Gate{return {allow:true,kind:"place",reason:"confirm_nearby_place",message:`Looks like you're near “${place.name}”. Save this as a study spot? Reply yes or skip. ${place.id.startsWith("uw:")?"Building data: UW Engineering Services.":"Nearby names: OpenStreetMap."} I can't tell whether you're inside.`};}
  async evaluate(conversation:string,block?:StudyBlock,calendarAvailable=true):Promise<Gate>{
    const key=keyFor(conversation);return this.locked(key,async()=>{
      const state=await this.read(key);if(!state.enabled)return {allow:true,reason:"calendar_only"};
      const quiet=async(reason:string,context?:DecisionFacts):Promise<Gate>=>{this.log(state,"stay_quiet",reason,undefined,context);await this.save(key,state);return{allow:false,reason};};
      if(!this.deps.coordinatorPlaces&&!state.places.length&&(!state.discovery||!this.deps.lookup))return quiet("no_saved_places");
      if(state.candidate&&state.candidate.expires<this.now())delete state.candidate;
      if(!this.deps.eventDriven&&this.now()<(state.reviewAfter??0))return quiet("decision_cooldown");
      const presence=this.deps.coordinatorPlaces?await this.coordinatorPresence(key,state):await this.presence(key,state);if(typeof presence==="string"){
        if(presence==="place_confirmation_ready"&&state.candidate){await this.save(key,state);return this.placeQuestion(state.candidate.place);}
        return quiet(presence);
      }
      const freeMinutes=block?Math.max(0,Math.floor((block.end-this.now())/60000)):0;if(!this.deps.coordinatorPlaces&&freeMinutes<30)return quiet("not_enough_open_time");
      const day=localDate(this.now());if(state.modelDay!==day){state.modelDay=day;state.modelCalls=0;}
      if(!this.deps.eventDriven){
        if((state.modelCalls??0)>=4)return quiet("daily_model_budget");
        state.modelCalls=(state.modelCalls??0)+1;state.reviewAfter=this.now()+10*60000;
        await this.save(key,state);
      }
      const recent=state.outcomes.filter(o=>this.now()-o.at<24*3600_000);
      const facts:DecisionFacts={place:presence.place.label,stableMinutes:presence.stableMinutes,
        locationAgeSeconds:presence.ageSeconds,accuracyMeters:presence.accuracy,freeMinutes,plannedMinutes:Math.min(45,freeMinutes),
        ...(this.deps.coordinatorPlaces?{placeEvidence:{confirmed:presence.confirmed===true,homeStatus:presence.homeStatus??"unknown",canSave:presence.confirmed===false&&!!state.candidate,calendarAvailable,matchedBuilding:presence.place.label!=="unknown",arrivalCheckInEligible:presence.homeStatus!=="at_saved_home"&&(!state.arrival||this.now()-state.arrival.at>6*3600000||distanceMeters(state.arrival,presence.place)>200)}}:{}),
        acceptedRecently:recent.filter(o=>o.kind==="accepted").length,skippedRecently:recent.filter(o=>o.kind==="skipped").length};
      if(this.deps.learn){
        try{facts.learning=await this.deps.learn(conversation,presence.place.label,freeMinutes);}
        catch{return quiet("learning_context_unavailable",facts);}
      }
      if(this.deps.eventDriven){
        let sessionState:unknown;try{sessionState=await this.deps.sessionState?.(conversation);}catch{return quiet("session_state_unavailable");}
        const region=state.signalRegion;
        if(!region||distanceMeters(region,presence.place)>200)state.signalRegion={latitude:presence.place.latitude,longitude:presence.place.longitude,id:randomUUID()};
        const signals={place:signalDigest({region:state.signalRegion!.id,id:presence.place.id,home:presence.homeStatus,arrival: facts.placeEvidence?.arrivalCheckInEligible}),calendar:signalDigest({available:calendarAvailable,key:block?.key,start:block?.start,end:block?.end,freeBucket:Math.floor(freeMinutes/15)}),learning:signalDigest({observations:facts.learning?.observations,cloudUnavailable:facts.learning?.cloudUnavailable,rankings:facts.learning?.options.map(o=>({id:o.id,minutesBucket:Math.floor(o.minutes/5),productivity:o.predictedProductivity===null?null:Math.round(o.predictedProductivity*10)/10,mood:o.predictedMood===null?null:Math.round(o.predictedMood*10)/10,count:o.relevantSessions})),notes:facts.learning?.sessionContext}),session:signalDigest({sessionState,outcomes:state.outcomes}),preferences:signalDigest({discovery:state.discovery,places:state.places.map(p=>({id:p.id,label:p.label}))})};
        const memory=state.coordinatorMemory??={};const trigger=decisionTrigger(memory,signals,this.now(),day);
        if(!trigger.allow)return quiet(trigger.reason);
        facts.triggers=trigger.triggers;facts.sessionState=sessionState;
        reserveDecision(memory,signals,this.now(),day);await this.save(key,state);
      }
      let decision:PromptDecision;
      try{decision=validateSelectedOption(validateDecision(await this.deps.decide(facts)),facts);}
      catch(error){if(this.deps.eventDriven){const memory=state.coordinatorMemory??={};failedDecision(memory,this.now(),error instanceof GeminiHttpError&&error.status===429?(error.retryMs??3600000):undefined);}return quiet("model_unavailable_or_invalid",facts);}
      if(this.deps.eventDriven&&state.coordinatorMemory){state.coordinatorMemory.failures=0;delete state.coordinatorMemory.retryAfter;}
      if(decision.action==="stay_quiet"||decision.confidence<0.75)return quiet(`model_${decision.reason}`,facts);
      let latestReading;try{latestReading=freshReading(await this.deps.read(state.address!),this.now());}catch{return quiet("location_changed_during_decision",facts);}
      if(!latestReading||!atPlace(presence.place,latestReading))return quiet("location_changed_during_decision",facts);
      if(decision.action==="check_in"){
        state.arrival={place:presence.place.id??presence.place.label,at:this.now(),latitude:presence.place.latitude,longitude:presence.place.longitude};
        this.log(state,"stay_quiet","arrival_checkin_reserved",undefined,facts);await this.save(key,state);
        const name=presence.place.name;
        return {allow:true,reason:"arrival_checkin",kind:"checkin",message:name?`Your location suggests you're near ${name}. What are you working on?`:`It looks like you've settled in one area. What are you working on?`};
      }
      if(decision.action==="ask_place"){
        if(!state.candidate)return quiet("place_candidate_unavailable",facts);
        this.log(state,"offer_place","coordinator_place_question",state.candidate.place.label,facts);await this.save(key,state);
        return this.placeQuestion(state.candidate.place);
      }
      if(!block)return quiet("no_current_calendar_opening",facts);
      const option=facts.learning?.options.find(o=>o.id===decision.optionId);
      const minutes=option?.minutes??Math.min(45,freeMinutes);
      const basis=option?.basis==="historical"?` Your past ${presence.place.label.replaceAll("_"," ")} ${option.studySpace!.replaceAll("_"," ")} setup predicts productivity ${option.predictedProductivity!.toFixed(1)}/5 and mood ${option.predictedMood!.toFixed(1)}/5, based on ${option.relevantSessions} matching session(s). Today's workspace may differ.`:facts.learning?" I don't have a matching personal workspace history yet.":"";
      state.offer={region:{latitude:presence.place.latitude,longitude:presence.place.longitude,radius:200},minutes,...(option?{optionId:option.id}:{}),key:block.key,place:presence.place.id??presence.place.label,expires:this.now()+10*60000};const audit=this.log(state,"offer_study",decision.reason,presence.place.label==="unknown"?undefined:presence.place.label,facts);state.offer.decisionId=audit.id;await this.save(key,state);
      return {allow:true,reason:decision.reason,plannedMinutes:minutes,message:`${presence.confirmed===false?(presence.place.name?"Your fresh location readings suggest you are staying near a detected building":"Your fresh location readings suggest you have stayed in one area"):"You have stayed near your saved "+presence.place.label.replaceAll("_"," ")+" spot"} and your demo calendar has ${freeMinutes} free minutes.${basis} Want to start up to a ${minutes}-minute study session and add it to Hackathon Demo? Reply yes or skip.`};
    });
  }
  async refreshPresence(conversation:string):Promise<void>{
    if(!this.deps.eventDriven)return;const key=keyFor(conversation);await this.locked(key,async()=>{const state=await this.read(key);if(!state.enabled)return;await this.coordinatorPresence(key,state);await this.save(key,state);});
  }
  async confirm(conversation:string,block:StudyBlock):Promise<boolean>{
    const key=keyFor(conversation);return this.locked(key,async()=>{
      const state=await this.read(key);if(!state.enabled)return true;
      if(!state.offer||state.offer.key!==block.key||state.offer.expires<this.now())return false;
      const presence=this.deps.coordinatorPlaces?await this.coordinatorPresence(key,state):await this.presence(key,state);
      const valid=typeof presence!=="string"&&(presence.place.id??presence.place.label)===state.offer.place&&(!state.offer.region||distanceMeters(state.offer.region,presence.place)<100);
      if(!valid){this.log(state,"stay_quiet","location_changed_before_confirmation");await this.save(key,state);}
      return valid;
    });
  }
}
