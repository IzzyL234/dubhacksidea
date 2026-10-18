import { google } from "googleapis";
import { readFile } from "node:fs/promises";
import { type StudyBlock } from "./study-events.ts";
import { demoCalendar } from "./calendar-api.ts";
import { openWindows } from "./open-time.ts";
import { addDays, localDate, parseCalendarTime, formatTime } from "./time.ts";

const calendarId = process.env.GOOGLE_CALENDAR_ID || "c_8a3f88a63add1862899e38c8eb168366805a752ed4bc3283303e5a68823964bf@group.calendar.google.com";
const tokenFile = new URL("../.google-calendar-token.json", import.meta.url);

export function isUpcomingRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[?.!]+$/, "");
  return /^(what'?s coming up|what is coming up|upcoming events|show (?:my )?(?:calendar|upcoming events)|(?:my )?calendar)$/.test(normalized);
}

export async function getUpcomingCalendarReply(): Promise<string> {
  let token;
  try {
    token = JSON.parse(await readFile(tokenFile, "utf8"));
  } catch (e) {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
      token = {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      };
    } else {
      throw e;
    }
  }
  const auth = new google.auth.OAuth2(token.client_id, token.client_secret);
  auth.setCredentials({ refresh_token: token.refresh_token });

  const calendar = google.calendar({ version: "v3", auth });
  const { data } = await calendar.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    maxResults: 5,
    singleEvents: true,
    orderBy: "startTime",
  }, { timeout: 20_000 });

  if (!data.items?.length) return "Your Hackathon Demo calendar has no upcoming events.";

  const timezone = data.timeZone || "America/Los_Angeles";
  const events = data.items.map((event) => {
    const time = event.start?.dateTime
      ? new Date(event.start.dateTime).toLocaleString("en-US", {
          timeZone: timezone,
          weekday: "short", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit",
        })
      : `${event.start?.date ?? "Date unknown"} (all day)`;
    const title = (event.summary || "Untitled event").replace(/\s+/g, " ").slice(0, 160);
    return `• ${time}: ${title}`;
  });

  return `Coming up on Hackathon Demo (${timezone}):\n\n${events.join("\n")}`;
}

export async function getOpenStudyWindows(now = Date.now()): Promise<StudyBlock[]> {
  const start = parseCalendarTime(`${localDate(now)} 00:00`);
  const end = parseCalendarTime(`${addDays(localDate(now),7)} 00:00`);
  return openWindows(await demoCalendar.busy(start,end),now);
}
export async function getOpenTimeReply(now = Date.now()): Promise<string> {
  const windows=(await getOpenStudyWindows(now)).slice(0,6);
  if(!windows.length)return "No 30-minute openings found in the next 7 days at any hour, allowing 10-minute buffers.";
  return "Open time based on Hackathon Demo only (Pacific; 10-minute buffers):\n"+windows.map(w=>{
    const start=Math.max(w.start,now);return `• ${formatTime(start)} to ${formatTime(w.end)} (${Math.floor((w.end-start)/60000)} minutes)`;
  }).join("\n")+"\nAn empty calendar slot is a suggestion, not proof you're available.";
}
