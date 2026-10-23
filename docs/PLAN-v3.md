# SCP v3 plan: the 2026-10-22 import-test backlog

v2 (`docs/PLAN-v2.md`) shipped imports, OAuth, OIDC, admin tools, nested groups and the plugin
marketplace. An import test of 140 public skill and plugin repos and a survey of 37 agent CLI tools
(both 2026-10-22) filed the tickets below. Every rule in `docs/PLAN.md` and `docs/PLAN-v2.md` still
holds (access rules, 404-not-403, path rules, limits, no hosted LLM calls). This file only adds.
Import behaviour changes are recorded in PLAN-v2 D1 (detection order, limits, options) where the
tickets say so; this file holds the chunking and the contracts that have no v2 section.

## Chunks

One linear stax stack, bottom to top, one PR per branch. Lane I is built in order in one worktree
(each branch stacks on the previous); lanes S, C and B are built in parallel worktrees and restacked
onto the top of lane I before shipping. Deferred tickets (`deferred` label) are not in this batch.

| Branch | Kata | Ticket |
|---|---|---|
| `v3-import-fixes` (I1) | 31bp | Zip import: accept backslash separators (Windows Compress-Archive) |
| | a51r | Repo and pack import: skip symlinks instead of failing the import |
| | hs8z | GitHub import: accept www.github.com and scheme-less URLs |
| | xksr | GitHub import refuses kind artifact before downloading |
| | kgtx | Single-file GitHub import stores a doubled source path |
| | qarz | Name-clash message articles ("an agent") |
| | q8f7 | claude-code bundle installs instructions as CLAUDE.md |
| `v3-import-limits` (I2) | dhje | Admin setting: maximum items per import |
| | 00tr | Admin setting: import size limits |
| | a4q8 | GitHub folder import via the Trees API when the archive is over the cap |
| `v3-import-detect` (I3) | 5w3w | Plugin import: group name and description from the manifest |
| | bppq | Marketplace import keeps nested plugins' agents and commands |
| | dnxq | Plugin import reports hooks, MCP servers, output styles (part 1) |
| | 4ky8 | Plugin import: manifest component paths, skip maintainer tooling |
| | ypmn | Multi-harness repos keep the Claude Code copy of a skill |
| `v3-import-options` (I4) | p2wf | Import into an existing group |
| | jwz6 | "Import items in folder as one type" (per-file kinds) |
| | mvfp | Ask what an unrecognised folder of MD files is |
| `v3-import-clash` (I5) | 5ef6 | Prefix on name clash instead of skipping |
| | 0rdh | Ask before skipping units with frontmatter errors |
| `v3-import-frontmatter` (I6) | jcfm | SCP-supplied frontmatter, re-applied on source update |
| | mas4 | Import a single GitHub file as a skill |
| `v3-sso` (S) | 0nhr | SSO accounts can set a break-glass password |
| | 59b0 | SSO sign-in merges with a password account after confirmation |
| `v3-cli-tools` (C) | f9j0 | Group "Requires" panel and the `cli_tools` registry |
| | fx78 | Tools section: install commands per CLI tool |
| `v3-bulk-ui` (B) | y79w | Items lists: multiselect bulk actions |
| | f31d | "Import a file" buttons read "Import" |
| `v3-sast` (X) | eya6 | Required OpenGrep check on PRs into main |

## Decisions taken for this batch

- f9j0 / fx78: install commands come only from the admin `cli_tools` registry, never from item
  frontmatter. The registry starts empty (no seeded rows); seeding stays a human decision.
- dnxq part 2 (serving hooks / MCP servers / output styles as items) is not built. Until a human
  decides, SCP reports those components in `skipped` and never stores or serves them.
- Migrations stay append-only (`db.ts` `MIGRATIONS`); parallel lanes each append theirs and the
  restack orders them. No deployed database has run a v3 migration before the batch merges.

## Shared files

Lanes S, C and B touch `db.ts` `MIGRATIONS`, `web/src/api*.ts`, `README.md`, `AdminSettings.tsx`
and `GroupDetail.tsx` alongside lane I. Each lane appends rather than rewrites (new migration at
the end, its own README section, its own settings section) so the restack conflicts are mechanical.
