"""JARVIS AI Agent - Main Entry Point

FastAPI server with WebSocket support, voice loop, swarm connectivity,
and comprehensive middleware stack for the JARVIS AI system.
"""
import asyncio
import logging
import os
import signal
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import yaml
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration Loader
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """Load configuration from config.yaml with environment variable substitution."""
    config_path = Path(__file__).parent / "config.yaml"
    if not config_path.exists():
        logging.warning("config.yaml not found, using defaults")
        return _default_config()

    with open(config_path, "r") as fh:
        raw = yaml.safe_load(fh)

    # Substitute environment variables like ${VAR_NAME}
    return _substitute_env(raw)


def _substitute_env(obj):
    """Recursively replace ${ENV_VAR} strings with environment variable values."""
    if isinstance(obj, dict):
        return {k: _substitute_env(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_substitute_env(item) for item in obj]
    if isinstance(obj, str) and obj.startswith("${") and obj.endswith("}"):
        env_key = obj[2:-1]
        return os.environ.get(env_key, obj)
    return obj


def _default_config() -> dict:
    """Return sensible defaults when config.yaml is absent."""
    return {
        "jarvis": {
            "name": "JARVIS",
            "personality": "professional, witty, loyal",
            "personality_mode": "professional",
            "voice": {
                "engine": "pyttsx3",
                "rate": 190,
                "volume": 1.0,
                "voice_id": 0,
                "stt_backend": "google",
            },
        },
        "security": {
            "jwt_secret_key": os.environ.get("JWT_SECRET_KEY", "dev-secret-key"),
            "jwt_expiry": 3600,
            "jwt_algorithm": "HS256",
            "rate_limit": 60,
            "rate_limit_window": 60,
            "encryption_key": os.environ.get("AES_ENCRYPTION_KEY", ""),
            "encryption_algorithm": "AES-256-GCM",
            "password_iterations": 600000,
        },
        "swarm": {
            "url": "https://github.com/younestsouli2019-bot/Nouveau-dossier-3-",
            "ws_url": os.environ.get("SWARM_WS_URL", ""),
            "reconnect_interval": 5,
            "heartbeat": 30,
            "max_retries": 5,
            "encryption": True,
        },
        "openai": {
            "model": "gpt-4o",
            "temperature": 0.7,
            "max_tokens": 2048,
        },
        "api": {
            "host": "0.0.0.0",
            "port": 8000,
            "cors_origins": ["*"],
            "debug": False,
        },
        "memory": {
            "max_messages": 20,
            "persist": True,
            "file_path": "./data/memory.json",
        },
        "upload": {
            "max_file_size": 52428800,
            "allowed_types": ["*"],
            "storage_path": "./uploads",
        },
        "logging": {
            "level": "INFO",
            "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
            "file": "./logs/jarvis.log",
        },
    }


# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

CONFIG = load_config()

# Configure logging
_log_cfg = CONFIG.get("logging", {})
_log_level = getattr(logging, _log_cfg.get("level", "INFO").upper(), logging.INFO)
_log_fmt = _log_cfg.get("format", "%(asctime)s - %(name)s - %(levelname)s - %(message)s")
_log_file = _log_cfg.get("file")

if _log_file:
    Path(_log_file).parent.mkdir(parents=True, exist_ok=True)

handlers = [logging.StreamHandler(sys.stdout)]
if _log_file:
    handlers.append(logging.FileHandler(_log_file))

logging.basicConfig(level=_log_level, format=_log_fmt, handlers=handlers)
logger = logging.getLogger("jarvis")

# ---------------------------------------------------------------------------
# Ensure data directories exist
# ---------------------------------------------------------------------------

Path("./data").mkdir(parents=True, exist_ok=True)
Path("./uploads").mkdir(parents=True, exist_ok=True)
Path("./logs").mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Core component instances (initialised during lifespan startup)
# ---------------------------------------------------------------------------

agent: Optional["JarvisAgent"] = None
security_manager: Optional["SecurityManager"] = None
voice_interface: Optional["VoiceInterface"] = None
swarm_connector: Optional["SwarmConnector"] = None

# Shutdown event
_shutdown_event = asyncio.Event()

# WebSocket connection tracking
_ws_connections: list = []

# Background task references
_background_tasks: list = []


# ---------------------------------------------------------------------------
# Lifespan Manager
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app):
    """Manage application startup and shutdown lifecycle."""
    global agent, security_manager, voice_interface, swarm_connector

    logger.info("=" * 60)
    logger.info("JARVIS AI Agent v2.0 starting up...")
    logger.info("=" * 60)

    # ---- Initialise core components ----
    try:
        from jarvis_core.agent import JarvisAgent
        from jarvis_core.security import SecurityManager
        from jarvis_core.voice import VoiceInterface
        from jarvis_core.swarm_connector import SwarmConnector

        security_manager = SecurityManager(CONFIG.get("security", {}))
        logger.info("SecurityManager initialised")

        voice_interface = VoiceInterface(CONFIG.get("jarvis", {}).get("voice", {}))
        logger.info("VoiceInterface initialised")

        swarm_connector = SwarmConnector(CONFIG.get("swarm", {}))
        logger.info("SwarmConnector initialised")

        agent = JarvisAgent(
            config=CONFIG,
            security_manager=security_manager,
            voice_interface=voice_interface,
            swarm_connector=swarm_connector,
        )
        logger.info("JarvisAgent initialised")

    except ImportError as exc:
        logger.warning(
            "jarvis_core modules not available (%s). Running in stub mode.", exc
        )
        security_manager = None
        voice_interface = None
        swarm_connector = None
        agent = None
    except Exception as exc:
        logger.error("Failed to initialise core components: %s", exc)
        security_manager = None
        voice_interface = None
        swarm_connector = None
        agent = None

    # ---- Start background tasks ----
    voice_task = asyncio.create_task(_voice_loop())
    _background_tasks.append(voice_task)
    logger.info("Background voice loop started")

    heartbeat_task = asyncio.create_task(_swarm_heartbeat_loop())
    _background_tasks.append(heartbeat_task)
    logger.info("Swarm heartbeat loop started")

    cleanup_task = asyncio.create_task(_periodic_cleanup())
    _background_tasks.append(cleanup_task)
    logger.info("Periodic cleanup task started")

    # ---- Signal handlers ----
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _handle_shutdown_signal, sig)

    logger.info("JARVIS AI Agent is ready to serve requests")
    yield  # ---- Application runs ----

    # ---- Shutdown ----
    logger.info("JARVIS AI Agent shutting down...")
    _shutdown_event.set()

    # Cancel background tasks
    for task in _background_tasks:
        task.cancel()
    await asyncio.gather(*_background_tasks, return_exceptions=True)
    _background_tasks.clear()

    # Disconnect swarm
    if swarm_connector:
        try:
            await swarm_connector.disconnect()
            logger.info("SwarmConnector disconnected")
        except Exception as exc:
            logger.warning("Error disconnecting swarm: %s", exc)

    # Close WebSocket connections
    for ws in _ws_connections[:]:
        try:
            await ws.close()
        except Exception:
            pass
    _ws_connections.clear()

    # Persist memory
    if agent and hasattr(agent, "memory"):
        try:
            agent.memory.save()
            logger.info("Agent memory persisted")
        except Exception as exc:
            logger.warning("Error saving agent memory: %s", exc)

    logger.info("JARVIS AI Agent shutdown complete")


