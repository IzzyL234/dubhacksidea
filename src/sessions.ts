import {bookStudyEvent,bookingFailure,type StudyBooking} from "./study-calendar.ts";
import type {CalendarGateway} from "./calendar-types.ts";
import {configuredLearningStore,type StudyHistorySource,type LearningPair} from "./learning-store.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { features, LOCATIONS, SPACES, train, type Candidate, type SerializedModelState, type Context } from "./learning.ts";
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

type Document = { calendarBookings?:Record<string,StudyBooking>; sessions: StudySession[]; replies: { id: string; text: string }[] };
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
      return {id,reply:`Started your calendar study session (${plannedMinutes} planned minutes).${calendarReply} Reply with your place and seat, for example library desk, then send a workspace photo or text workspace bright 3 7. Optional within the first 5 minutes: starting context 3 quiet (energy 1-5; noise quiet/moderate/loud/unknown). Text done when finished.`};
    });
  }
  async retryCalendar(conversation:string,gateway:CalendarGateway):Promise<string>{
    const key=hash(conversation);
    return this.serialized(key,async()=>{
      const doc=await this.read(key),session=doc.sessions.find(s=>s.status==="active");
      const plan=session&&doc.calendarBookings?.[session.id];
      if(!session||!plan)return "No active study session has a calendar booking to retry.";
      if(plan.status==="booked")return "This study session is already added to Hackathon Demo. No duplicate was created.";
      if(plan.end<=this.now())return "That planned study block has ended. I won't add a past event. Text done for your check-in.";
      try{
        const eventId=await bookStudyEvent(gateway,session.id,plan);
        doc.calendarBookings![session.id]={...plan,status:"booked",eventId};await this.save(key,doc);
        return "Your study session is added to Hackathon Demo. The original session time was kept; no duplicate was created.";
      }catch(error){return "Your tracked study session is still running. "+bookingFailure(error);}
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
      const old=doc.replies.find(r=>r.id===messageId); if(old)return old.text;
      const command=text.trim().toLowerCase();
      const active=doc.sessions.find(s=>s.status==="active");
      const waiting=doc.sessions.find(s=>s.status==="awaiting_feedback");
      let reply: string | null=null;
      if (/^start studying[.!]?$/.test(command)) {
        if (active) reply="You already have a study session. Text study status or done.";
        else if(waiting) reply="Finish your last check-in first: text rate session. Or text discard session to abandon it.";
        else {
          doc.sessions.push({id:randomUUID(),user_id:key,started_at:new Date(this.now()).toISOString(),ended_at:null,
            duration_mins:null,location:null,study_space:null,environment:{},environment_source:null,status:"active",feedback_id:null,is_synthetic:false,starting_energy:null,starting_noise:null,starting_context_at:null});
          reply="Started a study session. Where, what seat, and how many planned minutes? For example: library desk 45. Places: home, dorm_room, library, classroom, cafe. Seats: chair, desk, shared_table, bed, beanbag. Optional within the first 5 minutes: starting context 3 quiet (energy 1-5; noise quiet/moderate/loud/unknown).";
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
          active.starting_context_at=new Date(this.now()).toISOString();
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
      } else if(command==="recommend space" || command==="recommend" || command==="recommendations") {
        reply=await this.recommend(key,doc);
      } else if(active) {
        const parts=command.split(/\s+/);
        if((parts.length===3||(parts.length===2&&active.duration_mins!==null)) && LOCATIONS.includes(parts[0] as any) && SPACES.includes(parts[1] as any)) {
          const duration=parts.length===3?Number(parts[2]):active.duration_mins!;
          if(!Number.isInteger(duration)||duration<5||duration>240)reply="Use planned minutes from 5 to 240.";
          else {active.location=parts[0] as Context["location"];active.study_space=parts[1] as Context["study_space"];active.duration_mins=duration;
            reply="Context saved. Send a workspace photo for Perceptron analysis, or text workspace bright 3 7 using your own lighting, clutter, and comfort ratings. Text done when you finish.";}
        } else if(command.startsWith("workspace ")) {
          try {if(parts.length!==4)throw new Error();
            const environment=validateWorkspace({lighting:parts[1],clutter_score:Number(parts[2]),ergonomics:Number(parts[3])});
            active.environment=environment; active.environment_source="self_report";
            reply="Workspace details saved from your self-report. Text study score for a prediction, or done when finished.";
          } catch {reply="Use workspace bright 3 7: dim/bright, clutter 1–10, comfort 1–10.";}
        } else if(/^comfort [1-9]$|^comfort 10$/.test(command)) {
          active.environment.ergonomics=Number(parts[1]);
          active.environment_source=active.environment_source==="perceptron"?"mixed":active.environment_source??"self_report";
          reply="Comfort saved. Text study score or done.";
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
      if(!["image/jpeg","image/png","image/webp"].includes(mime))return "Please send a JPEG, PNG, or WebP photo.";
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
      const reply=`Perceptron estimates: ${environment.lighting} lighting, clutter ${environment.clutter_score}/10.${environment.ergonomics===null?" I couldn't assess seating/posture. Reply comfort 7 with your comfort from 1–10.":` Visible ergonomics ${environment.ergonomics}/10.`} You can correct these with workspace bright 3 7. Text done when finished.`;
      doc.replies=[...doc.replies,{id:messageId,text:reply}].slice(-40);await this.save(key,doc);return reply;
    });
  }
  private async buildPersonalLearner(key:string,doc:Document) {
    const rows=process.env.STUDY_DEMO_SEEDS==="true"?JSON.parse(await readFile(this.seedFile,"utf8")):[];
    const {learner}=train(rows);const pairs=new Map<string,LearningPair>();let cloudUnavailable=false;
    if(this.history){try{for(const pair of await this.history.load(key)){if(pair?.feedback_record?.id)pairs.set(pair.feedback_record.id,pair);}}catch{cloudUnavailable=true;}}
    let names:string[]=[];
    try{names=await readdir(this.feedbackDirectory);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n)).sort()){
      const feedback=JSON.parse(await readFile(join(this.feedbackDirectory,name),"utf8")) as SessionFeedback;
      const session=doc.sessions.find(s=>s.id===feedback.session_id);
      if(session&&!pairs.has(feedback.id))pairs.set(feedback.id,{session_record:session,feedback_record:feedback});
    }
    let personal=0;const visitCounts=new Map<string,number>();
    for(const {session_record:session,feedback_record:feedback} of [...pairs.values()].sort((a,b)=>a.feedback_record.id.localeCompare(b.feedback_record.id))){
      if(feedback.conversation_key!==key||session.user_id!==key||session.status!=="completed"||session.feedback_id!==feedback.id||session.id!==feedback.session_id||session.is_synthetic!==false||feedback.is_synthetic!==false)continue;
      const context=sessionContext(session);if(!context)continue;
      try{learner.observe({...context,id:feedback.id,user_productivity_rating:feedback.productivity_rating,user_mood_rating:feedback.mood_rating},observationWeight(feedback));personal++;const k=`${context.location}:${context.study_space}`;visitCounts.set(k,(visitCounts.get(k)??0)+1);}catch{/* Invalid observations cannot train the model. */}
    }
    // Completed history is authoritative; cached parameters are only an export.
    await this.sink?.putModelParams?.(learner.toState(key,visitCounts,personal+1));
    return {learner,rows,personal,cloudUnavailable,visitCounts};
  }
  private async score(key:string,current:StudySession,doc:Document):Promise<string>{
    const {learner,rows,personal,cloudUnavailable}=await this.buildPersonalLearner(key,doc);
    const prediction=learner.predict(sessionContext(current)!);
    return `Estimated productivity ${prediction.predictedProductivity.toFixed(1)}/5, mood ${prediction.predictedMood.toFixed(1)}/5. Based on ${personal} of your linked check-ins.${rows.length?` DEMO: also includes ${rows.length} synthetic starter examples.`:""}${cloudUnavailable?" Cloud history unavailable; using local feedback only.":this.history?" Supabase history and pending local feedback replayed without duplicate ratings.":" Local feedback only; Supabase learning is not configured."} These are associations, not guarantees. Planned duration is used; actual elapsed time is stored separately.`;
  }
  private async recommend(key: string, doc: Document): Promise<string> {
    const {learner, visitCounts}=await this.buildPersonalLearner(key, doc);
    const timestamp = new Date().toISOString();
    const typicalEnv: Record<Context["study_space"], Context["environment"]> = {
      desk: { clutter_score: 2, lighting: "bright", ergonomics: 8 },
      shared_table: { clutter_score: 3, lighting: "bright", ergonomics: 7 },
      chair: { clutter_score: 3, lighting: "bright", ergonomics: 6 },
      beanbag: { clutter_score: 5, lighting: "dim", ergonomics: 4 },
      bed: { clutter_score: 7, lighting: "dim", ergonomics: 2 },
    };
    const candidates: Candidate[] = [];
    for (const loc of LOCATIONS) {
      for (const sp of SPACES) {
        if (sp === "bed" && ["library", "classroom", "cafe"].includes(loc)) continue;
        candidates.push({
          id: `${loc}:${sp}`,
          label: `${loc.replace("_", " ")} ${sp.replace("_", " ")}`,
          timestamp,
          duration_mins: 45,
          location: loc,
          study_space: sp,
          environment: typicalEnv[sp],
        });
      }
    }
    const ranked = learner.rank(candidates, { alpha: 0.35 });
    const topKnown = ranked.find(c => (visitCounts.get(c.id) ?? 0) > 1);
    const topUnexplored = ranked.find(c => (visitCounts.get(c.id) ?? 0) <= 1);
    return `LinUCB Study Space Recommendations (illustrative lighting/clutter/comfort assumptions; availability and travel not checked):\n${topKnown?`• Previously studied setup: ${topKnown.label} (pred. productivity ${topKnown.predictedProductivity.toFixed(1)}/5, score ${topKnown.selectionScore.toFixed(2)})`:"• Not enough real history to identify a previously studied setup."}${topUnexplored?`\n• Unexplored option: ${topUnexplored.label} (score ${topUnexplored.selectionScore.toFixed(2)}, exploration bonus +${topUnexplored.explorationBonus.toFixed(2)})`:""}`;
  }

}

