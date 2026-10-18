import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedbackFlow } from "../src/feedback.ts";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() { const directory = await mkdtemp(join(tmpdir(), "study-feedback-")); directories.push(directory); return { directory, flow: new FeedbackFlow(directory) }; }
async function records(directory: string) { const folder = join(directory, "records");return Promise.all((await readdir(folder)).map(async file => JSON.parse(await readFile(join(folder, file), "utf8")))); }
async function rate(flow: FeedbackFlow, values: string[], conversation = "test-user") {
  const replies = [];
  for (const [i, value] of values.entries()) replies.push(await flow.handle(conversation, value, `${conversation}-${i}`));
  return replies;
}
test("asks three ratings and completes immediately when distraction is low", async () => {
  const { directory, flow } = await setup();
  const replies = await rate(flow, ["rate session", "4", "3", "2"]);
  expect(replies[1]).toContain("mood");expect(replies[2]).toContain("distracted");expect(replies[3]).toContain("Saved locally");
  const saved = await records(directory);expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ productivity_rating: 4, mood_rating: 3, distraction_rating: 2, distraction_source: null, session_id: null, is_synthetic: false });
});
test("only high distraction asks a source, and no record is complete before its answer", async () => {
  for (const high of ["4", "5"]) {
    const { directory, flow } = await setup();const replies = await rate(flow, ["rate", "4", "3", high]);
    expect(replies[3]).toContain("surroundings");expect(await records(directory)).toHaveLength(0);
    await flow.handle("test-user", "phone", "source");expect((await records(directory))[0].distraction_source).toBe("phone");
  }
});
test("source is optional and accepts something else without guessing a cause", async () => {
  for (const [answer, expected] of [["skip", null], ["something else", "other"], ["surroundings", "surroundings"]]) {
    const { directory, flow } = await setup();await rate(flow, ["rate", "3", "3", "4"]);
    await flow.handle("test-user", answer!, "source");expect((await records(directory))[0].distraction_source).toBe(expected);
  }
});
test("invalid ratings and source answers do not advance the check-in", async () => {
  const { directory, flow } = await setup();await flow.handle("a", "rate", "start");
  for (const input of ["0", "6", "2.5", "hello"]) expect(await flow.handle("a", input, input)).toContain("whole number");
  expect(await flow.handle("a", "5", "p")).toContain("mood");
  await flow.handle("a", "4", "m");await flow.handle("a", "4", "d");
  expect(await flow.handle("a", "not sure", "invalid-source")).toContain("skip");expect(await records(directory)).toHaveLength(0);
});
test("check-in survives process restart and stays isolated per conversation", async () => {
  const { directory, flow } = await setup();await flow.handle("a", "rate", "start-a");await flow.handle("a", "5", "p");
  const restarted = new FeedbackFlow(directory);
  expect(await restarted.handle("a", "rate", "resume")).toContain("mood");
  expect(await restarted.handle("b", "rate", "start-b")).toContain("productive");
});
test("duplicate messages cannot advance twice or create duplicate completed records", async () => {
  const { directory, flow } = await setup();await flow.handle("a", "rate", "s");
  const first = await flow.handle("a", "4", "p");expect(await flow.handle("a", "4", "p")).toBe(first);
  expect(await flow.handle("a", "3", "m")).toContain("distracted");
  const saved = await flow.handle("a", "2", "d");expect(await flow.handle("a", "2", "d")).toBe(saved);expect(await records(directory)).toHaveLength(1);
});
test("cancel and reset discard incomplete feedback; ordinary messages pass to the existing bot", async () => {
  const { directory, flow } = await setup();expect(await flow.handle("a", "hello", "hello")).toBeNull();
  await flow.handle("a", "rate", "s");expect(await flow.handle("a", "cancel", "c")).toContain("canceled");
  await flow.handle("a", "rate", "s2");expect(await flow.handle("a", "reset", "r")).toBeNull();
  expect(await flow.handle("a", "4", "p")).toBeNull();expect(await records(directory)).toHaveLength(0);
});
