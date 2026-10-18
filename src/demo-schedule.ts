import { createHash } from "node:crypto";
import { addDays, localDate, parseCalendarTime, TIMEZONE } from "./time.ts";

export function demoSchedule(now=Date.now()) {
  let monday=localDate(now);
  // Begin on the next Monday, so the sample schedule remains useful when rerun later.
  do {monday=addDays(monday,1);}while(new Date(`${monday}T12:00:00Z`).getUTCDay()!==1);
  const events=[];
  for(let day=0;day<5;day++){
    const date=addDays(monday,day);
    const slots=day%2===0
      ?[["Math lecture","09:00","10:00"],["CS lecture","11:00","12:00"],["Lunch","12:00","12:45"],["Campus club","15:00","16:00"],["Dinner","18:00","18:45"]]
      :[["Commute","09:00","09:30"],["Writing seminar","10:00","11:30"],["Lunch","12:30","13:15"],["CS lab","14:00","15:30"],["Part-time shift","17:00","19:00"]];
    for(const [title,start,end]of slots){
      const id="demo"+createHash("sha256").update(`study-demo-v1:${date}:${title}`).digest("hex").slice(0,40);
      events.push({id,summary:`[DEMO] ${title}`,description:"Synthetic hackathon schedule. This is a fictional commitment, not a real class or appointment.",
        start:{dateTime:new Date(parseCalendarTime(`${date} ${start}`)).toISOString(),timeZone:TIMEZONE},
        end:{dateTime:new Date(parseCalendarTime(`${date} ${end}`)).toISOString(),timeZone:TIMEZONE},
        transparency:"opaque",reminders:{useDefault:false},extendedProperties:{private:{studyAgentSeed:"schedule-v1"}},});
    }
  }
  return events;
}
