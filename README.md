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

Prebuilt images are published to `ghcr.io/zacgoodwin/scp` (`:<version>`, plus `:latest` for
non-prerelease versions). To use one
instead of building, set `image: ghcr.io/zacgoodwin/scp:latest` and remove `build: .` in
`docker-compose.yml`. To cut a release, bump `VERSION`, merge, then push the matching tag
(`git tag v$(cat VERSION) && git push origin v$(cat VERSION)`); `.github/workflows/release.yml`
refuses a tag that is not on `main`, does not match `VERSION`, or carries a `VERSION` that is not
semver. Release tags are immutable (a repository ruleset blocks moving or deleting a `v*` tag), and
each image carries a signed build provenance attestation:
`gh attestation verify oci://ghcr.io/zacgoodwin/scp:<version> --owner zacgoodwin`.

### Configuration

Set these in your shell or in a `.env` file next to `docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `SCP_PUBLIC_URL` | `http://localhost:<SCP_HOST_PORT>` | App URL as browsers and agents reach it |
| `SCP_ARTIFACT_URL` | `http://localhost:<SCP_HOST_ARTIFACT_PORT>` | Artifact origin. Must be a different origin; in production use a separate domain such as `scp-content.example.com` |
| `SCP_ADMIN_USERNAME` / `SCP_ADMIN_EMAIL` | `admin` / `admin@localhost` | First admin, created when the database is empty |
| `SCP_ADMIN_PASSWORD` | random, printed in the logs | First admin's password |
| `SCP_ALLOW_REGISTRATION` | `true` | Whether anyone can create an account with a password (`POST /auth/register`, the Register page): `true` or `false` (also `1`/`0`, `yes`/`no`, any case). Any other value stops the server at boot. Sign-up through OIDC is a separate switch, `SCP_OIDC_AUTO_REGISTER`: with OIDC on and that left at its default, a closed instance still creates an account for every identity the IdP admits |
| `SCP_TRUST_PROXY` | `false` | Use the rightmost `X-Forwarded-For` entry (the hop your proxy appended) for the audit IP and the login rate limit. Enable only behind exactly one proxy that appends it (nginx `$proxy_add_x_forwarded_for`, Cloudflare). Same values as above |
| `SCP_ARTIFACT_CDNS` | cdnjs, jsdelivr, unpkg, tailwind, jquery | Space-separated script and style origins artifacts may load from (`https://host[:port]`; a trailing slash is fine, anything else is ignored with a warning at boot) |
| `SCP_HOST_PORT` / `SCP_HOST_ARTIFACT_PORT` | `8080` / `8081` | Host ports published by compose |
| `SCP_GITHUB_TOKEN` | unset | GitHub token used by imports from GitHub: a higher rate limit for everyone, and private repositories for admins only (other accounts are refused a private repository, so the token never widens their access). Unset: the token saved under Admin, Settings, else anonymous |
| `SCP_IMPORT_MAX_ITEMS` | `200` | Most items one pack or GitHub import may create (1 to 2000; more is `400 too_many_items`). Unset: the Admin, Settings value, else the default |
| `SCP_IMPORT_MAX_ARCHIVE_MB` | `35` | Compressed size cap, in MB, for a GitHub repository archive and a pack upload, and for a single-file upload up to its own 35 MB (1 to 256; over it is `413`). Memory: up to 3 repository downloads run at once, each holding up to this much |
| `SCP_IMPORT_MAX_PACK_MB` | `64` | Unpacked size cap, in MB, for a pack or repository archive, per file and in total (1 to 256) |
| `SCP_GITHUB_API` | `https://api.github.com` | GitHub REST API origin imports talk to. Only for a GitHub Enterprise Server or a test stand-in; the public API needs no change |
| `SCP_OIDC_ISSUER` / `SCP_OIDC_CLIENT_ID` / `SCP_OIDC_CLIENT_SECRET` | unset | OIDC login (see below). All three enable it; each value set here overrides the matching Admin, Settings field |
| `SCP_OIDC_AUTO_REGISTER` | `true` | Create an account on a user's first OIDC login, whatever `SCP_ALLOW_REGISTRATION` says. `false`: only existing accounts (matched by linked identity, then email) can sign in |
| `SCP_OIDC_LABEL` | `Single sign-on` | Text of the login button |

If you set the two URLs yourself, they must match how the ports are really reached: previews frame `SCP_ARTIFACT_URL`, and
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

**Install as files** (skills to `.claude/skills/`, agents to `.claude/agents/`, instructions to `CLAUDE.md`, `DESIGN.md`):

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
`generic`; `&scope=user` lays files out for a home directory (`.claude/CLAUDE.md` for claude-code). An
instructions item is stored as `AGENTS.md` whatever the target; a member's `installAs` overrides where it lands. Every bundle includes `scp.lock.json`
(item versions and tree hashes) and the group's instructions.

### MCP surface

