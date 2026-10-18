import {test,expect} from 'bun:test';
import {createInboundDispatch} from '../src/inbound-dispatch.ts';
test('duplicate live/recovery deliveries never cancel the original planning turn',async()=>{
 const claims=new Set<string>();let cancellations=0,handled=0;const work:(()=>Promise<void>)[]=[];
 const dispatch=createInboundDispatch<{id:string}>({claim:async(c,id)=>{const k=c+id;if(claims.has(k))return false;claims.add(k);return true},cancel:()=>{cancellations++},enqueue:async(_,fn)=>{work.push(fn)},handle:async()=>{handled++},id:m=>m.id,isText:()=>true,onError:()=>{throw Error('unexpected')}});
 expect(await dispatch('chat',{id:'one'})).toBe(true);expect(await dispatch('chat',{id:'one'})).toBe(false);expect(cancellations).toBe(1);expect(work).toHaveLength(1);await work[0]!();expect(handled).toBe(1);
 await dispatch('chat',{id:'two'});expect(cancellations).toBe(2);expect(work).toHaveLength(2);
});
