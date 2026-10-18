"""
test_backend.py

Unit and integration tests for:
1. Photon-Perceptron-LinUCB workspace analysis backend (`analyze_workspace.py`, `ml_focus_model.py`, `supabase_store.py`)
2. Zero-Setup Self-Learning AI Calendar & Productivity Engine (`/backend`: `models.py`, `bandit.py`, `rhythm.py`,
   `scheduler.py`, `proactive.py`, `agent.py`, `proposals.py`, `main.py`) including Blank-Canvas Discovery Mode,
   multi-entity brain-dump & routine extraction, 24-hour dynamic task splitting, 3-stage hackathon demo presets,
   and the Agentic Calendar Planner Staged Approval Queue ("Git Diff for Calendar").
"""

import base64
import io
import unittest
import uuid
from typing import Any, Dict, List, Optional
from PIL import Image
from fastapi.testclient import TestClient

from analyze_workspace import app
from ml_focus_model import FocusMLModel
from supabase_store import SupabaseStore, normalize_user_id

from backend.main import app as engine_app, engine
from backend.bandit import LinUCBOptimizer
from backend.rhythm import ZeroSetupRhythmLearner, update_activity_observation, is_hour_schedulable
from backend.proactive import check_calendar_sparsity


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
        run_tag = uuid.uuid4().hex[:6]
        alice_id = f"alice_{run_tag}@example.com"
        bob_id = f"bob_{run_tag}@example.com"
        sess_id = f"sess_alice_{run_tag}"
        alice_hash = normalize_user_id(alice_id)
        bob_hash = normalize_user_id(bob_id)

        self.model.log_photo_analysis(
            {
                "id": sess_id,
                "location": "cafe",
                "study_space": "shared_table",
                "clutter_score": 2,
                "lighting_quality": "bright",
                "ergonomics_score": 8,
            },
            user_id=alice_id,
        )

        before_pred = self.model.predict(
            clutter_score=2,
            lighting_quality="bright",
            ergonomics_score=8,
            location="cafe",
            study_space="shared_table",
            distractions=[],
            user_id=alice_id,
        )

        updated_alice_state = self.model.update_parameters(
            session_data={"session_id": sess_id},
            actual_user_rating=5.0,
            actual_mood_rating=5.0,
            user_id=alice_id,
        )

        self.assertIn(alice_hash, self.mock_store.model_params_table)
        cloud_alice = self.mock_store.get_user_model_params(alice_id)
        self.assertEqual(cloud_alice["version"], updated_alice_state["version"])
        self.assertEqual(cloud_alice["observations_count"], 41)

        alice_photos = self.mock_store.get_user_photos_log(alice_id)
        self.assertEqual(len(alice_photos), 1)
        self.assertEqual(alice_photos[0]["user_productivity_rating"], 5)

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


