"""
/backend/scheduler.py

24-Hour Dynamic Task Splitter & Slot Allocator with NO hardcoded 8:00 AM - 11:00 PM bounds.
- Scans all 30-minute intervals across the 24-hour day that do not conflict with `FixedEvent`s.
- Scores slots by combining `LinUCB.ucb_score` with `rhythm.hourly_activity_prob`.
- Splits `Assignment.remaining_mins` into balanced chunks (30m to 90m) that minimize overwhelm.
- Simulates dynamic `rolling_fatigue` across each day so study blocks are naturally spaced out.
- Handles `cut_session_short`: updates `LinUCB` + `LearnedUserRhythm` and redistributes unfinished spillover minutes.
"""

from __future__ import annotations

import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from .bandit import LinUCBOptimizer
from .models import Assignment, FixedEvent, LearnedUserRhythm, ScheduledBlock
from .rhythm import ZeroSetupRhythmLearner


def _parse_iso(ts: str) -> datetime:
    cleaned = ts.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(cleaned)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _to_iso(dt: datetime) -> str:
    return dt.isoformat()


def _align_to_next_half_hour(dt: datetime) -> datetime:
    base = dt.replace(second=0, microsecond=0)
    if base.minute == 0 or base.minute == 30:
        return base
    if base.minute < 30:
        return base.replace(minute=30)
    return (base + timedelta(hours=1)).replace(minute=0)


def _overlaps(start_a: datetime, end_a: datetime, start_b: datetime, end_b: datetime) -> bool:
    return start_a < end_b and end_a > start_b


def compute_balanced_chunks(
    remaining_mins: int,
    min_chunk_mins: int = 30,
    max_chunk_mins: int = 90,
) -> List[int]:
    """
    Splits `remaining_mins` into balanced chunks within `[min_chunk_mins, max_chunk_mins]`.
    For example:
      - 300 mins (5h ML project) with max_chunk=90 -> 4 chunks of 75 mins (`[75, 75, 75, 75]`)
      - 120 mins -> 2 chunks of 60 mins (`[60, 60]`)
      - 45 mins -> 1 chunk of 45 mins (`[45]`)
    """
    total = max(0, int(remaining_mins))
    if total == 0:
        return []
    if total <= max_chunk_mins:
        return [max(min_chunk_mins, total)]

    num_chunks = math.ceil(total / float(max_chunk_mins))
    base_size = total // num_chunks
    remainder = total % num_chunks

    # Round to nearest 5-minute increment while keeping sum == total
    chunks = []
    for i in range(num_chunks):
        c = base_size + (1 if i < remainder else 0)
        chunks.append(max(min_chunk_mins, min(max_chunk_mins, c)))
    return chunks


