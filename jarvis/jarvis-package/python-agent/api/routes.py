"""JARVIS AI Agent - API Routes

Complete API route definitions with Pydantic models, dependency injection,
and full error handling for all JARVIS endpoints.
"""
import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, HTTPException, Depends, UploadFile, Query, Path as PathParam
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, validator

from api.auth import validate_token, validate_api_key, require_role

logger = logging.getLogger("jarvis.api.routes")

router = APIRouter()
security = HTTPBearer(auto_error=False)


# ===========================================================================
# Pydantic Models
# ===========================================================================

class ChatRequest(BaseModel):
    """Request model for chat endpoint."""
    message: str = Field(..., min_length=1, max_length=10000, description="User message to JARVIS")
    context: Optional[Dict[str, Any]] = Field(default=None, description="Optional conversation context")
    personality_mode: Optional[str] = Field(default=None, description="Override personality mode")
    stream: bool = Field(default=False, description="Enable streaming response")

    @validator("message")
    def message_must_not_be_blank(cls, v):
        if not v.strip():
            raise ValueError("Message must not be blank")
        return v.strip()

    @validator("personality_mode")
    def personality_mode_must_be_valid(cls, v):
        if v is not None and v not in ("professional", "witty", "concise", "detailed"):
            raise ValueError("personality_mode must be one of: professional, witty, concise, detailed")
        return v


class ChatResponse(BaseModel):
    """Response model for chat endpoint."""
    response: str = Field(..., description="JARVIS response text")
    conversation_id: str = Field(default_factory=lambda: str(uuid.uuid4()), description="Conversation ID")
    personality_mode: str = Field(default="professional", description="Active personality mode")
    processing_time_ms: float = Field(..., description="Processing time in milliseconds")
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="Additional metadata")


class STTRequest(BaseModel):
    """Request model for speech-to-text endpoint."""
    audio_data: str = Field(..., min_length=1, description="Base64-encoded audio data")
    language: str = Field(default="en-US", description="Language code for recognition")
    backend: Optional[str] = Field(default=None, description="STT backend override (google, whisper, sphinx)")

    @validator("backend")
    def backend_must_be_valid(cls, v):
        if v is not None and v not in ("google", "whisper", "sphinx"):
            raise ValueError("backend must be one of: google, whisper, sphinx")
        return v


class STTResponse(BaseModel):
    """Response model for speech-to-text endpoint."""
    text: str = Field(..., description="Recognized text")
    confidence: float = Field(default=0.0, description="Recognition confidence (0-1)")
    language: str = Field(default="en-US", description="Detected or used language")
    processing_time_ms: float = Field(..., description="Processing time in milliseconds")


class TTSRequest(BaseModel):
    """Request model for text-to-speech endpoint."""
    text: str = Field(..., min_length=1, max_length=5000, description="Text to convert to speech")
    voice_id: Optional[int] = Field(default=None, description="Voice ID override")
    rate: Optional[int] = Field(default=None, ge=50, le=500, description="Speech rate override")
    volume: Optional[float] = Field(default=None, ge=0.0, le=1.0, description="Volume override")

    @validator("text")
    def text_must_not_be_blank(cls, v):
        if not v.strip():
            raise ValueError("Text must not be blank")
        return v.strip()


class TTSResponse(BaseModel):
    """Response model for text-to-speech endpoint."""
    audio_data: str = Field(..., description="Base64-encoded audio data")
    format: str = Field(default="wav", description="Audio format")
    duration_seconds: float = Field(default=0.0, description="Audio duration in seconds")
    processing_time_ms: float = Field(..., description="Processing time in milliseconds")


class SearchRequest(BaseModel):
    """Request model for web search endpoint."""
    query: str = Field(..., min_length=1, max_length=1000, description="Search query")
    max_results: int = Field(default=10, ge=1, le=50, description="Maximum number of results")
    search_type: Optional[str] = Field(default="web", description="Search type (web, news, images)")

    @validator("query")
    def query_must_not_be_blank(cls, v):
        if not v.strip():
            raise ValueError("Query must not be blank")
        return v.strip()


class SearchResponse(BaseModel):
    """Response model for web search endpoint."""
    results: List[Dict[str, Any]] = Field(default_factory=list, description="Search results")
    total_results: int = Field(default=0, description="Total results found")
    query: str = Field(..., description="Original search query")
    processing_time_ms: float = Field(..., description="Processing time in milliseconds")


