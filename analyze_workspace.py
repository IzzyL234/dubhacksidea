"""
analyze-workspace.py (and importable as analyze_workspace)

FastAPI service endpoint to analyze a study workspace image using the Perceptron VLM API.
Enforces structured JSON output containing:
- clutter_score (integer 1-10)
- lighting_quality (string: 'dim' or 'bright')
- distractions (list of detected objects with label, confidence, and bounding_box)
"""

import base64
import json
import logging
import os
import re
from typing import List, Literal, Optional

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Load environment variables from .env
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
    label: str = Field(..., description="Name of the detected object / distraction")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Model confidence score")
    bounding_box: BoundingBox = Field(..., description="Bounding box enclosing the detected item")


class WorkspaceAnalysisResponse(BaseModel):
    clutter_score: int = Field(..., ge=1, le=10, description="Workspace clutter score from 1 (clean) to 10 (heavily cluttered)")
    lighting_quality: Literal["dim", "bright"] = Field(..., description="Lighting condition of the workspace")
    distractions: List[DetectedDistraction] = Field(default_factory=list, description="List of detected objects or distractions with bounding boxes")
    source: Optional[str] = Field("perceptron_vlm", description="Source of the prediction (e.g. perceptron_vlm or mock_fallback)")


class ImageBase64Payload(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded image string or data URI (data:image/jpeg;base64,...)")


# =====================================================================
# Perceptron VLM JSON Schema definition
# =====================================================================

WORKSPACE_JSON_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "workspace_analysis",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "clutter_score": {
                    "type": "integer",
                    "description": "Workspace clutter score strictly between 1 (minimal clutter) and 10 (extreme clutter)"
                },
                "lighting_quality": {
                    "type": "string",
                    "enum": ["dim", "bright"],
                    "description": "Ambient lighting quality in the scene"
                },
                "distractions": {
                    "type": "array",
                    "description": "List of detected distraction objects or clutter items in the study area",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "Object label (e.g. smartphone, tangled_wires, laptop, snack_wrapper)"},
                            "confidence": {"type": "number", "description": "Detection confidence score between 0.0 and 1.0"},
                            "bounding_box": {
                                "type": "object",
                                "properties": {
                                    "x_min": {"type": "number", "description": "Normalized left coordinate 0.0 to 1.0"},
                                    "y_min": {"type": "number", "description": "Normalized top coordinate 0.0 to 1.0"},
                                    "x_max": {"type": "number", "description": "Normalized right coordinate 0.0 to 1.0"},
                                    "y_max": {"type": "number", "description": "Normalized bottom coordinate 0.0 to 1.0"}
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
            "required": ["clutter_score", "lighting_quality", "distractions"],
            "additionalProperties": False
        }
    }
}

PROMPT_TEXT = (
    "You are an expert AI perceptual vision analyst for study workspaces.\n"
    "Carefully inspect the provided image of the user's study workspace.\n"
    "Identify:\n"
    "1. clutter_score: An integer score from 1 (very clean, organized desk/table) to 10 (disorganized, full of trash/wires/clutter).\n"
    "2. lighting_quality: Strictly either 'dim' or 'bright'.\n"
    "3. distractions: Detect all physical items that can distract or contribute to clutter (e.g. smartphone, tangled wires, snack wrappers, tablets, open books, cups). "
    "For each, provide its label, confidence (0.0 to 1.0), and normalized bounding box [x_min, y_min, x_max, y_max] from 0.0 to 1.0.\n"
    "You must return strictly valid JSON matching the requested schema."
)

# =====================================================================
# Core Analysis Service Logic
# =====================================================================

def _normalize_image_data_uri(image_bytes: bytes, mime_type: str = "image/jpeg") -> str:
    """Encodes raw image bytes into a data URI for multimodal VLM input."""
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    return f"data:{mime_type};base64,{b64}"


def _clean_base64_input(b64_str: str) -> str:
    """Ensures base64 string has the data URI prefix required by VLM APIs."""
    b64_str = b64_str.strip()
    if b64_str.startswith("data:image/"):
        return b64_str
    # Default to jpeg prefix if raw base64 string passed
    return f"data:image/jpeg;base64,{b64_str}"


