# Research: AgentKib (starroyhq/agentkib)

Sources (all read 2026-10-20, `main` branch, last push 2026-10-20):

- Repo: https://github.com/starroyhq/agentkib (MIT, TypeScript, 116 stars, 1,569 files)
- README: https://github.com/starroyhq/agentkib/blob/main/README.md
- Feature matrix: https://github.com/starroyhq/agentkib/blob/main/docs/FEATURES.md
- Skill management: https://github.com/starroyhq/agentkib/blob/main/docs/SKILLS.md
- MCP management (Chinese): https://github.com/starroyhq/agentkib/blob/main/docs/MCP-MANAGEMENT.md
- Remote artifacts API (Chinese): https://github.com/starroyhq/agentkib/blob/main/docs/REMOTE-CODEX-WEB.md
- Code read: `packages/backend/src/{mcp-hub,mcp-builtin,mcp-policy,manifest,default-manifest,catalog,skill-package,skill-state,skills,asset-candidates,store-migrations}.ts`,
  `packages/runtime-protocol/src/index.ts`, `apps/desktop/electron/main/web/artifacts.ts`

## 1. What AgentKib is (and is not)

"Local-first desktop control plane for coding-agent context, Skills, sessions, and toolchains."
KIB = "Knowledge & Instruction Base". It is an **Electron desktop app** that reads and writes the
native config of 8 coding agents on one machine. No server, no accounts for core features, no
multi-user. A hosted relay (`api.agentkib.com`, `remote.agentkib.com`) exists for phone access, but
its server code is not in the repo.

SCP is the inverse shape: a multi-user server that agents pull from. So AgentKib is a source of
**data models, safety patterns, and the MCP Hub URL/tool shape**, not of architecture.

Supported agents (the `agentSchema` enum, used everywhere):
`codex`, `claude-code`, `cursor`, `opencode`, `open-claw`, `hermes`, `grok-build`, `antigravity`,
`deepseek-harness` (read-only beta). URL aliases accepted by the Hub: `openclaw`→`open-claw`,
`grok`→`grok-build`, `dsh`→`deepseek-harness`.

## 2. Code structure

```
apps/
  desktop/            Electron app (React, shadcn/ui, TanStack). electron/main/* = IPC, web service, relay
    electron/main/web/artifacts.ts   ticketed artifact preview server (see section 9)
    electron/main/web/service.ts     /api/web/v1 HTTP API for the browser/phone client (218 KB)
    cursor-bridge/                   VS Code extension bridging Cursor IDE
  web/                Separately built web client (Vite + TanStack Router), routes: /connect, /pair, /sessions/$id
packages/
  backend/            All domain logic (~190 files). Runs in a utility process / workers
  runtime-protocol/   RPC method names + shared types (RUNTIME_METHODS)
  conversation-state/, session-catalog/, session-ui/, web-client/   session browsing UI + client
  agent-identity/     agent SVG icons
  claude-bridge-plugin/  Claude Code plugin (.claude-plugin/marketplace.json + hooks/register.js)
docs/                 ~25 docs, many bilingual EN/ZH
qa/                   dated QA evidence reports (acceptance tied to agent versions)
```

Notable dependencies: `@modelcontextprotocol/sdk` (Streamable HTTP server, >= 1.31.0), `zod`
(every boundary), `yaml`, `smol-toml`, `json5`, SQLite (`sql.ts` wrapper) with FTS5.

Backend request model: the renderer calls named RPC methods (`"skills.prepareInstall"` etc.,
section 7.6). Skill operations run in a dedicated Worker: 1 active + max 8 queued requests, 180 s
total deadline for network work, full queue fails immediately.

## 3. Feature inventory (FEATURES.md, complete)

### 3.1 Global ("Across your machine") views

| Area | What it provides | SCP relevance |
|---|---|---|
| Today | Prioritized local actions, recent workspace activity | Low. Maybe "recent pulls / recent agent writes" dashboard |
| Workspaces | Discovered + manually added projects with coverage and warnings | Medium. SCP "consumers/projects" that bind to groups |
| Asset catalog | Machine-wide view of Instructions, Skills, MCP, memory, other agent assets | **High.** Same as SCP's unified catalog across 3 planes |
| Skill Hub | Local Skill library, import, OpenAI/GitHub sources, version selection, deploy, update, rollback, withdraw, recoverable removal | **High.** Direct model for SCP Skill plane |
| Agents | Installation state, config homes, capabilities, discovered assets | Low (local-machine concern) |
| Quota | Provider quota windows via bundled CodexBar sidecar | Skip |
| Insights | Tokens, sessions, Git activity, heatmaps, achievements | Skip (maybe pull counts later) |
| Settings | Discovery roots, tool updates, integrations, privacy, diagnostics | Low |