Endpoints: `/mcp/<group>` is scoped to one group, and `/mcp` covers every group the key can read.
Auth is a Bearer API key, or an OAuth access token obtained through the built-in authorization server (see OAuth below). The group's instructions are sent in the `initialize` response.

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
POST /api/v1/items/import/pack             a zip of many skills/MDs -> items (+ a group)
POST /api/v1/items/import/github           import from a GitHub repo/ref/path, commit pinned
GET  /api/v1/imports/limits                the effective import caps, for any signed-in user
GET  /m/<key>/marketplace.json             Claude Code plugin marketplace for the key
```

## Importing packs and GitHub repositories

Besides single-file uploads (`POST /api/v1/items/import`), SCP imports whole collections:

```
POST /api/v1/items/import/pack     multipart: file=<.zip> [visibility=private|public] [group=<slug> [groupName=<text>] | intoGroup=<slug>] [kind=<kind>] [folderKinds=<JSON>] [includeRepoTooling=true] [onNameClash=skip|prefix] [frontmatterErrors=ask|import|skip] [description=<text>]
POST /api/v1/items/import/github   JSON: {url} or {repo:"owner/repo", ref?, path?} + visibility?, kind?, name?, group?, groupName?, intoGroup?, folderKinds?, includeRepoTooling?, onNameClash?, frontmatterErrors?, description?
                                   409 frontmatter_errors {details: [{path, kind, errors}]} when frontmatterErrors is ask (the default) and units have frontmatter errors; nothing is written