def _handle_shutdown_signal(sig):
    """Handle SIGINT / SIGTERM."""
    logger.info("Received signal %s, initiating graceful shutdown", sig.name)
    _shutdown_event.set()


# ---------------------------------------------------------------------------
# Background Loops
# ---------------------------------------------------------------------------

async def _voice_loop():
    """Background voice loop that listens for voice input when activated."""
    logger.info("Voice loop started")
    while not _shutdown_event.is_set():
        try:
            if voice_interface and voice_interface.listening:
                result = await asyncio.to_thread(voice_interface.listen_once)
                if result:
                    logger.debug("Voice input detected: %s", result[:80])
                    if agent:
                        response = await agent.process(result)
                        # Broadcast to WebSocket clients
                        await _broadcast_ws({
                            "type": "voice_input",
                            "text": result,
                            "response": response.get("response", "") if isinstance(response, dict) else str(response),
                        })
            await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Voice loop error: %s", exc)
            await asyncio.sleep(1)
    logger.info("Voice loop stopped")


async def _swarm_heartbeat_loop():
    """Periodic heartbeat to the swarm coordinator."""
    logger.info("Swarm heartbeat loop started")
    interval = CONFIG.get("swarm", {}).get("heartbeat", 30)
    while not _shutdown_event.is_set():
        try:
            if swarm_connector and swarm_connector.connected:
                await swarm_connector.send_heartbeat()
                logger.debug("Swarm heartbeat sent")
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Swarm heartbeat error: %s", exc)
            await asyncio.sleep(interval)
    logger.info("Swarm heartbeat loop stopped")


