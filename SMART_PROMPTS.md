# Location-aware study suggestions

This is optional: normal `reminders on` still offers calendar openings without location. To use location plus a conservative Grok decision:

1. Keep sharing Find My location with the bot's iMessage account.
2. Restart the bot in PowerShell: `cd C:\Users\Isabe\my-project`, then `bun start` (stop the previous process with Ctrl+C first).
3. While physically at a study place, text `remember place library`. Other labels: `cafe`, `home`, `dorm_room`, `classroom`. This saves your current coordinates as a 200-meter region; it does not infer the building.
4. Text `smart prompts on`. This also connects the demo-calendar reminders to this chat.
5. Use `proactivity status` or `why quiet` to inspect checks. `smart prompts off` stops reminders; `forget places` deletes saved place coordinates.

No new secrets or database migration is required for this feature. It uses existing Photon credentials, Google Calendar authorization and XAI_API_KEY. Calendar access is limited to Hackathon Demo. Keep one bot process running on an awake computer.

## How it decides

The timer checks once a minute. Quiet hours, an unfinished session/check-in, an outstanding invitation, cooldowns and the daily invitation budget suppress new invitations first. Eligible gaps are at least 30 minutes between calendar commitments, with the existing 10-minute buffers and 9 AM–8 PM Pacific study window. A free calendar is only a possible opportunity.

Location must have a capture timestamp within two minutes, reported accuracy of 100 meters or better, and source `live` or `shallow`. The accuracy region must fit inside a saved place. Three or more distinct readings spanning three minutes within the most recent five minutes must remain within 75 meters of one another. Re-reading the same cached capture cannot establish presence. Restarting clears this in-memory evidence; it must build up again. Samples are collected only when the other invitation gates pass. These are conservative heuristics, not proof that the person is studying or available.

After those gates, Grok receives only the saved place category, timing/accuracy summaries, free minutes and recent accepted/skipped counts. It returns a validated structured decision. Unavailable or invalid responses and confidence below 0.75 stay quiet; that threshold is a heuristic, not a calibrated probability. Calls are capped at four per Pacific day with at least ten minutes between decisions. Invitations are capped at two per day; skipping pauses invitations for an hour. Calendar and session state are checked again before sending. Replying yes rechecks calendar and location before creating the existing linked study session. No calendar event is booked automatically.

LinUCB remains the separate personalization model for study outcomes. Invitation outcomes guide the decision prompt; they do not retrain a notification model or establish causal effects of an environment.

## Privacy and verification

Saved place centers and the sender address are stored locally under gitignored `data/proactivity/`. Raw recent location samples remain only in memory. Coordinates, phone numbers and event titles are excluded from decision-model input and the decision log. The log retains at most 100 entries with fixed reason codes; accepted/skipped history is limited to seven days and 50 entries. Saved centers are approximate labels, not automatically discovered locations. The ordinary chat model still receives ordinary messages sent to it.

The implementation uses Photon Advanced iMessage `locations.get(senderAddress)`; it never enumerates other people's location shares. A readable snapshot does not guarantee continuously refreshed coordinates. If Photon keeps returning a stale timestamp or omits accuracy, the feature stays quiet. Real movement and background refresh must be checked on your phone; automated tests use synthetic location readings and do not send texts.

References: [Photon location API](https://photon.codes/docs/advanced-kits/imessage/locations), [xAI structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).
