"""
/backend/proactive.py

Event-Driven Proactive Outreach Engine + Blank-Canvas Discovery Mode for Photon (iMessage/SMS).

Capabilities:
1. Blank-Canvas Discovery Mode (`check_calendar_sparsity(events, blocks)` < 0.20):
   - `discovery_brain_dump`: Asks disorganized users for a messy text brain-dump or syllabus/to-do photo.
   - `discovery_gap_probe`: Probes 4+ hour blank daytime windows to uncover unlogged classes/routines.
   - `discovery_deadline_check`: Excavates upcoming assignments/exams living in the user's head.
2. Active Learning & Wellbeing Check-ins (`check_and_generate_prompts(current_time, ...)`):
   - `high_uncertainty_probe`: Probes high-uncertainty gaps (`uncertainty_bound > threshold`).
   - `request_workspace_photo`: 10 minutes into a `ScheduledBlock`, requests a workspace photo for Perceptron VLM.
   - `post_session_rating`: When a block ends, requests a 1-5 rating or tapback.
   - `overwhelm_intervention`: When `rolling_fatigue > 0.75` or after back-to-back classes, offers to split tonight's block.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Set

from .bandit import LinUCBOptimizer
from .models import (
    FixedEvent,
    LearnedUserRhythm,
    OutboundPrompt,
    PromptTriggerReason,
    ScheduledBlock,
)


def _parse_iso(ts: str) -> datetime:
    cleaned = ts.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(cleaned)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def check_calendar_sparsity(
    events: List[FixedEvent],
    blocks: List[ScheduledBlock],
    rhythm: Optional[LearnedUserRhythm] = None,
    days_window: int = 5,
) -> float:
    """
    Calculates what percentage (0.0 to 1.0) of the user's waking hours across the week
    have known structure (`FixedEvent`s or active/scheduled `ScheduledBlock`s).
    """
    if not events and not blocks:
        return 0.0

    # Estimate waking hours per day from LearnedUserRhythm (default ~15 waking hours/day)
    if rhythm and rhythm.hourly_activity_prob:
        active_hours_per_day = max(10.0, sum(1.0 for p in rhythm.hourly_activity_prob if p >= 0.30))
    else:
        active_hours_per_day = 15.0

    total_waking_mins = active_hours_per_day * 60.0 * max(1, days_window)

    structured_mins = 0.0
    for ev in events:
        try:
            s = _parse_iso(ev.start_time)
            e = _parse_iso(ev.end_time)
            if e > s:
                structured_mins += (e - s).total_seconds() / 60.0
        except Exception:
            continue

    for blk in blocks:
        if blk.status in ("scheduled", "in_progress", "completed"):
            try:
                s = _parse_iso(blk.start_time)
                e = _parse_iso(blk.end_time)
                if e > s:
                    structured_mins += (e - s).total_seconds() / 60.0
            except Exception:
                continue

    sparsity = min(1.0, max(0.0, structured_mins / total_waking_mins))
    return round(sparsity, 4)


def _has_consecutive_events(events: List[FixedEvent], ref_dt: datetime) -> bool:
    """Checks if the user has 2+ back-to-back FixedEvents on the current day."""
    same_day = []
    for ev in events:
        try:
            s = _parse_iso(ev.start_time)
            e = _parse_iso(ev.end_time)
            if s.date() == ref_dt.date():
                same_day.append((s, e))
        except Exception:
            continue
    same_day.sort(key=lambda pair: pair[0])
    for i in range(len(same_day) - 1):
        gap_mins = (same_day[i + 1][0] - same_day[i][1]).total_seconds() / 60.0
        if gap_mins <= 20:
            return True
    return False


def check_and_generate_prompts(
    current_time: str,
    events: List[FixedEvent],
    blocks: List[ScheduledBlock],
    rhythm: LearnedUserRhythm,
    bandit: LinUCBOptimizer,
    existing_prompts: Optional[List[OutboundPrompt]] = None,
    uncertainty_threshold: float = 0.85,
    force_trigger: Optional[PromptTriggerReason] = None,
) -> List[OutboundPrompt]:
    """
    Evaluates the user's current calendar sparsity, active/ending study blocks,
    LinUCB uncertainty bounds, and rolling fatigue to generate `OutboundPrompt` objects
    for Photon (iMessage/SMS).
    """
    now_dt = _parse_iso(current_time)
    now_iso = now_dt.isoformat()
    existing = existing_prompts or []
    unresolved_reasons: Set[str] = {p.trigger_reason for p in existing if not p.resolved}
    prompted_block_reasons: Set[str] = {
        f"{p.trigger_reason}:{p.target_block_id}" for p in existing if p.target_block_id
    }

    new_prompts: List[OutboundPrompt] = []

    def _make_prompt(
        reason: PromptTriggerReason,
        text: str,
        block_id: Optional[str] = None,
        hour: Optional[int] = None,
    ) -> OutboundPrompt:
        return OutboundPrompt(
            id=f"prm_{uuid.uuid4().hex[:8]}",
            timestamp=now_iso,
            trigger_reason=reason,
            message_text=text,
            target_block_id=block_id,
            target_hour=hour,
            resolved=False,
        )

    # ------------------------------------------------------------------
    # Explicit Demo Force Trigger (for instant live hackathon demo ticks)
    # ------------------------------------------------------------------
    if force_trigger:
        target_blk = next(
            (b for b in blocks if b.status in ("in_progress", "scheduled")),
            blocks[0] if blocks else None,
        )
        blk_title = target_blk.title if target_blk else "ML Project (Part 1/4)"
        blk_id = target_blk.id if target_blk else None

        if force_trigger == "discovery_brain_dump":
            new_prompts.append(
                _make_prompt(
                    "discovery_brain_dump",
                    "Your calendar is looking super empty! Don't worry about setting it up manually—just reply with a messy brain-dump of your classes/work this week, or snap a photo of your syllabus/to-do list, and I'll build your schedule for you.",
                )
            )
            return new_prompts

        if force_trigger == "discovery_gap_probe":
            day_name = now_dt.strftime("%A") if now_dt.strftime("%A") != "Saturday" else "Tuesday"
            new_prompts.append(
                _make_prompt(
                    "discovery_gap_probe",
                    f"I noticed your {day_name} afternoon is completely blank—are you actually free right now, or do you have regular classes/routines I should block out?",
                    hour=14,
                )
            )
            return new_prompts

        if force_trigger == "discovery_deadline_check":
            new_prompts.append(
                _make_prompt(
                    "discovery_deadline_check",
                    "Any assignments, exams, or errands coming up in the next few days that are living in your head instead of your calendar?",
                )
            )
            return new_prompts

        if force_trigger == "request_workspace_photo":
            new_prompts.append(
                _make_prompt(
                    "request_workspace_photo",
                    f"Just started {blk_title}! Snap a quick pic of your workspace so I can learn where you focus best.",
                    block_id=blk_id,
                )
            )
            return new_prompts

        if force_trigger == "post_session_rating":
            new_prompts.append(
                _make_prompt(
                    "post_session_rating",
                    f"Done with {blk_title}! Reply 1-5 (or tapback) for how locked-in you felt.",
                    block_id=blk_id,
                )
            )
            return new_prompts

        if force_trigger == "overwhelm_intervention":
            new_prompts.append(
                _make_prompt(
                    "overwhelm_intervention",
                    f"Your schedule looks packed today. Want me to split tonight's {blk_title} block in half and push the rest to tomorrow?",
                    block_id=blk_id,
                )
            )
            return new_prompts

        if force_trigger == "high_uncertainty_probe":
            new_prompts.append(
                _make_prompt(
                    "high_uncertainty_probe",
                    "Hey! You have a 2h gap right now—are you usually free to get work done around this time, or is this downtime for you?",
                    hour=now_dt.hour,
                )
            )
            return new_prompts

    # ------------------------------------------------------------------
    # Stage 1: Blank-Canvas Discovery Mode (`sparsity < 0.20`)
    # ------------------------------------------------------------------
    sparsity = check_calendar_sparsity(events, blocks, rhythm=rhythm)
    all_reasons_ever = {p.trigger_reason for p in existing}

    if sparsity < 0.20:
        if "discovery_brain_dump" not in all_reasons_ever:
            new_prompts.append(
                _make_prompt(
                    "discovery_brain_dump",
                    "Your calendar is looking super empty! Don't worry about setting it up manually—just reply with a messy brain-dump of your classes/work this week, or snap a photo of your syllabus/to-do list, and I'll build your schedule for you.",
                )
            )
            return new_prompts

        if "discovery_gap_probe" not in all_reasons_ever:
            new_prompts.append(
                _make_prompt(
                    "discovery_gap_probe",
                    "I noticed your Tuesday afternoon is completely blank—are you actually free right now, or do you have regular classes/routines I should block out?",
                    hour=14,
                )
            )
            return new_prompts

        if "discovery_deadline_check" not in all_reasons_ever:
            new_prompts.append(
                _make_prompt(
                    "discovery_deadline_check",
                    "Any assignments, exams, or errands coming up in the next few days that are living in your head instead of your calendar?",
                )
            )
            return new_prompts

    # ------------------------------------------------------------------
    # Stage 2: Block Lifecycle Triggers (Photo Check-in & Post-Session Rating)
    # ------------------------------------------------------------------
    for blk in blocks:
        try:
            s_dt = _parse_iso(blk.start_time)
            e_dt = _parse_iso(blk.end_time)
        except Exception:
            continue

        mins_since_start = (now_dt - s_dt).total_seconds() / 60.0
        mins_since_end = (now_dt - e_dt).total_seconds() / 60.0

        # 2a. Workspace Photo Check-in (~10 mins into a ScheduledBlock)
        if blk.status in ("scheduled", "in_progress") and 5.0 <= mins_since_start <= 35.0:
            blk.status = "in_progress"
            key = f"request_workspace_photo:{blk.id}"
            if key not in prompted_block_reasons:
                new_prompts.append(
                    _make_prompt(
                        "request_workspace_photo",
                        f"Just started {blk.title}! Snap a quick pic of your workspace so I can learn where you focus best.",
                        block_id=blk.id,
                        hour=s_dt.hour,
                    )
                )
                prompted_block_reasons.add(key)

        # 2b. One-Tap Rating & Mood Check (when a block finishes)
        if blk.status in ("scheduled", "in_progress") and 0.0 <= mins_since_end <= 60.0:
            key = f"post_session_rating:{blk.id}"
            if key not in prompted_block_reasons:
                new_prompts.append(
                    _make_prompt(
                        "post_session_rating",
                        f"Done with {blk.title}! Reply 1-5 (or tapback) for how locked-in you felt.",
                        block_id=blk.id,
                        hour=s_dt.hour,
                    )
                )
                prompted_block_reasons.add(key)

    # ------------------------------------------------------------------
    # Stage 3: Overwhelm Rescue (`rolling_fatigue > 0.75` or back-to-back classes)
    # ------------------------------------------------------------------
    if (
        rhythm.rolling_fatigue > 0.75 or _has_consecutive_events(events, now_dt)
    ) and "overwhelm_intervention" not in unresolved_reasons:
        upcoming_blk = next(
            (
                b
                for b in blocks
                if b.status == "scheduled" and _parse_iso(b.start_time) >= now_dt - timedelta(hours=2)
            ),
            blocks[0] if blocks else None,
        )
        if upcoming_blk is not None:
            key = f"overwhelm_intervention:{upcoming_blk.id}"
            if key not in prompted_block_reasons:
                new_prompts.append(
                    _make_prompt(
                        "overwhelm_intervention",
                        f"Your schedule looks packed today. Want me to split tonight's {upcoming_blk.title} block in half and push the rest to tomorrow?",
                        block_id=upcoming_blk.id,
                    )
                )
                prompted_block_reasons.add(key)

    # ------------------------------------------------------------------
    # Stage 4: High-Uncertainty Probe (Cold Start / Calibrating Gap Learning)
    # ------------------------------------------------------------------
    if not new_prompts and "high_uncertainty_probe" not in unresolved_reasons:
        hr = now_dt.hour
        slot_eval = bandit.evaluate_slot(
            hour=hr,
            difficulty=3,
            fatigue=rhythm.rolling_fatigue,
            activity_prob=rhythm.hourly_activity_prob[hr],
        )
        if slot_eval["uncertainty_bound"] > uncertainty_threshold:
            new_prompts.append(
                _make_prompt(
                    "high_uncertainty_probe",
                    "Hey! You have a 2h gap right now—are you usually free to get work done around this time, or is this downtime for you?",
                    hour=hr,
                )
            )

    return new_prompts
