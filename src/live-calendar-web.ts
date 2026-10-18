import type {CalendarGateway} from './calendar-types.ts';
import {upcomingEvents} from './dashboard-calendar.ts';
export async function liveCalendarView(gateway:CalendarGateway,now=Date.now()){
 try{const events=upcomingEvents(await gateway.list(now,now+7*86400000),now);return {status:'ready',authenticated:true,source:'google_calendar_live',upcoming_tasks:events.map(e=>({title:e.title,start_time:e.start,end_time:e.end,all_day:e.allDay,source:'google_calendar_live'}))};}
 catch{return {status:'unavailable',authenticated:false,source:'google_calendar_unavailable',upcoming_tasks:[]};}
}
