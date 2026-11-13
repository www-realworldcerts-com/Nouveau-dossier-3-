# JARVIS agent notes

- Work from `jarvis/` for this app; it has its own package manager and lockfile.
- Source of truth is `src/`. `jarvis-package/nextjs-app/` and `examples/` are
  snapshots/references and are excluded from tsc and eslint — do not fix them
  in place unless the task explicitly targets the distribution package.
- Commands: `bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bun run lint`,
  `bun run build`, `bun run dev`.
- API routes live in `src/app/api/jarvis/**`; they are server-only and call
  `z-ai-web-dev-sdk`. Never move model calls or keys into client components.
- `.env` and `db/*.db` are local only; keep them out of git.
- `next.config.ts` ignores TypeScript build errors, so always run
  `bunx tsc --noEmit` after changing types.
- When adding a route, also add the matching client call and verify the build
  lists it under the route table.
