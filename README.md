# Daywise

A runnable single-owner hackathon scheduling and decision agent. Node.js 24, a small browser dashboard, persistent SQLite or Supabase, Google Calendar REST tools, and a Photon iMessage Kit bridge for macOS. No bundler or model key is required for the demo.

## Run in two minutes

1. Install Node.js 24 or newer. Clone this repository and select the PR branch until merged.
2. Copy `.env.example` to `.env`. Set `APP_TOKEN` to a long random secret (for example, generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`).
3. Run `npm start`. No dependency installation is needed for the dashboard and local SQLite mode.
4. Open http://127.0.0.1:3000. Paste `APP_TOKEN` into the token field and click Connect. Without a configured token, the server prints a temporary one on startup.
5. Keep the server running. Data is saved in `data/agent.sqlite`, excluded from Git. This is a local app; it binds only to loopback. Open the dashboard on the computer running it.

`npm test` runs the meaningful behavior and integration-contract tests. `npm run check` checks source syntax. CI runs both on Node 24. The Node SQLite API may report an experimental warning depending on the Node release.

## Demo walkthrough

1. Save two completed study sessions at different local hours. Rate the morning session 1 and the afternoon session 5.
2. Find a 50-minute study slot. Afternoon candidates now rank above morning candidates, subject to availability. Select one and explicitly confirm the proposal below. A study session is created only after confirmation.
3. Change the six decision sliders and inspect the score and benefit/penalty breakdown. Under the optional section, customize priority weights and give an event start/end for a live conflict check.
4. Paste a flyer such as `Campus meetup\n2026-10-18 at 6 pm\nLocation: Student union`. Review the extracted hints, enter exact dates/times, propose an event, then confirm it.
5. Save a session that ended recently, then click Check reminders now. The app asks for a rating. The Mac bridge delivers queued prompts to the configured phone/account once running.
6. Try `study 50`, `rate SESSION_ID 4`, or `yes? 8 6 7 9 3 7` in the browser text simulator or via the Mac bot.

## Photon: teammate's Mac → your phone

This project deliberately selects **`@photon-ai/imessage-kit` 3.0.0**. It does not mix APIs from Spectrum, Photon cloud, or the legacy advanced SDK. That package runs on macOS, reads Messages, and sends via AppleScript. A phone number alone does not connect it. The Windows dashboard works without Photon.

### Easiest hackathon arrangement

1. Your teammate runs **both the server and bridge on their Mac**, with Node 24. Sign into Messages on that Mac with the account that will act as the bot. Prefer a separate demo Apple account; outgoing messages come from that signed-in account.
2. You send a new iMessage from your iPhone to the bot's iMessage address (Apple account email or enabled phone number). The bot account must differ from your sending account. From-me messages are ignored to prevent loops.
3. In the Mac's `.env`, set `PHOTON_PARTICIPANT` to your sender address exactly as Messages reports it. For a US phone number, use E.164, e.g. `+12025550123`. No real participant number is checked into this repository. If iMessage uses your Apple email as sender, allow that exact email instead.
4. Set `APP_TOKEN` to the same secret used by the local agent, and leave `AGENT_URL=http://127.0.0.1:3000`.
5. Run `npm ci` on the Mac. This installs the pinned Photon SDK and `better-sqlite3`; if a native binary is unavailable, install Apple's command line build tools and retry. Bun is another SDK-supported runtime, but the project scripts and tests target Node 24.
6. In **System Settings → Privacy & Security → Full Disk Access**, enable the terminal running the bridge. Reading Messages requires this permission. Allow Messages automation if macOS requests it.
7. In one terminal run `npm start`; in another run `npm run photon`. Send `study 50` from the allowed participant. Leave the Mac awake and both processes running.

The adapter accepts DMs from one configured sender and ignores from-me messages, groups, other senders, and attachment-only messages. Flyer images are uploaded through the dashboard; incoming MMS attachment ingestion is outside this MVP. Neither installation nor tests send real messages.

### SMS instead of iMessage

If the bot Mac is paired with an iPhone that has an SMS-capable number, Apple Text Message Forwarding can relay SMS to/from that Mac. Sign into the **same bot Apple account** on the bot iPhone and Mac, then on that iPhone enable **Settings → Apps → Messages → Text Message Forwarding → the Mac**. Verify sending and receiving manually in Messages first. Your personal phone then texts the bot phone's number. SMS/RCS delivery depends on carrier/Apple relay availability; it has not been tested here. A teammate's Mac by itself can use iMessage, but does not supply a cellular SMS number.

Do not pair your own phone account to the bot and expect self-texts to behave as incoming commands: those are intentionally filtered. A separate bot account/number is the clearest two-way demo. Photon `send()` resolves at AppleScript dispatch, not confirmed delivery.

## Google Calendar

Required private server environment values:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth web application's client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Offline token for the single owner's Google account |
| `GOOGLE_CALENDAR_ID` | `primary` by default, or an explicit calendar ID |

Create a Google Cloud project, enable Calendar API, configure an OAuth consent screen and add your demo user as a test user. Create a web OAuth client. For a quick single-user setup, add `https://developers.google.com/oauthplayground` as an authorized redirect URI; in OAuth Playground settings enable **Use your own OAuth credentials**. Authorize `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.freebusy`, request offline access and consent, exchange the code, and copy the refresh token into `.env`. Do not commit or share it. Testing-mode refresh tokens may expire; reauthorize when needed.

The server refreshes access tokens on demand, calls `freeBusy` before ranking slots and again before confirmation, and calls `events.insert` only after explicit confirmation. Missing configuration uses clearly labeled local calendar mode. Configured-provider failures block scheduling rather than pretending the calendar is free. No event invitations or emails are generated by this app.

Writes use a stable Google-compatible UUID-derived event ID. If an external write times out, the proposal stays `syncing`, and further writes are blocked to avoid duplicates. For this MVP, reconcile manually: locate that event ID in the configured Google calendar, then update the corresponding `events` record in the selected store to `confirmed` (with remote ID/link), or restore `proposed` only after verifying no event exists. There is no reconciliation UI yet. Google availability checking and event insertion are separate calls; another calendar client can race between them.

## Supabase sessions, ratings, and state

The default SQLite backend persists sessions, their ratings, proposals, decisions, processed-message responses, and proactive prompts. For Supabase:

1. Create a project and run `supabase/migrations/001_agent.sql` in its SQL editor.
2. Set **both** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`, then restart. Use the legacy JWT `service_role` key for the documented Bearer/apikey REST contract used here.
3. The server uses Supabase's PostgREST endpoint and upserts by `(kind,id)`. Existing local SQLite records are not automatically migrated.

The table enables RLS and grants no browser/anon/authenticated access. Only the backend holds the service key. The app token is a single-owner credential, not a multi-user auth system. Do not publicly expose this local server; production deployment needs real user authentication, per-user OAuth, quotas and a durable background worker.

## Image/flyer extraction

Text paste works without credentials. Optional JPEG/PNG image OCR uses Cloud Vision's documented `images:annotate` / `TEXT_DETECTION` endpoint:

1. Enable Cloud Vision API with billing in a Google Cloud project.
2. Set `GOOGLE_CLOUD_PROJECT` and an OAuth `VISION_ACCESS_TOKEN` with permission to call Vision (e.g. from `gcloud auth print-access-token` after configuring the project). This token is short-lived; refresh it manually for the demo and restart the server.
3. Upload an image under 4 MB. Image contents are sent to Google for OCR and are not persisted by this app.

The parser returns a title, explicit ISO date hint, am/pm time hint and labeled location hint. It leaves missing or ambiguous information unresolved. Extraction never creates an event by itself. Review dates, timezones, location and duration manually. No arbitrary URL downloads or autonomous instructions are executed from flyer content.

## How personalization and scoring work

Personalization is a small statistical learning model, not an LLM conversation. It ranks 30-minute candidate starts in the next 48 hours, inside local 08:00–22:00 hours, using nearby-hour study ratings. Prediction is `(sum(ratings) + 3 × 3)/(ratingCount + 3)`: three neutral prior ratings reduce overfitting. Ratings are 1–5; unreviewed sessions provide no training signal. Earlier starts break ties. The browser supplies its current UTC offset; travel and daylight-saving changes within the next 48 hours need manual review. Candidates check the one configured calendar and confirmed local commitments. Buffer/travel time and multiple calendars are future work.

Decision score (0–100) = weighted benefits × 10 − opportunity cost × 3 − (10 − energy) × 1.5, clipped to 0–100. Default priorities: academics 35%, social 25%, wellbeing 25%, career 15%. Weights normalize to sum to 1. A calendar conflict overrides the recommendation to Reschedule. Scores ≥60 recommend yes, 40–59 suggest a shorter version, and lower scores recommend protecting time. This is an explainable heuristic using the user's judgments, not a prediction of a guaranteed outcome. Text `yes?` commands have no event time and explicitly report that calendar conflicts were not checked.

## Proactive behavior and limits

- A minute-based checker queues one reminder within 15 minutes before a confirmed study session and one rating prompt for an unrated session that ended within the last 24 hours. It operates only while the server/bridge is running.
- Prompt IDs and expiry are persisted. The dashboard shows them; the bridge polls, sends, then acknowledges. Prompts expire after one hour. A send that succeeds before its acknowledgement fails can be delivered again (at-least-once). Only one bridge process should run.
- Inbound message IDs reuse the saved response and do not reapply a rating. The watcher itself has no durable inbound replay/retry worker; failures appear in the bridge log, and you can resend the command as a new message. A repeated callback can repeat the same reply.
- The app serializes API mutations within one process. Run one server instance per store. No multi-process locking or distributed queue is provided.
- There is no general natural-language planner, automatic consent to invitations, multi-user onboarding, calendar edit/delete tool, or production deployment in this 48-hour scope.

## API map

All `/api/*` routes require `Authorization: Bearer APP_TOKEN`. POSTs require JSON. Static assets are public on loopback. Timestamps must include an explicit timezone offset.

| Route | Behavior |
| --- | --- |
| `GET /api/status` | Sessions, ratings, events, decisions, prompts, integration status |
| `POST /api/slots` | `{minutes, offsetMinutes}` → ranked free slots |
| `POST /api/sessions` | `{title,start,end,localHour}` → saved session |
| `POST /api/ratings` | `{id,rating}` → updated session |
| `POST /api/decisions` | `{title,academic,social,wellbeing,career,cost,energy,weights?,start?,end?}` |
| `POST /api/proposals` | `{title,start,end,study?,localHour?}` → pending proposal |
| `POST /api/confirm` | `{id}` → conflict check and confirmed event |
| `POST /api/flyer` | `{text}` or `{image:base64}` → reviewable hints |
| `POST /api/messages` | `{id,text,offsetMinutes?}` → command response |
| `POST /api/tick` | `{}` → pending non-expired prompts |
| `POST /api/ack` | `{id}` → acknowledge a prompt |

## Validation and documentation sources

Tests exercise persistence, personalization, malformed inputs, confirmation and idempotency, uncertain writes, provider failures, proactive deduplication, message IDs, HTTP authentication and host restrictions, and mocked Google/Supabase/Vision request contracts. Live Google, Supabase, Vision and macOS Photon calls require owner credentials/hardware and have not been verified in this Windows environment. The installed Photon 3.0.0 declarations were checked for the constructor, watcher callbacks, message fields, send signature, and teardown method.

- [Photon iMessage Kit official SDK](https://github.com/photon-hq/imessage-kit)
- [Apple Text Message Forwarding](https://support.apple.com/en-us/102545)
- [Google Calendar freeBusy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Google Calendar events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Google offline OAuth refresh flow](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
- [Supabase REST API](https://supabase.com/docs/guides/api)
- [Cloud Vision OCR](https://docs.cloud.google.com/vision/docs/ocr)
