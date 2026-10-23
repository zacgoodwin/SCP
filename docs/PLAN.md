# SCP v1 plan

SCP is a self-hosted control plane for three kinds of agent content:

| Plane | Kinds | Examples |
|---|---|---|
| Skills | `skill` | `pdf/SKILL.md` + `scripts/`, any file tree with `SKILL.md` at root |
| MD (prompts) | `agent`, `command`, `instructions`, `prompt`, `design`, `package` | Claude Code subagent `.md`, `AGENTS.md`, prompt snippets, `DESIGN.md`, multi-file definition packages |
| Artifacts | `artifact` | HTML tools, dashboards, decks, documents, components, SVG, Mermaid, Markdown, React (JSX) |

Users log in, create items, and bundle items from all three planes into **groups**. Agents pull a
group over MCP (`/mcp/{group}`) or HTTP (`bundle.zip`), discover by task with search, and write
artifacts back. Artifacts can be shared publicly by unguessable, revocable link and render as
MCP Apps in supporting hosts.

Research behind every decision: `docs/research/*.md` (mcphub, agentkib, bytebridge, formats,
artifacts-mcp-apps, stack).

## Outcomes (how we know it works)

1. `docker compose up -d` on a clean machine gives a healthy container in < 60 s; data survives
   `docker compose down && up` (named volume).
2. A user can register, create a skill + agent MD + artifact, put all three in a group, mint an
   API key, and an MCP client (`@modelcontextprotocol/sdk` Client) on `/mcp/{group}` sees the
   group's catalog, reads the skill, reads the MD, renders the artifact, and creates a new
   artifact. Covered by `scripts/smoke.mjs` against the running container.
3. `GET /api/v1/groups/{slug}/bundle.zip?target=claude-code` unzips into a tree Claude Code
   loads as-is (`.claude/skills/<name>/SKILL.md`, `.claude/agents/<name>.md`, ...).
4. A public share link renders the artifact on the artifact origin with an opaque origin
   (`sandbox` CSP), and revoking the share 404s it.
5. Gate: `npm test` (server unit + integration), `npm run typecheck`, `npm run build` all green.

## Architecture

One Node 24 process, two listeners, one SQLite file.

```
:8080 app origin       SPA (web/dist), /api/v1/*, /mcp, /mcp/:group, /s/:token (share page), /api/health
:8081 artifact origin  /r/:token[/v/:n] (public raw), /r/:token/source (text/plain, sandbox CSP),
                       /p/:sig (signed owner preview). Nothing else.
/data/scp.db           node:sqlite, WAL, named docker volume
```

- Server: Hono + @hono/node-server, TypeScript run natively by Node (type stripping, no build).
- MCP: @modelcontextprotocol/sdk 1.32.1, `WebStandardStreamableHTTPServerTransport`, stateless,
  JSON responses, new `McpServer` per request (built from the DB for that principal + group).
- Web: React 19 + react-router 8 SPA, Vite build, plain CSS, served by the same process.
- No hosted LLM calls anywhere (search is SQLite FTS5).

### Repo layout and ownership

```
server/src/
  main.ts            boot: config, db, migrate, bootstrap admin, two listeners        [C0]
  app.ts             buildApp(ctx) -> { app, artifactApp }; mounts every routes module   [C0]
  config.ts          env -> Config                                                       [C0]
  db.ts              open, migrations, tx(), now(), newId()                              [C0]
  types.ts           Principal, Ctx, row types                                           [C0]
  access.ts          canRead/canEdit for items and groups, visible-group SQL             [C0]
  lib/crypto.ts      scrypt passwords, tokens, sha256, hmac                              [C0]
  lib/http.ts        HttpError, error handler, parseJson(zod), json helpers              [C0]
  auth/middleware.ts principal from cookie (scp_sid) or Bearer key; requireUser/requireScope [C0]
  auth/*             users, sessions, keys, admin users                                  [C1]
  lib/frontmatter.ts lib/paths.ts lib/zip.ts lib/tree.ts                                 [C2]
  items/*            item CRUD, versions, files, lint, import, FTS                        [C2]
  artifacts/*        render, CSP, shares, artifact-origin routes, /s page                 [C3]
  groups/*           group CRUD, members, sharing, bundle export, catalog, search API     [C4]
  mcp/*              MCP endpoint, tools, resources, prompts, viewer shell                [C5]
  audit.ts           audit(ctx, event) + GET /api/v1/audit                                [C0]
server/test/         node:test suites, test/helpers.ts (C0)
web/src/             SPA                                                                  [C6]
Dockerfile, docker-compose.yml, scripts/smoke.mjs                                         [C7]
```