```

Both answer `201 {items, group, skipped, skippedFolders, source}`. Every recognised unit in the tree becomes one item: `.claude-plugin/plugin.json` plugins and `.claude/` layouts (`skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`), top-level `skills/`, `agents/`, `commands/`, `prompts/`, any other folder holding a `SKILL.md` (`skill.md` in any case counts and is stored as `SKILL.md`), a `SKILL.md` at the root, in any case (one skill, every remaining file its own), root `AGENTS.md`/`CLAUDE.md`/`INSTRUCTIONS.md` (instructions) and `DESIGN.md` (design). A folder import (a `/tree/<ref>/<path>` or `/blob/.../SKILL.md` URL, or a zip of one folder) holding a `SKILL.md` is that one skill, `CLAUDE.md` and `agents/*.md` inside it included, the way the same folder is under `skills/` in a whole-repository import; carving root `AGENTS.md`/`CLAUDE.md` and `agents/*.md` into items of their own applies to a repository root only. A tree made only of `.md` files imports each file the way the single-file import would (README/LICENSE-style docs are skipped: README, LICENSE, CHANGELOG, CONTRIBUTING, CODE_OF_CONDUCT and SECURITY, with a locale or variant suffix such as `README.de.md`; a command named `security-review` is an item). At most 200 items per import. Each returned item carries `op`: `create`, `version` (a re-import that changed it) or `unchanged`.

Marketplace repositories import every plugin in them: a folder holding `.claude-plugin/plugin.json` (`plugins/<name>/`), or a same-repository `source` (`./plugins/<name>`) listed in the root `.claude-plugin/marketplace.json`, has its own `skills/`, `agents/`, `commands/` and `prompts/` read the way a repository root's are, a nested plugin before the plugin around it. A marketplace `source` that names another repository or points outside this one is not followed and is listed in `skipped`, and so is an `agents/` or `commands/` folder below the root that sits in no plugin. When two plugins ship the same name (two `agents/code-reviewer.md`), the second is skipped as a name clash naming the path that holds it (two skills of the same name are both imported, prefixed: see below). A plugin's hooks, MCP servers (`.mcp.json`), output styles, `settings.json`, `.lsp.json` and monitors are not imported or served: each is listed once in `skipped` (`plugin hooks/ is not supported by SCP; it was not imported`), so the SCP copy is visibly not the whole plugin. Whether SCP should ever serve these (they run commands on every machine that installs the plugin) is an open decision; until then it only reports them.

A plugin manifest that names its component paths (`"skills": ["./src/my-skill"]`, `"commands": "./cmds"`, `"agents": [...]`, in `plugin.json` or a same-repository `marketplace.json` entry) is followed first, so components outside the usual folders import as their kind; a path that is absolute, climbs out of the plugin with `../`, or holds nothing importable is listed in `skipped` and the rest imports. When a repository says where its product lives (a plugin, or a top-level `skills/` folder), its contributor tooling is not imported: `.claude/skills`, `.claude/agents`, `.claude/commands`, `.agents/skills`, `.gemini/skills` and `.opencode/skills` are listed in `skipped` as `maintainer tooling (repo ships a plugin)`, and with a plugin the root `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` too. Send `includeRepoTooling: true` (GitHub) or the form field `includeRepoTooling=true` (pack) to import them anyway. A repository with neither signal imports as before.

When a repository ships the same skill for several agent tools (a Claude Code plugin plus ports in `antigravity/`, `codex/`, `.openclaw/`...), the Claude Code copy is kept: a copy inside a plugin or `.claude/` wins, then one under a `skills/` folder, then any other folder, and a copy under a folder named for another tool (`.openclaw`, `.opencode`, `.gemini`, `.cursor`, `.kiro`, `.windsurf`, `.codex`, `antigravity`, `codex`, `openclaw`, `opencode`, `cursor`, `gemini`) comes last. The others are listed in `skipped` as `another copy of this skill (<path>) was imported; this one is the <tool> port`. Re-imports and updates keep the same copy.

Units that fail validation, clash with an unrelated item's name, or would conflict on an install path are listed in `skipped` with the reason; the rest still import. So is content detection passed over: a folder under `skills/` with no `SKILL.md`, any other loose `.md` outside a layout folder (`docs/guide.md`; one nested below a layout folder, `agents/sub/deep.md`, is told that only `agents/*.md` is imported), and a README inside `agents/`, `commands/` or `prompts/` (which would otherwise ship as a slash command named `readme`); a root README is expected and not reported. Symlinks (`CLAUDE.md -> AGENTS.md`, `.agents/skills -> ../.claude/skills`) are never imported, resolved or followed: each is listed in `skipped` as `symlink to '<target>', not imported` and the rest of the tree imports (the single-file `POST /items/import` still refuses a zip holding one). Zips written by Windows PowerShell's `Compress-Archive` (`\` separators) import like any other. When nothing at all was recognised the answer is 400 `nothing_to_import`, with those skip reasons as `error.details` whenever detection passed something over. With `group=<slug>`, the group is created (409 `slug_taken` fails the whole import) with every imported item as a member; `groupName` defaults to the plugin manifest's `displayName`, then its `name`, then the repo or zip name, and the group's description (which the served `plugin.zip` carries) comes from the manifest: `.claude-plugin/plugin.json`, else a `marketplace.json` listing exactly one plugin, else `.codex-plugin/plugin.json`. A manifest that is not valid UTF-8 or JSON, or a field that is not a string or is over the group limits (100 characters for the name, 2000 for the description), is ignored and listed in `skipped`; the import goes ahead. The import is one transaction. When every unit was skipped the answer is 422 `nothing_imported` with the skip reasons as `error.details`, never a 201 with an empty list, so a group is never created empty and its slug stays free.

Three more options shape an import. `intoGroup=<slug>` adds every imported item to an existing group you can edit instead of creating one (`group` and `intoGroup` together are a 400, as is either one given as `""` in the GitHub JSON, while an empty pack form field counts as not sent; a group you cannot edit is a 404 like one that does not exist); re-importing the same source into the same group versions its items and adds no member twice. `kind` turns detection off: for `agent`, `command`, `prompt` and `instructions` each `.md` in the tree becomes its own item of that kind (README-style docs and non-`.md` files are listed in `skipped`), for `skill`, `design` and `package` the whole tree is one item holding every file. A GitHub `path` naming a single file stays one item. Loose `.md` files detection passed over are counted per folder in `skippedFolders` (`[{path, count}]`, `''` for the root; README-style docs never count), also beside `details` on a 400 `nothing_to_import` or 422 `nothing_imported`. `folderKinds` (`{"docs/prompts": "prompt"}`, JSON text in the pack form) maps such folders: each loose `.md` in the folder becomes one item of that kind (`agent`, `command`, `prompt`, `instructions` or `design`), or `package` makes the whole folder one item. A folder that holds nothing left to import is listed in `skipped`, and a key that is absolute or climbs out of the tree (`../x`) is a 400.

Two more decide what happens to units that would otherwise be lost. Skills of one import that share a name (`access` in each of a marketplace's `discord`, `imessage` and `telegram` plugins) are always all imported, each prefixed with its plugin folder, or for a `<x>/skills/<name>` layout with `<x>`: `discord-access`, `imessage-access`; a port in another tool's folder still gives way. A unit whose name an item from another source (or one made in SCP) already holds is skipped by default (`onNameClash: skip`) with `prefixed` in its `skipped` entry, the name it would take: `onNameClash: prefix` imports it as `<repo>-<name>` (the repository name, or the zip's file name without `.zip`: `claude-mpm-skills-brainstorming`). A prefixed skill or agent has its frontmatter `name:` rewritten to the prefixed name, or the line added when upstream names nothing (a skill's must match its `.claude/skills/<name>/` folder); a re-import, with or without the option, and a source update keep the prefix, also once upstream drops `name:`. A `name` given to a GitHub import is written the same way. Frontmatter that is not valid YAML cannot take a name SCP chose: the unit is skipped with that reason (never imported under its bare name), and a source update or re-import of a prefixed item whose upstream frontmatter stopped parsing is refused (422) and leaves the item as it was. When `<repo>-<name>` is itself taken, the skip says the prefixed name is taken too. A unit whose prefixed name would pass the 64-character name limit is not prefixed: it is skipped with that reason (and no `prefixed` offer). `frontmatterErrors` covers units whose only lint errors are frontmatter ones (invalid YAML or fence, a missing `name` on an agent, a missing or over-1024-character `description`): `ask`, the default, answers 409 `frontmatter_errors` with `details: [{path, kind, errors}]` and writes nothing (no group either); `skip` lists them in `skipped` as before; `import` stores them with their upstream bytes untouched (but for a prefixed or given `name:`), named by their folder or file when the frontmatter names nothing, described by the body's first paragraph, the errors kept on the version as warnings marked `waived` (the item page shows a **frontmatter errors** badge). Source updates and re-imports of such an item accept the errors again without asking. Any other lint error (a skill name with capitals or `_`, say) is skipped in every mode.

A `description` (at most 1024 characters) supplies the frontmatter an upstream file lacks. It applies to an import of exactly one item of a kind with one entry file, so not a package (a 400 otherwise, nothing written). When that item's file (`SKILL.md`, an agent's `.md`, ...) has no frontmatter, SCP puts a block in front of it holding the description and, for a skill or agent, its `name` (the item name), written by a YAML library so colons, `#` and line breaks come through intact; the item stores those fields (`item.suppliedFrontmatter`). A file that has frontmatter of its own keeps it and nothing is stored. Every source update and re-import adds the stored block again, byte for byte, so a tracked upstream file without frontmatter never loses it; if upstream later adds its own, upstream's wins (except a skill's or agent's `name`, which stays the item name SCP supplied: its install folder), the stored fields wait as a fallback, and the item says so (`item.upstreamFrontmatter`). `PUT /api/v1/items/:id/source/frontmatter {description}` changes the stored description (a new version while SCP's block is in use; a block edited by hand since is a 409, not overwritten).

To import one Markdown file from GitHub as a skill, give its `path` (`skills.md`) with `kind: skill` and a `description`: the file becomes the skill's `SKILL.md`, named after the file, or after the repository when the file name is generic (`cesarferreira/stax` `skills.md` is the skill `stax`; `name` overrides), and SCP supplies its `name` and `description`. Source updates fetch the same file, store it as `SKILL.md` again and re-apply that frontmatter. Without `kind: skill` the file imports as it did before (a prompt, or an agent when it has a name and description).

GitHub URLs may be a repo (`https://github.com/o/r`), a folder (`.../tree/<ref>/<path>`) or a file (`.../blob/<ref>/<path>/SKILL.md`, which imports the file's folder); `www.github.com`, `http://` and no scheme at all (`github.com/o/r`) are accepted too, any other host is refused. A `path` may name one file (`docs/x.md`): that file is the item, and its source path. `ref` is a branch, tag or commit sha (default: the repo's default branch). SCP only talks to the GitHub REST API (`SCP_GITHUB_API`, default `https://api.github.com`): it resolves the ref to a commit and downloads that commit's zipball of the whole repository (35 MB compressed cap, 60 s timeout); with a `path`, only that folder is inflated. The archive is held to pack caps (20,000 files, 64 MB unpacked); each unit is then held to the per-version limits (1000 files, 30 MB, 10 MB per file) as it becomes an item, so a 150-skill repository imports and a single oversize unit lands in `skipped`, one holding a file over 10 MB included (the archive caps a file at its 64 MB total, not at a version's 10 MB). No clone, nothing is executed. The archive caps (35 MB compressed, 64 MB unpacked) and the 200-items-per-import cap are admin settings (Admin, Settings, Imports, or `SCP_IMPORT_*`). A folder import (`path`) of a repository whose archive is over the cap is fetched file by file through the Git Data API instead (one listing per path segment, then one request per file): the folder is held to the per-version limits (1000 files, 30 MB, 10 MB per file) from the listing before anything is downloaded, symlinks and submodules in it land in `skipped`, and every request counts against the importing user's GitHub rate limit, so the next import waits until they are paid back. Anonymous GitHub allows 60 requests an hour, so a large folder needs a `github.token`: one that needs more requests than are left is refused with a 400 saying so, never imported in part. A whole-repository import over the cap stays a 413. A token (`SCP_GITHUB_TOKEN`, or the `github.token` setting from the admin settings page) raises the rate limit for everyone; private repositories it can reach import for admins only (other accounts get the same 400 `bad_source` as for a repository that does not exist, so the token is no oracle for private repository names). The repository is recorded as GitHub spells it (names are case-insensitive). `kind: artifact` is refused before GitHub is contacted: an artifact imports from a single file. The GitHub quota is one shared identity (the token, or the server's address), so every route that contacts GitHub is limited per user (a burst of 10, then one every 5 s: 429 `rate_limited`), at most 3 repository downloads are in flight at once (503 `busy` with `Retry-After` otherwise), and an exhausted GitHub quota answers 429 naming the reset time instead of a bare 502.

Imported items record their provenance (`item.source`: kind, repo, ref, path, commit; for zips the file name and the zip's sha256). Importing the same repo and path again updates the existing item of that kind with a new version when it has the unit's name, or that name with the prefix a clash gave it (it keeps the prefix after the clash is gone), or the name SCP supplied (which then stays, whatever name upstream's own frontmatter gives), instead of failing on the name; a unit renamed upstream is a new unit, created under its new name (or skipped when an item already holds it) and never written into the item that kept the old name; at the same commit (or the same zip bytes), or a new commit whose tree at that path is what the import last wrote, nothing is written, so a local edit made since stays the latest version (the recorded ref and commit still follow the ones named), unless the import brings a `description` the item does not store yet: then only the frontmatter block of the latest version changes, as with the edit below, so a local edit keeps its body, and a latest version whose frontmatter was written by hand is not overwritten (the unit is skipped with that reason, as the edit's 409). For zips the identity is the uploaded file name: re-uploading under the same name updates, a renamed download (`pack (1).zip`) is a new pack whose units are skipped as `name_taken`, with the reason naming the file to upload under. For GitHub-sourced items:

```
POST /api/v1/items/:id/source/check            -> {source, upToDate, latestCommit}
POST /api/v1/items/:id/source/update  {note?}  -> {item, skipped}   (new version at the latest commit; 409 up_to_date when nothing changed; skipped: its symlinks)
```

Both need edit rights on the item. An item pinned to a commit sha is always up to date.

### Importing packs and GitHub repos (web UI)

The Import dialog (Dashboard quick links, or the Import button on any plane page) has three tabs:

- **File**: one `.md`, a skill folder as `.zip`/`.skill`, or an artifact file. Kind is detected, or pick one.
- **Zip pack**: a zip holding many units (a Claude Code plugin with `.claude-plugin/plugin.json`, a `.claude/` folder, `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `prompts/*.md`, or loose `.md` files). Each unit becomes one item, held to the per-version limits; the upload (the zip plus its form fields) may be 35 MB, and the archive 20,000 files and 64 MB unpacked, by default; the tab shows this instance's values and refuses an oversize zip before uploading it. Re-uploading a zip under the same file name updates the items it created; a renamed file is a new pack. **Group** puts every imported item in a group: none, a new one (slug and name), or an existing one of yours.
- **GitHub**: paste a repo URL (`https://github.com/owner/repo`, a `/tree/<ref>/<path>` folder or a `/blob/.../SKILL.md` file), or fill in owner/repo, ref and path. The import goes through the GitHub API at the ref's current commit (set `SCP_GITHUB_TOKEN` for higher rate limits; private repos import for admins only), and that commit is pinned on every item. **Import items in folder as one type** turns detection off: "Yes, all as prompt" (or agent, command, instructions) imports each `.md` directly in the folder (not in its subfolders) as its own item of that type, while skill, design and package make the whole folder one item (a Path naming one `.md` file with "Yes, all as skill" makes that file the skill's `SKILL.md`). The same **Group** choice as the pack tab. Both the pack and GitHub tabs have a **Description** field: for an import of one item whose file has no frontmatter, SCP writes it (and a skill's or agent's name) as the file's frontmatter and keeps it on every source update. The Artifacts page offers the File tab only: an artifact is one file with a format.

A group page's **Import into this group** button (editors only) opens the dialog with that group preselected and the Zip pack and GitHub tabs only.

After a pack or GitHub import the UI opens the group, or the item when exactly one was imported, provided nothing was skipped; otherwise it lists the imported items, a link to the group, and the units it skipped with the reason (unknown layout, lint errors, name taken), also when every unit was skipped and the requested group was therefore not created. Units skipped because you already have an item of that name are offered again with **Import these with the prefix** (`<repo>-<name>`). When units have frontmatter errors, nothing is imported until you answer: the dialog lists each unit with its errors and offers **Import anyway**, **Skip these** or **Cancel**; either choice ends in the normal result view. Folders of Markdown files SCP did not recognise are listed with a type to pick for each (prompt, agent, command, instructions, design, or package for the folder as one item); **Import selected** runs the same import again (the same zip, or the same repository, ref and path) with those folders mapped, so the items already imported are updated, not duplicated.

### Source panel and update checks

An imported item shows a **Source** card under its description: kind (github or zip), repo link, path, ref and the pinned commit. For GitHub sources, editors get **Check for updates**; when the ref has moved, **Update to latest** re-imports that path at the new commit as a new version (a loose `design.md` or `skill.md` imported from a folder of `.md` files is re-homed to `DESIGN.md` / `SKILL.md` again). "Already up to date" means the ref still points at the pinned commit, or the tree at the new commit is still what the import last wrote (a commit elsewhere in a monorepo); either way a local edit made since the import is never overwritten by an update. A whole-folder import (a `skills/<name>/` folder, or a `kind` override) keeps its whole folder on update, however upstream renames files inside it; a root `SKILL.md` import keeps carving sibling units out.

When SCP supplied the item's frontmatter on import, a **Frontmatter supplied by SCP** card shows the fields, with **Edit description** for editors (a new version while SCP's block is in use). When upstream has since added frontmatter of its own, the card carries an **upstream now provides its own frontmatter** badge: the latest version uses upstream's, and SCP's fields come back only if upstream drops it again.

### Dashboard

The dashboard lists **Your groups** and **Shared with you** (groups other users shared with you or made public), each with owner, plane counts and a Connect link. An admin reads every group, so for them the second card is **Other users' groups** and says so.

## Nested groups

A group can include other groups (`PUT /api/v1/groups/:slug/includes {includes: [slug]}`, `POST .../includes {slug}`, `DELETE .../includes/:slug`). Everything an included group serves flows into the including one: its own members first, then each include's members in order, up to 4 levels deep. An item that appears more than once is served once, from the first place it appears, with the version pin and "Install as" of that row. Cycles are refused (409 `include_cycle`), a fifth level is 400 `include_too_deep`.

You can include your own groups and public ones. A group another user shared with you by name is yours to read, not to republish, the same rule as for their private items (400 `include_not_shareable`), or a share recipient could turn private items into a public group. An included public group keeps flowing only while it stays public and its owner is enabled: if its owner makes it private or shared, its members drop out of your group until it is public again. The stale include stays listed for you (`flowing: false`, shown as "not flowing"), so you can reorder or remove it, but once you can no longer read the group you see its slug alone, not its live name or member count; and its owner's `includedBy` no longer names your group, since the edge no longer flows. A reader of your group sees an include they cannot open (your private group under your public one) as its slug alone too, still flowing: its members arrive, marked `via` that slug. Each included group still publishes only its owner's items or public ones, like any group. Reading a group grants read of everything it serves, included groups too, so a key restricted to one group sees what flows in through its includes and nothing else. A group includes at most 50 groups directly, is included by at most 50 other users' groups (your own includes of your own group never count against that, so strangers cannot lock you out of it), and serves at most 100 through its includes in all, at most 500 members and at most 20,000 files (400 `include_too_many` / `group_full`); the caps are checked on the group you edit and on every group of yours that includes it, so growing a child cannot push your own hub past them. The depth and member caps count your own groups, not another user's: four private groups a stranger stacks on your public group neither block your next include nor serve anything past depth 4 from their end, and a public group of theirs that you include may deepen or grow afterwards without failing your own reorders, includes or member adds (it truncates at depth 4 on read, and reordering or trimming your includes re-judges nothing). Another user's hub that includes your public group is theirs to trim. A group whose members hold more than 20,000 files (an unpinned member grew) answers 400 `group_full` for its manifest, bundle, catalog, plugin.zip and is left out of the marketplace alike. A change inside an included group (a member, a pin, an include) also updates every group that includes it, as does anything that shrinks what it serves (a member deleted or made private, an included group made private or deleted).

Install-path conflicts are checked across the whole effective set: an include that would make two members install to the same path is refused (409 `path_conflict`), and a clash that appears later inside an included group shows up as a manifest conflict and blocks the bundle until a member gets an "Install as" path.

In the UI, the group page has an "Included groups" section; members that flow in show "via <slug>" (the group holding the member's row, linked when it is a direct include you can open; a deeper group, or one you cannot read, is named only) and are edited in that group. The "Shared with" list is shown to editors whatever the visibility: the names survive a switch to private or public and grant access again on a switch back to shared, and count toward your marketplace and MCP group list only while the group is shared.

## Claude Code plugin marketplace

Every API key is a marketplace: `GET /m/<key>/marketplace.json` lists one plugin per group of the key's owner, plus the groups shared with them by name and, for a restricted key, the groups it was restricted to (named after the group slug; marketplace name `scp-<username>`), each pointing at `GET /m/<key>/<slug>/plugin.zip` as an `archive` source. Other users' public groups are not enumerated (any account can create any number of them), and Claude Code resolves `<slug>@scp-<username>` against that listing, so they install from the archive only: download `GET /m/<key>/<slug>/plugin.zip` (any group the key can read) and unpack it where Claude Code loads plugins from; the group page's Plugin tab shows that command for them. The zip is the Claude Code plugin layout: `.claude-plugin/plugin.json`, `skills/<name>/`, `agents/<name>.md`, `commands/<name>.md`, other kinds under `docs/<kind>/<name>/`, and a `.mcp.json` that connects the group's MCP server with the same key. Plugin versions are `<yyyymmdd>.<hhmmssmmm>`, the UTC time of the latest change (a member version, a pin, an include, the group itself, inside an included group too, and whatever removes files from the plugin: a member deleted or made private, an included group made private or deleted, a member's or an included group's owner disabled, enabled again or deleted), so they only ever climb and `claude plugin update` sees every change; the archive carries no sha256 pin (the listing would have to build every zip to compute one). `/m/<key>/*` answers 100 requests, then one a second, per key (429 `rate_limited`): the key sits in the URL, and the listing walks every member of every group.

```
claude plugin marketplace add https://scp.example.com/m/<YOUR_KEY>/marketplace.json
claude plugin install <group-slug>@scp-<username>
```

Use a key restricted to the groups you want installed: the key ends up inside each plugin's `.mcp.json`, and the marketplace lists exactly those groups (otherwise the first 200 of your own and shared ones). Claude Code downloads archives over `https://` only, never from localhost or a private address, so a Docker SCP on `http://localhost:8080` needs a real HTTPS hostname (a reverse proxy such as Caddy) before `claude plugin install` works. For local use, download `plugin.zip` from the group's Connect section (or `GET /api/v1/groups/<slug>/plugin.zip`) and unpack it where Claude Code loads plugins from; a browser download carries a `<YOUR_KEY>` placeholder in `.mcp.json`.

A group whose plugin cannot be built (two members with the same kind and name from different owners, which the plugin layout cannot separate with "Install as", or over 100 MB) is left out of the marketplace and `plugin.zip` answers 409 `path_conflict` / 413. The manifest reports it as `plugin: {ok: false, problem}`, the group page's Plugin tab shows the reason and its "Download plugin.zip" button is disabled with it.

## OAuth for hosted MCP clients

Hosted MCP hosts (Claude.ai, Claude Desktop, ChatGPT, VS Code, Claude Code without a pasted key) can connect to `/mcp` or `/mcp/<group>` with OAuth 2.1 instead of an API key. Point the host at the MCP URL and it does the rest: the 401 carries `WWW-Authenticate: Bearer resource_metadata=...`, the host reads `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, registers itself (dynamic client registration, anonymous, 20 per hour per IP; a registration nobody ever consents to is dropped after 7 days and the host simply registers again, while a consented one is kept however long its tokens have been gone, so the client id the host stored keeps working), and opens `/oauth/authorize` in your browser. You sign in if needed, land on the **Authorize** page, pick the permissions (`read` always, `write` optional) and either every group you can read or specific groups, and approve. The host exchanges the code for tokens and connects.

- PKCE S256 is mandatory; redirect URIs must be `https://`, `http://` on `localhost`, `127.0.0.1` or `[::1]` (any port; RFC 8252 reserves the port exemption for the IP literals, `localhost` is accepted too because hosts commonly register it), or the private-use scheme of a native host (`cursor://anysphere.cursor-mcp/oauth/callback`, `vscode://...`, `com.example.app:/oauth`; RFC 8252), matched exactly. Browser-executed schemes (`javascript:`, `data:`, `blob:`, `file:`, `vbscript:`, `about:`) are refused. An unknown client or a redirect URI that does not match the registration is a 400 page, never a redirect; any other failure of a registered client (an unknown scope, a PKCE method other than S256, a bad `resource`) is reported to its redirect URI as `error=` with the `state` (RFC 6749 4.1.2.1), so the host's pending flow ends instead of waiting for a code.
- Access tokens (`scp_at_...`) live 1 hour, refresh tokens (`scp_rt_...`) 30 days and rotate on every refresh; a rotated refresh token presented again revokes the whole grant, and so does replaying an authorization code with its PKCE verifier (without the verifier, or from another client, a spent code is refused and nothing is revoked: a leaked code cannot take the grant down). A client registered with `grant_types: ["authorization_code"]` alone gets no `refresh_token` and its refresh requests are 400 `unauthorized_client`. One exception: within 60 s of the rotation, while the grant still holds a live refresh token, the late call alone fails (`invalid_grant`) and the pair the first one issued survives. That is two refreshes in flight at access-token expiry (hosts do not serialize them), not a theft, and revoking would strand the host. Both are stored hashed. The token endpoint sweeps expired rows and rows revoked more than a day ago (on indexes), so a grant keeps a bounded number of rows however often it refreshes, and answers 30 requests, then one a second, per client address and per client id (429 `rate_limited`). A grant revoked by a replayed code or a reused refresh token is audited as `oauth.revoke` (`by: code_replay` / `reuse`).
- OAuth tokens work on `/mcp*` only. They are refused everywhere under `/api/v1`, so a token leaked from an MCP host cannot manage the account, mint keys or read the audit log. They never carry admin rights either, even for an admin's consent: "every group you can read" means the groups a regular user with that account reads, and the consent page offers an admin only those (another user's private group is 400 `unknown_group`). An admin who wants admin reach over MCP mints an API key.
- Every tool call and write made with a token is audited with the connected app's client id (`detail.oauthClientId`, shown as "app …xxxxxx" in Activity and Admin logs), so two apps stay tellable apart; a version an app writes names it the same way (`createdBy.clientId`, the item's Versions tab).
- Revoke a connected app any time under **API Keys → Connected apps** (or `DELETE /api/v1/oauth/grants/<id>`). An admin password reset (Admin > Users, `PATCH /api/v1/users/<id> {password}`) is account recovery: it revokes the user's sessions, API keys, every OAuth grant and any authorization code still awaiting exchange, and drops any single sign-on link, so neither an intruder's connected app nor an IdP identity they bound to the account can get back in. Disabling a user voids their pending codes and revokes their grants too (a connected app has to be approved again once the account is enabled); their API keys survive, refused until then. Admins list and disable OAuth clients with `GET /api/v1/oauth/clients?limit=&offset=` (newest first, 50 a page, with `total`) and `PATCH /api/v1/oauth/clients/<id> {"disabled": true}`; disabling suspends every grant of that client (its tokens are refused, Connected apps shows "disabled by admin") until it is enabled again, it does not revoke them. The token endpoint answers a disabled client with 400 `invalid_grant`, not 401 `invalid_client`: on the latter an MCP host (the SDK behind Claude Code, Claude Desktop, VS Code, Cursor) discards its client id and registers itself afresh, back in business under a client nobody disabled; on the former it keeps its id and lands on the refusal page until the admin enables it.
- Registration metadata `client_uri` and `logo_uri` must be `http(s)` URLs (400 `invalid_client_metadata`). The token request may omit `redirect_uri` (OAuth 2.1; PKCE binds the code), and a failed HTTP Basic client authentication answers `401` with `WWW-Authenticate: Basic realm="oauth"`.
- `SCP_PUBLIC_URL` must be the URL the host reaches you on: it is the issuer and the `resource` identifier in the metadata documents, and hosts refuse metadata whose issuer does not match. The 401 on `/mcp/<group>` points at `/.well-known/oauth-protected-resource/mcp/<group>`, whose `resource` is that URL (RFC 9728); one token still covers every MCP path. Group slugs are case-insensitive, so a host pointed at `/mcp/Kit` authorizes like `/mcp/kit`.

Endpoints: `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource[/mcp[/<group>]]`, `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/token` (`authorization_code`, `refresh_token`; form or JSON; `client_secret_post` or HTTP Basic for confidential clients), `POST /oauth/revoke`.

## OIDC login

SCP can sign users in through an external OpenID Connect provider (Authelia, Keycloak, Authentik, Entra ID, Google Workspace, ...). Set the three required values and a "Continue with <label>" button appears on the login page:

| Variable | Setting key (Admin > Settings) | Meaning |
|---|---|---|
| `SCP_OIDC_ISSUER` | `oidc.issuer` | Issuer URL; `{issuer}/.well-known/openid-configuration` must exist and name the same issuer |
| `SCP_OIDC_CLIENT_ID` | `oidc.client_id` | Client id registered at the IdP |
| `SCP_OIDC_CLIENT_SECRET` | `oidc.client_secret` | Client secret (confidential client). Sent as HTTP Basic (`client_secret_basic`, the OIDC default and what Authelia enforces), or in the body when the discovery document lists `client_secret_post` alone |
| `SCP_OIDC_AUTO_REGISTER` | `oidc.auto_register` | Create an account on first sign-in (default `true`), independently of `SCP_ALLOW_REGISTRATION` |
| `SCP_OIDC_LABEL` | `oidc.label` | Button text (default `Single sign-on`) |

An environment variable wins over the admin setting for that field. Register the redirect URI `{SCP_PUBLIC_URL}/api/v1/auth/oidc/callback` at the IdP; SCP asks for the `openid email profile` scopes, uses PKCE (S256), and accepts `RS256` or `ES256` id_tokens.

How a sign-in maps to an account, in order:

1. A user already linked to this identity (issuer + `sub`).
2. A user whose email equals the token's `email`, when the IdP marks it `email_verified: true` and that account has no password (an auto-registered account whose link an admin dropped): linked. An account with a password is never linked from the callback, because anyone may have registered that address first and kept the password (a pre-hijack); the page says to sign in with the password and link single sign-on from the account menu.
3. When auto-register is on and the IdP sent an email it does not call unverified: a new account. The username comes from `preferred_username` (else the email's local part), lowercased and slugified to SCP's username rules, with `-2`, `-3`, ... appended on a clash. Such accounts have no password: password login always fails for them. An admin can set one from Admin > Users (`PATCH /users/:id {password}`); `POST /auth/password` needs the current password, so it is not usable for them.
4. Otherwise a "no account" page. An admin creates the account (Admin > Users) and the user links it from their account menu, or the admin turns auto-register on.

A signed-in user links their own account from the user menu (`Link <label>`: `POST /api/v1/auth/oidc/link {next}` answers the IdP URL the browser then follows): the browser session is the proof of ownership, the callback then stores the identity on that account (403 when the identity already belongs to another account, or the account to a different identity). The link is bound to that session: if it ends before the callback (an admin reset, a logout) the link is refused. Linking starts from a POST only, so a page that navigates a signed-in user to `/auth/oidc/start` gets a plain sign-in, never a link. Password login keeps working after a link.

A link is dropped three ways: the user from the account menu (`Unlink <label>`: `POST /api/v1/auth/oidc/unlink`, 409 for an account without a password, which would become unreachable), an admin from Admin > Users ("Unlink SSO": `PATCH /api/v1/users/<id> {oidcUnlink: true}`, 409 for a password-less account unless a `password` comes in the same request; `GET /users` reports `oidcLinked` per user), and an admin password reset, which is account recovery and drops the link with everything else. Unlinking is how an account follows the IdP to a new issuer URL (a realm rename, http to https): the old link reads as "linked to a different identity, or to this provider under a previous issuer URL", the user unlinks and links again. The anonymous `/auth/oidc/start` and `/auth/oidc/callback` share the per-address rate limit of login and register (20, then one every 2 s), so a replayed state cannot drive token exchanges, which carry the client secret, at any rate.

Disabled accounts cannot sign in through OIDC either. SCP contacts only the token endpoint and JWKS the discovery document advertises, and only on a public `https://` host (the issuer's own or another, as Google and Cognito serve them from `*.googleapis.com` / `*.amazoncognito.com`); plain `http://` or an internal address (loopback, private, link-local) is refused unless the issuer itself is there (a local or test IdP). Requests time out after 10 seconds; discovery and keys are cached for 10 minutes, and a key rotation is picked up on the next unknown `kid`.

## Admin

Admins get three pages: **Users** (`/admin/users`), **Logs** (`/admin/logs`) and **Settings** (`/admin/settings`).

### Admin settings and storage

Admins manage server settings at `/admin/settings` (API: `GET`/`PUT /api/v1/admin/settings`). Settings live in the SQLite `settings` table under these keys: `oidc.issuer`, `oidc.client_id`, `oidc.client_secret`, `oidc.auto_register`, `oidc.label`, `github.token`, `import.max_items`, `import.max_archive_mb`, `import.max_pack_mb` (whole numbers: 1 to 2000 items, 1 to 256 MB; anything else is `400`). An environment variable (`SCP_OIDC_*`, `SCP_GITHUB_TOKEN`, `SCP_IMPORT_*`) always wins over the stored value and makes that one field read-only in the UI (the API lists them as `oidc.envFields` and `imports.envFields` and answers `400 env_managed`); the other fields stay editable, so `SCP_OIDC_LABEL` alone does not lock the issuer. Unset the variable to manage the value in the app. Secrets are write-only: the API reports `clientSecretSet` / `tokenSet`, never the value, and the audit log records only which keys changed. Sending `""` clears a value; omitted fields are kept.

The same page shows storage statistics and a "Sweep orphan blobs" button (`POST /api/v1/admin/gc`). File contents are stored once per sha256. Blob rows are removed in the same transaction as the item or user delete that drops their last reference, and a full sweep runs at boot (this reclaims space left by a database created before v2). The button runs that sweep by hand and is disabled while there is nothing to sweep.

### Admin logs

`/admin/logs` lists every user's audit events with filters (`GET /api/v1/audit?all=1&user=<username>&action=<prefix>&q=<text>&before=<id>&limit=`). `before` is a cursor: pass the smallest id of the page you have to load the next one. Non-admins can use the same filters on `/api/v1/audit` for their own events.

### Users

Admins can rename a user and change their email inline on `/admin/users` (`PATCH /api/v1/users/:id {username, email}`; 409 when either is taken). Renaming keeps the user's sessions and keys. A user linked to single sign-on carries an "SSO" badge and an "Unlink SSO" action (see OIDC login).

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
