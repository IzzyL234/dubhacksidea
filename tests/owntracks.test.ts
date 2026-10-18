import { expect, test } from "bun:test";
import { createHandler } from "../supabase/functions/owntracks/handler.ts";

const settings = { username: "test-phone", password: "test-only-password-long-enough", url: "https://example.supabase.co", serviceKey: "test-backend-key" };
const auth = `Basic ${btoa(`${settings.username}:${settings.password}`)}`;
const payload = { _type: "transition", desc: "Library", event: "enter", tst: 1700000000, wtst: 1690000000, lat: 47, lon: -122 };
const req = (p: unknown, authorization = auth) => new Request("https://example.test", { method: "POST", headers: { authorization }, body: JSON.stringify(p) });

test("requires authentication before database access and fails closed without configuration", async () => {
  let calls = 0;
  const fake = (async () => { calls++; return new Response(null, {status:201}); }) as (url: string, init?: RequestInit) => Promise<Response>;
  expect((await createHandler(settings, fake)(req(payload, "Basic invalid"))).status).toBe(401);
  expect((await createHandler({...settings,password:""}, fake)(req(payload))).status).toBe(503);
  expect(calls).toBe(0);
});
test("saves only named transitions and makes retry identity stable", async () => {
  const rows: Record<string, unknown>[] = [];
  const fake = (async (_url, init) => { rows.push(JSON.parse(String(init?.body))); return new Response(null,{status:201}); }) as (url: string, init?: RequestInit) => Promise<Response>;
  const handler = createHandler(settings, fake);
  expect(await (await handler(req(payload))).json()).toEqual([]);
  await handler(req({...payload,topic:"attacker/device"}));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(rows[1]);
  expect(rows[0]?.region_name).toBe("Library");
  expect(rows[0]).not.toHaveProperty("lat");
  expect(rows[0]).not.toHaveProperty("lon");
  expect(rows[0]).not.toHaveProperty("topic");
  await handler(req({_type:"location",lat:47,lon:-122}));
  expect(rows).toHaveLength(2);
});
test("rejects malformed transitions and does not acknowledge failed storage", async () => {
  const handler = createHandler(settings, (async () => new Response(null,{status:500})) as (url: string, init?: RequestInit) => Promise<Response>);
  expect((await handler(req({...payload,event:"studying"}))).status).toBe(400);
  expect((await handler(req({...payload,tst:Date.now()/1000+10000}))).status).toBe(400);
  expect((await handler(req(payload))).status).toBe(503);
  expect((await handler(req({_type:"encrypted"}))).status).toBe(422);
});
test("bounds payload size and accepts OwnTracks empty notifications", async () => {
  const handler = createHandler(settings);
  expect((await handler(req({x:"a".repeat(17000)}))).status).toBe(413);
  expect(await (await handler(new Request("https://example.test", {method:"POST",headers:{authorization:auth},body:""}))).json()).toEqual([]);
});