class DynamicScheduler:
    """
    24-Hour Dynamic Task Splitter & Slot Allocator.
    """

    def __init__(
        self,
        rhythm_learner: ZeroSetupRhythmLearner,
        bandit: LinUCBOptimizer,
    ):
        self.rhythm_learner = rhythm_learner
        self.bandit = bandit

    def schedule_or_split_assignment(
        self,
        assignment: Assignment,
        events: List[FixedEvent],
        existing_blocks: List[ScheduledBlock],
        reference_time: Optional[str] = None,
    ) -> List[ScheduledBlock]:
        """
        Splits `assignment.remaining_mins` into chunks (`30m` to `90m`) and places them into
        optimal 24-hour slots before `assignment.due_date` without hardcoding 8am-11pm bounds.
        Respects dynamic fatigue so multiple blocks on the same day are naturally spaced apart.
        """
        if assignment.remaining_mins <= 0:
            return []

        now_dt = _parse_iso(reference_time) if reference_time else datetime.now(timezone.utc)
        start_scan_dt = _align_to_next_half_hour(now_dt + timedelta(minutes=30))
        due_dt = _parse_iso(assignment.due_date)
        if due_dt <= start_scan_dt:
            due_dt = start_scan_dt + timedelta(days=4)

        chunk_durations = compute_balanced_chunks(
            assignment.remaining_mins,
            min_chunk_mins=assignment.min_chunk_mins,
            max_chunk_mins=assignment.max_chunk_mins,
        )
        total_parts = len(chunk_durations)

        # Build occupied intervals from FixedEvents and active/scheduled blocks (with 15m buffer)
        occupied: List[Tuple[datetime, datetime]] = []
        for ev in events:
            try:
                occupied.append((_parse_iso(ev.start_time), _parse_iso(ev.end_time)))
            except Exception:
                continue
        for blk in existing_blocks:
            if blk.status in ("scheduled", "in_progress"):
                try:
                    occupied.append((_parse_iso(blk.start_time), _parse_iso(blk.end_time)))
                except Exception:
                    continue

        # Track simulated fatigue and scheduled minutes per calendar date so chunks spread out naturally
        daily_fatigue_bonus: Dict[str, float] = {}
        daily_chunks_count: Dict[str, int] = {}
        placed_windows: List[Tuple[datetime, datetime]] = []
        created_blocks: List[ScheduledBlock] = []

        # Generate candidate 30-min grid points between start_scan_dt and due_dt (up to 10 days max)
        max_scan_dt = min(due_dt, start_scan_dt + timedelta(days=10))
        grid_starts: List[datetime] = []
        cursor = start_scan_dt
        while cursor + timedelta(minutes=30) <= max_scan_dt:
            grid_starts.append(cursor)
            cursor += timedelta(minutes=30)

        # Fallback if deadline is very tight: extend scan window by 48h
        if len(grid_starts) < total_parts * 2:
            ext_end = start_scan_dt + timedelta(hours=48)
            while cursor + timedelta(minutes=30) <= ext_end:
                grid_starts.append(cursor)
                cursor += timedelta(minutes=30)

        for idx, chunk_mins in enumerate(chunk_durations):
            chunk_delta = timedelta(minutes=chunk_mins)
            best_slot_dt: Optional[datetime] = None
            best_eval: Optional[Dict[str, Any]] = None
            best_combined_score = -1e9

            for cand_start in grid_starts:
                cand_end = cand_start + chunk_delta
                if cand_end > max_scan_dt and len(grid_starts) > total_parts * 3:
                    continue

                # 1. Check collision against FixedEvents and already placed blocks (with 15-min breather buffer)
                conflict = False
                for occ_s, occ_e in occupied:
                    if _overlaps(cand_start, cand_end, occ_s - timedelta(minutes=15), occ_e + timedelta(minutes=15)):
                        conflict = True
                        break
                if conflict:
                    continue

                # 2. Enforce at least 90-minute rest spacing between chunks of the same assignment
                too_close = False
                for pw_s, pw_e in placed_windows:
                    if _overlaps(cand_start, cand_end, pw_s - timedelta(minutes=90), pw_e + timedelta(minutes=90)):
                        too_close = True
                        break
                if too_close:
                    continue

                # 3. Evaluate 24-hour rhythm availability weight (NO hardcoded 8am-11pm bounds!)
                hr = cand_start.hour
                sched_weight = self.rhythm_learner.is_hour_schedulable(hr, exploration_alpha=0.15)
                if sched_weight < 0.22:
                    # Skip deep-sleep hours unless no other slots exist
                    continue

                day_key = cand_start.strftime("%Y-%m-%d")
                sim_fatigue = min(
                    0.95,
                    self.rhythm_learner.rhythm.rolling_fatigue + daily_fatigue_bonus.get(day_key, 0.0),
                )
                same_day_count = daily_chunks_count.get(day_key, 0)

                # Evaluate LinUCB across environment arms for this hour & fatigue level
                bandit_eval = self.bandit.evaluate_slot(
                    hour=hr,
                    difficulty=assignment.difficulty,
                    fatigue=sim_fatigue,
                    activity_prob=self.rhythm_learner.rhythm.hourly_activity_prob[hr],
                )

                # Combined slot objective:
                # LinUCB score * circadian availability weight - same-day fatigue stacking penalty
                stacking_penalty = 0.45 * same_day_count
                combined_score = (bandit_eval["ucb_score"] * sched_weight) - stacking_penalty

                if combined_score > best_combined_score:
                    best_combined_score = combined_score
                    best_slot_dt = cand_start
                    best_eval = bandit_eval

            # Fallback if all high-prob slots were full: pick the first non-conflicting slot
            if best_slot_dt is None:
                for cand_start in grid_starts:
                    cand_end = cand_start + chunk_delta
                    if not any(_overlaps(cand_start, cand_end, s, e) for s, e in occupied):
                        best_slot_dt = cand_start
                        hr = cand_start.hour
                        best_eval = self.bandit.evaluate_slot(
                            hour=hr,
                            difficulty=assignment.difficulty,
                            fatigue=self.rhythm_learner.rhythm.rolling_fatigue,
                            activity_prob=self.rhythm_learner.rhythm.hourly_activity_prob[hr],
                        )
                        break

            if best_slot_dt is None or best_eval is None:
                continue

            slot_end_dt = best_slot_dt + chunk_delta
            day_key = best_slot_dt.strftime("%Y-%m-%d")

            # Simulate fatigue increase on that day for subsequent chunks
            daily_fatigue_bonus[day_key] = daily_fatigue_bonus.get(day_key, 0.0) + (chunk_mins / 60.0) * 0.22
            daily_chunks_count[day_key] = daily_chunks_count.get(day_key, 0) + 1
            occupied.append((best_slot_dt, slot_end_dt))
            placed_windows.append((best_slot_dt, slot_end_dt))

            part_label = f" (Part {idx + 1}/{total_parts})" if total_parts > 1 else ""
            block = ScheduledBlock(
                id=f"blk_{uuid.uuid4().hex[:8]}",
                assignment_id=assignment.id,
                title=f"{assignment.title}{part_label}",
                start_time=_to_iso(best_slot_dt),
                end_time=_to_iso(slot_end_dt),
                recommended_location=best_eval["location"],
                predicted_reward=best_eval["expected_reward"],
                uncertainty_bound=best_eval["uncertainty_bound"],
                status="scheduled",
                explanation=best_eval["explanation"],
            )
            created_blocks.append(block)

        return created_blocks

    def cut_session_short(
        self,
        block_id: str,
        mins_completed: int,
        rating: float,
        mood: Optional[float],
        reason: Optional[str],
        blocks: List[ScheduledBlock],
        assignments: List[Assignment],
        events: List[FixedEvent],
        reference_time: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Truncates an active or scheduled study block:
        1. Updates `LinUCB` and `LearnedUserRhythm` (if cut short due to tiredness/fatigue,
           lowers the activity probability for that hour so future sessions avoid that time).
        2. Increases `rolling_fatigue` if the reason was tiredness/overwhelm.
        3. Automatically splits and reschedules the unfinished spillover minutes into
           future high-UCB slots before the assignment's deadline.
        """
        target_block: Optional[ScheduledBlock] = None
        for b in blocks:
            if b.id == block_id:
                target_block = b
                break

        if target_block is None:
            raise ValueError(f"ScheduledBlock '{block_id}' not found")

        start_dt = _parse_iso(target_block.start_time)
        end_dt = _parse_iso(target_block.end_time)
        planned_mins = max(15, int(round((end_dt - start_dt).total_seconds() / 60.0)))
        completed = max(0, min(planned_mins, int(mins_completed)))
        spillover_mins = max(0, planned_mins - completed)

        # Truncate block end_time & status
        target_block.status = "cut_short"
        target_block.end_time = _to_iso(start_dt + timedelta(minutes=max(5, completed)))

        hr = start_dt.hour
        reason_clean = (reason or "tired").lower().strip()
        is_tired_or_burnout = any(
            kw in reason_clean for kw in ("tired", "sleep", "exhaust", "fatig", "late", "burnout", "overwhelm")
        )

        # 1. Update LearnedUserRhythm:
        # If the user cut the session short because they are tired (e.g. at 9:00 PM / 21:00),
        # `was_active=False` lowers that hour's probability in `hourly_activity_prob`.
        self.rhythm_learner.update_activity_observation(
            hour=hr,
            was_active=not is_tired_or_burnout,
            rating=rating,
        )

        if is_tired_or_burnout:
            self.rhythm_learner.rhythm.rolling_fatigue = round(
                min(0.95, self.rhythm_learner.rhythm.rolling_fatigue + 0.20), 4
            )

        # 2. Update Disjoint LinUCB for the block's location arm
        parent_assignment: Optional[Assignment] = None
        for a in assignments:
            if a.id == target_block.assignment_id:
                parent_assignment = a
                break

        difficulty = parent_assignment.difficulty if parent_assignment else 3
        arm = target_block.recommended_location if target_block.recommended_location != "unknown" else "desk"
        effective_reward = (
            0.7 * float(rating) + 0.3 * float(mood)
            if mood is not None
            else float(rating)
        )
        self.bandit.observe(
            arm=arm,
            hour=hr,
            difficulty=difficulty,
            fatigue=self.rhythm_learner.rhythm.rolling_fatigue,
            activity_prob=self.rhythm_learner.rhythm.hourly_activity_prob[hr],
            reward=effective_reward,
        )

        # 3. Reschedule unfinished spillover minutes to future high-UCB slots before deadline
        rescheduled_blocks: List[ScheduledBlock] = []
        if spillover_mins >= 15:
            if parent_assignment is None:
                parent_assignment = Assignment(
                    id=target_block.assignment_id,
                    title=target_block.title.split(" (Part")[0],
                    due_date=_to_iso(end_dt + timedelta(days=3)),
                    total_estimated_mins=planned_mins,
                    remaining_mins=spillover_mins,
                    difficulty=3,
                )
                assignments.append(parent_assignment)
            else:
                parent_assignment.remaining_mins = max(spillover_mins, parent_assignment.remaining_mins - completed)

            spillover_task = Assignment(
                id=parent_assignment.id,
                title=f"{parent_assignment.title} (Spillover)",
                due_date=parent_assignment.due_date,
                total_estimated_mins=spillover_mins,
                remaining_mins=spillover_mins,
                difficulty=parent_assignment.difficulty,
                min_chunk_mins=min(30, spillover_mins),
                max_chunk_mins=parent_assignment.max_chunk_mins,
            )

            # Start scanning from at least 6 hours after the cut-short block so the user gets rest
            rest_resume_dt = max(
                _parse_iso(reference_time) if reference_time else end_dt,
                start_dt + timedelta(hours=8),
            )
            rescheduled_blocks = self.schedule_or_split_assignment(
                assignment=spillover_task,
                events=events,
                existing_blocks=blocks,
                reference_time=_to_iso(rest_resume_dt),
            )
            blocks.extend(rescheduled_blocks)

        return {
            "cut_block": target_block,
            "mins_completed": completed,
            "spillover_mins": spillover_mins,
            "rescheduled_blocks": rescheduled_blocks,
            "updated_hour_prob": self.rhythm_learner.rhythm.hourly_activity_prob[hr],
            "rolling_fatigue": self.rhythm_learner.rhythm.rolling_fatigue,
        }
