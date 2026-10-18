import {photoAttachment} from "./photo-input.ts";
export function isStudyRecommendation(text:string):boolean {
 return /(?:where (?:should|can|could|would) (?:i|we) (?:go (?:to )?)?study|where (?:do you|would you) (?:suggest|recommend).*study|(?:recommend|suggest|find|pick).*(?:study (?:spot|space|location)|place to study)|best (?:place|spot) (?:for me )?to study)/i.test(text);
}
import {studyOptions,type LearningSummary} from "./study-options.ts";
import {bookStudyEvent,logCompletedStudy,bookingFailure,type StudyBooking} from "./study-calendar.ts";
import type {CalendarGateway} from "./calendar-types.ts";
import {configuredLearningStore,type StudyHistorySource,type LearningPair} from "./learning-store.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { features, LOCATIONS, SPACES, train, type SerializedModelState, type Context } from "./learning.ts";
import { analyzePhoto, validateWorkspace, type Workspace } from "./vision.ts";
import type { SessionFeedback } from "./feedback.ts";

export type StudySession = {
  id: string; user_id: string; started_at: string; ended_at: string | null;
  duration_mins: number | null; location: Context["location"] | null; study_space: Context["study_space"] | null;
  environment: Partial<Workspace>; environment_source: "perceptron" | "self_report" | "mixed" | null;
  status: "active" | "awaiting_feedback" | "completed" | "canceled";
  feedback_id: string | null; is_synthetic: false;
  starting_energy?: number | null;
  starting_noise?: "quiet" | "moderate" | "loud" | "unknown" | null;
  starting_context_at?: string | null;
};
export type PhotoLogEntry = {
  id: string;
  user_id?: string;
  session_id: string | null;
  timestamp: string;
  location: Context["location"] | null;
  study_space: Context["study_space"] | null;
  duration_mins: number | null;
  perceptron_tags: Workspace;
  source: "perceptron";
};

