"""
analyze_workspace.py

FastAPI backend service that processes workspace photos sent from Photon (iMessage)
or other clients using the Perceptron VLM API and the per-user LinUCB study space learner.

Features:
1. Photo is sent (with `user_id` / `participant`) -> Perceptron VLM scores clutter, lighting, ergonomics, location, study_space, and detected objects.
2. Logs the photo analysis metadata (just the data, no raw image bytes) per user to Supabase (`public.workspace_photos_log`) and local cache.
3. Evaluates the study space using the specific user's LinUCB contextual-bandit model (`public.user_model_params` in Supabase).
4. Returns the LinUCB space score, predicted productivity, predicted mood, and personalized recommendations for both proven old study spaces and unexplored study spaces.
5. Integrates with the follow-up rating flow (`rate session` / `done`) to update that user's LinUCB model parameters in Supabase.
"""

import base64
import io
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional, Tuple

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Query, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field

# Enable automatic iPhone HEIC/HEIF image decoding
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

from ml_focus_model import focus_model
from supabase_store import normalize_user_id, supabase_store

# Load environment variables
load_dotenv(".env")

logger = logging.getLogger("analyze_workspace")
logging.basicConfig(level=logging.INFO)

# =====================================================================
# Pydantic Schemas for Structured JSON Output
# =====================================================================

class BoundingBox(BaseModel):
    x_min: float = Field(..., ge=0.0, le=1.0, description="Normalized x_min (0.0 - 1.0)")
    y_min: float = Field(..., ge=0.0, le=1.0, description="Normalized y_min (0.0 - 1.0)")
    x_max: float = Field(..., ge=0.0, le=1.0, description="Normalized x_max (0.0 - 1.0)")
    y_max: float = Field(..., ge=0.0, le=1.0, description="Normalized y_max (0.0 - 1.0)")


class DetectedDistraction(BaseModel):
    label: str = Field(..., description="Name of the detected object or distraction")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Detection confidence score")
    bounding_box: BoundingBox = Field(..., description="Normalized bounding box")


class SpaceRecommendationItem(BaseModel):
    id: str
    label: str
    location: str
    study_space: str
    visits: int
    is_unexplored: bool
    predicted_productivity: float
    predicted_mood: float
    selection_score: float
    exploration_bonus: float


class WorkspaceAnalysisResponse(BaseModel):
    session_id: str = Field(..., description="Unique ID for this analyzed session")
    user_id: str = Field("default_user", description="Normalized per-user identifier stored in Supabase")
    timestamp: str = Field(..., description="ISO 8601 timestamp")
    location: Literal["library", "classroom", "cafe", "dorm_room", "home", "other"] = Field(
        ..., description="Detected macro location"
    )
    study_space: Literal["desk", "shared_table", "chair", "beanbag", "bed", "other"] = Field(
        ..., description="Detected micro work surface or seating"
    )
    clutter_score: int = Field(..., ge=0, le=10, description="Clutter score from 0 (pristine) to 10 (extreme clutter)")
    lighting_quality: Literal["dim", "bright"] = Field(..., description="Lighting condition")
    ergonomics_score: int = Field(..., ge=0, le=10, description="Ergonomics rating from 0 (poor) to 10 (great)")
    distractions: List[DetectedDistraction] = Field(default_factory=list, description="Detected objects and clutter")
    focus_score: int = Field(..., ge=0, le=100, description="Focus score from 0 (distracted) to 100 (peak focus)")
    predicted_productivity: float = Field(..., ge=1.0, le=5.0, description="LinUCB predicted productivity rating (1-5)")
    predicted_mood: float = Field(4.0, ge=1.0, le=5.0, description="LinUCB predicted mood rating (1-5)")
    selection_score: float = Field(4.0, description="LinUCB selection score (expected utility + exploration bonus)")
    exploration_bonus: float = Field(0.1, description="LinUCB uncertainty exploration bonus")
    recommendations: Optional[Dict[str, Optional[SpaceRecommendationItem]]] = Field(
        None, description="Recommended proven and unexplored study spaces from LinUCB"
    )
    summary: str = Field(..., description="Concise assessment summary")
    reply_text: str = Field(..., description="Formatted text response optimized for Photon / iMessage")
    source: str = Field("perceptron_vlm", description="Origin of perception data (live VLM or fallback)")


