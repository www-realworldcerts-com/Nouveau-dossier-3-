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

All three are expected to pass. The build config sets
`typescript.ignoreBuildErrors: true` for deployment tolerance, so run `tsc`
in CI or before a release — Next.js alone will not catch type regressions.

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

`examples/` and `jarvis-package/` are excluded from this app's typecheck and
lint because they are standalone references and a distributable snapshot, not
part of the Next build. Treat `src/` as the source of truth.

## Fixes applied on import

- Generated the Prisma client so `@prisma/client` exports `PrismaClient`.
- Replaced `Record<string, unknown>` callback annotations that clashed with SDK
  `SearchFunctionResultItem` types.
- Cast image sizes to the SDK's union after runtime validation.
- Added the required `model` to `createVision` (override with
  `ZAI_VISION_MODEL`).
- Added `activate?: boolean` to the swarm activation payload.
- Added the missing `status` field to chat attachments sent to the store.
- Excluded duplicated/example trees from typecheck and lint; added a workspace
  file at the repository root for multi-root IDE sessions.
