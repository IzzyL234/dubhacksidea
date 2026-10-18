import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Source = "surroundings" | "phone" | "other";
type Draft = { id: string; step: "productivity" | "mood" | "distraction" | "source";
  productivity?: number; mood?: number; distraction?: number };
type State = { draft?: Draft; replies: { messageId: string; reply: string }[] };
export type SessionFeedback = {
  id: string;
  conversation_key: string;
  reported_at: string;
  session_id: null;
  productivity_rating: number;
  mood_rating: number;
  distraction_rating: number;
  distraction_source: Source | null;
  is_synthetic: false;
};

export const FEEDBACK_START = /^(?:rate(?: (?:my |study )?session)?|finished studying)[.!?]*$/i;

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
  constructor(private directory = fileURLToPath(new URL("../data/feedback/", import.meta.url))) {}

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
      state.draft = { id: randomUUID(), step: "productivity" };
      reply = "Quick check-in for your last study session. How productive were you? Reply 1–5 (1 = not productive, 5 = very productive). You can text cancel anytime.";
    } else if (FEEDBACK_START.test(command)) {
      reply = this.prompt(state.draft.step);
    } else if (state.draft.step === "source") {
      const choices: Record<string, Source> = { surroundings: "surroundings", environment: "surroundings", "1": "surroundings",
        phone: "phone", notifications: "phone", "2": "phone", other: "other", "something else": "other", "3": "other" };
      const source = choices[command];
      if (!source && command !== "skip") reply = "Reply surroundings, phone, something else, or skip.";
      else {
        await this.save(recordDirectory, key, state.draft, source ?? null);
        delete state.draft;
        reply = "Saved locally. Thanks! Your distraction report adds context; it doesn't prove what caused the session's result.";
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
          await this.save(recordDirectory, key, state.draft, null);
          delete state.draft;
          reply = "Saved locally: productivity, mood, and distraction. Thanks!";
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

  private async save(directory: string, key: string, draft: Draft, source: Source | null) {
    if (draft.productivity === undefined || draft.mood === undefined || draft.distraction === undefined) throw new Error("Incomplete check-in");
    const record: SessionFeedback = { id: draft.id, conversation_key: key, reported_at: new Date().toISOString(),
      session_id: null, productivity_rating: draft.productivity, mood_rating: draft.mood,
      distraction_rating: draft.distraction, distraction_source: source, is_synthetic: false };
    // No workspace or session timestamp is guessed. Link to a confirmed study session in a later integration.
    await atomicJson(join(directory, `${draft.id}.json`), record);
  }
}
