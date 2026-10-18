import {test,expect} from "bun:test";
import {generateGemini} from "../src/gemini.ts";
test("temporary service errors retry with backoff and return one complete reply",async()=>{
 const old=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY="test-only";
 try {let calls=0;const delays:number[]=[];
 const reply=await generateGemini("test",[{role:"user",parts:[{text:"hello"}]}],undefined,(async()=>++calls<3?new Response(null,{status:503}):Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:"hello"}]}}]})) as typeof fetch,async ms=>{delays.push(ms);});
 expect(reply).toBe("hello");expect(calls).toBe(3);expect(delays).toEqual([1000,2000]);
 }finally{if(old===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old;}
});
test("retries are bounded and authentication failures are never retried",async()=>{
 const old=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY="test-only";
 try {for(const status of [503,401]){let calls=0;
 await expect(generateGemini("test",[{role:"user",parts:[{text:"hello"}]}],undefined,(async()=>{calls++;return new Response(null,{status});}) as typeof fetch,async()=>{})).rejects.toThrow(`HTTP ${status}`);
 expect(calls).toBe(status===503?3:1);
 }}finally{if(old===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old;}
});
