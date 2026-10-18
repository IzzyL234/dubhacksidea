# Live Daywise web app

This branch builds on `webapp`, keeping its design and existing proposal screen. The private learning dashboard uses the same expiring code as the Framer version.

## Run

In your existing project checkout, install dependencies with `bun install`, then run `bun run web`. Open `http://localhost:3000`. Keep `bun start` running in a separate terminal for messages and background jobs. No second messaging process is needed.

Your existing gitignored Google OAuth token files continue to connect the real Google Calendar. The website now shows only events returned by that connection; an empty calendar stays empty, and a failed connection shows unavailable. Event times display in Pacific time. Upcoming events are capped at five, with a link to Google Calendar.

Optional runtime settings:

- `PORT`: website port, default `3000`.
- `FRONTEND_URL`: the website's public URL, required for review links that open from a phone. A phone cannot open a laptop's localhost URL.
- `GOOGLE_CALENDAR_ID`: defaults to the already connected calendar; use `primary` only if intentionally switching to the authorized account's primary calendar.
- `GOOGLE_CALENDAR_TOKEN_FILE` / `GOOGLE_CALENDAR_WRITE_TOKEN_FILE`: optional absolute paths when the website runs from a separate checkout. Existing token filenames are the defaults.
- `SCHEDULE_REVIEW_DIRECTORY`: optional absolute path to the bot's private `data/schedule-reviews` folder when the website runs from a separate checkout. Both processes must use the same folder on the same host. Do not put it in a public/static directory.
- `SUPABASE_URL`: existing project URL. The website's read-only dashboard proxy requires no database service key; background jobs use the bot's existing server credentials.

Never commit `.env`, Google credentials/tokens, or private `data/` runtime folders.

## Connect private history

Text **dashboard code** to the bot. Paste the code into Dashboard. It expires after 24 hours and only opens that chat's data. Disconnecting clears this browser's code. Text **disconnect dashboard** to revoke it everywhere.

Get Started has Library/Cafe/Home/Dorm/Classroom selection with live productivity and mood estimates. Distraction uses the available place history, falling back to overall recent ratings. It is an observed outcome, not a third predicted reward head.

## Activate daily insights and conflict review

1. Run `supabase/012_schedule_reviews.sql` and `supabase/013_study_insights.sql` in Supabase SQL Editor. Prior dashboard migrations 009–011 must already be applied.
2. Redeploy the existing `model-dashboard` Edge Function with the updated bundled source. Keep its existing custom dashboard-code authentication and `verify_jwt = false` setting. The same-origin website proxy means no new browser origin or database key is needed.
3. Restart the messaging bot once after switching to this branch.

Insights at `/insights` combines starter examples and owned linked check-ins. It reports distraction averages, high-distraction counts, and interruption/setup attribution. An initial preview works with the older dashboard endpoint; the saved daily report requires the deployment above. Reports publish at 8 PM Pacific, catch up after downtime, and persist privately in Supabase. The bot must stay running. Forty starter rows now have reproducible distraction ratings and attribution; high-distraction interruptions receive the same reduced learning weight as equivalent personal feedback.

Text **reminders on**, then **schedule review on** for proactive conflict reviews, or **review schedule** for a check now. Reviews follow quiet hours, wait while a study/check-in is active, and send at most one notification every six hours. Only personal, non-recurring events created through this bot are candidates for a move. Meetings, all-day events, and tracked study sessions stay fixed.

Each message links to `/review/REVIEW_ID`, a dedicated page with old/new times, overlapping events, overlap removed, time shifted, and available study-model context. **Approve calendar change** applies the move; **Deny suggestion** leaves Calendar unchanged. The current model does not learn time-of-day benefits. Bot commands **approve change REVIEW_ID** and **skip change REVIEW_ID** still work.

Review links use a separate random, expiring permission limited to that proposal. The token arrives in the URL fragment, is removed from the address bar, and is sent only to the same-origin review API. Dashboard codes remain read-only and cannot approve changes. Anyone holding a review link can act on that one proposal, so keep it private. Expired/changed proposals cannot edit Calendar; approval rechecks the event version, original conflict, and destination availability. Repeated approvals recover the same change without creating events. Web and bot actions share a file lock and private state; this implementation requires one host/shared disk, not separate serverless deployments. If a process crashes while holding `.review-lock`, stop both processes before removing that leftover lock and restarting.

