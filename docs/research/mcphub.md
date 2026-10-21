# MCPHub research (model for SCP)

Source of truth for this note: the MCPHub repo at commit
`209b74d8ac0a8cf105adf41fb7d9784fa33c662b` (2026-10-20), shallow-cloned and read
directly, plus the docs site. Where the docs and code disagree, the code wins and
the disagreement is called out.

- Docs: https://docs.mcphub.app/ (source lives in the repo under `docs/`, Mintlify)
- Group management: https://docs.mcphub.app/features/group-management
- Repo: https://github.com/samanhappy/mcphub
- Key files read: `src/db/entities/*.ts`, `src/server.ts`, `src/routes/index.ts`,
  `src/middlewares/auth.ts`, `src/services/sseService.ts`,
  `src/services/groupService.ts`, `src/services/smartRoutingService.ts`,
  `src/services/mcpService.ts`, `src/services/templateService.ts`,
  `src/utils/groupAccess.ts`, `src/utils/smartRoutingPath.ts`,
  `frontend/src/App.tsx`, `docker-compose.db.yml`, `Dockerfile`,
  `docs/api-reference/groups.mdx`, `docs/features/authentication.mdx`,
  `docs/features/mcp-apps.mdx`, `docs/configuration/*.mdx`.

## 1. What MCPHub is, in one paragraph

A single Node/Express process that connects to many upstream MCP servers
(stdio, SSE, streamable-http, or OpenAPI-wrapped) and re-exposes them through
stable MCP endpoints. The unit of curation is the **group**: a named list of
servers, each optionally narrowed to a subset of tools/prompts/resources. An
agent is pointed at `/mcp/{group}` and sees only that group's capabilities.
A `$smart` route replaces the full tool list with three meta-tools
(`search_tools`, `describe_tool`, `call_tool`) backed by pgvector semantic
search. A React dashboard manages servers, groups, users, keys, and logs.

SCP mapping: replace "upstream MCP server" with "Skill / MD / Artifact". SCP
items are stored content, not live processes, which removes the hardest half of
MCPHub (process supervision, OAuth to upstreams, per-session clients).

## 2. Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js, Express, TypeScript (ESM) |
| Frontend | React + Vite + Tailwind, served as static files by the same Express app (`express.static(frontendPath)` under `BASE_PATH`, SPA fallback `GET ${basePath}/*`) |
| MCP | `@modelcontextprotocol/sdk` (`SSEServerTransport`, streamable HTTP) |
| Storage | Two modes behind a DAO factory: **file mode** (`data/mcp_settings.json`) and **DB mode** (PostgreSQL via TypeORM, auto-enabled when `DB_URL` is set, or `USE_DB=true`) |
| Vector search | pgvector (`pgvector/pgvector:pg17`), OpenAI-compatible embeddings (`text-embedding-3-small` default, 1536 dims) |
| Auth libs | `jsonwebtoken` (JWT), bcrypt, `@node-oauth/oauth2-server`, optional Better Auth (GitHub/Google/OIDC, DB mode only) |

DAO pattern: `src/dao/XDao.ts` (interface + file impl) and `XDaoDbImpl.ts`
(TypeORM), selected by `DaoFactory` / `DatabaseDaoFactory`. Entities: Activity,
BearerKey, BuiltinPrompt, BuiltinResource, CredentialBinding, Group, OAuthClient,
OAuthToken, Server, SystemConfig, User, UserConfig, VectorEmbedding.

SCP note: SQLite fits this shape fine (TypeORM `simple-json` columns are
SQLite-portable). One storage mode only; the dual file/DB mode is a large
source of MCPHub complexity and bugs (duplicate-name startup failures, legacy
visibility states).

## 3. Entity model (exact fields from `src/db/entities`)

### 3.1 `groups`

