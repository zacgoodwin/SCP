# SCP v2 plan: the deferred tickets

v1 (`docs/PLAN.md`) shipped the three planes, groups, MCP, artifacts, Docker. v2 works the Kata
backlog: imports with provenance, OAuth for hosted MCP clients, OIDC login, admin tools, nested
groups, plugin marketplace export, and the UI gaps. Every rule in `docs/PLAN.md` still holds
(access rules, 404-not-403, path rules, limits, no hosted LLM calls). This file only adds.

| Kata | Ticket | Chunk |
|---|---|---|
| p4az | Zip pack import (many skills/MDs in one zip -> items + a group, provenance) | D1 |
| tjr1 | GitHub import via the API, pinned commit, provenance, save as group | D1 |
| bx27 | Check a GitHub-imported item for upstream changes; update on confirmation | D1 |
| 696s | OAuth 2.1 authorization server (PKCE, DCR) for hosted MCP clients | D2 |
| hy7k | OIDC login against an external IdP | D3 |
| fmnw | Docker env flags (OIDC, GitHub token, first password, base URL) | D0 + D3 |
| 8hwj | Admin tools: users, logs, outside credentials, OIDC settings, OAuth clients | D4 |
| 6cqt | Blob garbage collection | D4 |
| 58z1 | Nested groups (a group includes another group) | D5 |
| ecv9 | Claude Code plugin marketplace export | D5 |
| f1y7 | Install-as field in the add-member flow | D5 |
| ae3s | Dashboard shows groups shared with me | D6 |
| vc6t | UI for zip pack / GitHub URL import, source panel + update check | D6 |
| sfxv | Verify structuredContent in a real Claude Code session | D8 (by hand) |
| dqtd | UI second pass | D7 |
| v107 | Semantic search: evaluate | D8 (doc only) |

## D0 foundation (done by hand, in this commit)

- Migration 4 in `db.ts` (below). Every chunk relies on it; no chunk adds a migration.
- `types.ts`: `Principal.via` gains `'oauth'` and `oauthClientId?`; `ItemRow` gains
  `source_kind`, `source_commit`; `UserRow` gains `oidc_issuer`, `oidc_sub`.
- `config.ts`: `githubApiUrl` (`SCP_GITHUB_API`, default `https://api.github.com`), `githubToken`
  (`SCP_GITHUB_TOKEN`), `oidc` (`SCP_OIDC_ISSUER`, `SCP_OIDC_CLIENT_ID`, `SCP_OIDC_CLIENT_SECRET`,
  `SCP_OIDC_AUTO_REGISTER` default true, `SCP_OIDC_LABEL` default `Single sign-on`). Env values
  override the admin settings (D4) when set.
- `items/service.ts`: `CreateItemInput.source?: ItemSource` written to the item row;
  `ItemDetail.source` is `{kind, repo, ref, path, commit} | null`.
- Stub modules, each an empty `new Hono<AppEnv>()` (or a function returning the null case),
  already mounted so a chunk only fills its own files:
  - `server/src/imports/routes.ts` `importRoutes` (under `/api/v1`) ................ D1
  - `server/src/oauth/routes.ts` `oauthRoutes` (app root: `/oauth/*`, `/.well-known/*`) and
    `oauthApiRoutes` (under `/api/v1`: consent, grants, clients) ................... D2
  - `server/src/oauth/tokens.ts` `principalFromOAuthToken(c, token)` -> `Principal | null`,
    used by `mcp/routes.ts` after `principalFromKey` fails ........................ D2
  - `server/src/auth/oidc.ts` `oidcRoutes` (under `/api/v1`) and `oidcPublicConfig(ctx)`
    -> `{enabled, label}` returned by `GET /auth/config` as `oidc` ................ D3
  - `server/src/admin/routes.ts` `adminRoutes` (under `/api/v1`) ................... D4
  - `server/src/groups/marketplace.ts` `marketplaceRoutes` (app root: `/m/*`) ...... D5
  - `web/src/pages/Consent.tsx` (`/consent`) D2; `AdminSettings.tsx` (`/admin/settings`) and
    `AdminLogs.tsx` (`/admin/logs`) D4.
- `web/src/api.ts` exports `json`, `qs`, `send`. Chunks add API functions in their own file
  `web/src/api-<chunk>.ts` (e.g. `api-import.ts`), never in `api.ts`.
- `mcp/routes.ts`: 401 carries `WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource"`.
- `docker-compose.yml` and the README env table carry every v2 variable.

### Migration 4

```sql
CREATE TABLE group_includes (
  group_id TEXT NOT NULL REFERENCES scp_groups(id) ON DELETE CASCADE,
  included_id TEXT NOT NULL REFERENCES scp_groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, included_id),
  CHECK (group_id <> included_id)
);
CREATE INDEX group_includes_included ON group_includes(included_id);
ALTER TABLE items ADD COLUMN source_kind TEXT CHECK (source_kind IS NULL OR source_kind IN ('github','zip'));
ALTER TABLE items ADD COLUMN source_commit TEXT;
CREATE INDEX version_files_sha ON version_files(sha256);
ALTER TABLE users ADD COLUMN oidc_issuer TEXT;
ALTER TABLE users ADD COLUMN oidc_sub TEXT;
CREATE UNIQUE INDEX users_oidc ON users(oidc_issuer, oidc_sub) WHERE oidc_sub IS NOT NULL;
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,                 -- client_id, newId()
  secret_hash TEXT,                    -- NULL for public clients (token_endpoint_auth_method none)
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,         -- JSON array
  grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  client_uri TEXT, logo_uri TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scopes TEXT NOT NULL, group_ids TEXT, resource TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL,              -- one consent = one grant; revoking it kills both tokens
  scopes TEXT NOT NULL, group_ids TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT
);
CREATE INDEX oauth_tokens_user ON oauth_tokens(user_id);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
```

### Migration 5 (v2 review)

```sql
ALTER TABLE item_versions ADD COLUMN created_by_client TEXT REFERENCES oauth_clients(id) ON DELETE SET NULL;  -- the OAuth client a version was written through
CREATE INDEX oauth_tokens_client ON oauth_tokens(client_id);  -- the client sweep and the admin client listing look tokens up by client
```

### Settings keys (table `settings`, D4 writes, D1/D3 read)

`oidc.issuer`, `oidc.client_id`, `oidc.client_secret`, `oidc.auto_register` (`true|false`),
`oidc.label`, `github.token`, and (v3 dhje, 00tr) `import.max_items` (default 200, 1..2000),
`import.max_archive_mb` (35, 1..256: the GitHub zipball and the pack upload body, compressed; the
single-file `POST /items/import` body too, never above 35) and
`import.max_pack_mb` (64, 1..256: `PACK_LIMITS` per file and total, unpacked), env
`SCP_IMPORT_MAX_ITEMS` / `SCP_IMPORT_MAX_ARCHIVE_MB` / `SCP_IMPORT_MAX_PACK_MB` (out of range stops the
boot), ranges in `config.ts` `IMPORT_LIMITS`, read per request through `admin/settings.ts importLimit`;
`GET /admin/settings` reports them as `imports` with `envFields`; `GET /imports/limits` reports the
effective values (plus `maxFileMb`) to any signed-in user, so the Import dialog refuses an oversize
file before uploading it (a browser cut off mid-upload by the 413 sees a connection reset). The per-version caps stay fixed (the
item storage contract). Read through one helper per consumer: effective value =
env (config) when set, else the settings row, else default. Secrets are never returned by the
API: `GET /admin/settings` reports `clientSecretSet: true`, `tokenSet: true`.

## D1 imports (`server/src/imports/*`, tests `server/test/imports.test.ts`)

```
POST /items/import/pack    multipart file=<.zip> [visibility] [group=<slug>] [groupName] [intoGroup=<slug>] [kind] [folderKinds=<JSON>] [includeRepoTooling=true] [onNameClash] [frontmatterErrors] [description]  -> 201 ImportResult | 409 frontmatter_errors
POST /items/import/github  {url} | {repo, ref?, path?}  + visibility?, kind?, name?, group?, groupName?, intoGroup?, folderKinds?, includeRepoTooling?, onNameClash?, frontmatterErrors?, description?  -> 201 ImportResult | 409 frontmatter_errors
POST /items/:id/source/check                                                                     -> {source, upToDate, latestCommit}
POST /items/:id/source/update  {note?}                                                           -> {item, skipped}  (new version; 409 up_to_date when nothing changed; skipped: the path's symlinks)
PUT  /items/:id/source/frontmatter  {description}                                                -> {item}  (jcfm; 404 when SCP supplied nothing; 409 frontmatter_edited)
ImportResult = {items:[ItemDetail], group: GroupDetail | null, skipped:[{path, reason, prefixed?}], skippedFolders:[{path, count}], source: ItemSource | null}
ItemSource = {kind:'github'|'zip', repo: string|null, ref: string|null, path: string|null, commit: string|null}
```

