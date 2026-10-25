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
- dhje / 00tr: their criteria say non-admins get 404 on the settings route. The route keeps 403,
  like every admin route (PLAN-v2 D4 and `admin.test.ts` settle 403; an admin route's existence is no
  secret, unlike a resource). Kata c5j3 decides whether all admin routes move to 404 together.
- Migrations stay append-only (`db.ts` `MIGRATIONS`); parallel lanes each append theirs and the
  restack orders them. No deployed database has run a v3 migration before the batch merges.

## CLI tools (f9j0, fx78)

Migration 16 (`db.ts`):

- `version_requires (version_id → item_versions ON DELETE CASCADE, name, PRIMARY KEY (version_id, name))`,
  index on `name`. The CLIs a version's frontmatter requires: `metadata.requires` and top-level
  `requires`, a list or one string, names `^[a-z0-9][a-z0-9._-]{0,63}$`, sorted, at most 50
  (`items/lint.ts` `parseRequires`, written by `items/service.ts` `insertVersion`). The migration
  backfills existing versions with the same rule in SQL.
- `cli_tools (name PK, homepage, check_bin, install JSON {macos?, linux?, windows?, any?}, created_at,
  updated_at)`. Admin-curated; seeded with nothing. `check_bin` defaults to the name and is a binary
  name (`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`); each install command is one line, at most 1000 chars.

Lint codes: `requires.found` (info), `requires.invalid` (warn), `requires.max` (warn),
`requires.toplevel` (info, suggests `metadata.requires`).

Routes (`server/src/tools/routes.ts`, service `server/src/tools/service.ts`):

| Route | Who | Answer |
|---|---|---|
| `GET /api/v1/tools` | any signed-in user | `{tools: ToolView[]}` sorted by name (fx78) |
| `GET /api/v1/tools/:name` | any signed-in user | `{tool: ToolView}`; 404 when no registry row |
| `GET /api/v1/admin/cli-tools` | admin | `{tools: CliTool[]}` sorted by name |
| `POST /api/v1/admin/cli-tools` | admin, write | `201 {tool}`; 409 `tool_exists` |
| `PUT /api/v1/admin/cli-tools/:name` | admin, write | `{tool}`; replaces homepage, check, install |
| `DELETE /api/v1/admin/cli-tools/:name` | admin, write | 204 |

`CliTool = {name, homepage, check, install, updatedAt}`; `ToolView = CliTool & {usedBy: {items: [{id,
kind, name, title}], groups: [{slug, name}]}}`, at most 50 of each. `usedBy.items` are the items the
viewer can read (`itemReadSql`) whose latest version requires the tool; `usedBy.groups` are the groups
the viewer can read (`groupReadSql`) serving a member whose served version (pin, else latest) does,
directly or through includes (`access.ts` `requiringGroupsSql`, the upward walk of
`servingGroupsSql`), so another user's private group never appears. When one item reaches a group
twice, the group serves its first occurrence (`resolvedMembers`), so each candidate is confirmed by
`groups/service.ts` `servesRequiringCheck` and a group is listed exactly when its Requires panel lists the
tool (5x0a, v4). Confirmation is bounded per call (`USED_BY_CHECK_BUDGET`: each group's includes and
rows load once across candidates, about 500 statements at most), because any account can build
candidates that fail it; past the budget a group whose panel lists the tool may be missed, never one
whose panel does not. The MCP resource `scp://tools`
(`application/json`) returns the same `{tools}` for the connection's principal, on every endpoint.

Anyone but a full admin (a non-admin, a
group-restricted admin key) gets 404 on the admin routes. Every change is audited as
`cli_tool.create|update|delete` (target `cli_tool`, detail: the homepage, check and commands).

`GET /api/v1/groups/:slug` gains `requires: [{name, items: [{id, name}], tool: {homepage, check,
install} | null, sources?: [githubUrl]}]`, built from the effective members' resolved versions
(`resolvedMembers`, so nested groups and pins count), sorted by name. `sources` appears with
`tool: null` when a requiring item was imported from GitHub. The MCP `get_group` (first page,
`group.requires`) and `get_bundle` (`requires`) carry the same list with a "show the user, do not run"
note. Nothing in these responses reads item frontmatter beyond the names, so an item's
`metadata.install` never reaches a reader.

Web: the group page's "Requires" panel (`GroupDetail.tsx` `RequiresSection`, hidden when empty; a
CLI with a registry row links to `/tools#tool-<name>`), the admin "CLI tools" card
(`AdminSettings.tsx`), and the Tools page (`web/src/pages/Tools.tsx`, `/tools`, main nav "Tools"):
search, one card per registry row with a platform switcher, install command and check one-liner
with copy buttons, homepage, "Used by" links, and inline Edit / Remove / Add for admins only. All of
them build on `web/src/components/CliTools.tsx` and `web/src/api-tools.ts`.

## Shared files

Lanes S, C and B touch `db.ts` `MIGRATIONS`, `web/src/api*.ts`, `README.md`, `AdminSettings.tsx`
and `GroupDetail.tsx` alongside lane I. Each lane appends rather than rewrites (new migration at
the end, its own README section, its own settings section) so the restack conflicts are mechanical.
