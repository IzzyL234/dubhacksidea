# Learning-backed proactive coordinator

## Roles

LinUCB is the numerical learner. It predicts productivity and mood, uncertainty, and ranking scores from completed, correctly linked real sessions. The proactive coordinator is one selected LLM (Gemini or Grok) that chooses a supplied session option or stays quiet. Existing deterministic code rechecks context, asks for confirmation, starts tracking, books Calendar, and verifies the result. There is no second execution LLM and no Gemini-Grok debate.

Regular chat and natural-language distraction extraction continue to use the existing Grok integration. Selecting Gemini changes the proactive decision provider, not every model in the app. Workspace photo extraction remains Perceptron.

## What is now connected

After location/calendar/session gates pass, the bot loads that user's local and Supabase linked feedback. It excludes synthetic starters from live proactive choices even when demo mode is enabled. It builds up to three historical workspace profiles matching the current location category, and feasible duration options (25 minutes and up to 45 minutes, bounded by the opening).

Each option includes predicted productivity/mood, LinUCB uncertainty/selection score, the matching sample count, historical age, and an explicit historical basis. The coordinator receives these values plus free time, location quality, and recent accepted/skipped counts. It chooses an existing option ID or stay_quiet. The validated choice determines the invitation and the duration carried into the tracked session and Calendar booking after yes. The offer says up to the selected minutes, since time may pass before acceptance.

Historical seating/lighting/comfort are assumptions, not current measurements. The new session still requests actual workspace context; it does not copy those old measurements as facts. If there is no matching history, options have null predictions and the offer says personal history is missing. Category-level library history is not evidence about a particular named building. Travel, other locations' opening hours, and deadlines are not inferred.

Starting energy/noise are still collection-only. Accepted/skipped signals are timing feedback, not productivity labels. Interruption weighting remains in the numerical learner. Only valid, completed, linked real observations train personal estimates; no synthetic history has been rewritten.

## Gemini setup

Add these settings yourself in the existing private environment configuration (never paste an API key into chat or Git):

```
STUDY_COORDINATOR_PROVIDER=gemini
GEMINI_API_KEY=<your private Gemini API key>
GEMINI_MODEL=<the exact generateContent model ID enabled for your account>
```

The model must support JSON structured output. No model ID is guessed by the application. The key is sent in an HTTP header, not a URL. The coordinator uses the Gemini generateContent endpoint with a bounded structured response, validates the option ID, and ignores returned thinking text. Provider-level data handling is governed by your Gemini account terms; request facts omit coordinates, chat IDs, phone numbers and raw feedback text.

Without an explicit provider, Gemini is selected only when both GEMINI_API_KEY and GEMINI_MODEL are configured; otherwise Grok remains the coordinator. `STUDY_COORDINATOR_PROVIDER=grok` explicitly selects the existing Grok adapter. Explicit selection wins. There is no automatic cross-provider fallback on a blocked, failed, incomplete or invalid decision.

The existing XAI_API_KEY is still required for regular chat. No new database migration or package dependency is needed. Restart the single running bot after configuration. `proactivity status` shows the selected provider and the observation count from the last evaluated learning context; `why quiet` shows gate reasons.

## Limits and validation

The coordinator currently chooses whether to offer studying at the current confirmed place and which supported duration to offer. It does not rearrange your day, choose subjects, or book somewhere else. This is a bounded coordinator, not an unrestricted tool-calling loop. Existing daily invitation/model budgets, cooldowns, quiet-hour preferences and duplicate protection remain. Location is checked again after the decision; calendar/session state is revalidated before sending and accepting.

Tests use synthetic fixtures and mocked provider requests. They verify that opposite session histories change ranked durations, the chosen duration reaches actual booking code, no unknown workspace scores are invented, users are isolated, and model responses cannot invent option IDs. Live Gemini access and decision quality require a configured key/model and real-world evaluation; unit tests do not establish them.

References:
https://ai.google.dev/gemini-api/docs/structured-output
https://ai.google.dev/api/generate-content