`app.ts` (C0) already imports `authRoutes`, `itemRoutes`, `artifactRoutes`, `artifactOriginRoutes`,
`groupRoutes`, `mcpRoutes` from their modules; C0 ships each as an empty `new Hono()` stub so chunks
only fill their own files. A chunk never edits another chunk's files; if it needs a change in C0
files it says so in its report.

## Data model (owned by `db.ts`, migration 1)

All ids are `newId()` (time-sortable random, 26 chars). Timestamps ISO-8601 UTC text.

- `users(id, email UNIQUE NOCASE, username UNIQUE NOCASE, password_hash, is_admin, disabled, created_at)`
- `sessions(id_hash PK, user_id, created_at, expires_at)`; cookie `scp_sid` holds the raw id.
- `api_keys(id, user_id, name, token_hash UNIQUE, prefix, scopes JSON ["read"|"write"], group_ids JSON|NULL, created_at, last_used_at, expires_at, revoked_at)`.
  Token format `scp_<43 base64url chars>`, stored as sha256 hex, shown once. `group_ids NULL` = all groups the user can read.
- `blobs(sha256 PK, size, data BLOB)` content-addressed file bytes.
- `items(id, owner_id, kind, name, title, description, category, tags JSON, visibility private|public, format, latest_seq, source_repo, source_ref, source_path, forked_from, created_at, updated_at, UNIQUE(owner_id, kind, name))`.
  `format` is only set for artifacts: `html|markdown|svg|mermaid|react|code`. `category` is free text
  (artifact: component|design|deck|document|dashboard|tool|other; MD: roster taxonomy).
- `item_versions(id, item_id, seq, entry_path, tree_sha256, frontmatter JSON, lint JSON, total_bytes, note, created_by_user, created_by_key, created_at, UNIQUE(item_id, seq))`. Immutable.
- `version_files(version_id, path, mode, sha256, size, PK(version_id, path))`.
- `groups(id, owner_id, slug UNIQUE NOCASE, name, description, instructions, tags JSON, visibility private|shared|public, created_at, updated_at)`.
- `group_shares(group_id, user_id, PK)` users a `shared` group is visible to (read only).
- `group_members(group_id, item_id, pinned_seq NULL, install_as NULL, position, added_at, PK(group_id, item_id))`.
- `shares(id, item_id, token_hash UNIQUE, pinned_seq NULL, created_by, created_at, revoked_at)` public artifact links.
- `audit(id AUTOINCREMENT, ts, user_id, key_id, action, target_type, target_id, detail JSON, ip)`.
- `settings(key PK, value)` holds `hmac_secret` (generated on first boot, persists on the volume).
- `items_fts` FTS5(item_id UNINDEXED, name, title, description, tags, body); `groups_fts` FTS5(group_id UNINDEXED, slug, name, description, tags, instructions).

### Item rules

- Every version is a full snapshot file tree (immutable). Bytes stored verbatim, never re-serialized.
- Entry file: skill `SKILL.md`; agent/command/prompt `<name>.md`; instructions `AGENTS.md`;
  design `DESIGN.md`; package declared (default `README.md`); artifact by format
  (`index.html`, `index.md`, `image.svg`, `diagram.mmd`, `App.jsx`, `source.txt`).
- `tree_sha256` = sha256 over the lines `"<mode-octal> <sha256> <path>\n"`, the whole lines sorted in
  UTF-8 byte order (so the mode sorts first, and no UTF-16 code-unit order).
- Limits: 30 MB uncompressed per version, 1000 files (counted before any file is validated), 10 MB
  per file; artifact entry 5 MB; frontmatter 64 KB, YAML anchors allowed but aliases not (either is a
  `frontmatter.invalid` lint). Zip entries may not share or overlap their bytes (400).
- Path rules: POSIX relative, at most 255 characters and 32 segments, no `..`/`.` segments, no absolute/drive/backslash/NUL; no C0/C1
  control, zero-width, bidi-override, BOM, U+061C, U+2028/2029 or HFS+-ignorable (U+206A-206F)
  characters; well-formed Unicode. Two paths that differ
  only in case or Unicode normalization (NFC/NFD) collide.
