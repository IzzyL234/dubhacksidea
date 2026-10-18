"""
/backend/models.py

Pydantic schemas for events, assignments, scheduled study blocks,
learned user circadian rhythm, LinUCB contextual bandit state,
proactive outbound Photon prompts, and API request/response payloads.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


# =====================================================================
# Core Domain Models
# =====================================================================

EventSource = Literal["imported_calendar", "inferred_routine"]
LocationArm = Literal["library", "desk", "cafe", "bed", "unknown"]
BlockStatus = Literal["scheduled", "in_progress", "completed", "cut_short"]
OnboardingStage = Literal[
    "cold_start",
    "calibrating",
    "personalized",
    "blank_canvas",
    "day_3_calibrating",
    "day_21_optimized",
]
PromptTriggerReason = Literal[
    "high_uncertainty_probe",
    "request_workspace_photo",
    "post_session_rating",
    "overwhelm_intervention",
    "discovery_brain_dump",
    "discovery_gap_probe",
    "discovery_deadline_check",
]


class FixedEvent(BaseModel):
    id: str = Field(..., description="Unique event identifier")
    title: str = Field(..., description="Event title (e.g., 'CS Lecture', 'Work', 'Gym')")
    start_time: str = Field(..., description="ISO 8601 start timestamp")
    end_time: str = Field(..., description="ISO 8601 end timestamp")
    source: EventSource = Field(
        "imported_calendar",
        description="Origin of the fixed event ('imported_calendar' | 'inferred_routine')",
    )


class Assignment(BaseModel):
    id: str = Field(..., description="Unique assignment/task identifier")
    title: str = Field(..., description="Assignment or project title")
    due_date: str = Field(..., description="ISO 8601 due date timestamp")
    total_estimated_mins: int = Field(..., ge=15, description="Total estimated minutes required")
    remaining_mins: int = Field(..., ge=0, description="Remaining minutes to be scheduled/completed")
    difficulty: int = Field(3, ge=1, le=5, description="Task difficulty rating (1-5)")
    max_chunk_mins: int = Field(90, ge=30, le=240, description="Maximum study block chunk length in minutes")
    min_chunk_mins: int = Field(30, ge=15, le=120, description="Minimum study block chunk length in minutes")


class ScheduledBlock(BaseModel):
    id: str = Field(..., description="Unique scheduled block ID")
    assignment_id: str = Field(..., description="Parent assignment ID")
    title: str = Field(..., description="Block display title (e.g., 'ML Project (Part 1/4)')")
    start_time: str = Field(..., description="ISO 8601 start timestamp")
    end_time: str = Field(..., description="ISO 8601 end timestamp")
    recommended_location: LocationArm = Field(
        "unknown",
        description="LinUCB recommended environment arm ('library' | 'desk' | 'cafe' | 'bed' | 'unknown')",
    )
    predicted_reward: float = Field(
        3.0, ge=1.0, le=5.0, description="Predicted productivity/focus reward (1.0 - 5.0)"
    )
    uncertainty_bound: float = Field(
        1.2, ge=0.0, description="LinUCB confidence interval width (± stars)"
    )
    status: BlockStatus = Field(
        "scheduled",
        description="Lifecycle status ('scheduled' | 'in_progress' | 'completed' | 'cut_short')",
    )
    explanation: str = Field(
        "",
        description="Human-readable explanation of why this slot & location were selected",
    )


class LearnedUserRhythm(BaseModel):
    hourly_activity_prob: List[float] = Field(
        default_factory=lambda: [0.5] * 24,
        min_length=24,
        max_length=24,
        description="24 floats (0.0 to 1.0) representing learned probability user is awake & active at hour 0..23",
    )
    rolling_fatigue: float = Field(
        0.15,
        ge=0.0,
        le=1.0,
        description="Dynamic fatigue (0.0 to 1.0) that increases with consecutive work and decays during rest",
    )
    onboarding_stage: OnboardingStage = Field(
        "cold_start",
        description="Current learning stage ('cold_start' | 'calibrating' | 'personalized')",
    )
    observations_count: int = Field(
        0, ge=0, description="Number of passive or explicit rhythm observations recorded"
    )
    inferred_wake_hour: Optional[int] = Field(
        None, ge=0, le=23, description="Dynamically inferred typical wake hour (if learned)"
    )
    inferred_sleep_hour: Optional[int] = Field(
        None, ge=0, le=23, description="Dynamically inferred typical sleep onset hour (if learned)"
    )


class OutboundPrompt(BaseModel):
    id: str = Field(..., description="Unique outbound prompt ID")
    timestamp: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
        description="ISO 8601 timestamp when prompt was generated",
    )
    trigger_reason: PromptTriggerReason = Field(
        ...,
        description="Reason the proactive engine generated this message",
    )
    message_text: str = Field(..., description="Text message body to send via Photon (iMessage/SMS)")
    target_block_id: Optional[str] = Field(
        None, description="Optional ScheduledBlock ID associated with this prompt"
    )
    target_hour: Optional[int] = Field(
        None, ge=0, le=23, description="Optional hour of day being probed"
    )
    resolved: bool = Field(False, description="Whether the user has responded to or resolved this prompt")


# =====================================================================
# API Request / Response Payloads
# =====================================================================

class SimulateTickRequest(BaseModel):
    simulated_time: Optional[str] = Field(
        None,
        description="Optional ISO 8601 timestamp to advance the engine clock to",
    )
    advance_minutes: Optional[int] = Field(
        None,
        description="Optional minutes to advance from the current engine time",
    )
    force_trigger: Optional[PromptTriggerReason] = Field(
        None,
        description="Optional specific trigger reason to force-generate for live demo",
    )


class IncomingMessageRequest(BaseModel):
    user_id: Optional[str] = Field("default_user", description="User identifier or phone/iMessage handle")
    text: str = Field("", description="Incoming text message from Photon (iMessage/SMS)")
    timestamp: Optional[str] = Field(
        None, description="Optional ISO 8601 timestamp of the incoming message"
    )
    image_base64: Optional[str] = Field(
        None, description="Optional workspace or syllabus photo (base64)"
    )
    block_id: Optional[str] = Field(
        None, description="Optional target ScheduledBlock ID if replying to a specific block prompt"
    )


class IncomingMessageResponse(BaseModel):
    reply_text: str = Field(..., description="Conversational SMS reply to send back via Photon")
    extracted_events: List[FixedEvent] = Field(default_factory=list)
    extracted_assignments: List[Assignment] = Field(default_factory=list)
    scheduled_blocks: List[ScheduledBlock] = Field(default_factory=list)
    rhythm_updated: bool = Field(False)
    bandit_updated: bool = Field(False)
    calendar_sparsity: float = Field(0.0)
    onboarding_stage: str = Field("cold_start")


class CutShortRequest(BaseModel):
    mins_completed: int = Field(..., ge=0, description="Actual minutes completed before cutting short")
    rating: float = Field(2.5, ge=1.0, le=5.0, description="Productivity/focus rating (1-5)")
    mood: Optional[float] = Field(2.5, ge=1.0, le=5.0, description="User mood rating (1-5)")
    reason: Optional[str] = Field(
        "tired",
        description="Reason for cutting short (e.g., 'tired', 'distracted', 'interrupted', 'overwhelmed')",
    )


class DemoStageRequest(BaseModel):
    stage: Literal[
        "blank_canvas",
        "day_3_calibrating",
        "day_21_optimized",
        "cold_start",
        "calibrating",
        "personalized",
    ] = Field(..., description="Target demo preset stage")
    user_id: Optional[str] = Field("default_user", description="Optional user ID to apply the stage to")


class EngineState(BaseModel):
    user_id: str = "default_user"
    demo_stage: str = "blank_canvas"
    current_time: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    events: List[FixedEvent] = Field(default_factory=list)
    assignments: List[Assignment] = Field(default_factory=list)
    blocks: List[ScheduledBlock] = Field(default_factory=list)
    rhythm: LearnedUserRhythm = Field(default_factory=LearnedUserRhythm)
    bandit_state: Dict[str, Any] = Field(default_factory=dict)
    prompts: List[OutboundPrompt] = Field(default_factory=list)
    workspace_quality_by_arm: Dict[str, float] = Field(
        default_factory=lambda: {
            "library": 0.85,
            "desk": 0.78,
            "cafe": 0.62,
            "bed": 0.25,
        }
    )
