import {afterEach,expect,test} from "bun:test";
import {mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StudySessions,type PhotoLogEntry} from "../src/sessions.ts";
import {StudyLearner} from "../src/learning.ts";
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function setup(){const dir=await mkdtemp(join(tmpdir(),"main-study-merge-"));dirs.push(dir);return dir;}
test("recommendations preserved from main do not claim a proven location without real history",async()=>{
 const dir=await setup();const s=new StudySessions(join(dir,"sessions"),null,join(dir,"feedback"),"unused-seed",undefined,null);
 const result=await s.handle("chat","recommend space","recommend");expect(result).toContain("don't have enough of your study data");expect(result).not.toContain("LinUCB");expect(result).not.toContain("Unexplored option");
});
test("photo logs and model exports coexist with linked-session replay",async()=>{
 const dir=await setup();const logged:PhotoLogEntry[]=[];const models:any[]=[];
 const s=new StudySessions(join(dir,"sessions"),{put:async()=>{},putPhotoLog:async e=>{logged.push(e);},putModelParams:async m=>{models.push(m);}},join(dir,"feedback"),"unused-seed",async()=>({clutter_score:2,lighting:"bright",ergonomics:8}),null);
 await s.handle("chat","start studying","start");await s.handle("chat","library desk 45","context");await s.photo("chat","photo","image/jpeg",async()=>new Uint8Array([1]));
 expect(logged).toHaveLength(1);const [file]=await readdir(join(dir,"sessions","photos"));const local=JSON.parse(await readFile(join(dir,"sessions","photos",file!),"utf8"));expect(local[0].session_id).toBe(logged[0]?.session_id);
 expect(models).toHaveLength(1);expect(await s.handle("chat","study score","score")).toContain("0 of your linked check-ins");expect(models).toHaveLength(2);expect(StudyLearner.fromState(models[0])?.learner.count).toBe(0);
});
