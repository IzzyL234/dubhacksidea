import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {campusBuildings,footprintDistance,matchCampusBuilding,lookupCampusBuildings,type CampusBuilding} from '../src/uw-buildings.ts';
import {SmartPrompts} from '../src/smart-prompts.ts';import {StudyReminders} from '../src/proactive.ts';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const hub=campusBuildings.find(b=>b.code==='HUB')!;const points=hub.polygons.flat(2),lats=points.map(p=>p[1]!),lons=points.map(p=>p[0]!);
const hubPoint={latitude:(Math.min(...lats)+Math.max(...lats))/2,longitude:(Math.min(...lons)+Math.max(...lons))/2};
const noon=Date.parse('2026-10-17T19:00:00Z');
async function setup(offline=false){
 const root=await mkdtemp(join(tmpdir(),'uw-building-'));dirs.push(root);let now=noon,moved=false,starts=0,modelCalls=0,reads=0;const sent:string[]=[];
 const smart=new SmartPrompts({localBuildings:true,now:()=>now,lookup:lookupCampusBuildings,
 read:async()=>({...hubPoint,latitude:moved?0:hubPoint.latitude,accuracy:10,locationTimestamp:new Date(now),locationType:'live',isLocatingInProgress:false}),
 decide:async()=>{modelCalls++;return {action:'offer_study',reason:'useful_window',confidence:.9};}},join(root,'smart'));
 const reminders=new StudyReminders({now:()=>now,observe:c=>smart.observe(c),evaluate:(c,b)=>smart.evaluate(c,b),resolvePlace:(c,a)=>smart.resolvePlace(c,a),confirm:(c,b)=>smart.confirm(c,b),
 events:async()=>{reads++;if(offline)throw Error('calendar offline');return [];},send:async(_c,t)=>{sent.push(t);},busy:async()=>false,checkIn:async()=>false,active:async()=>true,
 start:async()=>{starts++;return {id:'one',reply:'Started'};}},join(root,'reminders.json'));
 await smart.handle('chat','+15555550123','smart prompts on');await reminders.handle('chat','reminders on','on');
 return {smart,reminders,sent,get starts(){return starts;},get calls(){return modelCalls;},get reads(){return reads;},time:(minutes:number)=>{now=noon+minutes*60000;},move:()=>{moved=true;}};
}
test('official UW catalog includes HUB with bounded valid footprints and unique IDs',async()=>{
 expect(campusBuildings.length).toBeGreaterThan(250);expect(new Set(campusBuildings.map(b=>b.id)).size).toBe(campusBuildings.length);
 expect(hub.name).toBe('Student Union Building');expect(footprintDistance(hub,hubPoint)).toBe(0);expect(matchCampusBuilding(hubPoint,10)?.code).toBe('HUB');
 const result=await lookupCampusBuildings({...hubPoint,accuracy:10});expect(result[0]?.name).toContain('(HUB)');expect(result[0]?.label).toBe('campus_building');
 expect(await lookupCampusBuildings({latitude:0,longitude:0,accuracy:10})).toEqual([]);
});
test('polygon holes, adjacent buildings and inaccurate readings do not create false building matches',()=>{
 const square:CampusBuilding={id:'one',name:'Square',code:'ONE',polygons:[[[[0,0],[.001,0],[.001,.001],[0,.001],[0,0]],[[.0004,.0004],[.0006,.0004],[.0006,.0006],[.0004,.0006],[.0004,.0004]]]]};
 expect(footprintDistance(square,{latitude:.0005,longitude:.0005})).toBeGreaterThan(10);
 const second={...square,id:'two'};expect(matchCampusBuilding({latitude:.0002,longitude:.0002},10,[square,second])).toBeNull();
 expect(matchCampusBuilding(hubPoint,101)).toBeNull();expect(matchCampusBuilding(hubPoint,NaN)).toBeNull();
});
test('HUB recognition and confirmation work with no free calendar time; yes never starts a session',async()=>{
 const s=await setup();await s.reminders.tick();s.time(1);await s.reminders.tick();s.time(3);await s.reminders.tick();
 expect(s.sent).toHaveLength(1);expect(s.sent[0]).toContain('Student Union Building (HUB)');expect(s.calls).toBe(0);
 s.time(4);await s.reminders.tick();expect(await s.reminders.handle('chat','yes','save')).toContain('Saved');expect(s.starts).toBe(0);
 s.time(14);await s.reminders.tick();s.time(15);await s.reminders.tick();s.time(17);await s.reminders.tick();expect(s.sent).toHaveLength(1);expect(s.calls).toBe(0);
});
test('calendar outage cannot block a ready building recognition question',async()=>{
 const s=await setup(true);await expect(s.reminders.tick()).rejects.toThrow('calendar offline');s.time(1);await expect(s.reminders.tick()).rejects.toThrow('calendar offline');
 const before=s.reads;s.time(3);await s.reminders.tick();expect(s.sent).toHaveLength(1);expect(s.reads).toBe(before);
});
test('explicit where am i uses a fresh building estimate without saving or starting anything',async()=>{
 const s=await setup();expect(await s.smart.handle('chat','+15555550123','where am i?')).toContain('Student Union Building (HUB)');
 expect(s.sent).toHaveLength(0);expect(s.starts).toBe(0);expect(s.calls).toBe(0);
 s.move();expect(await s.smart.handle('chat','+15555550123','campus location')).toContain("couldn't identify");
});
test('moving away before confirming a UW building saves nothing',async()=>{
 const s=await setup();await s.reminders.tick();s.time(1);await s.reminders.tick();s.time(3);await s.reminders.tick();s.move();
 expect(await s.reminders.handle('chat','yes','moved')).toContain('Nothing was saved');expect(s.starts).toBe(0);
});
