# Open time and demo-calendar edits

The agent now finds free time between commitments, regardless of event titles. It checks **Hackathon Demo only**, over the next seven local days, within a default 9 AM–8 PM Pacific study window. It merges busy intervals and allows ten-minute buffers. All-day commitments block time; canceled, transparent/free, and self-declined events do not. Openings need at least thirty minutes remaining. Calendar failures do not imply availability. An empty calendar slot is a suggestion, not proof that you're available; Canvas deadlines are not connected.

Restart with `bun start`. Text `open time` for the next six gaps, or `reminders on` for proactive suggestions. Defaults: Pacific quiet hours 22:00–08:00, up to two start suggestions per day, one pending suggestion, and a ten-minute cooldown. Reply `yes` to start up to 45 minutes within the fresh opening, or `skip`. The confirmation rechecks the calendar. The confirmed end is fixed rather than moving on every poll. At the end, an active session gets one follow-up; text `done` when actually finished for linked ratings. This does not automatically add a Google event.

Text `reminders off` to stop, `reminders status` for status, and `quiet hours 22 8` to set quiet hours. Keep the computer awake, online, and running one bot process. This is local polling rather than an always-on cloud deployment. Private attempt markers prevent duplicate prompts across restarts. Ambiguous delivery failures are not retried automatically. The separate `bridge/photon.mjs` should not run alongside this bot for the same Photon connection.

## Add and edit

`bun calendar-write-auth.mjs` opens Google's event-management consent. A token cannot gain permissions by editing its text. This saves a separate private `.google-calendar-write-token.json`, preserving the original read-only token. Google's `calendar.events` scope grants event access at the account scope level; our gateway restricts writes to the hardcoded Hackathon Demo calendar. Token files and private command state are gitignored.

Text `calendar help` for these formats. Explicit commands apply immediately to Hackathon Demo:

```text
calendar events
add event Study math | 2026-10-19 14:00 | 2026-10-19 14:45
move event 2 | 2026-10-19 15:00 | 2026-10-19 15:45
rename event 2 | Math practice
```

Use future dates when testing. Times are Pacific unless an explicit ISO offset is supplied. Invalid and ambiguous daylight-saving times are rejected. Numbers refer to your conversation's latest `calendar events` list, valid for fifteen minutes. Refresh after editing. Google's ETag check prevents overwriting intervening edits. This editor excludes events with guests and sends no invitations. Stable creation IDs prevent duplicate events on retried messages. Free-form natural-language event parsing and conflict prevention for explicit write commands are not implemented.

## Fake schedule

`bun scripts/seed-demo-calendar.ts` creates twenty-five `[DEMO]` events for the next Monday–Friday: lectures, labs, commute, meals, club, and work. They are fictional, have no guests, and disable default reminders. Existing events stay in place. Stable IDs prevent duplicates when rerun for the same week; a later run can target a later week. These events demonstrate a fuller calendar, not real coursework or model training labels.

Tests cover buffered/merged gaps, all-day/free events, Pacific/DST times, stable identities, stale-edit protection, and fixed session ends. Real calendar reads, seeded events, and editing are verified separately from phone delivery. No additional Supabase migration is needed beyond the previous linked-session setup.

References: https://developers.google.com/workspace/calendar/api/v3/reference/events/list , https://developers.google.com/workspace/calendar/api/v3/reference/events/insert , https://developers.google.com/workspace/calendar/api/v3/reference/events/patch .
