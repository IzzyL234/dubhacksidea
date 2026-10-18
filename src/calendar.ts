import { google } from "googleapis";
import { readFile } from "node:fs/promises";
import { studyBlock, type StudyBlock } from "./study-events.ts";

const calendarId = "c_8a3f88a63add1862899e38c8eb168366805a752ed4bc3283303e5a68823964bf@group.calendar.google.com";
const tokenFile = new URL("../.google-calendar-token.json", import.meta.url);

export function isUpcomingRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[?.!]+$/, "");
  return /^(what'?s coming up|what is coming up|upcoming events|show (?:my )?(?:calendar|upcoming events)|(?:my )?calendar)$/.test(normalized);
}

export async function getUpcomingCalendarReply(): Promise<string> {
  const token = JSON.parse(await readFile(tokenFile, "utf8"));
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

// Calendar event IDs identify expanded recurring occurrences independently.
export async function getCalendarStudyBlocks(now = Date.now()): Promise<StudyBlock[]> {
  const token = JSON.parse(await readFile(tokenFile, "utf8"));
  const auth = new google.auth.OAuth2(token.client_id, token.client_secret);
  auth.setCredentials({ refresh_token: token.refresh_token });
  const calendar = google.calendar({ version: "v3", auth });
  const blocks: StudyBlock[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await calendar.events.list({
      calendarId, timeMin: new Date(now - 6 * 3600_000).toISOString(),
      timeMax: new Date(now + 24 * 3600_000).toISOString(),
      maxResults: 2500, singleEvents: true, orderBy: "startTime", showDeleted: false, pageToken,
      fields: "nextPageToken,items(id,summary,status,start,end)",
    }, { timeout: 20_000 });
    for (const event of data.items ?? []) {
      const block = studyBlock(calendarId, event);
      if (block) blocks.push(block);
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return blocks;
}
