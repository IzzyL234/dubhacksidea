import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedbackFlow, type SessionFeedback } from "../src/feedback.ts";
import { SupabaseFeedback, type FeedbackSink } from "../src/feedback-cloud.ts";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(sink: FeedbackSink) {
  const dir = await mkdtemp(join(tmpdir(), "cloud-feedback-")); directories.push(dir);
  return { dir, flow: new FeedbackFlow(dir, sink) };
}
async function complete(flow: FeedbackFlow, high = false) {
  for (const [i, text] of ["rate", "4", "3", high ? "5" : "2"].entries()) await flow.handle("user", text, String(i));
  if (high) return flow.handle("user", "phone", "4");
  return flow.handle("user", "2", "3");
}
test("completed check-ins upload with the existing ratings/source fields and keep a local copy", async () => {
  const saved: SessionFeedback[] = [];
  const { flow, dir } = await setup({ put: async row => { saved.push(row); } });
  expect(await complete(flow, true)).toBe("Saved to Supabase. Thanks!");
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ productivity_rating: 4, mood_rating: 3, distraction_rating: 5, distraction_source: "phone", session_id: null });
  expect((await readdir(join(dir, "records"))).length).toBe(1);
  expect(await flow.syncPending()).toEqual({ synced: 0, pending: 0 });
  expect(saved).toHaveLength(1);
});
test("network failure keeps feedback and restart retries the exact same immutable record", async () => {
  const { dir, flow } = await setup({ put: async () => { throw new Error("offline"); } });
  expect(await complete(flow)).toContain("Saved locally");
  const [file] = await readdir(join(dir, "records"));
  const original = JSON.parse(await readFile(join(dir, "records", file!), "utf8"));
  const uploaded: SessionFeedback[] = [];
  const restarted = new FeedbackFlow(dir, { put: async row => { uploaded.push(row); } });
  expect(await restarted.syncPending()).toEqual({ synced: 1, pending: 0 });
  expect(uploaded[0]).toEqual(original);
  await restarted.syncPending();expect(uploaded).toHaveLength(1);
});
test("concurrent retry calls share a single upload for one record", async () => {
  const { dir, flow } = await setup({ put: async () => { throw new Error("offline"); } });
  await complete(flow);
  let calls = 0;
  const restarted = new FeedbackFlow(dir, { put: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); } });
  await Promise.all([restarted.syncPending(), restarted.syncPending()]);
  expect(calls).toBe(1);
});
test("Supabase sends a secret header, immutable ID conflict handling and no raw conversation ID", async () => {
  let captured: any;
  const request = (async (url: any, init: any) => { captured = { url, init }; return new Response(null, { status: 201 }); }) as typeof fetch;
  const sink = new SupabaseFeedback("https://example.supabase.co", "sb_secret_test", request);
  const { flow } = await setup(sink);await complete(flow);
  expect(captured.url).toBe("https://example.supabase.co/rest/v1/study_feedback?on_conflict=id");
  expect(captured.init.headers.apikey).toBe("sb_secret_test");
  expect(captured.init.headers.Prefer).toContain("ignore-duplicates");
  const body = JSON.parse(captured.init.body);
  expect(body.conversation_key).toMatch(/^[a-f0-9]{64}$/);expect(body.conversation_key).not.toBe("user");
  expect(captured.init.redirect).toBe("error");
});
test("readiness check reports missing table and does not write sample feedback", async () => {
  const sink = new SupabaseFeedback("https://example.supabase.co", "sb_secret_test",
    (async (_url: any, init: any) => { expect(init.method).toBeUndefined();return new Response(null, { status: 404 }); }) as typeof fetch);
  await expect(sink.check()).rejects.toThrow("002_study_feedback.sql");
});
test("misconfigured URLs and public keys cannot send backend credentials", () => {
  expect(() => new SupabaseFeedback("http://example.supabase.co", "sb_secret_test")).toThrow();
  expect(() => new SupabaseFeedback("https://attacker.test", "sb_secret_test")).toThrow();
  expect(() => new SupabaseFeedback("https://example.supabase.co", "sb_publishable_test")).toThrow();
});
