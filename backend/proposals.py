"""
/backend/proposals.py

Agentic Calendar Planner + Staged Approval Engine ("Git Diff for Calendar").

Responsibilities:
1. Gives the LLM (Grok / Gemini, with a deterministic synthesis fallback) full freedom to propose:
   - `CREATE_EVENT` (classes, study blocks, routines, personal events, recurring schedules)
   - `UPDATE_EVENT` (moving times, changing titles, switching study locations)
   - `SPLIT_OR_RESCHEDULE_BLOCK` (splitting multi-hour tasks or pushing unfinished chunks across days)
   - `DELETE_EVENT` (removing canceled events or study blocks)
   - `UPDATE_DEADLINE` (shifting assignment due dates and auto-rebalancing study blocks)
2. Passes `LearnedUserRhythm` (24h active probability curve) and `LinUCBOptimizer` top-scoring
   (time, location) insights into the planner's context window as guidance—NOT handcuffs.
3. Enriches proposed blocks with LinUCB `predicted_reward` and `uncertainty_bound`, and runs a
   lightweight deterministic validator ONLY to attach non-blocking `has_conflict`, `conflict_with`,
   and `exceeds_daily_cap` flags plus `veyzl_audit`.
4. Stages all mutations as `StagedChangeProposal` records (`status="pending"`) with full
   `before_state` and `after_state` snapshots so Photon SMS ("Reply YES to lock this in")
   or the Web Visual UI can diff, partially approve, fully approve, or reject changes before mutating state.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from .bandit import ARMS, LinUCBOptimizer
from .models import (
    Assignment,
    CalendarProposalBatch,
    CalendarProposalToolItem,
    EngineState,
    FixedEvent,
    LocationArm,
    ProposalSource,
    ProposedOperationDiff,
    RemainingChunkSpec,
    ScheduledBlock,
    StagedChangeProposal,
    VeyzlAudit,
)
from .rhythm import ZeroSetupRhythmLearner
from .scheduler import DynamicScheduler, _overlaps, _parse_iso

logger = logging.getLogger("backend.proposals")

DAY_NAME_TO_WEEKDAY: Dict[str, int] = {
    "monday": 0,
    "mon": 0,
    "m": 0,
    "tuesday": 1,
    "tues": 1,
    "tue": 1,
    "t": 1,
    "wednesday": 2,
    "wed": 2,
    "w": 2,
    "thursday": 3,
    "thurs": 3,
    "thu": 3,
    "th": 3,
    "r": 3,
    "friday": 4,
    "fri": 4,
    "f": 4,
    "saturday": 5,
    "sat": 5,
    "sunday": 6,
    "sun": 6,
}

# JSON Schema for LLM Structured Output (`CalendarProposalBatch`)
CALENDAR_PROPOSAL_BATCH_JSON_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary_message": {
            "type": "string",
            "description": "Conversational summary explaining the proposed schedule changes and asking for approval",
        },
        "operations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "op_type": {
                        "type": "string",
                        "enum": [
                            "CREATE_EVENT",
                            "UPDATE_EVENT",
                            "SPLIT_OR_RESCHEDULE_BLOCK",
                            "DELETE_EVENT",
                            "UPDATE_DEADLINE",
                        ],
                    },
                    "title": {"type": ["string", "null"]},
                    "start_time": {"type": ["string", "null"]},
                    "end_time": {"type": ["string", "null"]},
                    "event_type": {
                        "type": ["string", "null"],
                        "enum": ["class", "study_block", "routine", "personal", None],
                    },
                    "location": {
                        "type": ["string", "null"],
                        "enum": ["library", "desk", "cafe", "bed", "unknown", None],
                    },
                    "recurring_days": {
                        "type": ["array", "null"],
                        "items": {"type": "string"},
                    },
                    "target_event_id": {"type": ["string", "null"]},
                    "new_title": {"type": ["string", "null"]},
                    "new_start_time": {"type": ["string", "null"]},
                    "new_end_time": {"type": ["string", "null"]},
                    "new_location": {
                        "type": ["string", "null"],
                        "enum": ["library", "desk", "cafe", "bed", "unknown", None],
                    },
                    "target_block_id": {"type": ["string", "null"]},
                    "completed_mins": {"type": ["integer", "null"]},
                    "remaining_chunks": {
                        "type": ["array", "null"],
                        "items": {
                            "type": "object",
                            "properties": {
                                "start_time": {"type": "string"},
                                "end_time": {"type": "string"},
                                "location": {
                                    "type": "string",
                                    "enum": ["library", "desk", "cafe", "bed", "unknown"],
                                },
                            },
                            "required": ["start_time", "end_time", "location"],
                            "additionalProperties": False,
                        },
                    },
                    "assignment_id_or_title": {"type": ["string", "null"]},
                    "new_due_date": {"type": ["string", "null"]},
                    "auto_rebalance_blocks": {"type": ["boolean", "null"]},
                    "reasoning": {"type": "string"},
                },
                "required": ["op_type", "reasoning"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary_message", "operations"],
    "additionalProperties": False,
}


def _build_planner_context_prompt(
    state: EngineState,
    rhythm_learner: ZeroSetupRhythmLearner,
    bandit: LinUCBOptimizer,
) -> str:
    """
    Formats the user's current calendar snapshot, 24h LearnedUserRhythm curve,
    and top LinUCB (time, location) insights as rich context for the LLM planner.
    """
    top_slots = []
    for hr in range(24):
        prob = rhythm_learner.rhythm.hourly_activity_prob[hr]
        ev = bandit.evaluate_slot(
            hour=hr,
            difficulty=4,
            fatigue=rhythm_learner.rhythm.rolling_fatigue,
            activity_prob=prob,
        )
        top_slots.append(
            {
                "hour": f"{hr:02d}:00",
                "activity_prob": round(prob, 2),
                "best_location": ev["location"],
                "expected_reward": ev["expected_reward"],
                "uncertainty_bound": ev["uncertainty_bound"],
                "ucb_score": ev["ucb_score"],
            }
        )
    top_slots_sorted = sorted(top_slots, key=lambda s: -s["ucb_score"])[:8]

    context_obj = {
        "current_time": state.current_time,
        "rolling_fatigue": rhythm_learner.rhythm.rolling_fatigue,
        "onboarding_stage": rhythm_learner.rhythm.onboarding_stage,
        "top_linucb_windows": top_slots_sorted,
        "hourly_activity_prob": {
            f"{h:02d}:00": round(rhythm_learner.rhythm.hourly_activity_prob[h], 2)
            for h in range(24)
        },
        "existing_events": [e.model_dump() for e in state.events[:25]],
        "existing_blocks": [b.model_dump() for b in state.blocks[:25]],
        "existing_assignments": [a.model_dump() for a in state.assignments[:15]],
    }
    return json.dumps(context_obj, indent=2)


def _try_llm_proposal_generation(
    user_text: str,
    state: EngineState,
    rhythm_learner: ZeroSetupRhythmLearner,
    bandit: LinUCBOptimizer,
) -> Optional[CalendarProposalBatch]:
    """
    Calls Grok (`XAI_API_KEY`) or Gemini (`GEMINI_API_KEY`) if configured in `.env`
    to synthesize a `CalendarProposalBatch` using LinUCB & Rhythm context.
    Returns None if offline or if no LLM key is configured so the deterministic
    synthesis planner can seamlessly generate the proposal batch.
    """
    if os.getenv("DISABLE_LIVE_LLM_PLANNER") == "1":
        return None

    xai_key = (os.getenv("XAI_API_KEY") or "").strip()
    gemini_key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not xai_key and not gemini_key:
        return None

    system_prompt = (
        "You are an Agentic AI Calendar Planner with full authority to propose creating events, "
        "building recurring schedules, moving or renaming blocks, splitting multi-hour study tasks across days, "
        "and updating assignment deadlines.\n"
        "Use the provided 24-hour LearnedUserRhythm curve and Disjoint LinUCB (time, location) scores "
        "as context to pick optimal study times and locations ('library', 'desk', 'cafe', 'bed').\n"
        "Every mutation you output will be placed into a Staged Approval Queue ('Git Diff for Calendar') "
        "for the user to review and approve. Return strictly valid JSON matching CalendarProposalBatch."
    )
    context_str = _build_planner_context_prompt(state, rhythm_learner, bandit)
    user_payload = f"CALENDAR & LINUCB CONTEXT:\n{context_str}\n\nUSER REQUEST:\n{user_text}"

    try:
        if xai_key:
            body = {
                "model": os.getenv("XAI_MODEL", "grok-4.7"),
                "store": False,
                "instructions": system_prompt,
                "input": user_payload,
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": "calendar_proposal_batch",
                        "strict": True,
                        "schema": CALENDAR_PROPOSAL_BATCH_JSON_SCHEMA,
                    }
                },
            }
            req = urllib.request.Request(
                "https://api.x.ai/v1/responses",
                data=json.dumps(body).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {xai_key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=12.0) as resp:
                resp_data = json.loads(resp.read().decode("utf-8"))
                out_text = (
                    "".join(
                        part.get("text", "")
                        for item in resp_data.get("output", [])
                        if item.get("type") == "message"
                        for part in item.get("content", [])
                        if part.get("type") == "output_text"
                    ).strip()
                )
                if out_text:
                    parsed = json.loads(out_text)
                    if parsed.get("operations"):
                        return CalendarProposalBatch(**parsed)
    except Exception as e:
        logger.info("LLM planner fallback to deterministic synthesis (%s)", e)

    return None


def _resolve_day_date(ref_dt: datetime, day_str: str) -> datetime:
    cleaned = day_str.lower().strip()
    monday = (ref_dt - timedelta(days=ref_dt.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    if cleaned == "today" or cleaned == "tonight":
        return ref_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    if cleaned == "tomorrow":
        return (ref_dt + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    wd = DAY_NAME_TO_WEEKDAY.get(cleaned)
    if wd is not None:
        candidate = monday + timedelta(days=wd)
        if candidate.date() < ref_dt.date():
            candidate += timedelta(days=7)
        return candidate
    return (ref_dt + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def synthesize_calendar_proposal_batch(
    user_text: str,
    state: EngineState,
    rhythm_learner: ZeroSetupRhythmLearner,
    bandit: LinUCBOptimizer,
    scheduler: DynamicScheduler,
    reference_time: Optional[str] = None,
) -> CalendarProposalBatch:
    """
    Hybrid LLM + Deterministic Agentic Calendar Planner.
    Synthesizes complex multi-intent natural language requests such as:
      "I have CS lecture MWF 10-11:30, push my stats study block to tomorrow night,
       and split my 3-hour paper across Wednesday and Thursday"
    into a structured `CalendarProposalBatch` using `LinUCB` and `LearnedUserRhythm`.
    """
    # 1. Try live LLM tool synthesis if configured and enabled
    llm_batch = _try_llm_proposal_generation(user_text, state, rhythm_learner, bandit)
    if llm_batch and llm_batch.operations:
        return llm_batch

    from .agent import extract_assignments_from_text, extract_recurring_events_and_routines, _parse_hour_min

    ref_iso = reference_time or state.current_time
    ref_dt = _parse_iso(ref_iso)
    operations: List[CalendarProposalToolItem] = []
    summary_parts: List[str] = []

    # ------------------------------------------------------------------
    # A. Recurring Classes, Work Shifts & Routines -> `CREATE_EVENT`
    # ------------------------------------------------------------------
    recurring_events, wake_hr, sleep_hr, ev_summaries = extract_recurring_events_and_routines(
        user_text, ref_dt
    )
    if wake_hr is not None or sleep_hr is not None:
        rhythm_learner.apply_inferred_wake_time(
            wake_hour=wake_hr if wake_hr is not None else 10,
            sleep_hour=sleep_hr,
        )

    # Group recurring events or emit individual CREATE_EVENT operations
    for ev in recurring_events:
        ev_type = "routine" if ev.source == "inferred_routine" else "class"
        operations.append(
            CalendarProposalToolItem(
                op_type="CREATE_EVENT",
                title=ev.title,
                start_time=ev.start_time,
                end_time=ev.end_time,
                event_type=ev_type,
                location="unknown",
                reasoning=f"Extracted {ev.source.replace('_', ' ')} '{ev.title}' from your message.",
            )
        )
    if ev_summaries:
        summary_parts.extend(ev_summaries)

    # ------------------------------------------------------------------
    # B. Explicit Move / Push / Update Existing Block or Event -> `UPDATE_EVENT`
    #    e.g., "push my stats study block to tomorrow night"
    #          "move my ML Project block to Thursday at 8pm"
    # ------------------------------------------------------------------
    move_pattern = re.compile(
        r"(?:push|move|reschedule|shift)\s+(?:my\s+|the\s+|tonight'?s\s+)?([a-zA-Z0-9_\s]{2,30}?)\s+"
        r"(?:study\s+block\s+|block\s+|session\s+|event\s+)?to\s+"
        r"(tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
        r"(?:\s+(morning|afternoon|evening|night)|\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?",
        re.IGNORECASE,
    )
    for m in move_pattern.finditer(user_text):
        target_name = m.group(1).strip()
        day_word = m.group(2).strip()
        time_of_day = (m.group(3) or "").lower().strip()
        explicit_h = m.group(4)
        explicit_m = m.group(5)
        explicit_ap = m.group(6)

        target_date = _resolve_day_date(ref_dt, day_word)

        # Pick best hour in that window using LinUCB + Rhythm if no explicit hour was given
        if explicit_h:
            new_h, new_m = _parse_hour_min(explicit_h, explicit_m, explicit_ap)
        elif time_of_day == "morning":
            new_h, new_m = 10, 0
        elif time_of_day == "afternoon":
            new_h, new_m = 14, 0
        elif time_of_day in ("night", "evening"):
            # Pick best evening/night hour (20..23) from LinUCB
            best_night_h = max(
                [20, 21, 22, 23],
                key=lambda h: bandit.evaluate_slot(
                    h, 3, rhythm_learner.rhythm.rolling_fatigue, rhythm_learner.rhythm.hourly_activity_prob[h]
                )["ucb_score"],
            )
            new_h, new_m = best_night_h, 0
        else:
            new_h, new_m = 19, 0

        # Find matching existing block or event (or synthesize target ID if none exists yet)
        matched_blk = next(
            (b for b in state.blocks if target_name.lower() in b.title.lower() or target_name.lower() in b.id.lower()),
            state.blocks[0] if state.blocks else None,
        )
        matched_ev = next(
            (e for e in state.events if target_name.lower() in e.title.lower() or target_name.lower() in e.id.lower()),
            None,
        )

        duration_mins = 60
        target_id = f"blk_{target_name.lower().replace(' ', '_')[:10]}"
        resolved_title = f"{target_name.title()} Study Block"

        if matched_blk:
            target_id = matched_blk.id
            resolved_title = matched_blk.title
            old_s = _parse_iso(matched_blk.start_time)
            old_e = _parse_iso(matched_blk.end_time)
            duration_mins = max(30, int(round((old_e - old_s).total_seconds() / 60.0)))
        elif matched_ev:
            target_id = matched_ev.id
            resolved_title = matched_ev.title
            old_s = _parse_iso(matched_ev.start_time)
            old_e = _parse_iso(matched_ev.end_time)
            duration_mins = max(30, int(round((old_e - old_s).total_seconds() / 60.0)))

        new_start_dt = target_date.replace(hour=new_h, minute=new_m)
        new_end_dt = new_start_dt + timedelta(minutes=duration_mins)
        slot_eval = bandit.evaluate_slot(
            hour=new_h,
            difficulty=3,
            fatigue=rhythm_learner.rhythm.rolling_fatigue,
            activity_prob=rhythm_learner.rhythm.hourly_activity_prob[new_h],
        )

        operations.append(
            CalendarProposalToolItem(
                op_type="UPDATE_EVENT",
                target_event_id=target_id,
                new_title=resolved_title,
                new_start_time=new_start_dt.isoformat(),
                new_end_time=new_end_dt.isoformat(),
                new_location=slot_eval["location"],
                reasoning=(
                    f"Moved '{resolved_title}' to {day_word.capitalize()} at {new_h:02d}:{new_m:02d} "
                    f"({slot_eval['location'].title()}, LinUCB {slot_eval['expected_reward']:.1f}★ ± {slot_eval['uncertainty_bound']:.1f}★)."
                ),
            )
        )
        summary_parts.append(f"move {resolved_title} to {day_word} at {new_h:02d}:{new_m:02d}")

    # ------------------------------------------------------------------
    # C. Split / Distribute Task Across Specific Days -> `SPLIT_OR_RESCHEDULE_BLOCK`
    #    e.g., "split my 3-hour paper across Wednesday and Thursday"
    #          "split tonight's block in half and push the rest to tomorrow"
    # ------------------------------------------------------------------
    split_across_pattern = re.compile(
        r"split\s+(?:my\s+|the\s+|a\s+)?(?:(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(hour|hr|hrs|hours|min|mins)\s+)?"
        r"([a-zA-Z0-9_\s]{2,28}?)\s+(?:across|between|over)\s+"
        r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow)\s+and\s+"
        r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow)",
        re.IGNORECASE,
    )
    for m in split_across_pattern.finditer(user_text):
        amt_str = m.group(1)
        unit_str = (m.group(2) or "hour").lower()
        task_title = m.group(3).strip().title()
        day_1_str = m.group(4).strip()
        day_2_str = m.group(5).strip()

        total_mins = (
            int(round(float(amt_str) * 60))
            if (amt_str and unit_str.startswith("h"))
            else (int(round(float(amt_str))) if amt_str else 120)
        )
        half_mins = max(30, total_mins // 2)

        chunks: List[RemainingChunkSpec] = []
        for d_str in (day_1_str, day_2_str):
            d_dt = _resolve_day_date(ref_dt, d_str)
            # Pick best high-UCB hour on that day (e.g. 11:00 or 22:00)
            best_h = max(
                [10, 11, 13, 19, 21, 22],
                key=lambda h: bandit.evaluate_slot(
                    h, 4, rhythm_learner.rhythm.rolling_fatigue, rhythm_learner.rhythm.hourly_activity_prob[h]
                )["ucb_score"]
                * rhythm_learner.is_hour_schedulable(h),
            )
            ev_slot = bandit.evaluate_slot(
                best_h, 4, rhythm_learner.rhythm.rolling_fatigue, rhythm_learner.rhythm.hourly_activity_prob[best_h]
            )
            c_start = d_dt.replace(hour=best_h, minute=0)
            c_end = c_start + timedelta(minutes=half_mins)
            chunks.append(
                RemainingChunkSpec(
                    start_time=c_start.isoformat(),
                    end_time=c_end.isoformat(),
                    location=ev_slot["location"],
                    predicted_reward=ev_slot["expected_reward"],
                    uncertainty_bound=ev_slot["uncertainty_bound"],
                )
            )

        matched_blk = next(
            (b for b in state.blocks if task_title.lower() in b.title.lower()),
            None,
        )
        target_blk_id = matched_blk.id if matched_blk else f"blk_{task_title.lower().replace(' ', '_')[:10]}"

        operations.append(
            CalendarProposalToolItem(
                op_type="SPLIT_OR_RESCHEDULE_BLOCK",
                title=task_title,
                target_block_id=target_blk_id,
                completed_mins=0,
                remaining_chunks=chunks,
                reasoning=(
                    f"Split {total_mins}m '{task_title}' into two {half_mins}m LinUCB-optimized blocks across "
                    f"{day_1_str.capitalize()} and {day_2_str.capitalize()}."
                ),
            )
        )
        summary_parts.append(
            f"split your {task_title} into two {half_mins}-minute blocks across {day_1_str.capitalize()} and {day_2_str.capitalize()}"
        )

    # ------------------------------------------------------------------
    # D. Delete / Cancel Event -> `DELETE_EVENT`
    #    e.g., "cancel my Tuesday work shift" or "delete CS lecture"
    # ------------------------------------------------------------------
    del_pattern = re.compile(
        r"(?:delete|remove|cancel|drop)\s+(?:my\s+|the\s+)?([a-zA-Z0-9_\s]{3,32})",
        re.IGNORECASE,
    )
    for m in del_pattern.finditer(user_text):
        phrase = m.group(1).strip(" .,!?").lower()
        target_obj = next(
            (e for e in state.events if e.title.lower() in phrase or phrase in e.title.lower() or e.id.lower() == phrase),
            None,
        ) or next(
            (b for b in state.blocks if b.title.lower() in phrase or phrase in b.title.lower() or b.id.lower() == phrase),
            None,
        )
        t_id = target_obj.id if target_obj else f"ev_{phrase.replace(' ', '_')[:12]}"
        t_title = target_obj.title if target_obj else phrase.title()
        operations.append(
            CalendarProposalToolItem(
                op_type="DELETE_EVENT",
                target_event_id=t_id,
                title=t_title,
                reasoning=f"Requested removal of '{t_title}'.",
            )
        )
        summary_parts.append(f"remove {t_title}")

    # ------------------------------------------------------------------
    # E. Update Deadline -> `UPDATE_DEADLINE`
    #    e.g., "extend my ML project deadline to Sunday" / "change deadline for ML Project to Monday"
    # ------------------------------------------------------------------
    deadline_pattern = re.compile(
        r"(?:extend|change|move|update|push)\s+(?:my\s+|the\s+)?([a-zA-Z0-9_\s]{2,28}?)\s+"
        r"(?:deadline|due\s+date)\s+to\s+"
        r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)",
        re.IGNORECASE,
    )
    for m in deadline_pattern.finditer(user_text):
        asgn_title = m.group(1).strip()
        due_day = m.group(2).strip()
        new_due_dt = _resolve_day_date(ref_dt, due_day).replace(hour=23, minute=59)
        operations.append(
            CalendarProposalToolItem(
                op_type="UPDATE_DEADLINE",
                assignment_id_or_title=asgn_title,
                new_due_date=new_due_dt.isoformat(),
                auto_rebalance_blocks=True,
                reasoning=f"Updated deadline for '{asgn_title}' to {due_day.capitalize()} and rebalanced study blocks.",
            )
        )
        summary_parts.append(f"move {asgn_title} deadline to {due_day.capitalize()}")

    # ------------------------------------------------------------------
    # F. Assignments with Due Date -> Proposed `CREATE_EVENT` (study_block) chunks
    #    e.g., "a huge 5-hour ML project due Friday"
    # ------------------------------------------------------------------
    assignments_found = extract_assignments_from_text(user_text, ref_dt)
    simulated_events = list(state.events) + recurring_events
    simulated_blocks = list(state.blocks)
    for asgn in assignments_found:
        proposed_blocks = scheduler.schedule_or_split_assignment(
            assignment=asgn,
            events=simulated_events,
            existing_blocks=simulated_blocks,
            reference_time=ref_iso,
        )
        simulated_blocks.extend(proposed_blocks)
        for blk in proposed_blocks:
            operations.append(
                CalendarProposalToolItem(
                    op_type="CREATE_EVENT",
                    title=blk.title,
                    start_time=blk.start_time,
                    end_time=blk.end_time,
                    event_type="study_block",
                    location=blk.recommended_location,
                    reasoning=blk.explanation,
                )
            )
        if proposed_blocks:
            s0 = _parse_iso(proposed_blocks[0].start_time)
            e0 = _parse_iso(proposed_blocks[0].end_time)
            chunk_m = int(round((e0 - s0).total_seconds() / 60.0))
            count_w = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}.get(
                len(proposed_blocks), str(len(proposed_blocks))
            )
            summary_parts.append(
                f"split your {asgn.title} into {count_w} {chunk_m}-minute study blocks before Friday"
            )

    if summary_parts:
        if len(summary_parts) >= 2:
            joined = ", ".join(summary_parts[:-1]) + f", and {summary_parts[-1]}"
        else:
            joined = summary_parts[0]
        summary_msg = (
            f"I've drafted a calendar update to add/adjust your {joined}. "
            f"Review the staged changes or reply YES to lock them into your calendar!"
        )
    else:
        summary_msg = "No calendar mutations were detected in that message."

    return CalendarProposalBatch(summary_message=summary_msg, operations=operations)


def stage_proposal_batch(
    batch: CalendarProposalBatch,
    state: EngineState,
    rhythm_learner: ZeroSetupRhythmLearner,
    bandit: LinUCBOptimizer,
    source: ProposalSource = "user_chat",
) -> StagedChangeProposal:
    """
    Converts a `CalendarProposalBatch` into a `StagedChangeProposal` ("Git Diff for Calendar"):
    - Populates `before_state` and `after_state` for each operation so a Visual UI can render red/green diffs.
    - Enriches study blocks with LinUCB `predicted_reward` and `uncertainty_bound`.
    - Runs lightweight deterministic collision & Veyzl daily burnout checks, attaching
      non-blocking flags (`has_conflict`, `conflict_with`, `exceeds_daily_cap`) and `veyzl_audit`.
    - Appends the staged batch (`status="pending"`) to `state.pending_proposals`.
    """
    batch_id = f"batch_{uuid.uuid4().hex[:8]}"
    proposal_id = f"prop_{uuid.uuid4().hex[:8]}"
    now_iso = state.current_time or datetime.now(timezone.utc).isoformat()

    # Build lookup of existing occupied windows for non-blocking collision detection
    existing_intervals: List[Tuple[str, str, datetime, datetime]] = []
    for ev in state.events:
        try:
            existing_intervals.append((ev.id, ev.title, _parse_iso(ev.start_time), _parse_iso(ev.end_time)))
        except Exception:
            continue
    for blk in state.blocks:
        if blk.status in ("scheduled", "in_progress"):
            try:
                existing_intervals.append((blk.id, blk.title, _parse_iso(blk.start_time), _parse_iso(blk.end_time)))
            except Exception:
                continue

    # Track daily study minutes to flag `exceeds_daily_cap` (> 240 mins/day or rolling_fatigue > 0.80)
    daily_study_mins: Dict[str, int] = {}
    for blk in state.blocks:
        if blk.status in ("scheduled", "in_progress"):
            try:
                s = _parse_iso(blk.start_time)
                e = _parse_iso(blk.end_time)
                d_key = s.strftime("%Y-%m-%d")
                daily_study_mins[d_key] = daily_study_mins.get(d_key, 0) + int((e - s).total_seconds() / 60)
            except Exception:
                continue

    diffs: List[ProposedOperationDiff] = []

    def _check_window_collision(
        cand_s: datetime, cand_e: datetime, ignore_id: Optional[str] = None
    ) -> Tuple[bool, Optional[str]]:
        for item_id, item_title, occ_s, occ_e in existing_intervals:
            if ignore_id and item_id == ignore_id:
                continue
            if _overlaps(cand_s, cand_e, occ_s, occ_e):
                return True, f"{item_title} ({item_id})"
        return False, None

    for item in batch.operations:
        op_id = f"op_{uuid.uuid4().hex[:8]}"
        before_state: Optional[Dict[str, Any]] = None
        after_state: Optional[Dict[str, Any]] = None
        has_conflict = False
        conflict_with: Optional[str] = None
        exceeds_cap = False

        if item.op_type == "CREATE_EVENT":
            s_dt = _parse_iso(item.start_time) if item.start_time else _parse_iso(now_iso)
            e_dt = _parse_iso(item.end_time) if item.end_time else (s_dt + timedelta(minutes=60))
            dur_mins = max(15, int(round((e_dt - s_dt).total_seconds() / 60.0)))
            hr = s_dt.hour

            slot_eval = bandit.evaluate_slot(
                hour=hr,
                difficulty=4 if item.event_type == "study_block" else 3,
                fatigue=rhythm_learner.rhythm.rolling_fatigue,
                activity_prob=rhythm_learner.rhythm.hourly_activity_prob[hr],
            )
            loc: LocationArm = (
                item.location
                if (item.location and item.location != "unknown")
                else slot_eval["location"]
            )
            has_conflict, conflict_with = _check_window_collision(s_dt, e_dt)

            if item.event_type == "study_block":
                d_key = s_dt.strftime("%Y-%m-%d")
                daily_study_mins[d_key] = daily_study_mins.get(d_key, 0) + dur_mins
                exceeds_cap = daily_study_mins[d_key] > 240 or rhythm_learner.rhythm.rolling_fatigue > 0.80

            after_state = {
                "id": f"staged_{op_id}",
                "title": item.title or "Scheduled Event",
                "start_time": s_dt.isoformat(),
                "end_time": e_dt.isoformat(),
                "event_type": item.event_type or "study_block",
                "recommended_location": loc,
                "predicted_reward": slot_eval["expected_reward"],
                "uncertainty_bound": slot_eval["uncertainty_bound"],
                "ucb_score": slot_eval["ucb_score"],
                "recurring_days": item.recurring_days,
            }
            existing_intervals.append((after_state["id"], after_state["title"], s_dt, e_dt))

        elif item.op_type == "UPDATE_EVENT":
            target_id = item.target_event_id or ""
            existing_blk = next((b for b in state.blocks if b.id == target_id), None)
            existing_ev = next((e for e in state.events if e.id == target_id), None)

            if existing_blk:
                before_state = existing_blk.model_dump()
            elif existing_ev:
                before_state = existing_ev.model_dump()
            else:
                before_state = {"id": target_id, "title": item.new_title or "Existing Block"}

            new_s_str = item.new_start_time or (before_state.get("start_time") if before_state else now_iso)
            new_e_str = item.new_end_time or (before_state.get("end_time") if before_state else now_iso)
            s_dt = _parse_iso(new_s_str)
            e_dt = _parse_iso(new_e_str)
            hr = s_dt.hour
            slot_eval = bandit.evaluate_slot(
                hour=hr,
                difficulty=3,
                fatigue=rhythm_learner.rhythm.rolling_fatigue,
                activity_prob=rhythm_learner.rhythm.hourly_activity_prob[hr],
            )
            has_conflict, conflict_with = _check_window_collision(s_dt, e_dt, ignore_id=target_id)
            after_state = {
                **(before_state or {}),
                "title": item.new_title or (before_state.get("title") if before_state else "Updated Event"),
                "start_time": s_dt.isoformat(),
                "end_time": e_dt.isoformat(),
                "recommended_location": item.new_location or slot_eval["location"],
                "predicted_reward": slot_eval["expected_reward"],
                "uncertainty_bound": slot_eval["uncertainty_bound"],
            }

        elif item.op_type == "SPLIT_OR_RESCHEDULE_BLOCK":
            target_id = item.target_block_id or ""
            existing_blk = next((b for b in state.blocks if b.id == target_id), None)
            if existing_blk:
                before_state = existing_blk.model_dump()
            else:
                before_state = {"id": target_id, "title": item.title or "Target Study Block"}

            enriched_chunks = []
            for idx, ch in enumerate(item.remaining_chunks or []):
                cs_dt = _parse_iso(ch.start_time)
                ce_dt = _parse_iso(ch.end_time)
                c_eval = bandit.evaluate_slot(
                    hour=cs_dt.hour,
                    difficulty=4,
                    fatigue=rhythm_learner.rhythm.rolling_fatigue,
                    activity_prob=rhythm_learner.rhythm.hourly_activity_prob[cs_dt.hour],
                )
                c_conflict, c_with = _check_window_collision(cs_dt, ce_dt, ignore_id=target_id)
                if c_conflict:
                    has_conflict = True
                    conflict_with = c_with
                d_key = cs_dt.strftime("%Y-%m-%d")
                dur_m = max(15, int(round((ce_dt - cs_dt).total_seconds() / 60.0)))
                daily_study_mins[d_key] = daily_study_mins.get(d_key, 0) + dur_m
                if daily_study_mins[d_key] > 240:
                    exceeds_cap = True

                enriched_chunks.append(
                    {
                        "part": idx + 1,
                        "title": f"{item.title or before_state.get('title', 'Study Block')} (Part {idx + 1}/{len(item.remaining_chunks or [])})",
                        "start_time": cs_dt.isoformat(),
                        "end_time": ce_dt.isoformat(),
                        "recommended_location": ch.location if ch.location != "unknown" else c_eval["location"],
                        "predicted_reward": ch.predicted_reward or c_eval["expected_reward"],
                        "uncertainty_bound": ch.uncertainty_bound or c_eval["uncertainty_bound"],
                    }
                )
            after_state = {
                "target_block_id": target_id,
                "completed_mins": item.completed_mins or 0,
                "proposed_chunks": enriched_chunks,
            }

        elif item.op_type == "DELETE_EVENT":
            target_id = item.target_event_id or ""
            existing_blk = next((b for b in state.blocks if b.id == target_id), None)
            existing_ev = next((e for e in state.events if e.id == target_id), None)
            if existing_blk:
                before_state = existing_blk.model_dump()
            elif existing_ev:
                before_state = existing_ev.model_dump()
            else:
                before_state = {"id": target_id, "title": item.title or "Event to Delete"}
            after_state = None

        elif item.op_type == "UPDATE_DEADLINE":
            key = (item.assignment_id_or_title or "").lower()
            existing_asgn = next(
                (a for a in state.assignments if a.id.lower() == key or key in a.title.lower()),
                None,
            )
            if existing_asgn:
                before_state = existing_asgn.model_dump()
            else:
                before_state = {"title": item.assignment_id_or_title or "Assignment"}
            after_state = {
                **(before_state or {}),
                "due_date": item.new_due_date,
                "auto_rebalance_blocks": bool(item.auto_rebalance_blocks),
            }

        diffs.append(
            ProposedOperationDiff(
                proposal_id=op_id,
                op_type=item.op_type,
                reasoning=item.reasoning,
                before_state=before_state,
                after_state=after_state,
                raw_operation=item,
                has_conflict=has_conflict,
                conflict_with=conflict_with,
                exceeds_daily_cap=exceeds_cap,
                status="pending",
            )
        )

    audit = VeyzlAudit(
        conflict_free=not any(d.has_conflict for d in diffs),
        burnout_safe=not any(d.exceeds_daily_cap for d in diffs),
        requires_human_approval=True,
    )

    frontend_base = os.getenv("FRONTEND_URL", f"http://localhost:{os.getenv('PORT', '3000')}").rstrip("/")
    approval_url = f"{frontend_base}/approve/{batch_id}"

    staged = StagedChangeProposal(
        proposal_id=proposal_id,
        batch_id=batch_id,
        created_at=now_iso,
        source=source,
        summary_message=batch.summary_message,
        operations=diffs,
        veyzl_audit=audit,
        status="pending",
        approval_url=approval_url,
    )
    state.pending_proposals.append(staged)
    return staged


def approve_proposal_batch(
    state: EngineState,
    rhythm_learner: ZeroSetupRhythmLearner,
    bandit: LinUCBOptimizer,
    scheduler: DynamicScheduler,
    batch_id: str,
    proposal_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Approves and executes a `StagedChangeProposal` (either the entire batch or a subset of `proposal_ids`).
    Writes the approved operations into live calendar state (`state.events`, `state.blocks`, `state.assignments`).
    """
    target_batch = next(
        (p for p in state.pending_proposals if p.batch_id == batch_id or p.proposal_id == batch_id),
        None,
    )
    if target_batch is None:
        raise ValueError(f"Staged proposal batch '{batch_id}' not found")

    selected_set = set(proposal_ids) if proposal_ids else None
    applied_events: List[FixedEvent] = []
    applied_blocks: List[ScheduledBlock] = []
    deleted_ids: List[str] = []
    approved_ops_count = 0

    for diff in target_batch.operations:
        if diff.status == "approved":
            continue
        if selected_set is not None and diff.proposal_id not in selected_set:
            continue

        raw = diff.raw_operation
        after = diff.after_state or {}

        if diff.op_type == "CREATE_EVENT":
            ev_type = raw.event_type or after.get("event_type", "study_block")
            if ev_type == "study_block":
                blk = ScheduledBlock(
                    id=f"blk_{uuid.uuid4().hex[:8]}",
                    assignment_id=f"asgn_{(raw.title or 'task').lower().replace(' ', '_')[:8]}",
                    title=after.get("title") or raw.title or "Study Block",
                    start_time=after.get("start_time") or raw.start_time or state.current_time,
                    end_time=after.get("end_time") or raw.end_time or state.current_time,
                    recommended_location=after.get("recommended_location", "desk"),
                    predicted_reward=float(after.get("predicted_reward", 3.8)),
                    uncertainty_bound=float(after.get("uncertainty_bound", 0.8)),
                    status="scheduled",
                    explanation=diff.reasoning,
                )
                state.blocks.append(blk)
                applied_blocks.append(blk)
            else:
                src = "inferred_routine" if ev_type == "routine" else "imported_calendar"
                fev = FixedEvent(
                    id=f"ev_{uuid.uuid4().hex[:8]}",
                    title=after.get("title") or raw.title or "Calendar Event",
                    start_time=after.get("start_time") or raw.start_time or state.current_time,
                    end_time=after.get("end_time") or raw.end_time or state.current_time,
                    source=src,
                )
                state.events.append(fev)
                applied_events.append(fev)

        elif diff.op_type == "UPDATE_EVENT":
            t_id = raw.target_event_id or ""
            matched_blk = next((b for b in state.blocks if b.id == t_id), None)
            matched_ev = next((e for e in state.events if e.id == t_id), None)
            if matched_blk:
                if raw.new_title:
                    matched_blk.title = raw.new_title
                if raw.new_start_time:
                    matched_blk.start_time = raw.new_start_time
                if raw.new_end_time:
                    matched_blk.end_time = raw.new_end_time
                if raw.new_location:
                    matched_blk.recommended_location = raw.new_location
                applied_blocks.append(matched_blk)
            elif matched_ev:
                if raw.new_title:
                    matched_ev.title = raw.new_title
                if raw.new_start_time:
                    matched_ev.start_time = raw.new_start_time
                if raw.new_end_time:
                    matched_ev.end_time = raw.new_end_time
                applied_events.append(matched_ev)
            else:
                # Create the moved block if it wasn't on the calendar yet
                blk = ScheduledBlock(
                    id=t_id if t_id.startswith("blk_") else f"blk_{uuid.uuid4().hex[:8]}",
                    assignment_id="asgn_moved",
                    title=after.get("title", "Moved Study Block"),
                    start_time=after.get("start_time", state.current_time),
                    end_time=after.get("end_time", state.current_time),
                    recommended_location=after.get("recommended_location", "desk"),
                    predicted_reward=float(after.get("predicted_reward", 3.8)),
                    uncertainty_bound=float(after.get("uncertainty_bound", 0.8)),
                    status="scheduled",
                    explanation=diff.reasoning,
                )
                state.blocks.append(blk)
                applied_blocks.append(blk)

        elif diff.op_type == "SPLIT_OR_RESCHEDULE_BLOCK":
            t_id = raw.target_block_id or ""
            # Remove or mark old block cut_short if it existed
            for b in state.blocks:
                if b.id == t_id:
                    b.status = "cut_short"
            for ch_dict in after.get("proposed_chunks", []):
                blk = ScheduledBlock(
                    id=f"blk_{uuid.uuid4().hex[:8]}",
                    assignment_id=f"asgn_{t_id}",
                    title=ch_dict.get("title", "Split Study Block"),
                    start_time=ch_dict["start_time"],
                    end_time=ch_dict["end_time"],
                    recommended_location=ch_dict.get("recommended_location", "desk"),
                    predicted_reward=float(ch_dict.get("predicted_reward", 4.0)),
                    uncertainty_bound=float(ch_dict.get("uncertainty_bound", 0.8)),
                    status="scheduled",
                    explanation=diff.reasoning,
                )
                state.blocks.append(blk)
                applied_blocks.append(blk)

        elif diff.op_type == "DELETE_EVENT":
            t_id = raw.target_event_id or ""
            before_title = (diff.before_state or {}).get("title", "").lower()
            state.events = [
                e for e in state.events if e.id != t_id and e.title.lower() != before_title
            ]
            state.blocks = [
                b for b in state.blocks if b.id != t_id and b.title.lower() != before_title
            ]
            deleted_ids.append(t_id)

        elif diff.op_type == "UPDATE_DEADLINE":
            key = (raw.assignment_id_or_title or "").lower()
            matched_asgn = next(
                (a for a in state.assignments if a.id.lower() == key or key in a.title.lower()),
                None,
            )
            if matched_asgn and raw.new_due_date:
                matched_asgn.due_date = raw.new_due_date
                if raw.auto_rebalance_blocks:
                    state.blocks = [b for b in state.blocks if b.assignment_id != matched_asgn.id]
                    rebalanced = scheduler.schedule_or_split_assignment(
                        assignment=matched_asgn,
                        events=state.events,
                        existing_blocks=state.blocks,
                        reference_time=state.current_time,
                    )
                    state.blocks.extend(rebalanced)
                    applied_blocks.extend(rebalanced)

        diff.status = "approved"
        approved_ops_count += 1

    if applied_events:
        rhythm_learner.infer_from_fixed_events(applied_events)

    all_approved = all(d.status == "approved" for d in target_batch.operations)
    target_batch.status = "approved" if all_approved else "modified"

    return {
        "status": target_batch.status,
        "batch_id": target_batch.batch_id,
        "approved_operations_count": approved_ops_count,
        "applied_events": [e.model_dump() for e in applied_events],
        "applied_blocks": [b.model_dump() for b in applied_blocks],
        "deleted_ids": deleted_ids,
        "proposal": target_batch.model_dump(),
    }


