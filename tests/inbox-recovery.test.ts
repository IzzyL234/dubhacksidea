import {test,expect} from 'bun:test';
import {InboxRecovery} from '../src/inbox-recovery.ts';
test('backup inbox only forwards fresh inbound messages in order, deduplicates overlapping pages, and retries failed hydration',async()=>{
 const delivered:string[]=[];let fail=true;const recovery=new InboxRecovery({recipient:async()=>'owner',list:async()=>[{id:'late',at:12000,outbound:false},{id:'old',at:1,outbound:false},{id:'sent',at:11000,outbound:true},{id:'first',at:11000,outbound:false}],deliver:async(c,id)=>{expect(c).toBe('owner');if(fail){fail=false;throw Error('temporary');}delivered.push(id);}},10000);
 await expect(recovery.tick()).rejects.toThrow();await recovery.tick();await recovery.tick();expect(delivered).toEqual(['first','late']);
});
test('backup never queries without a connected recipient and does not run overlapping requests',async()=>{
 let calls=0,owner:string|null=null;let release!:()=>void;const recovery=new InboxRecovery({recipient:async()=>owner,list:async()=>{calls++;await new Promise<void>(r=>release=r);return [];},deliver:async()=>{}},10000);
 await recovery.tick();expect(calls).toBe(0);owner='owner';const p=recovery.tick();await new Promise(r=>setTimeout(r,0));await recovery.tick();expect(calls).toBe(1);release();await p;
});
