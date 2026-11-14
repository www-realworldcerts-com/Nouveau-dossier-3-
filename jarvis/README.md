# JARVIS v2

Next.js 16 / React 19 / Tailwind 4 dashboard for the JARVIS agent: chat, voice,
swarm agents, file analysis, image generation and web search. The API layer is
server-side (`src/app/api/jarvis/**`). Chat can run against a local
OpenAI-compatible endpoint (for example Strata) or `z-ai-web-dev-sdk`; no model
key is exposed to the browser.

This app lives inside the revenue-swarm repository as a subproject. It has its
own `package.json` and lockfile; run all commands from this directory.

## Requirements

- Node.js 20.9+ or Bun 1.3+
- SQLite (bundled through Prisma; no server to install)

## Setup

```bash
cd jarvis
bun install --frozen-lockfile

cp .env.example .env          # then edit DATABASE_URL if needed
bun run db:push               # creates db/custom.db from prisma/schema.prisma

bun run dev                   # http://localhost:3000
```

Production build:

```bash
bun run build
bun run start                 # runs .next/standalone/server.js
```

`bun run build` copies `.next/static` and `public/` into the standalone output,
so `bun run start` serves a complete app.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Prisma SQLite URL, e.g. `file:./db/custom.db` |
| `ZAI_VISION_MODEL` | no | Vision model for image uploads; defaults to `glm-4v` |
| `JARVIS_LOCAL_BASE_URL` | no | OpenAI-compatible local endpoint; enables local chat |
| `JARVIS_LOCAL_MODEL` | no | Model name sent to the local endpoint |
| `JARVIS_LOCAL_API_KEY` | no | Key for the local endpoint, if it requires one |
| `JARVIS_LOCAL_TIMEOUT_MS` | no | Local request timeout; defaults to 120000 |
| `JARVIS_ALLOW_CLOUD_FALLBACK` | no | Send chat to ZAI if the local endpoint fails; off by default |

`.env` is ignored by git. Commit only `.env.example`; never a real key or the
SQLite file.

## Checks

```bash
bunx tsc --noEmit     # strict typecheck
bun run lint          # eslint
bun run build         # production compile
bun test test/jarvis-privacy.test.ts test/jarvis-model-gateway.test.ts
```

All three are expected to pass. `next build` now enforces types (the previous
`ignoreBuildErrors` flag was removed), so a type regression fails the build
instead of shipping.

## Local-first model gateway

Strata shows that a capable model can run on the operator's own machine behind
an OpenAI-compatible API. Magpie shows the other half: one gateway, explicit
routing and privacy at the boundary. JARVIS follows both, narrowly:

```bash
# Strata or another OpenAI-compatible server on localhost
export JARVIS_LOCAL_BASE_URL=http://127.0.0.1:8080/v1
export JARVIS_LOCAL_MODEL=qwen3.8-flash-next
bun run dev
```

When `JARVIS_LOCAL_BASE_URL` is set, both chat passes use that endpoint. The
cloud is **not** a silent fallback: set `JARVIS_ALLOW_CLOUD_FALLBACK=true` only
if you accept sending the same prompt to ZAI when the local server is down.
Search, page reading and image generation still need the ZAI tool backend; a
local chat without it works, but those tool calls return a clear error.

Chat also masks high-confidence secrets and personal identifiers before the
request leaves the server: API keys, tokens, private keys, emails, IBANs,
Luhn-valid card numbers, long bank account numbers and Moroccan phone numbers.
The same value gets a stable placeholder, and placeholders in the reply are
restored for the client. The map is request-local; values are never logged or
written to disk. Tool calls do not receive restored secrets, so a search cannot
leak one.

## Operating guardrails

Inspired by Bonsai's governed-agent model, JARVIS is not allowed to turn
confidence into claims of execution:

- Chat and agent prompts share `src/lib/guardrails.ts`. A web search is reported
  as search output, not as a carrier API result or payment confirmation.
- `generate_document` produces `DRAFT` purchase orders, invoices, receipts and
  delivery notes with a visible disclaimer. It never issues an authorization or
  payment-confirmation code.
- `/api/jarvis/status` derives state from `data/swarm-heartbeat.json`,
  `data/resilience/silent-state.json`, the contentieux report, the procurement
  store and the payout ledger. Missing or stale evidence is `unknown`/`blocked`,
  never `online`.
- The status bar reads this endpoint and shows the real runtime state plus the
  open finding count.

The API routes still have **no authentication** (`authRequired: false` is
reported by `/api/jarvis/status`). Do not expose this app publicly until the
routes are protected.

## Layout

| Path | Contents |
| --- | --- |
| `src/app/page.tsx` | dashboard shell (auth gate + tabs) |
| `src/app/api/jarvis/` | chat, voice, swarm, upload, image, search routes |
| `src/components/jarvis/` | Chat, Voice, Swarm, FileUpload, Status, Visualizer |
| `src/lib/jarvis-store.ts` | Zustand store and client types |
| `src/lib/guardrails.ts` | evidence and draft-document rules |
| `src/lib/privacy.ts` | per-request secret/PII masking and restoration |
| `src/lib/model-gateway.ts` | local-first OpenAI-compatible chat with opt-in fallback |
| `src/lib/swarm-state.ts` | real heartbeat/findings/procurement/payout status |
| `prisma/schema.prisma` | SQLite schema (`User`, `Post`) |
| `db/custom.db` | local database, created by `db:push` (ignored) |
| `jarvis-package/` | distribution copy: Docker, Kubernetes, Python agent, docs |

`jarvis-package/` is the container/deployment layer (Docker, Kubernetes,
Python agent, docs). It has **no copy of this app**: its Compose files build
from this directory using `Dockerfile` / `Dockerfile.dev`. Treat `src/` here as
the only source of truth.

## Fixes applied on import

- Generated the Prisma client so `@prisma/client` exports `PrismaClient`.
- Replaced untyped SDK callbacks with the exported `SearchFunctionResultItem`
  type, which also fixed search titles: they were read from a nonexistent
  `title` field instead of `name`.
- Replaced image-size casts with the SDK's own `CreateImageGenerationBody`
  union and a type guard; unsupported sizes (256/512/1792) were removed.
- Corrected the page-reading tool to invoke the SDK's `page_reader`
  (previously called a nonexistent `web_reader` function).
- Added the required `model` to `createVision` (override with
  `ZAI_VISION_MODEL`).
- Added `activate?: boolean` to the swarm activation payload.
- Removed the unused `examples/` tree (it depended on socket.io, which is not a
  project dependency).
- Removed `typescript.ignoreBuildErrors`; `tsc` and `next build` now enforce
  types again.
- Removed the duplicated `jarvis-package/nextjs-app/` tree and pointed its
  Docker/Compose/Makefile/docs at this directory; the old Compose web service
  referenced Dockerfiles that did not exist and could not build.
- Added a workspace file at the repository root for multi-root IDE sessions.

## Container

From this directory:

```bash
docker build -t jarvis-web:2.0.0 .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=file:/app/data/jarvis.db \
  -v jarvis-web-data:/app/data \
  jarvis-web:2.0.0
```

Or from `jarvis-package/` with the full agent + Redis stack:

```bash
cp .env.example .env             # fill in real secrets, then edit
make build                       # builds jarvis-agent and jarvis-web
docker compose up -d             # web is built from ../ via Dockerfile
```

The Compose files expect a `jarvis-package/.env` (gitignored); without it the
agent has no credentials.