```ts
@Entity({ name: 'groups' })
class Group {
  id: string;                 // uuid PK
  name: string;               // varchar(255) UNIQUE, globally reserved
  description?: string;       // text
  instructions?: string;      // text, sent as MCP initialize.instructions
  servers: Array<             // simple-json
    | string                  // shorthand = all tools/prompts/resources
    | {
        name: string;         // server name
        alias?: string;       // exposed name override inside this group
        tools?: string[] | 'all';
        prompts?: string[] | 'all';
        resources?: string[] | 'all';   // resource URIs
        pinnedTools?: string[];         // shown next to meta-tools on $smart/{group}
      }
  >;
  owner?: string;             // username (not FK)
  visibility?: 'private' | 'group' | 'public';  // null = legacy
  sharedWithUsers?: string[]; // usernames, used when visibility = 'group'
  settingsSyncManaged?: boolean;
  createdAt; updatedAt;
}
```

Normalization (`groupService.normalizeGroupServers`): a string entry becomes
`{ name, tools:'all', prompts:'all', resources:'all' }`; missing selectors
default to `'all'`; aliases are trimmed; duplicate exposed names
(`alias || name`) are rejected.

### 3.2 `servers` (the thing groups point at)

```ts
@Entity({ name: 'servers' })
class Server {
  id: uuid; name: varchar UNIQUE;
  type?: 'stdio' | 'sse' | 'streamable-http' | 'openapi';
  description?, url?, command?, args?: string[], env?: Record<string,string>,
  headers?: Record<string,string>, enabled: boolean (default true),
  owner?: string,
  visibility: 'private' | 'group' | 'public' (default 'private'),
  sharedWithUsers?: string[],
  enableKeepAlive?, keepAliveInterval?,
  tools?:     Record<toolName, { enabled; description?; hiddenParams?: string[] }>,
  prompts?:   Record<name, { enabled; description? }>,
  resources?: Record<uri,  { enabled; description? }>,
  options?, oauth?, proxy?, openapi?, passthroughHeaders?, perSessionClient?,
  credentialTemplate?, settingsSyncHash?, settingsSyncManaged?, createdAt, updatedAt
}
```

Two layers of filtering: per-server enable/description overrides (global), then
per-group selection (`tools: [...]`). SCP analog: per-item metadata on the item,
per-group selection on the group membership row.

### 3.3 `users`

```ts
@Entity({ name: 'users' })
class User {
  id: uuid; username: varchar UNIQUE; password: varchar (bcrypt);
  isAdmin: boolean (default false);
  email: varchar UNIQUE nullable; ssoUserId: varchar UNIQUE nullable ('sso_user_id');
  createdAt; updatedAt;
}
```

Roles are binary: admin or not. No manager/viewer roles (docs state this
explicitly). Everything else references users by `username` string, not FK.

### 3.4 `bearer_keys`

```ts
@Entity({ name: 'bearer_keys' })
class BearerKey {
  id: uuid; name: varchar(100); token: varchar(512) (stored plaintext, compared with safeCompare);
  enabled: boolean (default true);
  kind: 'system' | 'user' (default 'system');
  owner?: string;                                   // required for kind 'user'
  accessType: 'all' | 'groups' | 'servers' | 'custom' (default 'all');
  allowedGroups?: string[];                         // names or ids
  allowedServers?: string[];
  createdAt; updatedAt;
}
```

Token is returned in plaintext only once in the create response; list/update
return a masked value. SCP should store a hash (sha256) instead of plaintext;
MCPHub keeps plaintext because it compares with `safeCompare` over all enabled keys.

### 3.5 Other entities worth copying the shape of

- `builtin_prompts`: `id, name UNIQUE, title?, description?, template (text),
  arguments?: [{name, title?, description?, required?}], enabled`. Rendered by
  `{{param}}` substitution, returned as one `user` text message from
  `prompts/get`. **Not group-scoped**: every enabled builtin prompt appears in
  `prompts/list` on every route (`mcpService.ts` ~L4819). SCP must scope MDs to
  groups, this is a gap in MCPHub.
- `builtin_resources`: `id, uri UNIQUE (varchar 1024), name?, description?,
  mimeType?, content (text), enabled`. Same global-scope caveat.
- `activities`: tool-call log. Fields include `timestamp, server, tool, duration
  (int ms), status ('success'|'error'), group, username, keyId, ...`, indexed on
  server/tool/status/group/username/keyId/timestamp. DB mode only.