class ImageBase64Payload(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded image or data URI")
    user_id: Optional[str] = Field(None, description="Optional user identifier or conversation key")
    participant: Optional[str] = Field(None, description="Optional sender identifier (phone or email from Photon)")


class SessionRatingPayload(BaseModel):
    session_id: str = Field(..., description="ID of the session to rate")
    user_id: Optional[str] = Field(None, description="Optional user identifier or conversation key")
    actual_rating: float = Field(..., ge=1.0, le=5.0, description="User's actual productivity rating (1.0 - 5.0)")
    mood_rating: Optional[float] = Field(None, ge=1.0, le=5.0, description="Optional user mood rating (1.0 - 5.0)")
    distraction_rating: Optional[int] = Field(None, ge=1, le=5, description="Optional distraction rating (1 - 5)")
    distraction_source: Optional[str] = Field(None, description="Optional distraction source (surroundings, phone, other)")


# =====================================================================
# Perceptron VLM JSON Schema Definition
# =====================================================================

PERCEPTRON_VLM_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "workspace_environment_analysis",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "enum": ["library", "classroom", "cafe", "dorm_room", "home", "other"],
                    "description": "General setting: library, classroom, cafe, dorm_room, home, or other"
                },
                "study_space": {
                    "type": "string",
                    "enum": ["desk", "shared_table", "chair", "beanbag", "bed", "other"],
                    "description": "Immediate surface/seating: desk, shared_table, chair, beanbag, bed, or other"
                },
                "clutter_score": {
                    "type": "integer",
                    "description": "Clutter score between 0 (very clean, organized) and 10 (very cluttered, messy)"
                },
                "lighting_quality": {
                    "type": "string",
                    "enum": ["dim", "bright"],
                    "description": "Ambient lighting condition in the workspace"
                },
                "ergonomics_score": {
                    "type": "integer",
                    "description": "Ergonomics score between 0 (poor posture, floor/bed) and 10 (supportive chair & desk)"
                },
                "summary": {
                    "type": "string",
                    "description": "A brief one-sentence observation of the study setup"
                },
                "distractions": {
                    "type": "array",
                    "description": "List of physical objects visible in the study area",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "Object name (e.g. smartphone, laptop, snack_wrapper, headphones)"},
                            "confidence": {"type": "number", "description": "Confidence score 0.0 to 1.0"},
                            "bounding_box": {
                                "type": "object",
                                "properties": {
                                    "x_min": {"type": "number", "description": "Normalized left edge 0.0 to 1.0"},
                                    "y_min": {"type": "number", "description": "Normalized top edge 0.0 to 1.0"},
                                    "x_max": {"type": "number", "description": "Normalized right edge 0.0 to 1.0"},
                                    "y_max": {"type": "number", "description": "Normalized bottom edge 0.0 to 1.0"}
                                },
                                "required": ["x_min", "y_min", "x_max", "y_max"],
                                "additionalProperties": False
                            }
                        },
                        "required": ["label", "confidence", "bounding_box"],
                        "additionalProperties": False
                    }
                }
            },
            "required": [
                "location",
                "study_space",
                "clutter_score",
                "lighting_quality",
                "ergonomics_score",
                "summary",
                "distractions"
            ],
            "additionalProperties": False
        }
    }
}