class TestZeroSetupProductivityEngine(unittest.TestCase):
    """
    Tests the `/backend` Zero-Setup AI Calendar & Productivity Engine:
    - Blank-Canvas Discovery Mode & sparsity calculation
    - Multi-Entity Brain-Dump & Routine extraction
    - 24-hour Rhythm Learner (including late-night 1:00 AM window expansion)
    - 7D Disjoint LinUCB Bandit (Day 1 Cold Start, Day 3 Calibrating, Day 21 Night-Owl / Library Persona)
    - Dynamic Task Splitter & Cut-Short Spillover Rescheduler
    - Proactive Simulate-Tick & 3-Stage Demo Switcher
    - Staged Approval Queue ("Git Diff for Calendar") propose / pending / approve / reject flows
    """

    def setUp(self):
        self.client = TestClient(engine_app)
        self.client.post("/api/demo/set-stage", json={"stage": "blank_canvas"})

    def test_1_blank_canvas_discovery_mode(self):
        cal_resp = self.client.get("/api/calendar")
        self.assertEqual(cal_resp.status_code, 200)
        cal = cal_resp.json()
        self.assertEqual(len(cal["events"]), 0)
        self.assertEqual(len(cal["scheduled_blocks"]), 0)
        self.assertEqual(cal["calendar_sparsity"], 0.0)
        self.assertTrue(cal["is_sparse_discovery_mode"])

        pending_resp = self.client.get("/api/proactive/pending")
        self.assertEqual(pending_resp.status_code, 200)
        pending = pending_resp.json()
        self.assertGreaterEqual(pending["count"], 1)
        reasons = [p["trigger_reason"] for p in pending["prompts"]]
        self.assertIn("discovery_brain_dump", reasons)

    def test_2_multi_entity_brain_dump_and_task_splitting(self):
        brain_dump = "I have CS lecture MWF 10-11:30, work Tuesdays 2-5, and a huge 5-hour ML project due Friday"
        resp = self.client.post(
            "/api/agent/incoming-message",
            json={"text": brain_dump}
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        # Verify 3 MWF CS lectures + 1 Tuesday Work shift = 4 FixedEvents
        self.assertEqual(len(data["extracted_events"]), 4)
        # Verify 1 ML Project (300 mins) extracted
        self.assertEqual(len(data["extracted_assignments"]), 1)
        self.assertEqual(data["extracted_assignments"][0]["total_estimated_mins"], 300)
        # Verify 300 mins split into four 75-minute study blocks
        self.assertEqual(len(data["scheduled_blocks"]), 4)
        self.assertIn("Boom—I just added", data["reply_text"])
        self.assertIn("four 75-minute study blocks", data["reply_text"])
        # Verify a StagedChangeProposal was also recorded for Visual UI diff inspection
        self.assertIsNotNone(data.get("staged_proposal"))

    def test_3_inferred_routine_and_24h_rhythm_learning(self):
        # User states wake time & gym routine
        resp = self.client.post(
            "/api/agent/incoming-message",
            json={"text": "I usually wake up around 11am and go to the gym at 6pm"}
        )
        self.assertEqual(resp.status_code, 200)
        cal = self.client.get("/api/calendar").json()
        probs = cal["rhythm"]["hourly_activity_prob"]
        # Hours before 11am (e.g. 6am, 7am, 8am) should be suppressed
        self.assertLessEqual(probs[7], 0.10)
        self.assertGreaterEqual(probs[11], 0.70)
        # Gym routine events created at 18:00
        gym_events = [e for e in cal["events"] if e["title"] == "Gym" and e["source"] == "inferred_routine"]
        self.assertGreaterEqual(len(gym_events), 5)

        # Test studying at 1:00 AM with a 4/5 rating automatically boosts hours 23, 0, 1, 2
        learner = ZeroSetupRhythmLearner.from_cold_start()
        before_23 = learner.rhythm.hourly_activity_prob[23]
        before_1 = learner.rhythm.hourly_activity_prob[1]
        update_activity_observation(learner.rhythm, hour=1, was_active=True, rating=4.0)
        self.assertGreater(learner.rhythm.hourly_activity_prob[1], before_1)
        self.assertGreater(learner.rhythm.hourly_activity_prob[0], 0.50)
        self.assertGreater(learner.rhythm.hourly_activity_prob[2], 0.50)
        self.assertGreater(learner.rhythm.hourly_activity_prob[23], before_23)
        self.assertGreater(is_hour_schedulable(learner.rhythm, 1), 0.60)

    def test_4_day_3_and_day_21_demo_presets(self):
        # Day 3 Calibrating: high uncertainty (~1.2 stars)
        r3 = self.client.post("/api/demo/set-stage", json={"stage": "day_3_calibrating"})
        self.assertEqual(r3.status_code, 200)
        cal3 = r3.json()["calendar"]
        self.assertGreaterEqual(len(cal3["events"]), 4)
        self.assertGreaterEqual(len(cal3["scheduled_blocks"]), 4)
        self.assertGreaterEqual(cal3["scheduled_blocks"][0]["uncertainty_bound"], 1.1)

        # Day 21 Optimized: Night-Owl / Library Persona with tight confidence intervals (~0.2 stars)
        r21 = self.client.post("/api/demo/set-stage", json={"stage": "day_21_optimized"})
        self.assertEqual(r21.status_code, 200)
        cal21 = r21.json()["calendar"]
        hourly = {item["hour"]: item for item in cal21["linucb_stats"]["hourly_evaluations"]}

        # 11:00 AM should favor Library with high expected reward and tight uncertainty (~0.2★)
        self.assertEqual(hourly[11]["best_location"], "library")
        self.assertGreaterEqual(hourly[11]["expected_reward"], 4.2)
        self.assertLessEqual(hourly[11]["uncertainty_bound"], 0.28)

        # 23:00 (11:00 PM) should favor Desk (Night-Owl persona)
        self.assertEqual(hourly[23]["best_location"], "desk")
        self.assertGreaterEqual(hourly[23]["expected_reward"], 4.2)

        # 16:00 (4:00 PM) should show afternoon crash
        self.assertLessEqual(hourly[16]["expected_reward"], 2.8)

    def test_5_cut_session_short_and_spillover_reschedule(self):
        self.client.post("/api/demo/set-stage", json={"stage": "day_3_calibrating"})
        cal = self.client.get("/api/calendar").json()
        first_blk = cal["scheduled_blocks"][0]
        blk_id = first_blk["id"]

        cut_resp = self.client.post(
            f"/api/blocks/{blk_id}/cut-short",
            json={"mins_completed": 25, "rating": 2.0, "mood": 2.0, "reason": "tired"}
        )
        self.assertEqual(cut_resp.status_code, 200)
        cut_data = cut_resp.json()
        self.assertEqual(cut_data["cut_block"]["status"], "cut_short")
        self.assertEqual(cut_data["spillover_mins"], 50)
        self.assertGreaterEqual(len(cut_data["rescheduled_blocks"]), 1)

    def test_6_simulate_tick_proactive_outreach(self):
        self.client.post("/api/demo/set-stage", json={"stage": "day_3_calibrating"})
        tick_resp = self.client.post(
            "/api/proactive/simulate-tick",
            json={"force_trigger": "overwhelm_intervention"}
        )
        self.assertEqual(tick_resp.status_code, 200)
        tick_data = tick_resp.json()
        self.assertEqual(tick_data["generated_count"], 1)
        self.assertEqual(tick_data["generated_prompts"][0]["trigger_reason"], "overwhelm_intervention")

    def test_7_staged_approval_engine_propose_pending_approve_and_reject(self):
        self.client.post("/api/demo/set-stage", json={"stage": "day_21_optimized"})
        before_cal = self.client.get("/api/calendar").json()
        before_blocks_count = len(before_cal["scheduled_blocks"])

        # 1. Propose complex multi-operation batch via POST /api/calendar/propose
        propose_resp = self.client.post(
            "/api/calendar/propose",
            json={
                "text": "Push my ML Project study block to tomorrow night and split my 3-hour paper across Wednesday and Thursday",
                "source": "user_chat",
            },
        )
        self.assertEqual(propose_resp.status_code, 200)
        prop_data = propose_resp.json()
        proposal = prop_data["proposal"]
        batch_id = proposal["batch_id"]
        self.assertEqual(proposal["status"], "pending")
        self.assertTrue(proposal["veyzl_audit"]["requires_human_approval"])
        self.assertGreaterEqual(len(proposal["operations"]), 2)
        op_types = [op["op_type"] for op in proposal["operations"]]
        self.assertIn("UPDATE_EVENT", op_types)
        self.assertIn("SPLIT_OR_RESCHEDULE_BLOCK", op_types)

        # Verify live calendar was NOT mutated while proposal is still pending
        mid_cal = self.client.get("/api/calendar").json()
        self.assertEqual(len(mid_cal["scheduled_blocks"]), before_blocks_count)

        # 2. Verify GET /api/calendar/proposals/pending returns full before_state and after_state
        pending_resp = self.client.get("/api/calendar/proposals/pending")
        self.assertEqual(pending_resp.status_code, 200)
        pending_list = pending_resp.json()["proposals"]
        self.assertTrue(any(p["batch_id"] == batch_id for p in pending_list))

        # 3. Approve batch via POST /api/calendar/proposals/{batch_id}/approve
        approve_resp = self.client.post(f"/api/calendar/proposals/{batch_id}/approve", json={})
        self.assertEqual(approve_resp.status_code, 200)
        approved_data = approve_resp.json()
        self.assertEqual(approved_data["status"], "approved")

        # 4. Propose another change and test REJECT flow
        propose2 = self.client.post(
            "/api/calendar/propose",
            json={"text": "Extend my ML project deadline to Sunday", "source": "user_chat"},
        ).json()
        batch_id_2 = propose2["proposal"]["batch_id"]
        reject_resp = self.client.post(
            f"/api/calendar/proposals/{batch_id_2}/reject",
            json={"reason": "Actually keep Friday deadline"},
        )
        self.assertEqual(reject_resp.status_code, 200)
        self.assertEqual(reject_resp.json()["status"], "rejected")


if __name__ == "__main__":
    unittest.main()