- Request bodies: 1 MB on `/api/v1` except the upload routes (`POST /items`, `/items/:id/versions`
  45 MB, `/items/import` 35 MB); `/mcp` 12 MB. Over the limit is a 413 `too_large`. The upload routes
  re-check the key or session once the body is in: one revoked (or reset) meanwhile gets 401 and writes nothing.

## Access rules (`access.ts`, C0)

Principal = `{ userId, username, isAdmin, via: 'session'|'key', keyId?, scopes, groupIds: string[]|null }`.
Session principals have scopes `['read','write']` and `groupIds null`.
Scope `write` implies `read`: `POST /keys` stores `['read','write']` whenever `write` is asked for (no
write-only key can be minted), and a stored key row with `write` resolves with `read` added (legacy
rows). A key whose scopes still lack `read` is unusable (401 everywhere), so every route a key reaches
already has `read` and read routes need no per-route scope check.

- Group readable: admin, owner, `public`, or `shared` with the user; AND if `groupIds` is set, the
  group id is in it.
- Group editable: (owner or admin) AND scope `write` AND (groupIds null or contains it).
- Item readable: admin, owner (only when `groupIds` null), `public` (only when `groupIds` null), or
  member of a readable group. A restricted key sees only its groups' contents (full containment).
- Item editable: (owner or admin) AND scope `write` AND groupIds null-or-the-item-is-in-an-allowed-group.
- Reading a group grants read of its members: adding an item to a group publishes it to the group's audience.
- Only items the actor can read can be added to a group, and a group only republishes what its owner
  could publish: their own items or public ones (400 `item_not_shareable`). The same rule applies to
  included groups (v2 D5): a group shared with the owner by name is theirs to read, not to republish.
- Unknown or unreadable resources return 404, never 403 (no existence leak). 403 only when the
  actor can read but lacks write. One exception: group slugs are one global namespace, so
  `POST /groups` answers 409 `slug_taken` for a slug another user holds, private or not.
- A deleted group's slug stays reserved for its owner and admins (409 `slug_taken` to everyone else),
  including groups removed by a user delete: saved `/mcp/<slug>` and bundle URLs never serve a new owner.
- A disabled account's groups and items are unreadable to everyone but admins (404), as are its
  share links and previews. Re-enabling restores all of it.
- A group-restricted key cannot use account-level endpoints (keys, audit, stats, users), create
  groups, or change a group's `sharedWith` or `visibility`, or an item's `visibility` (403
  `restricted_key`): choosing an audience is an account-level act.

## HTTP API (`/api/v1`, cookie session or `Authorization: Bearer scp_...`)

Errors: `{ "error": { "code": "not_found", "message": "..." } }` with the HTTP status.
Cookie-auth mutating requests must pass the Origin check (Hono `csrf`). Bearer requests skip it.

Auth (C1):
```
POST   /auth/register        {email, username, password}            -> 201 {user}   (if registration enabled)
POST   /auth/login           {login, password}                       -> {user} + Set-Cookie
POST   /auth/logout                                                  -> 204
GET    /auth/me                                                      -> {user, principal:{via,scopes,groupIds}}
POST   /auth/password        {current, next}                         -> 204
GET    /auth/config                                                  -> {registration: bool, artifactOrigin, publicUrl}  (no auth)
GET    /keys                                                         -> {keys:[{id,name,prefix,scopes,groupIds,createdAt,lastUsedAt,expiresAt}]}
POST   /keys                 {name, scopes, groups?: slug[], expiresInDays?} -> 201 {key, token}
DELETE /keys/:id                                                     -> 204
GET    /users (admin)        POST /users (admin) {email,username,password,isAdmin}
PATCH  /users/:id (admin)    {isAdmin?, disabled?, password?}       DELETE /users/:id (admin)
```
Login and register are rate limited in memory (429 `rate_limited`): 20 attempts per client IP, then one
per 2 s, shared by both; login also 10 per login name from one client IP, then one per 30 s (so one
client cannot lock an account out of the others), and 100 per login name across all IPs, then one per
6 s (distributed guessing). `POST /auth/password` is a compare-and-swap: if an admin reset lands while
it runs (or its session ends), it answers 401 and changes nothing. Passwords hash with async
scrypt (threadpool). With `SCP_TRUST_PROXY` the client IP is the rightmost `X-Forwarded-For` entry.
A password reset revokes the target's sessions and keys, so an admin cannot reset their own (409:
use `POST /auth/password`). Booleans in the environment (`SCP_ALLOW_REGISTRATION`,
`SCP_TRUST_PROXY`) accept true/false, 1/0, yes/no in any case; anything else stops the boot.
User JSON: `{id, email, username, isAdmin, disabled, createdAt}`. Password min 8 chars.
Username `^[a-z0-9][a-z0-9_-]{1,31}$`.

