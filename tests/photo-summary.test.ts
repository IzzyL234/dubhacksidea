import {test,expect,afterEach} from "bun:test";
import {mkdtemp,rm,readFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {StudySessions} from "../src/sessions.ts";
import {validateWorkspace} from "../src/vision.ts";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function root(){const d=await mkdtemp(join(tmpdir(),"photo-summary-"));dirs.push(d);return d;}
test("manual session photo is friendly and does not demand planned duration or hidden posture",async()=>{
 const dir=await root();let now=Date.parse("2026-10-18T07:00:00Z");
 const s=new StudySessions(dir,null,join(dir,"feedback"),join(dir,"no-starter-data"),async()=>({lighting:"bright",clutter_score:2,ergonomics:null,study_space:"desk"}),null,()=>now);
 await s.handle("chat","start studying","start");const reply=await s.photo("chat","photo","image/jpeg",async()=>new Uint8Array([1]));
 expect(reply).toContain("📸");expect(reply).toContain("🧹 Clutter: 2/10");expect(reply).toContain("don’t have enough");expect(reply).not.toContain("comfort 7");expect(reply).not.toContain("workspace bright");expect(reply).not.toContain("planned minutes");
 now+=23.5*60000;await s.beginFeedback(createHash("sha256").update("chat").digest("hex"));const file=(await readdir(dir)).find(n=>/^[a-f0-9]{64}.json$/.test(n))!;const doc=JSON.parse(await readFile(join(dir,file),"utf8"));expect(doc.sessions[0].duration_mins).toBe(23.5);expect(doc.sessions[0].study_space).toBe("desk");expect(doc.sessions[0].environment.ergonomics).toBeNull();
});
test("photo predictions use real historical learning while labeling missing-context comparisons",async()=>{
 const dir=await root(),user=createHash("sha256").update("chat").digest("hex");const id="11111111-1111-4111-8111-111111111111";
 const session={id:"past",user_id:user,started_at:"2026-10-17T19:00:00Z",ended_at:"2026-10-17T19:45:00Z",duration_mins:45,location:"library" as const,study_space:"desk" as const,environment:{lighting:"bright" as const,clutter_score:2,ergonomics:8},environment_source:"perceptron" as const,status:"completed" as const,feedback_id:id,is_synthetic:false as const};
 const feedback={id,conversation_key:user,reported_at:session.ended_at,session_id:"past",productivity_rating:5,mood_rating:5,distraction_rating:1,distraction_source:null,is_synthetic:false as const};
 const s=new StudySessions(dir,null,join(dir,"feedback"),undefined,async()=>({lighting:"bright",clutter_score:2,ergonomics:null}),{load:async()=>[{session_record:session,feedback_record:feedback}]});
 await s.handle("chat","start studying","start");const reply=await s.photo("chat","photo","image/jpeg",async()=>new Uint8Array([1]));expect(reply).toContain("Based on 1");expect(reply).toContain("Estimated productivity");expect(reply).toContain("historical values");expect(reply).not.toContain("planned minutes");
});
test("visible seating is optional and unsupported labels are rejected",()=>{
 expect(validateWorkspace({lighting:"bright",clutter_score:2,ergonomics:null,study_space:"desk"}).study_space).toBe("desk");expect(()=>validateWorkspace({lighting:"bright",clutter_score:2,ergonomics:null,study_space:"library"})).toThrow();
});
test("starter data produces labeled model numbers without becoming personal learning",async()=>{
 const dir=await root();const s=new StudySessions(dir,null,join(dir,"feedback"),undefined,async()=>({lighting:"bright",clutter_score:2,ergonomics:8,study_space:"desk"}),null);
 await s.handle("chat","start studying","start");const reply=await s.photo("chat","photo","image/jpeg",async()=>new Uint8Array([1]));
 expect(reply).toContain("40 synthetic demo sessions");expect(reply).toMatch(/Model score: \d+\/100/);expect(reply).toMatch(/Predicted productivity: \d\.\d\/5/);expect(reply).toContain("not your personal history");
 const options=await s.proactiveOptions("chat","library",60);expect(options.observations).toBe(0);expect(options.options.every(o=>o.predictedProductivity===null)).toBe(true);
});
