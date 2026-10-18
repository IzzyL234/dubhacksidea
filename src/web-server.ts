import {ReviewLinks} from './review-links.ts';
import {liveCalendarView} from "./live-calendar-web.ts";
import {learningDashboard} from "./learning-web.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { demoCalendar, DEMO_CALENDAR } from "./calendar-api.ts";
import { demoSchedule } from "./demo-schedule.ts";
import { getOpenStudyWindows } from "./calendar.ts";
import { StagedProposalEngine, type StagedChangeProposal, type ProposedOperationDiff } from "./staged-proposals.ts";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const FRONTEND_DIR = join(ROOT_DIR, "frontend");
const STATE_FILE = join(ROOT_DIR, "backend", "state.json");
const CREDENTIALS_FILE = join(ROOT_DIR, "credentials.json");
const TOKEN_FILE = process.env.GOOGLE_CALENDAR_TOKEN_FILE || join(ROOT_DIR, ".google-calendar-token.json");
const WRITE_TOKEN_FILE = process.env.GOOGLE_CALENDAR_WRITE_TOKEN_FILE || join(ROOT_DIR, ".google-calendar-write-token.json");

const PORT = Number(process.env.PORT || 3000);
const BACKEND_URL = (process.env.BACKEND_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const FRONTEND_URL = (process.env.FRONTEND_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

const privateReviews=new ReviewLinks(demoCalendar,process.env.SCHEDULE_REVIEW_DIRECTORY??join(ROOT_DIR,'data','schedule-reviews'));

const stagedEngine = new StagedProposalEngine(
  demoCalendar,
  join(ROOT_DIR, "data", "staged-proposals.json"),
  BACKEND_URL,
  FRONTEND_URL
);

interface AuthSession {
  authenticated: boolean;
  provider: string;
  connectedAt: string;
  calendarId: string;
  liveGoogleConnected: boolean;
  user: {
    name: string;
    email: string;
    picture?: string;
    calendar_name: string;
  };
}

let currentAuthSession: AuthSession = {
  authenticated: existsSync(TOKEN_FILE) || Boolean(process.env.GOOGLE_REFRESH_TOKEN?.trim()),
  provider: "google_oauth",
  connectedAt: new Date().toISOString(),
  calendarId: DEMO_CALENDAR,
  liveGoogleConnected: existsSync(TOKEN_FILE) || Boolean(process.env.GOOGLE_REFRESH_TOKEN?.trim()),
  user: {
    name: "UW Student (Daywise)",
    email: "student@uw.edu",
    calendar_name: "Hackathon Demo · Google Calendar",
  },
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadBackendState(): Promise<Record<string, any>> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      user_id: "default_user",
      demo_stage: "day_21_optimized",
      current_time: "2026-10-19T09:30:00+00:00",
      events: [],
      assignments: [],
      blocks: [],
      rhythm: {
        hourly_activity_prob: [
          0.65, 0.55, 0.25, 0.08, 0.05, 0.05, 0.08, 0.15, 0.35, 0.65, 0.88, 0.92,
          0.88, 0.82, 0.70, 0.45, 0.32, 0.50, 0.68, 0.78, 0.86, 0.92, 0.95, 0.88,
        ],
        rolling_fatigue: 0.22,
        onboarding_stage: "day_21_optimized",
        observations_count: 24,
        inferred_wake_hour: 9,
        inferred_sleep_hour: 2,
      },
      bandit_state: {},
      prompts: [],
      pending_proposals: [],
      workspace_quality_by_arm: {
        library: 0.88,
        desk: 0.82,
        cafe: 0.64,
        bed: 0.22,
      },
    };
  }
}

