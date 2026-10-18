"""
/backend/main.py

FastAPI Server for the Zero-Setup, Self-Learning AI Calendar & Productivity Engine.
Includes:
- CORS middleware for frontend & Photon bridge integration
- Persistent JSON state (`backend/state.json`)
- Agentic Calendar Planner & Staged Approval Queue ("Git Diff for Calendar"):
  * `POST /api/calendar/propose`
  * `GET /api/calendar/proposals/pending`
  * `POST /api/calendar/proposals/{batch_id}/approve`
  * `POST /api/calendar/proposals/{batch_id}/reject`
- Blank-Canvas Discovery Mode & 3-Stage Live Hackathon Demo Switcher (`/api/demo/set-stage`)
- Time-simulation tick endpoint (`/api/proactive/simulate-tick`)
- Multi-entity natural language brain-dump & routine router (`/api/agent/incoming-message`)
- Dynamic session truncation & spillover rescheduler (`/api/blocks/{block_id}/cut-short`)
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .agent import PhotonAgentRouter, extract_assignments_from_text, extract_recurring_events_and_routines
from .bandit import ARMS, LinUCBOptimizer
from .models import (
    ApproveProposalRequest,
    Assignment,
    CutShortRequest,
    DemoStageRequest,
    EngineState,
    FixedEvent,
    IncomingMessageRequest,
    IncomingMessageResponse,
    LearnedUserRhythm,
    OutboundPrompt,
    ProposeCalendarRequest,
    RejectProposalRequest,
    ScheduledBlock,
    SimulateTickRequest,
)
from .proactive import check_and_generate_prompts, check_calendar_sparsity
from .proposals import (
    approve_proposal_batch,
    reject_proposal_batch,
    stage_proposal_batch,
    synthesize_calendar_proposal_batch,
)
from .rhythm import ZeroSetupRhythmLearner
from .scheduler import DynamicScheduler

logger = logging.getLogger("backend.main")
logging.basicConfig(level=logging.INFO)

BACKEND_DIR = Path(__file__).parent
STATE_FILE = BACKEND_DIR / "state.json"

DEFAULT_DEMO_START_ISO = "2026-10-19T09:30:00+00:00"


def _parse_iso(ts: str) -> datetime:
    cleaned = ts.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(cleaned)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


class ProductivityEngineManager:
    """
    Coordinates `EngineState`, `ZeroSetupRhythmLearner`, `LinUCBOptimizer`,
    `DynamicScheduler`, `ProactiveEngine`, `StagedChangeProposal` queue, and `state.json` persistence.
    """

    def __init__(self, state_path: Path = STATE_FILE):
        self.state_path = state_path
        self.state: EngineState = EngineState(current_time=DEFAULT_DEMO_START_ISO)
        self.rhythm_learner: ZeroSetupRhythmLearner = ZeroSetupRhythmLearner.from_cold_start()
        self.bandit: LinUCBOptimizer = LinUCBOptimizer.create_cold_start()
        self.scheduler: DynamicScheduler = DynamicScheduler(self.rhythm_learner, self.bandit)

        if self.state_path.exists():
            self.load_state()
        else:
            self.apply_demo_stage("blank_canvas")

    def save_state(self) -> None:
        self.state.rhythm = self.rhythm_learner.rhythm
        self.state.bandit_state = self.bandit.to_dict()
        self.state.workspace_quality_by_arm = dict(self.bandit.workspace_priors)
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(
                json.dumps(self.state.model_dump(), indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.error("Failed to save state.json: %s", e)

    def load_state(self) -> None:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
            self.state = EngineState(**raw)
            self.rhythm_learner = ZeroSetupRhythmLearner(self.state.rhythm)
            self.bandit = LinUCBOptimizer.from_dict(self.state.bandit_state)
            self.scheduler = DynamicScheduler(self.rhythm_learner, self.bandit)
        except Exception as e:
            logger.warning("Could not load state.json (%s), initializing blank_canvas.", e)
            self.apply_demo_stage("blank_canvas")

    # =====================================================================
    # 3-Stage Live Hackathon Demo Preset Builder
    # =====================================================================

    def apply_demo_stage(self, stage: str, user_id: str = "default_user") -> Dict[str, Any]:
        norm_stage = stage.lower().strip()
        ref_dt = _parse_iso(DEFAULT_DEMO_START_ISO)

        if norm_stage in ("blank_canvas", "cold_start"):
            self.rhythm_learner = ZeroSetupRhythmLearner.from_cold_start()
            self.rhythm_learner.rhythm.onboarding_stage = (
                "blank_canvas" if norm_stage == "blank_canvas" else "cold_start"
            )
            self.bandit = LinUCBOptimizer.create_cold_start()
            self.scheduler = DynamicScheduler(self.rhythm_learner, self.bandit)

            self.state = EngineState(
                user_id=user_id,
                demo_stage=norm_stage,
                current_time=DEFAULT_DEMO_START_ISO,
                events=[],
                assignments=[],
                blocks=[],
                rhythm=self.rhythm_learner.rhythm,
                bandit_state=self.bandit.to_dict(),
                prompts=[],
                pending_proposals=[],
            )
            initial_prompts = check_and_generate_prompts(
                current_time=self.state.current_time,
                events=self.state.events,
                blocks=self.state.blocks,
                rhythm=self.rhythm_learner.rhythm,
                bandit=self.bandit,
                existing_prompts=self.state.prompts,
            )
            self.state.prompts.extend(initial_prompts)
            self.save_state()
            return self.get_calendar_payload()

        if norm_stage in ("day_3_calibrating", "calibrating"):
            self.rhythm_learner = ZeroSetupRhythmLearner.from_day_3_calibrating()
            self.rhythm_learner.rhythm.onboarding_stage = (
                "day_3_calibrating" if norm_stage == "day_3_calibrating" else "calibrating"
            )
            self.bandit = LinUCBOptimizer.create_day_3_calibrating()
            self.scheduler = DynamicScheduler(self.rhythm_learner, self.bandit)

            self.state = EngineState(
                user_id=user_id,
                demo_stage=norm_stage,
                current_time=DEFAULT_DEMO_START_ISO,
                events=[],
                assignments=[],
                blocks=[],
                rhythm=self.rhythm_learner.rhythm,
                bandit_state=self.bandit.to_dict(),
                prompts=[],
                pending_proposals=[],
            )

            router = PhotonAgentRouter(
                state=self.state,
                rhythm_learner=self.rhythm_learner,
                bandit=self.bandit,
                scheduler=self.scheduler,
            )
            router.handle_incoming(
                IncomingMessageRequest(
                    user_id=user_id,
                    text="I have CS lecture MWF 10-11:30, work Tuesdays 2-5, and a huge 5-hour ML project due Friday",
                    timestamp=DEFAULT_DEMO_START_ISO,
                    auto_commit=True,
                )
            )
            self.rhythm_learner.rhythm.onboarding_stage = (
                "day_3_calibrating" if norm_stage == "day_3_calibrating" else "calibrating"
            )

            photo_prompts = check_and_generate_prompts(
                current_time=self.state.current_time,
                events=self.state.events,
                blocks=self.state.blocks,
                rhythm=self.rhythm_learner.rhythm,
                bandit=self.bandit,
                existing_prompts=self.state.prompts,
                force_trigger="request_workspace_photo",
            )
            self.state.prompts.extend(photo_prompts)
            self.save_state()
            return self.get_calendar_payload()

        if norm_stage in ("day_21_optimized", "personalized"):
            self.rhythm_learner = ZeroSetupRhythmLearner.from_day_21_night_owl()
            self.rhythm_learner.rhythm.onboarding_stage = (
                "day_21_optimized" if norm_stage == "day_21_optimized" else "personalized"
            )
            self.bandit = LinUCBOptimizer.create_day_21_night_owl()
            self.scheduler = DynamicScheduler(self.rhythm_learner, self.bandit)

            events, _, _, _ = extract_recurring_events_and_routines(
                "I have CS lecture MWF 10-11:30, work Tuesdays 2-5, and go to the gym at 6pm",
                ref_dt,
            )
            assignments = extract_assignments_from_text(
                "huge 5-hour ML project due Friday and 3-hour Distributed Systems lab due Thursday",
                ref_dt,
            )

            blocks: List[ScheduledBlock] = []
            for asgn in assignments:
                new_blks = self.scheduler.schedule_or_split_assignment(
                    assignment=asgn,
                    events=events,
                    existing_blocks=blocks,
                    reference_time=DEFAULT_DEMO_START_ISO,
                )
                blocks.extend(new_blks)

            self.state = EngineState(
                user_id=user_id,
                demo_stage=norm_stage,
                current_time=DEFAULT_DEMO_START_ISO,
                events=events,
                assignments=assignments,
                blocks=blocks,
                rhythm=self.rhythm_learner.rhythm,
                bandit_state=self.bandit.to_dict(),
                prompts=[],
                pending_proposals=[],
            )
            self.save_state()
            return self.get_calendar_payload()

        raise ValueError(f"Unsupported demo stage: {stage}")

    # =====================================================================
    # Calendar & LinUCB Telemetry Builder
    # =====================================================================

    def get_calendar_payload(self) -> Dict[str, Any]:
        sparsity = check_calendar_sparsity(
            self.state.events,
            self.state.blocks,
            rhythm=self.rhythm_learner.rhythm,
        )
        hourly_curve = []
        for hr in range(24):
            act_prob = self.rhythm_learner.rhythm.hourly_activity_prob[hr]
            sched_weight = self.rhythm_learner.is_hour_schedulable(hr)
            slot_eval = self.bandit.evaluate_slot(
                hour=hr,
                difficulty=4,
                fatigue=self.rhythm_learner.rhythm.rolling_fatigue,
                activity_prob=act_prob,
            )
            hourly_curve.append({
                "hour": hr,
                "label": f"{hr:02d}:00",
                "activity_prob": act_prob,
                "schedulable_weight": sched_weight,
                "best_location": slot_eval["location"],
                "expected_reward": slot_eval["expected_reward"],
                "uncertainty_bound": slot_eval["uncertainty_bound"],
                "ucb_score": slot_eval["ucb_score"],
            })

        pending_proposals = [
            p.model_dump() for p in self.state.pending_proposals if p.status == "pending"
        ]

        return {
            "user_id": self.state.user_id,
            "demo_stage": self.state.demo_stage,
            "current_time": self.state.current_time,
            "calendar_sparsity": sparsity,
            "is_sparse_discovery_mode": sparsity < 0.20,
            "events": [e.model_dump() for e in self.state.events],
            "assignments": [a.model_dump() for a in self.state.assignments],
            "scheduled_blocks": [b.model_dump() for b in self.state.blocks],
            "blocks": [b.model_dump() for b in self.state.blocks],
            "pending_proposals": pending_proposals,
            "rhythm": self.rhythm_learner.rhythm.model_dump(),
            "linucb_stats": {
                "preset_mode": self.bandit.preset_mode,
                "alpha": self.bandit.alpha,
                "total_observations": self.bandit.total_observations,
                "arm_counts": self.bandit.arm_counts,
                "workspace_priors": self.bandit.workspace_priors,
                "theta": self.bandit.to_dict()["theta"],
                "hourly_evaluations": hourly_curve,
            },
            "pending_prompts_count": sum(1 for p in self.state.prompts if not p.resolved),
        }


# Singleton Engine Manager
engine = ProductivityEngineManager()

# =====================================================================
# FastAPI Application & Endpoints
# =====================================================================

app = FastAPI(
    title="Zero-Setup Self-Learning AI Calendar & Productivity Engine",
    description=(
        "FastAPI backend with Agentic Calendar Planner, Staged Approval Queue ('Git Diff for Calendar'), "
        "Blank-Canvas Discovery Mode, 24-hour zero-setup circadian rhythm learning, "
        "7D Disjoint LinUCB contextual bandit, dynamic task splitting, and Photon proactive outreach."
    ),
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount workspace VLM analysis routes from `analyze_workspace.py` if present in parent dir
try:
    import sys
    root_dir = str(BACKEND_DIR.parent)
    if root_dir not in sys.path:
        sys.path.insert(0, root_dir)
    from analyze_workspace import router as workspace_vlm_router
    app.include_router(workspace_vlm_router)
except Exception as e:
    logger.info("Standalone mode without root analyze_workspace router: %s", e)


@app.get("/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "service": "zero_setup_productivity_engine",
        "demo_stage": engine.state.demo_stage,
        "current_time": engine.state.current_time,
        "events_count": len(engine.state.events),
        "blocks_count": len(engine.state.blocks),
        "pending_proposals_count": sum(1 for p in engine.state.pending_proposals if p.status == "pending"),
        "onboarding_stage": engine.rhythm_learner.rhythm.onboarding_stage,
    }


@app.get("/api/calendar", tags=["Calendar & Learning State"])
async def get_calendar():
    """
    Returns `FixedEvent`s, `ScheduledBlock`s, `Assignment`s, `pending_proposals`,
    `LearnedUserRhythm` (24-hour activity probability curve), calendar sparsity, and Disjoint LinUCB stats.
    """
    return engine.get_calendar_payload()


# =====================================================================
# Staged Approval Queue ("Git Diff for Calendar") Endpoints
# =====================================================================

@app.post("/api/calendar/propose", tags=["Staged Approval Queue (Git Diff for Calendar)"])
async def propose_calendar_changes(payload: ProposeCalendarRequest):
    """
    Passes user text or proactive trigger to the Agentic Calendar Planner (LLM + LinUCB & Rhythm context),
    generates a `StagedChangeProposal` batch with `before_state`, `after_state`, and `veyzl_audit`,
    saves it to `pending_proposals` (`status="pending"`), and returns both the conversational explanation
    and the structured diff list without immediately mutating live calendar state.
    """
    batch = synthesize_calendar_proposal_batch(
        user_text=payload.text,
        state=engine.state,
        rhythm_learner=engine.rhythm_learner,
        bandit=engine.bandit,
        scheduler=engine.scheduler,
        reference_time=payload.timestamp or engine.state.current_time,
    )
    if not batch.operations:
        raise HTTPException(
            status_code=400,
            detail="Could not identify calendar mutations in request. Try describing classes, study blocks, deadlines, or edits.",
        )

    staged = stage_proposal_batch(
        batch=batch,
        state=engine.state,
        rhythm_learner=engine.rhythm_learner,
        bandit=engine.bandit,
        source=payload.source,
    )
    engine.save_state()

    return {
        "status": "staged",
        "batch_id": staged.batch_id,
        "proposal_id": staged.proposal_id,
        "summary_message": staged.summary_message,
        "reply_text": f"{staged.summary_message}\n\nReview & approve all changes here:\n{staged.approval_url}",
        "approval_url": staged.approval_url,
        "veyzl_audit": staged.veyzl_audit.model_dump(),
        "operations_count": len(staged.operations),
        "proposal": staged.model_dump(),
    }


@app.get("/api/calendar/proposals/pending", tags=["Staged Approval Queue (Git Diff for Calendar)"])
async def get_pending_calendar_proposals(
    include_all: bool = Query(False, description="If True, returns approved/rejected proposals too"),
):
    """
    Returns all `"pending"` `StagedChangeProposal` batches with full `before_state` and `after_state`
    blocks so the Web Visual UI can render ghost/dashed red/green preview blocks on the calendar grid.
    """
    if include_all:
        items = engine.state.pending_proposals
    else:
        items = [p for p in engine.state.pending_proposals if p.status in ("pending", "modified")]

    return {
        "count": len(items),
        "proposals": [p.model_dump() for p in items],
    }


@app.get("/api/calendar/proposals/{batch_id}", tags=["Staged Approval Queue (Git Diff for Calendar)"])
async def get_calendar_proposal_by_id(batch_id: str):
    """
    Returns a specific `StagedChangeProposal` batch by `batch_id` or `proposal_id` for the Final Approval Screen.
    """
    target = next(
        (p for p in engine.state.pending_proposals if p.batch_id == batch_id or p.proposal_id == batch_id),
        None,
    )
    if target is None:
        raise HTTPException(status_code=404, detail=f"Proposal batch '{batch_id}' not found")
    return {"proposal": target.model_dump()}


@app.post("/api/calendar/proposals/{batch_id}/approve", tags=["Staged Approval Queue (Git Diff for Calendar)"])
async def approve_calendar_proposal(batch_id: str, payload: Optional[ApproveProposalRequest] = None):
    """
    Approves a `StagedChangeProposal` batch (either the full batch or an optional subset of `proposal_ids`
    for partial approval), executes the mutations on `/backend` state (`state.json`), and marks the proposal `"approved"`.
    """
    req = payload or ApproveProposalRequest()
    try:
        res = approve_proposal_batch(
            state=engine.state,
            rhythm_learner=engine.rhythm_learner,
            bandit=engine.bandit,
            scheduler=engine.scheduler,
            batch_id=batch_id,
            proposal_ids=req.proposal_ids,
        )
        engine.save_state()
        return res
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/api/calendar/proposals/{batch_id}/reject", tags=["Staged Approval Queue (Git Diff for Calendar)"])
async def reject_calendar_proposal(batch_id: str, payload: Optional[RejectProposalRequest] = None):
    """
    Discards the staged changes for `batch_id`, marks the proposal `"rejected"`,
    and feeds a negative preference signal back to the rhythm learner so the agent asks how to adjust.
    """
    req = payload or RejectProposalRequest()
    try:
        res = reject_proposal_batch(
            state=engine.state,
            rhythm_learner=engine.rhythm_learner,
            bandit=engine.bandit,
            batch_id=batch_id,
            reason=req.reason,
        )
        engine.save_state()
        return res
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# =====================================================================
# Proactive Outreach, Incoming Message Router, & Demo Endpoints
# =====================================================================

@app.get("/api/proactive/pending", tags=["Proactive Photon Outreach"])
async def get_pending_proactive_prompts(
    include_resolved: bool = Query(False, description="Include already resolved prompts"),
):
    if include_resolved:
        prompts = engine.state.prompts
    else:
        prompts = [p for p in engine.state.prompts if not p.resolved]
    return {
        "count": len(prompts),
        "current_time": engine.state.current_time,
        "calendar_sparsity": check_calendar_sparsity(
            engine.state.events, engine.state.blocks, engine.rhythm_learner.rhythm
        ),
        "prompts": [p.model_dump() for p in prompts],
    }


@app.post("/api/proactive/simulate-tick", tags=["Proactive Photon Outreach"])
async def simulate_proactive_tick(payload: Optional[SimulateTickRequest] = None):
    req = payload or SimulateTickRequest()
    cur_dt = _parse_iso(engine.state.current_time)

    if req.simulated_time:
        cur_dt = _parse_iso(req.simulated_time)
    elif req.advance_minutes is not None:
        cur_dt = cur_dt + timedelta(minutes=int(req.advance_minutes))
    else:
        next_blk = next(
            (b for b in engine.state.blocks if b.status == "scheduled" and _parse_iso(b.start_time) >= cur_dt),
            None,
        )
        if next_blk and not req.force_trigger:
            cur_dt = _parse_iso(next_blk.start_time) + timedelta(minutes=12)
        else:
            cur_dt = cur_dt + timedelta(minutes=15)

    engine.state.current_time = cur_dt.isoformat()

    generated = check_and_generate_prompts(
        current_time=engine.state.current_time,
        events=engine.state.events,
        blocks=engine.state.blocks,
        rhythm=engine.rhythm_learner.rhythm,
        bandit=engine.bandit,
        existing_prompts=engine.state.prompts,
        force_trigger=req.force_trigger,
    )
    engine.state.prompts.extend(generated)
    engine.save_state()

    return {
        "status": "tick_processed",
        "current_time": engine.state.current_time,
        "generated_count": len(generated),
        "generated_prompts": [p.model_dump() for p in generated],
        "pending_prompts": [p.model_dump() for p in engine.state.prompts if not p.resolved],
    }


@app.post(
    "/api/agent/incoming-message",
    response_model=IncomingMessageResponse,
    tags=["Natural Language Agent & Brain-Dump Router"],
)
async def handle_incoming_message(payload: IncomingMessageRequest):
    router = PhotonAgentRouter(
        state=engine.state,
        rhythm_learner=engine.rhythm_learner,
        bandit=engine.bandit,
        scheduler=engine.scheduler,
    )
    response = router.handle_incoming(payload)
    engine.save_state()
    return response


@app.post("/api/blocks/{block_id}/cut-short", tags=["Dynamic Task Splitter & Scheduler"])
async def cut_block_short(block_id: str, payload: CutShortRequest):
    try:
        result = engine.scheduler.cut_session_short(
            block_id=block_id,
            mins_completed=payload.mins_completed,
            rating=payload.rating,
            mood=payload.mood,
            reason=payload.reason,
            blocks=engine.state.blocks,
            assignments=engine.state.assignments,
            events=engine.state.events,
            reference_time=engine.state.current_time,
        )
        engine.save_state()
        return {
            "status": "rescheduled",
            "cut_block": result["cut_block"].model_dump(),
            "mins_completed": result["mins_completed"],
            "spillover_mins": result["spillover_mins"],
            "rescheduled_blocks": [b.model_dump() for b in result["rescheduled_blocks"]],
            "updated_hour_prob": result["updated_hour_prob"],
            "rolling_fatigue": result["rolling_fatigue"],
        }
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/api/demo/set-stage", tags=["Live Hackathon Demo Presets"])
async def set_demo_stage(payload: DemoStageRequest):
    try:
        cal = engine.apply_demo_stage(payload.stage, user_id=payload.user_id or "default_user")
        return {
            "status": "stage_applied",
            "stage": payload.stage,
            "calendar": cal,
            "pending_prompts": [p.model_dump() for p in engine.state.prompts if not p.resolved],
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# =====================================================================
# Google OAuth & Daily Supplement Snapshot + Static Frontend Routes
# =====================================================================

@app.get("/api/auth/status", tags=["Google OAuth & Calendar Integration"])
async def get_auth_status():
    token_path = BACKEND_DIR.parent / ".google-calendar-token.json"
    has_token_file = token_path.exists()
    cal_id = os.getenv("GOOGLE_CALENDAR_ID", "c_8a3f88a63add1862899e38c8eb168366805a752ed4bc3283303e5a68823964bf@group.calendar.google.com")
    return {
        "authenticated": True,
        "provider": "google_oauth",
        "calendar_id": cal_id,
        "has_token_file": has_token_file,
        "user": {
            "name": "UW Student (Hackathon Demo)",
            "email": "student@uw.edu",
            "calendar_name": "Hackathon Demo Calendar",
        },
    }


@app.post("/api/auth/google/connect", tags=["Google OAuth & Calendar Integration"])
async def connect_google_account():
    if not engine.state.events and not engine.state.blocks:
        engine.apply_demo_stage("day_21_optimized")
    cal_id = os.getenv("GOOGLE_CALENDAR_ID", "c_8a3f88a63add1862899e38c8eb168366805a752ed4bc3283303e5a68823964bf@group.calendar.google.com")
    return {
        "status": "connected",
        "authenticated": True,
        "calendar_id": cal_id,
        "user": {
            "name": "UW Student (Hackathon Demo)",
            "email": "student@uw.edu",
            "calendar_name": "Hackathon Demo Calendar",
        },
        "redirect_to": "/dashboard",
    }


@app.get("/api/google-calendar/today", tags=["Google OAuth & Calendar Integration"])
async def get_google_calendar_today():
    cal_id = os.getenv("GOOGLE_CALENDAR_ID", "c_8a3f88a63add1862899e38c8eb168366805a752ed4bc3283303e5a68823964bf@group.calendar.google.com")
    events_sample = [
        {
            "id": e.id,
            "title": e.title,
            "start_time": e.start_time,
            "end_time": e.end_time,
            "source": "google_calendar_synced",
        }
        for e in engine.state.events
    ]
    blocks_sample = [
        {
            "id": b.id,
            "title": b.title,
            "start_time": b.start_time,
            "end_time": b.end_time,
            "recommended_location": b.recommended_location,
            "source": "google_calendar_synced",
        }
        for b in engine.state.blocks
    ]
    if not events_sample and not blocks_sample:
        events_sample = [
            {
                "id": "gcal_1",
                "title": "Math lecture",
                "start_time": "2026-10-19T09:00:00+00:00",
                "end_time": "2026-10-19T10:00:00+00:00",
                "source": "google_calendar_demo",
            },
            {
                "id": "gcal_2",
                "title": "CS lecture",
                "start_time": "2026-10-19T11:00:00+00:00",
                "end_time": "2026-10-19T12:00:00+00:00",
                "source": "google_calendar_demo",
            },
            {
                "id": "gcal_3",
                "title": "Lunch",
                "start_time": "2026-10-19T12:00:00+00:00",
                "end_time": "2026-10-19T12:45:00+00:00",
                "source": "google_calendar_demo",
            },
            {
                "id": "gcal_4",
                "title": "Campus club",
                "start_time": "2026-10-19T15:00:00+00:00",
                "end_time": "2026-10-19T16:00:00+00:00",
                "source": "google_calendar_demo",
            },
            {
                "id": "gcal_5",
                "title": "Dinner",
                "start_time": "2026-10-19T18:00:00+00:00",
                "end_time": "2026-10-19T18:45:00+00:00",
                "source": "google_calendar_demo",
            },
        ]
    combined = sorted(
        events_sample + blocks_sample,
        key=lambda item: item.get("start_time") or "",
    )[:8]
    return {
        "calendar_id": cal_id,
        "authenticated": True,
        "user": {
            "name": "UW Student (Hackathon Demo)",
            "email": "student@uw.edu",
            "calendar_name": "Hackathon Demo · Google Calendar",
        },
        "upcoming_tasks": combined,
        "today_events_sample": combined[:6],
    }


try:
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    FRONTEND_DIR = BACKEND_DIR.parent / "frontend"
    if FRONTEND_DIR.exists():
        app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR)), name="frontend_assets")

    @app.get("/", include_in_schema=False)
    @app.get("/dashboard", include_in_schema=False)
    @app.get("/customize", include_in_schema=False)
    @app.get("/calendar", include_in_schema=False)
    @app.get("/approve", include_in_schema=False)
    @app.get("/approve/{batch_id}", include_in_schema=False)
    async def serve_spa(batch_id: Optional[str] = None):
        index_file = FRONTEND_DIR / "index.html"
        if index_file.exists():
            return FileResponse(str(index_file))
        return {"message": "Daywise Frontend is starting..."}
except Exception as e:
    logger.info("Frontend static routes not mounted: %s", e)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("BACKEND_PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