PROMPT_TEXT = (
    "You are an expert AI workspace perception analyst.\n"
    "Analyze the provided image of the user's study workspace.\n"
    "Extract all characteristics:\n"
    "1. location: macro setting ('library', 'classroom', 'cafe', 'dorm_room', 'home', or 'other').\n"
    "2. study_space: micro space ('desk', 'shared_table', 'chair', 'beanbag', 'bed', or 'other').\n"
    "3. clutter_score: 0 to 10 (0=pristine, 10=extremely messy/cluttered).\n"
    "4. lighting_quality: strictly 'dim' or 'bright'.\n"
    "5. ergonomics_score: 0 to 10 (0=slouched on bed/couch, 10=ergonomic chair & elevated monitor).\n"
    "6. distractions: detect visible objects (laptop, smartphone, cables, notes, food, etc.) with normalized bounding boxes [0.0 to 1.0].\n"
    "7. summary: brief one-sentence assessment.\n"
    "Return strictly valid JSON conforming to the schema."
)

# =====================================================================
# Image Preprocessing & Normalization
# =====================================================================

def prepare_image_for_vlm(raw_bytes: bytes) -> str:
    """
    Decodes image bytes (including iPhone HEIC/HEIF, PNG, WEBP),
    resizes high-res camera photos to max 1920x1920 for fast VLM transmission,
    and returns a clean data:image/jpeg;base64 URI.
    """
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
        out_buf = io.BytesIO()
        img.save(out_buf, format="JPEG", quality=85, optimize=True)
        jpeg_bytes = out_buf.getvalue()
        b64 = base64.b64encode(jpeg_bytes).decode("utf-8")
        return f"data:image/jpeg;base64,{b64}"
    except Exception as e:
        logger.warning("Pillow could not optimize image, falling back to raw bytes: %s", e)
        b64 = base64.b64encode(raw_bytes).decode("utf-8")
        return f"data:image/jpeg;base64,{b64}"


def _format_photon_reply(
    location: str,
    study_space: str,
    clutter_score: int,
    lighting_quality: str,
    ergonomics_score: int,
    distractions: List[Any],
    focus_score: int,
    predicted_prod: float,
    predicted_mood: float,
    selection_score: float,
    recommendations: Dict[str, Any],
    session_id: str
) -> str:
    """Formats a structured analysis report + LinUCB recommendation into an iMessage response."""
    light_icon = "☀️ Bright" if lighting_quality == "bright" else "🌙 Dim"
    distraction_names = [
        d.label if hasattr(d, "label") else d.get("label", "item")
        for d in distractions[:4]
    ]
    distractions_str = ", ".join(distraction_names) if distraction_names else "None detected"
    clutter_desc = "Clean" if clutter_score <= 3 else ("Moderate" if clutter_score <= 6 else "Heavy clutter")

    if focus_score >= 80:
        badge = "🔥 Prime Focus"
    elif focus_score >= 50:
        badge = "⚡ Moderate Focus"
    else:
        badge = "⚠️ High Distraction Risk"

    rec_lines = []
    top_known = (recommendations or {}).get("top_known")
    top_unexplored = (recommendations or {}).get("top_unexplored")

    if focus_score < 70 and top_known:
        rec_lines.append(f"💡 Best proven spot: {top_known['label']} (Score {top_known['selection_score']:.2f})")
    if top_unexplored:
        rec_lines.append(f"🧭 Try unexplored spot: {top_unexplored['label']} (LinUCB {top_unexplored['selection_score']:.2f})")

    rec_block = ("\n" + "\n".join(rec_lines) + "\n") if rec_lines else "\n"

    return (
        f"📸 Workspace Analysis ({badge})\n"
        f"• Location: {location.replace('_', ' ').title()} ({study_space.replace('_', ' ').title()})\n"
        f"• Lighting: {light_icon}\n"
        f"• Clutter: {clutter_score}/10 ({clutter_desc})\n"
        f"• Ergonomics: {ergonomics_score}/10\n"
        f"• Visible items: {distractions_str}\n"
        f"━━━━━━━━━━━━━━\n"
        f"🎯 Focus Score: {focus_score}/100 (LinUCB: {selection_score:.2f})\n"
        f"📊 Predicted Productivity: {predicted_prod:.1f}/5 | Mood: {predicted_mood:.1f}/5"
        f"{rec_block}\n"
        f"When finished studying, text 'done' or 'rate session' for your follow-up check-in!"
    )


