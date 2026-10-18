"""
/backend/main.py

FastAPI Server for the Zero-Setup, Self-Learning AI Calendar & Productivity Engine.
Includes:
- CORS middleware for frontend & Photon bridge integration
- Persistent JSON state (`backend/state.json`)
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
    Assignment,
    CutShortRequest,
    DemoStageRequest,
    EngineState,
    FixedEvent,
    IncomingMessageRequest,
    IncomingMessageResponse,
    LearnedUserRhythm,
    OutboundPrompt,
    ScheduledBlock,
    SimulateTickRequest,
)
from .proactive import check_and_generate_prompts, check_calendar_sparsity
from .rhythm import ZeroSetupRhythmLearner
from .scheduler import DynamicScheduler

logger = logging.getLogger("backend.main")
logging.basicConfig(level=logging.INFO)

BACKEND_DIR = Path(__file__).parent
STATE_FILE = BACKEND_DIR / "state.json"

# Anchor demo clock to a clean Monday morning so MWF / Tuesday / Friday deadlines align predictably
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
    `DynamicScheduler`, `ProactiveEngine`, and `state.json` persistence.
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
        """
        Configures one of the 3 live hackathon presentation stages:
        1. `blank_canvas` (or `cold_start`):
           0 events, 0 blocks, flat uninformative rhythm prior, high LinUCB uncertainty (±1.2★).
           Immediately queues the `discovery_brain_dump` outbound Photon prompt.
        2. `day_3_calibrating` (or `calibrating`):
           Classes (`CS Lecture` MWF 10-11:30, `Work` Tue 14:00-17:00) and split `ML Project`
           blocks populated from the brain-dump conversation, with high LinUCB uncertainty (±1.2★)
           actively probing workspace photos.
        3. `day_21_optimized` (or `personalized`):
           Fully learned Night-Owl / Library Persona circadian rhythm curve, tight confidence
           intervals (±0.2★), and environment-optimized study blocks (10am-2pm Library & 10pm-1:30am Desk).
        """
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
            )
            # Trigger initial Discovery Mode brain-dump prompt
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
            )

            # Populate directly via the brain-dump extractor so Day 3 reflects the user's messy reply
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
                )
            )
            self.rhythm_learner.rhythm.onboarding_stage = (
                "day_3_calibrating" if norm_stage == "day_3_calibrating" else "calibrating"
            )

            # Queue a workspace photo check-in prompt for the first scheduled block
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
        "FastAPI backend with Blank-Canvas Discovery Mode, 24-hour zero-setup circadian rhythm learning, "
        "7D Disjoint LinUCB contextual bandit, dynamic task splitting, and Photon proactive outreach."
    ),
    version="1.0.0",
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
        "onboarding_stage": engine.rhythm_learner.rhythm.onboarding_stage,
    }


@app.get("/api/calendar", tags=["Calendar & Learning State"])
async def get_calendar():
    """
    Returns `FixedEvent`s, `ScheduledBlock`s, `Assignment`s, `LearnedUserRhythm`
    (24-hour activity probability curve), calendar sparsity, and Disjoint LinUCB stats.
    """
    return engine.get_calendar_payload()


@app.get("/api/proactive/pending", tags=["Proactive Photon Outreach"])
async def get_pending_proactive_prompts(
    include_resolved: bool = Query(False, description="Include already resolved prompts"),
):
    """
    Returns queued `OutboundPrompt` messages for the Photon service to text the user.
    """
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
    """
    Advances simulated time or triggers a proactive event immediately for a live hackathon demo.
    """
    req = payload or SimulateTickRequest()
    cur_dt = _parse_iso(engine.state.current_time)

    if req.simulated_time:
        cur_dt = _parse_iso(req.simulated_time)
    elif req.advance_minutes is not None:
        cur_dt = cur_dt + timedelta(minutes=int(req.advance_minutes))
    else:
        # Default tick: advance 15 minutes or jump 10 minutes into the next scheduled block
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
    """
    Processes an incoming Photon text, messy multi-entity brain-dump, routine mention,
    or session rating. Updates `LearnedUserRhythm` + `LinUCB`, schedules split study blocks,
    and returns the conversational SMS reply.
    """
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
    """
    Truncates a scheduled or in-progress study block, updates `LearnedUserRhythm` and `LinUCB`
    (lowering late-night probability if cut short due to fatigue), and redistributes
    the unfinished spillover minutes to future high-UCB slots before the deadline.
    """
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
    """
    Switches between the 3 live hackathon presentation presets:
    - `"blank_canvas"` (or `"cold_start"`): 0 events, triggers proactive brain-dump request.
    - `"day_3_calibrating"` (or `"calibrating"`): Classes & split assignments from text conversation, wide ±1.2★ bounds probing photos.
    - `"day_21_optimized"` (or `"personalized"`): Learned Night-Owl / Library Persona, tight ±0.2★ bounds, environment-optimized schedule.
    """
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


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("BACKEND_PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
