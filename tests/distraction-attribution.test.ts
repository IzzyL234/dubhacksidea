import {afterEach,expect,test} from "bun:test";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FeedbackFlow,type SessionFeedback} from "../src/feedback.ts";
import {SupabaseFeedback} from "../src/feedback-cloud.ts";
import {observationWeight} from "../src/sessions.ts";
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function setup(){const dir=await mkdtemp(join(tmpdir(),"attribution-"));dirs.push(dir);return {dir,flow:new FeedbackFlow(dir,null)};}
async function begin(flow:FeedbackFlow,distraction="5"){for(const [i,t] of ["rate","1","2",distraction].entries())await flow.handle("chat",t,String(i));}
async function record(dir:string){const [file]=await readdir(join(dir,"records"));return JSON.parse(await readFile(join(dir,"records",file!),"utf8")) as SessionFeedback;}
test("three explicit categories preserve original ratings and apply declared weights",async()=>{
 for(const [answer,category,weight] of [["interruption","interruption",.25],["1","interruption",.25],["setup","setup",1],["2","setup",1],["unsure","unsure",1],["3","unsure",1],["not sure","unsure",1],["skip","unsure",1]] as const){
  const {dir,flow}=await setup();await begin(flow);await flow.handle("chat",answer,"answer");const r=await record(dir);
  expect(r).toMatchObject({productivity_rating:1,mood_rating:2,distraction_rating:5,distraction_attribution:category,distraction_source:null});expect(observationWeight(r)).toBe(weight);
 }
});
test("attribution question survives restart and duplicate answer saves once",async()=>{
 const {dir,flow}=await setup();await begin(flow);expect(await readdir(join(dir,"records"))).toHaveLength(0);
 const resumed=new FeedbackFlow(dir,null);expect(await resumed.handle("chat","rate","resume")).toContain("interruption");
 expect(await resumed.handle("chat","invalid","invalid")).toContain("unsure");expect(await readdir(join(dir,"records"))).toHaveLength(0);
 const reply=await resumed.handle("chat","setup","answer");expect(await resumed.handle("chat","setup","answer")).toBe(reply);expect(await readdir(join(dir,"records"))).toHaveLength(1);
});
test("low distraction has no attribution and legacy feedback retains its weight",async()=>{
 const {dir,flow}=await setup();await begin(flow,"2");expect((await record(dir)).distraction_attribution).toBeNull();
 for(const [source,weight] of [["phone",.25],["other",.25],["surroundings",1],[null,1]] as const)expect(observationWeight({distraction_rating:5,distraction_source:source} as SessionFeedback)).toBe(weight);
 expect(observationWeight({distraction_rating:5,distraction_source:"other",distraction_attribution:"unsure"} as SessionFeedback)).toBe(1);
 expect(observationWeight({distraction_rating:2,distraction_attribution:"interruption"} as SessionFeedback)).toBe(1);
});
test("cloud payload preserves explicit uncertainty and does not invent attribution for legacy rows",async()=>{
 const payloads:any[]=[];const sink=new SupabaseFeedback("https://example.supabase.co","sb_secret_test",(async(_url,init)=>{payloads.push(JSON.parse(String(init?.body)));return new Response(null,{status:201});}) as typeof fetch);
 const {dir,flow}=await setup();await begin(flow);await flow.handle("chat","unsure","answer");const r=await record(dir);await sink.put(r);expect(payloads[0].distraction_attribution).toBe("unsure");
 const {distraction_attribution,...legacy}=r;await sink.put(legacy);expect(payloads[1]).not.toHaveProperty("distraction_attribution");
});
test("missing cloud column retains attribution locally and retries after migration",async()=>{
 const {dir}=await setup();let migrated=false;const uploaded:SessionFeedback[]=[];
 const sink={put:async(r:SessionFeedback)=>{if(!migrated)throw Error("column missing");uploaded.push(r);}};
 const flow=new FeedbackFlow(dir,sink);await begin(flow);expect(await flow.handle("chat","interruption","answer")).toContain("Saved locally");const original=await record(dir);
 migrated=true;const restarted=new FeedbackFlow(dir,sink);expect(await restarted.syncPending()).toEqual({synced:1,pending:0});expect(uploaded[0]).toEqual(original);expect(uploaded[0]?.distraction_attribution).toBe("interruption");
});