type Document = { energyAsked?:string[];energyQuestion?:{sessionId:string;expires:number}; calendarBookings?:Record<string,StudyBooking>; sessions: StudySession[]; replies: { id: string; text: string }[] };
export interface SessionSink {
  put(session: StudySession): Promise<void>;
  putPhotoLog?(entry: PhotoLogEntry): Promise<void>;
  getModelParams?(userId: string): Promise<SerializedModelState | null>;
  putModelParams?(state: SerializedModelState): Promise<void>;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function observationWeight(feedback: SessionFeedback): number {
  if (feedback.distraction_rating < 4) return 1;
  if (feedback.distraction_attribution === "interruption") return 0.25;
  // Unknown is kept unknown; no causal correction is inferred. Both setup and unsure
  // retain ordinary weight. Preserve the legacy rule only for older records.
  if (feedback.distraction_attribution != null) return 1;
  return feedback.distraction_rating >= 4 && ["phone", "other"].includes(feedback.distraction_source ?? "") ? 0.25 : 1;
}
export function sessionContext(session: StudySession): Context | null {
  const context = { timestamp: session.started_at, duration_mins: session.duration_mins,
    location: session.location, study_space: session.study_space, environment: session.environment } as Context;
  try { features(context); return context; } catch { return null; }
}
export class SupabaseSessions implements SessionSink {
  constructor(private url: string, private key: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co") || !key.startsWith("sb_secret_")) throw new Error("Invalid Supabase settings");
    this.url = parsed.origin;
  }
  async put(session: StudySession) {
    const result = await fetch(`${this.url}/rest/v1/study_sessions?on_conflict=id`, {
      method: "POST", headers: { apikey: this.key, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(session), redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!result.ok) throw new Error(`Session upload failed (HTTP ${result.status}); run supabase/004_session_lifecycle.sql`);
  }
  async putPhotoLog(entry: PhotoLogEntry) {
    if(!entry.location||!entry.study_space||entry.duration_mins===null)return;
    const loc = entry.location;
    const sp = entry.study_space;
    const body = {
      id: entry.id,
      user_id: entry.user_id ?? "default_user",
      session_id: entry.session_id,
      timestamp: entry.timestamp,
      duration_mins: entry.duration_mins,
      location: loc,
      study_space: sp,
      location_class: `${loc}_${sp}`,
      peceptron_tags: entry.perceptron_tags,
      linucb_metrics: {},
      source: entry.source,
    };
    await fetch(`${this.url}/rest/v1/workspace_photos_log?on_conflict=id`, {
      method: "POST",
      headers: { apikey: this.key, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
  async getModelParams(userId: string): Promise<SerializedModelState | null> {
    try {
      const res = await fetch(`${this.url}/rest/v1/user_model_params?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`, {
        headers: { apikey: this.key },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const rows = (await res.json()) as SerializedModelState[];
      return Array.isArray(rows) && rows.length > 0 ? rows[0]! : null;
    } catch {
      return null;
    }
  }
  async putModelParams(state: SerializedModelState): Promise<void> {
    await fetch(`${this.url}/rest/v1/user_model_params?on_conflict=user_id`, {
      method: "POST",
      headers: { apikey: this.key, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(state),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
}
export function configuredSessions(): SessionSink | null {
  return process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    ? new SupabaseSessions(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY) : null;
}
export class StudySessions {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private directory = fileURLToPath(new URL("../data/sessions/", import.meta.url)),
    private sink: SessionSink | null = configuredSessions(),
    private feedbackDirectory = fileURLToPath(new URL("../data/feedback/records/", import.meta.url)),
    private seedFile = fileURLToPath(new URL("../data/seed_sessions.json", import.meta.url)),
    private vision = analyzePhoto,
    private history:StudyHistorySource|null = sink instanceof SupabaseSessions?configuredLearningStore():null,
    private now:()=>number = Date.now) {}
  private async serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve();
    const operation = before.catch(() => {}).then(action);
    this.locks.set(key, operation);
    try { return await operation; } finally { if (this.locks.get(key) === operation) this.locks.delete(key); }
  }
  private async read(key: string): Promise<Document> {
    try { return JSON.parse(await readFile(join(this.directory, `${key}.json`), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {sessions:[],replies:[]}; throw e; }
  }
  private async save(key: string, document: Document) {
    await mkdir(this.directory,{recursive:true});
    const path = join(this.directory,`${key}.json`), temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp,JSON.stringify(document),{mode:0o600}); await rename(temp,path);
  }
  async chatContext(conversation:string):Promise<{sessionStatus:string;feedbackRecorded:boolean}>{
    const key=hash(conversation);return this.serialized(key,async()=>{
      const doc=await this.read(key),session=doc.sessions.at(-1);
      return {sessionStatus:session?.status??"none",feedbackRecorded:Boolean(session?.feedback_id)};
    });
  }
  async departureSession(conversation:string):Promise<{id:string;startedAt:string}|null>{
    const key=hash(conversation);return this.serialized(key,async()=>{const session=(await this.read(key)).sessions.find(s=>s.status==="active");return session?{id:session.id,startedAt:session.started_at}:null;});
  }
  async hasUnfinished(conversation: string): Promise<boolean> {
    const key=hash(conversation);
    return this.serialized(key,async()=> (await this.read(key)).sessions.some(s=>s.status==="active"||s.status==="awaiting_feedback"));
  }
  async isActive(conversation: string, sessionId: string): Promise<boolean> {
    const key=hash(conversation);
    return this.serialized(key,async()=> (await this.read(key)).sessions.some(s=>s.id===sessionId&&s.status==="active"));
  }
  async startCalendar(conversation: string, eventKey: string, plannedMinutes: number, booking?:{gateway:CalendarGateway;start:number;end:number}): Promise<{id:string;reply:string}|null> {
    if(!Number.isInteger(plannedMinutes)||plannedMinutes<5||plannedMinutes>240)throw new Error("Invalid calendar duration");
    if(booking&&(!Number.isFinite(booking.start)||!Number.isFinite(booking.end)||booking.end-booking.start!==plannedMinutes*60000||booking.end<=this.now()))throw Error("Invalid booking interval");
    const key=hash(conversation), id=`cal_${hash(`${key}:${eventKey}`)}`;
    return this.serialized(key,async()=>{
      const doc=await this.read(key);
      const existing=doc.sessions.find(s=>s.id===id);
      if(existing)return existing.status==="active"?{id,reply:"This calendar session is already started. Text study status."}:null;
      if(doc.sessions.some(s=>s.status==="active"||s.status==="awaiting_feedback"))return null;
      doc.sessions.push({id,user_id:key,started_at:new Date(this.now()).toISOString(),ended_at:null,duration_mins:plannedMinutes,
        location:null,study_space:null,environment:{},environment_source:null,status:"active",feedback_id:null,is_synthetic:false,starting_energy:null,starting_noise:null,starting_context_at:null});
      if(booking){doc.calendarBookings??={};doc.calendarBookings[id]={start:booking.start,end:booking.end,status:"pending"};}
      await this.save(key,doc); // Preserve the session and exact booking interval before any Calendar write.
      let calendarReply="";
      if(booking){
        try{
          const eventId=await bookStudyEvent(booking.gateway,id,doc.calendarBookings![id]!);
          doc.calendarBookings![id] = {...doc.calendarBookings![id]!,status:"booked",eventId};
          await this.save(key,doc);calendarReply=" Added it to Hackathon Demo.";
        }catch(error){calendarReply=" Your tracked session is running, but the calendar booking was not confirmed. "+bookingFailure(error);}
      }
      return {id,reply:`Started your study session (${plannedMinutes} planned minutes).${calendarReply} Please send a photo of your workspace so I can analyze it. Text done when finished.`};
    });
  }
  async nextEnergyQuestion(conversation:string):Promise<string|null>{
    const key=hash(conversation);
    return this.serialized(key,async()=>{
      const doc=await this.read(key),session=doc.sessions.find(s=>s.status==="active");
      if(!session||session.environment_source!=="perceptron"||session.starting_energy!=null||doc.energyAsked?.includes(session.id))return null;
      const expires=Date.parse(session.started_at)+5*60000;
      if(this.now()>expires)return null;
      doc.energyAsked=[...(doc.energyAsked??[]),session.id].slice(-200);doc.energyQuestion={sessionId:session.id,expires};await this.save(key,doc);
      return "How is your energy right now? Reply 1-5 (1 = exhausted, 5 = energized), or skip.";
    });
  }
  async answerEnergy(conversation:string,text:string,messageId:string):Promise<string|null>{
    const key=hash(conversation);
    return this.serialized(key,async()=>{
      const doc=await this.read(key),cacheId=`energy:${messageId}`;
      const old=doc.replies.find(r=>r.id===cacheId);if(old)return old.text;
      const command=text.trim().toLowerCase(),session=doc.sessions.find(s=>s.status==="active");
      if(!session||doc.energyQuestion?.sessionId!==session.id||! /^(?:[1-5]|energy [1-5]|skip|unknown)$/.test(command))return null;
      let reply:string;
      if(this.now()>doc.energyQuestion.expires)reply="The starting-energy question has expired, so I won't record this as a starting condition.";
      else{
        const value=command.replace(/^energy /,"");session.starting_energy=/^[1-5]$/.test(value)?Number(value):null;session.starting_context_at=new Date(this.now()).toISOString();
        reply=session.starting_energy===null?"Starting energy left unknown.":`Starting energy saved: ${session.starting_energy}/5.`;
      }
      delete doc.energyQuestion;doc.replies=[...doc.replies,{id:cacheId,text:reply}].slice(-40);await this.save(key,doc);return reply;
    });
  }
  async retryCalendar(conversation:string,gateway:CalendarGateway):Promise<string>{
    const key=hash(conversation);
    return this.serialized(key,async()=>{
      const doc=await this.read(key),session=doc.sessions.find(s=>s.status==="active")??[...doc.sessions].reverse().find(s=>doc.calendarBookings?.[s.id]?.completed);
      const plan=session&&doc.calendarBookings?.[session.id];
      if(!session||!plan)return "No active study session has a calendar booking to retry.";
      if(plan.status==="booked")return "This study session is already added to Hackathon Demo. No duplicate was created.";
      if(!plan.completed&&plan.end<=this.now())return "That planned study block has ended. I won't add a past event. Text done for your check-in.";
      try{
        const eventId=await (plan.completed?logCompletedStudy(gateway,session.id,plan):bookStudyEvent(gateway,session.id,plan));
        doc.calendarBookings![session.id]={...plan,status:"booked",eventId};await this.save(key,doc);
        return "Your study session is added to Hackathon Demo. The original session time was kept; no duplicate was created.";
      }catch(error){return (plan.completed?"Your session remains ended. ":"Your tracked study session is still running. ")+bookingFailure(error);}
    });
  }
  private async appendPhotoLog(entry: PhotoLogEntry) {
    const photosLogFile=join(this.directory,"photos",`${entry.user_id}.json`);
    await mkdir(join(this.directory,"photos"),{recursive:true});
    await this.sink?.putPhotoLog?.(entry);
    try {
      let existing: PhotoLogEntry[] = [];
      try {
        const parsed = JSON.parse(await readFile(photosLogFile, "utf8"));
        if (Array.isArray(parsed)) existing = parsed;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      existing.push(entry);
      const temp = `${photosLogFile}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(existing, null, 2), { mode: 0o600 });
      await rename(temp, photosLogFile);
    } catch {
      // Do not fail session flow if auxiliary photo log cannot be written
    }
  }
  async syncPending(): Promise<void> {
    if (!this.sink) return;
    let names: string[];
    try { names = await readdir(this.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))) {
      const key=name.slice(0,-5);
      await this.serialized(key, async()=> { for (const session of (await this.read(key)).sessions) await this.sink!.put(session); });
    }
  }
  // Capture the exact session at check-in start, before any later session can be created.
  async beginFeedback(key: string): Promise<string | null> {
    return this.serialized(key,async()=>{
      const doc=await this.read(key);
      const session=doc.sessions.find(s=>s.status==="active" || s.status==="awaiting_feedback");
      if (!session) return null;
      if (session.status==="active") { session.status="awaiting_feedback"; session.ended_at=new Date(this.now()).toISOString(); }
      await this.save(key,doc); return session.id;
    });
  }
  async finishCalendar(conversation:string,gateway:CalendarGateway):Promise<string|null>{
    const key=hash(conversation);const id=await this.beginFeedback(key);if(!id)return null;
    return this.serialized(key,async()=>{
      const doc=await this.read(key),session=doc.sessions.find(s=>s.id===id)!;
      const existing=doc.calendarBookings?.[id];
      if(existing&&!existing.completed)return "Your session ended. It already has a calendar booking; no second event was added.";
      if(existing?.status==="booked")return "Your completed session is already logged in Hackathon Demo.";
      const plan:StudyBooking=existing??{start:Date.parse(session.started_at),end:Date.parse(session.ended_at!),status:"pending",completed:true};
      doc.calendarBookings??={};doc.calendarBookings[id]=plan;await this.save(key,doc);
      try{const eventId=await logCompletedStudy(gateway,id,plan);doc.calendarBookings[id]={...plan,status:"booked",eventId};await this.save(key,doc);return "Session finished and added to Hackathon Demo using your actual start and finish times.";}
      catch(error){return "Your session ended, but I couldn't confirm its calendar entry. "+bookingFailure(error);}
    });
  }
  async completeFeedback(record: SessionFeedback): Promise<void> {
    if (!record.session_id) return;
    await this.serialized(record.conversation_key,async()=>{
      const doc=await this.read(record.conversation_key);
      const session=doc.sessions.find(s=>s.id===record.session_id);
      if (!session) throw new Error("Linked session unavailable");
      if (session.feedback_id && session.feedback_id!==record.id) throw new Error("Session already rated");
      session.feedback_id=record.id; session.status="completed";
      await this.save(record.conversation_key,doc);
    });
  }
  async ensureCloud(record: SessionFeedback): Promise<void> {
    if (!record.session_id) return;
    if (!this.sink) throw new Error("Session cloud not configured");
    await this.serialized(record.conversation_key,async()=>{
      const session=(await this.read(record.conversation_key)).sessions.find(s=>s.id===record.session_id);
      if (!session) throw new Error("Linked session unavailable");
      await this.sink!.put(session); // parent exists before inserting feedback foreign key
    });
  }
  async handle(conversation: string, text: string, messageId: string): Promise<string | null> {
    const key=hash(conversation);
    return this.serialized(key,async()=>{
      const doc=await this.read(key);
      const old=doc.replies.find(r=>r.id===messageId);
      const command=text.trim().toLowerCase();
      if(old){
        if(/^start studying[.!]?$/.test(command)&&/^Started a study session\./i.test(old.text)&&/where.*seat.*planned|how many planned/i.test(old.text)){
          old.text="Started a study session. Please send a photo of your workspace so I can analyze it. Text done when finished.";
          await this.save(key,doc);
        }
        return old.text;
      }
      const active=doc.sessions.find(s=>s.status==="active");
      const waiting=doc.sessions.find(s=>s.status==="awaiting_feedback");
      let reply: string | null=null;
      if (/^start studying[.!]?$/.test(command)) {
        if (active) reply="You already have a study session. Text study status or done.";
        else if(waiting) reply="Finish your last check-in first: text rate session. Or text discard session to abandon it.";
        else {
          doc.sessions.push({id:randomUUID(),user_id:key,started_at:new Date(this.now()).toISOString(),ended_at:null,
            duration_mins:null,location:null,study_space:null,environment:{},environment_source:null,status:"active",feedback_id:null,is_synthetic:false,starting_energy:null,starting_noise:null,starting_context_at:null});
          reply="Started a study session. Please send a photo of your workspace so I can analyze it. Text done when finished.";
        }
      } else if(command.startsWith("starting context")) {
        const match=command.match(/^starting context ([1-5]|unknown) (quiet|moderate|loud|unknown)$/);
        const elapsed=active?this.now()-Date.parse(active.started_at):NaN;
        if(!active)reply="Start a study session first.";
        else if(!Number.isFinite(elapsed)||elapsed<0||elapsed>5*60_000)reply="Starting context can only be recorded in the first 5 minutes, before the session outcome is known.";
        else if(!match)reply="Use starting context 3 quiet: energy 1-5 (1 = exhausted, 5 = energized) or unknown; noise quiet/moderate/loud/unknown. This is optional.";
        else{
          active.starting_energy=match[1]==="unknown"?null:Number(match[1]);
          active.starting_noise=match[2] as StudySession["starting_noise"];
          active.starting_context_at=new Date(this.now()).toISOString();delete doc.energyQuestion;
          reply="Starting energy and noise saved. These are collected for future learning; they don't change today's model score yet. Text done when finished.";
        }
      } else if(command==="discard session") {
        const session=active??waiting;
        if(session){session.status="canceled";session.ended_at??=new Date(this.now()).toISOString();}
        reply=session?"Session discarded. It won't train your model.":"No unfinished study session.";
      } else if(command==="study status") {
        const session=active??waiting;
        reply=session?`Session ${session.status.replaceAll("_"," ")}: ${session.location??"place not set"}, ${session.study_space??"seat not set"}, ${session.duration_mins??"?"} planned minutes. Starting energy ${session.starting_energy??"unknown"}/5; noise ${session.starting_noise??"unknown"}. ${sessionContext(session)?"Context ready for learning.":"Context incomplete; send your place/seat/minutes and a photo or workspace details."}`:"No unfinished study session. Text start studying.";
      } else if(command==="study score") {
        if(!active) reply="Start a study session first.";
        else if(!sessionContext(active)) reply="I need complete workspace context first. Send a photo or text workspace bright 3 7 (lighting, clutter 1–10, comfort 1–10).";
        else reply=await this.score(key,active,doc);
      } else if(isStudyRecommendation(command)) {
        reply=await this.personalRecommendation(key,doc);
      } else if(command==="recommend space" || command==="recommend" || command==="recommendations" || command==="study recommendations" || command==="study recommendation") {
        reply=await this.personalRecommendation(key,doc);
      } else if(active) {
        const parts=command.split(/\s+/);
        if((parts.length===3||(parts.length===2&&active.duration_mins!==null)) && LOCATIONS.includes(parts[0] as any) && SPACES.includes(parts[1] as any)) {
          const duration=parts.length===3?Number(parts[2]):active.duration_mins!;
          if(!Number.isInteger(duration)||duration<5||duration>240)reply="Use planned minutes from 5 to 240.";
          else {active.location=parts[0] as Context["location"];active.study_space=parts[1] as Context["study_space"];active.duration_mins=duration;
            reply=sessionContext(active)?"Workspace context saved. "+await this.score(key,active,doc):active.environment_source?"Photo details are saved. Please rate your seating comfort from 1-10, for example comfort 7.":"Context saved. Please send a photo of your workspace for analysis. If a photo isn't possible, use workspace bright 3 7 for self-reported lighting, clutter and comfort.";}
        } else if(command.startsWith("workspace ")) {
          try {if(parts.length!==4)throw new Error();
            const environment=validateWorkspace({lighting:parts[1],clutter_score:Number(parts[2]),ergonomics:Number(parts[3])});
            active.environment=environment; active.environment_source="self_report";
            reply="Workspace details saved from your self-report. Text study score for a prediction, or done when finished.";
          } catch {reply="Use workspace bright 3 7: dim/bright, clutter 1–10, comfort 1–10.";}
        } else if(/^comfort [1-9]$|^comfort 10$/.test(command)) {
          active.environment.ergonomics=Number(parts[1]);
          active.environment_source=active.environment_source==="perceptron"?"mixed":active.environment_source??"self_report";
          reply=sessionContext(active)?"Comfort saved. "+await this.score(key,active,doc):"Comfort saved. Please send your place, seat and planned minutes, for example library desk 45.";
        }
      }
      if(reply!==null){doc.replies=[...doc.replies,{id:messageId,text:reply}].slice(-40);await this.save(key,doc);}
      return reply;
    });
  }
  async photo(conversation: string, messageId: string, mime: string, read:()=>Promise<Uint8Array>): Promise<string> {
    const key=hash(conversation);
    return this.serialized(key,async()=>{
      const doc=await this.read(key);const old=doc.replies.find(r=>r.id===messageId);if(old)return old.text;
      const session=doc.sessions.find(s=>s.status==="active");
      if(!session)return "Text start studying before sending a workspace photo.";
      if(!photoAttachment(mime))return "Please send a workspace photo (iPhone HEIC, JPEG, PNG, or WebP).";
      const environment=await this.vision(await read(),mime);
      session.environment=environment;session.environment_source="perceptron";
      await this.appendPhotoLog({
        id: messageId,
        user_id: key,
        session_id: session.id,
        timestamp: new Date().toISOString(),
        location: session.location,
        study_space: session.study_space,
        duration_mins: session.duration_mins,
        perceptron_tags: environment,
        source: "perceptron",
      });
      const interpretation=`Your workspace looks ${environment.lighting==="bright"?"bright":"dim"} and ${environment.clutter_score<=3?"fairly clear":environment.clutter_score<=6?"a little cluttered":"quite cluttered"}. ${environment.lighting==="dim"?"A little more light may make it easier to see your work.":environment.clutter_score>=7?"Clearing a small area could give you more room to work.":"How does this setup feel to you?"}`;
      let reply=interpretation+`\n\nPerceptron estimates: ${environment.lighting} lighting, clutter ${environment.clutter_score}/10.${environment.ergonomics===null?" I couldn't assess seating/posture. Reply comfort 7 with your comfort from 1-10.":` Visible ergonomics ${environment.ergonomics}/10.`} You can correct these with workspace bright 3 7.`;
      if(sessionContext(session))reply+=" "+await this.score(key,session,doc);
      else if(!session.location||!session.study_space||session.duration_mins===null)reply+=" I still need your place, seat and planned minutes to use these features in your study model. For example: library desk 45.";
      reply+=" Text done when finished.";
      doc.replies=[...doc.replies,{id:messageId,text:reply}].slice(-40);await this.save(key,doc);return reply;
    });
  }
  private async buildPersonalLearner(key:string,doc:Document,includeDemo=true,exportModel=true) {
    const rows=includeDemo&&process.env.STUDY_DEMO_SEEDS==="true"?JSON.parse(await readFile(this.seedFile,"utf8")):[];
    const {learner}=train(rows);const pairs=new Map<string,LearningPair>();let cloudUnavailable=false;
    if(this.history){try{for(const pair of await this.history.load(key)){if(pair?.feedback_record?.id)pairs.set(pair.feedback_record.id,pair);}}catch{cloudUnavailable=true;}}
    let names:string[]=[];
    try{names=await readdir(this.feedbackDirectory);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n)).sort()){
      const feedback=JSON.parse(await readFile(join(this.feedbackDirectory,name),"utf8")) as SessionFeedback;
      const session=doc.sessions.find(s=>s.id===feedback.session_id);
      if(session&&!pairs.has(feedback.id))pairs.set(feedback.id,{session_record:session,feedback_record:feedback});
    }
    const contexts:Context[]=[];let personal=0;const visitCounts=new Map<string,number>();
    for(const {session_record:session,feedback_record:feedback} of [...pairs.values()].sort((a,b)=>a.feedback_record.id.localeCompare(b.feedback_record.id))){
      if(feedback.conversation_key!==key||session.user_id!==key||session.status!=="completed"||session.feedback_id!==feedback.id||session.id!==feedback.session_id||session.is_synthetic!==false||feedback.is_synthetic!==false)continue;
      const context=sessionContext(session);if(!context)continue;
      try{learner.observe({...context,id:feedback.id,user_productivity_rating:feedback.productivity_rating,user_mood_rating:feedback.mood_rating},observationWeight(feedback));personal++;contexts.push(context);const k=`${context.location}:${context.study_space}`;visitCounts.set(k,(visitCounts.get(k)??0)+1);}catch{/* Invalid observations cannot train the model. */}
    }
    // Completed history is authoritative; cached parameters are only an export.
    if(exportModel)await this.sink?.putModelParams?.(learner.toState(key,visitCounts,personal+1));
    return {learner,rows,personal,cloudUnavailable,visitCounts,contexts};
  }
  async proactiveOptions(conversation:string,place:string,freeMinutes:number):Promise<LearningSummary>{
    const key=hash(conversation);
    return this.serialized(key,async()=>{
      const doc=await this.read(key);
      // Live proactive decisions never consume synthetic starters or export parameter caches.
      const {learner,contexts,personal,cloudUnavailable}=await this.buildPersonalLearner(key,doc,false,false);
      return studyOptions(learner,contexts,place,freeMinutes,personal,cloudUnavailable,this.now());
    });
  }
  private async score(key:string,current:StudySession,doc:Document):Promise<string>{
    const {learner,rows,personal,cloudUnavailable}=await this.buildPersonalLearner(key,doc);
    const prediction=learner.predict(sessionContext(current)!);
    return `Estimated productivity ${prediction.predictedProductivity.toFixed(1)}/5, mood ${prediction.predictedMood.toFixed(1)}/5. Based on ${personal} of your linked check-ins.${rows.length?` DEMO: also includes ${rows.length} synthetic starter examples.`:""}${cloudUnavailable?" Cloud history unavailable; using local feedback only.":this.history?" Supabase history and pending local feedback replayed without duplicate ratings.":" Local feedback only; Supabase learning is not configured."} These are associations, not guarantees. Planned duration is used; actual elapsed time is stored separately.`;
  }
  private async personalRecommendation(key:string,doc:Document):Promise<string>{
    const {learner,contexts,personal,cloudUnavailable,visitCounts}=await this.buildPersonalLearner(key,doc,false,false);
    if(!contexts.length)return "I don't have enough of your study data to recommend a favorite spot yet—there are no completed linked sessions with enough workspace details. Send a workspace photo, add your place/seat/planned minutes, and finish the ratings so I can learn what works for you."+(cloudUnavailable?" Cloud history is unavailable, so this only checks local feedback.":"");
    const profiles=new Map<string,Context>();
    for(const c of [...contexts].sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp))){const id=`${c.location}:${c.study_space}`;if(!profiles.has(id))profiles.set(id,c);}
    const ranked=learner.rank([...profiles].map(([id,c])=>({...c,id,label:id.replaceAll(":"," ").replaceAll("_"," "),timestamp:new Date(this.now()).toISOString()})),{alpha:.35});
    return "Based on your past study sessions ("+personal+" completed linked check-in"+(personal===1?"":"s")+"), I’d suggest:\n"+ranked.slice(0,2).map((p,i)=>`${i===0?"My first pick":"Another option"}: ${p.label} — estimated productivity ${p.predictedProductivity.toFixed(1)}/5 and mood ${p.predictedMood.toFixed(1)}/5 (${visitCounts.get(p.id)??0} matching session${(visitCounts.get(p.id)??0)===1?"":"s"}).`).join("\n")+"\nThis uses your last recorded setup and planned duration for each option. It’s an early estimate, and today’s conditions may differ. I haven’t checked travel or whether a spot is open."+(cloudUnavailable?" Cloud history unavailable; local feedback only.":"");
  }
}