### 3.2 Workspace views

| Area | What it provides | SCP relevance |
|---|---|---|
| Overview | Agent coverage, shared asset state, signals | Low |
| Continue work | Session browsing + reviewed cross-agent handoff | Skip |
| Assets | Project-scoped Instructions, Skills, MCP, memory, native config | Medium (per-project view) |
| Git | Read-only repo status | Skip |
| Context | Effective load order, scope, overrides, conflicts per agent + dir | Medium. "What will this agent actually get from this group" preview |
| Doctor | Actionable diagnostics across agents | Medium. Lint for SKILL.md / AGENTS.md / artifact manifests |
| Changes | Pending + historical ChangeSets with full diffs | Medium. Version history + diff per asset |

Review-first write flow (applies to every generated write):
`Discover -> Preview effective context + diagnostics -> Generate ChangeSet + complete diff -> Write only after explicit approval`.
Browsing never creates a manifest; `.agentkib/manifest.yaml` is added to the ChangeSet only when
shared assets are first saved.

### 3.3 Session history (skip for SCP)
Opt-in full-text search over 8 agents' transcripts, latest-50 pagination, fork tracking,
cross-agent handoff with redaction, native import adapters. Out of SCP scope. One reusable idea:
**continuation archives chunked as `chunk-000001`**, served by MCP tools `session_search` /
`session_read_chunk` with bounded reads. Same pattern fits large artifacts/MDs read over MCP.

### 3.4 MCP Hub and client connections
- Collect native or pasted MCP configs (`mcpServers`, Codex JSON/TOML, OpenCode local/remote,
  named objects) as **disabled** definitions. Never starts services or copies native secrets on import.
- "Connect an Agent to the Hub": pick workspace + agent, show full Hub URL and native config path,
  copy URL/config, or write a connection-only ChangeSet.
- Per-agent native config formats: Codex + Grok Build TOML; Claude Code, Cursor, OpenCode,
  Antigravity, OpenClaw JSON; Hermes YAML. The Hub entry is always named `agentkib`.
- Enabled global services are defaults; workspace services override; each service's allowed-agent
  list controls publication.
- "Verify Hub" = HTTP MCP handshake + `tools/list`, no tool calls. Explicitly states that
  "config written" and "hub reachable" do not prove the agent reloaded.
- HTTP MCP OAuth credentials are bound to the issuing authorization server.

### 3.5 Skill Hub (section 7)

### 3.6 Tools and updates (skip)
Detects agent CLI installs, version, source, PATH default; runs pinned npm/pnpm/bun/Volta updates
without a shell; falls back to a printed command for Homebrew/remote scripts. Success only after
re-detection at the expected version.

### 3.7 Web access (pattern only)
Pairing grants **read first**; send/approve are separate per-browser permissions plus a host
switch. "A request receipt does not mean a turn completed"; disconnects never auto-retry.
API prefix `/api/web/v1`, HTTP commands + SSE updates, optional `/api/web/v1/socket` WebSocket.

## 4. Workspace manifest (`.agentkib/manifest.yaml`)

The closest thing AgentKib has to an SCP "group": a per-project bundle of instructions, skills,
MCP connections, and memory policy, rendered out to every agent's native files. Zod schema
(`packages/backend/src/manifest.ts`), `schema_version` 1 or 2:

```yaml
schema_version: 2
workspace: { id: "my-app", name: "My App" }      # id non-empty, not "." / ".."
instructions:
  shared: "..."                                    # common AGENTS.md body
  scoped:                                          # per-directory instruction files
    - { path: "services/api", content: "..." }
  platform_overrides:                              # partial record keyed by agent
    claude-code: "..."                             # grok-build override rejected; deepseek read-only
skills:
  - { name: "pdf", path: "skills/pdf", targets: [codex, claude-code] }  # name path-safe, unique
mcp: { config: "mcp.json" }                        # relative path (v2)
connections:
  - name: github
    transport: stdio                               # or http with url: https?://...
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }        # env values MUST be ${VAR} references
    allow_tools: []
    targets: [codex]
memories: { require_approval: true }
adapters:
  codex: { enabled: true, generated_hashes: { "AGENTS.md": "<sha256>" } }
```

Generated native files carry a managed block so user edits outside it survive:
`<!-- agentkib:managed:start -->` ... `<!-- agentkib:managed:end -->`. A file containing the line
`@AGENTS.md` is treated as importing the shared file. `generated_hashes` detects drift.

