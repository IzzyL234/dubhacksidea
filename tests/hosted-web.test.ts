import {test,expect} from 'bun:test';
import {hostedWeb} from '../src/hosted-web.ts';
const id='a'.repeat(16),token='Bearer '+'b'.repeat(43);
test('hosted site exposes no shared calendar or legacy OAuth/write routes',async()=>{
 for(const path of ['/api/calendar','/api/google-calendar/today','/api/auth/google/url','/api/calendar/proposals/demo/approve'])expect((await hostedWeb(new Request('https://daywise.example'+path))).status).toBe(404);
 expect((await hostedWeb(new Request('https://daywise.example/api/learning/dashboard'))).status).toBe(401);
});
test('review proxy enforces capability, explicit action, origin and backend configuration',async()=>{
 const url='https://daywise.example/api/learning/reviews/'+id;
 expect((await hostedWeb(new Request(url))).status).toBe(401);
 expect((await hostedWeb(new Request(url,{headers:{Authorization:token}}))).status).toBe(503);
 expect((await hostedWeb(new Request(url+'/approve',{headers:{Authorization:token}}))).status).toBe(405);
 expect((await hostedWeb(new Request(url+'/approve',{method:'POST',headers:{Authorization:token,Origin:'https://other.example'}}))).status).toBe(403);
 expect((await hostedWeb(new Request(url,{headers:{Authorization:token}}),{reviewBackend:'http://localhost:3002'})).status).toBe(503);
});
test('review proxy forwards only the scoped action and strips private fields',async()=>{
 const review={id,createdAt:'2026-10-18T15:00:00Z',expiresAt:'2099-10-18T17:00:00Z',status:'pending',title:'Study',before:{start:'2099-10-18T17:00:00Z',end:'2099-10-18T18:00:00Z'},after:{start:'2099-10-18T19:00:00Z',end:'2099-10-18T20:00:00Z'},conflicts:[],eventId:'private',etag:'private',conversation:'private'};
 let calls=0;const request:typeof fetch=async(input,init)=>{calls++;expect(String(input)).toBe('https://worker.example/api/learning/reviews/'+id+'/deny');expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');expect(init?.headers).toEqual({Authorization:token});return Response.json({review});};
 const r=await hostedWeb(new Request('https://daywise.example/api/index?route=learning/reviews/'+id+'/deny',{method:'POST',headers:{Authorization:token,Origin:'https://daywise.example'}}),{reviewBackend:'https://worker.example',request});
 expect(r.status).toBe(200);expect(calls).toBe(1);const value=await r.json();expect(value.review.eventId).toBeUndefined();expect(value.review.conversation).toBeUndefined();expect(value.review.id).toBe(id);
});
test('hosted proxy rejects invalid or mismatched backend payloads',async()=>{
 for(const body of [{review:{id:'0'.repeat(16)}},{unexpected:true}]){
 const response=await hostedWeb(new Request('https://daywise.example/api/learning/reviews/'+id,{headers:{Authorization:token}}),{reviewBackend:'https://worker.example',request:async()=>Response.json(body)});expect(response.status).toBe(503);
 }
});
