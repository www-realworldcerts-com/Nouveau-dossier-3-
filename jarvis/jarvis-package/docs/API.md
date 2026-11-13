# JARVIS AI Agent System - API Documentation

> Complete API reference for JARVIS v2.0.0

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Next.js API Routes](#nextjs-api-routes)
4. [Python Agent API](#python-agent-api)
5. [WebSocket Protocol](#websocket-protocol)
6. [Error Codes](#error-codes)
7. [Rate Limiting](#rate-limiting)

---

## Overview

JARVIS exposes two API layers:

| Layer | Base URL | Description |
|-------|----------|-------------|
| **Next.js API** | `http://localhost:3000/api/jarvis/` | Frontend API routes (uses z-ai-web-dev-sdk) |
| **Python Agent** | `http://localhost:8000/api/` | Backend FastAPI endpoints |

### Common Headers

```http
Content-Type: application/json
Authorization: Bearer <jwt_token>
X-API-Key: <api_key>
X-Request-ID: <uuid>
```

### Response Format

All API responses follow a consistent format:

```json
{
  "data": { ... },
  "error": null,
  "timestamp": 1700000000000
}
```

Error responses:

```json
{
  "error": "Error message describing what went wrong",
  "code": "ERROR_CODE",
  "timestamp": 1700000000000
}
```

---

## Authentication

### JWT Token Flow

```
1. POST /api/auth/login { username, password }
   → { access_token, refresh_token, token_type: "bearer" }

2. Use access_token in Authorization header
   → Authorization: Bearer <access_token>

3. When token expires, refresh it
   POST /api/auth/refresh { refresh_token }
   → { access_token, refresh_token, token_type: "bearer" }
```

### Login

```http
POST /api/auth/login
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | Yes | Username |
| `password` | string | Yes | Password |

**Request Example:**

```json
{
  "username": "admin",
  "password": "secure_password_123"
}
```

**Response (200):**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "bearer",
  "expires_in": 1800
}
```

**Response (401):**

```json
{
  "error": "Invalid credentials",
  "code": "AUTH_INVALID_CREDENTIALS"
}
```

### Register

```http
POST /api/auth/register
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | Yes | Username (3-50 chars) |
| `email` | string | Yes | Valid email address |
| `password` | string | Yes | Password (8+ chars) |

**Request Example:**

```json
{
  "username": "newuser",
  "email": "user@example.com",
  "password": "SecureP@ss123"
}
```

**Response (201):**

```json
{
  "id": "clx1234567890",
  "username": "newuser",
  "email": "user@example.com",
  "created_at": "2024-01-01T00:00:00Z"
}
```

### Refresh Token

```http
POST /api/auth/refresh
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `refresh_token` | string | Yes | Valid refresh token |

**Response (200):**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "bearer",
  "expires_in": 1800
}
```

### API Key Authentication

Alternatively, use API keys for service-to-service communication:

```http
GET /api/health
X-API-Key: jarvis_ak_abc123def456
```

API keys support scoped permissions:
- `read` - Read-only access
- `write` - Read and write access
- `admin` - Full access including user management

---

## Next.js API Routes

These routes are served by the Next.js application and use the `z-ai-web-dev-sdk` for AI capabilities.

### Chat

Send a message and receive an AI-powered response from JARVIS.

```http
POST /api/jarvis/chat
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | User message (1-10000 chars) |
| `history` | array | No | Conversation history |

**History Object:**

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | "user", "assistant", or "system" |
| `content` | string | Message content |

**Request Example:**

```json
{
  "message": "Hello JARVIS, can you help me review some code?",
  "history": [
    { "role": "user", "content": "Hi there" },
    { "role": "assistant", "content": "Hello! How may I assist you today?" }
  ]
}
```

**Response (200):**

```json
{
  "response": "Of course! I'd be delighted to help you review your code. You can either paste the code directly in our chat or upload a file through the Files panel. I can check for best practices, potential bugs, security issues, and overall code quality. What would you like me to look at?",
  "timestamp": 1700000000000
}
```

**Response (400):**

```json
{
  "error": "Message is required and must be a non-empty string"
}
```

**curl Example:**

```bash
curl -X POST http://localhost:3000/api/jarvis/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What are the security best practices for API development?",
    "history": []
  }'
```

**Python Example:**

```python
import requests

response = requests.post(
    "http://localhost:3000/api/jarvis/chat",
    json={
        "message": "What are the security best practices for API development?",
        "history": []
    }
)
result = response.json()
print(result["response"])
```

---

### Speech-to-Text (STT)

Transcribe audio to text.

```http
POST /api/jarvis/stt
Content-Type: multipart/form-data
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `audio` | file | Yes | Audio file (WAV, MP3, WebM, OGG) |

**Response (200):**

```json
{
  "text": "Hello JARVIS, can you check the system status?",
  "confidence": 0.95,
  "language": "en-US",
  "duration": 3.2,
  "timestamp": 1700000000000
}
```

**curl Example:**

```bash
curl -X POST http://localhost:3000/api/jarvis/stt \
  -F "audio=@recording.wav"
```

**Python Example:**

```python
import requests

with open("recording.wav", "rb") as f:
    response = requests.post(
        "http://localhost:3000/api/jarvis/stt",
        files={"audio": f}
    )
result = response.json()
print(result["text"])
```

---

### Text-to-Speech (TTS)

Convert text to spoken audio.

```http
POST /api/jarvis/tts
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to synthesize (1-5000 chars) |
| `voice` | string | No | Voice ID (default: "default") |
| `speed` | number | No | Speech rate 0.5-2.0 (default: 1.0) |

**Request Example:**

```json
{
  "text": "All systems are operational. The swarm network is online with six agents connected.",
  "speed": 1.0
}
```

**Response (200):**

Returns audio data as binary stream with appropriate Content-Type header.

```
Content-Type: audio/mpeg
Content-Length: 24576
```

**curl Example:**

```bash
curl -X POST http://localhost:3000/api/jarvis/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, I am JARVIS."}' \
  --output speech.mp3
```

**Python Example:**

```python
import requests

response = requests.post(
    "http://localhost:3000/api/jarvis/tts",
    json={"text": "Hello, I am JARVIS.", "speed": 1.0}
)

with open("speech.mp3", "wb") as f:
    f.write(response.content)
```

---

### Web Search

Search the web for real-time information.

```http
POST /api/jarvis/search
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Search query (1-500 chars) |

**Request Example:**

```json
{
  "query": "latest developments in AI agent systems 2024"
}
```

**Response (200):**

```json
{
  "results": [
    {
      "title": "AI Agent Systems: A Comprehensive Overview",
      "url": "https://example.com/ai-agents-2024",
      "snippet": "Recent developments in AI agent systems have shown remarkable progress...",
      "source": "example.com"
    }
  ],
  "query": "latest developments in AI agent systems 2024",
  "total_results": 10,
  "timestamp": 1700000000000
}
```

**curl Example:**

```bash
curl -X POST http://localhost:3000/api/jarvis/search \
  -H "Content-Type: application/json" \
  -d '{"query": "AI agent frameworks comparison"}'
```

---

### Image Generation

Generate images from text descriptions.

```http
POST /api/jarvis/image
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | Image description (1-2000 chars) |
| `size` | string | No | Image size (default: "1024x1024") |

**Size Options:** `512x512`, `1024x1024`, `2048x2048`

**Request Example:**

```json
{
  "prompt": "A futuristic AI laboratory with holographic displays and a central AI core",
  "size": "1024x1024"
}
```

**Response (200):**

```json
{
  "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "prompt": "A futuristic AI laboratory with holographic displays and a central AI core",
  "size": "1024x1024",
  "timestamp": 1700000000000
}
```

**curl Example:**

```bash
curl -X POST http://localhost:3000/api/jarvis/image \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Futuristic AI lab", "size": "1024x1024"}'
```

**Python Example:**

```python
import requests
import base64

response = requests.post(
    "http://localhost:3000/api/jarvis/image",
    json={"prompt": "Futuristic AI lab with holographic displays", "size": "1024x1024"}
)
result = response.json()

# Save image
image_data = base64.b64decode(result["url"].split(",")[1])
with open("generated_image.png", "wb") as f:
    f.write(image_data)
```

---

### File Upload

Upload and analyze files.

```http
POST /api/jarvis/upload
Content-Type: multipart/form-data
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | File to upload |

**Supported Types:** `.txt`, `.pdf`, `.doc`, `.docx`, `.py`, `.js`, `.ts`, `.tsx`, `.jsx`, `.json`, `.yaml`, `.yml`, `.md`, `.csv`, `.xml`, `.html`, `.css`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.h`

**Max Size:** 50 MB

**Response (200):**

```json
{
  "analysis": "This Python file contains a FastAPI application with the following key components: 1) User authentication endpoints using JWT, 2) CRUD operations for data management, 3) Middleware for CORS and rate limiting. Potential improvements: Add input validation with Pydantic models, implement proper error handling, and consider adding API versioning.",
  "fileName": "app.py",
  "fileSize": 4096,
  "fileType": "text/x-python",
  "timestamp": 1700000000000
}
```

**curl Example:**

```bash
curl -X POST http://localhost:3000/api/jarvis/upload \
  -F "file=@/path/to/your/file.py"
```

**Python Example:**

```python
import requests

with open("my_code.py", "rb") as f:
    response = requests.post(
        "http://localhost:3000/api/jarvis/upload",
        files={"file": f}
    )
result = response.json()
print(result["analysis"])
```

---

### System Status

Get the current system status.

```http
GET /api/jarvis/status
```

**Response (200):**

```json
{
  "status": "online",
  "version": "2.0.0",
  "uptime": 86400,
  "services": {
    "agent": "healthy",
    "redis": "healthy",
    "database": "healthy"
  },
  "features": {
    "voice": true,
    "swarm": true,
    "search": true,
    "image_gen": true,
    "file_upload": true,
    "encryption": true
  },
  "timestamp": 1700000000000
}
```

**curl Example:**

```bash
curl http://localhost:3000/api/jarvis/status
```

---

### Swarm Connect

Connect to the JARVIS agent swarm network.

```http
POST /api/jarvis/swarm/connect
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repoUrl` | string | No | Repository URL for agent context |

**Request Example:**

```json
{
  "repoUrl": "https://github.com/user/project"
}
```

**Response (200):**

```json
{
  "connected": true,
  "repoUrl": "https://github.com/user/project",
  "agents": [
    {
      "id": "code-reviewer",
      "name": "Code Reviewer",
      "status": "active",
      "capabilities": ["Code Review", "Pattern Analysis", "Best Practices"]
    },
    {
      "id": "security-auditor",
      "name": "Security Auditor",
      "status": "active",
      "capabilities": ["Vulnerability Scan", "Security Audit", "Threat Analysis"]
    },
    {
      "id": "test-engineer",
      "name": "Test Engineer",
      "status": "active",
      "capabilities": ["Test Generation", "Coverage Analysis", "Regression Testing"]
    },
    {
      "id": "web-perf",
      "name": "Web Performance",
      "status": "idle",
      "capabilities": ["Performance Audit", "Lighthouse Analysis", "Optimization"]
    },
    {
      "id": "payment-agent",
      "name": "Payment Gateway",
      "status": "idle",
      "capabilities": ["Payment Processing", "Policy Evaluation", "Transaction Management"]
    },
    {
      "id": "custom-agent",
      "name": "Custom Agent",
      "status": "idle",
      "capabilities": ["Custom Tasks", "Integration", "Automation"]
    }
  ],
  "encryptionEnabled": true,
  "protocol": "WSS/TLS",
  "timestamp": 1700000000000
}
```

**curl Example:**

```bash
curl -X POST http://localhost:3000/api/jarvis/swarm/connect \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/user/project"}'
```

---

### Swarm Agent Activate

Activate or deactivate a specific swarm agent.

```http
POST /api/jarvis/swarm/agent/{id}/activate
Content-Type: application/json
```

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Agent ID (e.g., "code-reviewer") |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `activate` | boolean | Yes | true to activate, false to deactivate |

**Request Example:**

```bash
# Activate the web performance agent
curl -X POST http://localhost:3000/api/jarvis/swarm/agent/web-perf/activate \
  -H "Content-Type: application/json" \
  -d '{"activate": true}'

# Deactivate the payment agent
curl -X POST http://localhost:3000/api/jarvis/swarm/agent/payment-agent/activate \
  -H "Content-Type: application/json" \
  -d '{"activate": false}'
```

**Response (200):**

```json
{
  "agent": {
    "id": "web-perf",
    "name": "Web Performance",
    "status": "active",
    "capabilities": ["Performance Audit", "Lighthouse Analysis", "Optimization"]
  },
  "activated": true,
  "timestamp": 1700000000000
}
```

---

## Python Agent API

The Python FastAPI backend provides additional endpoints with full authentication middleware.

### Health Check

```http
GET /api/health
```

**Response (200):**

```json
{
  "status": "healthy",
  "version": "2.0.0",
  "uptime_seconds": 86400,
  "components": {
    "redis": "connected",
    "database": "connected",
    "voice_stt": "available",
    "voice_tts": "available",
    "swarm": "connected"
  }
}
```

### Chat (Authenticated)

```http
POST /api/chat
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | User message |
| `conversation_id` | string | No | Existing conversation ID |
| `history` | array | No | Conversation history |

**Response (200):**

```json
{
  "response": "...",
  "conversation_id": "conv_abc123",
  "intent": "chat",
  "metadata": {
    "processing_time_ms": 1500,
    "tokens_used": 500,
    "model": "gpt-4"
  }
}
```

### Voice STT (Authenticated)

```http
POST /api/voice/stt
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `audio` | file | Yes | Audio file |
| `language` | string | No | Language code (default: "en-US") |

**Response (200):**

```json
{
  "text": "Transcribed text here",
  "confidence": 0.95,
  "language": "en-US",
  "duration_seconds": 3.2,
  "words": [
    { "word": "Hello", "start": 0.0, "end": 0.5, "confidence": 0.99 },
    { "word": "JARVIS", "start": 0.5, "end": 1.0, "confidence": 0.97 }
  ]
}
```

### Voice TTS (Authenticated)

```http
POST /api/voice/tts
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to synthesize |
| `voice_id` | string | No | Voice ID |
| `speed` | float | No | Speech rate (0.5-2.0) |
| `format` | string | No | Audio format: "wav", "mp3" (default: "wav") |

**Response (200):** Binary audio stream

### Web Search (Authenticated)

```http
POST /api/search
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `max_results` | integer | No | Max results (default: 10) |

**Response (200):**

```json
{
  "results": [
    {
      "title": "Result Title",
      "url": "https://example.com/page",
      "snippet": "Brief description of the search result...",
      "source": "example.com",
      "rank": 1
    }
  ],
  "total": 10,
  "query": "search query",
  "search_time_ms": 250
}
```

### File Upload (Authenticated)

```http
POST /api/upload
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | File to upload and analyze |
| `analysis_type` | string | No | "summary", "security", "review" (default: "summary") |

**Response (200):**

```json
{
  "analysis": "Detailed analysis of the uploaded file...",
  "file_info": {
    "name": "filename.py",
    "size": 4096,
    "type": "text/x-python",
    "hash": "sha256:abc123..."
  },
  "analysis_type": "summary",
  "processing_time_ms": 3200
}
```

### Swarm Connect (Authenticated)

```http
POST /api/swarm/connect
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo_url` | string | No | Repository URL |
| `encryption_enabled` | boolean | No | Enable swarm encryption (default: true) |

**Response (200):**

```json
{
  "connected": true,
  "session_id": "sess_abc123",
  "agents": [
    {
      "id": "code-reviewer",
      "name": "Code Reviewer",
      "status": "active",
      "capabilities": ["Code Review", "Pattern Analysis", "Best Practices"],
      "last_heartbeat": "2024-01-01T00:00:00Z"
    }
  ],
  "encryption_enabled": true,
  "protocol_version": "2.0"
}
```

### List Swarm Agents (Authenticated)

```http
GET /api/swarm/agents
Authorization: Bearer <token>
```

**Response (200):**

```json
{
  "agents": [
    {
      "id": "code-reviewer",
      "name": "Code Reviewer",
      "type": "code-reviewer",
      "status": "active",
      "description": "Analyzes code quality, patterns, and best practices",
      "capabilities": ["Code Review", "Pattern Analysis", "Best Practices"],
      "last_action": "Reviewed main.py",
      "tasks_completed": 42,
      "average_time_ms": 1500
    }
  ],
  "total_agents": 6,
  "active_agents": 3
}
```

---

## WebSocket Protocol

The JARVIS agent supports WebSocket connections for real-time communication, particularly for swarm operations.

### Connection

```
ws://localhost:8000/ws/swarm
```

With Caddy gateway:
```
ws://localhost/ws/swarm?XTransformPort=8000
```

### Message Format

All WebSocket messages use JSON:

```json
{
  "type": "message_type",
  "payload": { ... },
  "timestamp": "2024-01-01T00:00:00Z",
  "request_id": "uuid"
}
```

### Client → Server Messages

#### Subscribe to Agent Events

```json
{
  "type": "subscribe",
  "payload": {
    "agent_ids": ["code-reviewer", "security-auditor"],
    "events": ["status_change", "task_complete", "error"]
  }
}
```

#### Submit Task to Agent

```json
{
  "type": "submit_task",
  "payload": {
    "agent_id": "code-reviewer",
    "task_type": "code_review",
    "task_data": {
      "code": "def hello():\n    print('world')",
      "language": "python"
    },
    "priority": "normal"
  }
}
```

#### Chat Stream

```json
{
  "type": "chat",
  "payload": {
    "message": "Review this code for security issues",
    "stream": true,
    "conversation_id": "conv_abc123"
  }
}
```

### Server → Client Messages

#### Task Progress

```json
{
  "type": "task_progress",
  "payload": {
    "task_id": "task_xyz",
    "agent_id": "code-reviewer",
    "progress": 0.65,
    "status": "processing",
    "message": "Analyzing code patterns..."
  }
}
```

#### Task Complete

```json
{
  "type": "task_complete",
  "payload": {
    "task_id": "task_xyz",
    "agent_id": "code-reviewer",
    "status": "completed",
    "result": {
      "findings": 3,
      "severity": "medium",
      "summary": "Found 3 potential issues..."
    },
    "execution_time_ms": 2500
  }
}
```

#### Chat Stream Chunk

```json
{
  "type": "chat_chunk",
  "payload": {
    "conversation_id": "conv_abc123",
    "chunk": "I've analyzed ",
    "chunk_index": 1,
    "is_final": false
  }
}
```

#### Agent Status Change

```json
{
  "type": "agent_status",
  "payload": {
    "agent_id": "code-reviewer",
    "old_status": "idle",
    "new_status": "processing",
    "current_task": "task_xyz"
  }
}
```

#### Heartbeat

```json
{
  "type": "heartbeat",
  "payload": {
    "server_time": "2024-01-01T00:00:00Z",
    "active_connections": 5
  }
}
```

#### Error

```json
{
  "type": "error",
  "payload": {
    "code": "AGENT_UNAVAILABLE",
    "message": "Agent 'code-reviewer' is currently unavailable",
    "task_id": "task_xyz"
  }
}
```

---

## Error Codes

### Authentication Errors (401)

| Code | Description |
|------|-------------|
| `AUTH_INVALID_CREDENTIALS` | Username or password is incorrect |
| `AUTH_TOKEN_EXPIRED` | JWT token has expired |
| `AUTH_TOKEN_INVALID` | JWT token is malformed or invalid |
| `AUTH_TOKEN_MISSING` | No Authorization header provided |
| `AUTH_ACCOUNT_LOCKED` | Account is locked due to too many failed attempts |
| `AUTH_API_KEY_INVALID` | API key is invalid or revoked |

### Authorization Errors (403)

| Code | Description |
|------|-------------|
| `AUTH_INSUFFICIENT_PERMISSIONS` | User lacks required permissions |
| `AUTH_SCOPE_INSUFFICIENT` | API key scope is insufficient |

### Validation Errors (400)

| Code | Description |
|------|-------------|
| `VALIDATION_ERROR` | Request body validation failed |
| `INVALID_JSON` | Request body is not valid JSON |
| `INVALID_FILE_TYPE` | Uploaded file type is not allowed |
| `FILE_TOO_LARGE` | Uploaded file exceeds size limit |
| `INVALID_AUDIO_FORMAT` | Audio file format is not supported |
| `MISSING_REQUIRED_FIELD` | Required field is missing |

### Rate Limiting Errors (429)

| Code | Description |
|------|-------------|
| `RATE_LIMIT_EXCEEDED` | Request rate limit has been exceeded |
| `RATE_LIMIT_BURST` | Burst rate limit has been exceeded |

### Server Errors (500)

| Code | Description |
|------|-------------|
| `INTERNAL_ERROR` | An unexpected internal error occurred |
| `LLM_ERROR` | Error communicating with LLM provider |
| `STT_ERROR` | Speech-to-text processing failed |
| `TTS_ERROR` | Text-to-speech synthesis failed |
| `SEARCH_ERROR` | Web search request failed |
| `IMAGE_GEN_ERROR` | Image generation failed |
| `UPLOAD_ERROR` | File upload processing failed |
| `SWARM_CONNECTION_ERROR` | Failed to connect to swarm |
| `AGENT_UNAVAILABLE` | Requested agent is unavailable |
| `REDIS_ERROR` | Redis connection or operation failed |
| `DATABASE_ERROR` | Database operation failed |

---

## Rate Limiting

API rate limits are enforced per IP address and per user:

| Endpoint Category | Per-Minute Limit | Per-Hour Limit | Burst Limit |
|-------------------|-----------------|----------------|-------------|
| Chat | 30 | 500 | 5 |
| Voice (STT/TTS) | 15 | 200 | 3 |
| Search | 20 | 300 | 5 |
| Image Generation | 10 | 100 | 2 |
| File Upload | 10 | 100 | 3 |
| Swarm | 20 | 300 | 5 |
| Auth | 10 | 50 | 3 |
| Health/Status | 60 | 3600 | 10 |

### Rate Limit Headers

All responses include rate limit headers:

```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1700000060
Retry-After: 30
```

### Rate Limit Exceeded Response

```json
{
  "error": "Rate limit exceeded. Please try again later.",
  "code": "RATE_LIMIT_EXCEEDED",
  "retry_after": 30,
  "limit": 60,
  "remaining": 0,
  "reset_at": "2024-01-01T00:01:00Z"
}
```

---

*Last updated: 2024 | JARVIS AI Agent System v2.0.0*