- `system_config`: singleton row `id='default'` with JSON columns `routing`,
  `install`, `smartRouting`, `oauth`, `network`, `nameSeparator`, etc.
- `user_configs`: `username UNIQUE, routing?, additionalConfig?`.
- `vector_embeddings`: `content_type ('tool'|'market_server'|...), content_id,
  text_content, metadata (json), embedding (vector), dimensions, model`.

## 4. How agents address a group (MCP transport)

Registered in `src/server.ts` after upstreams init:

| Method | Path | Handler |
|---|---|---|
| GET | `${BASE_PATH}/sse/:group(.*)?` | legacy SSE connect |
| POST | `${BASE_PATH}/messages` | legacy SSE messages (`?sessionId=`) |
| POST | `${BASE_PATH}/mcp/:group(.*)?` | streamable HTTP JSON-RPC |
| GET, DELETE | `${BASE_PATH}/mcp/:group(.*)?` | streamable HTTP stream / session close |
| same five | `${BASE_PATH}/:user/sse/...`, `/:user/messages`, `/:user/mcp/:group?` | user-scoped variants; URL username must match key owner |

Every MCP route runs `mcpConnectionRateLimiter`, `smartRoutingPathMiddleware`,
`sseUserContextMiddleware`. Group access is re-checked on every request,
including existing sessions (`authorizeGroupRoute`).

The `:group` segment is overloaded and resolved in this order
(`sseService.isBearerKeyAllowedForRequest`, `groupService.getGroupByIdOrName`):