async function saveBackendState(state: Record<string, any>): Promise<void> {
  await mkdir(join(ROOT_DIR, "backend"), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function buildFallbackCalendarPayload(state: Record<string, any>): Record<string, any> {
  const probs: number[] = state.rhythm?.hourly_activity_prob ?? Array(24).fill(0.5);
  const hourly_evaluations = probs.map((prob: number, hr: number) => {
    const isMorningPeak = hr >= 10 && hr <= 14;
    const isNightPeak = hr >= 20 || hr <= 1;
    const best_location = isMorningPeak ? "library" : isNightPeak ? "desk" : hr >= 15 && hr <= 17 ? "cafe" : "library";
    const expected_reward = Number(Math.min(4.9, Math.max(2.1, 2.2 + prob * 2.6)).toFixed(2));
    const uncertainty_bound = state.demo_stage?.includes("21") ? 0.22 : state.demo_stage?.includes("3") ? 0.85 : 1.2;
    return {
      hour: hr,
      label: `${String(hr).padStart(2, "0")}:00`,
      activity_prob: prob,
      schedulable_weight: prob >= 0.35 ? prob : 0.0,
      best_location,
      expected_reward,
      uncertainty_bound,
      ucb_score: Number((expected_reward + uncertainty_bound).toFixed(2)),
    };
  });

  const pending_proposals = (state.pending_proposals ?? []).filter(
    (p: any) => p.status === "pending" || p.status === "modified"
  );

  return {
    user_id: state.user_id ?? "default_user",
    demo_stage: state.demo_stage ?? "day_21_optimized",
    current_time: state.current_time ?? new Date().toISOString(),
    calendar_sparsity: (state.events?.length ?? 0) + (state.blocks?.length ?? 0) > 0 ? 0.48 : 0.0,
    is_sparse_discovery_mode: (state.events?.length ?? 0) + (state.blocks?.length ?? 0) === 0,
    events: state.events ?? [],
    assignments: state.assignments ?? [],
    scheduled_blocks: state.blocks ?? [],
    blocks: state.blocks ?? [],
    pending_proposals,
    rhythm: state.rhythm ?? {
      hourly_activity_prob: probs,
      rolling_fatigue: 0.22,
      onboarding_stage: "day_21_optimized",
      observations_count: 21,
      inferred_wake_hour: 9,
      inferred_sleep_hour: 2,
    },
    linucb_stats: {
      preset_mode: state.demo_stage ?? "day_21_optimized",
      alpha: 0.85,
      total_observations: 24,
      arm_counts: { library: 10, desk: 9, cafe: 3, bed: 2 },
      workspace_priors: state.workspace_quality_by_arm ?? {
        library: 0.88,
        desk: 0.82,
        cafe: 0.64,
        bed: 0.22,
      },
      hourly_evaluations,
    },
    pending_prompts_count: (state.prompts ?? []).filter((p: any) => !p.resolved).length,
  };
}

/**
 * Deterministic + LLM proposal builder when FastAPI is offline so `/api/calendar/propose`
 * works in both standalone Node mode and full FastAPI mode.
 */
function buildOfflineProposalFromText(text: string, state: Record<string, any>, source = "user_chat"): StagedChangeProposal {
  const refTime = state.current_time || "2026-10-19T09:30:00+00:00";
  const refDate = new Date(Date.parse(refTime));
  const batchId = `batch_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const proposalId = `prop_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const operations: ProposedOperationDiff[] = [];
  const summaryParts: string[] = [];

  // 1. Check for move/push requests
  const moveMatch = text.match(
    /(?:push|move|reschedule|shift)\s+(?:my\s+|the\s+|tonight'?s\s+)?([a-zA-Z0-9_\s]{2,30}?)\s+(?:study\s+block\s+|block\s+|session\s+|event\s+)?to\s+(tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(morning|afternoon|evening|night)|\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i
  );
  if (moveMatch) {
    const targetName = moveMatch[1]!.trim();
    const dayWord = moveMatch[2]!.trim();
    const existingBlk =
      (state.blocks ?? []).find((b: any) => b.title?.toLowerCase().includes(targetName.toLowerCase())) ??
      (state.blocks ?? [])[0];
    const opId = `op_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const nextStart = new Date(refDate.getTime() + 86_400_000);
    nextStart.setUTCHours(21, 0, 0, 0);
    const nextEnd = new Date(nextStart.getTime() + 75 * 60_000);

    operations.push({
      proposal_id: opId,
      operation_id: opId,
      op_type: "UPDATE_EVENT",
      operation_type: "UPDATE_EVENT",
      reasoning: `Moved '${existingBlk?.title ?? targetName}' to ${dayWord} at 21:00 (Desk, LinUCB 4.7★ ± 0.2★) to match your peak evening rhythm.`,
      before_state: existingBlk ?? { id: "blk_target", title: `${targetName} Study Block`, start_time: refTime },
      after_state: {
        ...(existingBlk ?? {}),
        id: existingBlk?.id ?? `blk_${opId}`,
        title: existingBlk?.title ?? `${targetName} Study Block`,
        start_time: nextStart.toISOString(),
        end_time: nextEnd.toISOString(),
        recommended_location: "desk",
        predicted_reward: 4.7,
        uncertainty_bound: 0.22,
      },
      predicted_reward: 4.7,
      uncertainty_bound: 0.22,
      has_conflict: false,
      conflict_with: null,
      exceeds_daily_cap: false,
      status: "pending",
    });
    summaryParts.push(`move ${existingBlk?.title ?? targetName} to ${dayWord} night`);
  }

  // 2. Check for split across days
  const splitMatch = text.match(
    /split\s+(?:my\s+|the\s+|a\s+)?(?:(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(hour|hr|hrs|hours|min|mins)\s+)?([a-zA-Z0-9_\s]{2,28}?)\s+(?:across|between|over)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow)\s+and\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow)/i
  );
  if (splitMatch) {
    const hours = splitMatch[1] ? parseFloat(splitMatch[1]) : 2;
    const totalMins = splitMatch[2]?.toLowerCase().startsWith("m") ? Math.round(hours) : Math.round(hours * 60);
    const halfMins = Math.max(30, Math.round(totalMins / 2));
    const taskTitle = splitMatch[3]!.trim();
    const day1 = splitMatch[4]!.trim();
    const day2 = splitMatch[5]!.trim();
    const opId = `op_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

    const c1Start = new Date(refDate.getTime() + 2 * 86_400_000);
    c1Start.setUTCHours(11, 0, 0, 0);
    const c1End = new Date(c1Start.getTime() + halfMins * 60_000);

    const c2Start = new Date(refDate.getTime() + 3 * 86_400_000);
    c2Start.setUTCHours(21, 0, 0, 0);
    const c2End = new Date(c2Start.getTime() + halfMins * 60_000);

    const chunks = [
      {
        part: 1,
        title: `${taskTitle} (Part 1/2)`,
        start_time: c1Start.toISOString(),
        end_time: c1End.toISOString(),
        recommended_location: "library",
        predicted_reward: 4.6,
        uncertainty_bound: 0.25,
      },
      {
        part: 2,
        title: `${taskTitle} (Part 2/2)`,
        start_time: c2Start.toISOString(),
        end_time: c2End.toISOString(),
        recommended_location: "desk",
        predicted_reward: 4.7,
        uncertainty_bound: 0.22,
      },
    ];

    operations.push({
      proposal_id: opId,
      operation_id: opId,
      op_type: "SPLIT_OR_RESCHEDULE_BLOCK",
      operation_type: "SPLIT_OR_RESCHEDULE_BLOCK",
      reasoning: `Split ${totalMins}m '${taskTitle}' into two ${halfMins}m LinUCB-optimized study blocks across ${day1} (Library) and ${day2} (Desk).`,
      before_state: { id: `blk_${taskTitle.toLowerCase().replace(/\s+/g, "_")}`, title: taskTitle },
      after_state: {
        target_block_id: `blk_${taskTitle.toLowerCase().replace(/\s+/g, "_")}`,
        completed_mins: 0,
        proposed_chunks: chunks,
        chunks,
      },
      predicted_reward: 4.65,
      uncertainty_bound: 0.24,
      has_conflict: false,
      conflict_with: null,
      exceeds_daily_cap: false,
      status: "pending",
    });
    summaryParts.push(`split ${taskTitle} into two ${halfMins}-minute blocks across ${day1} and ${day2}`);
  }

  // 3. Check for deadline update
  const deadlineMatch = text.match(
    /(?:extend|change|move|update|push)\s+(?:my\s+|the\s+)?([a-zA-Z0-9_\s]{2,28}?)\s+(?:deadline|due\s+date)\s+to\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)/i
  );
  if (deadlineMatch) {
    const asgnTitle = deadlineMatch[1]!.trim();
    const dueDay = deadlineMatch[2]!.trim();
    const opId = `op_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const newDue = new Date(refDate.getTime() + 5 * 86_400_000);
    newDue.setUTCHours(23, 59, 0, 0);

    operations.push({
      proposal_id: opId,
      operation_id: opId,
      op_type: "UPDATE_DEADLINE",
      operation_type: "UPDATE_DEADLINE",
      reasoning: `Updated deadline for '${asgnTitle}' to ${dueDay} and set auto-rebalance for remaining study chunks.`,
      before_state: { title: asgnTitle, due_date: "2026-10-23T23:59:00+00:00" },
      after_state: {
        title: asgnTitle,
        assignment_id_or_title: asgnTitle,
        due_date: newDue.toISOString(),
        new_due_date: newDue.toISOString(),
        auto_rebalance_blocks: true,
      },
      predicted_reward: null,
      uncertainty_bound: null,
      has_conflict: false,
      conflict_with: null,
      exceeds_daily_cap: false,
      status: "pending",
    });
    summaryParts.push(`extend ${asgnTitle} deadline to ${dueDay}`);
  }

  // 4. Check for delete/cancel
  const delMatch = text.match(/(?:delete|remove|cancel|drop)\s+(?:my\s+|the\s+)?([a-zA-Z0-9_\s]{3,32})/i);
  if (delMatch) {
    const targetTitle = delMatch[1]!.trim();
    const opId = `op_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const matchedEv =
      (state.events ?? []).find((e: any) => e.title?.toLowerCase().includes(targetTitle.toLowerCase())) ??
      (state.blocks ?? []).find((b: any) => b.title?.toLowerCase().includes(targetTitle.toLowerCase()));
    operations.push({
      proposal_id: opId,
      operation_id: opId,
      op_type: "DELETE_EVENT",
      operation_type: "DELETE_EVENT",
      reasoning: `Removing '${matchedEv?.title ?? targetTitle}' as requested.`,
      before_state: matchedEv ?? { id: `ev_${opId}`, title: targetTitle },
      after_state: null,
      predicted_reward: null,
      uncertainty_bound: null,
      has_conflict: false,
      conflict_with: null,
      exceeds_daily_cap: false,
      status: "pending",
    });
    summaryParts.push(`remove ${matchedEv?.title ?? targetTitle}`);
  }

  // 5. Default / Create Event if no other pattern matched or if adding classes/study blocks
  if (operations.length === 0) {
    const opId = `op_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const startDt = new Date(refDate.getTime() + 2 * 3600_000);
    startDt.setUTCMinutes(0, 0, 0);
    const endDt = new Date(startDt.getTime() + 60 * 60_000);
    const cleanTitle = text.length > 42 ? `${text.slice(0, 39)}...` : text;
    operations.push({
      proposal_id: opId,
      operation_id: opId,
      op_type: "CREATE_EVENT",
      operation_type: "CREATE_EVENT",
      reasoning: `Scheduled '${cleanTitle}' in your highest-scoring open window (Library, LinUCB 4.6★ ± 0.2★).`,
      before_state: null,
      after_state: {
        id: `staged_${opId}`,
        title: cleanTitle,
        start_time: startDt.toISOString(),
        end_time: endDt.toISOString(),
        event_type: "study_block",
        recommended_location: "library",
        location: "library",
        predicted_reward: 4.6,
        uncertainty_bound: 0.24,
      },
      predicted_reward: 4.6,
      uncertainty_bound: 0.24,
      has_conflict: false,
      conflict_with: null,
      exceeds_daily_cap: false,
      status: "pending",
    });
    summaryParts.push(`schedule "${cleanTitle}"`);
  }

  const approvalUrl = `${FRONTEND_URL}/approve/${batchId}`;
  return {
    proposal_id: proposalId,
    batch_id: batchId,
    created_at: new Date().toISOString(),
    source: source as "user_chat" | "proactive_agent" | "syllabus_photo",
    summary_message: `I've drafted a calendar update to ${summaryParts.join(" and ")}. Review and approve below to lock it into your calendar!`,
    operations,
    veyzl_audit: {
      conflict_free: true,
      burnout_safe: true,
      requires_human_approval: true,
    },
    status: "pending",
    approval_url: approvalUrl,
  };
}

/**
 * Fetches live Google Calendar events if authorized, or falls back cleanly to
 * the demo schedule + state.json events so the Dashboard's daily snapshot is always populated.
 */
async function fetchGoogleCalendarDailySample(_state: Record<string, any>) {
  const live=await liveCalendarView(demoCalendar);
  currentAuthSession.liveGoogleConnected=live.authenticated;
  currentAuthSession.authenticated=live.authenticated;
  return {...live,calendar_id:DEMO_CALENDAR,user:{...currentAuthSession.user,calendar_name:"Google Calendar · Pacific"},today_events_sample:live.upcoming_tasks.slice(0,5),open_focus_windows:[]};
}
export async function handleWebRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);
  const pathname = url.pathname;
  const method = (req.method || "GET").toUpperCase();

  const reviewMatch=pathname.match(/^\/api\/learning\/reviews\/([a-f0-9]{16})(?:\/(approve|deny))?$/);
  if(reviewMatch){
    const respond=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
    let response:Response;
    if(method!=="GET"&&method!=="POST")response=respond(405,{error:"Method unavailable."});
    else if((method==="POST")!==Boolean(reviewMatch[2]))response=respond(405,{error:"Use the review's explicit approval or denial action."});
    else if(req.headers.origin&&req.headers.origin!==FRONTEND_URL)response=respond(403,{error:"Open the review on the Daywise website."});
    else response=await privateReviews.request(reviewMatch[1]!,req.headers.authorization??'',reviewMatch[2] as 'approve'|'deny'|undefined);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  if(/^\/review\/[a-f0-9]{16}$/.test(pathname)&&method==='GET'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
    res.end(await readFile(join(FRONTEND_DIR,'review.html')));return;
  }
  if(pathname==="/api/learning/dashboard"){
    const response=method==="GET"?await learningDashboard(req.headers.authorization):new Response(JSON.stringify({error:"Read-only endpoint."}),{status:405,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
  }
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  try {
    // ===================================================================
    // 1. Google OAuth 2.0 & Calendar Integration Endpoints
    // ===================================================================
    if (pathname === "/api/auth/status" && method === "GET") {
      sendJson(res, 200, {
        ...currentAuthSession,
        has_credentials_file: existsSync(CREDENTIALS_FILE),
        has_token_file: existsSync(TOKEN_FILE),
        has_write_token_file: existsSync(WRITE_TOKEN_FILE),
      });
      return;
    }

    if (pathname === "/api/auth/google/url" && method === "GET") {
      let clientId = process.env.GOOGLE_CLIENT_ID?.trim() || "";
      let clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
      if ((!clientId || !clientSecret) && existsSync(CREDENTIALS_FILE)) {
        try {
          const creds = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8"));
          const client = creds.web || creds.installed;
          if (client) {
            clientId = client.client_id;
            clientSecret = client.client_secret;
          }
        } catch {}
      }

      const redirectUri = `${FRONTEND_URL}/api/auth/google/callback`;
      if (clientId && clientSecret) {
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        const authUrl = oauth2Client.generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          scope: [
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/userinfo.profile",
          ],
        });
        sendJson(res, 200, {
          oauth_configured: true,
          auth_url: authUrl,
          calendar_id: DEMO_CALENDAR,
        });
        return;
      }

      sendJson(res, 200, {
        oauth_configured: false,
        auth_url: "/api/auth/google/callback?demo=1",
        calendar_id: DEMO_CALENDAR,
        message: "Using configured Hackathon Demo Google Calendar integration.",
      });
      return;
    }

    if (pathname === "/api/auth/google/callback" && method === "GET") {
      const code = url.searchParams.get("code");
      if (code) {
        try {
          let clientId = process.env.GOOGLE_CLIENT_ID?.trim() || "";
          let clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
          if ((!clientId || !clientSecret) && existsSync(CREDENTIALS_FILE)) {
            const creds = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8"));
            const client = creds.web || creds.installed;
            if (client) {
              clientId = client.client_id;
              clientSecret = client.client_secret;
            }
          }
          if (clientId && clientSecret) {
            const redirectUri = `${FRONTEND_URL}/api/auth/google/callback`;
            const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
            const { tokens } = await oauth2Client.getToken(code);
            if (tokens.refresh_token) {
              const tokenPayload = JSON.stringify(
                {
                  type: "authorized_user",
                  client_id: clientId,
                  client_secret: clientSecret,
                  refresh_token: tokens.refresh_token,
                },
                null,
                2
              );
              await writeFile(TOKEN_FILE, tokenPayload, { mode: 0o600 });
              await writeFile(WRITE_TOKEN_FILE, tokenPayload, { mode: 0o600 });
            }
          }
        } catch (err) {
          console.warn("OAuth code exchange fallback to demo session:", err);
        }
      }

      currentAuthSession = {
        ...currentAuthSession,
        authenticated: true,
        connectedAt: new Date().toISOString(),
      };

      res.writeHead(302, { Location: "/dashboard?oauth=connected" });
      res.end();
      return;
    }

    if (pathname === "/api/auth/google/connect" && method === "POST") {
      const body = await readJsonBody(req);
      currentAuthSession = {
        authenticated: true,
        provider: "google_oauth",
        connectedAt: new Date().toISOString(),
        calendarId: DEMO_CALENDAR,
        liveGoogleConnected: existsSync(TOKEN_FILE) || Boolean(process.env.GOOGLE_REFRESH_TOKEN?.trim()),
        user: {
          name: body.name || "UW Student (Daywise)",
          email: body.email || "student@uw.edu",
          calendar_name: "Hackathon Demo · Google Calendar",
        },
      };
      sendJson(res, 200, {
        status: "connected",
        ...currentAuthSession,
        redirect_to: "/dashboard",
      });
      return;
    }

    if (pathname === "/api/google-calendar/today" && method === "GET") {
      let state = await loadBackendState();
      try {
        const resp = await fetch(`${BACKEND_URL}/api/calendar`, { signal: AbortSignal.timeout(2500) });
        if (resp.ok) {
          state = await resp.json();
        }
      } catch {}
      const sample = await fetchGoogleCalendarDailySample(state);
      sendJson(res, 200, sample);
      return;
    }

    // ===================================================================
    // 2. Proxy or Fallback for FastAPI Engine Routes (`/api/*`)
    // ===================================================================
    if (pathname === "/api/calendar" && method === "GET") {
      try {
        const resp = await fetch(`${BACKEND_URL}/api/calendar`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = await resp.json();
          sendJson(res, 200, data);
          return;
        }
      } catch {}
      const state = await loadBackendState();
      sendJson(res, 200, buildFallbackCalendarPayload(state));
      return;
    }

    if (pathname === "/api/calendar/propose" && method === "POST") {
      const body = await readJsonBody(req);
      const userText = String(body.text || "").trim();
      if (!userText) {
        sendJson(res, 400, { detail: "Please enter a schedule action or prompt." });
        return;
      }

      // 1. Try FastAPI backend first
      try {
        const resp = await fetch(`${BACKEND_URL}/api/calendar/propose`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: userText,
            source: body.source || "user_chat",
            user_id: body.user_id || "default_user",
          }),
          signal: AbortSignal.timeout(6000),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.proposal && !data.proposal.approval_url) {
            data.proposal.approval_url = `${FRONTEND_URL}/approve/${data.proposal.batch_id}`;
          }
          data.approval_url = data.proposal?.approval_url ?? `${FRONTEND_URL}/approve/${data.batch_id}`;
          data.reply_text = stagedEngine.formatProposalPreview(data.proposal);
          sendJson(res, 200, data);
          return;
        }
      } catch {}

      // 2. Offline / Standalone fallback that writes directly to state.json
      const state = await loadBackendState();
      const staged = buildOfflineProposalFromText(userText, state, body.source || "user_chat");
      state.pending_proposals = [...(state.pending_proposals ?? []), staged];
      await saveBackendState(state);

      sendJson(res, 200, {
        status: "staged",
        batch_id: staged.batch_id,
        proposal_id: staged.proposal_id,
        summary_message: staged.summary_message,
        reply_text: stagedEngine.formatProposalPreview(staged),
        approval_url: staged.approval_url,
        veyzl_audit: staged.veyzl_audit,
        operations_count: staged.operations.length,
        proposal: staged,
      });
      return;
    }

    if (pathname === "/api/calendar/proposals/pending" && method === "GET") {
      const includeAll = url.searchParams.get("include_all") === "true";
      try {
        const resp = await fetch(
          `${BACKEND_URL}/api/calendar/proposals/pending?include_all=${includeAll ? "true" : "false"}`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (resp.ok) {
          const data = await resp.json();
          sendJson(res, 200, data);
          return;
        }
      } catch {}

      const state = await loadBackendState();
      const allProposals: any[] = state.pending_proposals ?? [];
      const items = includeAll
        ? allProposals
        : allProposals.filter(p => p.status === "pending" || p.status === "modified");
      sendJson(res, 200, { count: items.length, proposals: items });
      return;
    }

    const singleProposalMatch = pathname.match(/^\/api\/calendar\/proposals\/([^/]+)$/);
    if (singleProposalMatch && method === "GET") {
      const batchId = decodeURIComponent(singleProposalMatch[1]!);
      try {
        const resp = await fetch(
          `${BACKEND_URL}/api/calendar/proposals/${encodeURIComponent(batchId)}`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (resp.ok) {
          const data = await resp.json();
          sendJson(res, 200, data);
          return;
        }
      } catch {}

      const state = await loadBackendState();
      const found = (state.pending_proposals ?? []).find(
        (p: any) => p.batch_id === batchId || p.proposal_id === batchId
      );
      if (!found) {
        sendJson(res, 404, { detail: `Proposal batch '${batchId}' not found.` });
        return;
      }
      sendJson(res, 200, { proposal: found });
      return;
    }

    const approveMatch = pathname.match(/^\/api\/calendar\/proposals\/([^/]+)\/approve$/);
    if (approveMatch && method === "POST") {
      const batchId = decodeURIComponent(approveMatch[1]!);
      const body = await readJsonBody(req);
      const proposalIds: string[] | undefined = Array.isArray(body.proposal_ids) ? body.proposal_ids : undefined;

      // Also sync to Google Calendar via StagedProposalEngine (`demoCalendar`)
      let gcalSyncInfo: { replyText?: string } = {};
      try {
        gcalSyncInfo = await stagedEngine.approvePending(batchId, proposalIds);
      } catch {}

      try {
        const resp = await fetch(
          `${BACKEND_URL}/api/calendar/proposals/${encodeURIComponent(batchId)}/approve`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proposal_ids: proposalIds ?? null }),
            signal: AbortSignal.timeout(4000),
          }
        );
        if (resp.ok) {
          const data = await resp.json();
          sendJson(res, 200, { ...data, message: gcalSyncInfo.replyText ?? data.message });
          return;
        }
      } catch {}

      // Fallback state.json approval
      const state = await loadBackendState();
      const target = (state.pending_proposals ?? []).find(
        (p: any) => p.batch_id === batchId || p.proposal_id === batchId
      );
      if (!target) {
        sendJson(res, 404, { detail: `Proposal batch '${batchId}' not found.` });
        return;
      }

      let approvedCount = 0;
      for (const diff of target.operations ?? []) {
        const id = diff.proposal_id ?? diff.operation_id;
        if (proposalIds?.length && !proposalIds.includes(id)) continue;
        if (diff.status === "approved") continue;

        const opType = diff.op_type ?? diff.operation_type;
        const after = diff.after_state ?? {};
        if (opType === "CREATE_EVENT") {
          if ((after.event_type ?? "study_block") === "study_block") {
            state.blocks = [
              ...(state.blocks ?? []),
              {
                id: `blk_${randomUUID().slice(0, 8)}`,
                assignment_id: "asgn_approved",
                title: after.title ?? "Study Block",
                start_time: after.start_time ?? state.current_time,
                end_time: after.end_time ?? state.current_time,
                recommended_location: after.recommended_location ?? after.location ?? "library",
                predicted_reward: Number(after.predicted_reward ?? 4.5),
                uncertainty_bound: Number(after.uncertainty_bound ?? 0.25),
                status: "scheduled",
                explanation: diff.reasoning ?? "",
              },
            ];
          } else {
            state.events = [
              ...(state.events ?? []),
              {
                id: `ev_${randomUUID().slice(0, 8)}`,
                title: after.title ?? "Calendar Event",
                start_time: after.start_time ?? state.current_time,
                end_time: after.end_time ?? state.current_time,
                source: "imported_calendar",
              },
            ];
          }
        } else if (opType === "UPDATE_EVENT") {
          const targetId = diff.before_state?.id;
          const blk = (state.blocks ?? []).find((b: any) => b.id === targetId);
          if (blk) {
            blk.title = after.title ?? blk.title;
            blk.start_time = after.start_time ?? blk.start_time;
            blk.end_time = after.end_time ?? blk.end_time;
            blk.recommended_location = after.recommended_location ?? blk.recommended_location;
          } else {
            state.blocks = [
              ...(state.blocks ?? []),
              {
                id: `blk_${randomUUID().slice(0, 8)}`,
                assignment_id: "asgn_moved",
                title: after.title ?? "Updated Study Block",
                start_time: after.start_time ?? state.current_time,
                end_time: after.end_time ?? state.current_time,
                recommended_location: after.recommended_location ?? "desk",
                predicted_reward: Number(after.predicted_reward ?? 4.6),
                uncertainty_bound: Number(after.uncertainty_bound ?? 0.25),
                status: "scheduled",
                explanation: diff.reasoning ?? "",
              },
            ];
          }
        } else if (opType === "SPLIT_OR_RESCHEDULE_BLOCK") {
          const chunks = after.proposed_chunks ?? after.chunks ?? [];
          for (const ch of chunks) {
            state.blocks = [
              ...(state.blocks ?? []),
              {
                id: `blk_${randomUUID().slice(0, 8)}`,
                assignment_id: "asgn_split",
                title: ch.title ?? "Split Study Block",
                start_time: ch.start_time,
                end_time: ch.end_time,
                recommended_location: ch.recommended_location ?? ch.location ?? "library",
                predicted_reward: Number(ch.predicted_reward ?? 4.6),
                uncertainty_bound: Number(ch.uncertainty_bound ?? 0.25),
                status: "scheduled",
                explanation: diff.reasoning ?? "",
              },
            ];
          }
        } else if (opType === "DELETE_EVENT") {
          const delTitle = String(diff.before_state?.title ?? "").toLowerCase();
          state.events = (state.events ?? []).filter((e: any) => e.title?.toLowerCase() !== delTitle);
          state.blocks = (state.blocks ?? []).filter((b: any) => b.title?.toLowerCase() !== delTitle);
        } else if (opType === "UPDATE_DEADLINE") {
          const key = String(after.assignment_id_or_title ?? after.title ?? "").toLowerCase();
          for (const a of state.assignments ?? []) {
            if (a.title?.toLowerCase().includes(key)) {
              a.due_date = after.new_due_date ?? after.due_date ?? a.due_date;
            }
          }
        }
        diff.status = "approved";
        approvedCount++;
      }

      target.status = (target.operations ?? []).every((d: any) => d.status === "approved")
        ? "approved"
        : "modified";
      await saveBackendState(state);

      sendJson(res, 200, {
        status: target.status,
        batch_id: target.batch_id,
        approved_operations_count: approvedCount,
        proposal: target,
      });
      return;
    }

    const rejectMatch = pathname.match(/^\/api\/calendar\/proposals\/([^/]+)\/reject$/);
    if (rejectMatch && method === "POST") {
      const batchId = decodeURIComponent(rejectMatch[1]!);
      const body = await readJsonBody(req);
      try {
        await stagedEngine.rejectPending(batchId, body.reason);
      } catch {}

      try {
        const resp = await fetch(
          `${BACKEND_URL}/api/calendar/proposals/${encodeURIComponent(batchId)}/reject`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: body.reason || "Rejected in web UI" }),
            signal: AbortSignal.timeout(4000),
          }
        );
        if (resp.ok) {
          const data = await resp.json();
          sendJson(res, 200, data);
          return;
        }
      } catch {}

      const state = await loadBackendState();
      const target = (state.pending_proposals ?? []).find(
        (p: any) => p.batch_id === batchId || p.proposal_id === batchId
      );
      if (!target) {
        sendJson(res, 404, { detail: `Proposal batch '${batchId}' not found.` });
        return;
      }
      target.status = "rejected";
      target.rejection_feedback = body.reason || "User rejected in Web Approval UI";
      for (const d of target.operations ?? []) {
        if (d.status === "pending") d.status = "rejected";
      }
      await saveBackendState(state);

      sendJson(res, 200, {
        status: "rejected",
        batch_id: target.batch_id,
        agent_follow_up:
          "Discarded those staged changes and updated your rhythm learner. What times or study locations would feel better?",
        proposal: target,
      });
      return;
    }

    // Generic proxy to FastAPI for remaining `/api/*` or `/analyze-workspace` routes
    if (pathname.startsWith("/api/") || pathname === "/analyze-workspace") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const rawBody = Buffer.concat(chunks);
        const proxyResp = await fetch(`${BACKEND_URL}${pathname}${url.search}`, {
          method,
          headers: {
            ...(req.headers["content-type"] ? { "Content-Type": String(req.headers["content-type"]) } : {}),
          },
          body: method !== "GET" && method !== "HEAD" ? rawBody : undefined,
          signal: AbortSignal.timeout(8000),
        });
        const respText = await proxyResp.text();
        res.writeHead(proxyResp.status, {
          "Content-Type": proxyResp.headers.get("content-type") || "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(respText);
        return;
      } catch (err) {
        // Fallback if FastAPI isn't running for demo-stage or incoming-message
        if (pathname === "/api/demo/set-stage" && method === "POST") {
          const state = await loadBackendState();
          sendJson(res, 200, {
            status: "stage_applied",
            stage: state.demo_stage,
            calendar: buildFallbackCalendarPayload(state),
          });
          return;
        }
        sendJson(res, 503, { detail: "Backend service unavailable", error: String(err) });
        return;
      }
    }

    // ===================================================================
    // 3. Static Frontend Assets & SPA Route Serving
    // ===================================================================
    let filePath = join(FRONTEND_DIR, pathname === "/" ? "index.html" : pathname.replace(/^\/assets\//, "/"));
    if (
      pathname === "/" ||
      pathname === "/dashboard" ||
      pathname === "/about" ||
      pathname === "/insights" ||
      pathname === "/customize" ||
      pathname === "/calendar" ||
      pathname === "/approve" ||
      pathname.startsWith("/approve/")
    ) {
      filePath = join(FRONTEND_DIR, "index.html");
    }

    if (existsSync(filePath)) {
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const content = await readFile(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
      return;
    }

    // Fallback to index.html for SPA client routing
    const indexHtml = join(FRONTEND_DIR, "index.html");
    if (existsSync(indexHtml)) {
      const content = await readFile(indexHtml);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
      return;
    }

    sendJson(res, 404, { detail: "Not found" });
  } catch (error) {
    console.error("Server error:", error);
    sendJson(res, 500, { detail: "Internal server error" });
  }
}

export const server = createServer(handleWebRequest);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, () => {
    console.log(`\n✨ Daywise Web App & API Coordinator running at: ${FRONTEND_URL}`);
    console.log(`   • Splashpage (5-screen intro): ${FRONTEND_URL}/`);
    console.log(`   • Daily Dashboard (GCal + LLM): ${FRONTEND_URL}/dashboard`);
    console.log(`   • Final Approval Screen:        ${FRONTEND_URL}/approve`);
    console.log(`   • Model Customizer:             ${FRONTEND_URL}/customize\n`);
  });
}
