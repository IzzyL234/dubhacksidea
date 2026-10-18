# Study flow and feedback context

## Try a manual session

Text these messages in order:

1. `start studying` creates a durable active session with a start timestamp. It does not book Calendar or start an automatic end reminder.
2. `library desk 45` records location category, seat and planned minutes (5-240).
3. Optional in the first five minutes: `starting context 3 quiet` records starting energy (1 exhausted to 5 energized) and noise (`quiet`, `moderate`, `loud`, `unknown`). Use `unknown` for energy if needed. These fields are collected, not used as predictors yet. Missing older values remain unknown. They cannot be added after the first five minutes or after ending the session.
4. `workspace bright 3 7` records lighting, clutter (1-10) and comfort (1-10). Alternatively send a workspace photo and correct its estimates. Unknown measurements are not invented.
5. `study score` estimates productivity and mood when workspace context is complete.
6. `done` captures the session end timestamp and opens a check-in. Answer productivity, mood and distraction (1-5). The saved feedback is linked to this exact session.

`study status` reports your unfinished session. `discard session` cancels it without training. Only one active or awaiting-feedback session is allowed per chat. Actual start/end timestamps and planned duration are separate; prediction currently uses planned duration. Completed, linked real feedback with complete workspace context trains personal predictions. Incomplete context is saved but excluded from the learner.

## Calendar study blocks

`reminders on` enables checks for gaps in Hackathon Demo, not every calendar. Eligible gaps are at least 30 minutes at any hour, including across midnight, with 10-minute buffers. Quiet hours are off unless explicitly set. Text `quiet hours off` to disable them. Session state and prompt limits still apply. A free gap is not proof of availability.

A study invitation needs `yes`. Calendar and (if enabled) location are checked again, then a linked session is created for up to 45 minutes of remaining open time. A linked end reminder asks you to text `done`; it does not automatically finish the session or invent feedback. The invitation explicitly includes adding the accepted session to Hackathon Demo. On yes, booking is attempted and its result is reported. If booking is not confirmed, the tracked session stays active; `retry calendar` safely retries the original event without duplicates. Manual `start studying` does not book an event. Place-confirmation yes only saves the place; a separate study confirmation is required. Keep one bot process running on an awake computer.

## Natural-language distraction feedback

When distraction is 4-5, choose interruption/setup/unsure, or describe the distraction in a sentence. Descriptions go to the existing Grok API for a structured category, with storage disabled in the request. Only the description is sent by this classifier, not the session's ratings, location, calendar or chat identifiers. The application does not persist the raw description in feedback records. This request setting is not a claim about provider-wide retention policies.

Example: `The library was fine, but my friend kept interrupting me.` The bot suggests a category and requires `yes` to save it. `no` returns to the category menu. A direct category corrects the suggestion. Negative sentiment alone must not imply a bad location; mixed evidence maps to unsure. Original ratings stay unchanged.

Model failures or invalid outputs return to explicit choices. Descriptions are limited to 800 characters and at most two model attempts per check-in; direct choices work without model calls. Pending confirmation survives restart, duplicate messages are deduplicated, and concurrent messages within a chat are serialized.

For high-distraction feedback, confirmed interruption weight is 0.25; setup/unsure weight is 1. Older records retain their legacy policy. This is a fixed influence rule, not causal adjustment. No starting-energy/noise features have been added to the 13-feature LinUCB prototype, and no synthetic history has been altered. Personal predictions use real feedback by default; synthetic seeds require `STUDY_DEMO_SEEDS=true`.

## Setup and validation

Apply the additive migrations 005 (distraction), 006 (cloud history/events), and 008 (starting context) after the original session migrations. These migration files are prepared, not applied by this change. Missing database columns leave sessions/feedback queued locally for retry; apply the migrations before use with cloud sync. Restart the bot with `bun start` after updating source. The existing XAI_API_KEY and XAI_MODEL settings are reused; no new secret is needed.

Tests cover confirmation/correction, ambiguity, API failures, schema validation, duplicate/concurrent messages, restart, baseline timing and unchanged learner inputs. All API tests are mocked; no live classifier-quality evaluation or texts are sent. Reference: https://docs.x.ai/developers/model-capabilities/text/structured-outputs
