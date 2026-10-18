import {test,expect} from "bun:test";
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {acquireInstance,AlreadyRunning} from "../src/single-instance.ts";
test("second bot is refused, and a stopped bot can be restarted",()=>{
 const dir=mkdtempSync(join(tmpdir(),"bot-instance-")),path=join(dir,"lock.json");try{
 const release=acquireInstance(path,()=>true);expect(()=>acquireInstance(path,()=>true)).toThrow(AlreadyRunning);release();const next=acquireInstance(path,()=>true);next();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("crashed process locks recover, and old cleanup cannot remove a new owner",()=>{
 const dir=mkdtempSync(join(tmpdir(),"bot-instance-")),path=join(dir,"lock.json");try{
 writeFileSync(path,JSON.stringify({pid:999999,token:"crashed"}));const release=acquireInstance(path,()=>false);
 writeFileSync(path,JSON.stringify({pid:123,token:"replacement"}));release();expect(JSON.parse(readFileSync(path,"utf8")).token).toBe("replacement");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
