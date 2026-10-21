# SCP: Skill, MD and Artifact control plane

SCP is a self-hosted registry that agents pull their working kit from. It is like
[MCPHub](https://docs.mcphub.app/), but for content instead of MCP servers:

| Plane | What it stores |
|---|---|
| **Skills** | Agent Skills: a `SKILL.md` plus any files (`scripts/`, `references/`, ...) |
| **Prompts & MDs** | Agent definitions (`.claude/agents/*.md`), `AGENTS.md` instructions, slash commands, prompt snippets with arguments, `DESIGN.md` design systems, multi-file definition packages |
| **Artifacts** | HTML tools, dashboards, decks, documents, components, SVG, Mermaid, Markdown, React (JSX). Agents can write these back. |

The main feature is **groups**. A group mixes items from all three planes into one package, for
example "coding agents": the reviewer agent, the `AGENTS.md` house rules, the release-notes skill and
the team dashboard artifact. An agent connects to `/mcp/<group>`, or downloads the group's
`bundle.zip`, and gets exactly that package.

## Quick start (Docker)

```bash
docker compose up -d --build
docker compose logs scp | grep password    # the generated admin password, printed once
```

Open <http://localhost:8080> and sign in as `admin`, or register a new account. Artifacts are served
from a second origin, <http://localhost:8081>, under a `sandbox` CSP that gives them an opaque origin,
so artifact code cannot read your session or call the API. Cookies are not port-isolated, so
browsers still send the `httpOnly` session cookie to `localhost:8081` (the artifact origin ignores
it); to keep it off the artifact origin entirely, serve that from a different host, e.g.
`SCP_ARTIFACT_URL=http://127.0.0.1:8081` locally or a separate domain in production.

Data lives in the `scp-data` named volume (`/data/scp.db`, SQLite in WAL mode), so it survives
`docker compose down` and `up`. `docker compose down -v` deletes it.

### Configuration

Set these in your shell or in a `.env` file next to `docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `SCP_PUBLIC_URL` | `http://localhost:<SCP_HOST_PORT>` | App URL as browsers and agents reach it |
| `SCP_ARTIFACT_URL` | `http://localhost:<SCP_HOST_ARTIFACT_PORT>` | Artifact origin. Must be a different origin; in production use a separate domain such as `scp-content.example.com` |
| `SCP_ADMIN_USERNAME` / `SCP_ADMIN_EMAIL` | `admin` / `admin@localhost` | First admin, created when the database is empty |
| `SCP_ADMIN_PASSWORD` | random, printed in the logs | First admin's password |
| `SCP_ALLOW_REGISTRATION` | `true` | Whether anyone can create an account: `true` or `false` (also `1`/`0`, `yes`/`no`, any case). Any other value stops the server at boot |
| `SCP_TRUST_PROXY` | `false` | Use the rightmost `X-Forwarded-For` entry (the hop your proxy appended) for the audit IP and the login rate limit. Enable only behind exactly one proxy that appends it (nginx `$proxy_add_x_forwarded_for`, Cloudflare). Same values as above |
| `SCP_ARTIFACT_CDNS` | cdnjs, jsdelivr, unpkg, tailwind, jquery | Space-separated script and style origins artifacts may load from (`https://host[:port]`; a trailing slash is fine, anything else is ignored with a warning at boot) |
| `SCP_HOST_PORT` / `SCP_HOST_ARTIFACT_PORT` | `8080` / `8081` | Host ports published by compose |

[`.env.example`](.env.example) lists every variable with its default. If you set the two URLs
yourself, they must match how the ports are really reached: previews frame `SCP_ARTIFACT_URL`, and
artifact pages only allow being framed by `SCP_PUBLIC_URL`.

For a public deployment, put both origins behind HTTPS (Caddy, nginx, Cloudflare Tunnel) and set
the two URLs to match. claude.ai and other hosted clients need a public HTTPS MCP URL; they cannot
reach `localhost`.

## Connecting an agent

1. In the web app, create a group and add items to it.
2. Under **API Keys**, create a key, ideally restricted to that group. It is shown once.
3. Connect the agent.

**Claude Code over MCP:**

```bash
claude mcp add --transport http scp-coding http://localhost:8080/mcp/coding \
  --header "Authorization: Bearer scp_..."
```

**Any MCP client (JSON config):**

```json
{ "mcpServers": { "scp-coding": { "type": "http", "url": "http://localhost:8080/mcp/coding",
  "headers": { "Authorization": "Bearer scp_..." } } } }
```

**Install as files** (skills to `.claude/skills/`, agents to `.claude/agents/`, `AGENTS.md`, `DESIGN.md`):

```bash
curl -fsSL -H "Authorization: Bearer $SCP_KEY" \
  "http://localhost:8080/api/v1/groups/coding/bundle.zip?target=claude-code" -o scp-coding.zip
unzip -o scp-coding.zip
```

```powershell
Invoke-WebRequest -Headers @{Authorization="Bearer $env:SCP_KEY"} `
  -Uri "http://localhost:8080/api/v1/groups/coding/bundle.zip?target=claude-code" -OutFile scp-coding.zip
Expand-Archive -Force scp-coding.zip .
```

The target can be `claude-code`, `codex` (`.agents/skills/`, `AGENTS.md`, `.codex/prompts/`) or
`generic`; `&scope=user` lays files out for a home directory. Every bundle includes `scp.lock.json`
(item versions and tree hashes) and the group's instructions.

### MCP surface

Endpoints: `/mcp/<group>` is scoped to one group, and `/mcp` covers every group the key can read.
Auth is by Bearer key only. The group's instructions are sent in the `initialize` response.

Tools follow progressive disclosure: catalog first, then bodies, then files.

| Tool | Purpose |
|---|---|
| `list_groups`, `get_group` | Discover groups and a group's catalog (names and descriptions, no bodies) |
| `search` | Full-text search by task ("write a changelog", "review typescript") |
| `get_skill`, `get_skill_file` | `SKILL.md`, then individual files on demand |
| `get_md` | Agent definitions, `AGENTS.md`, prompts, `DESIGN.md`, packages |
| `list_artifacts`, `get_artifact`, `render_artifact` | Artifact source, or a rendered MCP App view |
| `create_artifact`, `update_artifact`, `share_artifact` | Agent write-back; needs the `write` scope |
| `get_bundle` | Bundle URL plus ready-to-run install commands |

Prompt and agent items are also exposed as MCP prompts. `render_artifact` is an
[MCP App](https://github.com/modelcontextprotocol/ext-apps) tool: hosts that support MCP Apps
(Claude, ChatGPT, VS Code, Goose, ...) render the artifact inline through the `ui://scp/viewer/v1`
viewer. Other clients get a preview link instead.

### HTTP API

Everything the web app does goes through `/api/v1`, using a cookie session or a Bearer key. The
contract is in [docs/PLAN.md](docs/PLAN.md). The routes agents use most:

```text
GET  /api/v1/groups/<slug>/manifest        catalog with install paths
GET  /api/v1/groups/<slug>/bundle.zip      install tree + scp.lock.json
GET  /api/v1/groups/<slug>/catalog.md      roster table
GET  /api/v1/search?q=...&plane=skill|md|artifact
GET  /api/v1/items/<id>/files/<path>       raw file bytes
POST /api/v1/items                         create (JSON files[] or content)
POST /api/v1/items/import                  upload .md / .zip / .skill / .html / .svg / .mmd / .jsx
```

## Security model

- Keys are stored hashed (sha256) and shown once. A key can be read-only, and can be restricted to
  specific groups. A restricted key sees only those groups' contents, even items its owner owns.
- A group shares its members with its audience (private, specific users, or every signed-in user).
  It can only republish its owner's items or public items. If an item's owner makes it private, the
  item stops flowing through other people's groups.
- Artifact HTML runs only on the artifact origin, under a CSP `sandbox` (opaque origin, no
  `allow-same-origin`, so artifact code cannot read cookies) with a CDN allowlist. Raw files on the app origin are always
  served inert (`text/plain`, `sandbox` CSP, `nosniff`).
- Public share links are unguessable 256-bit tokens. They are revocable, and can be pinned to a
  version or follow the latest.
- Uploads are hardened: zip-slip, symlinks, zip bombs and size caps are checked. Frontmatter is
  parsed with `yaml`, and is never evaluated.
- Every login, write, share, bundle download and MCP tool call is written to the audit log
  (**Activity** page).

## Development

```bash
npm --prefix server ci && npm --prefix web ci
npm --prefix server run dev        # API + MCP on :8080, artifact origin on :8081
npm --prefix web run dev           # Vite on :5173 with a proxy to :8080
npm run gate                       # typecheck + server tests + web build (must be green)
npm run smoke                      # end-to-end check against a running instance
```

With the Vite dev server, start the API with `SCP_PUBLIC_URL=http://localhost:5173`, or artifact
previews are refused: the artifact origin only lets `SCP_PUBLIC_URL` frame them.

Stack: Node 24 runs the TypeScript sources natively, with Hono, `node:sqlite` (FTS5 search) and
the MCP TypeScript SDK; React 19 + Vite on the web side. No hosted LLM calls are made.
Design notes and research are in [docs/](docs/).
