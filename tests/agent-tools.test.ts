import {test,expect} from 'bun:test';
import {createAgentTools} from '../src/agent-tools.ts';
import type {CalendarGateway,DemoEvent} from '../src/calendar-types.ts';
const now=Date.parse('2026-10-19T15:00:00Z');
function fixture(){let creates=0,busy=false,uncertain=false;const events=new Map<string,DemoEvent>();
 const calendar:CalendarGateway={list:async()=>[],busy:async()=>busy?[{start:now+3600000,end:now+7200000}]:[],get:async id=>{const e=events.get(id);if(!e)throw {response:{status:404}};return e},create:async e=>{creates++;const created={...e,etag:'v1'};events.set(e.id!,created);if(uncertain)throw Error('response lost');return created;},patch:async()=>{throw Error('unexpected patch')}};
 const tools=createAgentTools({calendar,openings:async()=>[{key:'gap',title:'Open',start:now+3600000,end:now+7200000}],estimate:async(_c,_s,lengths)=>lengths.map(minutes=>({minutes,productivity:4,mood:3,utility:3.7,observations:5})),learning:async()=>({observations:5}),notes:async()=>({confirmedNotes:0}),now:()=>now,withCalendarLock:async work=>work()});
 return {tools,events,get creates(){return creates},set busy(v:boolean){busy=v},set uncertain(v:boolean){uncertain=v}};
}
const choice={id:'slot',start:now+3600000,end:now+5400000,minutes:30,productivity:4,mood:3,observations:5};
test('opening constraints are applied to real gaps and retain model evidence',async()=>{
 const f=fixture(),r=await f.tools.read('chat','openings',{date:'2026-10-19',notBefore:'09:30',minutes:30}) as any;expect(r.options).toHaveLength(1);expect(r.options[0].start).toBe(Date.parse('2026-10-19T16:30:00Z'));expect(r.options[0].observations).toBe(5);expect(f.creates).toBe(0);
 await expect(f.tools.read('chat','openings',{date:'2026-10-29',notBefore:null,minutes:30})).rejects.toThrow();
});
test('booking rechecks availability and uses a deterministic id to recover a lost response',async()=>{
 const f=fixture();f.busy=true;await expect(f.tools.book('chat','plan',choice)).rejects.toThrow();expect(f.creates).toBe(0);
 f.busy=false;f.uncertain=true;await expect(f.tools.book('chat','plan',choice)).rejects.toThrow();expect(f.creates).toBe(1);
 f.busy=true;expect(await f.tools.book('chat','plan',choice)).toContain('already booked');expect(f.creates).toBe(1);
});
test('calendar read projection excludes event IDs, private metadata and exact location',async()=>{
 const f=fixture();const r=await f.tools.read('chat','calendar',{date:null,notBefore:null,minutes:null}) as any;expect(r.events).toEqual([]);expect(f.creates).toBe(0);
});