def _generate_mock_fallback(reason: str) -> WorkspaceAnalysisResponse:
    """
    Realistic fallback workspace analysis response when the remote VLM token
    quota is exceeded or offline during hackathon demos.
    """
    logger.warning("Perceptron VLM API offline or quota exceeded (%s). Returning calibrated fallback.", reason)
    return WorkspaceAnalysisResponse(
        clutter_score=3,
        lighting_quality="bright",
        distractions=[
            DetectedDistraction(
                label="smartphone",
                confidence=0.94,
                bounding_box=BoundingBox(x_min=0.48, y_min=0.35, x_max=0.68, y_max=0.56)
            ),
            DetectedDistraction(
                label="coffee_mug",
                confidence=0.91,
                bounding_box=BoundingBox(x_min=0.22, y_min=0.25, x_max=0.42, y_max=0.52)
            ),
            DetectedDistraction(
                label="tangled_wires",
                confidence=0.82,
                bounding_box=BoundingBox(x_min=0.15, y_min=0.62, x_max=0.38, y_max=0.85)
            )
        ],
        source=f"mock_fallback ({reason})"
    )


async def call_perceptron_vlm(data_uri: str) -> WorkspaceAnalysisResponse:
    """
    Calls Perceptron Mk1.5 / Mk1 VLM API with enforced JSON schema.
    """
    api_token = os.getenv("PERCEPTRON_TOKEN") or os.getenv("PERCEPTRON_API_KEY")
    if not api_token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="PERCEPTRON_TOKEN is not configured in .env"
        )

    try:
        from perceptron import Client
        client = Client(api_key=api_token)

        # Call Perceptron VLM chat completions with strict JSON schema enforcement
        response = client.chat.completions.create(
            model=os.getenv("PERCEPTRON_MODEL", "perceptron-mk1.5"),
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": PROMPT_TEXT},
                        {"type": "image_url", "image_url": {"url": data_uri}}
                    ]
                }
            ],
            response_format=WORKSPACE_JSON_SCHEMA,
            temperature=0.1
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Perceptron VLM returned empty response content")

        # Parse and validate against Pydantic schema
        parsed_data = json.loads(content)
        parsed_data["source"] = "perceptron_vlm"
        return WorkspaceAnalysisResponse(**parsed_data)

    except Exception as e:
        err_msg = str(e)
        logger.error("Perceptron VLM Error: %s", err_msg)
        # If quota is exceeded or rate limited, gracefully serve structured fallback so caller doesn't break
        if "quota" in err_msg.lower() or "billing" in err_msg.lower() or "rate" in err_msg.lower():
            return _generate_mock_fallback(reason=err_msg)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Perceptron VLM API error: {err_msg}"
        )


# =====================================================================
# FastAPI Router and Application Setup
# =====================================================================

router = APIRouter(prefix="", tags=["Workspace Analysis"])

@router.post(
    "/analyze-workspace",
    response_model=WorkspaceAnalysisResponse,
    summary="Analyze workspace image from multipart file upload"
)
async def analyze_workspace_upload(
    file: UploadFile = File(..., description="Workspace image file (JPEG, PNG, WEBP, etc.)")
):
    """
    Upload an image file directly to analyze the study workspace.
    Returns structured JSON with clutter_score, lighting_quality, and detected distractions.
    """
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Uploaded file must be an image, got: {file.content_type}"
        )

    file_bytes = await file.read()
    if len(file_bytes) == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")

    data_uri = _normalize_image_data_uri(file_bytes, file.content_type)
    return await call_perceptron_vlm(data_uri)


@router.post(
    "/analyze-workspace/base64",
    response_model=WorkspaceAnalysisResponse,
    summary="Analyze workspace image from base64 JSON payload"
)
async def analyze_workspace_base64(payload: ImageBase64Payload):
    """
    Send a base64-encoded image string or data URI in a JSON body.
    Useful for webcams or mobile apps sending base64 payloads directly.
    """
    if not payload.image_base64:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="image_base64 is empty")

    data_uri = _clean_base64_input(payload.image_base64)
    return await call_perceptron_vlm(data_uri)


# Standalone FastAPI App
app = FastAPI(
    title="Workspace Environment Analysis Service",
    description="FastAPI service analyzing workspace images via the Perceptron VLM API with enforced structured JSON output.",
    version="1.0.0"
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
    return {
        "status": "healthy",
        "service": "analyze-workspace",
        "perceptron_configured": bool(os.getenv("PERCEPTRON_TOKEN") or os.getenv("PERCEPTRON_API_KEY"))
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("FASTAPI_PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
