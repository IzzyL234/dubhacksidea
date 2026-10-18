import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuggestionReviewApi, type ReviewResult } from "../src/suggestion-review-api.ts";

const directories: string[] = [];
const apis: SuggestionReviewApi[] = [];
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(execute: (decision: "accept" | "decline") => Promise<ReviewResult>) {
  const directory = await mkdtemp(join(tmpdir(), "suggestion-review-"));
  directories.push(directory);
  const api = new SuggestionReviewApi(async (_conversation, id, decision) => execute(decision),
    "https://study.example", directory);
  apis.push(api);
  await api.listen(0, "127.0.0.1");
  const address = api.address()!;
  return { api, base: `http://127.0.0.1:${address.port}`, directory };
}

async function prepare(api: SuggestionReviewApi, base: string) {
  const created = await api.createSuggestion("private-conversation", {
    title: "Study session", start: Date.now() + 60_000, end: Date.now() + 45 * 60_000,
    availableUntil: Date.now() + 60 * 60_000, reason: "Calendar opening",
  }, Date.now() + 10 * 60_000);
  const url = new URL(created!.url), token = new URLSearchParams(url.hash.slice(1)).get("token")!;
  expect(url.pathname).toBe("/review");
  expect(url.searchParams.get("suggestion_id")).toBe(created!.id);
  expect(token).toBeTruthy();
  const exchange = await fetch(`${base}/api/v1/review-links/exchange`, {
    method: "POST", headers: { Origin: "https://study.example", "Content-Type": "application/json" },
    body: JSON.stringify({ suggestion_id: created!.id, token }),
  });
  return { id: created!.id, access: (await exchange.json() as { access_token: string }).access_token };
}

test("review link token exchanges once and grants access only to its suggestion", async () => {
  const { api, base } = await setup(async (decision) => ({ id: "unused", decision, status: "declined", calendar_status: "unchanged", message: "No change." }));
  const { id, access } = await prepare(api, base);
  const response = await fetch(`${base}/api/v1/suggestions/${id}`, { headers: { Authorization: `Bearer ${access}` } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id, status: "pending", title: "Study session", timezone: "America/Los_Angeles" });
});

test("acceptance executes once, is replayable with its idempotency key, and conflicts with another decision", async () => {
  let calls = 0;
  const { api, base } = await setup(async (decision) => {
    calls++;
    return { id: "unused", decision, status: "confirmed", calendar_status: "confirmed", message: "Added to calendar." };
  });
  const { id, access } = await prepare(api, base);
  const endpoint = `${base}/api/v1/suggestions/${id}/decision`;
  const request = (decision: string, key: string) => fetch(endpoint, {
    method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({ decision, idempotency_key: key }),
  });
  expect((await request("accept", "request-123")).status).toBe(200);
  expect((await request("accept", "request-123")).status).toBe(200);
  expect(calls).toBe(1);
  expect((await request("decline", "request-456")).status).toBe(409);
});

test("rejects invalid tokens and disallowed browser origins", async () => {
  const { api, base } = await setup(async (decision) => ({ id: "unused", decision, status: "declined", calendar_status: "unchanged", message: "No change." }));
  const created = await api.createSuggestion("chat", { title: "Study", start: Date.now() + 1000,
    end: Date.now() + 60_000, availableUntil: Date.now() + 60_000, reason: "Opening" }, Date.now() + 60_000);
  const url = new URL(created!.url);
  expect(url.pathname).toBe("/review");
  expect(url.searchParams.get("suggestion_id")).toBe(created!.id);
  const invalid = await fetch(`${base}/api/v1/review-links/exchange`, {
    method: "POST", headers: { Origin: "https://study.example", "Content-Type": "application/json" },
    body: JSON.stringify({ suggestion_id: created!.id, token: "A".repeat(43) }),
  });
  expect(invalid.status).toBe(401);
  const wrongOrigin = await fetch(`${base}/api/v1/review-links/exchange`, {
    method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ suggestion_id: created!.id, token: new URLSearchParams(url.hash.slice(1)).get("token") }),
  });
  expect(wrongOrigin.status).toBe(403);
});