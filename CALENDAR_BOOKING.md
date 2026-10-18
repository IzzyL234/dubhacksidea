# Confirmed study sessions and calendar booking

Study suggestions can happen at any hour, including across midnight. The old 9 AM-8 PM study window is removed. Quiet hours are off by default, including for older settings that only contained the previous default start/end hours. To deliberately silence a window, text `quiet hours 22 8`; to remove it, text `quiet hours off`. Cooldowns, skip snoozes, daily prompt limits, active-session checks, and fresh-location checks remain in effect.

The invitation explicitly asks whether to start a session and add it to Hackathon Demo. Replying `yes` revalidates the opening and location when enabled, starts the tracked session, and attempts to create a busy Calendar event for the actual session time. The calendar write rechecks commitments with ten-minute buffers. It creates no guests and disables default calendar reminders; the existing bot handles the linked end reminder.

The confirmation says `Added it to Hackathon Demo` only after the event ID, session tag, start/end times and active event status match. A separate place-confirmation yes still only saves a place. `skip` does not create a session or event. Manual `start studying` remains tracking-only.

## Failure and retry

The tracked session and original booking interval are saved locally before the calendar request. If booking fails or its response is uncertain, the bot explicitly says the tracked session is running but booking was not confirmed. It does not claim that both actions succeeded, and it does not roll back a session the user may already be studying in.

Text `retry calendar` to retry the active session's pending booking. The same deterministic Google-compatible event ID and exact start/end times are reused, including after restart. Existing confirmed bookings are not written again. A lost response can recover the same event through the existing gateway's 409 handling. Conflicting commitments, canceled or changed matching events, and expired planned blocks cannot silently produce a new booking. No automatic write retries are triggered by the background timer.

If write authorization is missing, run `bun calendar-write-auth.mjs` in the project terminal, complete Google sign-in, then text `retry calendar`. The existing write-token file's presence is not proof of a valid grant. Keep one bot process running. Retry state lives in the existing gitignored local session document; it is not a cloud-restoration feature.

No database migration or new secret is required for booking. Local booking metadata is separate from uploaded session fields. Tests use a mocked Calendar gateway; they do not create real calendar events. Reference: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
