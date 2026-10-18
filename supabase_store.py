"""
supabase_store.py

Supabase REST API persistence layer for per-user LinUCB model parameters
(`public.user_model_params`) and workspace photo analysis metadata (`public.workspace_photos_log`).

Uses Python's built-in `urllib.request` against Supabase PostgREST (`/rest/v1/...`),
matching the zero-dependency approach used in `src/sessions.ts` and `src/feedback-cloud.ts`.
Gracefully falls back to local `data/` storage when `SUPABASE_URL` / `SUPABASE_SECRET_KEY`
are not configured or when offline.
"""

import hashlib
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("supabase_store")


def normalize_user_id(raw_user_id: Optional[str]) -> str:
    """
    Normalizes a user/conversation identifier into a consistent key.
    - If already a 64-char SHA-256 hex key (used by `src/sessions.ts` and `src/feedback.ts`), keeps it as-is.
    - If empty or 'default', returns 'default_user'.
    - Otherwise hashes the raw string (phone number, email, space.id) with SHA-256 so PII is not stored in plain text,
      matching `createHash("sha256").update(conversation).digest("hex")` in the TypeScript bot.
    """
    if not raw_user_id or not str(raw_user_id).strip():
        return "default_user"
    cleaned = str(raw_user_id).strip()
    if cleaned == "default_user":
        return "default_user"
    if len(cleaned) == 64 and all(c in "0123456789abcdefABCDEF" for c in cleaned):
        return cleaned.lower()
    return hashlib.sha256(cleaned.encode("utf-8")).hexdigest()


