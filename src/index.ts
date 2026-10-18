import {configuredDashboardAccess} from "./dashboard-access.ts";
import {dashboardCommand} from "./dashboard-command.ts";
import {InsightsPublisher} from "./insights-publisher.ts";
import {configuredLearningStore} from "./learning-store.ts";
import insightSeed from "../data/seed_sessions.json";
import {ScheduleReviewService,configuredReviewUpload} from "./schedule-review-service.ts";
import {configuredDashboardCalendar} from "./dashboard-calendar.ts";
import {StudyDeparture} from "./study-departure.ts";
import {isStudyTimeRequest,studyTimeReply} from "./study-time.ts";
import {photoAttachment} from "./photo-input.ts";
import {acquireInstance,AlreadyRunning} from "./single-instance.ts";
import {fileURLToPath as instanceFilePath} from "node:url";
import {createHash as traceHash,randomUUID as traceUUID} from "node:crypto";
import {SessionContext} from "./session-context.ts";
import {MessageDelivery} from "./message-delivery.ts";
import {interpretCalendar} from "./calendar-language.ts";
import {generateText,textProvider} from "./text-model.ts";
import {GeminiHttpError,type Turn} from "./gemini.ts";
import {configuredEventSink} from "./proactivity-store.ts";
import {lookupCampusBuildings} from "./uw-buildings.ts";
import { SmartPrompts } from "./smart-prompts.ts";
import { decidePrompt } from "./proactive-decision.ts";
import { readPhotonLocation, getPhotonLocationStatus } from "./photon-location.ts";
import { LocationDiagnostics } from "./location-diagnostics.ts";
import { LocationTrial } from "./location.ts";
import { StudySessions, isStudyRecommendation } from "./sessions.ts";
import { inboundMessages } from "./inbound.ts";
import { FeedbackFlow } from "./feedback.ts";
import { getUpcomingCalendarReply, isUpcomingRequest, getOpenStudyWindows, getOpenTimeReply } from "./calendar.ts";
import { demoCalendar } from "./calendar-api.ts";
import { CalendarCommands } from "./calendar-commands.ts";
import {
  StagedProposalEngine,
  isAgenticProposalIntent,
  isPendingProposalsQuery,
  isProposalApproval,
  isProposalRejection,
} from "./staged-proposals.ts";
import { StudyReminders } from "./proactive.ts";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

if(textProvider()==="xai"&&!process.env.XAI_API_KEY)throw Error("Configure XAI_API_KEY");
if(textProvider()==="gemini"&&!process.env.GEMINI_API_KEY)throw Error("Configure GEMINI_API_KEY");

try{const release=acquireInstance(instanceFilePath(new URL("../data/runtime/bot-instance.json",import.meta.url)));process.once("exit",release);}catch(error){if(error instanceof AlreadyRunning){console.log(error.message);process.exit(0);}throw error;}

const app = await Spectrum({
  projectId:
    process.env.PROJECT_ID ?? process.env.SPECTRUM_PROJECT_ID!,
  projectSecret:
    process.env.PROJECT_SECRET ?? process.env.SPECTRUM_PROJECT_SECRET!,
  providers: [imessage.config()],
});

