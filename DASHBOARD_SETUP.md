# Framer learning dashboard

The `LearningPanel` component is saved on the Framer `/about` (AI Learning) page. It reads a private, read-only Supabase endpoint; database credentials never enter Framer.

## Deploy

1. Run `009_dashboard_access.sql` in the Supabase SQL editor. Existing session, feedback, learning-history and proactivity migrations must already be applied.
2. Deploy `supabase/functions/model-dashboard` as `model-dashboard`. The standalone `model-dashboard.ts` file is the same function bundled for the dashboard editor.
3. Set function secret `DASHBOARD_ALLOWED_ORIGINS` to:
   `https://moccasin-message-081741.framer.app,https://project-5sbbbqtjvcomqn7izsfm.framercanvas.com`
   Add any future custom domain explicitly. No wildcard origins.
4. Disable the platform's legacy JWT verification **only for this function** (`verify_jwt=false` in its configuration). Its handler checks its own random, expiring dashboard token before any personal-data query. Keep existing RLS and table permissions enabled.
5. Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` inside the function. The bot uses its existing `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Never put either secret key in Framer or commit them.
6. The Framer component API URL is `https://dhnmqgxjxwlfsmoaogvh.supabase.co/functions/v1/model-dashboard`.

## Use

Restart the updated bot, then text `dashboard code`. Paste its private code into the panel in Framer Preview or the published page. The code grants access to that chat's ratings, predictions and decisions for 24 hours. Requesting a new code replaces the old one; `disconnect dashboard` revokes it. “Disconnect this browser” clears only that browser's session.

The component refreshes every 10 seconds while visible. The running bot normally uploads records about once per minute. “Connected” refers to the data API, not a bot heartbeat. Empty personal history stays empty; sample records are not added. Unlinked feedback cannot train the model until linked to a completed session with valid workspace context.

Predictions use the bot's existing LinUCB / weighted ridge implementation. External interruptions receive the same reduced observation weight as in the bot. Coefficients describe associations, not causal effects. Coordinates, phone numbers, raw chat text, internal user identifiers and database keys are excluded from responses.

## Validation

- Nine dashboard tests cover token expiry, revocation, duplicate message handling, ownership checks, synthetic-data exclusion, distraction weighting, CORS and backend outages.
- Full bot suite: 156 passed, zero failed.
- Bot and React component bundle successfully; dashboard modules pass strict TypeScript checks.
- Saved Framer component renders in the existing page preview. Live data requires completing the deployment above and connecting with a private bot code.
