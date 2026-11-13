# JARVIS agent notes

- Work from `jarvis/` for this app; it has its own package manager and lockfile.
- Source of truth is `src/`. `jarvis-package/` only contains containers, the
  Python agent and docs; its Docker/Compose builds use this directory, so never
  reintroduce a copied Next app there.
- Commands: `bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bun run lint`,
  `bun run build`, `bun run dev`.
- API routes live in `src/app/api/jarvis/**`; they are server-only and call
  `z-ai-web-dev-sdk`. Never move model calls or keys into client components.
- `.env` and `db/*.db` are local only; keep them out of git.
- `next build` enforces types; still run `bunx tsc --noEmit` for a faster,
  isolated signal after changing types.
- When adding a route, also add the matching client call and verify the build
  lists it under the route table.