// Keep each conversation separate. Restarting the bot resets this memory.
const messageDelivery=new MessageDelivery();
const runTag=traceUUID().slice(0,8);
const messageTag=(value:string)=>traceHash("sha256").update(value).digest("hex").slice(0,12);
console.log("[delivery] process",JSON.stringify({run:runTag,pid:process.pid}));
const conversations = new Map<string, Turn[]>();
const studySessions = new StudySessions().enableDemoPrior();
const sessionContext=new SessionContext();
const dashboardAccess=configuredDashboardAccess();
const feedbackFlow = new FeedbackFlow(undefined, undefined, {
  begin: key => studySessions.beginFeedback(key),
  afterSave: async record => {
    await studySessions.completeFeedback(record);
    await sessionContext.arm(record);
    // Sync completed feedback rating to FastAPI per-user LinUCB service if running
    const backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";
    try {
      await fetch(`${backendUrl}/api/rate-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: record.session_id ?? record.id,
          user_id: record.conversation_key,
          actual_rating: record.productivity_rating,
          mood_rating: record.mood_rating,
          distraction_rating: record.distraction_rating,
          distraction_source: record.distraction_source,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // FastAPI service is optional when running standalone TS bot
    }
  },
  beforeUpload: record => studySessions.ensureCloud(record),
});
const locationTrial = new LocationTrial();
const locationDiagnostics = new LocationDiagnostics();
const messaging = imessage(app);
const calendarCommands = new CalendarCommands(demoCalendar,undefined,Date.now,interpretCalendar);
const stagedProposals = new StagedProposalEngine(demoCalendar);
const smartPrompts = new SmartPrompts({eventDriven:true,sessionState:async c=>({...await studySessions.chatContext(c),feedbackPending:await feedbackFlow.hasDraft(c)}),coordinatorPlaces:true,learn:async(c,p,m)=>({...await studySessions.proactiveOptions(c,p,m),sessionContext:await sessionContext.summary(c)}),events:configuredEventSink(),read:readPhotonLocation,decide:decidePrompt,lookup:lookupCampusBuildings,localBuildings:true});
async function captureStudyPlace(conversation:string){const s=await studySessions.placeSession(conversation);if(!s||s.location)return;try{const place=await smartPrompts.studyPlace(conversation,s.startedAt,s.endedAt);if(place)await studySessions.recordDetectedPlace(conversation,s.id,place);}catch{/* Ask the user only at the final check-in if detection is unavailable. */}}
const departures=new StudyDeparture({session:c=>studySessions.departureSession(c),read:c=>smartPrompts.departureLocation(c),send:async(c,text)=>{const space=await messaging.space.get(c);await space.send(text);}});
const reminders = new StudyReminders({
  refresh:async c=>{await departures.tick(c);await smartPrompts.refreshPresence(c);await captureStudyPlace(c);},

  promptBudget:6,
  resolvePlace:(c,accept)=>smartPrompts.resolvePlace(c,accept),
  coordinate:(c,b,available)=>smartPrompts.evaluate(c,b,available),
  confirm:(c,b)=>smartPrompts.confirm(c,b),
  audit:(c,r)=>smartPrompts.audit(c,r),
  outcome:(c,k)=>smartPrompts.outcome(c,k),
  events: now => getOpenStudyWindows(now),
  send: async (conversation, text) => { const space = await messaging.space.get(conversation); await space.send(text); },
  busy: async conversation => await studySessions.hasUnfinished(conversation) || await feedbackFlow.hasDraft(conversation),
  start: (conversation, block) => studySessions.startCalendar(conversation, block.key, (block.end-block.start)/60_000,{gateway:demoCalendar,start:block.start,end:block.end}),
  active: (conversation, id) => studySessions.isActive(conversation, id),
  checkIn: conversation => feedbackFlow.hasDraft(conversation),
});
const scheduleReviews=new ScheduleReviewService({gateway:demoCalendar,reviewUrl:(process.env.FRONTEND_URL??"http://localhost:3000").replace(/\/+$/,"")+"/dashboard",upload:configuredReviewUpload(),connected:c=>reminders.enabledFor(c),allowed:async c=>await reminders.notificationAllowedFor(c)&&!await studySessions.hasUnfinished(c)&&!await feedbackFlow.hasDraft(c),estimate:(c,start,lengths)=>studySessions.timeEstimates(c,start,lengths),send:async(c,text)=>{const space=await messaging.space.get(c);await space.send(text);}});
let reviewTickRunning=false;
async function pollScheduleReviews(){if(reviewTickRunning)return;reviewTickRunning=true;try{await scheduleReviews.tick();}catch{console.error("Schedule review deferred; check calendar connection and migration 012.");}finally{reviewTickRunning=false;}}
void pollScheduleReviews();
setInterval(()=>void pollScheduleReviews(),60000).unref();
let reminderTickRunning = false;
async function pollStudyReminders() {
  if (reminderTickRunning) return;
  reminderTickRunning = true;
  try { await reminders.tick(); }
  catch { console.error("Study reminder check failed. No event details or credentials logged."); }
  finally { reminderTickRunning = false; }
}
void pollStudyReminders();
setInterval(() => void pollStudyReminders(), 60_000).unref();
let feedbackSyncRunning = false;
async function retryFeedbackSync() {
  if (feedbackSyncRunning) return;
  feedbackSyncRunning = true;
  try {
    try { await studySessions.syncPending(); }
    catch { console.error("Session cloud sync deferred. Local sessions are kept; check the session migration."); }
    try {await smartPrompts.syncPending();}catch{console.error("Proactivity events queued; check Supabase migration 006 and connection.");}
    try{const rebuilt=await studySessions.rebuildDaily();if(rebuilt.rebuilt)console.log(`Rebuilt ${rebuilt.rebuilt} personal model(s) from saved history.`);}catch{console.error("Model consistency rebuild will retry; saved feedback is preserved.");}
    const result = await feedbackFlow.syncPending();
    if (result.synced) console.log(`Uploaded ${result.synced} pending feedback check-in(s).`);
    try{const contextSync=await sessionContext.flush();if(contextSync.pending)console.error('Confirmed session context queued; check migration 014 and Supabase connection.');}
    catch{console.error('Confirmed session context sync will retry. Local copies are kept.');}
  } catch {
    console.error("Feedback sync will retry. Local copies are kept.");
  } finally { feedbackSyncRunning = false; }
}
const dashboardCalendar=configuredDashboardCalendar(demoCalendar);
async function syncDashboardCalendar(){try{await dashboardCalendar?.sync();}catch{console.error("Dashboard calendar sync deferred; check migration 011 and Calendar connection.");}}
void syncDashboardCalendar();
setInterval(()=>void syncDashboardCalendar(),60000).unref();
const insightSource=configuredLearningStore();
const insightsPublisher=insightSource&&process.env.SUPABASE_URL&&process.env.SUPABASE_SECRET_KEY?new InsightsPublisher(insightSource,insightSeed,process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY):null;
async function publishDailyInsights(){try{await insightsPublisher?.tick();}catch{console.error("Daily insights deferred; check migration 013 and Supabase connection.");}}
void publishDailyInsights();
setInterval(()=>void publishDailyInsights(),60000).unref();
void retryFeedbackSync();
setInterval(() => void retryFeedbackSync(), 60_000).unref();

const instructions = `
You are an Agentic Calendar Planner and personal study assistant backed by a Staged Approval Queue ("Git Diff for Calendar").
Write short, natural replies suitable for text messages.
When the user asks to build their schedule, add recurring classes, move blocks, change deadlines, or split study sessions, you design the schedule changes using LinUCB context and their 24h LearnedUserRhythm, stage them in pending_proposals (CREATE_EVENT, UPDATE_EVENT, SPLIT_OR_RESCHEDULE_BLOCK, DELETE_EVENT, UPDATE_DEADLINE), and present a clean preview asking for approval ("Reply YES to lock this in, or NO to adjust").
Never claim a calendar mutation is already committed to Google Calendar until the user approves the staged proposal or executes an explicit command.
Ask one clarifying question at a time when needed. To record a study check-in, tell the user to text "rate session". A separate handler collects productivity, mood, and distraction ratings. Never invent ratings or claim you recorded them yourself.
To track a linked study session, tell the user to text "start studying", then send a workspace photo when prompted. After successful photo analysis, a separate text asks starting energy 1-5. Photo analysis extracts visible features; missing place/seat/planned minutes may be requested afterward, such as "library desk 45". They can use "study score" for an estimate, "recommend space" for hypothetical setup comparisons, and text "done" for linked ratings. They can optionally text "starting context 3 quiet" in the first five minutes to record energy and noise. These fields are collection-only, not score inputs yet. High-distraction feedback can be described naturally and requires confirmation of Gemini's suggested category. These commands are handled separately; never claim you ran them yourself or invent workspace measurements.
Calendar reminders are controlled by "reminders on", "reminders off", "reminders status", "quiet hours off", and optional "quiet hours 22 8". They detect open time between commitments, not event titles. Study suggestions can happen at any hour, with at least 30 free minutes and 10-minute buffers. Quiet hours are off unless explicitly configured. Only Hackathon Demo is checked. Never claim to enable reminders yourself. Accepting a study invitation starts a tracked session and attempts to add it to Hackathon Demo. The reply confirms booking or explains failure; retry calendar safely retries a failed booking. Manual start studying begins tracking; done or finished studying logs the actual completed interval to Hackathon Demo, with no duplicate if a proactive booking already exists. They work while the bot runs and use Pacific quiet hours. Text "open time" to list gaps.
The bot reads upcoming events with "calendar"; "calendar events" shows numbered events for editing. Explicit pipe commands are also supported: "add event Title | YYYY-MM-DD 14:00 | YYYY-MM-DD 14:45", "move event 2 | YYYY-MM-DD 15:00 | YYYY-MM-DD 15:45", or "rename event 2 | New title". Times are Pacific; use "calendar help" for syntax.
Shared Find My location is available only through separate explicit handlers. For a shared-location trial, tell the user to text location. Never infer their current location from conversation or claim GPS access. For an actual shared Find My snapshot check, tell the user to text live location status; a separate handler calls Photon. Text "smart prompts on" to enable smart suggestions and UW Seattle building discovery.
`;

for await (const [space, envelope] of app.messages) {
  for (const message of inboundMessages(envelope)) {
  if (message.direction === "outbound") continue;
  const claimed=await messageDelivery.claim(space.id,message.id);
  console.log("[delivery] inbound",JSON.stringify({run:runTag,chat:messageTag(space.id),message:messageTag(message.id),claimed,type:message.content.type}));
  if(!claimed)continue;
  if (message.content.type === "text" && /^(?:live location status|location api status)[.!?]*$/i.test(message.content.text.trim())) {
    try { await space.send(message.sender?.id ? await getPhotonLocationStatus(message.sender.id) : "I couldn't identify the sender for a location lookup."); }
    catch { console.error("Could not send the location status reply."); }
    continue;
  }
  locationDiagnostics.observe(space.id, message.id, {
    type:message.content.type,
    ...(message.content.type==="text"?{text:message.content.text}:{}),
    ...(message.content.type==="richlink"?{url:message.content.url}:{}),
    ...(message.content.type==="custom"?{raw:message.content.raw}:{}),
  });
  if (message.content.type === "text") {
    const diagnosticReply = locationDiagnostics.handle(space.id, message.content.text);
    if (diagnosticReply !== null) {
      try { await space.send(diagnosticReply); }
      catch { console.error("Could not send location test reply."); }
      continue;
    }
  }
  if (message.content.type === "attachment") {
    try {
      const attachment = message.content;
      if (photoAttachment(attachment.mimeType,attachment.name)) {
        if (attachment.size !== undefined && attachment.size > 8_000_000) {
          await space.send("Please send a workspace photo under 8 MB.");
          continue;
        }
        await space.responding(async () => {
          await space.send(await studySessions.photo(space.id, message.id, attachment.mimeType, () => attachment.read()));
          const question=await studySessions.nextEnergyQuestion(space.id);if(question)await space.send(question);
        });
      }
    } catch(error) {
      console.error("Workspace photo analysis failed; no image or credentials logged.");
      const reason=error instanceof Error?error.message:"";
      const photoError=reason==="PHOTO_SIZE_LIMIT"?"Please send a workspace photo under 8 MB (after conversion too).":reason==="PHOTO_FORMAT_UNSUPPORTED"?"I couldn't read that image format. Please resend a JPEG, PNG, WebP, or iPhone HEIC photo.":reason.startsWith("PHOTO_CONVERSION")?"I couldn't convert that iPhone photo. Please try resending it or send a screenshot of the photo.":"I couldn't analyze that photo just now. Please retry, or text workspace bright 3 7 to report the details yourself.";
      try { await space.send(photoError); }
      catch { console.error("Could not send photo error reply."); }
    }
    continue;
  }
  const locationInput = message.content.type === "text" ? message.content.text
    : message.content.type === "richlink" ? message.content.url : null;
  if (locationInput !== null && !/^where am i[?.!]*$/i.test(locationInput.trim())) {
    const locationReply = locationTrial.handle(space.id, locationInput);
    if (locationReply !== null) {
      try { await space.send(locationReply); }
      catch { console.error("Could not send location trial reply."); }
      continue;
    }
  }
  if (message.content.type !== "text") continue;

  let incoming = message.content.text.trim();
  let placeCheckInResolved=false;
  if (!incoming) continue;

  try {
    const dashboardReply=await dashboardCommand(dashboardAccess,space.id,incoming,message.id);
    if(dashboardReply!==null){await space.send(dashboardReply);continue;}
    const scheduleReply=await scheduleReviews.handle(space.id,incoming);
    if(scheduleReply!==null){await space.send(scheduleReply);void pollScheduleReviews();continue;}
    const departureAnswer=await departures.answer(space.id,incoming);
    if(departureAnswer){if(departureAnswer.done)incoming="done";else{await space.send(departureAnswer.reply!);continue;}}
    const pendingPlace=await studySessions.placeCheckIn(space.id,incoming,false);
    if(pendingPlace?.reply){await space.send(pendingPlace.reply);continue;}
    if(pendingPlace?.resume){incoming=pendingPlace.resume;placeCheckInResolved=true;}
    // Staged Approval Queue ("Git Diff for Calendar"): check pending approvals/rejections first
    if (isPendingProposalsQuery(incoming)) {
      const pending = await stagedProposals.getPendingProposals();
      if (!pending.length) {
        await space.send("No pending staged calendar proposals right now.");
      } else {
        await space.send(pending.map(p => stagedProposals.formatProposalPreview(p)).join("\n\n---\n\n"));
      }
      continue;
    }
    if (isProposalApproval(incoming)) {
      const pending = await stagedProposals.getPendingProposals();
      if (pending.length > 0) {
        const batchMatch = incoming.match(/\b(batch_[a-z0-9]+)\b/i);
        const { replyText } = await stagedProposals.approvePending(batchMatch?.[1]);
        await space.send(replyText);
        void pollStudyReminders();
        continue;
      }
    }
    if (isProposalRejection(incoming)) {
      const pending = await stagedProposals.getPendingProposals();
      if (pending.length > 0) {
        const batchMatch = incoming.match(/\b(batch_[a-z0-9]+)\b/i);
        const { replyText } = await stagedProposals.rejectPending(batchMatch?.[1], incoming);
        await space.send(replyText);
        continue;
      }
    }

    if(incoming.toLowerCase()==="smart prompts on"){
      const connected=await reminders.handle(space.id,"reminders on",message.id+":connect");
      if(!await reminders.enabledFor(space.id)){await space.send(connected??"Could not connect reminders.");continue;}
    }
    const smartReply=await smartPrompts.handle(space.id,message.sender?.id,incoming);
    if(smartReply!==null){
      if(incoming.toLowerCase()==="smart prompts off")await reminders.handle(space.id,"reminders off",message.id+":disconnect");
      await space.send(smartReply);void pollStudyReminders();continue;
    }
    if (/^(?:open time|free time|find open time|when am i free)[?.!]*$/i.test(incoming)) {
      await space.send(await getOpenTimeReply());
      continue;
    }
    if(incoming.toLowerCase()==="retry calendar"){
      await space.send(await studySessions.retryCalendar(space.id,demoCalendar));continue;
    }
    if(isStudyTimeRequest(incoming)){
      try{await space.send(await studyTimeReply(incoming,await getOpenStudyWindows(),(start,lengths)=>studySessions.timeEstimates(space.id,start,lengths)));}
      catch{await space.send("I couldn’t read your calendar openings just now. Please try again shortly; I haven’t booked anything.");}
      continue;
    }
    if(isStudyRecommendation(incoming)){const recommendation=await studySessions.handle(space.id,incoming,message.id);if(recommendation){await space.send(recommendation);continue;}}
    const extraReply=await sessionContext.handle(space.id,incoming,message.id);
    if(extraReply!==null){await space.send(extraReply);void pollStudyReminders();continue;}
    const energyReply=await studySessions.answerEnergy(space.id,incoming,message.id);
    if(energyReply!==null){await space.send(energyReply);continue;}
    const reminderReply = await reminders.handle(space.id, incoming, message.id);
    if (reminderReply !== null) {
      await space.send(reminderReply);
      void pollStudyReminders();
      void retryFeedbackSync();
      continue;
    }
    if (incoming.toLowerCase() === "discard session") await feedbackFlow.handle(space.id, "reset", `${message.id}:reset`);
    const sessionReply = await studySessions.handle(space.id, incoming, message.id);
    if (sessionReply !== null) {
      console.log("[delivery] session_send",JSON.stringify({run:runTag,message:messageTag(message.id),reply:messageTag(sessionReply)}));
      await space.send(sessionReply);
      console.log("[delivery] session_sent",JSON.stringify({run:runTag,message:messageTag(message.id)}));
      void pollStudyReminders();
      void retryFeedbackSync();
      continue;
    }
    const finishTrigger=/^(?:done|finished studying|rate session)[.!?]*$/i.test(incoming)&&!placeCheckInResolved&&!await feedbackFlow.hasDraft(space.id);
    if(finishTrigger)await captureStudyPlace(space.id);
    const placeCheckIn=finishTrigger?await studySessions.placeCheckIn(space.id,incoming,true):null;
    if(placeCheckIn?.reply){await space.send(placeCheckIn.reply);continue;}
    if(placeCheckIn?.resume)incoming=placeCheckIn.resume;
    const finishedCalendar=/^(?:done|finished studying)[.!?]*$/i.test(incoming)?await studySessions.finishCalendar(space.id,demoCalendar):null;
    const feedbackReply = await feedbackFlow.handle(space.id, incoming, message.id);
    if (feedbackReply !== null) {
      const extraQuestion=await sessionContext.question(space.id);
      void pollStudyReminders();
      await space.send((finishedCalendar?finishedCalendar+"\n\n":"")+feedbackReply+(extraQuestion?"\n\n"+extraQuestion:""));
      continue;
    }
    // Explicit pipe commands (`add event ... | ...`, `move event 2 | ...`, `calendar events`, `calendar help`)
    if (/^(calendar events|calendar help|add event(?:\s|$)|move event(?:\s|$)|rename event(?:\s|$))/i.test(incoming)) {
      const calendarReply = await calendarCommands.handle(space.id, incoming, message.id);
      if (calendarReply !== null) {
        await space.send(calendarReply);
        void pollStudyReminders();
        continue;
      }
    }
    // Agentic Calendar Planner: natural-language schedule building, moving blocks, splitting sessions, or changing deadlines
    if (isAgenticProposalIntent(incoming)) {
      const { replyText, proposal } = await stagedProposals.proposeFromText(incoming, "user_chat");
      if (proposal) {
        await space.send(replyText);
        continue;
      }
    }
    const calendarReply = await calendarCommands.handle(space.id, incoming, message.id);
    if (calendarReply !== null) {
      await space.send(calendarReply);
      void pollStudyReminders();
      continue;
    }
  } catch {
    console.error("Feedback could not be processed or delivered. No credentials were logged.");
    try { await space.send("I couldn't finish that check-in just now. Please try again, or text cancel to stop."); }
    catch { console.error("Could not send the feedback error message."); }
    continue;
  }

  if (isUpcomingRequest(incoming)) {
    try {
      await space.responding(async () => {
        await space.send(await getUpcomingCalendarReply());
      });
    } catch (error) {
      const status = (error as { response?: { status?: number }; code?: unknown }).response?.status
        ?? (error as { code?: unknown }).code;
      console.error("Calendar lookup failed:", status ?? "unknown error");
      try {
        await space.send("I couldn't read your demo calendar just now. Run bun calendar-test.mjs in the project terminal to check the connection.");
      } catch {
        console.error("Could not send the Calendar error message.");
      }
    }
    continue;
  }

  if (incoming.toLowerCase() === "reset") {
    conversations.delete(space.id);
    await space.send("Fresh start! What would you like help with?");
    continue;
  }

  try {
    await space.responding(async () => {
      const history=conversations.get(space.id)??[];
      const turns:Turn[]=[...history,{role:"user",parts:[{text:incoming}]}];
      const studyState=await studySessions.chatContext(space.id);
      const feedbackPending=await feedbackFlow.hasDraft(space.id);
      const pendingProposals=await stagedProposals.getPendingProposals();
      const reply=await generateText(instructions+"\nActual current study state (authoritative): "+JSON.stringify({...studyState,feedbackPending,confirmedContext:await sessionContext.summary(space.id),pendingProposalsCount:pendingProposals.length,pendingBatches:pendingProposals.map(p=>({batch_id:p.batch_id,summary:p.summary_message,operations_count:p.operations.length}))})+". If feedbackRecorded is true, acknowledge completed ratings and never ask to rate that session again. Do not suggest rate session unless the user explicitly asks how to give feedback. A done message begins the rating flow; ratings are only complete when saved. Only confirmedContext contains saved optional notes. These locally stored sentiment/social tags inform coordinator decisions but are not LinUCB features or causal evidence. Never claim ordinary conversation was saved or learned. Never infer friends were distracting without explicit confirmed evidence.",turns);
      await space.send(reply);
      conversations.set(space.id,[...turns,{role:"model" as const,parts:[{text:reply}]}].slice(-20));
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Reply failed");
    try {
      await space.send(
        error instanceof GeminiHttpError && error.status===503 ? "The AI service is temporarily busy. I retried, but it is still unavailable. Please try again shortly. Commands like start studying and where am i still work." : "I couldn't get an AI reply just now. Please try again."
      );
    } catch {
      console.error("Could not send the error message.");
    }
  }
}
}
