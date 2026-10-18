import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DailyBrief} from '../src/daily-brief.ts';
import {parseCalendarTime} from '../src/time.ts';
import type {CalendarGateway,DemoEvent} from '../src/calendar-types.ts';
test('8:30 Pacific brief uses real calendar, persists deduplication, and never sends early or overnight catch-up',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'brief-'));let now=parseCalendarTime('2026-10-18 08:29'),reads=0;const sent:string[]=[];
 const deps={calendar:{list:async()=>{reads++;return []}} as unknown as CalendarGateway,recipient:async()=>'owner',allowed:async()=>true,busy:async()=>false,send:async(_:string,t:string)=>{sent.push(t)},now:()=>now};
 try{let b=new DailyBrief(deps,dir);await b.tick();expect(sent).toHaveLength(0);now+=60000;await Promise.all([b.tick(),b.tick()]);expect(sent).toHaveLength(1);expect(sent[0]).toContain('no remaining events');b=new DailyBrief(deps,dir);await b.tick();expect(sent).toHaveLength(1);now=parseCalendarTime('2026-10-19 21:00');await b.tick();expect(sent).toHaveLength(1);expect(reads).toBeGreaterThan(0);}finally{await rm(dir,{recursive:true,force:true});}
});
test('event check-ins exclude all-day, cancelled and declined events, group simultaneous events and recover after restart without duplicates',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'brief-'));let now=parseCalendarTime('2026-10-18 12:00');const sent:string[]=[];
 const event=(id:string):DemoEvent=>({id,summary:id,start:{dateTime:new Date(now+10*60000).toISOString()}});
 const events=[event('a'),event('b'),{...event('cancel'),status:'cancelled'},{...event('declined'),attendees:[{self:true,responseStatus:'declined'}]},{id:'all',start:{date:'2026-10-18'}}];
 const deps={calendar:{list:async()=>events} as unknown as CalendarGateway,recipient:async()=>'owner',allowed:async()=>true,busy:async()=>false,send:async(_:string,t:string)=>{sent.push(t)},now:()=>now};
 try{await new DailyBrief(deps,dir).tick();await new DailyBrief(deps,dir).tick();expect(sent).toHaveLength(1);expect(sent[0]).toContain('a starts');expect(sent[0]).toContain('b starts');expect(sent[0]).not.toContain('cancel');expect(sent[0]).not.toContain('declined');await new DailyBrief(deps,dir).handle('owner','event checkins off');now+=60000;await new DailyBrief(deps,dir).tick();expect(sent).toHaveLength(1);}finally{await rm(dir,{recursive:true,force:true});}
});
test('calendar outages retry, messaging uncertainty never duplicates, and other chats cannot alter subscriptions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'brief-'));const now=parseCalendarTime('2026-10-18 08:30');let failRead=true,sends=0,allowed=true;
 const deps={calendar:{list:async()=>{if(failRead)throw Error('offline');return []}} as unknown as CalendarGateway,recipient:async()=>'owner',allowed:async()=>allowed,busy:async()=>false,send:async()=>{sends++;throw Error('uncertain')},now:()=>now};
 try{const b=new DailyBrief(deps,dir);expect(await b.handle('other','morning brief off')).toContain('connected');await expect(b.tick()).rejects.toThrow();expect(sends).toBe(0);failRead=false;await expect(b.tick()).rejects.toThrow();await new DailyBrief(deps,dir).tick();expect(sends).toBe(1);allowed=false;await b.tick();expect(sends).toBe(1);}finally{await rm(dir,{recursive:true,force:true});}
});
