# Linked study sessions

## One-time setup

Run `supabase/004_session_lifecycle.sql` in your existing Supabase SQL Editor. It preserves existing records, allows incomplete context at session start, and adds lifecycle/provenance fields. Supabase `study_sessions` rows contain session context; `study_feedback` contains the actual ratings and its `session_id` links them. Existing standalone feedback stays unlinked rather than being retroactively assigned to a guessed session.

For photos, add `PERCEPTRON_API_KEY` to your local `.env` yourself. Optional `PERCEPTRON_MODEL` defaults to `perceptron-mk1.5`. Never commit credentials. This TypeScript adapter calls the documented Perceptron Chat Completions endpoint directly; no separate Python server is required. The team's Python extractor is preserved. Live photo access needs a working Perceptron account/key and has not been verified by mocked tests.

Restart the bot with `bun start`. Run one bot process. New sessions and feedback stay private locally under gitignored data folders and retry Supabase sync. A linked feedback row uploads only after its parent session exists.

## Try by text

1. `start studying`
2. `library desk 45` — your location, seat, and **planned** minutes. Places: home, dorm_room, library, classroom, cafe. Seats: chair, desk, shared_table, bed, beanbag. Planned minutes: 5–240. These values are explicitly supplied rather than inferred from a photo.
3. Send a JPEG, PNG, or WebP photo under 8 MB. Perceptron estimates lighting, clutter, and visible ergonomics. If seating/posture cannot be assessed, the bot asks for `comfort 7` (use your own 1–10 answer). Images are sent to Perceptron for processing but are not saved by this bot.
4. Without a key/photo, use `workspace bright 3 7`: lighting (dim/bright), clutter (1–10), comfort (1–10). These are self-reports and are tagged separately. The same command corrects a photo estimate.
5. `study score` — predicts productivity and mood for this context. It reports synthetic starter-example and personal linked-check-in counts.
6. `done` — freezes the session's context/end time and asks productivity, mood, distraction (each 1–5). Only high distraction asks the optional source.

`study status` shows missing context. `discard session` abandons an unfinished session and its pending check-in. `cancel` cancels the rating questions; you can resume with `rate session`, or discard the session. `reset` resets conversation/check-in memory without silently discarding a real study session.

## What learning means here

Each prediction rebuilds your personal reward models from 40 synthetic starter records plus your completed, linked check-ins. Durable records make the update survive bot restarts without accumulating duplicate training events. Other conversations' real feedback is excluded. Unknown or incomplete contexts, abandoned sessions, and unlinked check-ins are not training observations. Start a subsequent session and use `study score` to see a prediction incorporating previous linked ratings.

Productivity and mood remain separate ridge reward predictors used by the existing LinUCB policy. Weighted updates use A += w xxᵀ and b += w xy. High distraction (4–5) explicitly attributed to phone/other receives w=0.25; otherwise w=1. The original rating is unchanged. This is a configurable design heuristic intended to reduce unrelated-noise influence, not causal correction or a learned explanation. It downweights the whole observation, including both outcomes, and cannot isolate which individual environment feature caused an outcome. A detected phone is not automatically classified as an actual distraction. Post-session distraction is not a pre-session predictor (avoids outcome leakage).

Duration is planned duration, matching the current predictor's input; started_at/ended_at also record real timing. No learned time-of-day effect is claimed. The image adapter does not guess exact location, mood, productivity, or actual distraction, and never substitutes mock observations for an unavailable API.

OwnTracks arrival-to-session automation, calendar triggers, and proactive notifications are separate unfinished integrations. This flow works manually while the phone is being updated.

## Verification

`bun test ./tests/sessions.test.ts ./tests/learning.test.ts ./tests/feedback.test.ts ./tests/feedback-cloud.test.ts ./tests/location.test.ts ./tests/owntracks.test.ts`

Tests exercise restart/replay, session/feedback foreign-key ordering, deduplication, local retention after network failure, photo validation, and reduced weighted-update influence. They do not send phone messages or claim real Perceptron accuracy.

References: https://photon.codes/docs/spectrum-ts/messages , https://photon.codes/docs/spectrum-ts/content/attachments , https://github.com/perceptron-ai-inc/perceptron , https://www.perceptron.inc/blog/introducing-perceptron-files-api .
