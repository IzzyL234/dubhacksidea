"""
ml_focus_model.py

Unified Per-User LinUCB Contextual Bandit & Ridge Regression Model for Study Space Scoring & Recommendations,
connected to Supabase per user (`public.user_model_params` and `public.workspace_photos_log`) with local cache fallback.

Matches `src/learning.ts` mathematically:
- 13-feature vector:
  [bias, location:dorm_room, location:library, location:classroom, location:cafe,
   space:desk, space:shared_table, space:bed, space:beanbag,
   clutter, bright_light, ergonomics, duration]
- Sherman-Morrison online inverse covariance updates:
  A <- A + w * x * x^T
  b_prod <- b_prod + w * x * p
  b_mood <- b_mood + w * x * m
- LinUCB selection score:
  selectionScore = 3 + 2 * (expected + alpha * uncertainty)
  where uncertainty = sqrt(x^T A^-1 x)

Responsibilities:
1. Maintains an isolated `LinUCBStudyLearner` per user (`user_id`), warm-started on `data/seed_sessions.json` (40 synthetic sessions)
   and synchronized with Supabase (`user_model_params`).
2. Logs every analyzed photo metadata per user to Supabase (`workspace_photos_log`) and local fallback (`data/photos_log.json`).
3. Online updates each user's parameters in Supabase whenever new feedback ratings arrive (`update_parameters`).
4. Computes space scores, focus scores (0-100), predicted productivity (1-5), predicted mood (1-5), and LinUCB exploration bonus.
"""

import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from supabase_store import SupabaseStore, normalize_user_id, supabase_store

logger = logging.getLogger("ml_focus_model")

ROOT_DIR = Path(__file__).parent
DATA_DIR = ROOT_DIR / "data"
SEED_FILE = DATA_DIR / "seed_sessions.json"
ROOT_SEED_FILE = ROOT_DIR / "seed_sessions.json"
PHOTOS_LOG_FILE = DATA_DIR / "photos_log.json"
SESSIONS_LOG_JSONL = DATA_DIR / "sessions_history.jsonl"
FEEDBACK_RECORDS_DIR = DATA_DIR / "feedback" / "records"
SESSIONS_DIR = DATA_DIR / "sessions"
PARAMS_FILE = DATA_DIR / "ml_model_params.json"
USER_PARAMS_DIR = DATA_DIR / "user_models"

LOCATIONS = ["home", "dorm_room", "library", "classroom", "cafe"]
SPACES = ["chair", "desk", "shared_table", "bed", "beanbag"]

FEATURE_NAMES = [
    "bias",
    *[f"location:{loc}" for loc in LOCATIONS[1:]],
    *[f"space:{sp}" for sp in SPACES[1:]],
    "clutter",
    "bright_light",
    "ergonomics",
    "duration",
]
DIMENSION = len(FEATURE_NAMES)  # 13


