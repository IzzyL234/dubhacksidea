import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalendarCommands } from "../src/calendar-commands.ts";
import type { CalendarGateway } from "../src/calendar-types.ts";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const now=Date.parse("2026-10-19T15:00:00Z");
const command="add event Study | 2026-10-19 14:00 | 2026-10-19 14:45";
async function setup(){const root=await mkdtemp(join(tmpdir(),"calendar-concurrency-"));roots.push(root);return root;}
function gateway(create:CalendarGateway["create"]):CalendarGateway{return {list:async()=>[],busy:async()=>[],get:async()=>({}),patch:async()=>({}),create};}
test("overlapping delivery retries execute the calendar write once",async()=>{
 const root=await setup();let calls=0;
 const commands=new CalendarCommands(gateway(async e=>{calls++;await Bun.sleep(30);return e;}),root,()=>now);
 const replies=await Promise.all([commands.handle("chat",command,"same-id"),commands.handle("chat",command,"same-id")]);
 expect(calls).toBe(1);expect(replies[0]).toBe(replies[1]);
});
test("concurrent different commands retain both replay records",async()=>{
 const root=await setup();
 const commands=new CalendarCommands(gateway(async e=>{await Bun.sleep(30);return e;}),root,()=>now);
 await Promise.all([commands.handle("chat",command,"first"),commands.handle("chat",command,"second")]);
 const files=await readdir(root);const state=JSON.parse(await readFile(join(root,files[0]!),"utf8"));
 expect(state.replies.map((r:{id:string})=>r.id).sort()).toEqual(["first","second"]);
});
test("a failed request does not block later commands",async()=>{
 const root=await setup();let calls=0;
 const commands=new CalendarCommands(gateway(async e=>{if(++calls===1)throw Error("temporary failure");return e;}),root,()=>now);
 const results=await Promise.allSettled([commands.handle("chat",command,"first"),commands.handle("chat",command,"second")]);
 expect(results[0]?.status).toBe("rejected");expect(results[1]?.status).toBe("fulfilled");expect(calls).toBe(2);
});
test("one chat's slow request does not block a different chat",async()=>{
 const root=await setup();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let started!:()=>void;const entered=new Promise<void>(r=>{started=r;});let calls=0;
 const commands=new CalendarCommands(gateway(async e=>{if(++calls===1){started();await gate;}return e;}),root,()=>now);
 const first=commands.handle("first-chat",command,"one");await entered;
 try{const result=await Promise.race([commands.handle("second-chat","calendar help","two"),Bun.sleep(500).then(()=>"blocked")]);expect(result).toContain("I can add");}finally{release();await first;}
});