async def _periodic_cleanup():
    """Periodic cleanup of stale resources."""
    logger.info("Periodic cleanup loop started")
    while not _shutdown_event.is_set():
        try:
            # Clean up stale WebSocket connections
            _ws_connections[:] = [ws for ws in _ws_connections if not ws.client_state.name == "DISCONNECTED"]

            # Clean up expired rate limit entries
            if security_manager:
                security_manager.cleanup_rate_limits()

            await asyncio.sleep(60)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Cleanup loop error: %s", exc)
            await asyncio.sleep(60)
    logger.info("Periodic cleanup loop stopped")


async def _broadcast_ws(message: dict):
    """Broadcast a message to all connected WebSocket clients."""
    disconnected = []
    for ws in _ws_connections:
        try:
            await ws.send_json(message)
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        if ws in _ws_connections:
            _ws_connections.remove(ws)


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.middleware import RateLimitMiddleware, AuditLoggingMiddleware
from api.auth import AuthMiddleware


app = FastAPI(
    title="JARVIS AI Agent",
    description="Advanced AI Assistant with voice, swarm, and security capabilities",
    version="2.0.0",
    lifespan=lifespan,
)

# ---- Middleware Stack ----

# CORS
cors_origins = CONFIG.get("api", {}).get("cors_origins", ["*"])
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate limiting
app.add_middleware(
    RateLimitMiddleware,
    max_requests=CONFIG.get("security", {}).get("rate_limit", 60),
    window_seconds=CONFIG.get("security", {}).get("rate_limit_window", 60),
)

# Audit logging
app.add_middleware(AuditLoggingMiddleware)

# Auth middleware
app.add_middleware(
    AuthMiddleware,
    jwt_secret=CONFIG.get("security", {}).get("jwt_secret_key", "dev-secret-key"),
    jwt_algorithm=CONFIG.get("security", {}).get("jwt_algorithm", "HS256"),
    exempt_paths=[
        "/health",
        "/docs",
        "/redoc",
        "/openapi.json",
        "/api/auth/login",
        "/api/auth/refresh",
    ],
)


# ---------------------------------------------------------------------------
# Health Check
# ---------------------------------------------------------------------------

@app.get("/health", tags=["System"])
async def health_check():
    """Comprehensive health check endpoint."""
    components = {
        "agent": agent is not None,
        "security": security_manager is not None,
        "voice": voice_interface is not None,
        "swarm": swarm_connector is not None,
    }
    swarm_connected = False
    if swarm_connector:
        try:
            swarm_connected = swarm_connector.connected
        except Exception:
            swarm_connected = False

    all_healthy = all(components.values())

    return {
        "status": "healthy" if all_healthy else "degraded",
        "version": "2.0.0",
        "uptime_seconds": time.time(),
        "components": components,
        "swarm_connected": swarm_connected,
        "active_websockets": len(_ws_connections),
        "personality_mode": CONFIG.get("jarvis", {}).get("personality_mode", "professional"),
    }