SCP takeaways:
- `targets: [agent...]` per item is the per-agent filter inside a bundle. SCP groups should carry
  an optional `targets` per member so one "coding" group serves Codex and Claude Code differently.
- `platform_overrides` = agent-specific variant of one MD. Worth a `variants` map on SCP MD items.
- Secrets never inline: `${VAR}` references only. SCP should apply this to any env/config inside
  skills or MD bundles.

## 5. Instruction / MD file conventions per agent (`asset-candidates.ts`)

This is the authoritative map SCP's MD plane needs for "install to agent" export and for typing
MD files. Format: path, kind, description.

| Agent | Instruction files | Skills dir | Agent defs | Other |
|---|---|---|---|---|
| codex | `AGENTS.md` | `.agents/skills` | `.codex/agents` | `.codex/config.toml`, `.codex/hooks.json` |
| claude-code | `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules` | `.claude/skills` | `.claude/agents` | `.claude/settings.json`, `.mcp.json` |
| cursor | `AGENTS.md`, `.cursor/rules`, `.cursor/commands` | `.cursor/skills`, `.agents/skills` | - | `.cursor/hooks.json`, `.cursor/mcp.json` |
| opencode | `AGENTS.md`, `CLAUDE.md` (fallback), `.opencode/commands` | `.opencode/skills`, `.claude/skills`, `.agents/skills` | `.opencode/agents` | `opencode.json(c)`, `.opencode/plugins`, `.opencode/tools` |
| open-claw | `AGENTS.md`, `SOUL.md` (persona), `IDENTITY.md` | `skills`, `.agents/skills` | - | `USER.md`, `MEMORY.md` (memory), `TOOLS.md` |
| hermes | `.hermes.md`, `HERMES.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules` | profile `skills`, `.hermes/skills` | - | - |
| grok-build | `AGENTS.md`, `.grok/rules` | `.grok/skills` | `.grok/agents` | `.grok/plugins`, `.grok/hooks`, `.grok/workflows`, `.grok/config.toml` |
| antigravity | `AGENTS.md`, `GEMINI.md`, `.agents/rules`, `.agent/rules` | `.agents/skills` | - | `.agents/mcp_config.json`, `.agents/plugins` |
| deepseek-harness | `AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md`, `CLAUDE.local.md` | `.dsh/skills`, `.agents/skills` | - | - |

Asset kinds enum (catalog): `instruction`, `skill`, `connection`, `agent`, `hook`, `memory`,
`configuration`. SCP MD types can reuse: `instruction` (AGENTS.md/CLAUDE.md/rules), `agent`
(subagent definitions with frontmatter), plus SCP-specific `prompt`, `design` (DESIGN.md),
`template`.

Claude Code agent/command frontmatter fields AgentKib reads: `name`, `description`, `tools`,
`model`. SCP should parse those from uploaded agent `.md` files for search and display.

## 6. SQLite data model (`store-migrations.ts`)

Relevant tables (SQLite, FTS5):

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  repository_group_id TEXT, manifest_workspace_id TEXT, status TEXT NOT NULL,
  asset_count INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT, last_discovered_at TEXT NOT NULL, last_scanned_at TEXT);

CREATE TABLE catalog_assets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                 -- 'workspace' | 'agent-home' | 'agentkib-home'
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  agent TEXT,                          -- null = agent-agnostic
  kind TEXT NOT NULL,                  -- instruction|skill|connection|agent|hook|memory|configuration
  name TEXT NOT NULL, path TEXT NOT NULL, summary TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0, modified_at TEXT);
-- later migrations add summary_key, summary_params (i18n summaries)
CREATE INDEX idx_catalog_assets_search ON catalog_assets(name, path, summary);

CREATE TABLE memories (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, memory_type TEXT NOT NULL, content TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending | approved | rejected | invalidated
  source_agent TEXT, source_thread TEXT, source_reference TEXT,
  created_at TEXT NOT NULL, approved_at TEXT, invalidated_by TEXT);
CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, project_id UNINDEXED, content);
-- AFTER INSERT / UPDATE OF content / DELETE triggers keep memories_fts in sync

CREATE TABLE audit_events (id TEXT PRIMARY KEY, project_id TEXT, action TEXT NOT NULL,
  detail TEXT NOT NULL, created_at TEXT NOT NULL);   -- e.g. action='memory.propose', detail=<id>
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schema_version