def _generate_mock_fallback(reason: str) -> Dict[str, Any]:
    """Fallback perception output when Perceptron token quota is exhausted or offline."""
    logger.warning("Using calibrated Perceptron fallback (%s)", reason)
    return {
        "location": "library",
        "study_space": "desk",
        "clutter_score": 2,
        "lighting_quality": "bright",
        "ergonomics_score": 9,
        "summary": "Clean, well-lit library desk setup with minimal visual distractions.",
        "distractions": [
            {
                "label": "laptop",
                "confidence": 0.98,
                "bounding_box": {"x_min": 0.25, "y_min": 0.30, "x_max": 0.65, "y_max": 0.70}
            },
            {
                "label": "notebook",
                "confidence": 0.91,
                "bounding_box": {"x_min": 0.68, "y_min": 0.45, "x_max": 0.90, "y_max": 0.80}
            },
            {
                "label": "coffee_mug",
                "confidence": 0.88,
                "bounding_box": {"x_min": 0.15, "y_min": 0.20, "x_max": 0.30, "y_max": 0.45}
            }
        ]
    }


async def _execute_vlm_analysis(data_uri: str) -> Tuple[Dict[str, Any], str]:
    """Invokes Perceptron Mk1.5 VLM with enforced structured JSON schema."""
    token = os.getenv("PERCEPTRON_TOKEN") or os.getenv("PERCEPTRON_API_KEY")
    if not token:
        logger.warning("PERCEPTRON_TOKEN missing in .env, using calibrated mock.")
        return _generate_mock_fallback("PERCEPTRON_TOKEN not configured"), "mock_fallback"

    try:
        from perceptron import Client
        client = Client(api_key=token, provider="perceptron")

        model_name = os.getenv("PERCEPTRON_MODEL", "perceptron-mk1.5")
        logger.info("Calling Perceptron VLM model=%s...", model_name)

        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": PROMPT_TEXT},
                        {"type": "image_url", "image_url": {"url": data_uri}}
                    ]
                }
            ],
            response_format=PERCEPTRON_VLM_SCHEMA,
            temperature=0.1
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Perceptron returned empty response content")

        logger.info("Perceptron VLM raw output: %s", content)
        return json.loads(content), "perceptron_vlm"

    except Exception as e:
        err_msg = str(e)
        logger.error("Perceptron VLM Call Failed: %s", err_msg)
        return _generate_mock_fallback(f"Perceptron fallback ({err_msg})"), "mock_fallback"


