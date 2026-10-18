import { LocationTrial } from "./location.ts";
import { StudySessions } from "./sessions.ts";
import { inboundMessages } from "./inbound.ts";
import { FeedbackFlow } from "./feedback.ts";
import { getUpcomingCalendarReply, isUpcomingRequest } from "./calendar.ts";
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
  afterSave: record => studySessions.completeFeedback(record),
  beforeUpload: record => studySessions.ensureCloud(record),
});
const locationTrial = new LocationTrial();
let feedbackSyncRunning = false;
async function retryFeedbackSync() {
  if (feedbackSyncRunning) return;
  feedbackSyncRunning = true;
  try {
    try { await studySessions.syncPending(); }
    catch { console.error("Session cloud sync deferred. Local sessions are kept; check the session migration."); }
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
To track a linked study session, tell the user to text "start studying", then send place/seat/planned minutes such as "library desk 45". They can send a workspace photo, use "study score" for an estimate, and text "done" for linked ratings. These commands are handled separately; never claim you ran them yourself or invent workspace measurements.
The bot can read the next five events from Hackathon Demo when the user texts "What's coming up?" or "calendar". For other calendar questions, ask them to use that command. You cannot create or change events yet.
Never invent calendar events, claim you performed a calendar lookup yourself, or claim you booked or saved anything. You cannot access live phone location. For a shared-location trial, tell the user to text location. Never infer their current location from conversation or claim GPS access.
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
  if (locationInput !== null) {
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