- `url` forms: `https://github.com/{o}/{r}`, `.../tree/{ref}/{path}`, `.../blob/{ref}/{path}/SKILL.md`
  (the file's folder); host `github.com` or `www.github.com` (any case), `https:` or `http:`, or no
  scheme at all (`github.com/o/r`, v3 hs8z). `repo` is `owner/repo`; `ref` a branch, tag or 7-40 hex sha (default: the
  repo's default branch); `path` a folder (default root) or one file, which is then the unit and
  every unit's `source_path` as is (`pathIsFile`; v3 kgtx: it was stored as `<file>/<name>`, and
  a v3 migration, `db.ts` `UNDOUBLE_SOURCE_PATHS`, cuts such rows back). Owner/repo `^[A-Za-z0-9_.-]{1,100}$`, ref
  `^[A-Za-z0-9_./-]{1,200}$` without `..`. Anything else is 400 `bad_source`.
- GitHub fetch via the API only, no clone, no code execution: `GET {githubApiUrl}/repos/{o}/{r}/commits/{ref}`
  (-> full sha; 404 -> 400 `bad_source`), then `GET {githubApiUrl}/repos/{o}/{r}/zipball/{sha}`
  (follow redirects, 60 s timeout, body capped at `import.max_archive_mb`, default 35 MB -> 413 naming
  the cap: the whole repository, compressed)
  into `safeUnzip` with a `keep` predicate (`underPath`) that skips every entry outside
  `<top>/<path>/` before it is counted, sized or inflated. The archive is held to pack caps
  (`PACK_LIMITS`: 20,000 files, `import.max_pack_mb` inflated, default 64 MB, the process's memory bound), not a version's: each
  unit meets the per-version caps (1000 files, 30 MB) in `createItemTx` as it becomes an item, so a
  150-skill repository imports and an oversize unit alone lands in `skipped`, one over the 10 MB
  per-file cap included (`PACK_LIMITS.fileBytes` is the 64 MB total, never a version's cap). Then
  strip the one top folder GitHub adds. Pack and repository imports (and `source/update`) unzip in
  skip mode (v3 a51r): a symlink entry is never imported, resolved or followed; it lands in
  `skipped` as `symlink to '<target>', not imported` (the target is the entry's stored bytes,
  capped at 255 characters) and the rest of the tree imports, so `CLAUDE.md -> AGENTS.md` no longer
  fails a whole repository. The single-file `POST /items/import` still refuses a zip holding one.
  Entry names have `\` read as `/` first (Windows `Compress-Archive`, v3 31bp). Header
  `Authorization: Bearer <token>` when `github.token` is set (env `SCP_GITHUB_TOKEN` first, then the
  setting). `resolveCommit` always reads `GET /repos/{o}/{r}` and refuses `private: true` for a
  non-admin principal (400 `bad_source`): the instance token must not make every account a reader
  of every private repository it reaches. Only `githubApiUrl` is ever contacted (no user-supplied
  hosts).
- Over the archive cap with a `path` (v3 a4q8; `import/github` and `source/update` alike, `routes.ts`
  `download` -> `github.ts fetchFolder`): the folder comes through the Git Data API instead. One
  `GET /repos/{o}/{r}/git/trees/{sha}` per path segment walks the tree shas down (a recursive
  listing of the whole repository truncates on exactly the repositories that land here; chosen over
  recursive-then-walk for one code path), then `git/trees/{folder}?recursive=1` (`truncated` -> 413).
  Junk paths drop out; the blobs are held to the per-version limits (`LIMITS`: 1000 files, 10 MB
  each, 30 MB) from the listing's sizes, and to the listing's `x-ratelimit-remaining` (more blobs
  than left -> 400 naming `github.token`, or the token's reset), before any blob is fetched. Each
  listing is charged to the per-user bucket as it is made, a refused folder's included, then the
  blobs at once (`ratelimit.ts spend`: the import was admitted by its one `take`, so this never
  refuses and may go into debt, which the user's next GitHub call waits out), and `git/blobs/{sha}`
  (raw, 8 at a time, each checked against its git object id) builds the same repository-relative
  `TreeFile[]` the zipball gives. Mode 120000 is a link (`symlink to ...` in `skipped`, as a51r), 160000 a submodule
  (`submodule at <7sha>, not imported`; a zipball leaves it out). No `path`: still 413.
- Pack layout detection (zip and GitHub alike), in order, each hit becomes one item:
  `.claude-plugin/plugin.json` (plugin: `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`),
  `.claude/skills/*/SKILL.md`, `.claude/agents/*.md`, `.claude/commands/*.md`, `skills/*/SKILL.md`,
  `agents/*.md`, `commands/*.md`, `prompts/*.md`, any other `*/SKILL.md` (its folder), `SKILL.md`
  at the root in any case (one skill over every remaining file), `AGENTS.md`/`CLAUDE.md`/
  `INSTRUCTIONS.md` (instructions), `DESIGN.md` (design). A folder's `skill.md` in any case is the entry, stored as
  `SKILL.md`. A folder import (`folderRoot`: a GitHub `path`, or a zip whose one wrapper folder was
  stripped) holding a root `SKILL.md` is that one skill over the whole tree (`source_scope`
  `tree`), `CLAUDE.md` and `agents/*.md` included, as the same folder is under `skills/` in a
  whole-repository import; root carving is for a repository root. A tree with none of these and
  only `*.md` files: each `.md` imports via the existing `importUpload` detection. Unknown or
  invalid units land in `skipped` with the reason (lint errors included), never fail the whole
  import: a folder under a skills dir with no `SKILL.md`, any unclaimed `.md` outside a layout
  folder (one nested below `agents/`, `commands/` or `prompts/` is told only that folder's `*.md`
  is imported), and a README-style file inside those folders (it would otherwise become a slash
  command named `readme`); a root README is expected and not reported. README-style means the
  stems README, LICENSE/LICENCE, CHANGELOG, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, with an
  optional dotted suffix (`README.de.md`), never a stem that merely starts so (`security-review.md`).
  Nothing recognised at all is 400 `nothing_to_import`, with the skip reasons as `details` when
  there are any. Each returned item carries `op` (`create` | `version` | `unchanged`). At most 200
  items per import by default (`import.max_items`; 400 `too_many_items` naming the cap).
- Nested plugins (v3 bppq, `pack.ts pluginRoots`): every folder holding `.claude-plugin/plugin.json`,
  plus every same-repository `source` (`./x`, normalised, inside the tree) a root
  `.claude-plugin/marketplace.json` lists, is a plugin root. Each root's `skills/*/SKILL.md`,
  `agents/*.md`, `commands/*.md`, `prompts/*.md` (and the `.claude/` variants) are detected first,
  deepest root first so a nested plugin claims its own files, then the repository root's as above.
  A source naming another repository (an object source, a URL, a path without `./`) or escaping the
  tree is never followed and lands in `skipped` against `marketplace.json`; so does a marketplace
  file that is not a JSON object. An `.md` at any depth in an `agents/` or `commands/` folder outside every plugin
  root and below the repository root (`antigravity/x/agents/<name>/agent.md`) is told it is imported only inside a plugin. Two plugins of one
  source shipping the same name: the second is skipped as `name_taken`, naming the path that holds
  it. `updateTree` runs the same detection, so a nested plugin's agent updates like a root one.
- Unsupported plugin components (v3 dnxq part 1): inside a plugin root, `hooks/`, `.mcp.json`,
  `output-styles/`, `settings.json`, `.lsp.json` and `monitors/` are never stored or served; each
  lands in `skipped` once (`plugin <component> is not supported by SCP; it was not imported`), not
  file by file. Outside a plugin these are ordinary files. Part 2, whether SCP should store and serve
  hooks and MCP servers at all, is pending a human decision (options: never; admin-published only;
  any owner with an install-time warning; each widens who can run code on subscriber machines).
  Until it is taken SCP is report-only (docs/PLAN-v3.md "Decisions taken"). The plugin.zip SCP
  builds carries only its own `.mcp.json`.
- Manifest component paths (v3 4ky8, `pack.ts declaredPath`), detected before every convention
  pass: a plugin root's `plugin.json`, or its same-repository `marketplace.json` entry, may name
  `skills`, `agents` and `commands` (a string or a list). Each path is resolved against the plugin
  root; an absolute one, one escaping the plugin root, one SCP would not store (`normalizePath`) or
  one holding no `SKILL.md` / `.md` lands in `skipped` against the manifest, and the rest imports. A
  `skills` path is one skill folder (its own `SKILL.md`) or a folder of them; an `agents`/`commands`
  path is one `.md` or a folder of them. Declared files are claimed first, so conventions add only
  what is left, never a duplicate. Remote marketplace sources are never fetched (bppq above).
  Manifest problems (here and bppq's marketplace sources) are listed up to 500 per import, the rest
  counted in one entry; a list or object where a path belongs shows as `[...]` / `{...}`.
- Maintainer tooling (v3 4ky8 part 2): when the tree has a plugin root, or `skills/*/SKILL.md` at the
  root, `.claude/skills|agents|commands`, `.agents/skills`, `.gemini/skills` and `.opencode/skills`
  are skipped, once per folder, as `maintainer tooling (repo ships a plugin)` (or `a skills/
  folder`). With a plugin root the root `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` are skipped too (a
  Claude Code plugin ships no instructions); with only a `skills/` folder they import as before,
  since a skills repository's `AGENTS.md` may be the product. `includeRepoTooling: true` (GitHub
  body; pack form field `includeRepoTooling=true`) restores the old detection. `updateTree` runs the
  same detection without the flag, so an update never pulls skipped tooling into a root skill.
- Which copy of a skill wins (v3 ypmn): the "any other `*/SKILL.md`" pass takes the outermost skill
  folders only (a nested one stays its parent's file) and orders them inside a non-root plugin root
  or a `.claude` folder first, then under a `skills` folder, then neutral, and last under a folder
  named for another tool (`.openclaw`, `.opencode`, `.gemini`, `.cursor`, `.kiro`, `.windsurf`,
  `.codex`, `antigravity`, `codex`, `openclaw`, `opencode`, `cursor`, `gemini`; a skill's own folder
  name never counts); depth, then path, within a rank. A port that loses its name to a better copy of
  the same import is skipped as `another copy of this skill (<path>) was imported; this one is the
  <tool> port`. Re-import and `updateTree` detect the same way, so the kept copy stays the same.
- Reuse `items/import.ts importUpload` / `items/service.ts createItemTx` for each unit; pass
  `source` on every item. An existing item of that kind with the unit's `source_repo`+`source_path`
  is the unit's item whatever its name (`importUnit`, checked before creating): add a new version to
  it (re-import = update), unless its `source_commit` already equals the import's (same commit, or
  the same zip bytes) or the unit's tree with the stored block is `source_tree_sha256` (a commit that
  left it alone): then `op: 'unchanged'` with the ref and commit recorded, so a local edit made since stays the latest version (jcfm: unless the unit
  carries supplied frontmatter other than the item stores; that swaps only the block on the latest
  version, as `PUT /items/:id/source/frontmatter` does, so a local edit keeps its body and a block
  edited by hand skips the unit as `frontmatter_edited`).
  Otherwise a `name` collision with the user's existing items of that kind is a 409 `name_taken`
  per unit, listed in `skipped`. When the name holder
  came from a zip under another file name, the reason names that file ("upload the file under
  that name to update it"): the zip's identity is its file name.
- `group`: when given, create the group (`groups/service.ts createGroup`, 409 if taken) with all
  imported items as members; `groupName` defaults to the manifest's `displayName`, then its `name`,
  then the repo or zip name, and the description comes from the manifest (v3 5w3w,
  `imports/manifest.ts pluginMeta`: `.claude-plugin/plugin.json`, else a `marketplace.json` listing
  exactly one plugin, else `.codex-plugin/plugin.json`; read only when `group` is given). plugin.zip
  writes the slug as its `name` and the group's description. The manifest is untrusted JSON (1 MB cap, an object, string fields trimmed and held
  to the group limits of 100 and 2000 characters): a bad manifest or field is ignored and listed in
  `skipped`, never a failed import. The whole import is one
  transaction: group + items + members, or nothing (apart from `skipped`). Every unit skipped is
  422 `nothing_imported` with `skipped` as `details`, never a 201 with `items: []`; with a group
  requested the group rolls back and its slug is not burnt. `kind: artifact` is 400 (a tree has no
  format), on the GitHub route before anything is fetched or the rate bucket charged (v3 xksr).
- `intoGroup` (v3 p2wf): an existing group every imported item joins (`addMemberTx`, same
  transaction), instead of `group` creating one; both together are 400, and an empty `group` or
  `intoGroup` in the GitHub JSON is 400 too (the pack form reads `''` as absent). Resolved before anything is
  fetched (`groups/service.ts loadEditableGroupOr404`): a group p can read but not edit is 404 like
  one it cannot read. An item already a member (a re-import of the same source) is versioned and
  not added again. Audit `group.members` `{op: 'import', count}` when members were added (never a
  second `group.create`). A group-restricted key is still refused first.
- `kind` on a tree (v3 jwz6, pack form field too): detection off. `agent`, `command`, `prompt`,
  `instructions`: each `.md` directly in the folder is one item of that kind (`pack.ts fileUnits`;
  commands and prompts named by file, like `prompts/`), source path the file's, so a re-import
  versions each; README-style docs, non-`.md` files and subfolders' `.md` files (their names could
  collide) land in `skipped`. A folder of exactly one such `.md` stays one item named after the
  folder, source path the folder, as before, so an item imported that way versions on re-import. Before this a single-file kind on a
  folder of 2+ files always failed (`a <kind> holds exactly one file`). `skill`, `design`,
  `package`: the whole tree one item, as before; so is any kind on a GitHub `path` naming one file.
- `skippedFolders` / `folderKinds` (v3 mvfp): every `.md` the detection fallback lists as passed
  over is counted by parent folder (`[{path, count}]`, `''` the root; README-style docs are never
  listed, so never counted). The 201 carries it, and the 400 `nothing_to_import` / 422
  `nothing_imported` carry it beside `details` (`error.skippedFolders`, `HttpError.extra`), since a
  code repository's `docs/prompts/` is exactly the 400 case. `folderKinds: {"<folder>": kind}`
  (JSON text in the pack form; at most 100; kinds `agent|command|prompt|instructions|design|package`)
  runs after every detection pass, so it only takes what conventions left: the folder's direct
  loose `.md` files become one item each (`design` stored as `DESIGN.md`; `updateTree` re-homes it
  the same way), or `package` the whole folder's remaining files one item. A key that fails
  `normalizePath` (`../x`, `/abs`, `C:/x`) is 400 before anything is fetched; a folder with nothing
  left lands in `skipped` as `folderKinds: no unrecognised files in this folder; ignored`.
- Name clashes (v3 5ef6). Inside one import, skills sharing a name (`previewItem` names every unit
  before the transaction) are all imported: each non-port copy takes `Unit.prefix`, its plugin
  root's folder name, else for `<x>/skills/<name>` the `<x>` (never a dot folder or a port), as
  `<prefix>-<name>`; ports of a name every copy was prefixed away from are skipped as ports. Agents
  and other kinds keep the bppq rule (the second is `name_taken`). Across sources: a name an item
  from another source (or a local one) holds is skipped, the `skipped` entry carrying
  `prefixed: '<repo>-<name>'`; `onNameClash: 'prefix'` (pack form field too) imports it under that
  name, `<repo>` the repository name or the zip's file name less `.zip`. Same-repository clashes
  keep their reasons. A renamed skill or agent has its entry's frontmatter `name:` rewritten
  (`items/service.ts renameFrontmatter`, as a fork's): chosen over relaxing `lint.ts`
  `skill.name.dir`, since Claude Code identifies a skill by that name and it must match the
  `.claude/skills/<name>/` folder the bundle installs. The item records what was put in front of
  the unit's bare name, `source_prefix` (migration 12): the in-import prefix, the cross-source one,
  or both combined (`fork-discord` for `fork-discord-access`, a fork of a repository whose plugins
  discord and imessage both ship `access`). `versionFromSource` re-applies the name (`keepPrefix`:
  the item name is `<source_prefix>-<upstream name>`), and a re-import, with or without the option
  and after the clash is gone, versions the prefixed item of that source path (found by source and
  the name the unit takes, or `<source_prefix>-<bare name>`). Rows from before the column infer
  the prefix (`wasPrefixed`: the repository or zip name, or one folder above the unit), which
  misses an item that took both. A unit imported with `frontmatterErrors: 'import'` that is also
  prefixed has its `SKILL.md` `name:` rewritten to the prefixed item name all the same (a skill's
  name is its install folder, `skill.name.dir`), so its bytes differ from upstream's in that one
  line; everything else stays upstream's. The rule (`pinName`): a skill, or a one-file agent, that
  carries a name SCP chose (a prefix, or a `name` the import was given) always stores exactly that
  `name:`. A block that parses but names nothing gets the line added first (`renameFrontmatter`,
  the value emitted by the yaml library; a key a line edit cannot reach is re-emitted whole); an
  entry with no frontmatter takes the block jcfm supplies, name included (`pinName` leaves it to
  `supply`, which a name-only block would shut out), and stays nameless when no description is
  supplied. A block that does not parse (invalid YAML or fence) cannot take
  it: 422 `frontmatter_invalid`, so the import skips the unit ("its frontmatter is not valid YAML,
  so it cannot take the prefixed name '<n>'") instead of importing it bare, and a source update or
  re-import refuses and leaves the item unchanged. `keepPrefix` pins an upstream that dropped
  `name:` when the item records a `source_prefix` it starts with (a row from before the column
  keeps the nameless entry). A cross-source retry whose `<repo>-<name>` is itself held is skipped
  saying the prefixed name is taken too, with no `prefixed` offer. A given `name` is not recorded,
  so a later source update of such a skill whose upstream names it otherwise is refused by
  `skill.name.dir` as before. A prefixed name
  is never cut to the 64-character cap (a cut one breaks `keepPrefix`, and two long names can cut to
  one): such a unit is skipped with the limit as its reason and no `prefixed` offer.
- Frontmatter errors (v3 0rdh): `items/lint.ts FRONTMATTER_ERRORS` (`frontmatter.invalid`,
  `skill.name.empty` (v4 rv5z: `name: ""` or blank, a missing name rather than a malformed one),
  `skill.description.missing`/`.len`, `agent.name.missing`, `agent.description.missing`) are the
  errors an import may accept; a non-empty malformed name (`skill.name.format`) is not. `frontmatterErrors: 'ask' | 'import' | 'skip'` (default `ask`): with
  `ask`, units whose every lint error is one of those (and no earlier import of the same source
  took them) make the import 409 `frontmatter_errors`, `details: [{path, kind, errors}]`, before
  the transaction, so nothing exists, no group either. `skip` is the earlier behaviour. `import`
  stores the upstream bytes untouched; the errors stay on the version as `level: 'warn'`,
  `waived: true`; a skill or agent the frontmatter does not name takes its folder or file name
  (never a heading), and a missing description the body's first non-heading paragraph (v4 t1ge: for
  a fence that never closes, the first one after its YAML, so never the YAML: the run of non-blank
  lines after the opener whatever it holds (quoted keys too), up to a `---` with trailing whitespace
  (no fence to the parser, so the closer the author meant); then up to the furthest paragraph end
  (of at most 16, within 8 KB) whose text from the opener still parses with `lib/frontmatter.ts` as a
  mapping that adds only known frontmatter keys (`FRONTMATTER_KEYS` in `items/lint.ts`), so YAML
  holding blank lines (between keys, in a folded scalar, in a list) and comments stays YAML, while a
  paragraph of `#` lines alone is a heading, not YAML. A `---` with trailing whitespace ends the YAML
  wherever it comes and the body starts after it (a heading or list right after it is the body's);
  past a blank line an unknown `Word: text` line is read as the body's first line, the likelier of
  two readings. The title
  heading is looked for in the same text, for every kind and not only with `import`. An item an
  earlier import named from a heading anywhere in such a text, its YAML lines included
  (`---\n# Project Guide\n...` was `project-guide`), is still that unit on re-import and keeps its
  name: `importUnit` previews the pre-v4 name too, `previewItem(..., preV4)`). The item
  gets `lint_waived = 1` (migration 11), and every later source write (`versionFromSource`:
  source/update and re-imports) accepts the same errors without asking. A local edit is still
  gated. Any other lint error skips the unit in every mode.
- Supplied frontmatter (v3 jcfm, `pack.ts supply`, `lib/frontmatter.ts prependFrontmatter`):
  `description` (trimmed, at most 1024 characters, lint's cap; blank is none) applies to an import
  of exactly one unit that is not a package (a package's entry is README.md or its first .md, so
  none is fixed), else 400 before anything is written. When the unit's entry (`SKILL.md`,
  `DESIGN.md`, a single-file kind's file) has no frontmatter block upstream, SCP puts one in front
  of it: `name` (skills and agents only: the item name, so a 5ef6 prefix carries over) and
  `description`, emitted by the `yaml` library (never concatenated), so `:`, `#` and newlines
  round-trip and the same fields always give the same bytes. The fields are stored on the item
  (`supplied_frontmatter`, JSON; migration 13). An entry with a block of its own (even a broken one)
  keeps it and nothing is stored. Every later source write (`versionFromSource`: source/update and
  re-imports, which take the stored fields when the request gives none, before the previews, so
  nothing is asked) applies the same rule: upstream still without one gets the stored block byte
  for byte; upstream with its own wins (but a supplied `name` is pinned on it, `pack.ts keepPrefix`
  with pin: a skill's name is its install folder and the item's identity), the fields stay as the fallback and `upstream_frontmatter`
  is 1 (`ItemDetail.upstreamFrontmatter`; the item page says "upstream now provides its own
  frontmatter"). The stored fields always describe the block the latest version carries: a source
  write that adds no version (op 'unchanged', a local edit since staying the latest) leaves them.
  `PUT /items/:id/source/frontmatter {description}` (edit rights) edits the stored
  description: while the supplied block is in use, a new version with the latest version's block
  swapped for the new one, and `source_tree_sha256` moved to the source's last tree with the same
  swap, so the same upstream file is still no change and a local edit survives it; while upstream
  has its own, only the fallback. A block edited by hand
  since is 409 `frontmatter_edited`, never overwritten. `ItemDetail.suppliedFrontmatter` is
  `{name?, description}` or null.
- One file as a skill (v3 mas4): a GitHub `path` naming one `.md` file with `kind: skill` makes
  that file the skill's `SKILL.md` (`importTree`; `updateTree` re-homes it again on every update,
  matched by `source_path` naming that file). The name defaults to the file stem, or the
  repository name when the stem is generic (`skill(s)`, `agent(s)`, `readme`, `index`, `claude`,
  `instructions`; `pack.ts fileRootName`): `cesarferreira/stax` `skills.md` is `stax`. With a
  `description` and no upstream frontmatter, SCP supplies `name` and `description` as above, so the
  skill passes lint and tracks the upstream file. Without `kind: skill` the file imports as before.
  A `/blob/<ref>/<path>/<file>.md` URL with `kind: skill` is the same import of that file (v4 y15q);
  a `SKILL.md` blob URL, or any blob URL without `kind: skill`, still names the file's folder.
- One-file names of last resort (v4 y15q, `fileRootName`): any import whose `path` names a file
  falls back to the file stem, never the file name (`agents/helper.md` with `kind: agent` and no
  frontmatter name or heading is `helper`, not `helper-md`), and a `SKILL.md` to its folder's name
  (`skills/foo/SKILL.md` is `foo`, with or without `kind: skill`; the repository's at its root).
  An item an earlier import named by the old fallback (the file name, `go-md` or `skill-md`; for
  `kind: skill` the stem, or the repository's for a generic one) is still that unit on re-import and
  keeps its name (`pack.ts importUnit`, `preV4RootName`), unless upstream has named the unit since.
  Not matched: such an old name that a clash also prefixed (`<repo>-go-md`), which comes back new.
- Provenance: `source_kind`, `source_repo` (`owner/repo` as GitHub's `full_name` spells it, zip: the
  file name), `source_ref`, `source_path`, `source_commit` (zip: sha256 of the zip bytes),
  `source_tree_sha256` (the tree the source last wrote), `source_scope` (`root` for a root
  `SKILL.md` detection unit, `tree` for a folder unit or a `kind` override), `source_carve` (v3: the
  paths inside a folder unit that another unit or skip took first), `source_prefix` (v3 5ef6: what
  the import put in front of the unit's bare name). Version note
  `import github owner/repo@<7sha> <path>` / `import zip <name>`.
- `source/check`: GitHub only (404 otherwise). Resolves `ref` again (a sha ref is always up to
  date), compares to `source_commit`. `source/update` re-imports that path at the latest commit as
  a new version (`addVersion`) and updates `source_commit`; the same commit as `source_commit`, or
  a tree identical to the latest version or to `source_tree_sha256` -> 409 `up_to_date` (so an
  update never writes the upstream tree over a local edit: not while check says up to date, and not
  when a commit elsewhere in the repository moved HEAD while this path stayed the same).
  A skill is carved the way its import carved it (`updateTree`, by `source_scope`): a root `SKILL.md`
  import leaves sibling units (`AGENTS.md`, `agents/*.md`) to their own items, as does a `SKILL.md` at
  a nested plugin root for that plugin's components (bppq), while a `skills/<name>/` folder, a folder
  import or a `kind` override keeps the whole folder. What another unit carved out of a skill folder
  (`source_carve`: a nested declared skill path, a marketplace entry's `agents`, a nested plugin's
  components) stays out, since the folder's subtree shows neither the marketplace.json nor the other
  declared paths; a re-import records the carve afresh. Rows from before `source_scope` was recorded
  infer it from the stored version (it holds none of the carved files exactly when the import carved
  them). A lone loose `.md` the md-only fallback re-homed (`design.md` -> `DESIGN.md`, `skill.md` ->
  `SKILL.md`) is re-homed the same way on update.
  Both require edit rights; audit `item.source_check`, `item.version` with `via: 'github'`.
- A group-restricted key is refused (403 `restricted_key`) before any body is parsed or anything
  fetched. A lone top folder named like a layout folder (`skills`, `agents`, `commands`,
  `prompts`, `.claude`, `.claude-plugin`) is kept, not stripped as a wrapper; a GitHub `path` ending
  in `agents`/`commands`/`prompts` makes the loose `.md` files at its root that kind. The md-only
  fallback re-homes `design.md` to `DESIGN.md` like the single-file import (a root `skill.md` is
  the root skill before the fallback is reached).
  Re-import updates the item of that kind with the same `source_repo` (compared
  case-insensitively: GitHub names and zip file names are) + `source_path` and the unit's name, or
  that name under its 5ef6 prefix, or whatever its name when SCP supplied it (mas4: pinned, its
  identity); two source paths never resolve to one item. A unit renamed upstream is a new unit:
  created under the new name, or skipped when an unrelated item holds it, never written into the
  item that kept the old name. At the same commit the
  row's `source_ref` still follows the ref named (a tag, then the branch at that commit).
  A private repository is refused to non-admins with the very text a missing repository gets.
- Body caps: pack `import.max_archive_mb` (default 35 MB, read per request; added to `UPLOAD_ROUTES` by D0), single-file import the same at most 35 MB, github JSON 1 MB.
- GitHub quota: one shared identity (the token, or the egress address), so `import/github`,
  `source/check` and `source/update` take from a per-user token bucket (`lib/ratelimit.ts`
  `AUTH_LIMITS.github`: burst 10, 0.2/s; 429 `rate_limited`) before anything leaves; a sha-pinned
  item's check and update contact nothing and cost nothing. At most `ZIPBALL_SLOTS` (3) zipball
  downloads are in flight process-wide (503 `busy` with `Retry-After`, `imports/github.ts
  withZipballSlot`), and a GitHub 403/429 with `x-ratelimit-remaining: 0` is a 429 naming the reset.
- Tests run a local `node:http` server as `SCP_GITHUB_API` serving `/repos/...` and a zipball
  built with `buildZip`; cover: url parsing, pack detection per layout, skipped units, group
  creation + rollback on group slug conflict, provenance fields, check/update flow, re-import
  updates in place, token header sent, size cap, no request leaves for a non-GitHub host.

## D2 OAuth 2.1 authorization server (`server/src/oauth/*`, `web/src/pages/Consent.tsx`, `web/src/api-oauth.ts`, tests `server/test/oauth.test.ts`)

App-root endpoints (`oauthRoutes`, no cookie auth, JSON errors per RFC 6749 `{error, error_description}`):

```
GET  /.well-known/oauth-authorization-server   RFC 8414: issuer=publicUrl, authorization_endpoint, token_endpoint,
                                               registration_endpoint, revocation_endpoint, scopes_supported [read, write],
                                               response_types_supported [code], grant_types_supported [authorization_code, refresh_token],
                                               code_challenge_methods_supported [S256], token_endpoint_auth_methods_supported [none, client_secret_post, client_secret_basic]
GET  /.well-known/oauth-protected-resource[/mcp[/<slug>]]  RFC 9728: resource = publicUrl + the path after the prefix ("/mcp" for the root document), so the document the
                                               401 on /mcp/<slug> points at (mcp/routes.ts) names that URL (3.3); authorization_servers [publicUrl], scopes_supported, bearer_methods_supported [header]
POST /oauth/register                           RFC 7591 DCR, anonymous, rate limited (20/h per IP): {redirect_uris (1..10), client_name?, token_endpoint_auth_method? none|client_secret_post|client_secret_basic, grant_types?, client_uri?, logo_uri?}
                                               -> 201 {client_id, client_secret? (once), client_id_issued_at, redirect_uris, ...echo}
                                               redirect_uris must be https://, http://localhost|127.0.0.1|[::1] (any port, any path), or a native host's private-use scheme
                                               (RFC 8252 7.1: cursor://..., vscode://..., com.example.app:/cb; exact match, never javascript:/data:/blob:/file:/vbscript:/about:);
                                               no fragments; 400 invalid_redirect_uri
GET  /oauth/authorize                          ?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&scope?&resource?
                                               validates client + exact redirect_uri match (else 400 page, never redirect), then the rest (PKCE, scope,
                                               resource; else 302 to redirect_uri with error, error_description, state: RFC 6749 4.1.2.1); then 302 to
                                               /consent?<same query> (the SPA; unauthenticated users go /login?next=/consent?...)
POST /oauth/token                              grant_type=authorization_code {code, redirect_uri, client_id, code_verifier} -> {access_token, token_type: Bearer, expires_in: 3600, refresh_token, scope}
                                               grant_type=refresh_token {refresh_token, client_id} -> rotated pair; the old refresh token is revoked; a reused one revokes the whole grant,
                                               except within REFRESH_RACE_MS (60 s) of its rotation while the grant still holds a live refresh token: two refreshes in flight at
                                               access-token expiry (the SDK does not serialize them), so only the late call fails (invalid_grant) and the first one's pair survives
                                               form-encoded or JSON; confidential clients authenticate (client_secret_post or Basic); codes are one-shot and expire in 10 min
                                               limited per client address and per client id (30, then 1/s; 429 rate_limited);
                                               every call first deletes expired rows and rows revoked over 24 h ago (sweepTokens, two indexed range deletes), so a grant holds O(1) rows however often it refreshes,
                                               and anonymous clients past CLIENT_GRACE_MS (7 d) nobody ever consented to (consented_at), with no token and no code (sweepClients, also on every /oauth/register);
                                               a grant revoked by a replayed code or a reused refresh token is audited as oauth.revoke {by: code_replay | reuse};
                                               a spent code revokes only when presented with its PKCE verifier (and by its client): a stranger holding a leaked code is refused, nothing revoked;
                                               a client registered without the refresh_token grant (RFC 7591 grant_types) gets no refresh_token and its refresh requests are 400 unauthorized_client;
                                               a disabled client is 400 invalid_grant here (never 401 invalid_client, on which the MCP SDK discards its client id and re-registers through DCR)
POST /oauth/revoke                             RFC 7009 {token} -> 200 always
```

API endpoints (`oauthApiRoutes`, cookie session only, `requireAccountUser` + `via === 'session'`):

```
GET    /oauth/consent?<authorize query>      -> {client:{id,name,clientUri,logoUri}, scopes:[read|write], groups:[GroupSummary] (readable as the token will act: never admin), redirectHost}
POST   /oauth/consent  {<authorize query fields>, approve: bool, scopes:[...], groups: slug[] | null}  -> {redirect}  (code appended; denial -> error=access_denied;
                                                a group the token could not read, e.g. another user's private one picked by an admin, is 400 unknown_group)
GET    /oauth/grants                         -> {grants:[{grantId, client:{id,name}, scopes, groups:[{id,slug}], createdAt, lastUsedAt, expiresAt}]}
DELETE /oauth/grants/:grantId                -> 204 (revokes access + refresh)
GET    /oauth/clients?limit=&offset= (admin) -> {clients:[{id,name,redirectUris,authMethod,createdAt,disabled,grants:n}], total}  (newest first, 50 a page, max 200)
PATCH  /oauth/clients/:id (admin) {disabled} -> {client}
```

- Tokens: access `scp_at_<43>` (1 h), refresh `scp_rt_<43>` (30 d), stored as sha256 like keys.
  `principalFromOAuthToken` resolves an unexpired, unrevoked access token of an enabled client
  and enabled user to `Principal {via:'oauth', oauthClientId, isAdmin: false, scopes, groupIds}` with
  the same containment rules as API keys (`groupIds` null = every readable group, else the consented
  list; `write` implies `read`). Never admin: an anonymous DCR client must not get instance-wide
  reach from an admin's consent (an admin mints an API key for that). Valid on `/mcp*` only:
  `/api/v1` keeps rejecting them (principalMiddleware is unchanged), so a leaked MCP token cannot
  manage the account. `audit()` adds `detail.oauthClientId` to every event an OAuth principal
  causes, `oauth.token` and `oauth.revoke` included (their actor carries the client id), so
  connected apps stay tellable apart in the logs, and `item_versions.created_by_client` names the
  client a version was written through (`VersionSummary.createdBy.clientId`, shown as "app …" in
  the Versions tab). An admin password reset (`PATCH /users/:id {password}`) revokes every grant of
  the user (`revokeUserGrants`) and pending code along with sessions, keys and the OIDC link (D3);
  disabling a user (`{disabled: true}`) revokes the grants and codes as well (keys stay, refused
  while disabled), so a grant an intruder consented to never returns with the account.
- Token request: `redirect_uri` is optional (OAuth 2.1; PKCE binds the code) and must match when
  sent. A 401 `invalid_client` after HTTP Basic authentication carries `WWW-Authenticate: Basic
  realm="oauth"` (RFC 6749 5.2). DCR `client_uri`/`logo_uri` must be `http(s)` URLs (400
  `invalid_client_metadata`): the consent page links `client_uri`.
- Admin `PATCH /oauth/clients/:id {disabled}` suspends: tokens are refused while disabled, grants
  stay and work again once enabled. `GET /oauth/grants` reports `clientDisabled` per grant. The
  suspension holds for SDK hosts because the token endpoint answers the disabled client with
  `invalid_grant` (the host drops its tokens and re-authorizes with the same client id, which the
  authorize endpoint refuses as "unknown or disabled client_id") rather than `invalid_client` (on
  which the host would discard the client id and register a fresh one through anonymous DCR).
- The client sweep (`sweepClients`) finds its candidates on the partial index `oauth_clients_sweep`
  (`created_at WHERE created_by IS NULL AND consented_at IS NULL`) and its codes subquery on
  `oauth_codes_client`; `oauth_codes_expires` serves `issueCode`'s expiry sweep.
- `resource` (RFC 8707), when sent, must be `publicUrl + '/mcp'` or `publicUrl + '/mcp/<slug>'`
  (400 `invalid_target` otherwise; the slug segment is case-insensitive, like the slug column); it
  is stored on the code and echoed in the token's `aud` claim-equivalent (tokens are opaque;
  `resource` only gates issuance).
- PKCE S256 is mandatory (plain -> 400 `invalid_request`). `state` is echoed verbatim.
- Audit: `oauth.consent`, `oauth.token`, `oauth.revoke`, `oauth.client_register`.
- Consent page (`/consent`): shows client name + redirect host, scope checkboxes (read checked,
  write optional), group restriction (all readable groups, or pick), Approve / Deny. Deny redirects
  with `error=access_denied`. Keys page (`web/src/pages/Keys.tsx`) gets a "Connected apps" list
  with revoke (D2 owns Keys.tsx for this).
- MCP hosts probe: 401 on `/mcp` -> `resource_metadata` -> AS metadata -> DCR -> authorize. Tests
  walk that whole flow with the SDK `Client` + a fake redirect capture, plus: wrong verifier,
  reused code, reused refresh token kills the grant, token on `/api/v1` is 401, disabled client,
  restricted consent cannot see other groups, `redirect_uri` mismatch never redirects.

## D3 OIDC login (`server/src/auth/oidc.ts`, `web/src/pages/Login.tsx` button, tests `server/test/oidc.test.ts`)

```
GET /api/v1/auth/oidc/start?next=/path   -> 302 {issuer authorization_endpoint}?response_type=code&client_id&redirect_uri={publicUrl}/api/v1/auth/oidc/callback&scope=openid email profile&state&nonce&code_challenge(S256)
GET /api/v1/auth/oidc/callback?code&state -> verifies state (signed cookie scp_oidc, 10 min, HttpOnly, SameSite=Lax), exchanges code (client_secret_basic, the discovery default
                                           when token_endpoint_auth_methods_supported is absent; client_secret_post only when the list names it and not basic), validates id_token
                                           (RS256/ES256 via JWKS from discovery, iss, aud, exp, nonce, iat skew 5 min), then: user by (issuer, sub); else by verified email
                                           only when that account has no password (password_hash '!oidc'; links: sets oidc_issuer/oidc_sub). A password account is
                                           never linked from the callback alone: anyone may have registered the address first (pre-hijack). v3 (59b0): it parks
                                           the identity in oidc_pending_links (issuer, sub, email, user id, next, sha256 of a random token; 5 min, single use,
                                           5 attempts), sets the binding cookie scp_oidc_link (HttpOnly, path /api/v1/auth/oidc/link) and 302s to
                                           /login/link?t=<token>, the SPA confirm screen (see link/confirm below). An account linked to another identity stays a
                                           403. Else auto-register when enabled (username from preferred_username|email local part, slugified
                                           to usernameSchema, suffixed -2, -3 on clash; password_hash '!oidc' so password login always fails); else 403 page "no account".
                                           Disabled user -> 403. Success: session cookie exactly like /auth/login, 302 to safeNext(next). Failures render a small HTML error page (no stack).
POST /api/v1/auth/oidc/link {next?}      -> {url}: the same flow for a browser session (401 otherwise), the signed state cookie carrying userId and the session's hash;
                                           the callback links the identity to that account only while that session is still alive (an admin reset deleted it: 403),
                                           and 403 when the identity belongs to another account, or the account to another identity (the message says it may be
                                           this provider under a previous issuer URL). A POST, never a GET: a GET rides the Lax session cookie from any page that
                                           navigates there, and csrfForCookies checks posts only. GET /start ignores link=1. Layout's user menu offers it as
                                           "Link <label>" and follows the returned URL.
GET  /api/v1/auth/oidc/link/pending?t=   -> {email, username} of the parked link's account; 400 bad_link_token when forged, expired, used, out of attempts
                                           or without the matching scp_oidc_link cookie.
POST /api/v1/auth/oidc/link/confirm {token, password}
                                         -> {user, next}: the same token checks, then the login rate limits (keyed on the account's email), one attempt spent
                                           before the scrypt, verifyLogin against that account (wrong or disabled: 401 invalid_credentials); then in one tx:
                                           delete the row (single use), link (only if still unlinked, enabled, same hash and email; a (issuer, sub) held
                                           elsewhere is 403), create the session (auth_method 'oidc'). Audit user.oidc_link {via: "callback-confirm"} and login.
POST /api/v1/auth/oidc/unlink            -> 204: drops the signed-in account's (issuer, sub); 409 not_linked / no_password (an OIDC-only account would become unreachable).
                                           Audit user.oidc_unlink. Works with OIDC unconfigured (the issuer changed). Admins: PATCH /users/:id {oidcUnlink: true}
                                           (409 for a password-less account unless {password} comes along), and a password reset drops the link too; GET /users
                                           reports oidcLinked. /start and /callback take from the login/register per-IP bucket (lib/ratelimit.ts limitIp) before any
                                           outbound call.
```

- `safeNext` parses `next` against `publicUrl` and returns the normalized same-origin path, never
  the raw string: `/\evil.com`, `/\/evil.com` and `/<TAB>/evil.com` resolve to other hosts and
  pass a prefix check (web/src/auth.tsx mirrors it).

- Config: env (`config.oidc`) overrides settings `oidc.*`. `enabled` = issuer + client id present
  (+ secret). Discovery `{issuer}/.well-known/openid-configuration` fetched at first use and cached
  10 min; the `issuer` claim must equal the configured issuer. All outbound calls 10 s timeout. SSRF
  guard on what is fetched (`endpointProblem`, applied in `fetchIdp` and at `/start`): the token
  endpoint and JWKS may be on any public `https://` host (Google: `oauth2.googleapis.com`,
  `www.googleapis.com`; Cognito likewise), not on `http://` or an internal address (loopback,
  private, link-local, via `net.BlockList`) unless the issuer itself is (a local/test IdP). The
  authorization endpoint is a browser redirect: http(s) scheme only.
- `oidcPublicConfig(ctx)` -> `{enabled, label}`; `GET /auth/config` already spreads it as `oidc`.
  Login page: when `config.oidc?.enabled`, a "Continue with <label>" button linking to
  `/api/v1/auth/oidc/start?next=<next>` under the password form.
- Admin PATCH `/users/:id {password}` on an OIDC-only user is allowed (sets a password). v3 (0nhr): the
  user sets a break-glass one themselves with `POST /auth/password {next}` and no `current`, accepted only
  while the hash is `'!oidc'` and the session is an SSO one (`sessions.auth_method = 'oidc'`, set by the
  callback) created in the last 10 minutes; else 400 `reauth_required`. Same CAS update and session
  ending as a normal change; audit `user.password {via: "oidc-set"}`. `/auth/me` gains `hasPassword`.
- README: an "OIDC" section (return it in the chunk report; D0 already added the env rows).
  docker-compose already passes the variables.
- Tests: a local `node:http` fake IdP (discovery, jwks with a generated RSA key, token endpoint
  minting id_tokens) covering: happy path new user, link by email, existing sub, nonce mismatch,
  bad signature, expired, wrong aud, state mismatch, auto_register off -> 403, disabled user,
  settings-based config vs env override, `start` 404 when not configured.

## D4 admin tools + blob GC (`server/src/admin/routes.ts`, `server/src/items/gc.ts`, `web/src/pages/AdminSettings.tsx`, `web/src/pages/AdminLogs.tsx`, `web/src/api-admin.ts`, `web/src/components/Layout.tsx` nav, `server/src/auth/routes.ts` users PATCH, tests `server/test/admin.test.ts`)

```
GET  /admin/settings      -> {oidc:{issuer, clientId, clientSecretSet, autoRegister, label, source:'env'|'settings'|'none', envFields:[field]}, github:{tokenSet, source}, registration:{enabled, source:'env'}, storage:{blobs, blobBytes, orphanBlobs, orphanBytes, items, versions, users, groups}}
                             envFields lists the oidc fields the environment sets (read-only, per field); source is 'env' only when an IdP value (issuer, clientId, clientSecret) comes from it
PUT  /admin/settings      {oidc?:{issuer?, clientId?, clientSecret?, autoRegister?, label?}, github?:{token?}}  -> same as GET. '' clears a value; omitted keeps; env-set fields are read-only (400 env_managed)
POST /admin/gc            -> {deletedBlobs, freedBytes}
GET  /audit?all=1&limit=&before=<id>&user=<username>&action=<prefix>&q=<text in target_id/detail>   (extend audit.ts; admin only for all=1; non-admin filters apply to own events)
PATCH /users/:id          {username?, email?} join the existing {isAdmin?, disabled?, password?} (409 on clash; audit user.update)
```

- Blob GC (`items/gc.ts`): `sweepBlobs(db)` deletes `blobs` rows with no `version_files` reference
  (index from migration 4); `deleteItem` in `items/service.ts` and `DELETE /users/:id` call it for
  the deleted versions' hashes inside their transaction (targeted: `WHERE sha256 IN (...) AND NOT
  EXISTS (...)`), and `main.ts` runs a full sweep at boot. Admin button runs it on demand.
- Admin UI: `/admin/settings` (OIDC form with "secret set" indicator, GitHub token, storage stats +
  "Sweep orphan blobs", OAuth clients table from D2's `GET /oauth/clients` with disable toggles;
  degrade gracefully when that endpoint 404s), `/admin/logs` (all users' audit with filters: user,
  action prefix, text, load more), `/admin/users` gains inline edit of username/email. Layout nav:
  the single "Admin" entry becomes three entries under an "Admin" heading (users, logs, settings).
- Tests: settings round trip, env override read-only, secret never echoed, GC deletes orphans
  only (a blob shared by two versions survives one delete), boot sweep, audit filters + paging,
  users PATCH username/email + clash, all endpoints 403 for non-admins and for restricted keys.

## D5 nested groups, marketplace, install-as (`server/src/groups/*`, `server/src/access.ts`, `web/src/pages/GroupDetail.tsx`, `web/src/api-groups.ts`, tests `server/test/includes.test.ts`, `server/test/marketplace.test.ts`)

Nested groups:
```
PUT    /groups/:slug/includes   {includes: slug[]}   -> {group}   (replace, ordered)
POST   /groups/:slug/includes   {slug}               -> 201 {group}
DELETE /groups/:slug/includes/:included              -> {group}
GroupDetail gains includes:[{slug, name, owner:{username}, memberCount, flowing}], includedBy:[{slug,name}] (readable includers whose edge flows),
and members[] gains via: null | slug (the group holding the member's row, at any depth: a grandchild's via names a group that is not a direct
include; the UI links via only when it names an includes[] row with a name). Readers get flowing includes only; editors get every row, but one whose
child they cannot read carries slug and flowing alone (name '', owner '', memberCount 0): flowing:false for an editor's stale edge, flowing:true for
a reader's row whose child they cannot open (the owner's private group under their public one), as its members' via say.
The manifest reports bundle: {ok, problem, code} and plugin: {ok, problem, code} (code: group_full | bundle_too_large | path_conflict), the very
refusal bundle.zip / plugin.zip would answer, so the group page gates both downloads and says why.
GET /groups?owner=others lists other users' readable groups (the dashboard's "Shared with you"), never buried under the caller's own.
```
- Effective members of G = G's own members, then each included group's effective members in
  position order, depth at most 4 (400 `include_too_deep`), transitive, first occurrence of an
  item wins, and a member's `pinnedSeq`/`installAs` are the ones on the edge it came through.
  Cycles are 409 `include_cycle` (direct or transitive). A group may include only groups its
  owner could publish: their own, or public ones (400 `include_not_shareable`), the v1
  `item_not_shareable` rule applied to groups; a group shared with the owner by name is readable
  but not republishable, or a share recipient could make a public group out of another user's
  private items. At read time an included group flows only while that still holds (own, or public
  with its owner enabled: `includeVouchSql`), each child's items still filtered by that child's
  `publishedSql`. Effective size obeys `MAX_MEMBERS` / `MAX_GROUP_FILES`, plus `MAX_INCLUDES` (50
  direct includes per group), `MAX_INCLUDED_BY` (50 other users' groups including one group, 400
  `include_too_many`; the child's owner is never refused by it, or 50 strangers' hubs over a public
  group would lock its owner out of including it) and `MAX_EFFECTIVE_GROUPS` (100 groups in one
  effective set, 400 `include_too_many`): every listing walks each listed group's include DAG, and
  `itemReadSql` walks upward from every item row on every other user's listing, so an unbounded one
  is a per-request amplifier. The upward CTE also stops after `MAX_UP_ROWS` (1000) rows (SQLite
  LIMIT on the recursive select), a backstop for a DAG grown past the caps (and for the owner's own
  uncapped fan-in). The depth check counts the owner's own groups only, above and below the edited
  group (another user's private chain stacked on a public group cannot block its owner, and a
  stranger's public group deepened after the owner included it cannot fail the owner's next write;
  reads truncate at depth 4 regardless). `MAX_MEMBERS` across the effective set counts the owner's
  own groups' rows only (`ownRows`): a stranger's public subtree grown past it is theirs to trim,
  reads still serve it (place() caps files alone). Member and include writes check the edited group
  and every group of the same owner that includes it (`assertAncestorsFit`): growing a child cannot
  push the owner's hub past `MAX_EFFECTIVE_GROUPS` / `MAX_MEMBERS` / `MAX_GROUP_FILES`, where
  `effectiveGroups` would silently truncate what it serves while `itemReadSql` still grants it, or
  place() would answer group_full for the hub's every download. Another owner's hub including a
  public group is not checked (refusing bob's edit over alice's hub would let anyone block a public
  group's owner); it truncates on read and its owner trims an include. Path conflicts across the
  effective set are 409 on include add when they involve an item the include newly serves; a lint
  already between the parent's own members stays a manifest lint, also when the child serves one of
  those items too. `PUT /includes` keeps a slug that is already an edge without re-checking
  readability or shareability (a child gone private stays reorderable and removable), and runs the
  depth, size and conflict checks only when the list has a new edge: a reorder or a trim is never
  refused. `listOwnGroups` (the marketplace and the /mcp group list) counts a share row only while
  the group is 'shared', as `groupReadableByUserSql` does for reading. `groups/touch.ts` walks up
  the includes, so a change inside an included group bumps every including group's `updated_at`;
  it also runs for everything that shrinks what a group serves (an item deleted or made private,
  for the groups holding it; a group deleted or made private, for the groups including it), so
  the plugin version (D5 marketplace) never stays put while the zip changes.
- `resolvedMembers(db, p, group)` returns the effective list (so MCP, manifest, bundle, catalog
  and `groupDetail` compose for free). `access.ts itemReadSql` must treat "member of a readable
  group" as effective membership (reading a group grants read of everything it serves), via a
  recursive CTE helper exported from `groups/service.ts` (keep the depth cap in SQL too).
- UI: GroupDetail "Included groups" section (search readable groups, add, remove, reorder) and
  members show "via <slug>" and cannot be edited there.

Marketplace (`groups/marketplace.ts`, app root, token in path, no cookies):
```
GET /m/:token/marketplace.json     -> Claude Code marketplace: name "scp-<username>", owner {name: username}, plugins: one per group of the key's owner, shared with
                                      them by name, or picked for a restricted key (listOwnGroups, like the /mcp instructions; strangers' public groups are attacker-sized
                                      and are not listed, so `claude plugin install <slug>@...` cannot find them: they are downloaded as plugin.zip by slug instead),
                                      {name: slug, description, version: "<yyyymmdd>.<hhmmssmmm>" UTC of the latest change (member version or group row, which touch()
                                      bumps for every including group too), source: {source:'archive', url: '<publicUrl>/m/<token>/<slug>/plugin.zip'}}. No sha256 pin
                                      (optional in the format): nothing is zipped to list; a group whose plugin would be refused (over MAX_GROUP_FILES files, over 100 MB,
                                      two members at one plugin path: same kind and pathKey-equal name, the folder being the unit) is left out. `pluginProblem(members, files)` is
                                      that one check: buildPlugin throws exactly it, and the manifest reports it as plugin: {ok, problem, code} so the group page can say why;
                                      the files count comes from the same per-group statement (pluginMembers), so manifest, bundle, plugin.zip and the listing refuse together
GET /m/:token/:slug/plugin.zip     -> plugin layout: .claude-plugin/plugin.json {name, version, description}, skills/<name>/..., agents/<name>.md, commands/<name>.md,
                                      .mcp.json {mcpServers: {scp-<slug>: {type:'http', url:'<publicUrl>/mcp/<slug>', headers:{Authorization:'Bearer <token>'}}}},
                                      other kinds under docs/<kind>/<name>/... ; deterministic bytes (fixed mtime 1980-01-01 in buildZip's caller), so sha256 is stable per effective tree
```
- `:token` resolves through `principalFromKey` (read scope); unknown -> 404. The response of
  `marketplace.json` is `no-store`. The listing reads its members in one statement per effective
  group (`pluginMembers`: kind, name, total_bytes, created_at at the pinned or latest version), never
  a version row per member. `/m/:token/*` is limited per key (100, then 1/s; 429 `rate_limited`):
  the key is in the URL. plugin.zip builds are cached per effective tree (Map bounded to
  200 entries and 256 MB of zip bytes). README: how to `claude plugin marketplace add
  <url>` and the HTTPS caveat (archive URLs must be https, not loopback), from `docs/research/formats.md` 3.
- `GET /groups/:slug/plugin.zip` (cookie or key) serves the same zip for manual installs.

Install-as (f1y7): in GroupDetail's "Add items" results, when `addMember` fails with 409
`path_conflict`, show the conflict message inline with an "Install as" input and a retry that
sends `installAs`. Kinds that cannot take `installAs` (not in `INSTALL_AS_KINDS`) show the
conflict only.

## D6 UI: import flows, source panel, dashboard (`web/src/components/ImportDialog.tsx`, `web/src/pages/ItemDetail.tsx`, `web/src/pages/Dashboard.tsx`, `web/src/api-import.ts`)

- ImportDialog gets three tabs: File (as today), Zip pack (file + visibility + optional "also
  create group <slug>"), GitHub (URL or owner/repo + ref + path, kind override, visibility,
  optional group). Pack/GitHub results: when nothing was skipped, go to the created group, else to
  the one item; otherwise show the list with links, the group link when one was created, and the
  `skipped` reasons (they are never discarded by a navigation).
- v3 p2wf: the group field is "Group: none / new / existing" (existing: a picker of the user's own
  groups, `listGroups({owner: 'me'})`); `ImportDialog` takes `intoGroup` to preselect one, and
  GroupDetail's "Import into this group" (editors) opens it so, Zip pack and GitHub tabs only.
- v3 jwz6: the GitHub kind option reads "Import items in folder as one type" ("No, detect each
  item's type" / "Yes, all as {k}"), help text saying single-file kinds split per file and
  skill/design/package keep the folder whole.
- v3 mvfp: the result screen lists `skippedFolders` with a kind select each; "Import selected"
  re-runs the same request (the zip `File` kept, or the same repo/ref/path) with the accumulated
  `folderKinds`, and with `intoGroup` set to a group the first run created.
- ItemDetail: a "Source" panel when `item.source` is set: kind, repo link
  (`https://github.com/<repo>/tree/<commit>/<path>`), ref, pinned commit (7 chars, full in
  title), and for GitHub sources a "Check for updates" button -> result line (up to date / new
  commit <7sha>) -> "Update to latest" that calls `source/update` and reloads; 409 `up_to_date`
  shows as "already up to date".
- Dashboard: "Your groups" stays; add "Shared with you" (other users' readable groups, from
  `listGroups({owner: 'others'})`: its own query, since the own-first readable page would bury
  them under 200 own groups), each with owner and plane counts; empty state text.
- No server changes. Run against D1's contract above; where an endpoint is not merged yet, the
  UI must show the API error, never crash.

## D7 UI second pass (after merge; browser agent)

Look at MCPHub's groups and settings pages for inspiration (the user's instance at
`https://mcphub.oracle.zoph.net/groups` if reachable, else docs.mcphub.app screenshots) and tighten
SCP's layout: consistent page headers, tables for lists, clearer empty states, admin section
grouping, mobile nav. No new features; CSS and markup only; `npm run gate` stays green.

## D8 by hand

- sfxv: run `claude -p` with an MCP config pointing at the container's `/mcp/<group>` and ask it
  to call `get_skill`; record whether the text or `structuredContent` was what the model saw;
  keep or drop the duplicate accordingly.
- v107: `docs/research/semantic-search.md` evaluation; close the ticket with the conclusion.

## Rules for chunk agents

- Start with `git merge --ff-only feat/scp-v2` in the worktree (worktrees branch from a stale
  trunk). Never touch another chunk's files; D0 files only where this plan says so.
- Tests in the same commit, `npm run gate` green before the commit, commit message
  `D<n>: <summary>` ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never `git add -A`; stage explicit paths. No heredocs (write files with the Write tool).
- No new npm dependencies (OAuth, OIDC, JWKS, zip all fit node:crypto, fflate, zod, hono).
- Don't edit `README.md`, `docs/PLAN.md`, `web/src/api.ts`, `web/src/styles.css` (append-only
  CSS to a new `web/src/styles-<chunk>.css` imported by your page is fine). Return the README
  text your feature needs in your report.
