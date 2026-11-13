# JARVIS AI Agent System v2.0.0

> **Just A Rather Very Intelligent System**
>
> A secure, personalized AI agent with voice interaction, file uploads, swarm intelligence, and a sophisticated personality inspired by Tony Stark's AI companion.

[![Version](https://img.shields.io/badge/version-2.0.0-cyan)](https://github.com/jarvis-ai/jarvis)
[![Python](https://img.shields.io/badge/python-3.11+-blue)](https://python.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## Features

- **Intelligent Chat** - LLM-powered conversations with JARVIS personality (witty, sophisticated, helpful)
- **Voice Interface** - Speech-to-text and text-to-speech with real-time audio visualization
- **Swarm Intelligence** - Orchestrate 6 specialized agents (Code Reviewer, Security Auditor, Test Engineer, Web Performance, Payment Gateway, Custom)
- **File Analysis** - Upload and analyze documents, code, images with AI-powered insights
- **Web Search** - Real-time web search with source citations
- **Image Generation** - AI-powered image creation from text descriptions
- **End-to-End Encryption** - AES-256-GCM encryption for all sensitive data
- **JWT Authentication** - Secure token-based auth with refresh tokens
- **Rate Limiting** - Configurable rate limiting with Redis backend
- **Audit Logging** - Comprehensive audit trail for all operations
- **Real-time WebSocket** - Live updates and streaming responses
- **Responsive UI** - Dark theme with JARVIS-inspired cyan/teal design, mobile-friendly

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT BROWSER                           │
│  ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Chat Panel │ │ Voice    │ │ Swarm    │ │ File Upload      │ │
│  │           │ │ Panel    │ │ Panel    │ │ Panel            │ │
│  └─────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬─────────┘ │
│        │             │            │                 │           │
│  ┌─────┴─────────────┴────────────┴─────────────────┴────────┐ │
│  │              Zustand State Management                       │ │
│  │  (messages, agents, voice, auth, encryption, tabs)        │ │
│  └────────────────────────┬───────────────────────────────────┘ │
└───────────────────────────┼─────────────────────────────────────┘
                            │ HTTP / WebSocket
┌───────────────────────────┼─────────────────────────────────────┐
│                  NEXT.JS 16 APP ROUTER                         │
│  ┌────────────────────────┴───────────────────────────────────┐ │
│  │                   API Routes (/api/jarvis/)                │ │
│  │  ┌──────┐ ┌─────┐ ┌──────┐ ┌───────┐ ┌─────┐ ┌────────┐ │ │
│  │  │ chat │ │ stt │ │ tts  │ │search │ │image│ │ upload │ │ │
│  │  └──┬───┘ └──┬──┘ └──┬───┘ └──┬────┘ └──┬──┘ └───┬────┘ │ │
│  │     └────────┴───────┴────────┴─────────┴────────┘      │ │
│  │                    z-ai-web-dev-sdk                       │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Swarm API         │  Prisma ORM  │  SQLite Database      │ │
│  │  /swarm/connect    │              │  (users, posts)       │ │
│  │  /swarm/agent/:id  │              │                       │ │
│  └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────┐
│               PYTHON FASTAPI AGENT (Port 8000)                 │
│  ┌────────────────────────┴───────────────────────────────────┐ │
│  │                   Middleware Pipeline                       │ │
│  │  Auth → Rate Limit → Encrypt → Validate → Audit → Route   │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌─────────┐ ┌────────┐ ┌──────────┐ ┌─────────────────────┐  │
│  │ jarvis_ │ │ voice  │ │ security │ │ swarm_connector     │  │
│  │ agent   │ │        │ │          │ │                     │  │
│  └────┬────┘ └───┬────┘ └────┬─────┘ └──────────┬──────────┘  │
│       │          │           │                    │             │
│  ┌────┴──────────┴───────────┴────────────────────┴──────────┐ │
│  │              Swarm Agent Network                          │ │
│  │  ┌────────────┐ ┌────────────────┐ ┌──────────────────┐  │ │
│  │  │ Code       │ │ Security       │ │ Test             │  │ │
│  │  │ Reviewer   │ │ Auditor        │ │ Engineer         │  │ │
│  │  └────────────┘ └────────────────┘ └──────────────────┘  │ │
│  │  ┌────────────┐ ┌────────────────┐ ┌──────────────────┐  │ │
│  │  │ Web        │ │ Payment        │ │ Custom           │  │ │
│  │  │ Perf       │ │ Gateway        │ │ Agent            │  │ │
│  │  └────────────┘ └────────────────┘ └──────────────────┘  │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ┌─────────┐ ┌────────┐ ┌──────────┐                         │
│  │ memory  │ │ upload │ │personality│                         │
│  │         │ │handler │ │          │                         │
│  └─────────┘ └────────┘ └──────────┘                         │
└───────────────────────────────────────────────────────────────┘
                            │
                    ┌───────┴───────┐
                    │     Redis     │
                    │  (Cache/Broker)│
                    └───────────────┘
```

---

## Quick Start

### Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/jarvis-ai/jarvis-package.git
cd jarvis-package

# Copy and configure environment
cp .env.example .env
# Edit .env with your API keys and secrets

# Start all services
docker compose up -d

# Check health
make health
```

Access the application:
- **Web UI**: http://localhost:3000
- **Agent API**: http://localhost:8000
- **API Docs**: http://localhost:8000/docs

### Manual Setup

```bash
# Run the installation script
./scripts/install.sh

# Start all services
./scripts/start.sh
```

### Development

```bash
# Start with hot reload
make dev

# Or with Docker Compose
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

---

## Installation

### Prerequisites

- **Python** 3.11+ (with pip and venv)
- **Node.js** 18+ or **Bun** 1.0+
- **Redis** 7+ (optional, for caching and rate limiting)
- **Docker** 24+ and **Docker Compose** v2 (for containerized deployment)
- **Git** 2.30+

### Option 1: Docker Deployment

1. **Clone and configure**:
   ```bash
   git clone https://github.com/jarvis-ai/jarvis-package.git
   cd jarvis-package
   cp .env.example .env
   ```

2. **Edit environment**:
   ```bash
   # Required: Update these in .env
   JWT_SECRET=<your-secret-key>
   ENCRYPTION_KEY=<your-encryption-key>
   ZAI_API_KEY=<your-zai-api-key>
   ```

3. **Build and start**:
   ```bash
   docker compose up -d --build
   ```

4. **Verify**:
   ```bash
   curl http://localhost:8000/api/health
   ```

### Option 2: Manual Installation

1. **Run the installer**:
   ```bash
   ./scripts/install.sh
   ```

2. **Start services**:
   ```bash
   ./scripts/start.sh
   ```

### Option 3: Development Setup

1. **Install dependencies**:
   ```bash
   # Python agent
   cd python-agent
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt

   # Next.js web (single source of truth one level up)
   cd ../../jarvis
   bun install --frozen-lockfile
   bun run db:push
   ```

2. **Start development servers**:
   ```bash
   # Terminal 1: Agent
   cd python-agent
   source venv/bin/activate
   uvicorn main:app --reload --port 8000

   # Terminal 2: Web (sibling directory, not a copy)
   cd ../jarvis
   bun run dev
   ```

---

## Configuration

All configuration is managed through environment variables. Copy `.env.example` to `.env` and customize:

### Critical Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Secret key for JWT token signing | *Required* |
| `ENCRYPTION_KEY` | AES-256-GCM encryption key | *Required* |
| `ZAI_API_KEY` | Z-AI API key for LLM features | *Required* |

### Service Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `JARVIS_PORT` | Agent API port | `8000` |
| `JARVIS_WEB_PORT` | Web UI port | `3000` |
| `JARVIS_WORKERS` | Uvicorn worker count | `4` |
| `JARVIS_LOG_LEVEL` | Logging level | `info` |
| `REDIS_URL` | Redis connection URL | `redis://redis:6379/0` |

### Security Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `RATE_LIMIT_PER_MINUTE` | API rate limit | `60` |
| `JWT_ACCESS_TOKEN_EXPIRE_MINUTES` | Token expiry | `30` |
| `AUTH_MAX_LOGIN_ATTEMPTS` | Max login attempts | `5` |
| `ENCRYPTION_ALGORITHM` | Encryption algorithm | `AES-256-GCM` |

See `.env.example` for the complete list of 80+ configuration variables.

---

## API Summary

### Chat & Conversation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/jarvis/chat` | POST | Send message, get AI response |
| `/api/jarvis/status` | GET | Get system status |

### Voice

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/jarvis/stt` | POST | Speech-to-text transcription |
| `/api/jarvis/tts` | POST | Text-to-speech synthesis |

### Tools

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/jarvis/search` | POST | Web search |
| `/api/jarvis/image` | POST | Image generation |
| `/api/jarvis/upload` | POST | File upload and analysis |

### Swarm

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/jarvis/swarm/connect` | POST | Connect to swarm network |
| `/api/jarvis/swarm/agent/[id]/activate` | POST | Activate/deactivate agent |

### Python Agent API (Port 8000)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/auth/login` | POST | User authentication |
| `/api/auth/register` | POST | User registration |
| `/api/auth/refresh` | POST | Refresh JWT token |
| `/api/chat` | POST | Chat with JARVIS agent |
| `/api/voice/stt` | POST | Speech-to-text |
| `/api/voice/tts` | POST | Text-to-speech |
| `/api/search` | POST | Web search |
| `/api/upload` | POST | File upload |
| `/api/swarm/connect` | POST | Connect to swarm |
| `/api/swarm/agents` | GET | List swarm agents |
| `/ws/swarm` | WS | WebSocket for swarm |

See [docs/API.md](docs/API.md) for complete API documentation with request/response schemas and examples.

---

## Security Overview

JARVIS implements a multi-layered security architecture:

1. **Authentication** - JWT tokens with RS256/HS256 signing, refresh token rotation
2. **Encryption** - AES-256-GCM for data at rest and in transit
3. **Rate Limiting** - Configurable per-IP and per-user rate limiting via Redis
4. **Input Validation** - Pydantic models for request validation, file type checking
5. **Audit Logging** - Comprehensive audit trail for all operations
6. **CORS** - Strict origin validation with configurable allowlists
7. **Headers** - Security headers (HSTS, CSP, X-Frame-Options, etc.)

See [docs/SECURITY.md](docs/SECURITY.md) for detailed security documentation.

---

## Swarm Integration

JARVIS orchestrates a network of specialized AI agents:

| Agent | Capabilities | Default Status |
|-------|-------------|----------------|
| **Code Reviewer** | Code review, pattern analysis, best practices | Active |
| **Security Auditor** | Vulnerability scanning, security audit, threat analysis | Active |
| **Test Engineer** | Test generation, coverage analysis, regression testing | Active |
| **Web Performance** | Performance audit, Lighthouse analysis, optimization | Idle |
| **Payment Gateway** | Payment processing, policy evaluation, transaction management | Idle |
| **Custom Agent** | Custom tasks, integration, automation | Idle |

Agents communicate via encrypted WebSocket connections using the WSS/TLS protocol. Tasks are distributed based on agent capabilities and current load.

---

## Usage Examples

### Chat with JARVIS

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "message": "Hello JARVIS, what can you do?",
    "history": []
  }'
```

### Speech-to-Text

```bash
curl -X POST http://localhost:8000/api/voice/stt \
  -H "Authorization: Bearer <token>" \
  -F "audio=@recording.wav"
```

### Web Search

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"query": "latest AI research papers"}'
```

### Connect to Swarm

```bash
curl -X POST http://localhost:8000/api/swarm/connect \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/user/repo"}'
```

### Image Generation

```bash
curl -X POST http://localhost:8000/api/image \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"prompt": "A futuristic AI lab", "size": "1024x1024"}'
```

### Python SDK

```python
import requests

class JarvisClient:
    def __init__(self, base_url="http://localhost:8000", token=None):
        self.base_url = base_url
        self.token = token

    def chat(self, message, history=None):
        response = requests.post(
            f"{self.base_url}/api/chat",
            json={"message": message, "history": history or []},
            headers={"Authorization": f"Bearer {self.token}"}
        )
        return response.json()

    def search(self, query):
        response = requests.post(
            f"{self.base_url}/api/search",
            json={"query": query},
            headers={"Authorization": f"Bearer {self.token}"}
        )
        return response.json()

    def connect_swarm(self, repo_url=None):
        response = requests.post(
            f"{self.base_url}/api/swarm/connect",
            json={"repoUrl": repo_url},
            headers={"Authorization": f"Bearer {self.token}"}
        )
        return response.json()

# Usage
jarvis = JarvisClient(token="your-jwt-token")
result = jarvis.chat("Analyze this codebase for security issues")
print(result["response"])
```

---

## Tech Stack

### Backend (Python Agent)

| Technology | Purpose |
|-----------|---------|
| **FastAPI** | Async web framework |
| **Uvicorn** | ASGI server with uvloop |
| **Pydantic** | Data validation and serialization |
| **PyJWT** | JWT token management |
| **cryptography** | AES-256-GCM encryption |
| **SpeechRecognition** | Speech-to-text |
| **pyttsx3** | Text-to-speech |
| **websockets** | WebSocket communication |
| **Redis** | Caching and rate limiting |

### Frontend (Next.js)

| Technology | Purpose |
|-----------|---------|
| **Next.js 16** | React framework with App Router |
| **TypeScript** | Type-safe development |
| **Tailwind CSS 4** | Utility-first styling |
| **shadcn/ui** | UI component library |
| **Zustand** | Client state management |
| **TanStack Query** | Server state management |
| **Prisma** | Database ORM |
| **Framer Motion** | Animations |
| **Lucide Icons** | Icon library |
| **z-ai-web-dev-sdk** | AI capabilities (LLM, TTS, STT, search, image gen) |

### Infrastructure

| Technology | Purpose |
|-----------|---------|
| **Docker** | Containerization |
| **Docker Compose** | Multi-container orchestration |
| **Redis** | Cache, session store, message broker |
| **SQLite** | Primary database (via Prisma) |
| **NGINX** | Ingress controller / reverse proxy |
| **Kubernetes** | Container orchestration (production) |

---

## Project Structure

```
jarvis-package/
├── Dockerfile                    # Multi-stage Docker build
├── docker-compose.yml            # Production Docker Compose
├── docker-compose.dev.yml        # Development override
├── .env.example                  # Environment variable template
├── .gitignore                    # Git ignore rules
├── Makefile                      # Build and deployment targets
├── README.md                     # This file
├── kubernetes/
│   ├── deployment.yaml           # K8s deployments (agent + web)
│   ├── service.yaml              # K8s ClusterIP services
│   └── ingress.yaml              # NGINX ingress with TLS
├── scripts/
│   ├── start.sh                  # Service startup script
│   └── install.sh                # Installation script
├── docs/
│   ├── ARCHITECTURE.md           # System architecture
│   ├── API.md                    # API documentation
│   ├── SECURITY.md               # Security documentation
│   └── DEPLOYMENT.md             # Deployment guide
├── python-agent/                 # Python FastAPI backend
│   ├── main.py                   # FastAPI application entry
│   ├── config.yaml               # Agent configuration
│   ├── requirements.txt          # Python dependencies
│   ├── jarvis_core/
│   │   ├── __init__.py           # Package exports
│   │   ├── agent.py              # Main JARVIS agent
│   │   ├── voice.py              # Voice interface (STT/TTS)
│   │   ├── security.py           # JWT, encryption, rate limiting
│   │   ├── swarm_connector.py    # Swarm WebSocket connectivity
│   │   ├── upload_handler.py     # File upload processing
│   │   ├── memory.py             # Conversation memory
│   │   └── personality.py        # Dynamic personality engine
│   ├── api/
│   │   ├── routes.py             # API route definitions
│   │   ├── auth.py               # Authentication module
│   │   └── middleware.py         # Middleware pipeline
│   └── swarm_agents/
│       ├── base_agent.py         # Abstract base agent
│       ├── code_reviewer.py      # Code review agent
│       ├── security_auditor.py   # Security audit agent
│       ├── test_engineer.py      # Test generation agent
│       ├── web_performance.py    # Performance audit agent
│       ├── payment_agent.py      # Payment processing agent
│       └── custom_agent.py       # Custom agent
└── ../jarvis/                    # Next.js frontend (single source of truth)
    ├── package.json              # Node.js dependencies
    ├── next.config.ts            # Next.js configuration
    ├── tailwind.config.ts        # Tailwind CSS configuration
    ├── prisma/
    │   └── schema.prisma         # Database schema
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx          # Main page with auth + dashboard
    │   │   ├── layout.tsx        # Root layout
    │   │   ├── globals.css       # Global styles with JARVIS theme
    │   │   └── api/jarvis/       # API routes
    │   │       ├── chat/route.ts
    │   │       ├── stt/route.ts
    │   │       ├── tts/route.ts
    │   │       ├── search/route.ts
    │   │       ├── image/route.ts
    │   │       ├── upload/route.ts
    │   │       ├── status/route.ts
    │   │       └── swarm/
    │   │           ├── connect/route.ts
    │   │           └── agent/[id]/activate/route.ts
    │   ├── components/
    │   │   ├── jarvis/
    │   │   │   ├── ChatPanel.tsx      # Chat interface
    │   │   │   ├── VoicePanel.tsx     # Voice interaction
    │   │   │   ├── SwarmPanel.tsx     # Agent management
    │   │   │   ├── FileUploadPanel.tsx # File upload
    │   │   │   ├── AudioVisualizer.tsx # Audio visualization
    │   │   │   └── StatusBar.tsx      # System status
    │   │   └── ui/                    # shadcn/ui components
    │   ├── hooks/
    │   │   ├── use-toast.ts
    │   │   └── use-mobile.ts
    │   └── lib/
    │       ├── utils.ts
    │       ├── db.ts               # Prisma client
    │       └── jarvis-store.ts     # Zustand store
    └── public/
        ├── logo.svg
        └── robots.txt
```

---

## Contributing

We welcome contributions! Please follow these guidelines:

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/my-feature`
3. **Commit** your changes: `git commit -m 'Add my feature'`
4. **Push** to the branch: `git push origin feature/my-feature`
5. **Open** a Pull Request

### Development Guidelines

- Write **TypeScript** for all frontend code (strict mode)
- Write **Python 3.11+** for all backend code with type hints
- Follow **PEP 8** for Python, **ESLint** for TypeScript
- Add **tests** for new functionality
- Update **documentation** for API changes
- Use **conventional commits** for commit messages

### Code Quality

```bash
# Lint all code
make lint

# Run tests
make test

# Check types
cd python-agent && mypy .
cd ../jarvis && bunx tsc --noEmit && bun run lint
```

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

<p align="center">
  <strong>JARVIS</strong> — Just A Rather Very Intelligent System<br>
  Secure • Personalized • Intelligent
</p>
