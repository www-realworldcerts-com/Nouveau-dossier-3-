# JARVIS v2

Next.js 16 / React 19 / Tailwind 4 dashboard for the JARVIS agent: chat, voice,
swarm agents, file analysis, image generation and web search. The API layer is
server-side (`src/app/api/jarvis/**`) and calls `z-ai-web-dev-sdk`; no model key
is exposed to the browser.

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

`.env` is ignored by git. Commit only `.env.example`; never a real key or the
SQLite file.

## Checks

```bash
bunx tsc --noEmit     # strict typecheck
bun run lint          # eslint
bun run build         # production compile
```

All three are expected to pass. `next build` now enforces types (the previous
`ignoreBuildErrors` flag was removed), so a type regression fails the build
instead of shipping.

## Layout

| Path | Contents |
| --- | --- |
| `src/app/page.tsx` | dashboard shell (auth gate + tabs) |
| `src/app/api/jarvis/` | chat, voice, swarm, upload, image, search routes |
| `src/components/jarvis/` | Chat, Voice, Swarm, FileUpload, Status, Visualizer |
| `src/lib/jarvis-store.ts` | Zustand store and client types |
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