def _process_and_score_session(
    vlm_data: Dict[str, Any],
    source: str = "perceptron_vlm",
    user_id: Optional[str] = None,
) -> WorkspaceAnalysisResponse:
    """
    Feeds VLM characteristics into the user's LinUCB model, generates scores & space recommendations,
    formats the Photon SMS reply, and logs the photo data to Supabase (`workspace_photos_log`) & local cache.
    """
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    uid = normalize_user_id(user_id)
    ts = datetime.now(timezone.utc).isoformat()

    loc = vlm_data.get("location", "home")
    space = vlm_data.get("study_space", "desk")
    clutter = max(0, min(10, int(vlm_data.get("clutter_score", 3))))
    lighting = vlm_data.get("lighting_quality", "bright")
    ergo = max(0, min(10, int(vlm_data.get("ergonomics_score", 7))))
    distractions_raw = vlm_data.get("distractions", [])
    summary_text = vlm_data.get("summary", "Workspace session analyzed.")

    # 1. Run per-user LinUCB Model prediction & space recommendations
    ml_result = focus_model.predict(
        clutter_score=max(1, clutter),
        lighting_quality=lighting,
        ergonomics_score=max(1, ergo),
        location=loc,
        study_space=space,
        distractions=distractions_raw,
        user_id=uid,
    )
    focus_score = ml_result["focus_score"]
    predicted_prod = ml_result["predicted_productivity"]
    predicted_mood = ml_result.get("predicted_mood", 4.0)
    selection_score = ml_result.get("selection_score", 4.0)
    exploration_bonus = ml_result.get("exploration_bonus", 0.1)
    recommendations = ml_result.get("recommendations", {})

    # 2. Convert raw distraction objects to Pydantic items & serializable dicts
    distraction_items = []
    distraction_dicts = []
    for d in distractions_raw:
        bbox = d.get("bounding_box", {"x_min": 0.0, "y_min": 0.0, "x_max": 0.0, "y_max": 0.0})
        clamped_bbox = BoundingBox(
            x_min=max(0.0, min(1.0, float(bbox.get("x_min", 0.0)))),
            y_min=max(0.0, min(1.0, float(bbox.get("y_min", 0.0)))),
            x_max=max(0.0, min(1.0, float(bbox.get("x_max", 1.0)))),
            y_max=max(0.0, min(1.0, float(bbox.get("y_max", 1.0))))
        )
        item = DetectedDistraction(
            label=d.get("label", "item"),
            confidence=float(d.get("confidence", 0.9)),
            bounding_box=clamped_bbox
        )
        distraction_items.append(item)
        distraction_dicts.append(item.model_dump())

    # 3. Format Photon reply message
    reply_text = _format_photon_reply(
        location=loc,
        study_space=space,
        clutter_score=clutter,
        lighting_quality=lighting,
        ergonomics_score=ergo,
        distractions=distraction_items,
        focus_score=focus_score,
        predicted_prod=predicted_prod,
        predicted_mood=predicted_mood,
        selection_score=selection_score,
        recommendations=recommendations,
        session_id=session_id
    )

    # 4. Log photo data per user (no image bytes) to Supabase `workspace_photos_log` & local fallback
    session_record = {
        "id": session_id,
        "user_id": uid,
        "timestamp": ts,
        "duration_mins": 45,
        "location": loc,
        "study_space": space,
        "clutter_score": max(1, clutter),
        "lighting_quality": lighting,
        "ergonomics_score": max(1, ergo),
        "distractions": distraction_dicts,
        "focus_score": focus_score,
        "predicted_productivity": predicted_prod,
        "predicted_mood": predicted_mood,
        "selection_score": selection_score,
        "exploration_bonus": exploration_bonus,
        "source": source
    }
    focus_model.log_photo_analysis(session_record, user_id=uid)

    return WorkspaceAnalysisResponse(
        session_id=session_id,
        user_id=uid,
        timestamp=ts,
        location=loc,
        study_space=space,
        clutter_score=clutter,
        lighting_quality=lighting,
        ergonomics_score=ergo,
        distractions=distraction_items,
        focus_score=focus_score,
        predicted_productivity=predicted_prod,
        predicted_mood=predicted_mood,
        selection_score=selection_score,
        exploration_bonus=exploration_bonus,
        recommendations=recommendations,
        summary=summary_text,
        reply_text=reply_text,
        source=source
    )


# =====================================================================
# API Endpoints
# =====================================================================

router = APIRouter(prefix="", tags=["Workspace Analysis & LinUCB"])

@router.post(
    "/analyze-workspace",
    response_model=WorkspaceAnalysisResponse,
    summary="Process photo from multipart upload (sent from Photon bridge or client)"
)
async def analyze_workspace_upload(
    file: UploadFile = File(..., description="Workspace photo (JPEG, PNG, HEIC, etc.)"),
    user_id: Optional[str] = Form(None, description="Optional user identifier or conversation key"),
    query_user_id: Optional[str] = Query(None, alias="user_id", description="Optional user_id query param"),
):
    """
    Accepts image file upload from Photon, converts/optimizes the photo,
    calls Perceptron VLM, logs photo data to Supabase per user, and scores with that user's LinUCB model.
    """
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Empty image file received.")

    effective_uid = user_id or query_user_id
    data_uri = prepare_image_for_vlm(file_bytes)
    vlm_result, source = await _execute_vlm_analysis(data_uri)
    return _process_and_score_session(vlm_result, source=source, user_id=effective_uid)


