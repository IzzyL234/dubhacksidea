# Location-aware study suggestions

This is optional: normal `reminders on` still offers calendar openings without location. To use location plus a conservative Grok decision:

1. Keep sharing Find My location with the bot's iMessage account.
2. Restart the bot in PowerShell: `cd C:\Users\Isabe\my-project`, then `bun start` (stop the previous process with Ctrl+C first).
3. Text `smart prompts on`. This also connects demo-calendar reminders and enables nearby-place discovery. You do not need to name the place first.
4. After stable readings at an unfamiliar place and a suitable calendar gap, the bot may ask whether to save a nearby named library or cafe. Reply `yes` to save only the place, or `skip` to dismiss it. A later study invitation needs its own confirmation. If automatic discovery finds no clear match, `remember place library` remains an optional fallback; other manual labels are cafe, home, dorm_room and classroom.
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

## Automatic nearby-place discovery

After the same three-minute stability checks at an unknown place, the bot queries OpenStreetMap Overpass through the documented Private.coffee public instance, with the main overpass-api.de instance as a sequential fallback. Requests contain coordinates rounded to three decimal places (roughly a hundred meters), no phone number, chat ID or calendar data. The service still receives an approximate location and the server IP. Use `place discovery off` to stop these lookups while keeping saved-place recognition, or `place discovery on` to re-enable them.

Only named libraries and cafes within 150 meters are candidates. When two candidates are within 40 meters of one another in distance from the phone, no place is suggested. This is an approximate center-based lookup, not an indoor-position detector. Named places are untrusted map data and never supplied as model instructions. User confirmation is required before saving any candidate. Confirmation needs a fresh reading whose accuracy region still fits within 200 meters of the venue. Multiple confirmed libraries/cafes retain separate map IDs.

Lookup cycles have a persisted 15-minute cooldown and four-per-day budget (at most eight HTTP requests if every cycle needs its fallback). Place-confirmation questions share the existing two-per-day invitation cap and ten-minute prompt cooldown; a new place can therefore use one of the day's two invitations. Skipped venues are remembered locally (up to 100 dismissed IDs) and not suggested again unless that history is removed. Failed/ambiguous map results stay quiet and are visible in `why quiet`. Questions expire after ten minutes. Turning smart prompts off or forgetting places clears pending place candidates. The first visit may need a second short period of stable readings after confirmation; future visits recognize the saved spot automatically.

Map data: © OpenStreetMap contributors, ODbL. [Overpass public instances and usage policies](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).

A public-campus live check returned named UW venues, but subsequent public-service requests returned HTTP 500/timeouts. The service is not guaranteed available; the bot stays quiet during outages.