def _dot(a: List[float], b: List[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _mat_vec_mul(mat: List[List[float]], vec: List[float]) -> List[float]:
    return [_dot(row, vec) for row in mat]


def _clip(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))


def extract_features(
    location: str,
    study_space: str,
    clutter_score: float,
    lighting: str,
    ergonomics: float,
    duration_mins: float = 45.0
) -> List[float]:
    """
    Constructs the exact 13-dimensional feature vector used by `src/learning.ts`.
    Normalizes unknown/other categories gracefully to reference categories ('home' / 'chair').
    """
    loc = location.lower().strip() if location else "home"
    if loc not in LOCATIONS:
        loc = "home"

    sp = study_space.lower().strip() if study_space else "desk"
    if sp not in SPACES:
        sp = "chair"

    clutter = _clip(float(clutter_score if clutter_score is not None else 3), 1.0, 10.0)
    ergo = _clip(float(ergonomics if ergonomics is not None else 7), 1.0, 10.0)
    dur = _clip(float(duration_mins if duration_mins is not None else 45), 5.0, 240.0)
    is_bright = 1.0 if str(lighting).lower().strip() == "bright" else 0.0

    return [
        1.0,
        *[1.0 if loc == l else 0.0 for l in LOCATIONS[1:]],
        *[1.0 if sp == s else 0.0 for s in SPACES[1:]],
        (clutter - 1.0) / 9.0,
        is_bright,
        (ergo - 1.0) / 9.0,
        dur / 120.0,
    ]


class LinUCBStudyLearner:
    """
    Python implementation of the shared-feature LinUCB contextual bandit & ridge regression learner
    matching `StudyLearner` in `src/learning.ts`, with full state serialization for Supabase storage.
    """

    def __init__(self, lam: float = 1.0):
        self.lam = lam
        self.version: int = 1
        self.inverse: List[List[float]] = [
            [(1.0 / lam if i == j else 0.0) for j in range(DIMENSION)]
            for i in range(DIMENSION)
        ]
        self.productivity: List[float] = [0.0] * DIMENSION
        self.mood: List[float] = [0.0] * DIMENSION
        self.observed_ids = set()
        self.combination_counts: Dict[str, int] = {}

    @property
    def count(self) -> int:
        return len(self.observed_ids)

    def to_state_dict(self, user_id: str = "default_user") -> Dict[str, Any]:
        """Serializes full LinUCB state for Supabase `user_model_params` and local JSON."""
        theta_p = _mat_vec_mul(self.inverse, self.productivity)
        theta_m = _mat_vec_mul(self.inverse, self.mood)
        return {
            "user_id": normalize_user_id(user_id),
            "version": self.version,
            "model_type": "LinUCB_Ridge_13D",
            "observations_count": self.count,
            "feature_names": FEATURE_NAMES,
            "inverse_matrix": self.inverse,
            "productivity_weights": self.productivity,
            "mood_weights": self.mood,
            "theta_productivity": [round(x, 4) for x in theta_p],
            "theta_mood": [round(x, 4) for x in theta_m],
            "combination_counts": self.combination_counts,
            "space_visit_counts": self.combination_counts,
            "observed_ids": sorted(list(self.observed_ids)),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    @classmethod
    def from_state_dict(cls, data: Dict[str, Any], lam: float = 1.0) -> Optional["LinUCBStudyLearner"]:
        """Restores a `LinUCBStudyLearner` from a Supabase `user_model_params` row or state dict."""
        try:
            inv = data.get("inverse_matrix")
            prod = data.get("productivity_weights")
            mood = data.get("mood_weights")
            if (
                not isinstance(inv, list)
                or len(inv) != DIMENSION
                or not isinstance(prod, list)
                or len(prod) != DIMENSION
                or not isinstance(mood, list)
                or len(mood) != DIMENSION
            ):
                return None
            learner = cls(lam=lam)
            learner.version = int(data.get("version", 1))
            learner.inverse = [[float(v) for v in row] for row in inv]
            learner.productivity = [float(v) for v in prod]
            learner.mood = [float(v) for v in mood]
            learner.observed_ids = set(str(x) for x in (data.get("observed_ids") or []))
            counts = data.get("combination_counts") or data.get("space_visit_counts") or {}
            learner.combination_counts = {str(k): int(v) for k, v in counts.items()}
            return learner
        except Exception as e:
            logger.warning("Could not restore learner from state dict: %s", e)
            return None

    def observe(
        self,
        session_id: str,
        location: str,
        study_space: str,
        clutter_score: float,
        lighting: str,
        ergonomics: float,
        productivity_rating: float,
        mood_rating: float,
        duration_mins: float = 45.0,
        sample_weight: float = 1.0
    ) -> bool:
        if not session_id or session_id in self.observed_ids:
            return False

        x = extract_features(location, study_space, clutter_score, lighting, ergonomics, duration_mins)
        w = _clip(float(sample_weight), 1e-6, 1.0)

        # Sherman-Morrison update: A^-1 <- A^-1 - (w * (A^-1 x)(A^-1 x)^T) / (1 + w * x^T A^-1 x)
        v = _mat_vec_mul(self.inverse, x)
        denom = 1.0 + w * _dot(x, v)
        self.inverse = [
            [
                self.inverse[i][j] - (w * v[i] * v[j]) / denom
                for j in range(DIMENSION)
            ]
            for i in range(DIMENSION)
        ]

        # Center ratings at 3, normalize to [-1, 1]
        p = (_clip(float(productivity_rating), 1.0, 5.0) - 3.0) / 2.0
        m = (_clip(float(mood_rating), 1.0, 5.0) - 3.0) / 2.0

        self.productivity = [val + w * x[i] * p for i, val in enumerate(self.productivity)]
        self.mood = [val + w * x[i] * m for i, val in enumerate(self.mood)]
        self.observed_ids.add(session_id)

        combo_key = f"{location.lower()}:{study_space.lower()}"
        self.combination_counts[combo_key] = self.combination_counts.get(combo_key, 0) + 1
        return True

    def predict(
        self,
        location: str,
        study_space: str,
        clutter_score: float,
        lighting: str,
        ergonomics: float,
        duration_mins: float = 45.0,
        productivity_weight: float = 0.7,
        alpha: float = 0.25
    ) -> Dict[str, Any]:
        x = extract_features(location, study_space, clutter_score, lighting, ergonomics, duration_mins)
        theta_p = _mat_vec_mul(self.inverse, self.productivity)
        theta_m = _mat_vec_mul(self.inverse, self.mood)

        raw_p = _dot(x, theta_p)
        raw_m = _dot(x, theta_m)

        uncertainty = math.sqrt(max(0.0, _dot(x, _mat_vec_mul(self.inverse, x))))
        expected = productivity_weight * raw_p + (1.0 - productivity_weight) * raw_m

        pred_prod = _clip(3.0 + 2.0 * raw_p, 1.0, 5.0)
        pred_mood = _clip(3.0 + 2.0 * raw_m, 1.0, 5.0)
        pred_util = _clip(3.0 + 2.0 * expected, 1.0, 5.0)
        exploration_bonus = 2.0 * alpha * uncertainty
        selection_score = 3.0 + 2.0 * (expected + alpha * uncertainty)

        # Convert utility (1-5) into a 0-100 Focus Score
        focus_score = int(round(_clip(((pred_util - 1.0) / 4.0) * 100.0, 0.0, 100.0)))

        combo_key = f"{location.lower()}:{study_space.lower()}"
        visits = self.combination_counts.get(combo_key, 0)

        return {
            "focus_score": focus_score,
            "predicted_productivity": round(pred_prod, 2),
            "predicted_mood": round(pred_mood, 2),
            "predicted_utility": round(pred_util, 2),
            "uncertainty": round(uncertainty, 4),
            "exploration_bonus": round(exploration_bonus, 3),
            "selection_score": round(selection_score, 3),
            "observations": self.count,
            "space_visits": visits,
        }

    def recommend_spaces(
        self,
        duration_mins: float = 45.0,
        productivity_weight: float = 0.7,
        alpha: float = 0.35
    ) -> Dict[str, Any]:
        """
        Evaluates all realistic (location, study_space) candidates using LinUCB.
        Returns:
        - top_known: Best proven study space from historical data
        - top_unexplored: Best under-explored / novel study space with high LinUCB exploration bonus + expected reward
        - ranked_candidates: Full ranked list
        """
        candidates = []
        typical_env = {
            "desk": {"clutter_score": 2, "lighting": "bright", "ergonomics": 8},
            "shared_table": {"clutter_score": 3, "lighting": "bright", "ergonomics": 7},
            "chair": {"clutter_score": 3, "lighting": "bright", "ergonomics": 6},
            "beanbag": {"clutter_score": 5, "lighting": "dim", "ergonomics": 4},
            "bed": {"clutter_score": 7, "lighting": "dim", "ergonomics": 2},
        }

        for loc in LOCATIONS:
            for sp in SPACES:
                if sp == "bed" and loc in ("library", "classroom", "cafe"):
                    continue
                env = typical_env[sp]
                pred = self.predict(
                    location=loc,
                    study_space=sp,
                    clutter_score=env["clutter_score"],
                    lighting=env["lighting"],
                    ergonomics=env["ergonomics"],
                    duration_mins=duration_mins,
                    productivity_weight=productivity_weight,
                    alpha=alpha,
                )
                combo_key = f"{loc}:{sp}"
                visits = self.combination_counts.get(combo_key, 0)
                candidates.append({
                    "id": combo_key,
                    "label": f"{loc.replace('_', ' ').title()} ({sp.replace('_', ' ').title()})",
                    "location": loc,
                    "study_space": sp,
                    "visits": visits,
                    "is_unexplored": visits <= 1,
                    **pred,
                })

        ranked = sorted(candidates, key=lambda c: (-c["selection_score"], c["id"]))

        known = [c for c in ranked if not c["is_unexplored"]]
        unexplored = sorted(
            [c for c in ranked if c["is_unexplored"]],
            key=lambda c: (-c["selection_score"], -c["exploration_bonus"])
        )

        return {
            "top_recommendation": ranked[0] if ranked else None,
            "top_known": known[0] if known else (ranked[0] if ranked else None),
            "top_unexplored": unexplored[0] if unexplored else None,
            "ranked_candidates": ranked,
        }


class FocusMLModel:
    """
    Manages per-user LinUCB study learners (`user_id` -> `LinUCBStudyLearner`),
    synchronizing each user's model parameters (`user_model_params`) and
    workspace photo logs (`workspace_photos_log`) with Supabase.
    """

    def __init__(self, store: Optional[SupabaseStore] = None):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        USER_PARAMS_DIR.mkdir(parents=True, exist_ok=True)
        self.store = store if store is not None else supabase_store
        self.learners: Dict[str, LinUCBStudyLearner] = {}
        self.learner = self.get_or_load_user_learner("default_user")
        self.weights = self.learner.to_state_dict("default_user")

    def _user_local_params_path(self, uid: str) -> Path:
        return USER_PARAMS_DIR / f"{uid}.json"

    def _warm_start_seed(self, learner: LinUCBStudyLearner):
        """Warm-starts a learner on the 40 synthetic starter sessions."""
        seed_path = SEED_FILE if SEED_FILE.exists() else ROOT_SEED_FILE
        if not seed_path.exists():
            return
        try:
            rows = json.loads(seed_path.read_text(encoding="utf-8"))
            rows_sorted = sorted(rows, key=lambda r: r.get("timestamp", ""))
            for r in rows_sorted:
                tags = r.get("peceptron_tags") or r.get("perceptron_tags") or r.get("environment") or {}
                learner.observe(
                    session_id=str(r.get("id")),
                    location=str(r.get("location", "home")),
                    study_space=str(r.get("study_space", "desk")),
                    clutter_score=float(tags.get("clutter_score", 3)),
                    lighting=str(tags.get("lighting", "bright")),
                    ergonomics=float(tags.get("ergonomics", 7)),
                    productivity_rating=float(r.get("user_productivity_rating", 3)),
                    mood_rating=float(r.get("user_mood_rating", 3)),
                    duration_mins=float(r.get("duration_mins", 45)),
                    sample_weight=1.0,
                )
        except Exception as e:
            logger.warning("Failed to load seed sessions: %s", e)

    def _train_user_history(self, uid: str, learner: LinUCBStudyLearner):
        """Applies a user's completed sessions & rated photo logs on top of the warm-start learner."""
        # 1. Completed TS bot sessions + feedback for this user (or all if default_user)
        try:
            if SESSIONS_DIR.exists() and FEEDBACK_RECORDS_DIR.exists():
                sessions_by_id: Dict[str, Dict[str, Any]] = {}
                for sess_file in SESSIONS_DIR.glob("*.json"):
                    if uid != "default_user" and sess_file.stem != uid:
                        continue
                    doc = json.loads(sess_file.read_text(encoding="utf-8"))
                    for s in doc.get("sessions", []):
                        if s.get("id"):
                            sessions_by_id[s["id"]] = s

                for fb_file in sorted(FEEDBACK_RECORDS_DIR.glob("*.json")):
                    fb = json.loads(fb_file.read_text(encoding="utf-8"))
                    if uid != "default_user" and fb.get("conversation_key") != uid:
                        continue
                    sess_id = fb.get("session_id")
                    if not sess_id or sess_id not in sessions_by_id:
                        continue
                    s = sessions_by_id[sess_id]
                    env = s.get("environment") or {}
                    if not s.get("location") or not s.get("study_space") or not env.get("lighting"):
                        continue
                    dist_rating = fb.get("distraction_rating", 1)
                    dist_source = fb.get("distraction_source")
                    weight = 0.25 if (dist_rating >= 4 and dist_source in ("phone", "other")) else 1.0
                    learner.observe(
                        session_id=str(fb.get("id")),
                        location=str(s.get("location")),
                        study_space=str(s.get("study_space")),
                        clutter_score=float(env.get("clutter_score", 3)),
                        lighting=str(env.get("lighting", "bright")),
                        ergonomics=float(env.get("ergonomics") or 7),
                        productivity_rating=float(fb.get("productivity_rating", 3)),
                        mood_rating=float(fb.get("mood_rating", 3)),
                        duration_mins=float(s.get("duration_mins") or 45),
                        sample_weight=weight,
                    )
        except Exception as e:
            logger.warning("Error loading linked TS feedback records for %s: %s", uid, e)

        # 2. Rated entries from Supabase or local photos_log for this user
        for entry in self.get_photos_log(user_id=uid):
            entry_uid = normalize_user_id(entry.get("user_id"))
            if uid != "default_user" and entry_uid != uid:
                continue
            if entry.get("user_productivity_rating") is not None:
                tags = entry.get("peceptron_tags") or entry.get("perceptron_tags") or {}
                learner.observe(
                    session_id=str(entry.get("id")),
                    location=str(entry.get("location", "home")),
                    study_space=str(entry.get("study_space", "desk")),
                    clutter_score=float(tags.get("clutter_score", 3)),
                    lighting=str(tags.get("lighting", "bright")),
                    ergonomics=float(tags.get("ergonomics", 7)),
                    productivity_rating=float(entry["user_productivity_rating"]),
                    mood_rating=float(entry.get("user_mood_rating") or entry["user_productivity_rating"]),
                    duration_mins=float(entry.get("duration_mins", 45)),
                    sample_weight=float(entry.get("sample_weight", 1.0)),
                )

    def get_or_load_user_learner(self, user_id: Optional[str] = None, force_reload: bool = False) -> LinUCBStudyLearner:
        """
        Loads a user's LinUCB model from:
        1. Supabase `user_model_params` (if configured & row exists for `user_id`)
        2. Local per-user cache `data/user_models/<uid>.json` (if exists)
        3. Warm-start from 40 seed sessions, then catches up with any rated sessions for that user,
           and persists the initialized state to Supabase.
        """
        uid = normalize_user_id(user_id)
        if not force_reload and uid in self.learners:
            return self.learners[uid]

        learner: Optional[LinUCBStudyLearner] = None

        # 1. Try loading user's saved model parameters from Supabase
        if self.store and self.store.enabled:
            cloud_row = self.store.get_user_model_params(uid)
            if cloud_row:
                learner = LinUCBStudyLearner.from_state_dict(cloud_row)

        # 2. Try loading from local per-user cache if not found in cloud
        local_user_file = self._user_local_params_path(uid)
        if learner is None and local_user_file.exists():
            try:
                cached = json.loads(local_user_file.read_text(encoding="utf-8"))
                learner = LinUCBStudyLearner.from_state_dict(cached)
            except Exception:
                learner = None

        # 3. Cold start: initialize with 40 synthetic starter sessions
        if learner is None:
            learner = LinUCBStudyLearner()
            self._warm_start_seed(learner)

        # 4. Ensure any new rated sessions or feedback not yet in `observed_ids` are incorporated
        before_count = learner.count
        self._train_user_history(uid, learner)
        self.learners[uid] = learner

        # Save state if newly created or updated with new observations
        if learner.count != before_count or not local_user_file.exists():
            self._save_user_state(uid, learner)

        if uid == "default_user":
            self.learner = learner
            self.weights = learner.to_state_dict(uid)

        return learner

    def _save_user_state(self, user_id: str, learner: LinUCBStudyLearner) -> Dict[str, Any]:
        """Persists a user's model parameters to Supabase (`user_model_params`) and local fallback."""
        uid = normalize_user_id(user_id)
        state = learner.to_state_dict(uid)

        # 1. Sync to Supabase `user_model_params`
        if self.store and self.store.enabled:
            self.store.upsert_user_model_params(uid, state)

        # 2. Save per-user local cache (`data/user_models/<uid>.json`)
        try:
            USER_PARAMS_DIR.mkdir(parents=True, exist_ok=True)
            self._user_local_params_path(uid).write_text(json.dumps(state, indent=2), encoding="utf-8")
        except Exception as e:
            logger.error("Failed to write per-user model params for %s: %s", uid, e)

        # 3. Also update `data/ml_model_params.json` with latest active user state for inspection
        self.weights = state
        self.learner = learner
        try:
            PARAMS_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
        except Exception as e:
            logger.error("Failed to write model params summary: %s", e)

        return state

    def reload_and_train(self, user_id: Optional[str] = None) -> int:
        """Reloads and synchronizes the specified user's LinUCB model."""
        uid = normalize_user_id(user_id)
        learner = self.get_or_load_user_learner(uid, force_reload=True)
        return learner.count

    def predict(
        self,
        clutter_score: int,
        lighting_quality: str,
        ergonomics_score: int,
        location: str,
        study_space: str,
        distractions: List[Dict[str, Any]],
        duration_mins: int = 45,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Runs LinUCB prediction for the specific user's model and generates personalized space recommendations.
        """
        uid = normalize_user_id(user_id)
        learner = self.get_or_load_user_learner(uid)
        pred = learner.predict(
            location=location,
            study_space=study_space,
            clutter_score=clutter_score,
            lighting=lighting_quality,
            ergonomics=ergonomics_score if ergonomics_score is not None else 7,
            duration_mins=duration_mins,
        )
        recs = learner.recommend_spaces(duration_mins=duration_mins)
        return {
            "user_id": uid,
            **pred,
            "recommendations": {
                "top_known": recs["top_known"],
                "top_unexplored": recs["top_unexplored"],
            },
            "breakdown": {
                "distraction_count": len(distractions),
                "space_visits": pred["space_visits"],
                "observations_trained": pred["observations"],
            },
        }

    def get_photos_log(self, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Reads workspace photo logs from Supabase (`workspace_photos_log`) if enabled,
        falling back to or merging with local `data/photos_log.json`.
        """
        uid = normalize_user_id(user_id) if user_id else None

        # 1. Try reading from Supabase first when configured
        if self.store and self.store.enabled:
            cloud_photos = self.store.get_user_photos_log(user_id=uid if uid != "default_user" else None)
            if cloud_photos is not None and len(cloud_photos) > 0:
                return cloud_photos

        # 2. Fallback to local `data/photos_log.json`
        if not PHOTOS_LOG_FILE.exists():
            return []
        try:
            data = json.loads(PHOTOS_LOG_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                return []
            if uid and uid != "default_user":
                return [row for row in data if normalize_user_id(row.get("user_id")) == uid]
            return data
        except Exception:
            return []

    def log_photo_analysis(self, record: Dict[str, Any], user_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Saves photo analysis metadata (without raw image bytes) per user to:
        1. Supabase `public.workspace_photos_log`
        2. Local `data/photos_log.json` & `data/sessions_history.jsonl`
        """
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        uid = normalize_user_id(user_id or record.get("user_id"))

        entry = {
            "id": record.get("id"),
            "user_id": uid,
            "session_id": record.get("session_id") or record.get("id"),
            "timestamp": record.get("timestamp", datetime.now(timezone.utc).isoformat()),
            "duration_mins": record.get("duration_mins", 45),
            "location": record.get("location", "home"),
            "study_space": record.get("study_space", "desk"),
            "location_class": f"{record.get('location', 'home')}_{record.get('study_space', 'desk')}",
            "peceptron_tags": {
                "clutter_score": record.get("clutter_score", 3),
                "lighting": record.get("lighting_quality", "bright"),
                "ergonomics": record.get("ergonomics_score", 7),
                "detected_objects": record.get("distractions", []),
            },
            "perceptron_tags": {
                "clutter_score": record.get("clutter_score", 3),
                "lighting": record.get("lighting_quality", "bright"),
                "ergonomics": record.get("ergonomics_score", 7),
                "detected_objects": record.get("distractions", []),
            },
            "linucb_metrics": {
                "focus_score": record.get("focus_score"),
                "predicted_productivity": record.get("predicted_productivity"),
                "predicted_mood": record.get("predicted_mood"),
                "selection_score": record.get("selection_score"),
                "exploration_bonus": record.get("exploration_bonus"),
            },
            "user_productivity_rating": record.get("user_productivity_rating"),
            "user_mood_rating": record.get("user_mood_rating"),
            "user_distraction_rating": record.get("user_distraction_rating"),
            "distraction_source": record.get("distraction_source"),
            "source": record.get("source", "perceptron_vlm"),
        }

        # 1. Persist to Supabase `workspace_photos_log`
        if self.store and self.store.enabled:
            self.store.insert_photo_log(uid, entry)

        # 2. Local fallback cache (`data/photos_log.json` and `data/sessions_history.jsonl`)
        try:
            local_photos = []
            if PHOTOS_LOG_FILE.exists():
                parsed = json.loads(PHOTOS_LOG_FILE.read_text(encoding="utf-8"))
                if isinstance(parsed, list):
                    local_photos = parsed
            local_photos.append(entry)
            PHOTOS_LOG_FILE.write_text(json.dumps(local_photos, indent=2), encoding="utf-8")
        except Exception as e:
            logger.error("Failed to write photos_log.json: %s", e)

        try:
            with open(SESSIONS_LOG_JSONL, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            logger.error("Failed to append sessions_history.jsonl: %s", e)

        return entry

    def log_session(self, record: Dict[str, Any], user_id: Optional[str] = None):
        """Alias for log_photo_analysis for backward compatibility."""
        return self.log_photo_analysis(record, user_id=user_id)

    def update_parameters(
        self,
        session_data: Dict[str, Any],
        actual_user_rating: float,
        actual_mood_rating: Optional[float] = None,
        distraction_rating: Optional[int] = None,
        distraction_source: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Records user feedback ratings for a logged photo session, performs an online Sherman-Morrison
        LinUCB parameter update for that specific user, and saves the updated parameters to Supabase.
        """
        sess_id = session_data.get("session_id") or session_data.get("id")
        mood = actual_mood_rating if actual_mood_rating is not None else actual_user_rating
        weight = (
            0.25
            if (distraction_rating and distraction_rating >= 4 and distraction_source in ("phone", "other"))
            else 1.0
        )

        resolved_user_id = user_id or session_data.get("user_id")
        matched_item: Optional[Dict[str, Any]] = None

        # 1. Update photo rating in Supabase if enabled
        if self.store and self.store.enabled and sess_id:
            cloud_updated = self.store.update_photo_rating(
                session_id=str(sess_id),
                productivity_rating=int(round(actual_user_rating)),
                mood_rating=int(round(mood)),
                distraction_rating=distraction_rating,
                distraction_source=distraction_source,
                sample_weight=weight,
            )
            if cloud_updated:
                matched_item = cloud_updated
                if not resolved_user_id:
                    resolved_user_id = cloud_updated.get("user_id")

        # 2. Also update local `data/photos_log.json` if present
        if PHOTOS_LOG_FILE.exists():
            try:
                photos = json.loads(PHOTOS_LOG_FILE.read_text(encoding="utf-8"))
                if isinstance(photos, list):
                    local_changed = False
                    for item in photos:
                        if item.get("id") == sess_id or item.get("session_id") == sess_id:
                            item["user_productivity_rating"] = int(round(actual_user_rating))
                            item["user_mood_rating"] = int(round(mood))
                            if distraction_rating is not None:
                                item["user_distraction_rating"] = int(distraction_rating)
                            if distraction_source is not None:
                                item["distraction_source"] = distraction_source
                            item["sample_weight"] = weight
                            local_changed = True
                            if matched_item is None:
                                matched_item = item
                            if not resolved_user_id:
                                resolved_user_id = item.get("user_id")
                            break
                    if local_changed:
                        PHOTOS_LOG_FILE.write_text(json.dumps(photos, indent=2), encoding="utf-8")
            except Exception as e:
                logger.error("Failed to update local photos_log.json: %s", e)

        uid = normalize_user_id(resolved_user_id)
        learner = self.get_or_load_user_learner(uid)

        # 3. Online update of the user's LinUCB model parameters
        if matched_item is not None:
            tags = matched_item.get("peceptron_tags") or matched_item.get("perceptron_tags") or {}
            learner.observe(
                session_id=str(matched_item.get("id") or sess_id),
                location=str(matched_item.get("location", "home")),
                study_space=str(matched_item.get("study_space", "desk")),
                clutter_score=float(tags.get("clutter_score", 3)),
                lighting=str(tags.get("lighting", "bright")),
                ergonomics=float(tags.get("ergonomics", 7)),
                productivity_rating=float(actual_user_rating),
                mood_rating=float(mood),
                duration_mins=float(matched_item.get("duration_mins", 45)),
                sample_weight=weight,
            )
        else:
            learner.observe(
                session_id=str(sess_id or f"manual_{datetime.now().timestamp()}"),
                location=str(session_data.get("location", "library")),
                study_space=str(session_data.get("study_space", "desk")),
                clutter_score=float(session_data.get("clutter_score", 3)),
                lighting=str(session_data.get("lighting_quality", "bright")),
                ergonomics=float(session_data.get("ergonomics_score", 7)),
                productivity_rating=float(actual_user_rating),
                mood_rating=float(mood),
                duration_mins=float(session_data.get("duration_mins", 45)),
                sample_weight=weight,
            )

        learner.version += 1
        return self._save_user_state(uid, learner)


# Singleton instance
focus_model = FocusMLModel()
