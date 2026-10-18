import {test,expect,afterEach} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SmartPrompts} from "../src/smart-prompts.ts";
import {decisionTrigger,reserveDecision,failedDecision,type CoordinatorMemory} from "../src/coordinator-memory.ts";
import {generateText} from "../src/text-model.ts";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
test("persistent event memory suppresses unchanged polls and reacts to feedback and session changes",()=>{
 const signals={place:"one",calendar:"one",learning:"one",session:"one",preferences:"one"};const m:CoordinatorMemory={};const now=1000000;
 expect(decisionTrigger(m,signals,now,"day").triggers).toEqual(["first_stable_context"]);reserveDecision(m,signals,now,"day");
 const restarted=JSON.parse(JSON.stringify(m));expect(decisionTrigger(restarted,signals,now+120000,"day").reason).toBe("no_meaningful_change");
 expect(decisionTrigger(restarted,{...signals,learning:"two",session:"two"},now+120000,"day").triggers).toEqual(["learning_changed","session_changed"]);
 failedDecision(restarted,now+120000,3600000);expect(decisionTrigger(restarted,{...signals,place:"two"},now+180000,"day").reason).toBe("coordinator_retry_backoff");
 expect(decisionTrigger(m,signals,now+1800000,"day").triggers).toContain("scheduled_review");
});
test("real coordinator retains dwell and decisions across restart and reevaluates new memory",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"event-coordinator-"));dirs.push(dir);const base=Date.parse("2026-10-17T19:00:00Z");let now=base,calls=0,status="none";
 const make=()=>new SmartPrompts({eventDriven:true,coordinatorPlaces:true,sessionState:async()=>({status}),now:()=>now,read:async()=>({latitude:47,longitude:-122,accuracy:10,locationType:"live",locationTimestamp:new Date(now),isLocatingInProgress:false}),decide:async facts=>{calls++;expect(facts.triggers?.length).toBeGreaterThan(0);return {action:"stay_quiet",reason:"poor_timing",confidence:.9,optionId:null};}},dir);
 let smart=make();await smart.handle("chat","+15555550123","smart prompts on");await smart.evaluate("chat");now+=60000;await smart.evaluate("chat");smart=make();now=base+180000;await smart.evaluate("chat");expect(calls).toBe(1);
 smart=make();now+=60000;expect((await smart.evaluate("chat")).reason).toBe("no_meaningful_change");expect(calls).toBe(1);
 status="completed";now+=60000;await smart.evaluate("chat");expect(calls).toBe(2);
});
test("xAI handles structured requests without Gemini and isolates conversation turns",async()=>{
 const oldProvider=process.env.AI_PROVIDER,oldKey=process.env.XAI_API_KEY;process.env.AI_PROVIDER="xai";process.env.XAI_API_KEY="test-only";
 try{const reply=await generateText("system",[{role:"user",parts:[{text:"hello"}]},{role:"model",parts:[{text:"hi"}]},{role:"user",parts:[{text:"next"}]}],{type:"object"},(async(url,init)=>{expect(String(url)).toBe("https://api.x.ai/v1/responses");const body=JSON.parse(String(init?.body));expect(body.store).toBe(false);expect(body.input.map((x:any)=>x.role)).toEqual(["user","assistant","user"]);expect(body.text.format.type).toBe("json_schema");return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:'{"ok":true}'}]}]});}) as typeof fetch);expect(reply).toBe('{"ok":true}');}
 finally{if(oldProvider===undefined)delete process.env.AI_PROVIDER;else process.env.AI_PROVIDER=oldProvider;if(oldKey===undefined)delete process.env.XAI_API_KEY;else process.env.XAI_API_KEY=oldKey;}
});
