import {test,expect} from "bun:test";
import {mkdtemp,rm,mkdir,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {StudySessions} from "../src/sessions.ts";
test("old start replies replay the photo-first wording without creating another session",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"start-replay-"));try{
 const key=createHash("sha256").update("chat").digest("hex"),path=join(dir,key+".json");
 await mkdir(dir,{recursive:true});await writeFile(path,JSON.stringify({sessions:[],replies:[{id:"start",text:"Started a study session. Where, what seat, and how many planned minutes?"}]}));
 const s=new StudySessions(dir,null,join(dir,"feedback"),undefined,undefined,null);
 const reply=await s.handle("chat","start studying","start");expect(reply).toContain("photo of your workspace");expect(reply).not.toContain("what seat");expect(JSON.parse(await readFile(path,"utf8")).sessions).toHaveLength(0);
 expect(await s.handle("chat","start studying","new")).toContain("photo of your workspace");
 }finally{await rm(dir,{recursive:true,force:true});}
});
