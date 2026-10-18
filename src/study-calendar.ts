import {createHash} from "node:crypto";
import type {CalendarGateway} from "./calendar-types.ts";
import {busyIntervals} from "./open-time.ts";
import {TIMEZONE} from "./time.ts";
export type StudyBooking={start:number;end:number;status:"pending"|"booked";eventId?:string};
export function studyEventId(sessionId:string):string{return "agent"+createHash("sha256").update(`study:${sessionId}`).digest("hex").slice(0,40);}
export async function bookStudyEvent(gateway:CalendarGateway,sessionId:string,plan:Pick<StudyBooking,"start"|"end">):Promise<string>{
 const {start,end}=plan;
 if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<5*60000||end-start>240*60000)throw Error("INVALID_STUDY_BOOKING");
 const id=studyEventId(sessionId);
 // Recheck before a write, including retries. The same session's event cannot conflict with itself.
 const events=await gateway.list(start-10*60000,end+10*60000);
 const busy=busyIntervals(events.filter(e=>e.id!==id));
 if(busy.some(b=>b.start-10*60000<end&&b.end+10*60000>start))throw Error("STUDY_BOOKING_CONFLICT");
 const event=await gateway.create({id,summary:"Study session",description:"Study session confirmed by you through the scheduling assistant.",
  start:{dateTime:new Date(start).toISOString(),timeZone:TIMEZONE},end:{dateTime:new Date(end).toISOString(),timeZone:TIMEZONE},
  transparency:"opaque",reminders:{useDefault:false},extendedProperties:{private:{studyAgentSession:sessionId}},
 });
 // The existing gateway recovers a 409 using this ID and matching private tags. Verify the event too.
 if(event.id!==id||event.status==="cancelled"||event.attendees?.length||event.extendedProperties?.private?.studyAgentSession!==sessionId
   ||Date.parse(event.start?.dateTime??"")!==start||Date.parse(event.end?.dateTime??"")!==end)throw Error("STUDY_BOOKING_CHANGED");
 return id;
}
export function bookingFailure(error:unknown):string{
 const message=error instanceof Error?error.message:"";
 const status=(error as {response?:{status?:number}})?.response?.status;
 if(message==="CALENDAR_WRITE_AUTH_REQUIRED"||status===401||status===403)return "Calendar write permission needs attention. Run bun calendar-write-auth.mjs in your project terminal, then text retry calendar.";
 if(message==="STUDY_BOOKING_CONFLICT")return "Your calendar has a conflicting commitment. No new event was added. Resolve the conflict before texting retry calendar.";
 if(message==="STUDY_BOOKING_CHANGED")return "The matching calendar event was changed or canceled. I couldn't verify its booking; check Hackathon Demo before retrying.";
 return "I couldn't confirm the calendar booking. It may already exist if the connection dropped. Text retry calendar to check safely without creating a duplicate.";
}