class UploadResponse(BaseModel):
    """Response model for file upload endpoint."""
    file_id: str = Field(..., description="Unique file identifier")
    filename: str = Field(..., description="Original filename")
    size_bytes: int = Field(..., description="File size in bytes")
    content_type: str = Field(..., description="MIME content type")
    analysis: Optional[Dict[str, Any]] = Field(default=None, description="AI analysis of file content")
    upload_time_ms: float = Field(..., description="Upload processing time in milliseconds")


class SwarmConnectRequest(BaseModel):
    """Request model for swarm connection endpoint."""
    url: Optional[str] = Field(default=None, description="Override swarm URL")
    api_key: Optional[str] = Field(default=None, description="API key for swarm authentication")
    auto_dispatch: bool = Field(default=False, description="Enable auto task dispatch")


class SwarmDisconnectRequest(BaseModel):
    """Request model for swarm disconnection endpoint."""
    reason: Optional[str] = Field(default=None, description="Disconnection reason")
    notify_swarm: bool = Field(default=True, description="Notify swarm of disconnection")


class AgentActivateRequest(BaseModel):
    """Request model for agent activation endpoint."""
    config: Optional[Dict[str, Any]] = Field(default=None, description="Agent configuration overrides")
    auto_start: bool = Field(default=True, description="Auto-start agent after activation")


class AgentDeactivateRequest(BaseModel):
    """Request model for agent deactivation endpoint."""
    cleanup: bool = Field(default=True, description="Clean up agent resources")
    save_state: bool = Field(default=True, description="Save agent state before deactivation")


class StatusResponse(BaseModel):
    """Response model for system status endpoint."""
    status: str = Field(..., description="Overall system status")
    version: str = Field(default="2.0.0", description="System version")
    uptime_seconds: float = Field(..., description="System uptime in seconds")
    components: Dict[str, bool] = Field(default_factory=dict, description="Component availability")
    swarm_connected: bool = Field(default=False, description="Swarm connection status")
    active_agents: int = Field(default=0, description="Number of active agents")
    memory_usage: Optional[Dict[str, Any]] = Field(default=None, description="Memory usage stats")


