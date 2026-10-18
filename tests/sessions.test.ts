import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StudySessions, observationWeight, type StudySession, type SessionSink } from "../src/sessions.ts";
import { FeedbackFlow, type SessionFeedback } from "../src/feedback.ts";
import { StudyLearner, type Context } from "../src/learning.ts";
import { analyzePhoto, validateWorkspace } from "../src/vision.ts";
import { inboundMessages } from "../src/inbound.ts";
import type { Message } from "spectrum-ts";

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function setup(sink:SessionSink|null=null) {
  const root=await mkdtemp(join(tmpdir(),"linked-sessions-"));dirs.push(root);
  const seed=fileURLToPath(new URL("../data/seed_sessions.json",import.meta.url));
  const make=()=>new StudySessions(join(root,"sessions"),sink,join(root,"feedback","records"),seed,
    async()=>({clutter_score:3,lighting:"bright",ergonomics:null}));
  return {root,make,sessions:make()};
}
async function document(root:string) { const [name]=await readdir(join(root,"sessions"));return JSON.parse(await readFile(join(root,"sessions",name!),"utf8")) as {sessions:StudySession[]}; }
async function start(s:StudySessions,user="a") {
  await s.handle(user,"start studying","start");
  await s.handle(user,"library desk 45","context");
  await s.handle(user,"workspace bright 3 7","environment");
}
test("session and check-in remain linked through restarts, duplicate messages, and model replay",async()=>{
  const {root,sessions,make}=await setup();await start(sessions);
  await sessions.handle("a","start studying","start");
  expect((await document(root)).sessions).toHaveLength(1);
  const restarted=make();
  const saved:SessionFeedback[]=[];
  const order:string[]=[];
  const flow=new FeedbackFlow(join(root,"feedback"),{put:async row=>{order.push("feedback");saved.push(row);}}, {
    begin:key=>restarted.beginFeedback(key),afterSave:r=>restarted.completeFeedback(r),beforeUpload:async()=>{order.push("session");},
  });
  await flow.handle("a","done","done");
  expect((await document(root)).sessions[0]?.status).toBe("awaiting_feedback");
  for(const [i,text]of["4","3","2"].entries())await flow.handle("a",text,`rating${i}`);
  await flow.handle("a","2","rating2");
  expect(saved).toHaveLength(1);expect(order).toEqual(["session","feedback"]);
  const completed=(await document(root)).sessions[0]!;
  expect(saved[0]?.session_id).toBe(completed.id);expect(completed.status).toBe("completed");
  expect(completed.ended_at).not.toBeNull();
  await restarted.handle("a","start studying","start2");
  await restarted.handle("a","library desk 45","context2");
  await restarted.handle("a","workspace bright 3 7","environment2");
  const score=await restarted.handle("a","study score","score");
  expect(score).toContain("1 of your linked check-ins");
  expect(await make().handle("a","study score","score2")).toBe(score);
  await restarted.handle("b","start studying","startb");
  expect(await restarted.handle("b","study score","scoreb")).toContain("complete workspace context");
});
test("photos attach once to the active session; missing visual posture is not fabricated",async()=>{
  const {root,sessions}=await setup();let reads=0;
  const read=async()=>{reads++;return new Uint8Array([1]);};
  expect(await sessions.photo("a","photo","image/jpeg",read)).toContain("start studying");
  await sessions.handle("a","start studying","start");
  await sessions.handle("a","library desk 45","details");
  expect(await sessions.photo("a","photo","image/jpeg",read)).toContain("couldn't assess");
  await sessions.photo("a","photo","image/jpeg",read);expect(reads).toBe(1);
  expect((await document(root)).sessions[0]?.environment.ergonomics).toBeNull();
  await sessions.handle("a","comfort 7","comfort");
  expect((await document(root)).sessions[0]?.environment_source).toBe("mixed");
});
test("invalid context preserves previous values and canceled/missing sessions never supply labels",async()=>{
  const {root,sessions}=await setup();await start(sessions);
  await sessions.handle("a","workspace dim 9 2 unexpected","invalid");
  expect((await document(root)).sessions[0]?.environment.clutter_score).toBe(3);
  await sessions.handle("a","discard session","discard");
  expect((await document(root)).sessions[0]?.status).toBe("canceled");
  const flow=new FeedbackFlow(join(root,"feedback"),null,{begin:key=>sessions.beginFeedback(key)});
  expect(await flow.handle("a","done","done")).toContain("No unfinished");
});
test("cloud failures retain sessions locally and feedback can retry only after parent exists",async()=>{
  let fail=true;const cloud:StudySession[]=[];
  const {root,sessions}=await setup({put:async s=>{if(fail)throw Error("offline");cloud.push(s);}});await start(sessions);
  const uploaded:SessionFeedback[]=[];
  const flow=new FeedbackFlow(join(root,"feedback"),{put:async r=>{uploaded.push(r);}}, {
    begin:k=>sessions.beginFeedback(k),afterSave:r=>sessions.completeFeedback(r),beforeUpload:r=>sessions.ensureCloud(r),
  });
  for(const [i,text]of["done","4","3","1"].entries())await flow.handle("a",text,String(i));
  expect(uploaded).toHaveLength(0);expect((await document(root)).sessions[0]?.status).toBe("completed");
  fail=false;expect((await flow.syncPending()).synced).toBe(1);
  expect(cloud).toHaveLength(1);
  expect(cloud[0]?.id).toBe(uploaded[0]!.session_id!);
});
test("high unrelated distraction reduces influence, but never changes the reported rating",()=>{
  const context:Context={timestamp:"2026-10-17T12:00:00Z",duration_mins:45,location:"library",study_space:"desk",environment:{lighting:"bright",clutter_score:2,ergonomics:8}};
  const observation={...context,id:"real",user_productivity_rating:1,user_mood_rating:1};
  const full=new StudyLearner(),less=new StudyLearner();full.observe(observation);less.observe(observation,0.25);
  expect(less.predict(context).predictedProductivity).toBeGreaterThan(full.predict(context).predictedProductivity);
  expect(observation.user_productivity_rating).toBe(1);
  expect(observationWeight({distraction_rating:5,distraction_source:"phone"} as SessionFeedback)).toBe(0.25);
  expect(observationWeight({distraction_rating:5,distraction_source:"surroundings"} as SessionFeedback)).toBe(1);
  expect(()=>less.observe({...observation,id:"bad"},0)).toThrow();
});
test("photo API validates structured output, refuses missing data, and never uses mock values",async()=>{
  let sent:Record<string,any>|undefined;
  const request=async(_url:string,init?:RequestInit)=>{sent=JSON.parse(String(init?.body));return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({clutter_score:4,lighting:"dim",ergonomics:null})}}]});};
  expect(await analyzePhoto(new Uint8Array([255,216,255,224]),"image/jpeg","test-key",request)).toEqual({clutter_score:4,lighting:"dim",ergonomics:null});
  expect(sent?.messages[0].content[1].image_url.url).toStartWith("data:image/jpeg;base64,");
  expect(()=>validateWorkspace({clutter_score:3,lighting:"bright"})).toThrow();
  expect(()=>validateWorkspace({clutter_score:99,lighting:"bright",ergonomics:7})).toThrow();
  await expect(analyzePhoto(new Uint8Array([255,216,255,224]),"image/jpeg","test-key",async()=>new Response(null,{status:429}))).rejects.toThrow("429");
});
test("Spectrum grouped photos are processed as child messages while outbound echoes are excluded",()=>{
  const image={id:"image",direction:"inbound",content:{type:"attachment",mimeType:"image/jpeg"}};
  const echo={id:"echo",direction:"outbound",content:{type:"text",text:"bot reply"}};
  const group={id:"group",direction:"inbound",content:{type:"group",items:[image,echo]}} as unknown as Message;
  expect(inboundMessages(group).map(m=>m.id)).toEqual(["image"]);
});
