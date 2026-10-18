import {afterEach,expect,test} from "bun:test";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {FeedbackFlow,type DistractionAttribution} from "../src/feedback.ts";
import {interpretDistraction,validateAttribution} from "../src/distraction-language.ts";
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function setup(interpret:(text:string)=>Promise<DistractionAttribution>){const dir=await mkdtemp(join(tmpdir(),"language-feedback-"));dirs.push(dir);const make=()=>new FeedbackFlow(dir,null,{},interpret);const flow=make();for(const [i,t] of ["rate","1","2","5"].entries())await flow.handle("chat",t,String(i));return{dir,flow,make};}
async function records(dir:string){return Promise.all((await readdir(join(dir,"records"))).map(async f=>JSON.parse(await readFile(join(dir,"records",f),"utf8"))));}
test("natural language suggests attribution but saves no feedback until confirmation",async()=>{
 const {dir,flow}=await setup(async text=>{expect(text).toBe("My friend kept interrupting me.");return "interruption";});
 expect(await flow.handle("chat","My friend kept interrupting me.","describe")).toContain("one-off interruption");expect(await records(dir)).toHaveLength(0);
 await flow.handle("chat","yes","confirm");expect((await records(dir))[0]).toMatchObject({productivity_rating:1,mood_rating:2,distraction_rating:5,distraction_attribution:"interruption"});
 expect(JSON.stringify(await records(dir))).not.toContain("My friend");
});
test("confirmation survives restart, accepts correction and keeps chats separate",async()=>{
 const {dir,flow,make}=await setup(async()=>"interruption");await flow.handle("chat","There were people nearby.","describe");
 const restarted=make();expect(await restarted.handle("chat","rate","resume")).toContain("Reply yes");
 expect(await restarted.handle("other-chat","yes","wrong-chat")).toBeNull();expect(await records(dir)).toHaveLength(0);
 await restarted.handle("chat","setup","correction");expect((await records(dir))[0].distraction_attribution).toBe("setup");
});
test("no rejects suggestion and direct categories avoid model calls",async()=>{
 let calls=0;const {dir,flow}=await setup(async()=>{calls++;return "setup";});await flow.handle("chat","The chair was uncomfortable.","describe");
 expect(await flow.handle("chat","no","reject")).toContain("What best");expect(await records(dir)).toHaveLength(0);
 await flow.handle("chat","unsure","answer");expect(calls).toBe(1);expect((await records(dir))[0].distraction_attribution).toBe("unsure");
});
test("duplicate concurrent descriptions make one request and one confirmed record",async()=>{
 let calls=0;const {dir,flow}=await setup(async()=>{calls++;await Bun.sleep(15);return "unsure";});
 const replies=await Promise.all([flow.handle("chat","I don't know what happened.","describe"),flow.handle("chat","I don't know what happened.","describe")]);expect(replies[0]).toBe(replies[1]);expect(calls).toBe(1);
 await Promise.all([flow.handle("chat","yes","confirm"),flow.handle("chat","yes","confirm")]);expect(await records(dir)).toHaveLength(1);
});
test("failed or invalid interpretations never save or guess and calls are capped",async()=>{
 let calls=0;const {dir,flow,make}=await setup(async()=>{calls++;if(calls===1)throw Error("offline");return "invented" as DistractionAttribution;});
 for(let i=0;i<3;i++)expect(await (i===2?make():flow).handle("chat","Everything was pretty awful.",`attempt${i}`)).toContain("unsure");
 expect(calls).toBe(2);expect(await records(dir)).toHaveLength(0);await flow.handle("chat","skip","skip");expect((await records(dir))[0].distraction_attribution).toBe("unsure");
});
test("interpreter schema is strict and API receives only the bounded description",async()=>{
 for(const v of [{attribution:"negative"},{attribution:"setup",rating:1},null])expect(()=>validateAttribution(v)).toThrow();
 const old=process.env.XAI_API_KEY;process.env.XAI_API_KEY="test-only";
 try{
  const result=await interpretDistraction("A friend interrupted me.",(async(url,init)=>{expect(String(url)).toBe("https://api.x.ai/v1/responses");const body=JSON.parse(String(init?.body));expect(body.store).toBe(false);expect(body.input).toBe(JSON.stringify({description:"A friend interrupted me."}));expect(body.text.format.schema.additionalProperties).toBe(false);return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:'{"attribution":"interruption"}'}]}]});}) as typeof fetch);expect(result).toBe("interruption");
  await expect(interpretDistraction("x".repeat(801))).rejects.toThrow("length");
 }finally{if(old===undefined)delete process.env.XAI_API_KEY;else process.env.XAI_API_KEY=old;}
});
