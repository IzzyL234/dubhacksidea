"""
test_backend.py

Unit and integration tests for the Photon-Perceptron workspace analysis backend:
- ML focus model predictions and correlations
- Online parameter updates
- FastAPI endpoints for file uploads, base64 payload, and rating feedback
"""

import base64
import io
import unittest
from PIL import Image
from fastapi.testclient import TestClient

from analyze_workspace import app
from ml_focus_model import FocusMLModel


class TestWorkspaceBackend(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.model = FocusMLModel()

    def test_health_check(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "healthy")
        self.assertTrue("ml_model_version" in data)

    def test_ml_model_correlations(self):
        # 1. Optimal workspace: clean library desk with bright lighting
        high_res = self.model.predict(
            clutter_score=1,
            lighting_quality="bright",
            ergonomics_score=9,
            location="library",
            study_space="desk",
            distractions=[]
        )
        self.assertGreaterEqual(high_res["focus_score"], 80)
        self.assertGreaterEqual(high_res["predicted_productivity"], 4.0)

        # 2. Suboptimal workspace: cluttered bed with dim lighting
        low_res = self.model.predict(
            clutter_score=9,
            lighting_quality="dim",
            ergonomics_score=2,
            location="dorm_room",
            study_space="bed",
            distractions=[{"label": "smartphone"}, {"label": "snack"}, {"label": "wires"}]
        )
        self.assertLessEqual(low_res["focus_score"], 40)
        self.assertLessEqual(low_res["predicted_productivity"], 2.5)

    def test_ml_parameter_update(self):
        initial_version = self.model.weights.get("version", 1)
        self.model.update_parameters(
            session_data={"study_space": "desk", "location": "library", "predicted_productivity": 3.0},
            actual_user_rating=5.0
        )
        new_version = self.model.weights.get("version")
        self.assertGreater(new_version, initial_version)

    def test_analyze_workspace_upload(self):
        img = Image.new("RGB", (80, 80), color="green")
        buf = io.BytesIO()
        img.save(buf, format="JPEG")

        resp = self.client.post(
            "/analyze-workspace",
            files={"file": ("workspace.jpg", buf.getvalue(), "image/jpeg")}
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        # Check required characteristics from schema
        for key in ["session_id", "location", "study_space", "clutter_score", "lighting_quality", "ergonomics_score", "focus_score", "reply_text"]:
            self.assertIn(key, data, f"Missing {key} in response")

        # Verify reply text contains Photon iMessage badge & scores
        self.assertIn("Focus Score:", data["reply_text"])
        self.assertIn("Location:", data["reply_text"])

    def test_analyze_workspace_base64(self):
        img = Image.new("RGB", (60, 60), color="white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        resp = self.client.post(
            "/analyze-workspace/base64",
            json={"image_base64": b64}
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("session_id", data)
        self.assertGreaterEqual(data["focus_score"], 0)
        self.assertLessEqual(data["focus_score"], 100)

    def test_rate_session_endpoint(self):
        resp = self.client.post(
            "/api/rate-session",
            json={"session_id": "test_sess_001", "actual_rating": 4.5}
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "success")


if __name__ == "__main__":
    unittest.main()
