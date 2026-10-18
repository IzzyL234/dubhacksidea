import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredFeedbackSink, type FeedbackSink } from "./feedback-cloud.ts";

type Source = "surroundings" | "phone" | "other";
type Draft = { id: string; step: "productivity" | "mood" | "distraction" | "source";
  productivity?: number; mood?: number; distraction?: number; sessionId?: string | null };
type State = { draft?: Draft; replies: { messageId: string; reply: string }[] };
export type SessionFeedback = {
  id: string;
  conversation_key: string;
  reported_at: string;
  session_id: string | null;
  productivity_rating: number;
  mood_rating: number;
  distraction_rating: number;
  distraction_source: Source | null;
  is_synthetic: false;
};

export const FEEDBACK_START = /^(?:rate(?: (?:my |study )?session)?|finished studying|done)[.!?]*$/i;

export type FeedbackHooks = {
  begin?: (conversationKey: string) => Promise<string | null>;
  afterSave?: (record: SessionFeedback) => Promise<void>;
  beforeUpload?: (record: SessionFeedback) => Promise<void>;
};

async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

// Single bot process. No model calls: the check-in is deterministic and survives restarts.
export class FeedbackFlow {
  private uploading = new Map<string, Promise<boolean>>();
  constructor(private directory = fileURLToPath(new URL("../data/feedback/", import.meta.url)),
    private sink: FeedbackSink | null = configuredFeedbackSink(), private hooks: FeedbackHooks = {}) {}

  async syncPending(): Promise<{ synced: number; pending: number }> {
    if (!this.sink) return { synced: 0, pending: 0 };
    let names: string[];
    try { names = (await readdir(join(this.directory, "records"))).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { synced: 0, pending: 0 };
      throw error;
    }
    let synced = 0, pending = 0;
    for (const name of names) {
      const record = JSON.parse(await readFile(join(this.directory, "records", name), "utf8")) as SessionFeedback;
      if (await this.isSynced(record.id)) continue;
      if (await this.upload(record)) synced++; else pending++;
    }
    return { synced, pending };
  }

  private async isSynced(id: string): Promise<boolean> {
    try { await readFile(join(this.directory, "synced", `${id}.json`)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  private async upload(record: SessionFeedback): Promise<boolean> {
    if (!this.sink) return false;
    const existing = this.uploading.get(record.id);
    if (existing) return existing;
    const operation = (async () => {
      try {
        if (await this.isSynced(record.id)) return true;
        await this.hooks.afterSave?.(record);
        await this.hooks.beforeUpload?.(record);
        await this.sink!.put(record);
        await mkdir(join(this.directory, "synced"), { recursive: true });
        await atomicJson(join(this.directory, "synced", `${record.id}.json`), { synced_at: new Date().toISOString() });
        return true;
      } catch {
        console.warn("Feedback cloud save deferred. Local copy kept for retry.");
        return false;
      }
    })();
    this.uploading.set(record.id, operation);
    try { return await operation; } finally { this.uploading.delete(record.id); }
  }

  private savedReply(result: "cloud" | "queued" | "local"): string {
    return result === "cloud" ? "Saved to Supabase. Thanks!"
      : result === "queued" ? "Saved locally. I'll retry the cloud sync when the connection is available. Thanks!"
      : "Saved locally: productivity, mood, and distraction. Thanks!";
  }

  async handle(conversation: string, text: string, messageId: string): Promise<string | null> {
    const key = createHash("sha256").update(conversation).digest("hex");
    const stateDirectory = join(this.directory, "state");
    const recordDirectory = join(this.directory, "records");
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(recordDirectory, { recursive: true });
    const statePath = join(stateDirectory, `${key}.json`);
    let state: State;
    try { state = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { replies: [] };
    }
    const old = state.replies.find(r => r.messageId === messageId);
    if (old) return old.reply;
    const command = text.trim().toLowerCase();

    if (command === "reset") {
      delete state.draft;
      await atomicJson(statePath, state);
      return null; // Let the existing bot reset its conversation, too.
    }
    if (!state.draft && !FEEDBACK_START.test(command)) return null;

    let reply: string;
    if (command === "cancel") {
      delete state.draft;
      reply = "Check-in canceled. Nothing was saved as session feedback.";
    } else if (!state.draft) {
      const sessionId = await this.hooks.begin?.(key) ?? null;
      if (command === "done" && !sessionId) return "No unfinished study session. Text start studying first, or rate session for a standalone check-in.";
      state.draft = { id: randomUUID(), step: "productivity", sessionId };
      reply = "Quick check-in for your last study session. How productive were you? Reply 1–5 (1 = not productive, 5 = very productive). You can text cancel anytime.";
    } else if (FEEDBACK_START.test(command)) {
      reply = this.prompt(state.draft.step);
    } else if (state.draft.step === "source") {
      const choices: Record<string, Source> = { surroundings: "surroundings", environment: "surroundings", "1": "surroundings",
        phone: "phone", notifications: "phone", "2": "phone", other: "other", "something else": "other", "3": "other" };
      const source = choices[command];
      if (!source && command !== "skip") reply = "Reply surroundings, phone, something else, or skip.";
      else {
        const saved = await this.save(recordDirectory, key, state.draft, source ?? null);
        delete state.draft;
        reply = this.savedReply(saved);
      }
    } else if (!/^[1-5]$/.test(command)) {
      reply = `Please reply with a whole number from 1 to 5. ${this.prompt(state.draft.step)}`;
    } else {
      const rating = Number(command);
      if (state.draft.step === "productivity") {
        state.draft.productivity = rating;
        state.draft.step = "mood";
        reply = this.prompt("mood");
      } else if (state.draft.step === "mood") {
        state.draft.mood = rating;
        state.draft.step = "distraction";
        reply = this.prompt("distraction");
      } else {
        state.draft.distraction = rating;
        if (rating >= 4) {
          state.draft.step = "source";
          reply = this.prompt("source");
        } else {
          const saved = await this.save(recordDirectory, key, state.draft, null);
          delete state.draft;
          reply = this.savedReply(saved);
        }
      }
    }

    state.replies = [...state.replies, { messageId, reply }].slice(-40);
    await atomicJson(statePath, state);
    return reply;
  }

  private prompt(step: Draft["step"]): string {
    return { productivity: "How productive were you? 1–5 (5 = very productive).",
      mood: "How was your mood? 1–5 (1 = very low, 5 = very good).",
      distraction: "How distracted were you? 1–5 (1 = not distracted, 5 = very distracted).",
      source: "Mostly your surroundings, your phone, or something else? You can also reply skip." }[step];
  }

  private async save(directory: string, key: string, draft: Draft, source: Source | null): Promise<"cloud" | "queued" | "local"> {
    if (draft.productivity === undefined || draft.mood === undefined || draft.distraction === undefined) throw new Error("Incomplete check-in");
    const record: SessionFeedback = { id: draft.id, conversation_key: key, reported_at: new Date().toISOString(),
      session_id: draft.sessionId ?? null, productivity_rating: draft.productivity, mood_rating: draft.mood,
      distraction_rating: draft.distraction, distraction_source: source, is_synthetic: false };
    // The session ID was captured at check-in start, not guessed from the latest session.
    const path = join(directory, `${draft.id}.json`);
    let durable = record;
    try { durable = JSON.parse(await readFile(path, "utf8")) as SessionFeedback; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicJson(path, record);
    }
    await this.hooks.afterSave?.(durable);
    if (!this.sink) return "local";
    return await this.upload(durable) ? "cloud" : "queued";
  }
}
