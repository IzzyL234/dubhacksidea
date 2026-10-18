import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {SmartPrompts} from '../src/smart-prompts.ts';import {StudyReminders} from '../src/proactive.ts';
import {parseNearby,chooseNearby,lookupNearby,type NearbyPlace} from '../src/nearby-places.ts';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const noon=Date.parse('2026-10-17T19:00:00Z'),point={latitude:47,longitude:-122};
const library:NearbyPlace={id:'osm:node:1',name:'Example Library',label:'library',...point};
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'discovery-'));dirs.push(root);let now=noon,latitude=47,lookups=0,captured=noon,fail=false,starts=0;const sent:string[]=[];
 const smart=new SmartPrompts({now:()=>now,read:async()=>({latitude,longitude:-122,accuracy:20,locationType:'live',locationTimestamp:new Date(captured),isLocatingInProgress:false}),
 lookup:async()=>{lookups++;if(fail)throw Error('offline');return[library];},decide:async()=>({action:'offer_study',reason:'useful_window',confidence:.9})},join(root,'smart'));
 const block={key:'open:one',kind:'open' as const,title:'Open time',start:noon,end:noon+4*3600000};
 const reminders=new StudyReminders({now:()=>now,events:async()=>[block],busy:async()=>false,checkIn:async()=>false,active:async()=>true,
 send:async(_c,t)=>{sent.push(t);},start:async()=>{starts++;return{id:'session',reply:'Started'};},evaluate:(c,b)=>smart.evaluate(c,b),confirm:(c,b)=>smart.confirm(c,b),resolvePlace:(c,a)=>smart.resolvePlace(c,a)},join(root,'reminders.json'));
 await smart.handle('chat','+15555550123','smart prompts on');await reminders.handle('chat','reminders on','on');
 return {smart,reminders,block,sent,get lookups(){return lookups;},get starts(){return starts;},time:(minutes:number,fresh=true)=>{now=noon+minutes*60000;if(fresh)captured=now;},move:()=>{latitude=48;},fail:()=>{fail=true;}};
}
async function dwell(s:Awaited<ReturnType<typeof setup>>){await s.reminders.tick();s.time(1);await s.reminders.tick();s.time(3);await s.reminders.tick();}
test('discovery yes saves only the place; a later study offer requires separate confirmation',async()=>{
 const s=await setup();await dwell(s);expect(s.lookups).toBe(1);expect(s.sent).toHaveLength(1);expect(s.sent[0]).toContain('Example Library');
 expect(await s.reminders.handle('chat','yes','save')).toContain('Saved');expect(s.starts).toBe(0);
 expect(await s.reminders.handle('chat','yes','save')).toContain('Saved');expect(s.starts).toBe(0);
 s.time(13);await s.reminders.tick();s.time(14);await s.reminders.tick();s.time(16);await s.reminders.tick();expect(s.sent).toHaveLength(2);expect(s.lookups).toBe(1);
 expect(await s.reminders.handle('chat','yes','start')).toBe('Started');expect(s.starts).toBe(1);
});
test('moving before place confirmation saves nothing and starts no session',async()=>{
 const s=await setup();await dwell(s);s.move();expect(await s.reminders.handle('chat','yes','moved')).toContain('Nothing was saved');expect(s.starts).toBe(0);
});
test('skip dismisses venue and pauses invitations',async()=>{
 const s=await setup();await dwell(s);expect(await s.reminders.handle('chat','skip','skip')).toContain("won't suggest it again");s.time(20);await s.reminders.tick();expect(s.sent).toHaveLength(1);expect(s.lookups).toBe(1);
 s.time(70);await s.reminders.tick();s.time(71);await s.reminders.tick();s.time(73);await s.reminders.tick();expect(s.sent).toHaveLength(1);
});
test('discovery off and stale captures avoid map lookup',async()=>{
 const s=await setup();await s.reminders.tick();s.time(1,false);await s.reminders.tick();s.time(3,false);await s.reminders.tick();expect(s.lookups).toBe(0);
 await s.smart.handle('chat',undefined,'place discovery off');s.time(4);await s.reminders.tick();expect(s.lookups).toBe(0);
});
test('map failure stays quiet and reserves retry cooldown',async()=>{
 const s=await setup();s.fail();await dwell(s);expect(s.lookups).toBe(1);expect(s.sent).toHaveLength(0);s.time(4);await s.reminders.tick();expect(s.lookups).toBe(1);
 expect(await s.smart.handle('chat',undefined,'why quiet')).toContain('place_lookup_cooldown');
});
test('map parsing deduplicates venues, rejects unsupported categories, and refuses ambiguous matches',()=>{
 const data={elements:[{type:'node',id:1,lat:47,lon:-122,tags:{amenity:'library',name:'Example Library'}},{type:'way',id:2,center:{lat:47,lon:-122},tags:{amenity:'library',name:'Example Library'}},{type:'node',id:3,lat:47,lon:-122,tags:{amenity:'restaurant',name:'Not a study venue'}}]};
 const places=parseNearby(data,point);expect(places).toHaveLength(1);expect(chooseNearby(places,point)?.name).toBe('Example Library');
 expect(chooseNearby([library,{...library,id:'osm:node:2',name:'Other Library'}],point)).toBeNull();
});
test('map requests contain rounded coordinates and no chat identifiers',async()=>{
 let body='';const request=async(_url:unknown,init?:RequestInit)=>{body=String(init?.body);return new Response(JSON.stringify({elements:[]}));};
 await lookupNearby({latitude:47.123456,longitude:-122.987654},request as typeof fetch);expect(decodeURIComponent(body)).toContain('47.123,-122.988');expect(body).not.toContain('47.123456');expect(body).not.toContain('chat');
});

test('lookup retries only the documented fallback after a provider error',async()=>{
 const urls:string[]=[];const request=async(url:unknown)=>{urls.push(String(url));return urls.length===1?new Response('',{status:500}):new Response(JSON.stringify({elements:[]}));};
 expect(await lookupNearby(point,request as typeof fetch)).toEqual([]);expect(urls).toEqual(['https://overpass.private.coffee/api/interpreter','https://overpass-api.de/api/interpreter']);
});
