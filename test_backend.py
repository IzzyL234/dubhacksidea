"""
test_backend.py

Unit and integration tests for the Photon-Perceptron-LinUCB workspace analysis backend:
- Per-user LinUCB focus model predictions, correlations, and space recommendations (proven + unexplored)
- Per-user Supabase sync (`public.user_model_params` and `public.workspace_photos_log`)
- Photo metadata logging (just the data without raw image bytes)
- Online parameter updates per user with user ratings
- FastAPI endpoints for file uploads, base64 payload, recommendations, photos log, and rating feedback
"""

import base64
import io
import unittest
from typing import Any, Dict, List, Optional
from PIL import Image
from fastapi.testclient import TestClient

from analyze_workspace import app
from ml_focus_model import FocusMLModel
from supabase_store import SupabaseStore, normalize_user_id


class MockSupabaseStore(SupabaseStore):
    """In-memory mock of Supabase tables (`user_model_params` and `workspace_photos_log`) for testing."""

    def __init__(self):
        super().__init__()
        self.base_url = "https://mock-project.supabase.co"
        self.api_key = "sb_secret_mock_test_key"
        self.model_params_table: Dict[str, Dict[str, Any]] = {}
        self.photos_log_table: List[Dict[str, Any]] = []

    def get_user_model_params(self, user_id: str) -> Optional[Dict[str, Any]]:
        uid = normalize_user_id(user_id)
        return self.model_params_table.get(uid)

    def upsert_user_model_params(self, user_id: str, params_record: Dict[str, Any]) -> bool:
        uid = normalize_user_id(user_id)
        self.model_params_table[uid] = dict(params_record, user_id=uid)
        return True

    def insert_photo_log(self, user_id: str, entry: Dict[str, Any]) -> bool:
        uid = normalize_user_id(user_id)
        row = dict(entry, user_id=uid)
        self.photos_log_table = [r for r in self.photos_log_table if r.get("id") != row.get("id")]
        self.photos_log_table.append(row)
        return True

    def update_photo_rating(
        self,
        session_id: str,
        productivity_rating: int,
        mood_rating: int,
        distraction_rating: Optional[int] = None,
        distraction_source: Optional[str] = None,
        sample_weight: float = 1.0,
    ) -> Optional[Dict[str, Any]]:
        for row in self.photos_log_table:
            if row.get("id") == session_id or row.get("session_id") == session_id:
                row["user_productivity_rating"] = int(productivity_rating)
                row["user_mood_rating"] = int(mood_rating)
                row["sample_weight"] = float(sample_weight)
                if distraction_rating is not None:
                    row["user_distraction_rating"] = int(distraction_rating)
                if distraction_source is not None:
                    row["distraction_source"] = distraction_source
                return row
        return None

    def get_user_photos_log(self, user_id: Optional[str] = None, limit: int = 100) -> Optional[List[Dict[str, Any]]]:
        if not user_id:
            return list(self.photos_log_table)
        uid = normalize_user_id(user_id)
        return [r for r in self.photos_log_table if r.get("user_id") == uid]


