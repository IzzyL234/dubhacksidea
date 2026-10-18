import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CalendarGateway, DemoEvent, EventInput } from "./calendar-types.ts";
import { generateText } from "./text-model.ts";
import { TIMEZONE } from "./time.ts";

export type ProposalEventType = "class" | "study_block" | "routine" | "personal";
export type ProposalOperationType =
  | "CREATE_EVENT"
  | "UPDATE_EVENT"
  | "SPLIT_OR_RESCHEDULE_BLOCK"
  | "DELETE_EVENT"
  | "UPDATE_DEADLINE";

export interface RemainingChunkSpec {
  start_time: string;
  end_time: string;
  location: string;
}

export interface CalendarProposalToolItem {
  operation_type: ProposalOperationType;
  reasoning: string;
  // CREATE_EVENT
  title?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  event_type?: ProposalEventType | null;
  location?: string | null;
  recurring_days?: string[] | null;
  // UPDATE_EVENT / DELETE_EVENT
  target_event_id?: string | null;
  new_title?: string | null;
  new_start_time?: string | null;
  new_end_time?: string | null;
  new_location?: string | null;
  // SPLIT_OR_RESCHEDULE_BLOCK
  target_block_id?: string | null;
  completed_mins?: number | null;
  remaining_chunks?: RemainingChunkSpec[] | null;
  // UPDATE_DEADLINE
  assignment_id_or_title?: string | null;
  new_due_date?: string | null;
  auto_rebalance_blocks?: boolean | null;
}

export interface CalendarProposalBatch {
  summary_message: string;
  operations: CalendarProposalToolItem[];
}

export interface ProposedOperationDiff {
  operation_id?: string;
  proposal_id?: string;
  operation_type?: ProposalOperationType;
  op_type?: ProposalOperationType;
  reasoning: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  predicted_reward?: number | null;
  uncertainty_bound?: number | null;
  has_conflict: boolean;
  conflict_with: string | null;
  exceeds_daily_cap: boolean;
  status: "pending" | "approved" | "rejected" | "modified";
}

export interface VeyzlAudit {
  conflict_free: boolean;
  burnout_safe: boolean;
  requires_human_approval: boolean;
}

export interface StagedChangeProposal {
  proposal_id: string;
  batch_id: string;
  created_at: string;
  source: "user_chat" | "proactive_agent" | "syllabus_photo";
  summary_message: string;
  operations: ProposedOperationDiff[];
  veyzl_audit: VeyzlAudit;
  status: "pending" | "approved" | "rejected" | "modified";
  approval_url?: string | null;
}

