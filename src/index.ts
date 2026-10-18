import {configuredEventSink} from "./proactivity-store.ts";
import {lookupCampusBuildings} from "./uw-buildings.ts";
import { SmartPrompts } from "./smart-prompts.ts";
import { decidePrompt } from "./proactive-decision.ts";
import { readPhotonLocation, getPhotonLocationStatus } from "./photon-location.ts";
import { LocationDiagnostics } from "./location-diagnostics.ts";
import { LocationTrial } from "./location.ts";
import { StudySessions } from "./sessions.ts";
import { inboundMessages } from "./inbound.ts";
import { FeedbackFlow } from "./feedback.ts";
import { getUpcomingCalendarReply, isUpcomingRequest, getOpenStudyWindows, getOpenTimeReply } from "./calendar.ts";
import { demoCalendar } from "./calendar-api.ts";
import { CalendarCommands } from "./calendar-commands.ts";
import { StudyReminders } from "./proactive.ts";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

if (!process.env.XAI_API_KEY) {
  throw new Error("Add XAI_API_KEY to your .env file first.");
}

const app = await Spectrum({
  projectId:
    process.env.PROJECT_ID ?? process.env.SPECTRUM_PROJECT_ID!,
  projectSecret:
    process.env.PROJECT_SECRET ?? process.env.SPECTRUM_PROJECT_SECRET!,
  providers: [imessage.config()],
});

