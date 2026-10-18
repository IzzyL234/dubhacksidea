import {test,expect} from 'bun:test';
import {ConversationQueue} from '../src/conversation-queue.ts';
test('slow chats do not block other users and same-chat messages stay ordered after failure',async()=>{
 const q=new ConversationQueue(),order:string[]=[];let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const first=q.enqueue('one',async()=>{await gate;order.push('one');throw Error('failed')});const caught=first.catch(()=>{});
 const second=q.enqueue('one',async()=>{order.push('two')});await q.enqueue('other',async()=>{order.push('other')});expect(order).toEqual(['other']);release();await caught;await second;expect(order).toEqual(['other','one','two']);
});