class SupabaseStore:
    """
    Handles reading and upserting per-user model parameters and photo metadata logs in Supabase.
    Tables (defined in `supabase/005_user_models_and_photos.sql`):
      - `public.user_model_params`
      - `public.workspace_photos_log`
      - `public.study_sessions` (read/write compatibility)
      - `public.study_feedback` (read compatibility)
    """

    def __init__(self, url: Optional[str] = None, key: Optional[str] = None):
        raw_url = (url or os.getenv("SUPABASE_URL") or "").strip()
        raw_key = (
            key
            or os.getenv("SUPABASE_SECRET_KEY")
            or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_KEY")
            or ""
        ).strip()

        self.base_url: Optional[str] = None
        self.api_key: Optional[str] = None

        if raw_url and raw_key:
            parsed = urllib.parse.urlparse(raw_url)
            if parsed.scheme == "https" and parsed.netloc:
                self.base_url = f"{parsed.scheme}://{parsed.netloc}"
                self.api_key = raw_key

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.api_key)

    def _headers(self, prefer: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "apikey": self.api_key or "",
            "Authorization": f"Bearer {self.api_key or ''}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        return headers

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Any] = None,
        prefer: Optional[str] = None,
        timeout: float = 10.0,
    ) -> Any:
        if not self.enabled:
            return None

        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(prefer), method=method)

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8").strip()
                if not raw:
                    return True
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8")[:200]
            except Exception:
                pass
            logger.warning("Supabase HTTP %s on %s %s: %s", e.code, method, path, err_body)
            return None
        except Exception as e:
            logger.warning("Supabase request failed on %s %s: %s", method, path, e)
            return None

    # ------------------------------------------------------------------
    # 1. Per-User Model Parameters (`public.user_model_params`)
    # ------------------------------------------------------------------

    def get_user_model_params(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Fetches a user's stored LinUCB model parameters from Supabase."""
        if not self.enabled:
            return None
        uid = urllib.parse.quote(normalize_user_id(user_id), safe="")
        rows = self._request("GET", f"/rest/v1/user_model_params?user_id=eq.{uid}&select=*&limit=1")
        if isinstance(rows, list) and len(rows) > 0:
            return rows[0]
        return None

    def upsert_user_model_params(self, user_id: str, params_record: Dict[str, Any]) -> bool:
        """Upserts a user's LinUCB model parameters (inverse matrix, weights, counts, theta) to Supabase."""
        if not self.enabled:
            return False
        uid = normalize_user_id(user_id)
        payload = {
            "user_id": uid,
            "version": int(params_record.get("version", 1)),
            "observations_count": int(params_record.get("observations_count", 0)),
            "inverse_matrix": params_record.get("inverse_matrix", []),
            "productivity_weights": params_record.get("productivity_weights", []),
            "mood_weights": params_record.get("mood_weights", []),
            "theta_productivity": params_record.get("theta_productivity", []),
            "theta_mood": params_record.get("theta_mood", []),
            "combination_counts": params_record.get("combination_counts", {}),
            "observed_ids": list(params_record.get("observed_ids", [])),
            "updated_at": params_record.get("updated_at") or datetime.now(timezone.utc).isoformat(),
        }
        res = self._request(
            "POST",
            "/rest/v1/user_model_params?on_conflict=user_id",
            body=payload,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        return res is not None

    # ------------------------------------------------------------------
    # 2. Per-User Workspace Photo Log (`public.workspace_photos_log`)
    # ------------------------------------------------------------------

    def insert_photo_log(self, user_id: str, entry: Dict[str, Any]) -> bool:
        """Upserts a workspace photo analysis metadata entry for a user into Supabase."""
        if not self.enabled:
            return False
        uid = normalize_user_id(user_id)
        tags = entry.get("peceptron_tags") or entry.get("perceptron_tags") or {}
        payload = {
            "id": str(entry.get("id")),
            "user_id": uid,
            "session_id": entry.get("session_id") or entry.get("id"),
            "timestamp": entry.get("timestamp") or datetime.now(timezone.utc).isoformat(),
            "duration_mins": int(entry.get("duration_mins") or 45),
            "location": str(entry.get("location") or "home"),
            "study_space": str(entry.get("study_space") or "desk"),
            "location_class": str(
                entry.get("location_class")
                or f"{entry.get('location', 'home')}_{entry.get('study_space', 'desk')}"
            ),
            "peceptron_tags": tags,
            "linucb_metrics": entry.get("linucb_metrics") or {},
            "user_productivity_rating": entry.get("user_productivity_rating"),
            "user_mood_rating": entry.get("user_mood_rating"),
            "user_distraction_rating": entry.get("user_distraction_rating"),
            "distraction_source": entry.get("distraction_source"),
            "sample_weight": float(entry.get("sample_weight", 1.0)),
            "source": str(entry.get("source") or "perceptron_vlm"),
        }
        res = self._request(
            "POST",
            "/rest/v1/workspace_photos_log?on_conflict=id",
            body=payload,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        return res is not None

    def update_photo_rating(
        self,
        session_id: str,
        productivity_rating: int,
        mood_rating: int,
        distraction_rating: Optional[int] = None,
        distraction_source: Optional[str] = None,
        sample_weight: float = 1.0,
    ) -> Optional[Dict[str, Any]]:
        """Updates a logged photo row in Supabase with user ratings and returns the updated row if found."""
        if not self.enabled or not session_id:
            return None
        sid = urllib.parse.quote(str(session_id), safe="")
        patch_body: Dict[str, Any] = {
            "user_productivity_rating": int(round(productivity_rating)),
            "user_mood_rating": int(round(mood_rating)),
            "sample_weight": float(sample_weight),
        }
        if distraction_rating is not None:
            patch_body["user_distraction_rating"] = int(distraction_rating)
        if distraction_source in ("surroundings", "phone", "other"):
            patch_body["distraction_source"] = distraction_source

        # Match either id or session_id
        rows = self._request(
            "PATCH",
            f"/rest/v1/workspace_photos_log?or=(id.eq.{sid},session_id.eq.{sid})",
            body=patch_body,
            prefer="return=representation",
        )
        if isinstance(rows, list) and len(rows) > 0:
            return rows[0]
        return None

    def get_user_photos_log(self, user_id: Optional[str] = None, limit: int = 100) -> Optional[List[Dict[str, Any]]]:
        """Fetches workspace photo analysis records from Supabase (filtered by user_id if provided)."""
        if not self.enabled:
            return None
        query = f"/rest/v1/workspace_photos_log?select=*&order=timestamp.asc&limit={int(limit)}"
        if user_id:
            uid = urllib.parse.quote(normalize_user_id(user_id), safe="")
            query += f"&user_id=eq.{uid}"
        rows = self._request("GET", query)
        return rows if isinstance(rows, list) else None

    def get_photo_by_session_id(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Finds a photo record by `id` or `session_id` to resolve which user owns the session."""
        if not self.enabled or not session_id:
            return None
        sid = urllib.parse.quote(str(session_id), safe="")
        rows = self._request(
            "GET",
            f"/rest/v1/workspace_photos_log?or=(id.eq.{sid},session_id.eq.{sid})&select=*&limit=1",
        )
        if isinstance(rows, list) and len(rows) > 0:
            return rows[0]
        return None


# Singleton store instance
supabase_store = SupabaseStore()
