# Proactive coordinator

The running bot polls location and calendar once a minute. This is a local process, not a hosted service: the computer must remain awake and connected. Starting the process is still required after a computer restart.

Production enables `eventDriven` in SmartPrompts. Fresh location evidence must establish at least three distinct captures spanning three minutes. Recent captures (at most five minutes old), prior reviewed signals, API backoff and prompt history persist locally. Coordinates remain in private local settings, not model prompts.

The coordinator reviews a first stable context, changed place, calendar window, session status, learning/rankings, confirmed notes, preferences, or a scheduled 30-minute review. Identical one-minute polls do not call the language model. Busy sessions collect location evidence without sending new invitations.

Decisions receive real LinUCB outcomes and uncertainty, confirmed optional context, and current session state. The language model chooses among quiet, arrival check-in, optional place saving, and study invitation. Code validates and executes the action. Session creation and advance calendar booking still require user acceptance.

There is a one-minute minimum between model reviews, at most 48 reviews per Pacific day, and at most six proactive invitations/check-ins per day. Notifications retain a ten-minute cooldown, skip snooze, quiet-hour preferences and duplicate-delivery protection. API failures back off exponentially; a Gemini 429 respects a reported retry delay or waits an hour. Restarting does not erase these limits.

All text-model features use `AI_PROVIDER`, default `xai`. xAI uses `XAI_API_KEY` and optional `XAI_MODEL` (default `grok-4.7`). Selecting `AI_PROVIDER=gemini` uses the existing Gemini key and optional model. Provider fallback is explicit, never automatic. Perceptron remains the photo extractor. No fine-tuning is performed; personalization comes from recorded history, confirmed context and LinUCB updates.