# ---------------------------------------------------------------------------
# System Info
# ---------------------------------------------------------------------------

@app.get("/api/system/info", tags=["System"])
async def system_info():
    """Return system information and configuration summary."""
    return {
        "name": CONFIG.get("jarvis", {}).get("name", "JARVIS"),
        "version": "2.0.0",
        "personality_mode": CONFIG.get("jarvis", {}).get("personality_mode", "professional"),
        "openai_model": CONFIG.get("openai", {}).get("model", "gpt-4o"),
        "swarm_configured": bool(CONFIG.get("swarm", {}).get("ws_url")),
        "voice_engine": CONFIG.get("jarvis", {}).get("voice", {}).get("engine", "pyttsx3"),
        "memory_persist": CONFIG.get("memory", {}).get("persist", True),
        "max_upload_size": CONFIG.get("upload", {}).get("max_file_size", 52428800),
    }


@app.get("/api/system/metrics", tags=["System"])
async def system_metrics():
    """Return system metrics and performance data."""
    metrics = {
        "active_connections": len(_ws_connections),
        "background_tasks": len(_background_tasks),
    }
    if agent and hasattr(agent, "get_metrics"):
        try:
            metrics["agent"] = agent.get_metrics()
        except Exception:
            metrics["agent"] = {"error": "unavailable"}
    if security_manager:
        try:
            metrics["security"] = security_manager.get_metrics()
        except Exception:
            metrics["security"] = {"error": "unavailable"}
    if swarm_connector:
        try:
            metrics["swarm"] = swarm_connector.get_metrics()
        except Exception:
            metrics["swarm"] = {"error": "unavailable"}
    return metrics


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws/jarvis")
async def websocket_jarvis(websocket: WebSocket):
    """WebSocket endpoint for real-time JARVIS communication.

    Protocol:
    - Client sends JSON messages with a "type" field
    - Server responds with JSON messages
    - Supported types: chat, voice, command, ping
    """
    await websocket.accept()
    _ws_connections.append(websocket)
    logger.info("WebSocket client connected. Total: %d", len(_ws_connections))

    # Send welcome message
    await websocket.send_json({
        "type": "welcome",
        "message": f"Connected to {CONFIG.get('jarvis', {}).get('name', 'JARVIS')} v2.0",
        "personality_mode": CONFIG.get("jarvis", {}).get("personality_mode", "professional"),
    })

    try:
        while not _shutdown_event.is_set():
            try:
                data = await asyncio.wait_for(websocket.receive_json(), timeout=30)
            except asyncio.TimeoutError:
                # Send keepalive ping
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    break
                continue

            msg_type = data.get("type", "unknown")
            logger.debug("WebSocket message received: type=%s", msg_type)

            try:
                if msg_type == "ping":
                    await websocket.send_json({"type": "pong"})

                elif msg_type == "chat":
                    await _handle_ws_chat(websocket, data)

                elif msg_type == "voice":
                    await _handle_ws_voice(websocket, data)

                elif msg_type == "command":
                    await _handle_ws_command(websocket, data)

                elif msg_type == "swarm":
                    await _handle_ws_swarm(websocket, data)

                else:
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Unknown message type: {msg_type}",
                    })

            except Exception as exc:
                logger.error("Error handling WebSocket message: %s", exc)
                try:
                    await websocket.send_json({
                        "type": "error",
                        "message": str(exc),
                    })
                except Exception:
                    break

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected normally")
    except Exception as exc:
        logger.error("WebSocket error: %s", exc)
    finally:
        if websocket in _ws_connections:
            _ws_connections.remove(websocket)
        logger.info("WebSocket client removed. Total: %d", len(_ws_connections))


