import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Decision = "accept" | "decline";
export type ReviewResult = {
  id: string;
  decision: Decision;
  status: "confirmed" | "accepted_booking_pending" | "declined" | "rejected";
  calendar_status: "confirmed" | "not_confirmed" | "unchanged";
  message: string;
};
type StoredSuggestion = {
  id: string;
  conversation: string;
  title: string;
  start: string;
  end: string;
  timezone: string;
  available_until: string;
  reason: string;
  expires_at: number;
  token_hash: string;
  token_used: boolean;
  access_token_hash?: string;
  access_expires_at?: number;
  result?: ReviewResult;
  idempotency_key?: string;
};
type SuggestionInput = { title: string; start: number; end: number; availableUntil: number; reason: string };
export type ReviewExecutor = (conversation: string, suggestionId: string, decision: Decision) => Promise<ReviewResult>;

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function matches(value: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const actual = Buffer.from(digest(value), "hex"), target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export class SuggestionReviewApi {
  private server: Server | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private frontendOrigin: string | null;

  constructor(
    private execute: ReviewExecutor,
    frontendUrl = process.env.FRAMER_REVIEW_URL,
    private directory = fileURLToPath(new URL("../data/review-links/", import.meta.url)),
    private now: () => number = Date.now,
  ) {
    this.frontendOrigin = frontendUrl ? new URL(frontendUrl).origin : null;
  }

  async createSuggestion(conversation: string, input: SuggestionInput, expiresAt: number): Promise<{ id: string; url: string } | null> {
    if (!this.frontendOrigin) return null;
    if (!conversation || !Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end <= input.start
        || !Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error("Invalid review suggestion");
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const record: StoredSuggestion = {
      id, conversation, title: input.title.slice(0, 160),
      start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString(),
      timezone: "America/Los_Angeles", available_until: new Date(input.availableUntil).toISOString(),
      reason: input.reason.slice(0, 500), expires_at: expiresAt, token_hash: digest(token), token_used: false,
    };
    await this.save(record);
    const url = new URL("/review", this.frontendOrigin);
    url.searchParams.set("suggestion_id", id);
    url.hash = new URLSearchParams({ token }).toString();
    return { id, url: url.toString() };
  }

  async listen(port = Number(process.env.REVIEW_API_PORT ?? 8787), host = process.env.REVIEW_API_HOST ?? "127.0.0.1"): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => { this.server!.off("error", reject); resolve(); });
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  address(): { port: number; address: string } | null {
    const address = this.server?.address();
    return address && typeof address !== "string" ? { port: address.port, address: address.address } : null;
  }

  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const before = this.locks.get(id) ?? Promise.resolve();
    const current = before.catch(() => {}).then(action);
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }

  private path(id: string): string { return join(this.directory, `${id}.json`); }
  private async load(id: string): Promise<StoredSuggestion> {
    try { return JSON.parse(await readFile(this.path(id), "utf8")) as StoredSuggestion; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(404, "not_found", "Suggestion not found.");
      throw error;
    }
  }
  private async save(record: StoredSuggestion): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(record.id), temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  }

  private cors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin && origin !== this.frontendOrigin) throw new ApiError(403, "origin_not_allowed", "This website is not allowed to access review links.");
    if (origin && origin === this.frontendOrigin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Cache-Control", "no-store");
  }

  private send(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    let text = "";
    for await (const chunk of request) {
      text += chunk.toString();
      if (text.length > 8192) throw new ApiError(413, "body_too_large", "Request body is too large.");
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new ApiError(400, "invalid_json", "Expected a JSON request body."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_body", "Expected a JSON object.");
    return value as Record<string, unknown>;
  }

  private bearer(request: IncomingMessage): string {
    const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/);
    if (!match) throw new ApiError(401, "unauthorized", "A valid review access token is required.");
    return match[1]!;
  }

  private async authorize(record: StoredSuggestion, request: IncomingMessage): Promise<void> {
    if (!matches(this.bearer(request), record.access_token_hash) || this.now() >= (record.access_expires_at ?? 0)) {
      throw new ApiError(401, "unauthorized", "The review access token is invalid or expired.");
    }
  }

  private publicSuggestion(record: StoredSuggestion) {
    return { id: record.id, status: record.result?.status ?? (this.now() >= record.expires_at ? "expired" : "pending"),
      title: record.title, start: record.start, end: record.end, timezone: record.timezone,
      available_until: record.available_until, reason: record.reason, expires_at: new Date(record.expires_at).toISOString(),
      ...(record.result ? { result: record.result } : {}) };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.cors(request, response);
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST" && url.pathname === "/api/v1/review-links/exchange") {
        const body = await this.body(request), id = body.suggestion_id, token = body.token;
        if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
          throw new ApiError(400, "invalid_exchange", "A suggestion ID and one-time token are required.");
        }
        const result = await this.locked(id, async () => {
          const record = await this.load(id);
          if (record.token_used || record.result || this.now() >= record.expires_at) throw new ApiError(410, "link_expired", "This review link has expired or was already used.");
          if (!matches(token, record.token_hash)) throw new ApiError(401, "invalid_token", "The review link is invalid.");
          const accessToken = randomBytes(32).toString("base64url");
          record.token_used = true;
          record.access_token_hash = digest(accessToken);
          record.access_expires_at = Math.min(this.now() + 10 * 60_000, record.expires_at);
          await this.save(record);
          return { access_token: accessToken, token_type: "Bearer", expires_in: Math.max(0, Math.floor((record.access_expires_at - this.now()) / 1000)) };
        });
        this.send(response, 200, result); return;
      }
      const match = url.pathname.match(/^\/api\/v1\/suggestions\/([0-9a-f-]{36})(\/decision)?$/i);
      if (!match) throw new ApiError(404, "not_found", "API route not found.");
      const id = match[1]!, isDecision = Boolean(match[2]);
      const result = await this.locked(id, async () => {
        const record = await this.load(id);
        await this.authorize(record, request);
        if (!isDecision && request.method === "GET") {
          if (!record.result && this.now() >= record.expires_at) throw new ApiError(410, "suggestion_expired", "This suggestion has expired.");
          return { status: 200, body: this.publicSuggestion(record) };
        }
        if (!isDecision || request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Use GET for a suggestion or POST to decide.");
        const body = await this.body(request), decision = body.decision, idempotencyKey = body.idempotency_key;
        if ((decision !== "accept" && decision !== "decline") || typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
          throw new ApiError(400, "invalid_decision", "Provide decision accept/decline and an idempotency_key.");
        }
        if (record.result) {
          if (record.idempotency_key === idempotencyKey && record.result.decision === decision) return { status: 200, body: record.result };
          throw new ApiError(409, "already_decided", "This suggestion already has a decision.");
        }
        if (this.now() >= record.expires_at) throw new ApiError(410, "suggestion_expired", "This suggestion has expired.");
        const outcome = await this.execute(record.conversation, id, decision);
        record.result = outcome;
        record.idempotency_key = idempotencyKey;
        await this.save(record);
        return { status: 200, body: outcome };
      });
      this.send(response, result.status, result.body); return;
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(500, "internal_error", "The review request could not be completed.");
      this.send(response, failure.status, { error: failure.code, message: failure.message });
    }
  }
}