import type { SessionFeedback } from "./feedback.ts";

export interface FeedbackSink {
  put(record: SessionFeedback): Promise<void>;
}

export class SupabaseFeedback implements FeedbackSink {
  private base: string;
  constructor(url: string, private secret: string, private request: typeof fetch = fetch) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co") || parsed.username || parsed.password) {
      throw new Error("Use your Supabase project HTTPS URL");
    }
    if (!secret.startsWith("sb_secret_")) throw new Error("Use your Supabase backend Secret key");
    this.base = parsed.origin;
  }

  async put(record: SessionFeedback): Promise<void> {
    // Explicit fields only. A retry of the same immutable check-in must not create another row.
    const body = { id: record.id, conversation_key: record.conversation_key,
      reported_at: record.reported_at, session_id: record.session_id,
      productivity_rating: record.productivity_rating, mood_rating: record.mood_rating,
      distraction_rating: record.distraction_rating, distraction_source: record.distraction_source,
      ...(record.distraction_attribution === undefined ? {} : {distraction_attribution: record.distraction_attribution}),
      is_synthetic: record.is_synthetic };
    const response = await this.request(`${this.base}/rest/v1/study_feedback?on_conflict=id`, {
      method: "POST", headers: { apikey: this.secret, "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Supabase feedback write failed (HTTP ${response.status})`);
  }

  async check(): Promise<number | null> {
    const response = await this.request(`${this.base}/rest/v1/study_feedback?select=id&limit=1`, {
      headers: { apikey: this.secret, Prefer: "count=exact" }, redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      if (response.status === 404) throw new Error("Create study_feedback by running supabase/002_study_feedback.sql in the Supabase SQL Editor");
      throw new Error(`Supabase feedback read failed (HTTP ${response.status})`);
    }
    const count = response.headers.get("content-range")?.split("/")[1];
    return count && /^\d+$/.test(count) ? Number(count) : null;
  }
}

export function configuredFeedbackSink(): SupabaseFeedback | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  return url && key ? new SupabaseFeedback(url, key) : null;
}
