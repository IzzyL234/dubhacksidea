"""
ml_focus_model.py

Focus and productivity machine learning scoring model.
Extracts environmental characteristics from Perceptron VLM data:
- clutter_score (1-10)
- lighting_quality ('dim' / 'bright')
- ergonomics_score (1-10)
- location (macro: library, classroom, cafe, dorm_room, home, other)
- study_space (micro: desk, shared_table, chair, beanbag, bed, other)
- detected distractions

Computes:
- focus_score (0-100)
- predicted_productivity (1.0 to 5.0)

Maintains persistent parameters and provides an update hook
to retrain / adjust model weights when user feedback is provided.
"""

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("ml_focus_model")

DATA_DIR = Path(__file__).parent / "data"
PARAMS_FILE = DATA_DIR / "ml_model_params.json"
SESSIONS_LOG = DATA_DIR / "sessions_history.jsonl"

# Initial baseline weights calibrated against seed_sessions.json correlations
DEFAULT_WEIGHTS = {
    "base_focus": 50.0,
    "clutter_weight": -4.5,            # per clutter point (1-10)
    "dim_lighting_penalty": -18.0,      # if dim lighting
    "bright_lighting_bonus": 10.0,      # if bright lighting
    "ergonomics_weight": 2.5,          # per point relative to 5
    "distraction_penalty": -4.0,       # per detected distraction
    "space_weights": {
        "desk": 15.0,
        "shared_table": 12.0,
        "chair": 2.0,
        "beanbag": -15.0,
        "bed": -28.0,
        "other": 0.0
    },
    "location_weights": {
        "library": 12.0,
        "classroom": 10.0,
        "cafe": 3.0,
        "home": -2.0,
        "dorm_room": -5.0,
        "other": 0.0
    },
    "learning_rate": 0.05,
    "version": 1
}


class FocusMLModel:
    def __init__(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.weights = self._load_parameters()

    def _load_parameters(self) -> Dict[str, Any]:
        """Loads weights from disk or initializes defaults."""
        if PARAMS_FILE.exists():
            try:
                with open(PARAMS_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                logger.warning("Failed to load parameters from %s, using defaults: %s", PARAMS_FILE, e)
        return dict(DEFAULT_WEIGHTS)

    def save_parameters(self):
        """Persists updated weights to disk."""
        try:
            with open(PARAMS_FILE, "w", encoding="utf-8") as f:
                json.dump(self.weights, f, indent=2)
            logger.info("Saved updated ML model parameters to %s", PARAMS_FILE)
        except Exception as e:
            logger.error("Failed to save ML model parameters: %s", e)

    def predict(
        self,
        clutter_score: int,
        lighting_quality: str,
        ergonomics_score: int,
        location: str,
        study_space: str,
        distractions: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Calculates focus score (0-100) and predicted productivity (1.0 - 5.0)
        from Perceptron vision characteristics.
        """
        w = self.weights

        # 1. Base score
        raw_score = w.get("base_focus", 50.0)

        # 2. Clutter penalty
        clutter_effect = (clutter_score - 2) * w.get("clutter_weight", -4.5)
        raw_score += clutter_effect

        # 3. Lighting effect
        is_bright = (lighting_quality.lower() == "bright")
        lighting_effect = w.get("bright_lighting_bonus", 10.0) if is_bright else w.get("dim_lighting_penalty", -18.0)
        raw_score += lighting_effect

        # 4. Ergonomics effect
        ergo_effect = (ergonomics_score - 5) * w.get("ergonomics_weight", 2.5)
        raw_score += ergo_effect

        # 5. Study space effect
        space_key = study_space.lower()
        space_weights = w.get("space_weights", {})
        space_effect = space_weights.get(space_key, space_weights.get("other", 0.0))
        raw_score += space_effect

        # 6. Location effect
        loc_key = location.lower()
        loc_weights = w.get("location_weights", {})
        loc_effect = loc_weights.get(loc_key, loc_weights.get("other", 0.0))
        raw_score += loc_effect

        # 7. Distraction items penalty
        distraction_count = len(distractions)
        distraction_effect = distraction_count * w.get("distraction_penalty", -4.0)
        raw_score += distraction_effect

        # Clip focus score between 0 and 100
        focus_score = int(round(max(0.0, min(100.0, raw_score))))

        # Map focus score (0-100) to predicted productivity rating (1.0 - 5.0)
        predicted_prod = round(max(1.0, min(5.0, 1.0 + (focus_score / 100.0) * 4.0)), 2)

        return {
            "focus_score": focus_score,
            "predicted_productivity": predicted_prod,
            "breakdown": {
                "base": round(w.get("base_focus", 50.0), 1),
                "clutter_effect": round(clutter_effect, 1),
                "lighting_effect": round(lighting_effect, 1),
                "ergonomics_effect": round(ergo_effect, 1),
                "space_effect": round(space_effect, 1),
                "location_effect": round(loc_effect, 1),
                "distractions_effect": round(distraction_effect, 1),
                "distraction_count": distraction_count
            }
        }

    def update_parameters(self, session_data: Dict[str, Any], actual_user_rating: float):
        """
        Online model learning: Adjusts parameters based on actual user feedback rating (1-5).
        Allows the ML model to adapt dynamically to the user's personal study habits.
        """
        pred = session_data.get("predicted_productivity", 3.0)
        error = actual_user_rating - pred  # Positive error means user was more productive than predicted
        lr = self.weights.get("learning_rate", 0.05)

        logger.info(
            "Updating ML parameters with actual rating: %.1f, predicted: %.1f, error: %.2f",
            actual_user_rating, pred, error
        )

        # Gradient update on base focus and modifiers
        self.weights["base_focus"] = round(self.weights["base_focus"] + lr * error * 5.0, 3)

        # Update space weight
        space = session_data.get("study_space", "").lower()
        if space in self.weights.get("space_weights", {}):
            curr_val = self.weights["space_weights"][space]
            self.weights["space_weights"][space] = round(curr_val + lr * error * 4.0, 3)

        # Update location weight
        loc = session_data.get("location", "").lower()
        if loc in self.weights.get("location_weights", {}):
            curr_val = self.weights["location_weights"][loc]
            self.weights["location_weights"][loc] = round(curr_val + lr * error * 3.0, 3)

        self.weights["version"] = self.weights.get("version", 1) + 1
        self.save_parameters()

    def log_session(self, record: Dict[str, Any]):
        """Persists processed perceptron session to sessions_history.jsonl."""
        try:
            with open(SESSIONS_LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        except Exception as e:
            logger.error("Failed to log session: %s", e)


# Global singleton instance
focus_model = FocusMLModel()
