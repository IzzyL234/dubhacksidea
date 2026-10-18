"""
/backend/rhythm.py

Zero-Setup Schedule & Circadian Rhythm Learner.
Infers waking hours, sleep windows, and energy dips purely from passive interactions,
session ratings, and existing calendar events—with NO hardcoded 8:00 AM to 11:00 PM cutoffs.
"""

from __future__ import annotations

from datetime import datetime
from typing import Iterable, List, Optional

from .models import FixedEvent, LearnedUserRhythm


def _clip(val: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, float(val)))


def _parse_iso_hour(iso_str: str) -> Optional[int]:
    try:
        cleaned = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        return dt.hour
    except Exception:
        return None


def _parse_iso_dt(iso_str: str) -> Optional[datetime]:
    try:
        cleaned = iso_str.replace("Z", "+00:00")
        return datetime.fromisoformat(cleaned)
    except Exception:
        return None


class ZeroSetupRhythmLearner:
    """
    Maintains and updates `LearnedUserRhythm` without any manual user settings.
    Starts with an uninformative flat prior (0.50 across all 24 hours) or infers initial
    structure solely from imported calendar events and passive message timestamps.
    """

    def __init__(self, rhythm: Optional[LearnedUserRhythm] = None):
        self.rhythm = rhythm if rhythm is not None else LearnedUserRhythm()

    @classmethod
    def from_cold_start(
        cls,
        events: Optional[Iterable[FixedEvent]] = None,
        message_timestamps: Optional[Iterable[str]] = None,
    ) -> "ZeroSetupRhythmLearner":
        """
        Creates a cold-start rhythm learner with an uninformative flat prior (0.5 across 0..23),
        then softly incorporates any existing `FixedEvent`s and message timestamps.
        """
        rhythm = LearnedUserRhythm(
            hourly_activity_prob=[0.50] * 24,
            rolling_fatigue=0.15,
            onboarding_stage="cold_start",
            observations_count=0,
        )
        learner = cls(rhythm)
        if events:
            learner.infer_from_fixed_events(list(events))
        if message_timestamps:
            for ts in message_timestamps:
                hr = _parse_iso_hour(ts)
                if hr is not None:
                    learner.update_activity_observation(hr, was_active=True, rating=None)
        return learner

    @classmethod
    def from_day_3_calibrating(cls, events: Optional[Iterable[FixedEvent]] = None) -> "ZeroSetupRhythmLearner":
        """
        Day 3 preset: User has shared a messy brain-dump of classes/work and woken up around 10-11 AM.
        Some structure is emerging, but late-night and afternoon windows are still calibrating.
        """
        probs = [
            0.22, 0.15, 0.10, 0.08, 0.08, 0.10,  # 00:00 - 05:00
            0.14, 0.20, 0.32, 0.55, 0.78, 0.84,  # 06:00 - 11:00
            0.82, 0.76, 0.72, 0.65, 0.60, 0.68,  # 12:00 - 17:00
            0.74, 0.78, 0.80, 0.76, 0.62, 0.40,  # 18:00 - 23:00
        ]
        rhythm = LearnedUserRhythm(
            hourly_activity_prob=probs,
            rolling_fatigue=0.25,
            onboarding_stage="calibrating",
            observations_count=6,
            inferred_wake_hour=9,
            inferred_sleep_hour=1,
        )
        learner = cls(rhythm)
        if events:
            learner.infer_from_fixed_events(list(events))
        return learner

    @classmethod
    def from_day_21_night_owl(cls) -> "ZeroSetupRhythmLearner":
        """
        Day 21 preset: Fully learned Night-Owl / Library Persona.
        High activity & alertness 10:00 AM - 2:00 PM and 9:00 PM - 1:30 AM,
        with a distinct afternoon energy dip around 3:00 PM - 5:00 PM and sleep 2:30 AM - 9:30 AM.
        """
        probs = [
            0.88, 0.82, 0.35, 0.08, 0.04, 0.03,  # 00:00 - 05:00 (00-01:30 late-night peak, then sleep)
            0.04, 0.06, 0.12, 0.38, 0.90, 0.95,  # 06:00 - 11:00 (wakes ~9:30-10am, strong mid-day peak)
            0.94, 0.91, 0.78, 0.45, 0.32, 0.48,  # 12:00 - 17:00 (4pm afternoon crash)
            0.66, 0.75, 0.84, 0.92, 0.96, 0.93,  # 18:00 - 23:00 (second wind night-owl surge)
        ]
        rhythm = LearnedUserRhythm(
            hourly_activity_prob=probs,
            rolling_fatigue=0.20,
            onboarding_stage="personalized",
            observations_count=42,
            inferred_wake_hour=10,
            inferred_sleep_hour=2,
        )
        return cls(rhythm)

    def infer_from_fixed_events(self, events: List[FixedEvent]) -> None:
        """
        Inspects existing `FixedEvent`s on the user's calendar to infer active hours dynamically.
        """
        if not events:
            return

        for ev in events:
            start_dt = _parse_iso_dt(ev.start_time)
            end_dt = _parse_iso_dt(ev.end_time)
            if not start_dt or not end_dt:
                continue

            start_h = start_dt.hour
            end_h = end_dt.hour
            # Boost hours covered by the event and 1 hour before/after (commute / prep)
            span = (end_h - start_h) % 24
            if span == 0 and end_dt > start_dt:
                span = 1
            for offset in range(-1, span + 2):
                h = (start_h + offset) % 24
                weight = 0.78 if 0 <= offset <= span else 0.65
                current = self.rhythm.hourly_activity_prob[h]
                self.rhythm.hourly_activity_prob[h] = round(_clip(0.65 * current + 0.35 * max(current, weight)), 4)

        self._refresh_wake_sleep_estimates()

    def update_activity_observation(
        self,
        hour: int,
        was_active: bool,
        rating: Optional[float] = None,
        ema_alpha: float = 0.35,
    ) -> LearnedUserRhythm:
        """
        Updates `hourly_activity_prob[hour]` using an exponential moving average (EMA)
        and widens/shifts the user's active window automatically across neighboring hours.

        Example: If a user texts or studies at 1:00 AM (`hour=1`) with a `4/5` rating,
        hours 23, 0, 1, 2 automatically become high-score candidate slots for future scheduling.
        """
        h = int(hour) % 24

        if was_active:
            if rating is not None:
                # Rating 1..5 maps target activity probability into [0.25 .. 0.98]
                norm_rating = _clip((float(rating) - 1.0) / 4.0, 0.0, 1.0)
                target = 0.25 + 0.73 * norm_rating
            else:
                # Passive text/interaction without explicit rating implies awake & responsive
                target = 0.82
        else:
            # Explicit inactivity / cut-short due to tiredness or downtime
            if rating is not None:
                norm_rating = _clip((float(rating) - 1.0) / 4.0, 0.0, 1.0)
                target = 0.08 + 0.25 * norm_rating
            else:
                target = 0.12

        # Kernel smoothing across neighboring hours:
        # For late-night / early-morning activity (e.g., 1:00 AM), widen window across [h-2, h-1, h, h+1]
        # so hours 23, 0, 1, 2 all shift together naturally.
        neighbor_Multipliers = {
            -2: 0.45,
            -1: 0.70,
            0: 1.00,
            1: 0.70,
            2: 0.40,
        }

        for offset, mult in neighbor_Multipliers.items():
            idx = (h + offset) % 24
            effective_alpha = _clip(ema_alpha * mult, 0.05, 0.65)
            old_p = self.rhythm.hourly_activity_prob[idx]
            new_p = (1.0 - effective_alpha) * old_p + effective_alpha * target
            self.rhythm.hourly_activity_prob[idx] = round(_clip(new_p, 0.02, 0.99), 4)

        self.rhythm.observations_count += 1
        if self.rhythm.observations_count >= 15:
            self.rhythm.onboarding_stage = "personalized"
        elif self.rhythm.observations_count >= 3 and self.rhythm.onboarding_stage in ("cold_start", "blank_canvas"):
            self.rhythm.onboarding_stage = "calibrating"

        self._refresh_wake_sleep_estimates()
        return self.rhythm

    def apply_inferred_wake_time(self, wake_hour: int, sleep_hour: Optional[int] = None) -> LearnedUserRhythm:
        """
        Updates `LearnedUserRhythm` when the user mentions their wake-up or sleep routine in natural language
        (e.g., "I usually wake up around 11am").
        Suppresses hours in the sleep window leading up to `wake_hour` and boosts hours after `wake_hour`.
        """
        w_hr = int(wake_hour) % 24
        s_hr = int(sleep_hour) % 24 if sleep_hour is not None else (w_hr - 8) % 24

        self.rhythm.inferred_wake_hour = w_hr
        self.rhythm.inferred_sleep_hour = s_hr

        # Suppress hours inside the sleep arc [s_hr .. w_hr)
        cur = s_hr
        steps = 0
        while cur != w_hr and steps < 14:
            self.rhythm.hourly_activity_prob[cur] = round(
                min(self.rhythm.hourly_activity_prob[cur], 0.08), 4
            )
            cur = (cur + 1) % 24
            steps += 1

        # Boost active hours for 12 hours starting at wake_hour
        for offset in range(0, 13):
            active_h = (w_hr + offset) % 24
            self.rhythm.hourly_activity_prob[active_h] = round(
                max(self.rhythm.hourly_activity_prob[active_h], 0.75 if offset < 10 else 0.65), 4
            )

        self.rhythm.observations_count += 1
        return self.rhythm

    def is_hour_schedulable(self, hour: int, exploration_alpha: float = 0.15) -> float:
        """
        Returns a continuous availability weight in [0.0, 1.0] instead of a rigid boolean cutoff.
        Combines learned `hourly_activity_prob[hour]` with an exploration bonus when the model
        is still in `cold_start` or `calibrating` stage.
        """
        h = int(hour) % 24
        base_prob = _clip(self.rhythm.hourly_activity_prob[h], 0.0, 1.0)

        # Uncertainty shrinks as observations_count grows
        uncertainty_factor = 1.0 / (1.0 + 0.15 * self.rhythm.observations_count)
        optimistic_weight = base_prob + float(exploration_alpha) * uncertainty_factor

        # Softly penalize very low probability hours (< 0.20) so deep sleep isn't scheduled
        # unless exploration_alpha is explicitly high
        if base_prob < 0.18:
            return round(_clip(base_prob * 0.5 + 0.1 * exploration_alpha * uncertainty_factor, 0.0, 1.0), 4)

        return round(_clip(optimistic_weight, 0.0, 1.0), 4)

    def simulate_fatigue_step(self, current_fatigue: float, work_mins: int = 0, rest_mins: int = 0) -> float:
        """
        Updates rolling fatigue (0.0 to 1.0):
        - Increases proportionally with consecutive work minutes.
        - Decays exponentially during rest gaps.
        """
        f = _clip(current_fatigue, 0.0, 1.0)
        if work_mins > 0:
            # 60 mins of work adds ~0.22 fatigue; 90 mins adds ~0.33 fatigue
            f += (work_mins / 60.0) * 0.22
        if rest_mins > 0:
            # 60 mins of rest decays fatigue by ~0.18
            f -= (rest_mins / 60.0) * 0.18
        return round(_clip(f, 0.05, 0.98), 4)

    def _refresh_wake_sleep_estimates(self) -> None:
        probs = self.rhythm.hourly_activity_prob
        if not probs or len(probs) != 24:
            return
        # Find 8-hour window with lowest total activity probability as inferred sleep window
        best_sleep_start = 0
        min_sum = 999.0
        for start_h in range(24):
            window_sum = sum(probs[(start_h + k) % 24] for k in range(7))
            if window_sum < min_sum:
                min_sum = window_sum
                best_sleep_start = start_h
        self.rhythm.inferred_sleep_hour = best_sleep_start
        self.rhythm.inferred_wake_hour = (best_sleep_start + 7) % 24


# Module-level convenience functions matching specification signatures
def update_activity_observation(
    rhythm: LearnedUserRhythm,
    hour: int,
    was_active: bool,
    rating: Optional[float] = None,
) -> LearnedUserRhythm:
    learner = ZeroSetupRhythmLearner(rhythm)
    return learner.update_activity_observation(hour=hour, was_active=was_active, rating=rating)


def is_hour_schedulable(
    rhythm: LearnedUserRhythm,
    hour: int,
    exploration_alpha: float = 0.15,
) -> float:
    learner = ZeroSetupRhythmLearner(rhythm)
    return learner.is_hour_schedulable(hour=hour, exploration_alpha=exploration_alpha)