def reject_proposal_batch(
    state: EngineState,
    rhythm_learner: ZeroSetupRhythmLearner,
    bandit: LinUCBOptimizer,
    batch_id: str,
    reason: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Discards a staged proposal batch, marks it `"rejected"`, and records a negative preference
    signal so the agent can ask how to adjust.
    """
    target_batch = next(
        (p for p in state.pending_proposals if p.batch_id == batch_id or p.proposal_id == batch_id),
        None,
    )
    if target_batch is None:
        raise ValueError(f"Staged proposal batch '{batch_id}' not found")

    target_batch.status = "rejected"
    target_batch.rejection_feedback = reason or "User rejected staged schedule changes"
    for diff in target_batch.operations:
        if diff.status == "pending":
            diff.status = "rejected"
            # Feed subtle negative signal if a specific study hour was rejected
            if diff.after_state and "start_time" in diff.after_state:
                try:
                    rej_hr = _parse_iso(diff.after_state["start_time"]).hour
                    rhythm_learner.update_activity_observation(rej_hr, was_active=False, rating=2.0, ema_alpha=0.15)
                except Exception:
                    pass

    follow_up = (
        f"No problem—I discarded those staged changes ({len(target_batch.operations)} item(s)). "
        f"What times or study spots would feel better for you?"
    )
    return {
        "status": "rejected",
        "batch_id": target_batch.batch_id,
        "rejection_feedback": target_batch.rejection_feedback,
        "agent_follow_up": follow_up,
        "proposal": target_batch.model_dump(),
    }
