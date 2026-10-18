import { StudySessions } from "../src/sessions.ts";
import { FeedbackFlow } from "../src/feedback.ts";
import { configuredFeedbackSink } from "../src/feedback-cloud.ts";

try {
  const sink = configuredFeedbackSink();
  if (!sink) throw new Error("Add SUPABASE_URL and SUPABASE_SECRET_KEY to your local .env");
  const count = await sink.check();
  console.log(`Connected to study_feedback${count === null ? "" : ` (${count} saved check-ins)`}.`);
  const sessions = new StudySessions();
  await sessions.syncPending();
  const result = await new FeedbackFlow(undefined, sink, {
    afterSave: record => sessions.completeFeedback(record),
    beforeUpload: record => sessions.ensureCloud(record),
  }).syncPending();
  console.log(`Uploaded: ${result.synced}. Still pending locally: ${result.pending}.`);
  if (result.pending) process.exitCode = 1;
} catch (error) {
  // Never print request objects or authentication headers.
  const message = error instanceof Error ? error.message : "";
  console.error(/^(Create study_feedback|Supabase feedback read failed|Add SUPABASE_URL|Use your Supabase)/.test(message)
    ? message : "Feedback sync could not finish. Your local copies are kept; check your connection and retry.");
  process.exitCode = 1;
}
