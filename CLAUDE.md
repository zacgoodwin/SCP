# SCP

Skill / MD / Artifact control plane. Plan and contracts: `docs/PLAN.md`. Research: `docs/research/`.

## Commands

- Gate (must be green before merge): `npm run gate` (typecheck server + web, server tests, web build)
- Server tests only: `npm --prefix server test`
- Run locally: `npm --prefix server run dev` (app :8080, artifact origin :8081, DB `server/data/scp.db`)
- Web dev server: `npm --prefix web run dev` (Vite :5173, proxies `/api`, `/mcp`, `/s` to :8080)
- Docker: `docker compose up -d --build`, then `npm run smoke` (hits the running container)

## Rules

- Server TypeScript runs natively on Node 24 (type stripping): `.ts` import suffixes, `import type`,
  no `enum`/`namespace`/parameter properties.
- All SQL lives behind `db.ts` (schema) and the per-chunk service modules; access checks go through
  `src/access.ts`. Unreadable resources are 404, never 403.
- Artifact HTML is only ever served from the artifact origin with the sandbox CSP. Never from the app origin.
- Never use gray-matter (it evals `---js`); frontmatter parsing is `yaml` via `lib/frontmatter.ts`.
- No hosted LLM API calls. Search is SQLite FTS5.
