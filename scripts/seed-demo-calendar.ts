import { demoCalendar } from "../src/calendar-api.ts";
import { demoSchedule } from "../src/demo-schedule.ts";

try {
  const events=demoSchedule();
  console.log(`Adding ${events.length} clearly labeled fictional commitments to Hackathon Demo. Stable event IDs prevent duplicates.`);
  for(const event of events)await demoCalendar.create(event);
  const verified=await demoCalendar.list(Date.parse(events[0]!.start.dateTime),Date.parse(events.at(-1)!.end.dateTime)+86400_000);
  const ids=new Set(verified.map(e=>e.id));
  const present=events.filter(e=>ids.has(e.id)).length;
  console.log(`Verified ${present}/${events.length} demo events in Google Calendar.`);
  if(present!==events.length)process.exitCode=1;
} catch {
  console.error('Demo schedule was not fully added. Run bun calendar-write-auth.mjs to authorize editing, then retry. Existing events are preserved; stable IDs make retry safe.');
  process.exitCode=1;
}