async def _handle_ws_chat(websocket: WebSocket, data: dict):
    """Handle chat messages over WebSocket."""
    message = data.get("message", "")
    if not message:
        await websocket.send_json({"type": "error", "message": "Empty message"})
        return

    if agent:
        try:
            # Indicate typing
            await websocket.send_json({"type": "typing", "status": True})

            response = await agent.process(message)
            reply = response.get("response", "") if isinstance(response, dict) else str(response)

            await websocket.send_json({
                "type": "chat_response",
                "message": reply,
                "metadata": response.get("metadata", {}) if isinstance(response, dict) else {},
            })
        except Exception as exc:
            logger.error("Agent processing error: %s", exc)
            await websocket.send_json({
                "type": "error",
                "message": "I encountered an error processing your request.",
            })
    else:
        await websocket.send_json({
            "type": "chat_response",
            "message": f"Echo: {message}",
            "metadata": {"mode": "stub"},
        })


async def _handle_ws_voice(websocket: WebSocket, data: dict):
    """Handle voice-related WebSocket messages."""
    action = data.get("action", "")

    if action == "start_listening":
        if voice_interface:
            voice_interface.listening = True
            await websocket.send_json({"type": "voice_status", "listening": True})
        else:
            await websocket.send_json({"type": "error", "message": "Voice not available"})

    elif action == "stop_listening":
        if voice_interface:
            voice_interface.listening = False
            await websocket.send_json({"type": "voice_status", "listening": False})
        else:
            await websocket.send_json({"type": "error", "message": "Voice not available"})

    elif action == "stt":
        audio_data = data.get("audio", "")
        if voice_interface and audio_data:
            try:
                text = await voice_interface.speech_to_text(audio_data)
                await websocket.send_json({"type": "stt_result", "text": text})
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": f"STT error: {exc}"})
        else:
            await websocket.send_json({"type": "error", "message": "Voice or audio data not available"})

    elif action == "tts":
        text = data.get("text", "")
        if voice_interface and text:
            try:
                audio = await voice_interface.text_to_speech(text)
                await websocket.send_json({"type": "tts_result", "audio": audio})
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": f"TTS error: {exc}"})
        else:
            await websocket.send_json({"type": "error", "message": "Voice or text not available"})

    else:
        await websocket.send_json({"type": "error", "message": f"Unknown voice action: {action}"})


async def _handle_ws_command(websocket: WebSocket, data: dict):
    """Handle command messages over WebSocket."""
    command = data.get("command", "")
    params = data.get("params", {})

    supported_commands = {
        "set_personality": _cmd_set_personality,
        "clear_memory": _cmd_clear_memory,
        "get_status": _cmd_get_status,
        "set_voice_rate": _cmd_set_voice_rate,
    }

    handler = supported_commands.get(command)
    if handler:
        result = await handler(params)
        await websocket.send_json({"type": "command_result", "command": command, "result": result})
    else:
        await websocket.send_json({"type": "error", "message": f"Unknown command: {command}"})


async def _handle_ws_swarm(websocket: WebSocket, data: dict):
    """Handle swarm-related WebSocket messages."""
    action = data.get("action", "")

    if action == "connect":
        if swarm_connector:
            try:
                await swarm_connector.connect()
                await websocket.send_json({"type": "swarm_status", "connected": True})
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": f"Swarm connect error: {exc}"})
        else:
            await websocket.send_json({"type": "error", "message": "Swarm not available"})

    elif action == "disconnect":
        if swarm_connector:
            try:
                await swarm_connector.disconnect()
                await websocket.send_json({"type": "swarm_status", "connected": False})
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": f"Swarm disconnect error: {exc}"})
        else:
            await websocket.send_json({"type": "error", "message": "Swarm not available"})

    elif action == "list_agents":
        if swarm_connector:
            try:
                agents = await swarm_connector.list_agents()
                await websocket.send_json({"type": "swarm_agents", "agents": agents})
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": f"List agents error: {exc}"})
        else:
            await websocket.send_json({"type": "error", "message": "Swarm not available"})

    elif action == "dispatch_task":
        task = data.get("task", {})
        agent_id = data.get("agent_id", "")
        if swarm_connector:
            try:
                result = await swarm_connector.dispatch_task(agent_id, task)
                await websocket.send_json({"type": "task_result", "result": result})
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": f"Task dispatch error: {exc}"})
        else:
            await websocket.send_json({"type": "error", "message": "Swarm not available"})

    else:
        await websocket.send_json({"type": "error", "message": f"Unknown swarm action: {action}"})