export const CALENDAR_PROPOSAL_BATCH_SCHEMA = {
  type: "object",
  properties: {
    summary_message: { type: "string" },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          operation_type: {
            type: "string",
            enum: [
              "CREATE_EVENT",
              "UPDATE_EVENT",
              "SPLIT_OR_RESCHEDULE_BLOCK",
              "DELETE_EVENT",
              "UPDATE_DEADLINE",
            ],
          },
          reasoning: { type: "string" },
          title: { type: ["string", "null"] },
          start_time: { type: ["string", "null"] },
          end_time: { type: ["string", "null"] },
          event_type: {
            type: ["string", "null"],
            enum: ["class", "study_block", "routine", "personal", null],
          },
          location: { type: ["string", "null"] },
          recurring_days: {
            type: ["array", "null"],
            items: { type: "string" },
          },
          target_event_id: { type: ["string", "null"] },
          new_title: { type: ["string", "null"] },
          new_start_time: { type: ["string", "null"] },
          new_end_time: { type: ["string", "null"] },
          new_location: { type: ["string", "null"] },
          target_block_id: { type: ["string", "null"] },
          completed_mins: { type: ["integer", "null"] },
          remaining_chunks: {
            type: ["array", "null"],
            items: {
              type: "object",
              properties: {
                start_time: { type: "string" },
                end_time: { type: "string" },
                location: { type: "string" },
              },
              required: ["start_time", "end_time", "location"],
              additionalProperties: false,
            },
          },
          assignment_id_or_title: { type: ["string", "null"] },
          new_due_date: { type: ["string", "null"] },
          auto_rebalance_blocks: { type: ["boolean", "null"] },
        },
        required: [
          "operation_type",
          "reasoning",
          "title",
          "start_time",
          "end_time",
          "event_type",
          "location",
          "recurring_days",
          "target_event_id",
          "new_title",
          "new_start_time",
          "new_end_time",
          "new_location",
          "target_block_id",
          "completed_mins",
          "remaining_chunks",
          "assignment_id_or_title",
          "new_due_date",
          "auto_rebalance_blocks",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["summary_message", "operations"],
  additionalProperties: false,
};

const PLANNER_PROPOSAL_TRIGGER =
  /\b(schedule|plan|move|push|shift|reschedule|split|break up|divide|delete|remove|cancel|drop|deadline|due date|extension|block|lecture|class|study session|paper|project|exam|homework|assignment)\b/i;

const APPROVAL_TRIGGER =
  /^(?:yes|yep|yeah|y|approve|approved|lock it in|lock this in|looks good|confirm|do it)(?:\s+batch_[a-z0-9]+)?[.!]*$/i;

const REJECTION_TRIGGER =
  /^(?:no|nope|nah|reject|discard|cancel proposal|don't do that)(?:\s+batch_[a-z0-9]+)?[.!]*$/i;

const PENDING_LIST_TRIGGER =
  /^(?:pending proposals|staged proposals|show diff|calendar diff|pending changes)[?.!]*$/i;

export function isAgenticProposalIntent(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (/^(?:calendar|calendar events|calendar help|add event|move event|rename event|open time|free time|start studying|done|finished studying|rate session|where am i|smart prompts|reminders|quiet hours)/i.test(cleaned)) {
    return false;
  }
  return PLANNER_PROPOSAL_TRIGGER.test(cleaned);
}

export function isProposalApproval(text: string): boolean {
  return APPROVAL_TRIGGER.test(text.trim());
}

export function isProposalRejection(text: string): boolean {
  return REJECTION_TRIGGER.test(text.trim());
}

export function isPendingProposalsQuery(text: string): boolean {
  return PENDING_LIST_TRIGGER.test(text.trim());
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return Math.max(startA, startB) < Math.min(endA, endB);
}

/**
 * Lightweight deterministic validator that attaches `has_conflict`, `conflict_with`,
 * and `exceeds_daily_cap` metadata flags without blocking the LLM from proposing.
 */
export function validateAndStageBatch(
  batch: CalendarProposalBatch,
  existingEvents: DemoEvent[],
  source: "user_chat" | "proactive_agent" | "syllabus_photo" = "user_chat",
  linucbContext?: { hourlyScores?: Record<number, { reward: number; uncertainty: number; location: string }> }
): StagedChangeProposal {
  const batchId = `batch_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const proposalId = `prop_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const createdAt = new Date().toISOString();

  const dailyStudyMins = new Map<string, number>();
  const intervals: { id: string; title: string; start: number; end: number }[] = [];

  for (const ev of existingEvents) {
    const startIso = ev.start?.dateTime ?? ev.start?.date;
    const endIso = ev.end?.dateTime ?? ev.end?.date;
    if (!startIso || !endIso) continue;
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      intervals.push({
        id: ev.id ?? "existing",
        title: ev.summary ?? "Event",
        start: startMs,
        end: endMs,
      });
    }
  }

  let anyConflict = false;
  let anyBurnout = false;
  const diffs: ProposedOperationDiff[] = [];

  for (const op of batch.operations) {
    const opId = `op_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    let beforeState: Record<string, unknown> | null = null;
    let afterState: Record<string, unknown> | null = null;
    let hasConflict = false;
    let conflictWith: string | null = null;
    let exceedsDailyCap = false;
    let predictedReward: number | null = null;
    let uncertaintyBound: number | null = null;

    if (op.operation_type === "CREATE_EVENT" && op.start_time && op.end_time) {
      const startMs = Date.parse(op.start_time);
      const endMs = Date.parse(op.end_time);
      const hour = Number.isFinite(startMs) ? new Date(startMs).getHours() : 11;
      const score = linucbContext?.hourlyScores?.[hour];
      const loc = op.location ?? score?.location ?? "library";
      predictedReward = score?.reward ?? 3.8;
      uncertaintyBound = score?.uncertainty ?? 0.45;

      if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
        for (const iv of intervals) {
          if (overlaps(startMs, endMs, iv.start, iv.end)) {
            hasConflict = true;
            conflictWith = `${iv.title} (${iv.id})`;
            break;
          }
        }
        const dayKey = new Date(startMs).toISOString().slice(0, 10);
        const durMins = Math.max(0, Math.round((endMs - startMs) / 60_000));
        if ((op.event_type ?? "study_block") === "study_block") {
          const nextTotal = (dailyStudyMins.get(dayKey) ?? 0) + durMins;
          dailyStudyMins.set(dayKey, nextTotal);
          if (nextTotal > 240) exceedsDailyCap = true;
        }
        intervals.push({
          id: opId,
          title: op.title ?? "New Event",
          start: startMs,
          end: endMs,
        });
      }

      afterState = {
        id: `staged_${opId}`,
        title: op.title ?? "Proposed Event",
        start_time: op.start_time,
        end_time: op.end_time,
        event_type: op.event_type ?? "study_block",
        location: loc,
        recurring_days: op.recurring_days ?? [],
        predicted_reward: predictedReward,
        uncertainty_bound: uncertaintyBound,
      };
    } else if (op.operation_type === "UPDATE_EVENT") {
      const target = existingEvents.find(
        e => e.id === op.target_event_id || (op.target_event_id && e.summary?.toLowerCase().includes(op.target_event_id.toLowerCase()))
      );
      if (target) {
        beforeState = {
          id: target.id,
          title: target.summary ?? "Untitled",
          start_time: target.start?.dateTime ?? target.start?.date ?? null,
          end_time: target.end?.dateTime ?? target.end?.date ?? null,
        };
      }
      const nextStart = op.new_start_time ?? (beforeState?.start_time as string | null) ?? null;
      const nextEnd = op.new_end_time ?? (beforeState?.end_time as string | null) ?? null;
      if (nextStart && nextEnd) {
        const startMs = Date.parse(nextStart);
        const endMs = Date.parse(nextEnd);
        for (const iv of intervals) {
          if (iv.id !== target?.id && overlaps(startMs, endMs, iv.start, iv.end)) {
            hasConflict = true;
            conflictWith = `${iv.title} (${iv.id})`;
            break;
          }
        }
      }
      afterState = {
        ...(beforeState ?? { id: op.target_event_id ?? `staged_${opId}` }),
        title: op.new_title ?? (beforeState?.title as string) ?? "Updated Event",
        start_time: nextStart,
        end_time: nextEnd,
        location: op.new_location ?? "library",
      };
    } else if (op.operation_type === "SPLIT_OR_RESCHEDULE_BLOCK") {
      const target = existingEvents.find(e => e.id === op.target_block_id);
      if (target) {
        beforeState = {
          id: target.id,
          title: target.summary ?? "Study Block",
          start_time: target.start?.dateTime ?? null,
          end_time: target.end?.dateTime ?? null,
        };
      }
      const chunks = (op.remaining_chunks ?? []).map((ch, idx) => {
        const startMs = Date.parse(ch.start_time);
        const endMs = Date.parse(ch.end_time);
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          for (const iv of intervals) {
            if (iv.id !== op.target_block_id && overlaps(startMs, endMs, iv.start, iv.end)) {
              hasConflict = true;
              conflictWith = `${iv.title} (${iv.id})`;
              break;
            }
          }
        }
        return {
          id: `staged_${opId}_chunk_${idx + 1}`,
          title: `${(beforeState?.title as string) ?? "Study Session"} (Part ${idx + 1})`,
          start_time: ch.start_time,
          end_time: ch.end_time,
          location: ch.location,
        };
      });
      afterState = {
        target_block_id: op.target_block_id,
        completed_mins: op.completed_mins ?? 0,
        chunks,
      };
    } else if (op.operation_type === "DELETE_EVENT") {
      const target = existingEvents.find(e => e.id === op.target_event_id);
      beforeState = target
        ? {
            id: target.id,
            title: target.summary ?? "Event",
            start_time: target.start?.dateTime ?? null,
            end_time: target.end?.dateTime ?? null,
          }
        : { id: op.target_event_id };
      afterState = null;
    } else if (op.operation_type === "UPDATE_DEADLINE") {
      beforeState = { assignment_id_or_title: op.assignment_id_or_title };
      afterState = {
        assignment_id_or_title: op.assignment_id_or_title,
        new_due_date: op.new_due_date,
        auto_rebalance_blocks: op.auto_rebalance_blocks ?? true,
      };
    }

    if (hasConflict) anyConflict = true;
    if (exceedsDailyCap) anyBurnout = true;

    diffs.push({
      operation_id: opId,
      operation_type: op.operation_type,
      reasoning: op.reasoning,
      before_state: beforeState,
      after_state: afterState,
      predicted_reward: predictedReward,
      uncertainty_bound: uncertaintyBound,
      has_conflict: hasConflict,
      conflict_with: conflictWith,
      exceeds_daily_cap: exceedsDailyCap,
      status: "pending",
    });
  }

  const frontendBase = (process.env.FRONTEND_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`).replace(/\/+$/, "");

  return {
    proposal_id: proposalId,
    batch_id: batchId,
    created_at: createdAt,
    source,
    summary_message: batch.summary_message,
    operations: diffs,
    veyzl_audit: {
      conflict_free: !anyConflict,
      burnout_safe: !anyBurnout,
      requires_human_approval: true,
    },
    status: "pending",
    approval_url: `${frontendBase}/approve/${batchId}`,
  };
}

export class StagedProposalEngine {
  private backendUrl: string;
  private frontendUrl: string;
  private storagePath: string;

  constructor(
    private gateway: CalendarGateway,
    storagePath = fileURLToPath(new URL("../data/staged-proposals.json", import.meta.url)),
    backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:8000",
    frontendUrl = process.env.FRONTEND_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`
  ) {
    this.storagePath = storagePath;
    this.backendUrl = backendUrl;
    this.frontendUrl = frontendUrl.replace(/\/+$/, "");
  }

  private async loadLocal(): Promise<StagedChangeProposal[]> {
    try {
      const raw = await readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveLocal(proposals: StagedChangeProposal[]): Promise<void> {
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temp = `${this.storagePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(proposals, null, 2), { mode: 0o600 });
    await rename(temp, this.storagePath);
  }

  async getPendingProposals(): Promise<StagedChangeProposal[]> {
    try {
      const resp = await fetch(`${this.backendUrl}/api/calendar/proposals/pending`, {
        signal: AbortSignal.timeout(3500),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { proposals?: StagedChangeProposal[] };
        if (Array.isArray(data.proposals)) return data.proposals;
      }
    } catch {
      // Fallback to local staged proposals store
    }
    const local = await this.loadLocal();
    return local.filter(p => p.status === "pending");
  }

  async proposeFromText(
    text: string,
    source: "user_chat" | "proactive_agent" | "syllabus_photo" = "user_chat"
  ): Promise<{ replyText: string; proposal: StagedChangeProposal | null }> {
    // 1. Try syncing with the FastAPI backend's hybrid LinUCB + Rhythm + LLM Staged Proposal Engine first
    try {
      const resp = await fetch(`${this.backendUrl}/api/calendar/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, source }),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          reply_text?: string;
          summary_message?: string;
          approval_url?: string;
          proposal: StagedChangeProposal;
        };
        if (!data.proposal.approval_url) {
          data.proposal.approval_url = data.approval_url ?? `${this.frontendUrl}/approve/${data.proposal.batch_id}`;
        }
        const existing = await this.loadLocal();
        await this.saveLocal([...existing.filter(p => p.batch_id !== data.proposal.batch_id), data.proposal]);
        const replyText = this.formatProposalPreview(data.proposal);
        return { replyText, proposal: data.proposal };
      }
    } catch {
      // Fall through to local TS LLM proposal synthesis if FastAPI backend is offline
    }

    // 2. Standalone TypeScript LLM synthesis using CalendarProposalBatch JSON Schema
    let existingEvents: DemoEvent[] = [];
    try {
      existingEvents = await this.gateway.list(Date.now(), Date.now() + 7 * 86_400_000);
    } catch {
      existingEvents = [];
    }

    const prompt = `You are an Agentic Calendar Planner.
Current time: ${new Date().toISOString()} (${TIMEZONE}).
Existing calendar events (next 7 days): ${JSON.stringify(
      existingEvents.slice(0, 25).map(e => ({
        id: e.id,
        title: e.summary,
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
      }))
    )}
Generate a structured CalendarProposalBatch for the user's request. Use ISO-8601 timestamps.`;

    const rawJson = await generateText(
      prompt,
      [{ role: "user", parts: [{ text }] }],
      CALENDAR_PROPOSAL_BATCH_SCHEMA
    );
    const batch = JSON.parse(rawJson) as CalendarProposalBatch;
    if (!batch.operations?.length) {
      return { replyText: batch.summary_message || "No calendar changes needed.", proposal: null };
    }

    const staged = validateAndStageBatch(batch, existingEvents, source);
    const existing = await this.loadLocal();
    await this.saveLocal([...existing, staged]);

    const replyText = this.formatProposalPreview(staged);
    return { replyText, proposal: staged };
  }

  formatProposalPreview(proposal: StagedChangeProposal): string {
    const lines = proposal.operations.map((op, idx) => {
      const opType = op.operation_type ?? op.op_type ?? "CREATE_EVENT";
      const warn = op.has_conflict
        ? ` [CONFLICT with ${op.conflict_with}]`
        : op.exceeds_daily_cap
          ? " [Burnout cap warning]"
          : "";
      if (opType === "CREATE_EVENT" && op.after_state) {
        const rewardVal = op.predicted_reward ?? (typeof op.after_state.predicted_reward === "number" ? op.after_state.predicted_reward : null);
        const reward = rewardVal ? ` (${rewardVal.toFixed(1)}★)` : "";
        const loc = op.after_state.location ?? op.after_state.recommended_location ?? "desk";
        return `${idx + 1}. + CREATE "${op.after_state.title}" (${op.after_state.start_time} -> ${op.after_state.end_time}) @ ${loc}${reward}${warn}`;
      }
      if (opType === "UPDATE_EVENT" && op.after_state) {
        return `${idx + 1}. ~ MOVE/UPDATE "${op.after_state.title}" -> ${op.after_state.start_time}${warn}`;
      }
      if (opType === "SPLIT_OR_RESCHEDULE_BLOCK" && op.after_state) {
        const chunkList = Array.isArray(op.after_state.chunks)
          ? op.after_state.chunks
          : Array.isArray(op.after_state.proposed_chunks)
            ? op.after_state.proposed_chunks
            : [];
        return `${idx + 1}. % SPLIT block ${op.after_state.target_block_id} into ${chunkList.length} chunk(s)${warn}`;
      }
      if (opType === "DELETE_EVENT") {
        return `${idx + 1}. - DELETE "${op.before_state?.title ?? op.before_state?.id ?? "event"}"`;
      }
      if (opType === "UPDATE_DEADLINE" && op.after_state) {
        return `${idx + 1}. ! DEADLINE "${op.after_state.assignment_id_or_title ?? op.after_state.title}" -> ${op.after_state.new_due_date ?? op.after_state.due_date}`;
      }
      return `${idx + 1}. ${opType}: ${op.reasoning}`;
    });

    const approvalUrl = proposal.approval_url || `${this.frontendUrl}/approve/${proposal.batch_id}`;

    return (
      `${proposal.summary_message}\n\n` +
      `Staged Calendar Diff (${proposal.batch_id}):\n` +
      `${lines.join("\n")}\n\n` +
      `Review & approve all changes here:\n${approvalUrl}\n` +
      `(Or reply YES to lock this in, NO to discard.)`
    );
  }

  async approvePending(
    batchId?: string,
    proposalIds?: string[]
  ): Promise<{ replyText: string; approved: StagedChangeProposal | null }> {
    const pending = await this.getPendingProposals();
    const target = batchId
      ? pending.find(p => p.batch_id === batchId || p.proposal_id === batchId)
      : pending[pending.length - 1];

    if (!target) {
      return { replyText: "No pending calendar proposals to approve.", approved: null };
    }

    // 1. Approve in FastAPI backend if reachable
    let backendReply: string | null = null;
    try {
      const resp = await fetch(
        `${this.backendUrl}/api/calendar/proposals/${encodeURIComponent(target.batch_id)}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proposal_ids: proposalIds ?? null }),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (resp.ok) {
        const data = (await resp.json()) as {
          message?: string;
          proposal?: StagedChangeProposal;
        };
        backendReply = data.message ?? null;
      }
    } catch {
      // Continue with Google Calendar sync and local state update
    }

    // 2. Write approved operations to Google Calendar (`src/calendar-api.ts`) when credentials exist
    let gcalSynced = 0;
    for (const op of target.operations) {
      const opId = op.operation_id ?? op.proposal_id ?? "op";
      const opType = op.operation_type ?? op.op_type ?? "CREATE_EVENT";
      if (
        proposalIds?.length &&
        !proposalIds.includes(opId) &&
        !proposalIds.includes(target.proposal_id)
      ) {
        continue;
      }
      try {
        if (opType === "CREATE_EVENT" && op.after_state) {
          const startIso = String(op.after_state.start_time ?? "");
          const endIso = String(op.after_state.end_time ?? "");
          if (startIso && endIso) {
            const key = createHash("sha256")
              .update(`${target.batch_id}:${opId}`)
              .digest("hex");
            const eventInput: EventInput = {
              id: `staged${key.slice(0, 36)}`,
              summary: String(op.after_state.title ?? "Scheduled Block"),
              start: { dateTime: new Date(Date.parse(startIso)).toISOString(), timeZone: TIMEZONE },
              end: { dateTime: new Date(Date.parse(endIso)).toISOString(), timeZone: TIMEZONE },
              reminders: { useDefault: false },
              extendedProperties: { private: { studyAgentRequest: key } },
            };
            await this.gateway.create(eventInput);
            gcalSynced++;
          }
        }
      } catch {
        // Google Calendar write token is optional in offline/test environments
      }
      op.status = "approved";
    }

    target.status = "approved";
    const allLocal = await this.loadLocal();
    await this.saveLocal(
      allLocal.map(p => (p.batch_id === target.batch_id ? target : p))
    );

    const gcalNote = gcalSynced > 0 ? ` (${gcalSynced} synced to Google Calendar)` : "";
    return {
      replyText:
        backendReply
          ? `${backendReply}${gcalNote}`
          : `Locked in! Approved batch ${target.batch_id} (${target.operations.length} change(s) applied${gcalNote}).`,
      approved: target,
    };
  }

  async rejectPending(
    batchId?: string,
    feedback?: string
  ): Promise<{ replyText: string; rejected: StagedChangeProposal | null }> {
    const pending = await this.getPendingProposals();
    const target = batchId
      ? pending.find(p => p.batch_id === batchId || p.proposal_id === batchId)
      : pending[pending.length - 1];

    if (!target) {
      return { replyText: "No pending calendar proposals to discard.", rejected: null };
    }

    let backendReply: string | null = null;
    try {
      const resp = await fetch(
        `${this.backendUrl}/api/calendar/proposals/${encodeURIComponent(target.batch_id)}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feedback: feedback ?? "User rejected via text" }),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (resp.ok) {
        const data = (await resp.json()) as { follow_up_question?: string };
        backendReply = data.follow_up_question ?? null;
      }
    } catch {
      // Fallback to local state update
    }

    target.status = "rejected";
    for (const op of target.operations) op.status = "rejected";
    const allLocal = await this.loadLocal();
    await this.saveLocal(
      allLocal.map(p => (p.batch_id === target.batch_id ? target : p))
    );

    return {
      replyText:
        backendReply ??
        `Discarded staged proposal ${target.batch_id}. How would you like to adjust the times or locations instead?`,
      rejected: target,
    };
  }
}
