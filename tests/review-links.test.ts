import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ScheduleReviewService} from '../src/schedule-review-service.ts';
import {ReviewLinks} from '../src/review-links.ts';
import type {CalendarGateway,DemoEvent} from '../src/calendar-types.ts';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'review-link-'));dirs.push(directory);let patches=0;
 const events:DemoEvent[]=[{id:'study',etag:'1',summary:'Study math',start:{dateTime:'2026-10-19T17:00:00Z'},end:{dateTime:'2026-10-19T18:00:00Z'},extendedProperties:{private:{studyAgentRequest:'1'}}},{id:'meeting',etag:'1',summary:'Project meeting',start:{dateTime:'2026-10-19T17:30:00Z'},end:{dateTime:'2026-10-19T18:30:00Z'}}];
 const now=()=>Date.parse('2026-10-19T15:00:00Z');
 const gateway:CalendarGateway={list:async()=>events,busy:async()=>[],get:async id=>events.find(e=>e.id===id)!,create:async()=>{throw Error('No create')},patch:async(id,etag,change)=>{patches++;if(events[0]!.etag!==etag)throw {response:{status:412}};events[0]={...events[0],...change,etag:'2'};return events[0]!;}};
 const service=new ScheduleReviewService({gateway,now,send:async()=>{},allowed:async()=>true,reviewUrl:'https://daywise.example/dashboard'},directory);
 const message=await service.handle('private-chat','review schedule');
 const url=new URL(message!.match(/https:\/\/[^\s]+/)![0]);const id=url.pathname.split('/').pop()!,key=new URLSearchParams(url.hash.slice(1)).get('key')!;
 return {directory,gateway,service,id,key,now,events,get patches(){return patches}};
}
test('private link hides calendar internals and rejects absent, wrong and cross-proposal credentials',async()=>{
 const f=await fixture(),api=new ReviewLinks(f.gateway,f.directory,f.now);
 const ok=await api.request(f.id,'Bearer '+f.key);expect(ok.status).toBe(200);const body=await ok.json();expect(body.review.eventId).toBeUndefined();expect(body.review.etag).toBeUndefined();expect(JSON.stringify(body)).not.toContain('private-chat');
 expect((await api.request(f.id,'Bearer '+'a'.repeat(43))).status).toBe(401);expect((await api.request('0'.repeat(16),'Bearer '+f.key)).status).toBe(401);expect((await api.request(f.id,'')).status).toBe(401);expect(f.patches).toBe(0);
});
test('concurrent web and bot approvals make one conditional calendar edit and preserve state',async()=>{
 const f=await fixture(),api=new ReviewLinks(f.gateway,f.directory,f.now);
 await Promise.all([api.request(f.id,'Bearer '+f.key,'approve'),f.service.handle('private-chat','approve change '+f.id)]);
 expect(f.patches).toBe(1);expect((await (await api.request(f.id,'Bearer '+f.key)).json()).review.status).toBe('applied');
});
test('denial is final, replay cannot change calendar, expiry fails closed',async()=>{
 const f=await fixture(),api=new ReviewLinks(f.gateway,f.directory,f.now);
 expect((await (await api.request(f.id,'Bearer '+f.key,'deny')).json()).review.status).toBe('skipped');
 await api.request(f.id,'Bearer '+f.key,'approve');expect(f.patches).toBe(0);
 const expired=new ReviewLinks(f.gateway,f.directory,()=>f.now()+2*86400000);expect((await expired.request(f.id,'Bearer '+f.key,'approve')).status).toBe(410);
});
test('calendar changed after link generation invalidates approval',async()=>{
 const f=await fixture();f.events[0]!.etag='changed';const api=new ReviewLinks(f.gateway,f.directory,f.now);
 expect((await (await api.request(f.id,'Bearer '+f.key,'approve')).json()).review.status).toBe('stale');expect(f.patches).toBe(0);
});
