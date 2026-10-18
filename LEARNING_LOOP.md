# Supabase learning loop

This update adds durable cloud event history and makes each `study score` rebuild the personal model from completed Supabase sessions/feedback plus pending local feedback. It does not train a language model or yet use LinUCB to choose proactive invitations.

## Setup

Run the SQL in `supabase/005_distraction_attribution.sql`, then `supabase/006_learning_events.sql`, in the existing project's SQL Editor. These are additive and preserve existing records. Migration 006 requires the existing feedback table and session lifecycle migration 004. The dashboard's service-role access remains backend-only; no keys change. Restart the bot afterward.

The backend retries session, event and feedback uploads every minute while running. Failed uploads stay in private local files. Proactivity events are keyed by stable UUIDs; a retry updates the same row. Coalesced repeated quiet reasons update their occurrence count. Unsynced events are kept separately from the bounded display log so log truncation cannot discard them. Uploads are flushed in batches of up to 20 per minute. Network requests run outside the chat-state lock so a slow upload does not block conversation commands. Keep one bot process running per private state directory.

## Data

- `study_sessions` and `study_feedback`: existing linked session context and your explicit ratings. Parent sessions upload before feedback.
- `study_learning_history`: service-role-only view joining completed sessions to their exact feedback ID, for the same hashed user. Synthetic records are excluded. Scoring also validates ownership, context and ratings, deduplicates feedback IDs, and reads only that user's rows.
- `proactivity_events`: hashed user key, timestamp, action, fixed reason, occurrence count, place category, sanitized decision-time numeric facts when available, and related decision ID for accepted/skipped study offers. Coordinates, phone numbers, chat text and calendar event titles are not uploaded here. These events are decision attempts, not proof that a text was delivered; sending can fail after reservation. Missing user responses are not recorded as negative ratings.

Model history is loaded on each new score, including after a restart. Replaying a small history gives the latest linear model without counting a rating twice. If cloud history is unavailable, the reply explicitly says local-only; it does not claim to have used cloud records. Records missing workspace context are stored but excluded from learning rather than filled with invented features. Per-user history above 10,000 rows fails explicitly instead of silently truncating. Long-term deployment should use model checkpoints and versioned features.

Personal scoring uses real observations by default. `STUDY_DEMO_SEEDS=true` explicitly includes the existing synthetic dataset and labels the score as a demo. The standalone learning tests/demo still exercise the seed data. Before personal feedback, predictions start neutral and uncertain.

The next implementation step is to connect a complete-context personalized ranker to feasible study plans. Sentiment/energy and learned notification timing remain separate future work. The current Grok invitation policy is unchanged; its decision/outcome history is now ready to analyze.
