# Calendar study reminders

## Try it

Restart the bot with `bun start`, then text `reminders on` to the bot from the chat where you want reminders. This binds the existing Hackathon Demo calendar to that chat. Only one chat can own this shared demo calendar at a time; turn reminders off there before moving to another chat.

Create a timed event titled `Study math` (or another title containing the whole word study/studying) in **Hackathon Demo**, starting a few minutes from now and lasting 5–240 whole minutes. All-day, canceled, unrelated, and unsupported-duration events are ignored. No new Calendar permission or database migration is required for reminders themselves; linked session uploads still require the previously supplied `supabase/004_session_lifecycle.sql`.

At the start, the bot asks if you're ready. Reply `yes` to create a linked session, or `skip` to leave it unstarted. Calendar duration supplies planned minutes. Reply `library desk` with your actual place/seat, then send a photo or use `workspace bright 3 7` for self-reported lighting/clutter/comfort. Location is not inferred from calendar plans or photos.

If you confirmed the session and it's still active, the bot sends one follow-up at the calendar block's end. Text `done` when actually finished to answer the existing ratings and connect them to that session. Finishing a session manually suppresses the later calendar follow-up. The scheduled end is not assumed to be the actual time you finished studying.

## Controls

- `reminders on` / `reminders off`: enable or stop reminders for the connected chat.
- `reminders status`: show status.
- `quiet hours 22 8`: set quiet hours using 24-hour start/end hours from 0–23. Defaults to 10 PM–8 AM **America/Los_Angeles**, with daylight saving handled. Daytime quiet windows also work. Replies to your own commands are still sent during quiet hours.

If testing outside quiet hours, no change is needed. You can adjust the hours for a demo, then restore them. `study status`, `rate session`, `discard session`, and existing check-in commands continue to work.

## Behavior and limits

The bot polls Calendar once per minute while running. Your computer must stay awake, online, and running the bot. This is not an always-on cloud scheduler, and no texts are sent merely by installing the code. A phone test is still necessary to verify actual delivery.

Start prompts are eligible only during the first five minutes of a study block. A pending prompt expires after ten minutes or at the block's end, whichever comes first. A start is revalidated against Calendar when you reply yes, so canceled/rescheduled/ended blocks cannot create stale sessions. Distinct recurring instances have distinct Calendar IDs. Already-attempted instances are not repeatedly prompted after an edit.

The bot avoids new start prompts while a study session or rating check-in is open, permits only one pending start prompt, and applies a ten-minute cooldown between proactive prompts. The linked session's end follow-up is exempt from that cooldown but is sent only once, within fifteen minutes after the scheduled end, outside quiet hours, and while no check-in is open. Overlapping, missed, or quiet-time blocks can therefore be skipped. It does not replay a backlog of old reminders after a long shutdown.

Private reminder state, the target chat ID, and event attempt markers persist under gitignored `data/reminders/`. Markers are saved before sending. If delivery fails ambiguously, the bot does not retry that prompt automatically: this prefers a missed prompt over duplicate texts. Manual session commands remain available. Run one bot process; this local state does not coordinate multiple deployments. The state is not uploaded to GitHub or Supabase.

OwnTracks arrival events are still a separate integration. This version uses Calendar timing and explicit confirmation, not automatic presence detection.

## Validation

Tests cover quiet hours/DST, restart deduplication, opt-in chat binding, confirmation/skip, cancellation, stale events, failure paths, and idempotent calendar-linked session creation. The existing session, ratings, photo, learner, and location tests also run. Tests use fake delivery and do not send real texts.

Official references: https://developers.google.com/workspace/calendar/api/v3/reference/events/list and https://photon.codes/docs/spectrum-ts/spaces-and-users .

The repository also contains the team's separate `bridge/photon.mjs` entry point. This reminder integration runs through `bun start` / `src/index.ts`. Use one bot entry point at a time for the same Photon connection.
