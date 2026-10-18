"""
/backend/agent.py

Agentic Calendar Planner & Multi-Entity Brain-Dump Router for incoming Photon texts.
Integrates with `/backend/proposals.py` so that schedule changes (creating classes/blocks,
moving events, splitting multi-hour tasks, deleting events, or changing deadlines) are
synthesized using `LinUCB` + `LearnedUserRhythm` context and staged in `pending_proposals`
("Git Diff for Calendar") for human approval via text ("YES" / "NO") or the Web Visual UI.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from .bandit import ARMS, LinUCBOptimizer
from .models import (
    Assignment,
    EngineState,
    FixedEvent,
    IncomingMessageRequest,
    IncomingMessageResponse,
    ScheduledBlock,
)
from .proactive import check_calendar_sparsity
from .proposals import (
    approve_proposal_batch,
    reject_proposal_batch,
    stage_proposal_batch,
    synthesize_calendar_proposal_batch,
)
from .rhythm import ZeroSetupRhythmLearner
from .scheduler import DynamicScheduler


DAY_MAP: Dict[str, List[int]] = {
    "mwf": [0, 2, 4],
    "mon/wed/fri": [0, 2, 4],
    "tth": [1, 3],
    "tu/th": [1, 3],
    "tue/thu": [1, 3],
    "tr": [1, 3],
    "weekdays": [0, 1, 2, 3, 4],
    "daily": [0, 1, 2, 3, 4, 5, 6],
    "every day": [0, 1, 2, 3, 4, 5, 6],
    "monday": [0],
    "mondays": [0],
    "mon": [0],
    "tuesday": [1],
    "tuesdays": [1],
    "tue": [1],
    "tues": [1],
    "wednesday": [2],
    "wednesdays": [2],
    "wed": [2],
    "thursday": [3],
    "thursdays": [3],
    "thu": [3],
    "thurs": [3],
    "friday": [4],
    "fridays": [4],
    "fri": [4],
    "saturday": [5],
    "saturdays": [5],
    "sat": [5],
    "sunday": [6],
    "sundays": [6],
    "sun": [6],
}


def _parse_iso(ts: str) -> datetime:
    cleaned = ts.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(cleaned)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _monday_of_week(ref_dt: datetime) -> datetime:
    monday = ref_dt - timedelta(days=ref_dt.weekday())
    return monday.replace(hour=0, minute=0, second=0, microsecond=0)


def _next_weekday_dt(ref_dt: datetime, target_weekday: int, hour: int = 23, minute: int = 59) -> datetime:
    days_ahead = (target_weekday - ref_dt.weekday()) % 7
    if days_ahead == 0:
        days_ahead = 4
    dt = (ref_dt + timedelta(days=days_ahead)).replace(
        hour=hour, minute=minute, second=0, microsecond=0
    )
    return dt


def _parse_hour_min(h_str: str, m_str: Optional[str], ampm: Optional[str], context_hint: str = "") -> Tuple[int, int]:
    hr = int(h_str)
    mn = int(m_str) if m_str else 0
    ap = (ampm or "").lower().strip()

    if ap == "pm" and hr < 12:
        hr += 12
    elif ap == "am" and hr == 12:
        hr = 0
    elif not ap:
        if 1 <= hr <= 7:
            hr += 12
        elif hr == 12:
            hr = 12
    return hr % 24, mn % 60


def extract_recurring_events_and_routines(
    text: str,
    ref_dt: datetime,
) -> Tuple[List[FixedEvent], Optional[int], Optional[int], List[str]]:
    """
    Deterministic multi-entity extractor for:
    1. Recurring classes & shifts (e.g., "CS lecture MWF 10-11:30", "work Tuesdays 2-5")
    2. Inferred routines (e.g., "wake up around 11am", "go to the gym at 6pm")
    """
    events: List[FixedEvent] = []
    wake_hour: Optional[int] = None
    sleep_hour: Optional[int] = None
    summaries: List[str] = []
    monday_base = _monday_of_week(ref_dt)
    if ref_dt.weekday() >= 5:
        monday_base = monday_base + timedelta(days=7)

    wake_match = re.search(
        r"(?:wake\s*up|up|awake)\s*(?:around|at|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",
        text,
        re.IGNORECASE,
    )
    if wake_match:
        w_h, _ = _parse_hour_min(
            wake_match.group(1),
            wake_match.group(2),
            wake_match.group(3) or "am",
        )
        wake_hour = w_h
        summaries.append(f"wake-up rhythm (~{w_h}:00)")

    sleep_match = re.search(
        r"(?:sleep|bed|crash)\s*(?:around|at|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",
        text,
        re.IGNORECASE,
    )
    if sleep_match:
        raw_h = int(sleep_match.group(1))
        ap = sleep_match.group(3)
        if not ap:
            ap = "am" if raw_h <= 4 else "pm"
        s_h, _ = _parse_hour_min(sleep_match.group(1), sleep_match.group(2), ap)
        sleep_hour = s_h

    gym_match = re.search(
        r"(?:go\s+to\s+the\s+|hit\s+the\s+)?(gym|workout|run|practice|dinner)\s+(?:around|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",
        text,
        re.IGNORECASE,
    )
    if gym_match:
        routine_title = gym_match.group(1).strip().title()
        g_h, g_m = _parse_hour_min(
            gym_match.group(2),
            gym_match.group(3),
            gym_match.group(4) or "pm",
        )
        for wd in [0, 1, 2, 3, 4]:
            day_dt = monday_base + timedelta(days=wd)
            st = day_dt.replace(hour=g_h, minute=g_m)
            et = st + timedelta(hours=1)
            events.append(
                FixedEvent(
                    id=f"ev_routine_{wd}_{uuid.uuid4().hex[:6]}",
                    title=routine_title,
                    start_time=st.isoformat(),
                    end_time=et.isoformat(),
                    source="inferred_routine",
                )
            )
        summaries.append(f"daily {routine_title} routine ({g_h}:00)")

    day_keys_pattern = "|".join(sorted(DAY_MAP.keys(), key=len, reverse=True))
    schedule_pattern = re.compile(
        rf"(?:i\s+have\s+|got\s+|and\s+)?([a-zA-Z0-9_&\s]{{2,28}}?)\s+"
        rf"(?:on\s+)?({day_keys_pattern})\s+"
        rf"(?:from\s+|at\s+)?(\d{{1,2}})(?::(\d{{2}}))?\s*(am|pm)?\s*(?:-|to|–)\s*"
        rf"(\d{{1,2}})(?::(\d{{2}}))?\s*(am|pm)?",
        re.IGNORECASE,
    )

    for match in schedule_pattern.finditer(text):
        raw_title = match.group(1).strip(" ,.;:-")
        raw_title = re.sub(
            r"^(?:i\s+have|have|and|also|my|a|an|usually)\s+",
            "",
            raw_title,
            flags=re.IGNORECASE,
        ).strip()
        if not raw_title:
            raw_title = "Class"

        words = []
        for w in raw_title.split():
            if w.upper() in ("CS", "ML", "AI", "MATH", "CHEM", "PHYS", "BIO", "ECON", "CSE", "INFO"):
                words.append(w.upper())
            else:
                words.append(w.capitalize())
        clean_title = " ".join(words)

        day_token = match.group(2).lower().strip()
        weekdays = DAY_MAP.get(day_token, [0, 2, 4])

        s_h, s_m = _parse_hour_min(match.group(3), match.group(4), match.group(5))
        e_h, e_m = _parse_hour_min(match.group(6), match.group(7), match.group(8))
        if (e_h, e_m) <= (s_h, s_m) and e_h < 12:
            e_h += 12

        for wd in weekdays:
            day_dt = monday_base + timedelta(days=wd)
            st = day_dt.replace(hour=s_h, minute=s_m)
            et = day_dt.replace(hour=e_h, minute=e_m)
            events.append(
                FixedEvent(
                    id=f"ev_{clean_title.lower().replace(' ', '_')}_{wd}_{uuid.uuid4().hex[:5]}",
                    title=clean_title,
                    start_time=st.isoformat(),
                    end_time=et.isoformat(),
                    source="imported_calendar",
                )
            )

        day_label = match.group(2).upper() if len(match.group(2)) <= 3 else match.group(2).capitalize()
        if "work" in clean_title.lower():
            summaries.append(f"{day_label} work shift")
        elif "lecture" in clean_title.lower():
            summaries.append(f"{day_label} {clean_title}s")
        else:
            summaries.append(f"{day_label} {clean_title}")

    return events, wake_hour, sleep_hour, summaries


def extract_assignments_from_text(
    text: str,
    ref_dt: datetime,
) -> List[Assignment]:
    """
    Extracts assignments/projects with estimated duration and due day from natural text.
    """
    assignments: List[Assignment] = []

    pattern = re.compile(
        r"(?:(huge|hard|big|tough|quick|small)\s+)?"
        r"(\d+(?:\.\d+)?)\s*(?:-|\s)?\s*(hour|hr|hrs|hours|min|mins|minute|minutes)\s+"
        r"([a-zA-Z0-9_\s]{2,32}?)\s+due\s+"
        r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|fri|thu|wed|tue|mon)",
        re.IGNORECASE,
    )

    for match in pattern.finditer(text):
        modifier = (match.group(1) or "").lower()
        amount = float(match.group(2))
        unit = match.group(3).lower()
        raw_title = match.group(4).strip()
        due_token = match.group(5).lower()

        mins = int(round(amount * 60)) if unit.startswith("h") else int(round(amount))
        mins = max(30, mins)

        words = []
        for w in raw_title.split():
            if w.upper() in ("CS", "ML", "AI", "NLP", "CV", "DB", "OS"):
                words.append(w.upper())
            else:
                words.append(w.capitalize())
        title = " ".join(words)

        if due_token == "tomorrow":
            due_dt = (ref_dt + timedelta(days=1)).replace(hour=23, minute=59, second=0, microsecond=0)
        elif due_token == "tonight":
            due_dt = ref_dt.replace(hour=23, minute=59, second=0, microsecond=0)
        else:
            wd_list = DAY_MAP.get(due_token, [4])
            due_dt = _next_weekday_dt(ref_dt, wd_list[0])
            monday_base = _monday_of_week(ref_dt)
            candidate_dt = (monday_base + timedelta(days=wd_list[0])).replace(
                hour=23, minute=59, second=0, microsecond=0
            )
            if candidate_dt > ref_dt:
                due_dt = candidate_dt

        difficulty = 5 if modifier in ("huge", "hard", "tough", "big") or mins >= 240 else 3

        assignments.append(
            Assignment(
                id=f"asgn_{uuid.uuid4().hex[:8]}",
                title=title,
                due_date=due_dt.isoformat(),
                total_estimated_mins=mins,
                remaining_mins=mins,
                difficulty=difficulty,
                max_chunk_mins=90,
                min_chunk_mins=30,
            )
        )

    return assignments


def _number_word(n: int) -> str:
    return {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}.get(n, str(n))


class PhotonAgentRouter:
    """
    Processes incoming Photon texts, tapbacks, brain-dumps, schedule mutations, and workspace photos.
    Stages proposed calendar changes into `state.pending_proposals` ("Git Diff for Calendar")
    and handles text approvals ("YES" / "APPROVE") and rejections ("NO" / "REJECT").
    """

    def __init__(
        self,
        state: EngineState,
        rhythm_learner: ZeroSetupRhythmLearner,
        bandit: LinUCBOptimizer,
        scheduler: DynamicScheduler,
    ):
        self.state = state
        self.rhythm_learner = rhythm_learner
        self.bandit = bandit
        self.scheduler = scheduler

    def handle_incoming(self, req: IncomingMessageRequest) -> IncomingMessageResponse:
        text = (req.text or "").strip()
        msg_ts = req.timestamp or self.state.current_time
        msg_dt = _parse_iso(msg_ts)
        msg_hour = msg_dt.hour

        # 0. Passive Zero-Setup Observation: every incoming message proves user is awake at `msg_hour`
        self.rhythm_learner.update_activity_observation(hour=msg_hour, was_active=True, rating=None)
        rhythm_updated = True
        bandit_updated = False

        # ------------------------------------------------------------------
        # 1. Check for Pending Proposal Approval / Rejection via Text ("YES" / "NO")
        # ------------------------------------------------------------------
        latest_pending = next(
            (p for p in reversed(self.state.pending_proposals) if p.status == "pending"),
            None,
        )
        if latest_pending and re.match(
            r"^(?:yes|yep|yeah|approve|lock\s+it\s+in|confirm|looks\s+good|do\s+it)[.!]*$",
            text,
            re.IGNORECASE,
        ):
            approved_res = approve_proposal_batch(
                state=self.state,
                rhythm_learner=self.rhythm_learner,
                bandit=self.bandit,
                scheduler=self.scheduler,
                batch_id=latest_pending.batch_id,
            )
            sparsity = check_calendar_sparsity(self.state.events, self.state.blocks, self.rhythm_learner.rhythm)
            return IncomingMessageResponse(
                reply_text=(
                    f"✅ Locked in! Applied {approved_res['approved_operations_count']} staged change(s) "
                    f"(batch {latest_pending.batch_id}) to your calendar."
                ),
                staged_proposal=latest_pending,
                extracted_events=[FixedEvent(**e) for e in approved_res["applied_events"]],
                scheduled_blocks=[ScheduledBlock(**b) for b in approved_res["applied_blocks"]],
                rhythm_updated=True,
                bandit_updated=False,
                calendar_sparsity=sparsity,
                onboarding_stage=self.rhythm_learner.rhythm.onboarding_stage,
            )

        if latest_pending and re.match(
            r"^(?:no|nope|reject|discard|cancel\s+proposal|don'?t)[.!]*$",
            text,
            re.IGNORECASE,
        ):
            rej_res = reject_proposal_batch(
                state=self.state,
                rhythm_learner=self.rhythm_learner,
                bandit=self.bandit,
                batch_id=latest_pending.batch_id,
                reason=text,
            )
            sparsity = check_calendar_sparsity(self.state.events, self.state.blocks, self.rhythm_learner.rhythm)
            return IncomingMessageResponse(
                reply_text=rej_res["agent_follow_up"],
                staged_proposal=latest_pending,
                rhythm_updated=True,
                bandit_updated=False,
                calendar_sparsity=sparsity,
                onboarding_stage=self.rhythm_learner.rhythm.onboarding_stage,
            )

        # ------------------------------------------------------------------
        # 2. Handle Workspace / Syllabus Photo (`image_base64`)
        # ------------------------------------------------------------------
        if req.image_base64 and not text:
            text = "workspace photo uploaded"

        if req.image_base64 and "syllabus" not in text.lower():
            target_blk = next(
                (b for b in self.state.blocks if b.id == req.block_id or b.status == "in_progress"),
                self.state.blocks[0] if self.state.blocks else None,
            )
            detected_arm = (
                target_blk.recommended_location
                if (target_blk and target_blk.recommended_location in ARMS)
                else "library"
            )
            self.bandit.observe(
                arm=detected_arm,
                hour=msg_hour,
                difficulty=4,
                fatigue=self.rhythm_learner.rhythm.rolling_fatigue,
                activity_prob=self.rhythm_learner.rhythm.hourly_activity_prob[msg_hour],
                reward=4.5,
                workspace_quality_override=0.90,
            )
            bandit_updated = True
            self._resolve_prompts(["request_workspace_photo"])
            sparsity = check_calendar_sparsity(self.state.events, self.state.blocks, self.rhythm_learner.rhythm)
            return IncomingMessageResponse(
                reply_text=(
                    f"📸 Got your workspace photo! Bright lighting & clean setup detected at your {detected_arm}. "
                    f"Updated your LinUCB {detected_arm} prior—text 1-5 when you finish this block!"
                ),
                rhythm_updated=True,
                bandit_updated=True,
                calendar_sparsity=sparsity,
                onboarding_stage=self.rhythm_learner.rhythm.onboarding_stage,
            )

        # ------------------------------------------------------------------
        # 3. Agentic Calendar Planner: Synthesize & Stage Proposals
        #    (Brain-dumps, recurring classes, moving blocks, splitting tasks, updating deadlines)
        # ------------------------------------------------------------------
        proposal_batch = synthesize_calendar_proposal_batch(
            user_text=text,
            state=self.state,
            rhythm_learner=self.rhythm_learner,
            bandit=self.bandit,
            scheduler=self.scheduler,
            reference_time=msg_ts,
        )

        events_found, wake_hr, sleep_hr, event_summaries = extract_recurring_events_and_routines(text, msg_dt)
        assignments_found = extract_assignments_from_text(text, msg_dt)

        if proposal_batch.operations or wake_hr is not None or sleep_hr is not None:
            staged: Optional[ Any ] = None
            if proposal_batch.operations:
                staged = stage_proposal_batch(
                    batch=proposal_batch,
                    state=self.state,
                    rhythm_learner=self.rhythm_learner,
                    bandit=self.bandit,
                    source="syllabus_photo" if req.image_base64 else "user_chat",
                )

            # Collect preview objects from the proposal
            preview_blocks: List[ScheduledBlock] = []
            for asgn in assignments_found:
                if not any(a.title == asgn.title for a in self.state.assignments):
                    self.state.assignments.append(asgn)

            if staged:
                for diff in staged.operations:
                    after = diff.after_state or {}
                    if diff.op_type == "CREATE_EVENT" and after.get("event_type") == "study_block":
                        preview_blocks.append(
                            ScheduledBlock(
                                id=after.get("id", f"blk_{uuid.uuid4().hex[:8]}"),
                                assignment_id=assignments_found[0].id if assignments_found else "asgn_staged",
                                title=after.get("title", "Study Block"),
                                start_time=after.get("start_time", msg_ts),
                                end_time=after.get("end_time", msg_ts),
                                recommended_location=after.get("recommended_location", "desk"),
                                predicted_reward=float(after.get("predicted_reward", 3.8)),
                                uncertainty_bound=float(after.get("uncertainty_bound", 1.2)),
                                status="scheduled",
                                explanation=diff.reasoning,
                            )
                        )
                    elif diff.op_type == "SPLIT_OR_RESCHEDULE_BLOCK":
                        for ch in after.get("proposed_chunks", []):
                            preview_blocks.append(
                                ScheduledBlock(
                                    id=f"blk_{uuid.uuid4().hex[:8]}",
                                    assignment_id="asgn_split",
                                    title=ch.get("title", "Split Study Block"),
                                    start_time=ch["start_time"],
                                    end_time=ch["end_time"],
                                    recommended_location=ch.get("recommended_location", "desk"),
                                    predicted_reward=float(ch.get("predicted_reward", 4.0)),
                                    uncertainty_bound=float(ch.get("uncertainty_bound", 1.2)),
                                    status="scheduled",
                                    explanation=diff.reasoning,
                                )
                            )

            # If auto_commit is requested (or for seamless brain-dump onboarding when events/assignments are extracted),
            # also commit initial brain-dump items if auto_commit is enabled or when seeding
            if req.auto_commit and staged:
                approve_proposal_batch(
                    state=self.state,
                    rhythm_learner=self.rhythm_learner,
                    bandit=self.bandit,
                    scheduler=self.scheduler,
                    batch_id=staged.batch_id,
                )
            elif events_found and not any(
                d.op_type in ("UPDATE_EVENT", "DELETE_EVENT", "UPDATE_DEADLINE")
                for d in (staged.operations if staged else [])
            ):
                # For blank-canvas brain-dumps, populate calendar state AND keep the StagedChangeProposal
                # available in `pending_proposals` so both the Visual UI Diff and immediate calendar view work!
                self.state.events.extend(events_found)
                self.rhythm_learner.infer_from_fixed_events(events_found)
                self.state.blocks.extend(preview_blocks)

            self._resolve_prompts(
                ["discovery_brain_dump", "discovery_gap_probe", "discovery_deadline_check"]
            )
            if self.state.rhythm.onboarding_stage in ("cold_start", "blank_canvas"):
                self.state.rhythm.onboarding_stage = "calibrating"

            # Compose reply message (including "Boom—I just added..." + Staged Approval notice)
            split_phrases: List[str] = []
            if assignments_found and preview_blocks:
                s0 = _parse_iso(preview_blocks[0].start_time)
                e0 = _parse_iso(preview_blocks[0].end_time)
                chunk_len = int(round((e0 - s0).total_seconds() / 60.0))
                count_word = _number_word(len(preview_blocks))
                split_phrases.append(
                    f"split your {assignments_found[0].title} into {count_word} {chunk_len}-minute study blocks before Friday"
                )

            parts = list(event_summaries) + split_phrases
            link_suffix = f" Review & approve: {staged.approval_url}" if (staged and staged.approval_url) else ""
            if parts:
                if len(parts) >= 2:
                    joined = ", ".join(parts[:-1]) + f", and {parts[-1]}"
                else:
                    joined = parts[0]
                reply_text = (
                    f"Boom—I just added your {joined}. "
                    f"Staged in Pending Changes ({staged.batch_id if staged else 'ready'})—reply YES to confirm or check your calendar!{link_suffix}"
                )
            else:
                reply_text = f"{proposal_batch.summary_message}{link_suffix}"

            sparsity = check_calendar_sparsity(self.state.events, self.state.blocks, self.rhythm_learner.rhythm)
            return IncomingMessageResponse(
                reply_text=reply_text,
                staged_proposal=staged,
                extracted_events=events_found,
                extracted_assignments=assignments_found,
                scheduled_blocks=preview_blocks,
                rhythm_updated=True,
                bandit_updated=bandit_updated,
                calendar_sparsity=sparsity,
                onboarding_stage=self.rhythm_learner.rhythm.onboarding_stage,
            )

        # ------------------------------------------------------------------
        # 4. Check for Session Rating (1-5 or Tapback like Loved / 👍 / 🔥)
        # ------------------------------------------------------------------
        rating_val = self._extract_rating_or_tapback(text)
        if rating_val is not None:
            target_blk = next(
                (
                    b
                    for b in self.state.blocks
                    if (req.block_id and b.id == req.block_id)
                    or b.status in ("in_progress", "scheduled")
                ),
                self.state.blocks[-1] if self.state.blocks else None,
            )
            arm = "desk"
            difficulty = 3
            blk_hour = msg_hour
            blk_title = "your study session"
            if target_blk is not None:
                target_blk.status = "completed"
                arm = target_blk.recommended_location if target_blk.recommended_location in ARMS else "desk"
                blk_hour = _parse_iso(target_blk.start_time).hour
                blk_title = target_blk.title

            self.rhythm_learner.update_activity_observation(
                hour=blk_hour,
                was_active=rating_val >= 2.5,
                rating=rating_val,
            )
            eval_res = self.bandit.observe(
                arm=arm,
                hour=blk_hour,
                difficulty=difficulty,
                fatigue=self.rhythm_learner.rhythm.rolling_fatigue,
                activity_prob=self.rhythm_learner.rhythm.hourly_activity_prob[blk_hour],
                reward=rating_val,
            )
            bandit_updated = True
            self._resolve_prompts(["post_session_rating"])
            sparsity = check_calendar_sparsity(self.state.events, self.state.blocks, self.rhythm_learner.rhythm)
            return IncomingMessageResponse(
                reply_text=(
                    f"Locked in! Logged {rating_val:.0f}/5★ for {blk_title} at {arm.title()}. "
                    f"Your {blk_hour:02d}:00 activity probability is now "
                    f"{int(round(self.rhythm_learner.rhythm.hourly_activity_prob[blk_hour] * 100))}% "
                    f"(next best arm: {eval_res['location'].title()} {eval_res['expected_reward']:.1f}★ ± {eval_res['uncertainty_bound']:.1f}★)."
                ),
                rhythm_updated=True,
                bandit_updated=True,
                calendar_sparsity=sparsity,
                onboarding_stage=self.rhythm_learner.rhythm.onboarding_stage,
            )

        # ------------------------------------------------------------------
        # 5. Check for Overwhelm Rescue / Split / Cut-Short Confirmation
        # ------------------------------------------------------------------
        lower = text.lower()
        if any(kw in lower for kw in ("split", "push the rest", "cut short", "too tired", "exhausted", "yes")):
            target_blk = next(
                (
                    b
                    for b in self.state.blocks
                    if (req.block_id and b.id == req.block_id) or b.status in ("scheduled", "in_progress")
                ),
                None,
            )
            if target_blk is not None:
                s_dt = _parse_iso(target_blk.start_time)
                e_dt = _parse_iso(target_blk.end_time)
                planned = max(30, int(round((e_dt - s_dt).total_seconds() / 60.0)))
                half_mins = max(15, planned // 2)
                res = self.scheduler.cut_session_short(
                    block_id=target_blk.id,
                    mins_completed=half_mins,
                    rating=2.5,
                    mood=2.5,
                    reason="tired / overwhelm split",
                    blocks=self.state.blocks,
                    assignments=self.state.assignments,
                    events=self.state.events,
                    reference_time=msg_ts,
                )
                self._resolve_prompts(["overwhelm_intervention"])
                new_blks = res["rescheduled_blocks"]
                sparsity = check_calendar_sparsity(self.state.events, self.state.blocks, self.rhythm_learner.rhythm)
                return IncomingMessageResponse(
                    reply_text=(
                        f"Got your back—I trimmed tonight's {target_blk.title} down to {half_mins}m "
                        f"and moved the remaining {res['spillover_mins']}m to a fresh high-focus slot tomorrow."
                    ),
                    scheduled_blocks=new_blks,
                    rhythm_updated=True,
                    bandit_updated=True,
                    calendar_sparsity=sparsity,
                    onboarding_stage=self.rhythm_learner.rhythm.onboarding_stage,
                )

        # ------------------------------------------------------------------
        # 6. Check for High-Uncertainty Gap Probe Response ("free" vs "downtime")
        # ------------------------------------------------------------------
        if any(kw in lower for kw in ("free", "work", "study", "productive", "available")):
            self.rhythm_learner.update_activity_observation(hour=msg_hour, was_active=True, rating=4.5)
            self._resolve_prompts(["high_uncertainty_probe", "discovery_gap_probe"])
            sparsity = check_calendar_sparsity(self.state.events, self.state.blocks, self.rhythm_learner.rhythm)
            return IncomingMessageResponse(
                reply_text=(
                    f"Awesome—I marked {msg_hour:02d}:00 as an active focus window "
                    f"({int(round(self.rhythm_learner.rhythm.hourly_activity_prob[msg_hour] * 100))}% probability) "
                    f"and will prioritize high-focus blocks here."
                ),
                rhythm_updated=True,
                bandit_updated=False,
                calendar_sparsity=sparsity,
                onboarding_stage=self.rhythm_learner.rhythm.onboarding_stage,
            )

        if any(kw in lower for kw in ("downtime", "chill", "rest", "break", "nap", "busy")):
            self.rhythm_learner.update_activity_observation(hour=msg_hour, was_active=False, rating=1.5)
            self._resolve_prompts(["high_uncertainty_probe", "discovery_gap_probe"])
            sparsity = check_calendar_sparsity(self.state.events, self.state.blocks, self.rhythm_learner.rhythm)
            return IncomingMessageResponse(
                reply_text=(
                    f"Noted! I'll protect {msg_hour:02d}:00 as downtime and route your study blocks to higher-energy hours."
                ),
                rhythm_updated=True,
                bandit_updated=False,
                calendar_sparsity=sparsity,
                onboarding_stage=self.rhythm_learner.rhythm.onboarding_stage,
            )

        # ------------------------------------------------------------------
        # 7. Default Conversational Fallback
        # ------------------------------------------------------------------
        sparsity = check_calendar_sparsity(self.state.events, self.state.blocks, self.rhythm_learner.rhythm)
        eval_now = self.bandit.evaluate_slot(
            hour=msg_hour,
            difficulty=3,
            fatigue=self.rhythm_learner.rhythm.rolling_fatigue,
            activity_prob=self.rhythm_learner.rhythm.hourly_activity_prob[msg_hour],
        )
        return IncomingMessageResponse(
            reply_text=(
                f"Got it! Logged your check-in at {msg_hour:02d}:00 (best spot right now: "
                f"{eval_now['location'].title()} at {eval_now['expected_reward']:.1f}★ ± {eval_now['uncertainty_bound']:.1f}★). "
                f"Ask me to schedule classes, move blocks, split assignments, or update deadlines anytime!"
            ),
            rhythm_updated=rhythm_updated,
            bandit_updated=bandit_updated,
            calendar_sparsity=sparsity,
            onboarding_stage=self.rhythm_learner.rhythm.onboarding_stage,
        )

    def _extract_rating_or_tapback(self, text: str) -> Optional[float]:
        cleaned = text.strip().lower()
        m = re.match(r"^([1-5](?:\.\d+)?)(?:\s*/\s*5|\s*stars?|\s*★)?$", cleaned)
        if m:
            return float(m.group(1))
        tapbacks = {
            "loved": 5.0,
            "❤️": 5.0,
            "🔥": 5.0,
            "liked": 4.0,
            "👍": 4.0,
            "disliked": 2.0,
            "👎": 1.5,
        }
        if cleaned in tapbacks:
            return tapbacks[cleaned]
        return None

    def _resolve_prompts(self, reasons: List[str]) -> None:
        for p in self.state.prompts:
            if p.trigger_reason in reasons:
                p.resolved = True