Items (C2), artifacts are items with `kind: "artifact"`:
```
GET    /items?plane=skill|md|artifact&kind=&q=&owner=me&limit=&offset=   -> {items:[ItemSummary], total}
POST   /items                {kind, name?, title?, description?, category?, tags?, visibility?, format?, files:[FileIn], note?} -> 201 {item}
POST   /items/import         multipart file=<.md|.zip|.skill> [kind] [visibility]               -> 201 {item}
GET    /items/:id                                                                  -> {item}  (ItemDetail)
PATCH  /items/:id            {title?, description?, category?, tags?, visibility?}    -> {item}
DELETE /items/:id                                                                  -> 204
POST   /items/:id/versions   {files:[FileIn], note?}                                 -> 201 {item}
GET    /items/:id/versions                                                         -> {versions:[VersionSummary]}
GET    /items/:id/versions/:seq                                                    -> {version: VersionDetail}
GET    /items/:id/files/*path?version=N                                            -> raw bytes, ETag = sha256
GET    /items/:id/download.zip?version=N                                           -> zip, single top folder <name>/
POST   /items/:id/fork?version=N                                                   -> 201 {item}  (default latest)
GET    /search?q=&plane=&kind=&group=&limit=                                       -> {results:[ItemSummary & {groups?}]}  (FTS over readable items)
```
`FileIn = {path, content?: string(utf8), contentBase64?: string, mode?: 420|493}`.
`ItemSummary = {id, kind, plane, name, title, description, category, tags, visibility, format, latestSeq, owner:{id,username}, updatedAt}`.
`ItemDetail = ItemSummary & {createdAt, source, forkedFrom, version: VersionDetail, groups:[{slug,name}], canEdit}`.
`VersionDetail = {seq, entryPath, treeSha256, frontmatter, lint:[Lint], totalBytes, note, createdAt, createdBy:{userId, keyId}, files:[{path, mode, size, sha256}]}`.
`Lint = {level: error|warn|info, code, message, path?}`. Writes with any `error` lint return 422 with the lint list.
Name: skills `^[a-z0-9]+(-[a-z0-9]+)*$` <= 64; other kinds `^[a-z0-9][a-z0-9._-]{0,63}$`; derived
from frontmatter `name` or title when omitted (an imported skill's wrapper folder comes before the title).
`q` (items and search): at most 8 distinct words, ANDed; words of 3+ characters match as prefixes,
shorter ones exactly.

Artifacts (C3):
```
GET    /items/:id/preview-url?version=N            -> {url}   signed {ART}/p/<sig>, 10 min
GET    /items/:id/shares                            -> {shares:[{id, pinnedSeq, createdAt, revokedAt, url?}]}
POST   /items/:id/shares     {pinnedSeq?: n, pinVersion?: bool} -> 201 {share, url}   url = {PUBLIC}/s/<token>
                                                       pinnedSeq pins that version (1..latest), pinVersion the latest
DELETE /shares/:id                                  -> 204 (sets revoked_at)
GET    /s/:token             (app origin, no auth)  -> HTML share page: title, owner, version, iframe {ART}/r/<token>
GET    {ART}/r/:token[/v/:n] (artifact origin)      -> rendered HTML, strict CSP + sandbox, no-cache. /v/:n only for
                                                       the version the link resolves to now (pinned, else latest);
                                                       404 when the owner is disabled
GET    {ART}/r/:token/source                         -> the entry file as text/plain, sandbox CSP, same 404 rules
GET    {ART}/p/:sig                                  -> rendered HTML for signed preview
```
Rendering is cached per version (versions are immutable). Markdown over 512 KB, or nested over 64
blockquote/list levels on one line, is shown as escaped source; the closer scans of `*`, `_` and `~`
openers share a budget of 2M characters per render, past which further openers stay literal text. A
render that fails shows an error page, never a 500.

Groups (C4):
```
GET    /groups?q=&owner=me&limit=&offset=           -> {groups:[GroupSummary], total}  readable groups, own first;
                                                       limit default 50, max 200
POST   /groups               {slug, name, description?, instructions?, tags?, visibility?, sharedWith?: username[]} -> 201 {group}
GET    /groups/:slug                                -> {group: GroupDetail}
PATCH  /groups/:slug         {name?, description?, instructions?, tags?, visibility?, sharedWith?} -> {group}
DELETE /groups/:slug                                -> 204
PUT    /groups/:slug/members {members:[{itemId, pinnedSeq?, installAs?}]} -> {group}  (replace, keeps order)
POST   /groups/:slug/members {itemId, pinnedSeq?, installAs?}             -> 201 {group}
DELETE /groups/:slug/members/:itemId                                      -> {group}
GET    /groups/:slug/manifest                       -> Manifest (catalog for agents, no bodies)
GET    /groups/:slug/bundle.zip?target=claude-code|codex|generic&scope=project|user -> zip + scp.lock.json
GET    /groups/:slug/catalog.md                     -> roster markdown
GET    /stats                                       -> {skills, mds, artifacts, groups, keys}  (own, for dashboard)
```
`GroupSummary = {id, slug, name, description, tags, visibility, owner:{id,username}, counts:{skill, md, artifact}, updatedAt}`.
`GroupDetail = GroupSummary & {instructions, sharedWith:[username], members:[{item: ItemSummary, pinnedSeq, installAs, resolvedSeq}], endpoints:{mcp, manifest, bundle}, canEdit}`.
`Manifest = {group:{slug,name,description,instructions}, items:[{id, kind, plane, name, title, description, version, installPath}]}`.

Bundle paths (`target=claude-code`; `generic` uses `skills/ agents/ commands/ prompts/ ...`;
`codex` uses `.agents/skills/`, `AGENTS.md`, `.codex/prompts/`):

| kind | project scope path |
|---|---|
| skill | `.claude/skills/<name>/...` |
| agent | `.claude/agents/<name>.md` |
| command | `.claude/commands/<name>.md` |
| instructions | `installAs` or `CLAUDE.md` (user scope: `.claude/CLAUDE.md`); stored as `AGENTS.md`, which `codex` installs |
| design | `installAs` or `DESIGN.md`; its other files always go under `.scp/design/<name>/` |
| prompt | `.scp/prompts/<name>.md` |
| package | `.scp/packages/<name>/...` |
| artifact | `.scp/artifacts/<name>/<entry>` |

Two members mapping to the same path is a 409 on member add and an error lint in the manifest.
A group holds at most 500 members and 20,000 files across their versions (400 `group_full` on add, and
from manifest, `bundle.zip` and `catalog.md` when new versions of unpinned members grow it past that);
`bundle.zip` is refused over 100 MB uncompressed (413 `bundle_too_large`).

Audit (C0): `GET /audit?limit=` own events (admin: all). Events: `login`, `item.create`,
`item.version`, `item.delete`, `group.*`, `key.*`, `share.*`, `mcp.call` (tool name, group),
`bundle.download`.

## MCP (C5)

Endpoints: `POST /mcp` (all readable groups) and `POST /mcp/:group` (one group). Bearer key
required (401 + `WWW-Authenticate: Bearer` otherwise). Cookie sessions are not accepted on MCP.
`initialize.instructions` = group instructions + generated usage hint.

Progressive disclosure tool set (all read tools `readOnlyHint: true`):

| Tool | Input | Output |
|---|---|---|
| `list_groups` | `{q?, offset?}` | readable groups, 50 per page (global endpoint only) |
| `get_group` | `{group?, offset?}` | group info + instructions (first page) + catalog (kind, name, description, version), 50 per page |
| `search` | `{query, plane?, kind?, group?, limit?}` | ranked catalog entries in scope |
| `get_skill` | `{name, group?, version?}` or `{id}` | SKILL.md text + file index + install hint |
| `get_skill_file` | `{name or id, path, version?}` | one file: text (paged) when it decodes as UTF-8 without NUL, else base64 up to 16 KB (larger: the HTTP URL) |
| `get_md` | `{name, kind?, group?}` or `{id}` | MD body + frontmatter + install path |
| `list_artifacts` | `{group?, offset?}` | artifacts in scope, 50 per page, with the total |
| `get_artifact` | `{name or id, version?}` | source text (20,000 characters per call, paged by `offset`) |
| `render_artifact` | `{name or id, version?}` | MCP App: `_meta.ui.resourceUri = ui://scp/viewer/v1`; text has share/preview URL |
| `scp_artifact_content` | `{id, version}` | app-only (`visibility: ["app"]`), rendered HTML for the viewer |
| `get_bundle` | `{group?, target?}` | bundle.zip URL + curl/PowerShell install commands |
| `create_artifact` | `{title, format, content, category?, description?, tags?, name?}` | write scope; adds to current group if editable |
| `update_artifact` | `{id, content, note?}` | write scope; new version |
| `share_artifact` | `{id, version?, pinVersion?}` | write scope; public link, pinned to `version` if given |

Result size: Claude Code reads `structuredContent` and refuses results over 25k tokens, so bodies page at
20,000 characters (`next` gives the following offset), catalog descriptions are clipped to 300
characters, file indexes list 100 files, and `structuredContent` carries each body once (as `text`,
`base64` or a list) with a short `message`, never the body twice.

Resources: `ui://scp/viewer/v1` (`text/html;profile=mcp-app`), template
`scp://items/{id}/v/{seq}/{+path}` (raw file), template `scp://artifacts/{id}/v/{seq}` (rendered HTML,
refused over 100,000 characters: page it with `scp_artifact_content`).
Prompts: every `prompt` and `agent` item in scope is an MCP prompt, at most 200 per endpoint (`arguments`
from frontmatter `arguments: [{name, description, required}]`, the first 32 valid, `{{arg}}` substitution; agent prompts too, wrapped as
"Adopt this agent definition"). On `/mcp/:group` a prompt is named after its item; on the global `/mcp`
the prompt and agent members of the groups the key owns, is shared with by name, or is restricted to
(at most 50 groups, 200 prompts) are prompts named `<groupSlug>.<name>`. Other users' public groups are
never enumerated there (any account can create them): `initialize.instructions` lists the caller's own
groups with descriptions, shared ones by slug and owner only, and just counts the rest; they stay
reachable through `list_groups` and `/mcp/<slug>`. Name clashes
get a `-<kind>` suffix, then an id suffix.

## Chunks

Each chunk ships its tests in the same commit and leaves `npm test` green.

| # | Chunk | Depends | Done when |
|---|---|---|---|
| C0 | Foundation: scaffolding, deps, config, db schema, crypto, http, auth middleware, access, audit, app/main, test helpers, gate | - | `npm test` runs access + crypto + db tests; `node server/src/main.ts` serves `/api/health` |
| C1 | Auth: register/login/logout/me/password, sessions, admin users, API keys, admin bootstrap | C0 | auth tests incl. disabled user, bad password, key revoke/expiry, scope gating |
| C2 | Items: frontmatter, paths, zip, tree hash, blobs, CRUD, versions, files, lint, import, FTS search | C0 | item tests incl. zip-slip, zip bomb, lint codes, CRLF preserved bytes, access matrix |
| C3 | Artifacts: render per format, CSP, artifact origin, signed preview, shares, share page | C0, C2 | render tests per format, CSP sanitize, revoked share 404, sandbox header present |
| C4 | Groups: CRUD, sharing, members, manifest, bundle.zip, catalog.md, stats | C0, C2 | group tests incl. restricted-key containment, path collision 409, bundle tree layout |
| C5 | MCP: endpoint, tools, resources, prompts, viewer shell | C1-C4 | SDK Client integration test over a real port: every tool, scope denial, write-back |
| C6 | Web SPA: login, dashboard, three planes, item editor, groups builder, keys, admin, audit, artifact preview/share | API | `npm run build` green; manual QA via browser |
| C7 | Docker: Dockerfile, compose, .env.example, smoke script, README | all | `docker compose up` healthy; `scripts/smoke.mjs` passes against container |
| C8 | Review + QA loop: adversarial review, browser QA, fix findings | all | no open confirmed findings |

## Out of scope for v1 (file as tickets)

OAuth server for claude.ai remote connectors; Claude Code plugin marketplace export (needs a public
HTTPS hostname); GitHub import; nested groups; semantic/vector search; per-artifact CSP "pinned app"
tools; multi-file HTML artifact bundles; approval queue for agent writes.