# ---------------------------------------------------------------------------
# Command Handlers
# ---------------------------------------------------------------------------

async def _cmd_set_personality(params: dict) -> dict:
    """Set the personality mode."""
    mode = params.get("mode", "professional")
    CONFIG["jarvis"]["personality_mode"] = mode
    if agent and hasattr(agent, "set_personality_mode"):
        agent.set_personality_mode(mode)
    return {"success": True, "mode": mode}


async def _cmd_clear_memory(params: dict) -> dict:
    """Clear agent conversation memory."""
    if agent and hasattr(agent, "memory"):
        agent.memory.clear()
        return {"success": True, "message": "Memory cleared"}
    return {"success": False, "message": "Agent memory not available"}


async def _cmd_get_status(params: dict) -> dict:
    """Get current system status."""
    return {
        "agent_active": agent is not None,
        "voice_active": voice_interface is not None,
        "swarm_connected": swarm_connector.connected if swarm_connector else False,
        "ws_connections": len(_ws_connections),
        "personality_mode": CONFIG.get("jarvis", {}).get("personality_mode"),
    }


async def _cmd_set_voice_rate(params: dict) -> dict:
    """Set voice speech rate."""
    rate = params.get("rate", 190)
    if voice_interface:
        try:
            voice_interface.set_rate(rate)
            return {"success": True, "rate": rate}
        except Exception as exc:
            return {"success": False, "message": str(exc)}
    return {"success": False, "message": "Voice not available"}


# ---------------------------------------------------------------------------
# Include API Routes
# ---------------------------------------------------------------------------

from api.routes import router

app.include_router(router, prefix="/api")


# ---------------------------------------------------------------------------
# Exception Handlers
# ---------------------------------------------------------------------------

@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    """Custom HTTP exception handler."""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": True,
            "status_code": exc.status_code,
            "detail": exc.detail,
            "path": str(request.url),
        },
    )


@app.exception_handler(Exception)
async def general_exception_handler(request, exc):
    """Catch-all exception handler."""
    logger.error("Unhandled exception: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "error": True,
            "status_code": 500,
            "detail": "Internal server error",
            "path": str(request.url),
        },
    )


# ---------------------------------------------------------------------------
# Startup Event (for additional startup logic beyond lifespan)
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def on_startup():
    """Additional startup logic."""
    logger.info("FastAPI application startup event triggered")
    logger.info("Configuration loaded: personality_mode=%s", CONFIG.get("jarvis", {}).get("personality_mode"))
    logger.info("CORS origins: %s", CONFIG.get("api", {}).get("cors_origins"))
    logger.info("Rate limit: %d requests per %d seconds",
                CONFIG.get("security", {}).get("rate_limit", 60),
                CONFIG.get("security", {}).get("rate_limit_window", 60))


@app.on_event("shutdown")
async def on_shutdown():
    """Additional shutdown logic."""
    logger.info("FastAPI application shutdown event triggered")


# ---------------------------------------------------------------------------
# Uvicorn Entry Point
# ---------------------------------------------------------------------------

def run_server():
    """Run the JARVIS AI Agent server."""
    api_config = CONFIG.get("api", {})
    host = api_config.get("host", "0.0.0.0")
    port = api_config.get("port", 8000)
    debug = api_config.get("debug", False)

    logger.info("Starting JARVIS server on %s:%d (debug=%s)", host, port, debug)

    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=debug,
        log_level=_log_cfg.get("level", "info").lower(),
        access_log=True,
        ws_ping_interval=30,
        ws_ping_timeout=60,
    )


if __name__ == "__main__":
    run_server()