// Keep each conversation separate. Restarting the bot resets this memory.
const conversations = new Map<string, string>();
const studySessions = new StudySessions();
const feedbackFlow = new FeedbackFlow(undefined, undefined, {
  begin: key => studySessions.beginFeedback(key),
  afterSave: async record => {
    await studySessions.completeFeedback(record);
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
const calendarCommands = new CalendarCommands(demoCalendar);
const smartPrompts = new SmartPrompts({events:configuredEventSink(),read:readPhotonLocation,decide:decidePrompt,lookup:lookupCampusBuildings,localBuildings:true});
const reminders = new StudyReminders({
  observe:c=>smartPrompts.observe(c),
  resolvePlace:(c,accept)=>smartPrompts.resolvePlace(c,accept),
  evaluate:(c,b)=>smartPrompts.evaluate(c,b),
  confirm:(c,b)=>smartPrompts.confirm(c,b),
  audit:(c,r)=>smartPrompts.audit(c,r),
  outcome:(c,k)=>smartPrompts.outcome(c,k),
  events: now => getOpenStudyWindows(now),
  send: async (conversation, text) => { const space = await messaging.space.get(conversation); await space.send(text); },
  busy: async conversation => await studySessions.hasUnfinished(conversation) || await feedbackFlow.hasDraft(conversation),
  start: (conversation, block) => studySessions.startCalendar(conversation, block.key, (block.end-block.start)/60_000),
  active: (conversation, id) => studySessions.isActive(conversation, id),
  checkIn: conversation => feedbackFlow.hasDraft(conversation),
});
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
    const result = await feedbackFlow.syncPending();
    if (result.synced) console.log(`Uploaded ${result.synced} pending feedback check-in(s).`);
  } catch {
    console.error("Feedback sync will retry. Local copies are kept.");
  } finally { feedbackSyncRunning = false; }
}
void retryFeedbackSync();
setInterval(() => void retryFeedbackSync(), 60_000).unref();

const instructions = `
You are a friendly personal study and scheduling assistant.
Write short, natural replies suitable for text messages.
Help the user think through study plans and commitments.
Ask one clarifying question at a time when needed. To record a study check-in, tell the user to text "rate session". A separate handler collects productivity, mood, and distraction ratings. Never invent ratings or claim you recorded them yourself.
To track a linked study session, tell the user to text "start studying", then send place/seat/planned minutes such as "library desk 45". They can send a workspace photo, use "study score" for an estimate, "recommend space" for hypothetical setup comparisons, and text "done" for linked ratings. They can optionally text "starting context 3 quiet" in the first five minutes to record energy and noise. These fields are collection-only, not score inputs yet. High-distraction feedback can be described naturally and requires confirmation of Grok's suggested category. These commands are handled separately; never claim you ran them yourself or invent workspace measurements.
Calendar reminders are controlled by "reminders on", "reminders off", "reminders status", and "quiet hours 22 8". They detect open time between commitments, not event titles. The default study window is 9 AM–8 PM Pacific with at least 30 free minutes and 10-minute buffers. Only Hackathon Demo is checked. Never claim to enable reminders yourself. They work while the bot runs and use Pacific quiet hours. Text "open time" to list gaps.
The bot reads upcoming events with "calendar"; "calendar events" shows numbered events for editing. Calendar tools support explicit commands: "add event Title | YYYY-MM-DD 14:00 | YYYY-MM-DD 14:45", "move event 2 | YYYY-MM-DD 15:00 | YYYY-MM-DD 15:45", or "rename event 2 | New title". Times are Pacific; use "calendar help" for syntax. Never claim an event was created or edited yourself: deterministic handlers execute these commands and confirm actual results.
Never invent calendar events, claim you performed a calendar lookup yourself, or claim you booked or saved anything. Shared Find My location is available only through separate explicit handlers. For a shared-location trial, tell the user to text location. Never infer their current location from conversation or claim GPS access. For an actual shared Find My snapshot check, tell the user to text live location status; a separate handler calls Photon. Text "smart prompts on" to enable smart suggestions and UW Seattle building discovery. Building recognition is independent of calendar availability; study invitations still need open time. Text "where am i" for a fresh building estimate. After stable readings at an unknown place, the bot may ask to save a nearby named study spot; yes saves only the place and never starts a session. A separate later study invitation requires a separate yes. "place discovery off" disables map lookup; "remember place library" remains a manual fallback. Fresh distinct location readings over three minutes, calendar availability, quiet hours, and prompt limits must pass before a separate Grok decision. "why quiet" shows reasons. Never infer that these checks passed or that a session started. "smart prompts off" stops suggestions.
`;

type GrokResponse = {
  id: string;
  status: string;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
};

for await (const [space, envelope] of app.messages) {
  for (const message of inboundMessages(envelope)) {
  if (message.direction === "outbound") continue;
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
      if (attachment.mimeType.startsWith("image/")) {
        if (attachment.size !== undefined && attachment.size > 8_000_000) {
          await space.send("Please send a workspace photo under 8 MB.");
          continue;
        }
        await space.responding(async () => {
          await space.send(await studySessions.photo(space.id, message.id, attachment.mimeType, () => attachment.read()));
        });
      }
    } catch {
      console.error("Workspace photo analysis failed; no image or credentials logged.");
      try { await space.send("I couldn't analyze that photo. Check PERCEPTRON_API_KEY, or text workspace bright 3 7 for self-reported lighting, clutter, and comfort. No photo features were invented."); }
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

  const incoming = message.content.text.trim();
  if (!incoming) continue;

  try {
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
    const calendarReply = await calendarCommands.handle(space.id, incoming, message.id);
    if (calendarReply !== null) {
      await space.send(calendarReply);
      void pollStudyReminders();
      continue;
    }
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
      await space.send(sessionReply);
      void retryFeedbackSync();
      continue;
    }
    const feedbackReply = await feedbackFlow.handle(space.id, incoming, message.id);
    if (feedbackReply !== null) {
      await space.send(feedbackReply);
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
      const previousId = conversations.get(space.id);

      const response = await fetch("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.XAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: process.env.XAI_MODEL ?? "grok-4.7",
          instructions,
          input: incoming,
          ...(previousId ? { previous_response_id: previousId } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`xAI request failed: HTTP ${response.status}`);
      }

      const data = (await response.json()) as GrokResponse;

      const reply = (data.output ?? [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();

      if (data.status !== "completed" || !reply) {
        throw new Error("Grok did not return a complete reply.");
      }

      await space.send(reply);
      conversations.set(space.id, data.id);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Reply failed");
    try {
      await space.send(
        "I couldn't get an AI reply just now. Please try again."
      );
    } catch {
      console.error("Could not send the error message.");
    }
  }
}
}