1. empty: **global route**, all visible servers. Disable with
   `systemConfig.routing.enableGlobalRoute=false` (then 403 "Global routes are
   disabled. Please specify a group ID.").
2. group by `name` (only if `routing.enableGroupNameRoute`, default true), then
   by `id` (UUID).
3. server by name: `/mcp/{server}` exposes one server.
4. `$smart` (or `$smart/{group}`): smart routing. `SMART_ROUTING_PATH` env can
   rename the segment (`^[A-Za-z0-9_-]{1,64}$`); names colliding with it are
   rejected for servers and groups.

Group and server share one namespace in the URL, group wins. SCP should avoid
this ambiguity: separate prefixes (`/mcp/g/{group}`, or only groups addressable).

Endpoint summary from README:

```
/mcp                  all servers
/mcp/{group}          a group
/mcp/{server}         a single server
/mcp/$smart           smart routing over everything visible
/mcp/$smart/{group}   smart routing scoped to a group
/sse/{group}          legacy SSE
```

### 4.1 Tool naming

Multi-server routes qualify tool names `server{sep}tool`. Code default separator
is `-` (`config/index.ts`: `settings.systemConfig?.nameSeparator || '-'`); the
MCP Apps doc shows `weather::forecast`, i.e. a configured `::`. Single-server
Apps-eligible routes expose bare upstream names. Group `alias` replaces the
server prefix.

SCP analog: skill/MD names need a stable namespaced id, e.g. `{owner}/{slug}`,
and the group exposes them by slug or alias.

### 4.2 Group `instructions`

Sent as `instructions` in the MCP `initialize` response:
- `/mcp/{group}` with several servers: group text only.
- single-server group: group text + upstream server instructions, joined
  (blank parts dropped; nothing left = no instructions field).
- `/mcp/$smart/{group}`: group text.
- global, bare `$smart`, server routes: none.

Clients read it once per session, so changes need a reconnect. This is the
cheapest, highest-value feature to copy: SCP group `instructions` should be the
"how to use this pack" text, sent on initialize and also returned by the HTTP
bundle endpoint.

### 4.3 Smart routing (`$smart`)

`tools/list` on `$smart` routes returns meta-tools only (`smartRoutingService.buildSmartRoutingMetaTools`):

- Standard mode (2 steps): `search_tools {query: string (required), limit: int default 10}` → `call_tool {toolName: string (required), arguments?: object}`. Optional `describe_tool` when only top-N results include the schema (`fullSchemaTopN`).
- Progressive disclosure (3 steps): `search_tools` (names + descriptions only) → `describe_tool {toolName}` (full `inputSchema`) → `call_tool`.
- `search_tools` description embeds "Available servers: ..." and examples; results are "most relevant first; score is the query-to-tool similarity (0-1)". Dynamic relevance threshold filters low scores.
- `pinnedTools` on a group's server entry are listed next to the meta-tools on `$smart/{group}` (only if also selected in `tools`).
- Annotations: `search_tools`/`describe_tool` `readOnlyHint: true`; `call_tool` `openWorldHint: true`.
- Embeddings: `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `EMBEDDING_MODEL` (default `text-embedding-3-small`), Azure variants, or `EMBEDDING_SERVICE_URL`. Requires PostgreSQL + pgvector; reindex via `POST /api/smart-routing/reindex`.
- Re-embeds on upstream `tools/list_changed`.

SCP analog: `search_skills` / `get_skill`, `search_prompts` / `get_prompt`,
`search_artifacts` / `get_artifact`. For SQLite without vectors, FTS5 (bm25)
over name + description + tags is the lazy first version; vectors later via
`sqlite-vec` if keyword search proves weak. Note the user's CLAUDE.md forbids
hosted LLM API calls by default, which rules out MCPHub's OpenAI embedding
path unless explicitly approved.

### 4.4 MCP Apps (ext-apps) passthrough

From `docs/features/mcp-apps.mdx`:
- Enabled automatically when the client advertises extension
  `io.modelcontextprotocol/ui` with MIME `text/html;profile=mcp-app`. Legacy
  clients declare it at initialize; `2026-07-28` protocol clients declare it per
  request under `params._meta["io.modelcontextprotocol/clientCapabilities"]`.
- Forwards UI-linked tool metadata (`_meta.ui`, legacy `_meta["ui/resourceUri"]`),
  app-only tools (`_meta.ui.visibility: ["app"]`), `ui://` resources, list-change
  notifications.
- On `$smart` routes it hides app-only tools, strips `_meta.ui`, rejects direct
  calls to app-only tools and unlisted `ui://` reads.
- Multi-server routes probe each upstream for unlisted `ui://` URIs.
- MCPHub does **not** render app UIs in its dashboard.

SCP analog: SCP is the origin of `ui://` resources, not a proxy. Each HTML
artifact can be served as resource `ui://scp/{artifactId}` with mimeType
`text/html;profile=mcp-app`, plus a tool whose `_meta.ui.resourceUri` points at
it. Unlike MCPHub, SCP must also render artifacts in its own web UI and public
share pages (sandboxed iframe).

### 4.5 HTTP (non-MCP) access per group: OpenAPI

Public, no auth (docs: "OpenAPI endpoints are public for easy integration"):

```
GET  /api/openapi.json | /api/openapi.yaml          ?title&description&version&serverUrl
GET  /api/:name/openapi.json | .yaml                 per-group spec
GET  /api/openapi/servers | /api/openapi/stats
GET|POST /api/tools/:serverName/:toolName            execute
GET|POST /api/:name/tools/:serverName/:toolName      execute within group
```

SCP analog: a plain REST "pull the bundle" endpoint matters more than MCP for
skills, because agents (Claude Code) consume skills as files on disk.
Recommended: `GET /api/v1/groups/{slug}/bundle` (JSON manifest) and
`/bundle.zip` (directory tree `skills/<name>/SKILL.md`, `agents/<name>.md`, ...).

## 5. Auth model

### 5.1 Dashboard / management API (`/api/*`, middleware `src/middlewares/auth.ts`)

Order of evaluation:
1. `READONLY=true` check: only `GET` and `${basePath}/tools/*` pass, else 403.
2. **Forward auth** (JWKS-verified gateway JWT, off by default). If the token's
   `iss` matches config, it authenticates or 401s with no fallback.
3. **Bearer key** from `Authorization: Bearer <token>` (header name configurable
   via `systemConfig.routing.bearerAuthHeaderName`). Only `kind:'system'` with
   `accessType:'all'` is accepted for the dashboard API; request user becomes
   `{ username: key.owner || 'system', isAdmin: true }`.
4. **Better Auth session cookie** (GitHub/Google/OIDC; DB mode only), mounted
   at `${BASE_PATH}/api/auth/better`.
5. **JWT** from `x-auth-token` header or `?token=` query. Issued by
   `POST /api/auth/login {username,password}` → `{ success:true, token, user }`.
   Signed with `JWT_SECRET` (ephemeral random if unset, so restarts log everyone
   out), fixed 24h expiry, bound to the current password hash (password change
   invalidates).
6. `systemConfig.routing.skipAuth=true`: synthetic `{username:'guest', isAdmin:true}`.
   Dashboard only, flagged in docs as dangerous.

Default admin: `initializeDefaultUser()` creates `admin` if no users exist,
password from `ADMIN_PASSWORD`, else random and printed to logs (`admin123` under
`pnpm dev`). Self-registration is opt-in (`systemConfig.auth.allowRegistration`),
always creates non-admin users, password needs 8+ chars with letter, number,
special char. `POST /api/auth/register`, `GET /api/auth/user`.

### 5.2 MCP transport auth (`sseService.validateBearerAuth`)

- `systemConfig.routing.enableBearerAuth` (default true). When true, a bearer
  header is required on `/mcp/*` and `/sse/*`; missing → 401 reason `missing`.
- Token matched against enabled `bearer_keys`, else against MCPHub-issued OAuth
  access tokens, else 401.
- `skipAuth` does **not** apply to MCP routes.
- Key scoping (`isBearerKeyAllowedForRequest`):

| `kind` / `accessType` | Global `/mcp` | `/mcp/{group}` | `/mcp/{server}` |
|---|---|---|---|
| `user` (any) | owner's live visibility | owner's live visibility | owner's live visibility |
| system `all` | yes, sees private too | yes | yes |
| system `groups` | no | if group name or id in `allowedGroups` | no |
| system `servers` | no | only if **every** server in the group is in `allowedServers` (GHSA-454m-4vm6-842f) | if in `allowedServers` |
| system `custom` | no | group in `allowedGroups`, or full containment of servers | if in `allowedServers` |

User keys (`kind:'user'`) are MCP-only credentials, never valid on `/api/*`.
They inherit the owner's permissions live; `/:user/mcp/...` URL user must match
the key owner. System keys carry no user identity.

### 5.3 Visibility (groups and servers)

- `private` (default for new): owner + admins.
- `group` (UI label "Shared"): owner, admins, usernames in `sharedWithUsers`.
  Sharing grants discovery/use only, never edit.
- `public`: every authenticated user of the instance (not anonymous).
- `null` (legacy groups only): route usable by anyone who knows the endpoint,
  directory listing owner/admin only (`canAccessGroupRoute`).
- User-authenticated MCP requests need **both** group and server visibility.
  Sharing a group never grants a server the user cannot otherwise see.
- Responses filter hidden nested servers (`presentGroup`); replacement edits by
  an owner preserve entries they cannot see (`mergeVisibleServers`).
- Only owner and admins can mutate/delete (`canMutateGroup`).
- `GET /api/groups/:id/share-candidates` returns sorted usernames excluding owner.

SCP note: MCPHub has no anonymous public link. SCP's "public share by link"
for artifacts is new: an unguessable slug (`/s/{token}`), separate from
`visibility`, served without auth, with its own revocation.

### 5.4 OAuth authorization server (optional, `systemConfig.oauthServer.enabled`)

`GET|POST /oauth/authorize` (PKCE), `POST /oauth/token`, `GET /oauth/userinfo`,
`GET /.well-known/oauth-authorization-server` (RFC 8414),
`GET /.well-known/oauth-protected-resource`, `POST /oauth/register` and
`GET|PUT|DELETE /oauth/register/:clientId` (RFC 7591 DCR), admin CRUD at
`/api/oauth/clients`. Tokens valid on MCP routes only, rejected on `/api/*`.
SCP: defer; bearer keys cover agents. Add when a client (claude.ai remote
connectors) requires OAuth.

## 6. Management REST API (mounted at `${BASE_PATH}/api`, all authenticated)

Response envelope everywhere: `{ "success": boolean, "data"?: ..., "message"?: string }`
(400 on validation with `errors`).

Auth and public:
```
POST /api/auth/login          {username,password} -> {success, token, user}
POST /api/auth/register       (opt-in)
GET  /api/auth/user
POST /api/auth/change-password
GET  ${BASE_PATH}/config, /public-config     runtime config for the SPA
GET  /health, /metrics
```

Groups (`:id` accepts id or name):
```
GET    /api/groups                         -> {success, data:[{id,name,description,servers,owner,...}]}
GET    /api/groups/:id
GET    /api/groups/:id/share-candidates
POST   /api/groups                         {name, description?, instructions?, servers?, visibility?, sharedWithUsers?}
POST   /api/groups/batch
PUT    /api/groups/:id                     partial; instructions:"" removes
DELETE /api/groups/:id
POST   /api/groups/:id/servers             {serverName}
DELETE /api/groups/:id/servers/:serverName
GET    /api/groups/:id/servers
PUT    /api/groups/:id/servers/batch       {servers:[string | {name,tools,prompts,resources,pinnedTools}]}
GET    /api/groups/:id/server-configs
GET    /api/groups/:id/server-configs/:serverName
PUT    /api/groups/:id/server-configs/:serverName/tools   {tools: "all" | string[]}
```

Create example (docs):
```json
{
  "name": "My New Group",
  "description": "A description for the new group",
  "servers": [
    "server1",
    { "name": "server2", "tools": ["toolA","toolB"], "prompts": ["draft_prompt"], "resources": ["resource://docs/guide"] }
  ]
}
```
Docs inconsistency: the feature page says add-server body is `{"serverId": ...}`,
the API reference says `{"serverName": ...}`. Pick one name and keep it.

Servers:
```
GET /api/servers, GET /api/servers/:name, POST /api/servers, POST /api/servers/batch,
PUT /api/servers/:name, DELETE /api/servers/:name,
POST /api/servers/:name/toggle | /reload | /reinstall,
GET  /api/servers/:name/share-candidates,
POST /api/servers/:serverName/tools/:toolName/toggle,
PUT  /api/servers/:serverName/tools/:toolName/description | /hidden-params,
(same toggle/description for prompts/:promptName and resources/:resourceUri)
```

Users (admin only): `GET/POST /api/users`, `GET/PUT/DELETE /api/users/:username`, `GET /api/users-stats`.

Bearer keys: `GET/POST /api/auth/keys`, `PUT/DELETE /api/auth/keys/:id`.

Built-in prompts/resources: `GET/POST /api/prompts`, `GET/PUT/DELETE /api/prompts/:id`;
`GET/POST /api/resources`, `GET/PUT/DELETE /api/resources/:id`, `POST /api/resources/read`.

Templates (export/import a portable pack, closest thing to an SCP "package"):
```
POST /api/templates/export                  {name, description?, groupIds?, includeDisabledServers?}
POST /api/templates/export/groups/:id
POST /api/templates/import                  ConfigTemplate
```
```ts
interface ConfigTemplate {
  version: '1.0'; name: string; description?: string; createdAt: string;
  servers: Record<string, TemplateServerConfig>;   // env/headers secrets replaced by ${PLACEHOLDER}
  groups: { name: string; description?: string; servers: IGroupServerConfig[] }[];
  requiredEnvVars: string[];
}
interface TemplateImportResult {
  success; serversCreated; serversSkipped; groupsCreated; groupsSkipped;
  requiredEnvVars: string[];
  details: { type:'server'|'group'; name; action:'created'|'skipped'|'failed'; message? }[];
}
```
Secret stripping: env keys matching `api_key|apikey|secret|token|password|passwd|access_key|secret_key|private_key|auth` (and substrings) become `${KEY_NAME}`. Import skips existing names (no overwrite).

Other: activities (`/api/activities`, `/stats`, `/filters`, `/:id`, `DELETE /cleanup`),
logs (`GET/DELETE /api/logs`, `GET /api/logs/stream` SSE), market/cloud/registry
browse, `GET /api/mcp-settings/export`, `PUT /api/system-config`,
`POST /api/cache/clear`, `GET /api/cost/servers|groups` (token footprint),
`/.well-known/mcp-marketplace`, `/discovery/servers[/:name[/install]]`.

## 7. Settings file (`data/mcp_settings.json`, file mode)

```json
{
  "mcpServers": {
    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"], "env": { "USER_AGENT": "MCPHub/1.0" } },
    "slack": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-slack"],
               "env": { "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}" } }
  },
  "groups": [
    { "name": "web", "instructions": "For web pages use fetch first...", "servers": ["fetch", "firecrawl"] }
  ],
  "users": [],
  "bearerKeys": [],
  "systemConfig": {
    "routing": {
      "enableGlobalRoute": true, "enableGroupNameRoute": true,
      "enableBearerAuth": true, "bearerAuthHeaderName": "Authorization",
      "jsonBodyLimit": "1mb", "skipAuth": false
    },
    "auth": { "allowRegistration": false },
    "nameSeparator": "-"
  }
}
```
`${VAR}` env substitution supported. Docs show `groups` as both an object map
and an array in different pages; code (`assertSmartRoutingSettingsAvailable`)
iterates `settings.groups || []` as an array. Hot reload on file edit.

SCP: a seed/import file is useful (declarative bootstrap of groups), but keep
the DB authoritative and offer import/export rather than two live stores.

## 8. Dashboard pages (`frontend/src/App.tsx`)

| Route | Page | SCP analog |
|---|---|---|
| `/login` | LoginPage (password + SSO buttons, optional Create account) | same |
| `/oauth/authorize` | OAuthConsentPage | defer |
| `/` | Dashboard (counts, status) | counts per type, recent agent writes |
| `/servers` | ServersPage (list, add/edit form, per-tool toggles, Advanced → Visibility) | `/skills`, `/prompts`, `/artifacts` |
| `/groups` | GroupsPage (create, pick servers, per-server capability picker, instructions, visibility, share users, copy endpoint) | `/groups`: pick items across all three types |
| `/prompts`, `/resources` | builtin prompt/resource CRUD | folded into MDs |
| `/users` | UsersPage (admin) | same |
| `/market`, `/market/:serverName` | marketplace browse/install | optional: import from GitHub skill repos |
| `/credentials` | per-user upstream credentials | not needed |
| `/logs`, `/activity` | server logs, tool-call activity | agent pull/write audit log |
| `/settings` | keys (system + user), routing toggles, Better Auth, smart routing | keys + instance settings |

Group form UX worth copying: "Save the group before choosing users" (share list
needs an id); visibility badge (Private / Shared / Public); copyable endpoint
URL and client config snippet.

## 9. Docker deployment

Image `samanhappy/mcphub:latest` (Node, Python, uv/uvx, Git, build tools;
`latest-full` adds Rust, Docker Engine, Playwright, amd64 only). Base
`python:3.13-slim-trixie`, `WORKDIR /app`, `EXPOSE 3000`,
`ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]`, `CMD ["node","dist/index.js"]`.

Minimal:
```bash
docker run -p 3000:3000 -v ./data:/app/data -e ADMIN_PASSWORD=change-me samanhappy/mcphub
```

Compose (from `docs/configuration/docker-setup.mdx`, trimmed):
```yaml
services:
  mcphub:
    image: samanhappy/mcphub:latest
    ports: ['3000:3000']
    environment:
      - NODE_ENV=production
      - PORT=3000
      - TRUST_PROXY=1
      - JWT_SECRET=${JWT_SECRET:-your-jwt-secret}
      - DB_URL=postgresql://mcphub:password@postgres:5432/mcphub
    volumes:
      - ./data:/app/data
      - mcphub_npm_cache:/root/.npm
      - mcphub_uv_cache:/root/.cache/uv
    depends_on: { postgres: { condition: service_healthy } }
    restart: unless-stopped
  postgres:
    image: pgvector/pgvector:pg17
    environment: [POSTGRES_DB=mcphub, POSTGRES_USER=mcphub, POSTGRES_PASSWORD=password]
    volumes: [postgres_data:/var/lib/postgresql/data]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U mcphub -d mcphub']
      interval: 10s
      timeout: 5s
      retries: 5
volumes: { postgres_data: {}, mcphub_npm_cache: {}, mcphub_uv_cache: {} }
```

Key env vars: `PORT` (3000), `BASE_PATH`, `ADMIN_PASSWORD`, `JWT_SECRET`,
`DB_URL` / `USE_DB`, `MCPHUB_SETTING_PATH` (default `/app/data/mcp_settings.json`;
a legacy `/app/mcp_settings.json` mount takes precedence), `TRUST_PROXY`,
`READONLY`, `DISABLE_WEB` (headless API+MCP only), `SMART_ROUTING_PATH`,
`OPENAI_API_KEY`, `EMBEDDING_MODEL`, `BETTER_AUTH_*`, `GITHUB_CLIENT_ID/SECRET`,
`GOOGLE_CLIENT_ID/SECRET`, `HTTP_PROXY/HTTPS_PROXY`, `NPM_REGISTRY`.
Health: `GET /health`. Prometheus-style: `GET /metrics`. Nginx example in
`nginx.conf.example` (needs SSE-friendly `proxy_buffering off`).

SCP with SQLite collapses this to one service and one volume:
```yaml
services:
  scp:
    build: .
    ports: ['3000:3000']
    environment: [ADMIN_PASSWORD=${ADMIN_PASSWORD}, JWT_SECRET=${JWT_SECRET}, PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost:3000}]
    volumes: ['./data:/app/data']        # scp.db + artifact blobs
    healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/health'] }
    restart: unless-stopped
```

## 10. Known MCPHub sharp edges to avoid in SCP

1. Group/server name collision in one URL segment, plus id-or-name lookup
   everywhere. Use one addressing scheme (slug) per entity type.
2. Dual storage modes (file vs DB) with different feature sets (activity log,
   Better Auth, smart routing are DB-only). One store.
3. Legacy `visibility: null` semantics leaking into access checks forever.
   Start with a NOT NULL default.
4. Plaintext bearer tokens in the DB. Hash them; show once.
5. Builtin prompts/resources are global, not group-scoped. In SCP every
   item is reachable by an agent only through a group (or an explicit
   all-access key).
6. Ephemeral `JWT_SECRET` when unset logs users out on restart. Generate once
   and persist to the data volume on first boot.
7. Security advisories fixed late (GHSA-454m-4vm6-842f: server-scoped key
   gaining whole-group access; GHSA-xf2m-3c3x-53vp: upload path reaching stdio
   exec). Lesson: scope checks must be "full containment", and uploads must
   never land where something executes.
8. Docs drift (`serverId` vs `serverName`, `groups` map vs array, separator
   `-` vs `::`). Generate API docs from the route table or an OpenAPI spec.

## 11. Direct translation table: MCPHub → SCP

| MCPHub | SCP |
|---|---|
| Server (upstream MCP process) | Item: `skill` (SKILL.md + files), `md` (AGENTS.md, agent def, prompt snippet, DESIGN.md), `artifact` (HTML/MD/JSON with versions) |
| Server tools/prompts/resources toggles | Item versions, tags, enabled flag |
| Group `{name, description, instructions, servers[], owner, visibility, sharedWithUsers}` | Group `{slug, name, description, instructions, owner, visibility, sharedWithUsers}` + `group_items(group_id, item_id, alias?, pinned?, version_pin?)` |
| `/mcp/{group}` tools/list | `/mcp/{group}`: tools `list_skills`, `get_skill`, `list_prompts`/`get_prompt` (MCP prompts), `list_artifacts`, `get_artifact`, `create_artifact`, `update_artifact`; resources `scp://skill/...`, `ui://scp/artifact/...` |
| `$smart` search_tools/describe_tool/call_tool | `search_items {query, type?, limit}` → `get_item {id}` (FTS5) |
| Group `instructions` on initialize | Same, plus returned in the HTTP bundle manifest |
| Bearer key `accessType` + `allowedGroups` | Agent key: `kind user|system`, `scopes: read|write`, `allowedGroups[]`; writes land in a target group the key may write to |
| Template export/import (secrets stripped) | Group bundle export/import (JSON + zip of files) |
| OpenAPI per group (public) | `GET /api/v1/groups/{slug}/bundle[.zip]` (authenticated), plus public `/s/{shareToken}` for artifacts only |
| Activity log | Audit log: pulls and writes by key/user/group |
