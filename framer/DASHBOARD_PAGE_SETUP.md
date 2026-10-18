# DAYWISE Dashboard

The Framer draft now has `/dashboard`, linked in the desktop and mobile menus. The model overview was moved out of `/about`. The dashboard contains model estimates, recent sessions, agent activity, and an upcoming-events section.

To enable the live events list:

1. Run `011_dashboard_calendar.sql` in this project's Supabase SQL Editor.
2. Replace the deployed `model-dashboard` function code with the updated `model-dashboard.ts` and deploy updates. Preserve the existing allowed origins and custom-token authentication settings.
3. Restart the local bot with `bun start`. It refreshes calendar snapshots about once a minute for dashboards with valid connection codes.

The list uses the existing shared **Hackathon Demo** calendar, not a separate personal calendar for each phone. It shows up to 12 events in the next seven days, including ongoing and all-day events. Calendar times are shown in Pacific time. Attendees, descriptions and contact details are excluded.

The cache is private with row-level security and backend-only access. The dashboard endpoint selects only the connected code's owner row. Missing, failed, or older-than-five-minute snapshots show “not synced” rather than claiming the calendar is empty. No Google credentials are copied to Framer or Supabase.

Validation: 185 bot tests passed, including calendar filtering, cache isolation and all-day Pacific boundaries. TypeScript and bot, React and Edge Function builds passed. The existing Google Calendar connection returned 12 upcoming events. Framer preview showed the moved model overview and upcoming-events section; the live event list awaits the deployment steps above.