@router.post(
    "/analyze-workspace/base64",
    response_model=WorkspaceAnalysisResponse,
    summary="Process photo from base64 string (JSON payload)"
)
async def analyze_workspace_base64(payload: ImageBase64Payload):
    """
    Accepts base64 image payload from Photon or mobile apps.
    """
    raw_b64 = payload.image_base64.strip()
    if not raw_b64:
        raise HTTPException(status_code=400, detail="image_base64 is required.")

    if "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1]

    raw_bytes = base64.b64decode(raw_b64)
    data_uri = prepare_image_for_vlm(raw_bytes)

    effective_uid = payload.user_id or payload.participant
    vlm_result, source = await _execute_vlm_analysis(data_uri)
    return _process_and_score_session(vlm_result, source=source, user_id=effective_uid)


@router.get(
    "/api/photos-log",
    summary="Retrieve the log of analyzed workspace photos per user (metadata only, no image bytes)"
)
async def get_photos_log(user_id: Optional[str] = Query(None, description="Optional user_id filter")):
    photos = focus_model.get_photos_log(user_id=user_id)
    return {
        "user_id": normalize_user_id(user_id) if user_id else "all",
        "supabase_connected": supabase_store.enabled,
        "count": len(photos),
        "photos": photos
    }


@router.get(
    "/api/recommendations",
    summary="Get personalized LinUCB study space recommendations for a user"
)
async def get_space_recommendations(
    user_id: Optional[str] = Query(None, description="Optional user identifier"),
    duration_mins: int = Query(45, ge=5, le=240),
    alpha: float = Query(0.35, ge=0.0, le=5.0)
):
    learner = focus_model.get_or_load_user_learner(user_id)
    recs = learner.recommend_spaces(duration_mins=duration_mins, alpha=alpha)
    return {
        "user_id": normalize_user_id(user_id),
        "observations_count": learner.count,
        **recs,
    }


@router.post(
    "/api/rate-session",
    summary="Submit user productivity & mood feedback to update the user's LinUCB model in Supabase"
)
async def rate_session(payload: SessionRatingPayload):
    """
    Updates the logged photo session with the user's post-session ratings and updates
    that user's LinUCB model parameters in Supabase (`user_model_params`).
    """
    updated_state = focus_model.update_parameters(
        session_data={"session_id": payload.session_id, "user_id": payload.user_id},
        actual_user_rating=payload.actual_rating,
        actual_mood_rating=payload.mood_rating,
        distraction_rating=payload.distraction_rating,
        distraction_source=payload.distraction_source,
        user_id=payload.user_id,
    )
    return {
        "status": "success",
        "user_id": updated_state.get("user_id"),
        "supabase_synced": supabase_store.enabled,
        "message": f"LinUCB model updated for session {payload.session_id} with rating {payload.actual_rating}",
        "new_version": updated_state.get("version"),
        "observations_count": updated_state.get("observations_count")
    }


@router.get("/api/ml-parameters", summary="Inspect current LinUCB model parameters and weights for a user")
async def get_ml_parameters(user_id: Optional[str] = Query(None, description="Optional user identifier")):
    learner = focus_model.get_or_load_user_learner(user_id)
    return learner.to_state_dict(user_id or "default_user")


# Standalone App
app = FastAPI(
    title="Photon-Perceptron-LinUCB Workspace AI Service",
    description="FastAPI service analyzing photos from Photon via Perceptron VLM, logging photo metadata per user in Supabase, and scoring/recommending study spaces with per-user LinUCB models.",
    version="3.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

@app.get("/health", tags=["Health"])
async def health_check():
    token = os.getenv("PERCEPTRON_TOKEN") or os.getenv("PERCEPTRON_API_KEY")
    return {
        "status": "healthy",
        "service": "analyze_workspace",
        "version": "3.1.0",
        "perceptron_configured": bool(token),
        "supabase_configured": supabase_store.enabled,
        "ml_model_version": focus_model.weights.get("version", 1),
        "observations_trained": focus_model.learner.count
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("FASTAPI_PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
