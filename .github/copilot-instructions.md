# Copilot / IDE instructions

This repository is a monorepo with two independent Node projects:

- **Root** (`/`): the revenue swarm and payment/resilience engine. Package
  manager: npm (`package-lock.json`). Entry point: `scripts/auto-restart-loop.js`.
- **JARVIS** (`/jarvis`): Next.js 16 dashboard and API. Package manager: Bun
  (`jarvis/bun.lock`). Read `jarvis/AGENTS.md` and `jarvis/README.md` before
  editing it.

Rules:

- Run commands inside the project you are changing; do not install root
  dependencies into `jarvis/` or vice versa.
- `jarvis/jarvis-package/` and `jarvis/examples/` are distribution/reference
  copies, excluded from typecheck and lint. Change `jarvis/src/` instead.
- Never commit `.env` files, `jarvis/db/*.db`, tokens or keys.
- For JARVIS changes, verify with `cd jarvis && bunx tsc --noEmit && bun run lint && bun run build`.
- For root changes, run the relevant `npm run test:*` suite and keep the
  lockfile intact.

To open both projects in one IDE window, use `swarm.code-workspace`.
