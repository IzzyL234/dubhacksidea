import {test,expect} from 'bun:test';
import {dashboardCommand} from '../src/dashboard-command.ts';
test('dashboard commands reach their dedicated handler and preserve chat and message identity',async()=>{
 let calls=0;const access={handle:async(c:string,t:string,id:string)=>{calls++;expect(c).toBe('chat');expect(id).toBe('message');return t;}};
 expect(await dashboardCommand(access,'chat','dashboard code','message')).toBe('dashboard code');
 expect(await dashboardCommand(access,'chat','study status','message')).toBeNull();expect(calls).toBe(1);
});
test('configuration and network failures yield an explicit reply instead of general chat',async()=>{
 expect(await dashboardCommand(null,'chat','dashboard code','m')).toContain('not configured');
 expect(await dashboardCommand({handle:async()=>{throw Error('offline')}},'chat','connect dashboard','m')).toContain('Please retry');
});
