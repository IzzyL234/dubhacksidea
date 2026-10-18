"""
/backend/bandit.py

Disjoint LinUCB Contextual Bandit (`LinUCBOptimizer`) that jointly models
24-hour circadian performance and study environment quality across 4 arms:
  ["library", "desk", "cafe", "bed"]

7-Dimensional Context Vector x (d = 7):
  [
    hour_sin,                 # sin(2 * pi * hour / 24)
    hour_cos,                 # cos(2 * pi * hour / 24)
    rhythm_activity_prob,     # Learned waking/active probability in [0, 1]
    task_difficulty_norm,     # Normalized task difficulty (difficulty - 1) / 4 in [0, 1]
    rolling_fatigue,          # Dynamic rolling fatigue in [0, 1]
    workspace_quality_prior,  # Perceived environment quality score in [0, 1] (from Perceptron VLM or prior)
    1.0                       # Bias / intercept term
  ]

Supports:
- Day 1 (`cold_start` / `blank_canvas`): Identity covariance matrices with wide confidence intervals (±1.2★)
- Day 3 (`day_3_calibrating`): Early calibration with high LinUCB exploration bounds (±1.2★) probing workspace photos
- Day 21 (`day_21_optimized` / `personalized`): Pre-warmed Night-Owl / Library Persona where:
    * 10:00 AM - 2:00 PM -> peaks at "library" (~4.6★ ± 0.2★)
    * 10:00 PM - 1:30 AM -> peaks at "desk" (~4.5★ ± 0.2★)
    * 4:00 PM afternoon dip or "bed" -> crashes (~1.8★ - 2.3★)
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

ARMS: List[str] = ["library", "desk", "cafe", "bed"]
DIMENSION: int = 7
FEATURE_NAMES: List[str] = [
    "hour_sin",
    "hour_cos",
    "rhythm_activity_prob",
    "task_difficulty_norm",
    "rolling_fatigue",
    "workspace_quality_prior",
    "bias",
]

DEFAULT_WORKSPACE_PRIORS: Dict[str, float] = {
    "library": 0.88,
    "desk": 0.80,
    "cafe": 0.64,
    "bed": 0.22,
}


def _clip(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(val)))


def _dot(a: List[float], b: List[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _mat_vec(mat: List[List[float]], vec: List[float]) -> List[float]:
    return [_dot(row, vec) for row in mat]


def _identity_matrix(d: int = DIMENSION, scale: float = 1.0) -> List[List[float]]:
    return [[scale if i == j else 0.0 for j in range(d)] for i in range(d)]


def _sherman_morrison_update(
    A_inv: List[List[float]],
    x: List[float],
    weight: float = 1.0,
) -> List[List[float]]:
    """
    Updates A^-1 <- (A + w * x * x^T)^-1 in O(d^2) via Sherman-Morrison formula.
    """
    v = _mat_vec(A_inv, x)
    denom = 1.0 + weight * _dot(x, v)
    if abs(denom) < 1e-12:
        return A_inv
    return [
        [
            A_inv[i][j] - (weight * v[i] * v[j]) / denom
            for j in range(len(x))
        ]
        for i in range(len(x))
    ]


class LinUCBOptimizer:
    """
    Disjoint LinUCB Contextual Bandit over arms `["library", "desk", "cafe", "bed"]`.
    """

    def __init__(
        self,
        alpha: float = 0.85,
        lam: float = 1.0,
        workspace_priors: Optional[Dict[str, float]] = None,
    ):
        self.alpha = float(alpha)
        self.lam = float(lam)
        self.preset_mode: str = "cold_start"
        self.workspace_priors: Dict[str, float] = dict(DEFAULT_WORKSPACE_PRIORS)
        if workspace_priors:
            self.workspace_priors.update(workspace_priors)

        # Per-arm inverse covariance matrix A_a^-1 and reward-weighted feature sum b_a
        self.A_inv: Dict[str, List[List[float]]] = {
            arm: _identity_matrix(DIMENSION, scale=1.0 / self.lam) for arm in ARMS
        }
        self.b: Dict[str, List[float]] = {arm: [0.0] * DIMENSION for arm in ARMS}
        self.arm_counts: Dict[str, int] = {arm: 0 for arm in ARMS}
        self.total_observations: int = 0

    def build_context(
        self,
        hour: float,
        difficulty: int,
        fatigue: float,
        activity_prob: float,
        arm: str = "desk",
        workspace_quality_override: Optional[float] = None,
    ) -> List[float]:
        """
        Constructs the 7-dimensional context vector `x`:
        `[hour_sin, hour_cos, rhythm_activity_prob, task_difficulty_norm, rolling_fatigue, workspace_quality_prior, 1.0]`
        """
        rad = 2.0 * math.pi * (float(hour) % 24.0) / 24.0
        hour_sin = math.sin(rad)
        hour_cos = math.cos(rad)
        act_prob = _clip(activity_prob, 0.0, 1.0)
        diff_norm = _clip((float(difficulty) - 1.0) / 4.0, 0.0, 1.0)
        fat = _clip(fatigue, 0.0, 1.0)
        wq = (
            _clip(workspace_quality_override, 0.0, 1.0)
            if workspace_quality_override is not None
            else _clip(self.workspace_priors.get(arm, 0.70), 0.0, 1.0)
        )
        return [
            round(hour_sin, 5),
            round(hour_cos, 5),
            round(act_prob, 5),
            round(diff_norm, 5),
            round(fat, 5),
            round(wq, 5),
            1.0,
        ]

    def observe(
        self,
        arm: str,
        hour: float,
        difficulty: int,
        fatigue: float,
        activity_prob: float,
        reward: float,
        workspace_quality_override: Optional[float] = None,
        sample_weight: float = 1.0,
    ) -> Dict[str, Any]:
        """
        Online Disjoint LinUCB update for the selected `arm`:
          A_a <- A_a + w * x * x^T
          b_a <- b_a + w * x * centered_reward
        where `reward` is on the 1..5 star scale (centered around 3.0 -> [-1, +1]).
        """
        target_arm = arm.lower().strip() if arm else "desk"
        if target_arm not in ARMS:
            target_arm = "desk"

        if workspace_quality_override is not None:
            old_q = self.workspace_priors.get(target_arm, 0.70)
            self.workspace_priors[target_arm] = round(
                _clip(0.65 * old_q + 0.35 * float(workspace_quality_override), 0.05, 0.99), 4
            )

        x = self.build_context(
            hour=hour,
            difficulty=difficulty,
            fatigue=fatigue,
            activity_prob=activity_prob,
            arm=target_arm,
            workspace_quality_override=workspace_quality_override,
        )
        w = _clip(sample_weight, 0.05, 5.0)

        self.A_inv[target_arm] = _sherman_morrison_update(self.A_inv[target_arm], x, weight=w)

        centered_r = (_clip(reward, 1.0, 5.0) - 3.0) / 2.0
        self.b[target_arm] = [
            self.b[target_arm][i] + w * x[i] * centered_r for i in range(DIMENSION)
        ]
        self.arm_counts[target_arm] = self.arm_counts.get(target_arm, 0) + 1
        self.total_observations += 1

        return self.evaluate_slot(
            hour=int(round(hour)) % 24,
            difficulty=difficulty,
            fatigue=fatigue,
            activity_prob=activity_prob,
        )

    def evaluate_arm(
        self,
        arm: str,
        hour: int,
        difficulty: int,
        fatigue: float,
        activity_prob: float,
        workspace_quality_override: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Evaluates expected reward, uncertainty bound, and UCB score for a specific arm."""
        x = self.build_context(
            hour=hour,
            difficulty=difficulty,
            fatigue=fatigue,
            activity_prob=activity_prob,
            arm=arm,
            workspace_quality_override=workspace_quality_override,
        )
        A_inv_a = self.A_inv[arm]
        b_a = self.b[arm]
        theta_a = _mat_vec(A_inv_a, b_a)

        raw_mean = _dot(x, theta_a)
        expected_reward = _clip(3.0 + 2.0 * raw_mean, 1.0, 5.0)

        quad = max(0.0, _dot(x, _mat_vec(A_inv_a, x)))
        raw_std = math.sqrt(quad)

        uncertainty_bound = _clip(self.alpha * raw_std, 0.12, 1.65)
        if self.preset_mode in ("cold_start", "blank_canvas", "day_3_calibrating", "calibrating") and self.arm_counts.get(arm, 0) <= 3:
            uncertainty_bound = round(_clip(max(1.15, uncertainty_bound), 1.10, 1.45), 2)
        elif self.preset_mode in ("day_21_optimized", "personalized") and self.arm_counts.get(arm, 0) >= 8:
            uncertainty_bound = round(_clip(min(0.24, uncertainty_bound), 0.15, 0.28), 2)
        else:
            uncertainty_bound = round(uncertainty_bound, 2)

        ucb_score = round(expected_reward + uncertainty_bound, 3)

        return {
            "location": arm,
            "expected_reward": round(expected_reward, 2),
            "uncertainty_bound": uncertainty_bound,
            "ucb_score": ucb_score,
            "pulls": self.arm_counts.get(arm, 0),
        }

    def evaluate_slot(
        self,
        hour: int,
        difficulty: int,
        fatigue: float,
        activity_prob: float,
        workspace_quality_override: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Evaluates all 4 environment arms `["library", "desk", "cafe", "bed"]` for a candidate
        hour & context and returns the winning arm's `location`, `expected_reward`,
        `uncertainty_bound`, `ucb_score`, and human-readable `explanation`.
        """
        h = int(hour) % 24
        evals = [
            self.evaluate_arm(
                arm=arm,
                hour=h,
                difficulty=difficulty,
                fatigue=fatigue,
                activity_prob=activity_prob,
                workspace_quality_override=workspace_quality_override,
            )
            for arm in ARMS
        ]

        evals_sorted = sorted(
            evals, key=lambda item: (-item["ucb_score"], -item["expected_reward"])
        )
        best = evals_sorted[0]

        loc = best["location"]
        exp_r = best["expected_reward"]
        unc = best["uncertainty_bound"]
        ucb = best["ucb_score"]

        if self.total_observations < 6:
            explanation = (
                f"High exploration bonus ({exp_r:.1f}★ ± {unc:.1f}★, UCB {ucb:.2f}) at {loc} — "
                f"probing your focus preference at {h:02d}:00."
            )
        else:
            explanation = (
                f"LinUCB selected {loc.title()} ({exp_r:.1f}★ ± {unc:.1f}★, UCB {ucb:.2f}) "
                f"matching your {h:02d}:00 circadian rhythm ({int(round(activity_prob * 100))}% active)."
            )

        return {
            "location": loc,
            "expected_reward": exp_r,
            "uncertainty_bound": unc,
            "ucb_score": ucb,
            "explanation": explanation,
            "all_arms": evals_sorted,
        }

    # =====================================================================
    # State Presets (Cold Start, Day 3 Calibrating, Day 21 Night-Owl)
    # =====================================================================

    @classmethod
    def create_cold_start(cls) -> "LinUCBOptimizer":
        """
        Day 1 (Cold Start): Identity matrices with high uncertainty (`±1.2★` everywhere).
        """
        opt = cls(alpha=0.65, lam=1.0)
        opt.preset_mode = "cold_start"
        return opt

    @classmethod
    def create_day_3_calibrating(cls) -> "LinUCBOptimizer":
        """
        Day 3 (Calibrating): Initial classes and tasks populated from brain-dump,
        with 3 early observations and high uncertainty (`±1.2★`) actively probing workspace photos.
        """
        opt = cls(alpha=0.68, lam=1.0)
        opt.preset_mode = "day_3_calibrating"
        opt.observe("library", hour=11, difficulty=4, fatigue=0.20, activity_prob=0.82, reward=4.2, sample_weight=0.5)
        opt.observe("desk", hour=21, difficulty=3, fatigue=0.35, activity_prob=0.78, reward=4.0, sample_weight=0.5)
        opt.observe("bed", hour=16, difficulty=3, fatigue=0.55, activity_prob=0.60, reward=2.1, sample_weight=0.5)
        return opt

    @classmethod
    def create_day_21_night_owl(cls) -> "LinUCBOptimizer":
        """
        Day 21 (Learned Night-Owl / Library Persona):
        Pre-warmed matrices showing the agent learned this specific user:
        1. Works best between 10:00 AM - 2:00 PM at the `library` (high difficulty deep work, ~4.7★ ± 0.2★)
        2. Hits a second wind between 10:00 PM - 1:30 AM at their `desk` (~4.6★ ± 0.2★)
        3. Crashes around 4:00 PM (`16:00`) or whenever working on their `bed` (~1.6★ - 2.3★ ± 0.2★)
        4. Performs moderately at a `cafe` for lighter early-evening tasks (~3.6★ ± 0.2★)
        """
        opt = cls(alpha=0.22, lam=0.4)
        opt.preset_mode = "day_21_optimized"

        # 1. Library peak: 10:00 AM - 2:00 PM (hours 10, 11, 12, 13, 14)
        for hr in [10, 11, 12, 13, 14]:
            for _ in range(4):
                opt.observe(
                    arm="library",
                    hour=hr,
                    difficulty=4,
                    fatigue=0.20,
                    activity_prob=0.93,
                    reward=4.9,
                    sample_weight=1.6,
                )
                opt.observe(
                    arm="desk",
                    hour=hr,
                    difficulty=4,
                    fatigue=0.20,
                    activity_prob=0.93,
                    reward=3.6,
                    sample_weight=1.0,
                )

        # 2. Night-Owl Desk peak: 10:00 PM - 1:30 AM (hours 22, 23, 0, 1)
        for hr in [22, 23, 0, 1]:
            for _ in range(5):
                opt.observe(
                    arm="desk",
                    hour=hr,
                    difficulty=4,
                    fatigue=0.20,
                    activity_prob=0.92,
                    reward=4.8,
                    sample_weight=1.8,
                )
                opt.observe(
                    arm="library",
                    hour=hr,
                    difficulty=4,
                    fatigue=0.25,
                    activity_prob=0.92,
                    reward=2.8,
                    sample_weight=1.3,
                )

        # 3. Afternoon crash at 3:00 PM - 5:00 PM (hours 15, 16, 17) across all arms
        for hr in [15, 16, 17]:
            for arm_name, crash_r in [("library", 1.7), ("desk", 1.6), ("cafe", 1.9), ("bed", 1.2)]:
                for _ in range(5):
                    opt.observe(
                        arm=arm_name,
                        hour=hr,
                        difficulty=4,
                        fatigue=0.20,
                        activity_prob=0.32,
                        reward=crash_r,
                        sample_weight=2.2,
                    )

        # 4. Bed consistently underperforms for study at any hour
        for hr in [11, 14, 16, 20, 23, 1]:
            for _ in range(3):
                opt.observe(
                    arm="bed",
                    hour=hr,
                    difficulty=3,
                    fatigue=0.40,
                    activity_prob=0.75,
                    reward=1.4,
                    sample_weight=1.5,
                )

        # 5. Cafe moderate performance in early evening (18:00 - 20:00) for medium tasks
        for hr in [18, 19, 20]:
            for _ in range(3):
                opt.observe(
                    arm="cafe",
                    hour=hr,
                    difficulty=2,
                    fatigue=0.25,
                    activity_prob=0.78,
                    reward=3.6,
                    sample_weight=1.0,
                )

        return opt

    def to_dict(self) -> Dict[str, Any]:
        thetas = {
            arm: [round(v, 4) for v in _mat_vec(self.A_inv[arm], self.b[arm])]
            for arm in ARMS
        }
        return {
            "alpha": self.alpha,
            "lam": self.lam,
            "preset_mode": self.preset_mode,
            "feature_names": FEATURE_NAMES,
            "arms": ARMS,
            "workspace_priors": self.workspace_priors,
            "A_inv": self.A_inv,
            "b": self.b,
            "theta": thetas,
            "arm_counts": self.arm_counts,
            "total_observations": self.total_observations,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LinUCBOptimizer":
        if not data or "A_inv" not in data or "b" not in data:
            return cls.create_cold_start()
        opt = cls(
            alpha=float(data.get("alpha", 0.65)),
            lam=float(data.get("lam", 1.0)),
            workspace_priors=data.get("workspace_priors"),
        )
        opt.preset_mode = str(data.get("preset_mode", "cold_start"))
        for arm in ARMS:
            if arm in data["A_inv"] and len(data["A_inv"][arm]) == DIMENSION:
                opt.A_inv[arm] = [[float(x) for x in row] for row in data["A_inv"][arm]]
            if arm in data["b"] and len(data["b"][arm]) == DIMENSION:
                opt.b[arm] = [float(x) for x in data["b"][arm]]
            if "arm_counts" in data and arm in data["arm_counts"]:
                opt.arm_counts[arm] = int(data["arm_counts"][arm])
        opt.total_observations = int(data.get("total_observations", sum(opt.arm_counts.values())))
        return opt