class TestWorkspaceBackend(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.mock_store = MockSupabaseStore()
        self.model = FocusMLModel(store=self.mock_store)

    def test_health_check(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "healthy")
        self.assertTrue("ml_model_version" in data)
        self.assertIn("supabase_configured", data)
        self.assertGreaterEqual(data["observations_trained"], 40)

    def test_ml_model_correlations_and_linucb(self):
        # 1. Optimal workspace: clean library desk with bright lighting
        high_res = self.model.predict(
            clutter_score=1,
            lighting_quality="bright",
            ergonomics_score=9,
            location="library",
            study_space="desk",
            distractions=[],
            user_id="alice@example.com",
        )
        self.assertGreaterEqual(high_res["focus_score"], 80)
        self.assertGreaterEqual(high_res["predicted_productivity"], 4.0)
        self.assertIn("recommendations", high_res)
        self.assertIsNotNone(high_res["recommendations"]["top_known"])
        self.assertIsNotNone(high_res["recommendations"]["top_unexplored"])

        # 2. Suboptimal workspace: cluttered bed with dim lighting
        low_res = self.model.predict(
            clutter_score=9,
            lighting_quality="dim",
            ergonomics_score=2,
            location="dorm_room",
            study_space="bed",
            distractions=[{"label": "smartphone"}, {"label": "snack"}, {"label": "wires"}],
            user_id="alice@example.com",
        )
        self.assertLessEqual(low_res["focus_score"], 40)
        self.assertLessEqual(low_res["predicted_productivity"], 2.5)

    def test_per_user_supabase_isolation_and_parameter_updates(self):
        """Verifies that each user has independent parameters in Supabase that update online."""
        alice_id = "+12065550101"
        bob_id = "+12065550202"
        alice_hash = normalize_user_id(alice_id)
        bob_hash = normalize_user_id(bob_id)

        # Log photo for Alice in a cafe shared_table
        self.model.log_photo_analysis(
            {
                "id": "sess_alice_1",
                "location": "cafe",
                "study_space": "shared_table",
                "clutter_score": 2,
                "lighting_quality": "bright",
                "ergonomics_score": 8,
            },
            user_id=alice_id,
        )

        # Before rating: check Alice's prediction for cafe shared_table
        before_pred = self.model.predict(
            clutter_score=2,
            lighting_quality="bright",
            ergonomics_score=8,
            location="cafe",
            study_space="shared_table",
            distractions=[],
            user_id=alice_id,
        )

        # Alice rates her cafe session 5/5 productivity & 5/5 mood
        updated_alice_state = self.model.update_parameters(
            session_data={"session_id": "sess_alice_1"},
            actual_user_rating=5.0,
            actual_mood_rating=5.0,
            user_id=alice_id,
        )

        # Verify Alice's params were saved to Supabase `user_model_params`
        self.assertIn(alice_hash, self.mock_store.model_params_table)
        cloud_alice = self.mock_store.get_user_model_params(alice_id)
        self.assertEqual(cloud_alice["version"], updated_alice_state["version"])
        self.assertEqual(cloud_alice["observations_count"], 41)

        # Verify Alice's photo log in Supabase has the updated rating
        alice_photos = self.mock_store.get_user_photos_log(alice_id)
        self.assertEqual(len(alice_photos), 1)
        self.assertEqual(alice_photos[0]["user_productivity_rating"], 5)

        # Verify Alice's cafe prediction increased after the 5/5 update
        after_pred = self.model.predict(
            clutter_score=2,
            lighting_quality="bright",
            ergonomics_score=8,
            location="cafe",
            study_space="shared_table",
            distractions=[],
            user_id=alice_id,
        )
        self.assertGreater(after_pred["predicted_productivity"], before_pred["predicted_productivity"])

        # Verify Bob's model is completely unaffected by Alice's rating
        bob_pred = self.model.predict(
            clutter_score=2,
            lighting_quality="bright",
            ergonomics_score=8,
            location="cafe",
            study_space="shared_table",
            distractions=[],
            user_id=bob_id,
        )
        self.assertEqual(bob_pred["observations"], 40)
        self.assertEqual(bob_pred["predicted_productivity"], before_pred["predicted_productivity"])
        self.assertIn(bob_hash, self.mock_store.model_params_table)

    def test_analyze_workspace_upload_and_photo_log(self):
        img = Image.new("RGB", (80, 80), color="green")
        buf = io.BytesIO()
        img.save(buf, format="JPEG")

        resp = self.client.post(
            "/analyze-workspace",
            data={"user_id": "test_user_upload"},
            files={"file": ("workspace.jpg", buf.getvalue(), "image/jpeg")}
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        for key in [
            "session_id", "user_id", "location", "study_space", "clutter_score",
            "lighting_quality", "ergonomics_score", "focus_score",
            "selection_score", "recommendations", "reply_text"
        ]:
            self.assertIn(key, data, f"Missing {key} in response")

        self.assertEqual(data["user_id"], normalize_user_id("test_user_upload"))

        # Verify /api/photos-log endpoint with user_id filter
        log_resp = self.client.get("/api/photos-log", params={"user_id": "test_user_upload"})
        self.assertEqual(log_resp.status_code, 200)
        self.assertGreaterEqual(log_resp.json()["count"], 1)

    def test_recommendations_endpoint(self):
        resp = self.client.get("/api/recommendations", params={"user_id": "test_user_upload"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("top_known", data)
        self.assertIn("top_unexplored", data)
        self.assertTrue(data["top_unexplored"]["is_unexplored"])

    def test_analyze_workspace_base64(self):
        img = Image.new("RGB", (60, 60), color="white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        resp = self.client.post(
            "/analyze-workspace/base64",
            json={"image_base64": b64, "user_id": "user_b64"}
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("session_id", data)
        self.assertEqual(data["user_id"], normalize_user_id("user_b64"))

    def test_rate_session_endpoint(self):
        resp = self.client.post(
            "/api/rate-session",
            json={
                "session_id": "test_sess_001",
                "user_id": "user_b64",
                "actual_rating": 5.0,
                "mood_rating": 4.0
            }
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["user_id"], normalize_user_id("user_b64"))


if __name__ == "__main__":
    unittest.main()