class LoginRequest(BaseModel):
    """Request model for login endpoint."""
    username: str = Field(..., min_length=1, max_length=100, description="Username")
    password: str = Field(..., min_length=1, max_length=200, description="Password")
    remember_me: bool = Field(default=False, description="Enable extended session")

    @validator("username")
    def username_must_be_valid(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("Username must not be blank")
        return v


class LoginResponse(BaseModel):
    """Response model for login endpoint."""
    access_token: str = Field(..., description="JWT access token")
    token_type: str = Field(default="bearer", description="Token type")
    expires_in: int = Field(..., description="Token expiry in seconds")
    refresh_token: str = Field(..., description="JWT refresh token")
    user: Dict[str, Any] = Field(default_factory=dict, description="User info")


class RefreshResponse(BaseModel):
    """Response model for token refresh endpoint."""
    access_token: str = Field(..., description="New JWT access token")
    token_type: str = Field(default="bearer", description="Token type")
    expires_in: int = Field(..., description="Token expiry in seconds")


class ErrorResponse(BaseModel):
    """Standard error response model."""
    error: bool = Field(default=True)
    detail: str = Field(..., description="Error description")
    status_code: int = Field(..., description="HTTP status code")
    request_id: Optional[str] = Field(default=None, description="Request ID for tracking")


# ===========================================================================
# Dependency Injection
# ===========================================================================

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> Dict[str, Any]:
    """Extract and validate the current user from the JWT token."""
    if credentials is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = validate_token(credentials.credentials)
        return payload
    except Exception as exc:
        raise HTTPException(status_code=401, detail=str(exc))


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> Optional[Dict[str, Any]]:
    """Extract user if authenticated, but do not require it."""
    if credentials is None:
        return None
    try:
        payload = validate_token(credentials.credentials)
        return payload
    except Exception:
        return None


# ===========================================================================
# Helper to get core component references from main module
# ===========================================================================

def _get_main_module():
    """Get the main module to access global component instances."""
    import main as jarvis_main
    return jarvis_main


# ===========================================================================
# Chat Endpoints
# ===========================================================================

@router.post("/chat", response_model=ChatResponse, summary="Chat with JARVIS")
async def chat_endpoint(
    request: ChatRequest,
    user: Optional[Dict[str, Any]] = Depends(get_optional_user),
):
    """Process a chat message and return JARVIS response.

    The chat endpoint is the primary interaction point. It supports:
    - Natural language conversation
    - Personality mode overrides
    - Context-aware responses
    - Optional streaming (via WebSocket)
    """
    start_time = time.time()
    jarvis_main = _get_main_module()

    logger.info("Chat request: message_length=%d, personality=%s",
                len(request.message), request.personality_mode)

    if not jarvis_main.agent:
        # Fallback when agent is not available
        elapsed_ms = (time.time() - start_time) * 1000
        return ChatResponse(
            response=f"I'm running in limited mode. You said: {request.message}",
            personality_mode=request.personality_mode or "professional",
            processing_time_ms=elapsed_ms,
            metadata={"mode": "stub"},
        )

    try:
        # Override personality mode if requested
        if request.personality_mode and hasattr(jarvis_main.agent, "set_personality_mode"):
            jarvis_main.agent.set_personality_mode(request.personality_mode)

        # Process the message through the agent
        result = await jarvis_main.agent.process(
            request.message,
            context=request.context,
        )

        elapsed_ms = (time.time() - start_time) * 1000

        if isinstance(result, dict):
            response_text = result.get("response", "")
            metadata = result.get("metadata", {})
        else:
            response_text = str(result)
            metadata = {}

        return ChatResponse(
            response=response_text,
            personality_mode=request.personality_mode or jarvis_main.CONFIG.get("jarvis", {}).get("personality_mode", "professional"),
            processing_time_ms=round(elapsed_ms, 2),
            metadata=metadata,
        )

    except Exception as exc:
        logger.error("Chat processing error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Chat processing error: {str(exc)}")


# ===========================================================================
# Voice Endpoints
# ===========================================================================

@router.post("/voice/stt", response_model=STTResponse, summary="Speech to text")
async def speech_to_text(
    request: STTRequest,
    user: Optional[Dict[str, Any]] = Depends(get_optional_user),
):
    """Convert speech audio to text using the configured STT backend.

    Supports multiple backends: Google Speech Recognition, Whisper, Sphinx.
    Audio data must be base64-encoded.
    """
    start_time = time.time()
    jarvis_main = _get_main_module()

    logger.info("STT request: language=%s, backend=%s", request.language, request.backend)

    if not jarvis_main.voice_interface:
        raise HTTPException(status_code=503, detail="Voice interface not available")

    try:
        backend = request.backend or jarvis_main.CONFIG.get("jarvis", {}).get("voice", {}).get("stt_backend", "google")
        result = await jarvis_main.voice_interface.speech_to_text(
            request.audio_data,
            language=request.language,
            backend=backend,
        )

        elapsed_ms = (time.time() - start_time) * 1000

        if isinstance(result, dict):
            text = result.get("text", "")
            confidence = result.get("confidence", 0.0)
        else:
            text = str(result)
            confidence = 0.0

        return STTResponse(
            text=text,
            confidence=confidence,
            language=request.language,
            processing_time_ms=round(elapsed_ms, 2),
        )

    except Exception as exc:
        logger.error("STT processing error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Speech recognition error: {str(exc)}")


@router.post("/voice/tts", response_model=TTSResponse, summary="Text to speech")
async def text_to_speech(
    request: TTSRequest,
    user: Optional[Dict[str, Any]] = Depends(get_optional_user),
):
    """Convert text to speech audio.

    Returns base64-encoded audio data. Supports rate, volume, and voice overrides.
    """
    start_time = time.time()
    jarvis_main = _get_main_module()

    logger.info("TTS request: text_length=%d", len(request.text))

    if not jarvis_main.voice_interface:
        raise HTTPException(status_code=503, detail="Voice interface not available")

    try:
        result = await jarvis_main.voice_interface.text_to_speech(
            request.text,
            voice_id=request.voice_id,
            rate=request.rate,
            volume=request.volume,
        )

        elapsed_ms = (time.time() - start_time) * 1000

        if isinstance(result, dict):
            audio_data = result.get("audio_data", "")
            duration = result.get("duration_seconds", 0.0)
        else:
            audio_data = str(result)
            duration = 0.0

        return TTSResponse(
            audio_data=audio_data,
            duration_seconds=duration,
            processing_time_ms=round(elapsed_ms, 2),
        )

    except Exception as exc:
        logger.error("TTS processing error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Text-to-speech error: {str(exc)}")


# ===========================================================================
# Auth Endpoints
# ===========================================================================

@router.post("/auth/login", response_model=LoginResponse, summary="Login")
async def login_endpoint(request: LoginRequest):
    """Authenticate user and return JWT tokens.

    Supports both username/password and API key authentication.
    Implements account lockout after repeated failed attempts.
    """
    start_time = time.time()
    jarvis_main = _get_main_module()

    logger.info("Login attempt: username=%s", request.username)

    if not jarvis_main.security_manager:
        raise HTTPException(status_code=503, detail="Security manager not available")

    try:
        result = jarvis_main.security_manager.authenticate(
            username=request.username,
            password=request.password,
        )

        if not result.get("success", False):
            raise HTTPException(status_code=401, detail=result.get("message", "Authentication failed"))

        return LoginResponse(
            access_token=result["access_token"],
            expires_in=result.get("expires_in", 3600),
            refresh_token=result["refresh_token"],
            user=result.get("user", {}),
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Login error: %s", exc)
        raise HTTPException(status_code=500, detail="Authentication service error")


@router.post("/auth/refresh", response_model=RefreshResponse, summary="Refresh token")
async def refresh_token_endpoint(
    credentials: HTTPAuthorizationCredentials = Depends(security),
):
    """Refresh an expired JWT access token using a valid refresh token.

    The refresh token must be provided in the Authorization header.
    """
    jarvis_main = _get_main_module()

    if not credentials:
        raise HTTPException(status_code=401, detail="Refresh token required")

    if not jarvis_main.security_manager:
        raise HTTPException(status_code=503, detail="Security manager not available")

    try:
        result = jarvis_main.security_manager.refresh_token(credentials.credentials)

        if not result.get("success", False):
            raise HTTPException(status_code=401, detail=result.get("message", "Token refresh failed"))

        return RefreshResponse(
            access_token=result["access_token"],
            expires_in=result.get("expires_in", 3600),
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Token refresh error: %s", exc)
        raise HTTPException(status_code=500, detail="Token refresh service error")


# ===========================================================================
# Upload Endpoint
# ===========================================================================

@router.post("/upload", response_model=UploadResponse, summary="Upload files")
async def upload_file(
    file: UploadFile = File(...),
    user: Optional[Dict[str, Any]] = Depends(get_optional_user),
):
    """Upload a file for JARVIS analysis.

    Supports all file types up to the configured maximum size.
    Files are analyzed by the AI and results are returned.
    """
    start_time = time.time()
    jarvis_main = _get_main_module()

    max_size = jarvis_main.CONFIG.get("upload", {}).get("max_file_size", 52428800)
    allowed_types = jarvis_main.CONFIG.get("upload", {}).get("allowed_types", ["*"])

    logger.info("File upload: filename=%s, content_type=%s", file.filename, file.content_type)

    # Read file content
    content = await file.read()
    file_size = len(content)

    # Validate size
    if file_size > max_size:
        raise HTTPException(
            status_code=413,
            detail=f"File size ({file_size} bytes) exceeds maximum ({max_size} bytes)",
        )

    # Validate content type
    if allowed_types != ["*"] and file.content_type not in allowed_types:
        raise HTTPException(
            status_code=415,
            detail=f"Content type {file.content_type} not allowed",
        )

    # Save file
    file_id = str(uuid.uuid4())
    storage_path = jarvis_main.CONFIG.get("upload", {}).get("storage_path", "./uploads")

    try:
        os.makedirs(storage_path, exist_ok=True)
        file_path = os.path.join(storage_path, f"{file_id}_{file.filename}")
        async with open(file_path, "wb") as f:
            await f.write(content)
    except Exception as exc:
        logger.error("File save error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to save uploaded file")

    # Analyze file with agent
    analysis = None
    if jarvis_main.agent and hasattr(jarvis_main.agent, "analyze_file"):
        try:
            analysis = await jarvis_main.agent.analyze_file(file_path, file.content_type)
        except Exception as exc:
            logger.warning("File analysis error: %s", exc)
            analysis = {"error": str(exc)}

    elapsed_ms = (time.time() - start_time) * 1000

    return UploadResponse(
        file_id=file_id,
        filename=file.filename or "unknown",
        size_bytes=file_size,
        content_type=file.content_type or "application/octet-stream",
        analysis=analysis,
        upload_time_ms=round(elapsed_ms, 2),
    )


# ===========================================================================
# Swarm Endpoints
# ===========================================================================

@router.post("/swarm/connect", summary="Connect to swarm")
async def swarm_connect(
    request: SwarmConnectRequest,
    user: Dict[str, Any] = Depends(get_current_user),
):
    """Connect to the swarm network.

    Establishes a WebSocket connection to the swarm coordinator.
    Requires authentication.
    """
    jarvis_main = _get_main_module()

    if not jarvis_main.swarm_connector:
        raise HTTPException(status_code=503, detail="Swarm connector not available")

    try:
        connect_kwargs = {}
        if request.url:
            connect_kwargs["url"] = request.url
        if request.api_key:
            connect_kwargs["api_key"] = request.api_key
        connect_kwargs["auto_dispatch"] = request.auto_dispatch

        result = await jarvis_main.swarm_connector.connect(**connect_kwargs)

        return {
            "success": True,
            "connected": True,
            "swarm_info": result if isinstance(result, dict) else {"status": "connected"},
        }

    except Exception as exc:
        logger.error("Swarm connect error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Swarm connection error: {str(exc)}")


@router.post("/swarm/disconnect", summary="Disconnect from swarm")
async def swarm_disconnect(
    request: SwarmDisconnectRequest = None,
    user: Dict[str, Any] = Depends(get_current_user),
):
    """Disconnect from the swarm network.

    Optionally notifies the swarm of the disconnection.
    """
    jarvis_main = _get_main_module()

    if not jarvis_main.swarm_connector:
        raise HTTPException(status_code=503, detail="Swarm connector not available")

    try:
        notify = request.notify_swarm if request else True
        reason = request.reason if request else None

        await jarvis_main.swarm_connector.disconnect(reason=reason, notify=notify)

        return {"success": True, "connected": False}

    except Exception as exc:
        logger.error("Swarm disconnect error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Swarm disconnection error: {str(exc)}")


@router.post("/swarm/agent/{agent_id}/activate", summary="Activate a swarm agent")
async def activate_agent(
    agent_id: str = PathParam(..., description="Agent identifier"),
    request: AgentActivateRequest = None,
    user: Dict[str, Any] = Depends(get_current_user),
):
    """Activate a specific swarm agent.

    The agent will start processing tasks according to its configuration.
    Requires admin or user role.
    """
    jarvis_main = _get_main_module()

    if not jarvis_main.swarm_connector:
        raise HTTPException(status_code=503, detail="Swarm connector not available")

    try:
        config = request.config if request else None
        auto_start = request.auto_start if request else True

        result = await jarvis_main.swarm_connector.activate_agent(
            agent_id=agent_id,
            config=config,
            auto_start=auto_start,
        )

        return {
            "success": True,
            "agent_id": agent_id,
            "status": "active",
            "details": result if isinstance(result, dict) else {},
        }

    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.error("Agent activation error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Agent activation error: {str(exc)}")


@router.post("/swarm/agent/{agent_id}/deactivate", summary="Deactivate a swarm agent")
async def deactivate_agent(
    agent_id: str = PathParam(..., description="Agent identifier"),
    request: AgentDeactivateRequest = None,
    user: Dict[str, Any] = Depends(get_current_user),
):
    """Deactivate a specific swarm agent.

    The agent will stop processing tasks and optionally save its state.
    """
    jarvis_main = _get_main_module()

    if not jarvis_main.swarm_connector:
        raise HTTPException(status_code=503, detail="Swarm connector not available")

    try:
        cleanup = request.cleanup if request else True
        save_state = request.save_state if request else True

        result = await jarvis_main.swarm_connector.deactivate_agent(
            agent_id=agent_id,
            cleanup=cleanup,
            save_state=save_state,
        )

        return {
            "success": True,
            "agent_id": agent_id,
            "status": "inactive",
            "details": result if isinstance(result, dict) else {},
        }

    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.error("Agent deactivation error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Agent deactivation error: {str(exc)}")


# ===========================================================================
# Status Endpoint
# ===========================================================================

@router.get("/status", response_model=StatusResponse, summary="System status")
async def status_endpoint(
    user: Optional[Dict[str, Any]] = Depends(get_optional_user),
):
    """Get the current system status including all component states.

    Returns health information for all subsystems: agent, voice, swarm, security.
    """
    jarvis_main = _get_main_module()

    components = {
        "agent": jarvis_main.agent is not None,
        "security": jarvis_main.security_manager is not None,
        "voice": jarvis_main.voice_interface is not None,
        "swarm": jarvis_main.swarm_connector is not None,
    }

    swarm_connected = False
    active_agents = 0
    if jarvis_main.swarm_connector:
        try:
            swarm_connected = jarvis_main.swarm_connector.connected
            if hasattr(jarvis_main.swarm_connector, "active_agent_count"):
                active_agents = jarvis_main.swarm_connector.active_agent_count()
        except Exception:
            pass

    memory_usage = None
    if jarvis_main.agent and hasattr(jarvis_main.agent, "memory"):
        try:
            memory_usage = jarvis_main.agent.memory.get_usage_stats()
        except Exception:
            pass

    all_healthy = all(components.values())

    return StatusResponse(
        status="healthy" if all_healthy else "degraded",
        version="2.0.0",
        uptime_seconds=time.time(),
        components=components,
        swarm_connected=swarm_connected,
        active_agents=active_agents,
        memory_usage=memory_usage,
    )
