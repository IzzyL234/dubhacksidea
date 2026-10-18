import {test,expect} from 'bun:test';
import {SupabaseAgentRuns} from '../src/agent-run-cloud.ts';
import {agentRunProjection} from '../src/agent-run-public.ts';
test('agent audit upload projects only action receipts, without prompts or private payloads',async()=>{
 let body:any;const sink=new SupabaseAgentRuns('https://example.supabase.co','sb_secret_test',async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(null,{status:201})});
 await sink.put('a'.repeat(64),[{id:'00000000-0000-4000-8000-000000000000',at:Date.now(),tools:[{tool:'openings',ok:true}],outcome:'proposal',text:'secret user text',key:'private'} as any]);
 expect(Object.keys(body[0]).sort()).toEqual(['id','outcome','reported_at','steps','user_key']);expect(JSON.stringify(body)).not.toContain('secret');expect(JSON.stringify(body)).not.toContain('private');
});
test('public agent receipts remove owner data and unrecognized steps',()=>{
 const value=agentRunProjection([{id:'00000000-0000-4000-8000-000000000000',reported_at:new Date().toISOString(),outcome:'proposal',user_key:'private',steps:[{tool:'calendar',ok:true,token:'private'},{tool:'delete',ok:true}]}]);
 expect(value[0]?.steps).toEqual([{tool:'calendar',ok:true}]);expect(JSON.stringify(value)).not.toContain('private');
});