CREATE TABLE mcp_installations (id TEXT PRIMARY KEY, name TEXT NOT NULL, package_kind TEXT NOT NULL,
  identifier TEXT NOT NULL, version TEXT, install_path TEXT, status TEXT NOT NULL,
  installed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE mcp_registry_cache (name TEXT PRIMARY KEY, entry_json TEXT NOT NULL,
  schema_version TEXT NOT NULL, etag TEXT, cached_at TEXT NOT NULL);
CREATE TABLE mcp_tool_cache (server_id TEXT NOT NULL, tool_name TEXT NOT NULL,
  descriptor_json TEXT NOT NULL, probed_at TEXT NOT NULL, PRIMARY KEY(server_id, tool_name));
```

Search implementation: catalog uses `LIKE ? ESCAPE '\'` across name/path/summary with
`%`, `_`, `\` escaped, filters `(?2 IS NULL OR agent=?2)`, limit clamped 1..500. Memory search
uses FTS5 with each whitespace word quoted (`"word"` with `"` doubled) joined by ` AND `, ordered by
`rank`, only `status='approved'`, limit clamped 1..50. Empty query returns latest approved.

Note: skill library state is **not** in SQLite; it is JSON files on disk (section 7.4). SCP should
put it in SQLite instead (multi-user server, no filesystem ownership puzzles).

## 7. Skill Hub (docs/SKILLS.md + skills.ts)

### 7.1 Package definition
- A Skill = one directory rooted at `SKILL.md`; supporting files stay inside the package and are
  never separate top-level assets.
- `SKILL.md` must start with YAML frontmatter `---\n...\n---`, max 1 MiB.
- Frontmatter rules: `name` string, trimmed, non-empty, **<= 64 UTF-8 bytes**; `description`
  string, non-empty, **<= 1024 bytes**; optional `license`, `compatibility` (strings).
  If `name` is absent on local import, the directory name is used. An explicit invalid `name` is
  rejected, never replaced.
- Safe library ID is separate from display name (handles collisions and non-canonical dir names).
- Package limits: 4,096 entries, 512 files, 8 MiB per file, 32 MiB total; text preview 256 KiB.
- Readable over MCP: `SKILL.md`, and files under `references/`, `scripts/`, `assets/` that are not
  dot-files or in `.git`, `node_modules`, `target`, `dist`, `build`, `__pycache__`.
- Private-path filter (excluded from preview, copy, and MCP reads), checked on every path component:
  leading `.`; `node_modules|target|dist|build|__pycache__`; names containing
  `credential|telemetry|session|secret|token`; suffix `.env`, `.pem`, `.key`, `state.db`.
- Path portability: reject `\`, NUL, absolute, `.`/`..` segments, Windows drive prefix,
  `<>:"|?*`, trailing `.`/space, control chars, `CON PRN AUX NUL COM1-9 LPT1-9`; case-folded NFC
  collisions rejected. Symlinks and special files reported, not followed.

### 7.2 Content hash `skill-package-v1`
Deterministic whole-package SHA-256: files sorted by byte order; for each file hash
`u64le(len(name)) | name | u8(executable) | u64le(size) | bytes`. If empty directories exist,
append `0xFF x8 | "agentkib-empty-directories-v1\0"` then `u64le(len) | name` per sorted dir.
SCP should adopt an equivalent canonical hash for skill versions, MD bundles, and artifact bundles
so "same content" dedup and ETags are stable across uploads.

### 7.3 Sources and versions
- Discovery: reviewed OpenAI catalog `https://github.com/openai/skills/tree/main/skills/.curated`
  (source kind `openai-curated`), or any public GitHub repo / tree / `SKILL.md` URL (`github`).
- GitHub fetch via API only, no clone, no code execution:
  `GET /repos/{o}/{r}/commits/{sha}`, `GET /repos/{o}/{r}/git/trees/{tree}?recursive=1`,
  files from `https://raw.githubusercontent.com/{o}/{r}/{commit}/{path}`;
  version lists `GET /repos/{o}/{r}/tags|branches?per_page=50&page=N`.
- "Choose version": tag, branch, or 7-40 char SHA, resolved to full commit in the preview. A
  failed version-list read is reported; it never silently falls back to the default branch.
- Preview freezes resolved commit + downloaded files. Previews expire after **15 min**; 1 GiB cap
  on retained preview snapshots.

Source record:
```ts
type Source = {
  kind: "openai-curated" | "github";
  repository: string;          // "owner/repo"
  ref: string;                 // as selected
  ref_type?: "tag" | "branch" | "commit";
  path: string;                // package dir in repo
  resolved_commit: string;     // full SHA
  tree_sha: string;
};
```

### 7.4 Library lock file (`skills.lock.json`, v1/v2)
```ts
type LockFile = { schema_version: number;
  skills:   Record<libraryId, LockEntry>;
  previous: Record<libraryId, LockEntry> };   // exactly one previous version kept for rollback
type LockEntry = {
  source: Source | null;             // null = local import
  content_sha256: string;
  installed_at: string; updated_at: string;
  display_name?: string;
  local_source?: string | null; local_resolved_path?: string | null;
  upstream_base_hash?: string | null; upstream_display_name?: string;
  snapshot_hash?: string; hash_algorithm?: "skill-package-v1";
  version_origin?: { kind: "github" | "local-import" | "deployment" | "library-edit";
                     deployment_id?: string; operation_id: string };
  library_instance_id?: string;
};
```
Immutable snapshots live under `.skill-state/snapshots/` (no GC in v1); library transactions
journaled under `.skill-state/library-transactions/`.

Update semantics: ordinary update follows the recorded ref (branch = latest; tag/commit = stay).
Rollback restores contents and ref together. Library packages are **never auto-enabled** for an
agent; deployment is explicit.

### 7.5 Deployments, sync state machine, policy
Deployment = complete copy (no symlinks) to a personal or project path. Default targets:

| Agent | Personal | Project |
|---|---|---|
| Codex | `~/.agents/skills` | `.agents/skills` |
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| Cursor | `~/.cursor/skills` | `.cursor/skills` |
| OpenCode | `~/.config/opencode/skills` | `.opencode/skills` |
| OpenClaw | `~/.openclaw/skills` | `skills` in configured workspace |
| Hermes | profile `skills` | `.hermes/skills` |
| Grok Build | `~/.grok/skills` | `.grok/skills` |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills` | `.agents/skills` |

Receipts: project `.agentkib/skill-deployments.json`, reservations
`.agentkib/skill-deployment-reservations.json`; personal in AgentKib Home. Each receipt file
<= 4 MiB and 4,096 records. Deployment origin: `agentkib | adopted | legacy-unknown`.

Three-way sync per location (B = baseline, L = accepted library, D = current dir):

| Comparison | State |
|---|---|
| L = D = B | Current |
| L != B, D = B | Outgoing (push to authorized following locations) |
| L = B, D != B | Incoming (user reclaims or overwrites) |
| L = D != B | Converged (advance baseline only) |
| both changed differently | Conflict (pause auto writes) |
| missing / invalid / unknown ownership | Blocked / unverified (never auto-rebuild or propagate deletes) |

Conflict resolutions: "use library version", "take into library", "save as independent Skill",
"unmanage, keep files". No automatic text merge.

Policy (`skill-sync.json`): check interval off/1h/6h/24h (default daily, auto-writes off).
Per package: `manual | check | auto-update`. Per deployment: `manual | follow | pinned`.
Grants bind package + deployment incarnation + physical location; never inherited.

### 7.6 RPC surface (`RUNTIME_METHODS`, packages/runtime-protocol/src/index.ts)
```
skills.listCatalog  skills.discover  skills.listInstalled  skills.prepareInstall
skills.applyOperation  skills.checkUpdates  skills.prepareUpdate  skills.listVersions
skills.prepareVersionChange  skills.discardPreview  skills.rollback  skills.uninstall
skills.listRemoved  skills.restore  skills.readFile  skills.inventory  skills.targets
skills.getDetail  skills.readDetailFile  skills.prepareImport  skills.prepareImports
skills.applyImports  skills.readPreviewFile  skills.listDeployments
skills.prepareDeployment  skills.applyDeployment
skills.syncState  skills.prepareSync  skills.applySync  skills.syncPolicy
skills.saveSyncPolicy  skills.syncRuns  skills.recoverSync  skills.runDueSync (main-process only)
catalog.searchAssets  workspace.resolveContext
memories.listGlobal / list / search / propose / review
```
Pattern: every mutation is `prepare*` (returns a preview token + full diff) then `apply*`
(token-addressed). "Requests address library, observation and deployment IDs or preview tokens,
never arbitrary filesystem roots."

## 8. MCP Hub (mcp-hub.ts, mcp-builtin.ts, mcp-policy.ts)

### 8.1 Endpoint shape
- Node `http` server, default bind `127.0.0.1:<port>`; LAN mode binds `0.0.0.0` and requires
  `lan_risk_accepted: true`. Settings: `{ port, lan_enabled, lan_risk_accepted }`.
- Routes:
  - `GET /healthz` -> `200 ok`
  - `GET /oauth/callback/{serverId}?code&state[&iss]` -> completes upstream MCP OAuth
  - `POST|GET|DELETE /mcp/v1/workspaces/{workspaceId}/agents/{agent}` -> MCP Streamable HTTP
- **The URL path is the scope.** `{workspaceId}` resolves to a registered workspace; `{agent}`
  selects per-agent policy. This is exactly MCPHub's `/mcp/{group}` idea plus an agent dimension.
- Session handling: `mcp-session-id` header; a session is bound to
  `{workspaceId, registeredWorkspaceId, project, agent, remote}` and a request whose path scope
  differs from the session's gets 404. New sessions only on POST. `sessionIdGenerator: randomUUID`.
- DNS-rebinding protection on: `allowedOrigins` = `http://127.0.0.1:<port>`,
  `http://localhost:<port>`; `allowedHosts` restricted unless LAN.
- Server info `{ name: "agentkib", version: "0.13.0" }`, capabilities `{ tools: {} }`,
  `instructions: "AgentKib local MCP Hub"`. Tools only, no resources/prompts.
- Results: if payload already is a `CallToolResult` pass through; else
  `{ content: [{type:"text", text: JSON.stringify(payload)}], structuredContent: payload }`.
  Errors -> `{ isError: true, content: [{type:"text", text: message}] }`.
- Scope re-asserted on every `tools/list` and `tools/call` ("MCP workspace identity changed;
  reconnect before reading").
- Unauthenticated LAN clients never see built-in tools, only external proxied tools.

### 8.2 Built-in tools (the "agent pulls context" API)

| Tool | Input | Read-only | Returns |
|---|---|---|---|
| `workspace_get_context` | `{ cwd?: string }` | yes | effective agent context (bodies outside workspace stripped to sizes/counts) |
| `asset_list` | `{}` | yes | governed asset inventory for the workspace |
| `asset_get` | `{ path: string }` (required) | yes | `{ path, content }`, max 256 KiB, only paths in inventory |
| `skill_list` | `{}` | yes | `manifest.skills` |
| `memory_search` | `{ query: string, limit?: 1..50 }` | yes | approved memories (FTS5) |
| `memory_propose` | `{ type: enum, content, source_thread?, source_reference? }` | **no** | pending memory; "this never approves it" |
| `session_search` | `{ archive_id, query?: <=256, limit?: 1..20 }` | yes | hits with bounded chunk ranges |
| `session_read_chunk` | `{ archive_id, chunk_id: ^chunk-[0-9]{6}$ }` | yes | one chunk |

`memory_propose.type` enum: `user_preference, project_fact, decision, constraint,
failed_attempt, open_loop, task_state, agent_observation`. The calling agent is recorded as
`source_agent` from the URL, not from the payload.

### 8.3 Per-agent tool policy (`.agentkib/mcp-policy.json`)
```json
{ "schema_version": 1,
  "rules": [ { "agent": "codex", "server_id": null, "mode": "selected", "tools": ["asset_get"] } ] }
```
- `server_id: null` = AgentKib built-in group; else an upstream server ID.
- `mode`: `inherit` (workspace inherits global) | `all` (includes future tools) |
  `selected` (only listed; empty list hides all; new tools not auto-added).
- Unique per `(agent, server_id)`; `tools` only allowed with `selected`; max 8,192 rules,
  4,096 tools/rule, file <= 1 MiB.
- Effective = global rules overlaid by workspace rules (non-`inherit` wins).
- Saving requires the current `revision` (sha256 of all config/policy snapshots); mismatch ->
  "reload before saving" (optimistic concurrency).
- Same rule applied at `tools/list` and again at `tools/call` (a remembered tool name is
  re-checked). Effective access = service switch ∩ target agent ∩ allow_tools ∩ policy.
- Public config `.agentkib/mcp.json`; secrets in restricted `.agentkib/mcp.local.json`. Search
  and copy show only redacted public config. Inline credentials in command/args/URL/`-H` headers
  are refused on import.

## 9. Artifacts (`apps/desktop/electron/main/web/artifacts.ts`, REMOTE-CODEX-WEB.md)

AgentKib "artifacts" are files an agent session produced, surfaced to the remote web client. No
artifact repository, no sharing, no write-back. The **serving model** is the valuable part.

Types:
```ts
type ArtifactPreviewKind = "html" | "image" | "video" | "audio" | "pdf" | "text" | "download";
interface ArtifactEntry { id; name; kind: "file" | "directory"; mime; size; modifiedAt;
                          revision; previewKind }
interface ArtifactTicketOptions { artifactId; expectedRevision?; bundleRootId?; ttlMs?; download? }
```
API (under `/api/web/v1`): `GET artifacts` (file references parsed from a session, cursor paged),
`GET files/workspaces`, `GET files/list`, `GET files/text`, `GET diff`,
`POST artifact-tickets` (preview/download ticket for a file or HTML bundle).

Ticket model:
- Ticket id: 32 chars `[A-Za-z0-9_-]`; URL `{previewOrigin}/p/{ticket}/{entryPath}`.
- TTL default 10 min, allowed 1 s..30 min; max 32 live tickets; parent page renews before expiry.
- HTML: the entry's directory is snapshotted into an in-memory bundle (max **32 MiB / 256 files**,
  depth 12, 64 MiB across all tickets). Bundle revision = sha256 over `[path,len]+bytes`; used as
  `ETag`. `expectedRevision` mismatch -> `409 artifact_changed`.
- Served only on a **separate preview origin**; only GET/HEAD/OPTIONS; Host must equal preview
  origin; raw path validated before URL decoding (traversal).
- Headers on HTML:
  ```
  Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' {base};
    style-src 'unsafe-inline' {base}; img-src {base} data: blob:; media-src {base} blob:;
    font-src {base} data:; connect-src {base}; object-src 'none'; worker-src 'none';
    frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts;
    frame-ancestors {appOrigin...}
  Cache-Control: no-store   Referrer-Policy: no-referrer   X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  ```
  `sandbox allow-scripts` without `allow-same-origin` means the artifact cannot touch the app's
  cookies or API. External CDNs, dev servers, popups, workers are unsupported in v1
  ("set build base to relative paths").
- Media: Range/If-Range, 256 KiB+ transfers rate-limited (2 MiB/s per host, 8 concurrent, 4 per
  device, 429 + `Retry-After: 1`).
- Error codes: `artifact_not_found`, `artifact_ticket_expired` (410), `artifact_changed` (409),
  `artifact_bundle_too_large` (413), `artifact_invalid_origin`, `artifact_invalid_host`,
  `artifact_ticket_limit` (429).

## 10. Cross-cutting safety patterns worth copying

1. **Prepare / review / apply** with server-held preview tokens (15 min TTL) and full diffs. Apply
   re-verifies hashes; partial batch success reported per item; "Retry failed" re-prepares.
2. **Optimistic concurrency via `revision`** hash on every editable document.
3. **Agent writes are proposals** (`memory_propose` -> `pending` until human review). Status set
   `pending | approved | rejected | invalidated`; FTS only serves `approved`.
4. **Identity by stable ID, never by display name**; same-name/different-source stay separate.
5. **One previous version** for rollback plus immutable content-addressed snapshots.
6. **Redaction**: secrets only as `${VAR}` refs or in a separate private store; private-path
   filters on every path component.
7. **Bounded everything**: explicit byte/file/record caps with named error codes.
8. **Audit table** for each mutation (`action`, `detail`, `created_at`).
9. **Honest status**: "config written" != "reachable" != "agent loaded it". Verify = handshake +
   `tools/list`, no tool calls.
10. **Read grants before write grants**; control permissions are separate switches.

## 11. Adopt / adapt / skip for SCP

| AgentKib idea | Verdict | SCP form |
|---|---|---|
| Hub URL scoped by path `/mcp/v1/workspaces/{id}/agents/{agent}` | **Adopt** | `/mcp/{groupSlug}` (MCPHub style) with optional `?agent=` or `/agents/{agent}` to apply per-agent `targets`; bearer token per user/agent key instead of loopback trust |
| Session bound to scope; scope re-checked per call | Adopt | Bind MCP session to `{token, group, agent}`; recheck group membership on every `tools/call` |
| Built-in read tools `asset_list` / `asset_get` / `skill_list` | **Adopt + extend** | `group_get_manifest`, `skill_list`, `skill_get` (SKILL.md + file list), `skill_read_file`, `md_search`, `md_get`, `artifact_search`, `artifact_get` |
| `memory_propose` write-back as pending | **Adapt** | `artifact_create` / `artifact_update` from agents; default `visibility=private`, optional `status=pending` review queue per group; record `source_agent`, `source_thread`, `source_reference` |
| Memory type enum | Adapt | Artifact `kind` enum: `component, design, deck, document, dashboard, tool` (+ `snippet`) |
| Per-agent tool policy `inherit|all|selected` | Adopt (simplified) | Per-group, per-API-key tool allowlist; `selected` mode for write tools |
| Manifest with `targets` and `platform_overrides` | **Adopt** | Group members carry `targets: [agent]`; MD items carry per-agent `variants` |
| `${VAR}` env references only | Adopt | Reject inline secrets in uploaded skill/MD config blocks |
| SKILL.md frontmatter limits (name <= 64 B, description <= 1024 B) | **Adopt exactly** | Same validation on upload/import |
| Package limits, private-path filter, path portability rules | Adopt | Same checks on zip/dir upload of skills and artifact bundles |
| `skill-package-v1` canonical hash | Adopt | `content_hash` column on every version row; dedup + ETag |
| GitHub import via API (no clone), ref selection, resolved commit pin | Adopt | `POST /api/skills/import { url, ref }` -> preview -> apply; store `Source` record verbatim |
| OpenAI curated catalog source | Adopt as seed | "Discover" tab reading `openai/skills/skills/.curated` (and Anthropic skills repo) |
| One previous version for rollback | **Change** | Keep full version history in SQLite (cheap on a server); allow pin to version in group membership |
| Three-way B/L/D sync to native dirs | Skip v1 | SCP serves over HTTP/MCP; optional CLI `scp pull <group>` later writes to the per-agent paths in section 7.5 |
| Per-agent native target path table | Adopt as data | Used by a "download for agent X" zip export and a future CLI |
| Instruction file map (section 5) | Adopt as data | MD type detection + "install as" path suggestions |
| Ticketed preview origin + strict CSP + `sandbox allow-scripts` | **Adopt** | Serve artifact HTML from a separate origin/subdomain or path with sandboxed iframe; public share links are long random tokens but **non-expiring and revocable** (different from AgentKib's 10 min tickets) |
| HTML bundle snapshot limits (32 MiB / 256 files) | Adopt | Artifact bundle upload limits |
| `previewKind` enum | Adopt | `html, image, video, audio, pdf, text, markdown, download` |
| Catalog `LIKE` search / memory FTS5 | Adopt FTS5 | One `search_fts` virtual table over skills, MDs, artifacts (name, description, body) |
| `audit_events` table | Adopt | Log every agent pull and write (also feeds "usage" stats) |
| `revision` optimistic concurrency on saves | Adopt | `If-Match` / `revision` on PUT for all three planes |
| prepare/apply preview tokens | Adapt | Only for imports (GitHub, zip). Plain CRUD edits do not need it |
| Session history, handoff, quota, tool updates, insights, Electron | Skip | Out of scope |
| Proxying upstream MCP servers | Skip | SCP serves skills/MDs/artifacts, not MCP servers (MCPHub covers that) |
| Local-only loopback trust | **Reject** | SCP is multi-user and network-exposed: auth required on every route except public share links |

## 12. Gaps AgentKib does not solve (SCP must design fresh)

- **Multi-user + groups with membership/ownership/sharing.** AgentKib has one user and
  workspace-scoped manifests. SCP needs `users`, `groups`, `group_items(group_id, item_type,
  item_id, version_pin, targets)`, `api_keys(user_id, scopes, group_ids)`.
- **Agent discovery by profile/task.** AgentKib has no "find the right AGENTS.md for this task"
  tool. SCP needs `md_search(query, type, tags)` and `group_resolve(profile|task)` backed by FTS5
  plus tags.
- **Artifact write-back and repository.** AgentKib only previews session-produced files.
- **Public share links.** AgentKib tickets are short-lived device-bound capability URLs and it says
  "do not share". SCP needs durable `share_token` (>=128-bit random), revoke, optional expiry.
- **MCP Apps / ext-apps** (`ui://` resources, `text/html;profile=mcp-app`): AgentKib's Hub exposes
  tools only, no resources. SCP must add `resources/list|read` for artifacts.

## 13. Concrete minimal SCP contracts derived from this research

MCP endpoint (Streamable HTTP, MCP SDK, DNS-rebinding protection on):
```
POST/GET/DELETE /mcp/{groupSlug}            Authorization: Bearer <api_key>
POST/GET/DELETE /mcp/{groupSlug}/agents/{agent}   (applies member targets filter)
GET  /healthz
```
Tool result envelope (copy AgentKib): text JSON + `structuredContent`; errors `isError: true`.

Agent write-back tool (modeled on `memory_propose`):
```json
{ "name": "artifact_create",
  "inputSchema": { "type": "object", "required": ["title", "kind", "content"],
    "properties": {
      "title": {"type": "string", "maxLength": 200},
      "kind": {"enum": ["component","design","deck","document","dashboard","tool"]},
      "content": {"type": "string"},
      "mime": {"type": "string", "default": "text/html"},
      "description": {"type": "string", "maxLength": 1024},
      "tags": {"type": "array", "items": {"type": "string"}},
      "source_thread": {"type": "string"},
      "source_reference": {"type": "string"} } } }
```
`source_agent` taken from the URL/key, never from input. Default `visibility: private`.

Skill version row (from LockEntry + Source):
```
skill_versions(id, skill_id, version, content_hash, hash_algorithm, source_kind,
  source_repository, source_ref, source_ref_type, source_path, resolved_commit, tree_sha,
  version_origin, created_by, created_at)
```
