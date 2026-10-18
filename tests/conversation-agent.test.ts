import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ConversationAgent,validateAgentDecision,type AgentDecision} from '../src/conversation-agent.ts';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const now=Date.parse('2026-10-19T15:00:00Z'),choice={id:'slot',start:now+3600000,end:now+5400000,minutes:30,productivity:4,mood:4,observations:4};
const decision=(part:Partial<AgentDecision>):AgentDecision=>({kind:'fallback',tool:null,action:null,optionId:null,args:{date:null,notBefore:null,minutes:null},reply:'',...part});
async function fixture(sequence:AgentDecision[],extras:Record<string,unknown>={}){const dir=await mkdtemp(join(tmpdir(),'agent-'));dirs.push(dir);let calls=0,books=0;const inputs:any[]=[];
 const deps={decide:async(input:any)=>{inputs.push(input);return sequence[calls++]!;},tool:async()=>({options:[choice]}),session:async()=>({sessionStatus:'none'}),book:async()=>{books++;return 'Booked and verified';},now:()=>now,...extras};
 return {dir,deps,agent:new ConversationAgent(deps,dir),inputs,get books(){return books},get calls(){return calls}};
}
test('agent observes tool results and proposes only an exact real candidate, without booking',async()=>{
 const f=await fixture([decision({kind:'tool',tool:'openings'}),decision({kind:'propose',optionId:'slot'})]);const result=await f.agent.run('chat','Find me half an hour tomorrow','m');expect(result?.reply).toContain('30-minute');expect(result?.offerId).toBeDefined();expect(f.inputs[1].observations[0].ok).toBe(true);expect(f.books).toBe(0);
 await f.agent.presented('chat',result!.offerId!);expect(await f.agent.resolve('chat','book it','yes')).toEqual({reply:'Booked and verified'});expect(f.books).toBe(1);
 expect(await new ConversationAgent(f.deps,f.dir).resolve('chat','book it','yes')).toEqual({reply:'Booked and verified'});expect(f.books).toBe(1);
});
test('an unseen offer, an invented option, and another chat cannot authorize a write',async()=>{
 const f=await fixture([decision({kind:'tool',tool:'openings'}),decision({kind:'propose',optionId:'slot'})]);await f.agent.run('chat','plan study','m');expect(await f.agent.resolve('other','yes','x')).toBeNull();expect((await f.agent.resolve('chat','yes','y'))?.reply).toContain('fresh suggestion');expect(f.books).toBe(0);
 const g=await fixture([decision({kind:'propose',optionId:'invented'})]);expect((await g.agent.run('chat','plan study','m'))?.reply).toContain('fresh calendar');expect(g.books).toBe(0);
});
test('decline and expiry do not book; confirmation survives restart',async()=>{
 let clock=now;const f=await fixture([decision({kind:'tool',tool:'openings'}),decision({kind:'propose',optionId:'slot'})],{now:()=>clock});const p=await f.agent.run('chat','plan study','m');await f.agent.presented('chat',p!.offerId!);clock+=11*60000;
 expect((await new ConversationAgent(f.deps,f.dir).resolve('chat','yes','confirm'))?.reply).toContain('expired');expect(f.books).toBe(0);
 const g=await fixture([decision({kind:'tool',tool:'openings'}),decision({kind:'propose',optionId:'slot'})]);const q=await g.agent.run('chat','plan study','m');await g.agent.presented('chat',q!.offerId!);expect((await g.agent.resolve('chat','no','deny'))?.reply).toContain('skipped');expect(g.books).toBe(0);
});
test('failed tools stay unknown; repeated calls and total steps are bounded',async()=>{
 const d=decision({kind:'tool',tool:'calendar'}),f=await fixture([d,d],{tool:async()=>{throw Error('offline')}});expect((await f.agent.run('chat','plan my day','m'))?.reply).toContain('access');expect(f.inputs[1].observations[0]).toMatchObject({ok:false,data:{error:expect.stringContaining('unavailable')}});expect(f.calls).toBe(2);
 const seq=['calendar','openings','learning','notes'].map(tool=>decision({kind:'tool',tool:tool as any})),g=await fixture(seq);expect((await g.agent.run('chat','plan everything','m'))?.reply).toContain('planning limit');expect(g.calls).toBe(4);
});
test('private-code workflows return a route, not a credential to the model',async()=>{
 const f=await fixture([decision({kind:'workflow',action:'dashboard_code'})]);expect(await f.agent.run('chat','Help connect my dashboard','m')).toEqual({route:'dashboard code'});expect(f.books).toBe(0);
});
test('session workflows recheck actual session state before routing to the rating flow',async()=>{
 const f=await fixture([decision({kind:'workflow',action:'finish_study'})]);const r=await f.agent.run('chat','I wrapped up','m');await f.agent.presented('chat',r!.offerId!);expect((await f.agent.resolve('chat','yes','y'))?.reply).toContain('no unfinished');expect(f.books).toBe(0);
});
test('cancellation stops an in-flight decision before it can create an offer',async()=>{
 let started!:()=>void;const ready=new Promise<void>(r=>started=r);const f=await fixture([],{decide:async(_i:any,signal:AbortSignal)=>{started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
 const running=f.agent.run('chat','plan study','m');await ready;f.agent.cancel('chat');expect(await running).toEqual({cancelled:true});expect(f.books).toBe(0);
});
test('decision validation rejects arbitrary capabilities and malformed constraints',()=>{
 expect(()=>validateAgentDecision({...decision({kind:'tool',tool:'calendar'}),admin:true})).toThrow();expect(()=>validateAgentDecision(decision({kind:'workflow',action:'delete_everything' as any}))).toThrow();expect(()=>validateAgentDecision(decision({kind:'tool',tool:'openings',args:{date:null,notBefore:'14:00',minutes:30}}))).toThrow();
});
