# Study agent

Text-based study assistant built with Photon Spectrum and Grok. Reads a demo Google Calendar and collects productivity, mood, and distraction feedback. A separate contextual-bandit demo learns workspace preferences from synthetic study sessions.

## Run the bot

Requires Bun. In the project folder:

```sh
bun install --frozen-lockfile
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp` if needed. Edit `.env` locally with your Photon project credentials and xAI API key, then run:

```sh
bun start
```

Commands:

- `What's coming up?` or `calendar`: reads the next five events on the configured demo calendar.
- `rate session`: asks productivity, mood, and distraction, each 1–5. Distraction 4–5 triggers an optional source question.
- `cancel`: cancels an active feedback check-in.
- `reset`: resets the AI conversation and any unfinished check-in.
- Other messages: conversational Grok replies.

## Calendar setup

Create a Google Cloud Desktop OAuth client with Calendar API enabled. Save its downloaded credentials as `credentials.json` beside `package.json`. Set your calendar ID in `calendar-test.mjs` and `src/calendar.ts` (the current values refer to the team's demo calendar). Run `bun calendar-test.mjs`, sign into the account that owns or can access that calendar, and approve read-only event access. The resulting token stays local. In OAuth Testing mode, add that Google account as a test user.

## Learning demo and tests

```sh
bun scripts/learning-demo.ts
bun test tests/learning.test.ts tests/feedback.test.ts
```

The learning demo uses 40 synthetic records, two ridge reward predictors, and LinUCB ranking. It prints predictions, a chronological holdout comparison, and an illustrative update. See `LEARNING.md` for the model and its limits. It does not claim learned time-of-day preferences. The learner is not yet connected to the bot's feedback records.

## Supabase status

Optional backend settings are `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (a key starting `sb_secret_`). Run `bun supabase-test.mjs` to test read access to `public.study_sessions`. The table setup is in `supabase/001_study_sessions.sql`.

Supabase is not yet wired into feedback saving. Completed check-ins and unfinished conversations persist privately under `data/feedback/`. They are not linked to calendar events or automatically used to train the model. Calendar creation, proactive notifications, and shared feedback syncing are future steps.

## Private files

Never commit `.env`, `credentials.json`, `.google-calendar-token.json`, or `data/feedback/`. Each teammate supplies credentials locally; the example environment file contains names only. Run one bot process for this local feedback store.

The root `generate_seed_sessions.py`, `seed_sessions.json`, and `analyze_workspace.py` are the team's existing data/vision work. The bot does not currently call the vision service.
