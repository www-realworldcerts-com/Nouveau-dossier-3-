# JARVIS AI Agent System - Architecture Documentation

> Comprehensive system architecture documentation for JARVIS v2.0.0

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Component Architecture](#component-architecture)
3. [Python Agent Architecture](#python-agent-architecture)
4. [Next.js Web Architecture](#nextjs-web-architecture)
5. [Security Architecture](#security-architecture)
6. [Swarm Intelligence Architecture](#swarm-intelligence-architecture)
7. [Voice Pipeline Architecture](#voice-pipeline-architecture)
8. [Data Flow](#data-flow)
9. [State Management](#state-management)
10. [Deployment Architecture](#deployment-architecture)

---

## System Overview

JARVIS is a two-tier application consisting of a Python FastAPI backend agent and a Next.js 16 frontend web application, connected through RESTful APIs and WebSockets. The system is designed with security-first principles, implementing end-to-end encryption, JWT authentication, and comprehensive audit logging.

### Design Principles

1. **Security First** - All data is encrypted at rest (AES-256-GCM) and in transit (WSS/TLS)
2. **Modular Architecture** - Each subsystem is a standalone module that can be used independently
3. **Agent as Orchestrator** - The JarvisAgent composes all subsystems and routes requests through a unified pipeline
4. **Graceful Degradation** - Systems fall back gracefully when optional dependencies are unavailable
5. **Horizontal Scalability** - Stateless design enables horizontal scaling behind load balancers
6. **Real-time Communication** - WebSocket support for live updates and streaming responses

### High-Level Architecture Diagram

```
                         ┌──────────────────────┐
                         │    Load Balancer      │
                         │    (NGINX/Caddy)      │
                         └──────────┬───────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
          ┌─────────┴─────────┐           ┌─────────┴─────────┐
          │   JARVIS Web      │           │   JARVIS Agent    │
          │   (Next.js 16)    │           │   (FastAPI)       │
          │   Port 3000       │           │   Port 8000       │
          │                   │           │                   │
          │  - React UI       │◄─────────►│  - LLM Chat       │
          │  - Zustand Store  │   HTTP    │  - Voice STT/TTS  │
          │  - API Routes     │   WS      │  - Swarm Mgmt     │
          │  - Prisma ORM     │           │  - File Analysis  │
          │  - SQLite DB      │           │  - Security Layer  │
          └───────────────────┘           └─────────┬─────────┘
                                                    │
                                          ┌─────────┴─────────┐
                                          │      Redis         │
                                          │   (Cache/Broker)   │
                                          │   Port 6379        │
                                          └───────────────────┘
```

---

## Component Architecture

### Technology Stack Layers

```
┌─────────────────────────────────────────────┐
│              PRESENTATION LAYER              │
│  React 19 + Next.js 16 + Tailwind CSS 4    │
│  shadcn/ui + Framer Motion + Lucide Icons   │
├─────────────────────────────────────────────┤
│              STATE LAYER                     │
│  Zustand (client) + TanStack Query (server) │
│  Prisma ORM (database)                      │
├─────────────────────────────────────────────┤
│              API LAYER                       │
│  Next.js API Routes + FastAPI Endpoints     │
│  z-ai-web-dev-sdk (AI capabilities)         │
├─────────────────────────────────────────────┤
│              BUSINESS LOGIC LAYER            │
│  JARVIS Agent Core + Swarm Agents           │
│  Voice Engine + Memory + Personality        │
├─────────────────────────────────────────────┤
│              SECURITY LAYER                  │
│  JWT Auth + AES-256-GCM + Rate Limiting     │
│  Input Validation + Audit Logging           │
├─────────────────────────────────────────────┤
│              DATA LAYER                      │
│  SQLite (Prisma) + Redis (Cache/Broker)     │
│  File System (Uploads/Logs)                 │
├─────────────────────────────────────────────┤
│              INFRASTRUCTURE LAYER            │
│  Docker + Docker Compose + Kubernetes       │
│  NGINX Ingress + TLS/Cert-Manager           │
└─────────────────────────────────────────────┘
```

---

## Python Agent Architecture

The Python agent is the brain of the JARVIS system. It's built on FastAPI and follows a modular design where each subsystem is a standalone module.

### Module Architecture

```
python-agent/
├── main.py                   # FastAPI app with lifespan handler
├── config.yaml               # Agent configuration
├── requirements.txt          # Python dependencies
├── jarvis_core/              # Core modules
│   ├── __init__.py           # Package exports
│   ├── agent.py              # Main JARVIS agent (orchestrator)
│   ├── voice.py              # Voice interface (STT/TTS)
│   ├── security.py           # JWT, encryption, rate limiting
│   ├── swarm_connector.py    # Swarm WebSocket connectivity
│   ├── upload_handler.py     # File upload processing
│   ├── memory.py             # Persistent conversation memory
│   └── personality.py        # Dynamic personality engine
├── api/                      # API layer
│   ├── routes.py             # API route definitions
│   ├── auth.py               # Authentication module
│   └── middleware.py         # Middleware pipeline
└── swarm_agents/             # Specialized agents
    ├── base_agent.py         # Abstract SwarmAgent base
    ├── code_reviewer.py      # Code review agent
    ├── security_auditor.py   # Security audit agent
    ├── test_engineer.py      # Test generation agent
    ├── web_performance.py    # Performance audit agent
    ├── payment_agent.py      # Payment processing agent
    └── custom_agent.py       # Configurable custom agent
```

### Agent Processing Pipeline

When a request arrives at the JARVIS agent, it flows through the following pipeline:

```
Request → Auth → Rate Limit → Decrypt → Validate → Route → Process → Encrypt → Respond
                                                  │
                                      ┌───────────┴───────────┐
                                      │    Intent Detection    │
                                      └───────────┬───────────┘
                                                  │
                    ┌─────────┬─────────┬─────────┼─────────┬─────────┐
                    ▼         ▼         ▼         ▼         ▼         ▼
              Chat/LLM    Voice     Search    Upload    Swarm    Image
              Handler    Handler   Handler   Handler  Handler   Handler
                    │         │         │         │         │         │
                    └─────────┴─────────┴─────────┴─────────┴─────────┘
                                          │
                                   ┌──────┴──────┐
                                   │   Memory     │
                                   │   Store      │
                                   └─────────────┘
```

### Intent Detection

The agent uses regex-based pattern matching to route user input to the appropriate handler:

| Intent | Patterns | Handler |
|--------|----------|---------|
| Chat | General conversation, questions | `JarvisAgent._handle_chat()` |
| Voice | "speak", "listen", "hear" | `VoiceInterface` |
| Search | "search", "find", "look up" | `WebSearchHandler` |
| Upload | "upload", "analyze file" | `UploadHandler` |
| Swarm | "agent", "swarm", "activate" | `SwarmConnector` |
| Image | "generate image", "create picture" | `ImageGenHandler` |

### Security Module

The security module (`security.py`) provides:

```
┌──────────────────────────────────────────┐
│           Security Module                │
├──────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────────┐  │
│  │ JWT Manager │  │ Encryption Engine │  │
│  │             │  │ (AES-256-GCM)    │  │
│  │ - Generate  │  │ - Encrypt data   │  │
│  │ - Validate  │  │ - Decrypt data   │  │
│  │ - Refresh   │  │ - Key derivation │  │
│  └─────────────┘  └──────────────────┘  │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │ Rate Limiter│  │ Audit Logger     │  │
│  │             │  │                  │  │
│  │ - Per-IP    │  │ - Request log    │  │
│  │ - Per-User  │  │ - Auth events    │  │
│  │ - Sliding   │  │ - Data access    │  │
│  └─────────────┘  └──────────────────┘  │
└──────────────────────────────────────────┘
```

### Memory System

The memory module (`memory.py`) provides persistent conversation storage:

- **ConversationManager** - Manages conversation lifecycles
- **Conversation** - Individual conversation with message history
- **Message** - Individual message with metadata
- **Summary Generation** - Automatic summarization of long conversations
- **Search** - Full-text search across conversation history

---

## Next.js Web Architecture

The frontend is built with Next.js 16 using the App Router pattern, providing both the UI and API proxy layer.

### Application Architecture

```
nextjs-app/
├── src/
│   ├── app/
│   │   ├── layout.tsx           # Root layout (theme, fonts)
│   │   ├── page.tsx             # Main page (AuthGate + Dashboard)
│   │   ├── globals.css          # JARVIS theme + animations
│   │   └── api/jarvis/          # API route handlers
│   │       ├── chat/            # POST - LLM chat
│   │       ├── stt/             # POST - Speech-to-text
│   │       ├── tts/             # POST - Text-to-speech
│   │       ├── search/          # POST - Web search
│   │       ├── image/           # POST - Image generation
│   │       ├── upload/          # POST - File upload
│   │       ├── status/          # GET  - System status
│   │       └── swarm/           # Swarm operations
│   │           ├── connect/     # POST - Connect to swarm
│   │           └── agent/[id]/  # POST - Activate agent
│   ├── components/
│   │   ├── jarvis/              # JARVIS-specific components
│   │   └── ui/                  # shadcn/ui base components
│   ├── hooks/                   # Custom React hooks
│   └── lib/                     # Utilities and stores
│       ├── utils.ts             # Utility functions
│       ├── db.ts                # Prisma client
│       └── jarvis-store.ts      # Zustand state store
```

### Page Component Architecture

```
page.tsx
├── AuthGate (if not authenticated)
│   ├── Animated grid background
│   ├── JARVIS logo with orbiting dot
│   ├── Security features grid
│   └── Initialize JARVIS button
│
└── JarvisDashboard (if authenticated)
    ├── Header
    │   ├── AudioVisualizer (mini)
    │   ├── Title + version
    │   └── Connection status indicator
    ├── StatusBar
    │   ├── Connection status
    │   ├── Encryption badge
    │   ├── Swarm status
    │   └── Clock
    ├── Tabs
    │   ├── Chat (ChatPanel)
    │   │   ├── Message list with scroll
    │   │   ├── Input area with send button
    │   │   └── Microphone recording button
    │   ├── Voice (VoicePanel)
    │   │   ├── Large AudioVisualizer
    │   │   ├── Voice controls
    │   │   └── STT → Chat → TTS pipeline
    │   ├── Swarm (SwarmPanel)
    │   │   ├── Connect button
    │   │   ├── Agent cards with status
    │   │   └── Activate/deactivate controls
    │   └── Files (FileUploadPanel)
    │       ├── Drag-and-drop zone
    │       ├── File list
    │       └── Analysis results
    └── Footer
        └── Version + security info
```

### API Route Pattern

Each API route follows the same pattern:

```typescript
// src/app/api/jarvis/[endpoint]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

export async function POST(req: NextRequest) {
  try {
    // 1. Parse and validate request
    const body = await req.json();

    // 2. Initialize Z-AI SDK
    const zai = await ZAI.create();

    // 3. Process with AI capability
    const result = await zai.capability.method({ ... });

    // 4. Return response
    return NextResponse.json({ ...result, timestamp: Date.now() });
  } catch (error) {
    // 5. Handle errors
    console.error('[JARVIS Endpoint] Error:', error);
    return NextResponse.json({ error: '...' }, { status: 500 });
  }
}
```

---

## Security Architecture

JARVIS implements a 5-layer security model:

### Layer 1: Transport Security

```
Client ──── WSS/TLS ────► NGINX ──── HTTP ────► Agent
                           (TLS termination)
```

- TLS 1.2+ for all external connections
- HSTS headers with 1-year max-age
- Certificate management via cert-manager (Kubernetes)

### Layer 2: Authentication

```
Login Request → Validate Credentials → Generate JWT (access + refresh)
                    │
                    ├── Success: Return tokens
                    └── Failure: Increment failed attempts → Lockout after 5
```

- JWT tokens with configurable expiry (30 min access, 7 day refresh)
- Token refresh rotation to prevent replay attacks
- Account lockout after 5 failed login attempts for 15 minutes
- API key authentication as alternative to JWT

### Layer 3: Authorization

```
Request → Extract Token → Validate → Check Permissions → Allow/Deny
```

- Role-based access control (admin, user, viewer)
- API key scopes (read, write, admin)
- Per-endpoint permission checks

### Layer 4: Data Encryption

```
Plaintext → PBKDF2 Key Derivation → AES-256-GCM Encrypt → Ciphertext + IV + Tag
```

- AES-256-GCM for authenticated encryption
- PBKDF2 with 100,000 iterations for key derivation
- Unique IV (12 bytes) for each encryption operation
- Authentication tags (16 bytes) for integrity verification
- Sensitive field encryption in database

### Layer 5: Application Security

- **Input Validation**: Pydantic models with strict type checking
- **Rate Limiting**: Per-IP and per-user with Redis backend
- **File Upload Security**: Type validation, size limits, quarantine directory
- **CORS**: Strict origin validation with configurable allowlists
- **Security Headers**: CSP, X-Frame-Options, X-Content-Type-Options
- **Audit Logging**: Comprehensive audit trail for all operations

---

## Swarm Intelligence Architecture

The swarm system enables JARVIS to orchestrate multiple specialized AI agents that work together to accomplish complex tasks.

### Agent Hierarchy

```
                    ┌────────────────────┐
                    │  Swarm Coordinator │
                    │  (JARVIS Agent)    │
                    └────────┬───────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────┴──────┐ ┌────┴─────┐ ┌─────┴────────┐
     │ Active Agents │ │ Idle     │ │ Error Agents │
     │               │ │ Agents   │ │              │
     │ - Code Review │ │ - Web    │ │ - (retry)    │
     │ - Security    │ │   Perf   │ │              │
     │ - Test Eng    │ │ - Payment│ │              │
     │               │ │ - Custom │ │              │
     └───────────────┘ └──────────┘ └──────────────┘
```

### Base Agent Lifecycle

Each swarm agent follows a defined lifecycle:

```
Initialized → Idle → Active → Processing → Completed → Idle
                │                     │
                └── Error ←───────────┘
                     │
                     └── Retry (up to 3 times) → Idle
```

### Swarm Communication Protocol

Agents communicate via encrypted WebSocket connections:

```json
// Task Assignment
{
  "type": "task_assign",
  "task_id": "uuid",
  "agent_id": "code-reviewer",
  "payload": "<encrypted_payload>",
  "priority": "high",
  "deadline": "2024-01-01T00:00:00Z"
}

// Task Result
{
  "type": "task_result",
  "task_id": "uuid",
  "agent_id": "code-reviewer",
  "status": "completed",
  "result": "<encrypted_result>",
  "metrics": {
    "execution_time_ms": 1500,
    "tokens_used": 2000
  }
}

// Heartbeat
{
  "type": "heartbeat",
  "agent_id": "code-reviewer",
  "status": "idle",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### Agent Specializations

| Agent | Input | Processing | Output |
|-------|-------|-----------|--------|
| **Code Reviewer** | Source code | Pattern analysis, best practice checking | Review report with suggestions |
| **Security Auditor** | Code/config | OWASP scanning, vulnerability detection | Security report with severity ratings |
| **Test Engineer** | Source code | Test case generation, coverage analysis | Test suite with coverage metrics |
| **Web Performance** | URLs/code | Lighthouse audit, Core Web Vitals | Performance report with optimizations |
| **Payment Gateway** | Transaction data | Policy evaluation, fraud detection | Transaction result with risk score |
| **Custom Agent** | Configurable | User-defined processing | Custom output format |

---

## Voice Pipeline Architecture

The voice pipeline enables natural voice interaction with JARVIS through a STT → Chat → TTS flow.

### Pipeline Flow

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Microphone│───►│   STT    │───►│  JARVIS  │───►│   TTS    │───► Speaker
│ (PyAudio) │    │ Engine   │    │  Agent   │    │ Engine   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                     │                               │
                     ▼                               ▼
              ┌──────────────┐               ┌──────────────┐
              │ Speech       │               │ pyttsx3 /    │
              │ Recognition  │               │ ElevenLabs   │
              │ (Google)     │               │              │
              └──────────────┘               └──────────────┘
```

### STT Pipeline Details

1. **Audio Capture**: PyAudio captures microphone input at 16kHz mono
2. **Preprocessing**: Noise reduction, VAD (Voice Activity Detection)
3. **Recognition**: Google Speech Recognition API (primary), with fallback
4. **Post-processing**: Text normalization, punctuation restoration

### TTS Pipeline Details

1. **Text Chunking**: Split response into natural speech chunks
2. **Voice Selection**: Use configured voice (pyttsx3 default or ElevenLabs)
3. **Synthesis**: Generate audio in configured format (WAV/MP3)
4. **Streaming**: Stream audio chunks to client via API response

### Frontend Voice Flow (VoicePanel)

```
User clicks "Start Listening"
    → navigator.mediaDevices.getUserMedia()
    → MediaRecorder captures audio
    → Audio blob sent to /api/jarvis/stt
    → Transcribed text sent to /api/jarvis/chat
    → Response text sent to /api/jarvis/tts
    → Audio played back via HTMLAudioElement
    → AudioVisualizer shows waveform
```

---

## Data Flow

### Chat Data Flow

```
1. User types message in ChatPanel
   └─→ Zustand store: addMessage({role: 'user', content: '...'})

2. ChatPanel sends POST to /api/jarvis/chat
   └─→ Body: { message, history }

3. API route initializes Z-AI SDK
   └─→ zai.chat.completions.create({ messages, system_prompt })

4. LLM generates response
   └─→ Returns: { response, timestamp }

5. Frontend adds assistant message
   └─→ Zustand store: addMessage({role: 'assistant', content: '...'})
```

### File Upload Data Flow

```
1. User drops file in FileUploadPanel
   └─→ File read as base64 or FormData

2. POST to /api/jarvis/upload with FormData
   └─→ Body: { file: File }

3. API route processes file
   ├─→ Save to disk (optional)
   ├─→ Extract text content
   └─→ Send to LLM for analysis

4. LLM analyzes file content
   └─→ Returns analysis summary

5. Frontend displays analysis
   └─→ Zustand store: addMessage({role: 'assistant', metadata: {type: 'file_upload'}})
```

### Swarm Connection Data Flow

```
1. User clicks "Connect to Swarm" in SwarmPanel
   └─→ POST to /api/jarvis/swarm/connect

2. API establishes connection
   ├─→ Verify repo URL (if provided)
   ├─→ Initialize agent pool
   └─→ Return agent list

3. Frontend updates swarm state
   └─→ Zustand store: setSwarmConnected(true), setSwarmAgents([...])

4. User activates an agent
   └─→ POST to /api/jarvis/swarm/agent/[id]/activate

5. Agent activation
   ├─→ Change agent status to 'active'
   └─→ Return updated agent state

6. Frontend updates agent status
   └─→ Zustand store: updateSwarmAgent(id, {status: 'active'})
```

---

## State Management

### Zustand Store Structure

The Zustand store (`jarvis-store.ts`) manages all client-side state:

```typescript
interface JarvisState {
  // Connection state
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;

  // Voice state
  isListening: boolean;
  isSpeaking: boolean;
  audioLevel: number;

  // Chat state
  messages: Message[];
  isProcessing: boolean;

  // Swarm state
  swarmAgents: SwarmAgent[];
  swarmConnected: boolean;

  // Security state
  isAuthenticated: boolean;
  encryptionEnabled: boolean;

  // UI state
  activeTab: 'chat' | 'voice' | 'swarm' | 'files';
}
```

### Message Types

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: {
    type?: 'search' | 'image_gen' | 'file_upload' | 'swarm' | 'voice' | 'text';
    imageUrl?: string;
    sources?: Array<{ title: string; url: string }>;
    fileName?: string;
    fileSize?: number;
    agentName?: string;
    agentStatus?: string;
  };
  audioUrl?: string;
}
```

### Swarm Agent State

```typescript
interface SwarmAgent {
  id: string;
  name: string;
  type: 'code-reviewer' | 'security-auditor' | 'test-engineer' |
        'web-performance' | 'payment-agent' | 'custom';
  status: 'idle' | 'active' | 'processing' | 'error';
  lastAction?: string;
  description: string;
  capabilities: string[];
}
```

---

## Deployment Architecture

### Docker Compose (Development/Small Scale)

```
┌─────────────────────────────────────────────┐
│              Docker Host                     │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ jarvis-  │  │ jarvis-  │  │  Redis   │  │
│  │ agent    │  │ web      │  │  Alpine  │  │
│  │ :8000    │  │ :3000    │  │  :6379   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │        │
│       └──────┬───────┘              │        │
│              │    jarvis-network    │        │
│              └──────────────────────┘        │
│                                              │
│  Volumes: agent-data, web-data, redis-data  │
└─────────────────────────────────────────────┘
```

### Kubernetes (Production/Scalable)

```
┌─────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                     │
│                                                          │
│  ┌──────────────────────┐  ┌──────────────────────────┐ │
│  │  Ingress Controller  │  │    cert-manager          │ │
│  │  (NGINX)             │  │    (Let's Encrypt)       │ │
│  └──────────┬───────────┘  └──────────────────────────┘ │
│             │                                            │
│  ┌──────────┴───────────────────────────────────────┐   │
│  │                jarvis namespace                   │   │
│  │                                                   │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────┐ │   │
│  │  │ agent-pod-1 │  │ agent-pod-2 │  │  Redis   │ │   │
│  │  │ (FastAPI)   │  │ (FastAPI)   │  │  Stateful │ │   │
│  │  └─────────────┘  └─────────────┘  └──────────┘ │   │
│  │                                                   │   │
│  │  ┌─────────────┐  ┌─────────────┐                │   │
│  │  │ web-pod-1   │  │ web-pod-2   │                │   │
│  │  │ (Next.js)   │  │ (Next.js)   │                │   │
│  │  └─────────────┘  └─────────────┘                │   │
│  │                                                   │   │
│  │  PVCs: agent-data, agent-uploads, web-data       │   │
│  └───────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Resource Requirements

| Service | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---------|------------|-----------|----------------|--------------|
| Agent | 500m | 2000m | 512Mi | 2Gi |
| Web | 250m | 1000m | 256Mi | 1Gi |
| Redis | 100m | 500m | 64Mi | 512Mi |

---

*Last updated: 2024 | JARVIS AI Agent System v2.0.0*