For a walkthrough, run `bun scripts/seed-calendar-review.ts`. It adds a study block and overlapping project meeting in a clear upcoming window of the connected calendar. It never approves or moves them. Then text **review schedule** and open the private link. Public HTTPS hosting and `FRONTEND_URL` are still required for links to work from a phone; the laptop preview works locally only.

During studying, fresh stable location evidence can attach a known category. If the category is still unknown when finishing, the bot asks **Where were you studying?** A short description or category is accepted; **skip** preserves unknown. The session end time is frozen before this question, and productivity/mood/distraction ratings still follow.

## Validation

Bot tests cover private dashboard ownership, location fallback, model consistency, daily report rollover, conflict approval and replay protection, and unavailable/empty live calendars. The web app and bot both build with Bun. Main and the teammate's `webapp` branch are unchanged.

The teammate's existing `/approve/:batchId` planner screen remains available. New private conflict reviews use their own authenticated page and do not execute through that legacy screen.

## Interactive website and Vercel

The **How it works** tab at `/how-it-works` includes a technical SVG architecture diagram, the 19-feature encoder, weighted LinUCB scoring formula, feedback updates, coordinator gates, and conditional calendar execution. Four interactive components explain implementation details, followed by design benefits and model limitations. The floating **Daily** mascot is a project guide: questions are matched to curated public project notes in the browser. It makes no live LLM call, reads no personal study history, and cannot execute calendar actions. Unknown questions receive an explicit fallback. Nickname and reduced-motion preferences stay in browser storage. Use the bot to start, finish, and rate sessions.

`vercel.json` hosts only `frontend/` and the bundled `api/index.mjs`. The hosted API proxies the existing private Supabase dashboard endpoint, with no database service key or Google OAuth tokens. Shared local calendar, OAuth, and legacy demo-write routes are deliberately unavailable publicly. Connect your private dashboard code to see that chat's synced calendar and model.

For a permanent deployment, import this repository into Vercel using **Other** as the framework, repository root, and this feature branch for a preview. The supplied configuration sets the output directory to `frontend`. The CLI equivalent is `bunx vercel deploy` after signing in. An unsigned-in temporary preview can be created with `bunx vercel deploy --temporary --yes` after publishing approval; keep its claim link private and claim it in your Vercel account. Vercel sign-in created an account-owned project during this session. The original site is https://webapp-checkout-eight.vercel.app; the technical architecture page and project-guide widget were subsequently approved and deployed to production. The GitHub-to-Vercel connection did not complete, so pushes do not yet deploy automatically; use the CLI until that connection is configured.

Phone calendar reviews also need the existing bot/review state on an always-running host. Run `bun src/review-worker.ts` beside the bot with the same `SCHEDULE_REVIEW_DIRECTORY` and Google token files, behind an HTTPS reverse proxy. The worker defaults to loopback port 3003 and exposes only the capability-protected review API. Set **REVIEW_BACKEND_URL** in Vercel to its HTTPS origin, and set **FRONTEND_URL** for the bot to the Vercel website origin. Do not publicly expose the full development web server. The messaging loop and file-based approval state cannot be moved into an ordinary short-lived Vercel function unchanged. If the review backend is absent, the hosted page explains that approval is unavailable and the bot-chat commands remain usable.

`.vercelignore` allowlists website assets, the small hosted API and its shared pure helpers, package metadata, and synthetic starter data. It excludes private runtime state, `.env`, Google credentials/tokens, photos, and personal study records. Keep those exclusions when deploying from a populated checkout.

UI references reviewed: [Motion](https://github.com/motiondivision/motion) and [Floating UI](https://github.com/floating-ui/floating-ui), both MIT-licensed. The companion uses the project's existing penguin SVG, native CSS animation and standard browser APIs; no third-party UI code or new animation dependencies were copied. Native behavior keeps this small vanilla-JavaScript site lightweight. Reduced-motion preferences are respected.

The hosted API is bundled with `bun run build:hosted` from `src/hosted-entry.ts` into `api/index.mjs`. Commit the regenerated bundle when changing hosted API source. This avoids TypeScript import-path differences in the Node deployment runtime. The Vercel build runs this command as well; the bundle itself has no runtime package dependencies.

