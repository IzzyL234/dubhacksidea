import { google } from "googleapis";
import { readFile } from "node:fs/promises";
import { parseCalendarTime } from "./time.ts";
import { busyIntervals } from "./open-time.ts";
import type { CalendarGateway, DemoEvent } from "./calendar-types.ts";
export const DEMO_CALENDAR = "c_8a3f88a63add1862899e38c8eb168366805a752ed4bc3283303e5a68823964bf@group.calendar.google.com";
async function calendarClient(write=false) {
  let token;
  try {token=JSON.parse(await readFile(new URL(write?"../.google-calendar-write-token.json":"../.google-calendar-token.json",import.meta.url),"utf8"));}
  catch(e){if(write&&(e as NodeJS.ErrnoException).code==="ENOENT")throw Error("CALENDAR_WRITE_AUTH_REQUIRED");throw e;}
  const auth=new google.auth.OAuth2(token.client_id,token.client_secret);auth.setCredentials({refresh_token:token.refresh_token});
  return google.calendar({version:"v3",auth});
}
export const demoCalendar:CalendarGateway={
  async list(from,to){
    const client=await calendarClient();const events:DemoEvent[]=[];let pageToken:string|undefined;
    do{
      const {data}=await client.events.list({calendarId:DEMO_CALENDAR,timeMin:new Date(from).toISOString(),timeMax:new Date(to).toISOString(),
        singleEvents:true,orderBy:"startTime",maxResults:2500,pageToken,fields:"nextPageToken,items(id,etag,summary,status,start,end,transparency,attendees,extendedProperties)"},{timeout:20000});
      events.push(...data.items??[]);pageToken=data.nextPageToken??undefined;
    }while(pageToken);return events;
  },
  async busy(from,to){
    // Use Events.list so the existing calendar.events.readonly grant remains sufficient.
    return busyIntervals(await this.list(from,to));
  },
  async create(event){
    const client=await calendarClient(true);
    try{return (await client.events.insert({calendarId:DEMO_CALENDAR,sendUpdates:"none",requestBody:event},{timeout:20000})).data;}
    catch(e){
      if((e as {response?:{status?:number}}).response?.status===409&&event.id){
        const existing=(await client.events.get({calendarId:DEMO_CALENDAR,eventId:event.id},{timeout:20000})).data;
        const tags=event.extendedProperties?.private;
        if(tags&&Object.entries(tags).every(([k,v])=>existing.extendedProperties?.private?.[k]===v))return existing;
      }
      throw e;
    }
  },
  async get(id){return (await (await calendarClient()).events.get({calendarId:DEMO_CALENDAR,eventId:id},{timeout:20000})).data;},
  async patch(id,etag,change){return (await (await calendarClient(true)).events.patch({calendarId:DEMO_CALENDAR,eventId:id,sendUpdates:"none",requestBody:change},{timeout:20000,headers:{"If-Match":etag}})).data;},
};
