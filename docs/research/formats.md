# SCP content formats: skills, MD documents, catalogs

Research for SCP (Skill / MD / Artifact control plane). Scope: the on-disk
formats SCP stores and serves, so an agent can pull an item and drop it into
place byte-for-byte. Researched 2026-10-20.

Sources (all fetched for this note):

- Agent Skills open spec: https://agentskills.io/specification
- Anthropic Skills overview: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Claude Code skills reference: https://code.claude.com/docs/en/skills
- Claude Code subagents reference: https://code.claude.com/docs/en/sub-agents
- Skills API guide: https://platform.claude.com/docs/en/build-with-claude/skills-guide
- anthropics/skills repo: https://github.com/anthropics/skills (`.claude-plugin/marketplace.json`, `skills/skill-creator/scripts/package_skill.py`, `quick_validate.py`, read via `gh api`)
- Plugin marketplaces: https://code.claude.com/docs/en/plugin-marketplaces and https://code.claude.com/docs/en/plugins/marketplace-reference
- AGENTS.md: https://agents.md
- DESIGN.md: https://github.com/google-labs-code/design.md
- AIBootstrap rosters: https://github.com/zacgoodwin/AIBootstrap/tree/b8ea30ba3efa44abb9940847aeec79ef82ad14cd/docs/agents (local clone `C:/Users/zacgo/GitHub/AIBootstrap/docs/agents`)
- Local machine roster: `C:/Users/zacgo/GitHub/AGENTS.md`
- Local on-disk samples: `C:/Users/zacgo/GitHub/AIBootstrap/.claude/agents/*.md`, `C:/Users/zacgo/.claude/skills/*`, `C:/Users/zacgo/.claude/plugins/cache/*`

---

## 1. Agent definitions and rosters (AIBootstrap + local machine)

### 1.1 Files in `AIBootstrap/docs/agents/`

7 files, all Markdown catalogs (no agent definitions live here; definitions
live in `.claude/agents/`):

| File | Role |
|---|---|
| `README.md` | Index: "Packs that ship agents" table (pack, count, file, shape), "Packs that ship no agents" table, refresh procedure with upstream commit SHAs per pack, count-check command |
| `IN-REPO-AGENTS.md` | Deduplicated roster of every agent reachable on the author's machine (53 rows, categorized) |
| `ECC.md` | affaan-m/ECC roster, 73 agents, extra `On disk` column (`library` / `active` / `—`) |
| `HAN.MD` | TheBushidoCollective/han roster, 72 agents |
| `GSD.MD` | open-gsd/gsd-core roster, 35 agents; adds a `Design & UI` category |
| `TRAILOFBITS.MD` | trailofbits/skills roster, 29 agents |
| `CODEMYSPEC.MD` | Code-My-Spec/plugins roster, 5 agents |

Note the mixed extension casing (`.md` vs `.MD`). SCP must treat filenames
case-preserving and match `SKILL.md`/`AGENTS.md` case-insensitively only on
import, never rename on export.

`C:/Users/zacgo/GitHub/AGENTS.md` is the same roster format, regenerated
with 57 agents and an extra `Job Search` category. It is a *catalog named
AGENTS.md*, not an agents.md-standard instruction file. SCP must not infer
kind from filename alone; a file called `AGENTS.md` can be either.

### 1.2 Roster (catalog) format

Each roster file is:

```markdown
# <Pack> agents

<provenance paragraph: upstream repo link, count, upstream short SHA + date, check date>

Execution: `subagent_type=<name>` via the Agent tool, or ask Claude to "use the `<name>` agent".

## <Category>

| Execution | Source (origin) | What it does |
|---|---|---|
| Agent subagent_type=`architect` | affaan-m/ECC | Software architecture specialist ... |
```

Observed properties:

- Category taxonomy (shared across files): Plan & Architecture, Code Review,
  Build Test & QA, Docs & Research, Agent Harness, Open-source Pipeline,
  Product & Review Panel, Business Personas, Domain Specialists. Packs may add
  categories (GSD adds Design & UI; machine roster adds Job Search) and must
  say so at the top. -> SCP: `category` is a free string with a seeded list,
  not an enum.
- Column variants: `Source (origin)` (machine roster), `On disk` (ECC), none
  (GSD). "Source" means **upstream provenance** (`owner/repo`), not the local
  path.
- Descriptions in the machine roster are truncated mid-word at ~180 chars
  (`...build order` -> `...and buil`). SCP must store full descriptions and
  truncate only in display.
- Integrity check is a row count: `grep -c '^| Agent subagent_type=' docs/agents/*`
  must equal the stated count. -> SCP can generate these rosters from the DB
  (`GET /groups/{slug}/catalog.md`) and the count is then true by construction.
- Refresh is tracked by upstream commit SHA per pack (README table:
  `affaan-m/ECC | d8409a4 (2026-08-19)`). -> SCP item provenance needs
  `source_repo`, `source_ref` (sha), `source_path`, `imported_at`.

### 1.3 Agent definition file format (Claude Code subagent)

Path: `.claude/agents/<name>.md` (project) or `~/.claude/agents/<name>.md`
(user). Single file, YAML frontmatter + Markdown body = system prompt.

Real samples (AIBootstrap `.claude/agents/`, 14 files, all CRLF):

```markdown
---
name: product
description: Turn fuzzy ideas into scoped user stories with acceptance criteria; prioritization; scope cuts. Use for "should we build", "write a ticket for", "scope this", "prioritize the backlog".
tools: Read, Grep, Glob, WebSearch, WebFetch, Bash
model: sonnet
---

You are the product manager. ...
```

```markdown
---
name: skeptic
description: >-
  Devil's advocate on a proposal: problem validity, alternatives, failure
  modes, opportunity cost, scope creep. Use for "stress-test this", ...
tools: Read, Grep, Glob
model: sonnet
---
```

Observed variation SCP's parser must accept: `tools` as comma string,
`description` as plain or folded block scalar (`>-`), CRLF line endings,
UTF-8 with non-ASCII. Bodies range from 20 lines to several hundred
(`typescript-reviewer.md` opens with a "Prompt Defense Baseline" section).

Full frontmatter field set (Claude Code, code.claude.com/docs/en/sub-agents).
camelCase, unknown keys silently ignored:

| Field | Req | Values / semantics |
|---|---|---|
| `name` | yes | <=256 chars, must not start with `-`, must not contain `:` (reserved for plugin scoping). Filename need not match |
| `description` | yes | When to delegate. Short (consumes context) |
| `tools` | no | Allowlist; comma string or YAML list; MCP wildcards `mcp__github__*`. Omitted = inherit all |
| `disallowedTools` | no | Denylist, same format, applied first |
| `model` | no | `sonnet`, `opus`, `haiku`, `fable`, full model id, or `inherit` |
| `permissionMode` | no | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, `manual` |
| `maxTurns` | no | int |
| `autoCompactWindow` | no | int 100000..1000000 |
| `skills` | no | Skill names to preload in full, up to 32 |
| `mcpServers` | no | List of server-name strings or inline `{name: {type, command, args}}` |
| `hooks` | no | `PreToolUse`, `PostToolUse`, `Stop`, ... |
| `memory` | no | `user` / `project` / `local` |
| `background` | no | bool |
| `omitClaudeMd` | no | bool |
| `effort` | no | `low`..`max` |
| `isolation` | no | `worktree` |
| `color` | no | `red blue green yellow purple orange pink cyan` |
| `initialPrompt` | no | string |
| `experimental` | no | map, only `cacheTtl` read |

Silent-skip conditions (Claude Code ignores the file, no error): no `name`;
opening `---` not on line 1; `name` starts with `-` / contains `:` / >256;
`name` without `description`; unparseable YAML. -> SCP validation must flag
exactly these as errors on upload, since the client will not.

Precedence: managed > `--agents` CLI JSON > `.claude/agents/` > `~/.claude/agents/`
> plugin `agents/`. Subfolders are scanned recursively; path does not affect
identity. Plugin agents get `plugin:sub:name` scoping and ignore `hooks`,
`mcpServers`, `permissionMode`.

`--agents` JSON shape (useful as SCP's JSON rendering of an agent, for
orchestrators that spawn without writing files):

```json
{ "code-reviewer": { "description": "...", "prompt": "<body>", "tools": ["Read","Grep"], "model": "sonnet" } }
```

i.e. `prompt` = Markdown body, every other frontmatter key passes through
(`color`, `experimental` ignored).

---

## 2. Agent Skills (SKILL.md)

### 2.1 Directory layout (agentskills.io spec)

```
skill-name/
├── SKILL.md          # required: YAML frontmatter + Markdown body
├── scripts/          # optional: executable code
├── references/       # optional: docs loaded on demand
├── assets/           # optional: templates, images, data
└── ...               # any other files/dirs are allowed
```

Verified on disk. Real skills carry far more than the three conventional dirs:

| Skill | Files |
|---|---|
| `~/.claude/skills/zg-verify-claims/` | `SKILL.md README.md CHANGELOG.md VERSION bin/verify-claims.mjs tests/gate.sh` |
| `~/.claude/skills/stack-ship/` | `SKILL.md README.md CHANGELOG.md VERSION .gitignore setup check-pipeline.sh tests/gate.sh` |
| `~/.claude/skills/careful/` | `SKILL.md bin/check-careful.sh bin/hook-extract.sh` |
| `~/.claude/skills/loose-ends/` | `SKILL.md README.md CHANGELOG.md package.json` |
| `anthropics/skills/skills/pdf/` | `SKILL.md LICENSE.txt forms.md reference.md scripts/` |
| `anthropics/skills/skills/mcp-builder/` | `SKILL.md LICENSE.txt reference/ scripts/` |
| plugin `elixir-phoenix/3.0.1/skills/audit/` | `SKILL.md references/` |

-> SCP stores a skill as an **arbitrary file tree** with `SKILL.md` at the
root. Do not model `scripts/references/assets` as fixed slots. Preserve dot
files (`.gitignore`), extensionless executables (`setup`), and the executable
bit (scripts are run directly, e.g. `check-pipeline.sh`).

### 2.2 Frontmatter: portable core (agentskills.io + Anthropic)

| Field | Req | Constraint |
|---|---|---|
| `name` | yes | 1-64 chars, `[a-z0-9-]`, no leading/trailing `-`, no `--`, **must match parent directory name**. Anthropic adds: no XML tags, must not contain `anthropic` or `claude` |
| `description` | yes | 1-1024 chars, non-empty, no XML tags (`quick_validate.py` rejects any `<` or `>`). Must say what + when |
| `license` | no | Short name or bundled-file reference, e.g. `Proprietary. LICENSE.txt has complete terms` |
| `compatibility` | no | 1-500 chars |
| `metadata` | no | map string->string (e.g. `author`, `version: "1.0"`) |
| `allowed-tools` | no | Spec: space-separated string, experimental (`Bash(git:*) Read`) |

Validation regex: `^[a-z0-9]+(-[a-z0-9]+)*$`, length <= 64.

Strict portable set: `quick_validate.py` (anthropics/skills) has
`ALLOWED_PROPERTIES = {'name','description','license','allowed-tools','metadata','compatibility'}`.
Claude Code docs confirm: claude.ai uploads, the Skills API, and
`package_skill.py` **hard-error** on any other key.

### 2.3 Frontmatter: Claude Code extensions

All optional in Claude Code; `name` defaults to dir name, `description`
falls back to first body line. Unknown keys silently ignored.

| Field | Semantics |
|---|---|
| `when_to_use` | Appended to description, shares the cap |
| `argument-hint` | Autocomplete hint `[issue-number]` |
| `arguments` | Named positional args for `$name` substitution |
| `disable-model-invocation` | `true` = only user can invoke (`/name`); blocks subagent preload |
| `user-invocable` | `false` = hidden from `/` menu |
| `allowed-tools` | string (space/comma) or YAML list |
| `disallowed-tools` | removed while active |
| `model`, `effort` | per-turn overrides |
| `context: fork`, `agent`, `background` | run in subagent |
| `hooks` | registered on invocation |
| `paths` | globs gating auto-load |
| `shell` | `bash` / `powershell` for `` !`cmd` `` injection |
| `metadata`, `license`, `compatibility` | accepted, not acted on |

Observed third-party keys in local skills (not in either spec, must be
preserved and tolerated): `version`, `triggers` (list), `preamble-tier`
(gstack), `effort` (oliver-kriska), `allowed-tools` as YAML list (gstack).
`careful/SKILL.md` puts a full `hooks:` tree in frontmatter.

Body substitutions Claude Code expands: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`,
`$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`,
`${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`.
`` !`cmd` `` and ```` ```! ```` blocks run shell before Claude sees the skill.

Portability hazard seen locally: `careful` hooks call
`bash $HOME/.claude/skills/gstack/careful/bin/check-careful.sh`, a hard-coded
install path. A copy installed anywhere else silently breaks. -> SCP lint
rule: warn on literal `~/.claude/skills/` or `$HOME/.claude/` in a skill;
suggest `${CLAUDE_SKILL_DIR}`.

Security surface SCP should flag at upload (it serves these to autonomous
agents): `` !`...` `` injection, `hooks`, `allowed-tools` containing
`Bash(*)`/unscoped `Bash`, `context: fork` + `permissionMode`, and any file
with exec bit. Anthropic: "Treat like installing software."

### 2.4 Progressive disclosure and size budgets

| Level | Loaded | Budget |
|---|---|---|
| 1 Metadata (`name` + `description`) | always, at startup | ~100 tokens/skill |
| 2 SKILL.md body | on trigger | < 5k tokens; < 500 lines recommended |
| 3 Bundled files | on read / script output only | no context cost until used |

Claude Code: `description` + `when_to_use` truncated at **1,536 chars** in
listing; post-compaction re-attach keeps first 5,000 tokens per skill, 25,000
total. File references should be relative and one level deep from SKILL.md.

-> This maps 1:1 onto a control-plane API (the bytebridge "skills via MCP"
pattern): `list` returns level 1 only, `get` returns SKILL.md, `get_file`
returns level 3 on demand. SCP should compute and store `body_tokens_est`
and `line_count` and warn past 500 lines / 5k tokens.

### 2.5 Install locations (Claude Code)

| Scope | Path |
|---|---|
| Personal | `~/.claude/skills/<name>/SKILL.md` |
| Project | `.claude/skills/<name>/SKILL.md` |
| Nested | `<subdir>/.claude/skills/<name>/SKILL.md` (addressed `/subdir:name`) |
| Plugin | `<plugin>/skills/<name>/SKILL.md` (namespaced `/plugin:name`) |
| claude.ai sync | `~/.claude/skills/synced/` (read-only) |

Enterprise > personal > project on name collision. Edits hot-reload.
Folder names starting `anthropic-skills` are reserved. Names with
zero-width/control/bidi chars or `<`/`>` are refused.

Other surfaces: claude.ai = zip upload in Settings > Features, per-user.
Skills API = workspace-wide, files land at `/skills/{name}/` in the container.

### 2.6 Packaging: the zip shapes that exist today

1. **Anthropic `.skill` file** (`package_skill.py`): a ZIP_DEFLATED zip named
   `<name>.skill`; `arcname = file.relative_to(skill_path.parent)`, so entries
   are `<name>/SKILL.md`, `<name>/scripts/x.py` (one top-level folder).
   Excludes: dirs `__pycache__`, `node_modules` anywhere; `evals/` at skill
   root only; files `.DS_Store`, `*.pyc`.
2. **claude.ai upload**: zip, same shape.
3. **Skills API** (`POST /v1/skills`, `POST /v1/skills/{id}/versions`):
   multipart `files[]`, each part's `filename` is its path (`my_skill/SKILL.md`);
   zip also accepted; `SKILL.md` at root or under one enclosing folder;
   **< 30 MB uncompressed**. Each version is a full snapshot, not a delta;
   `name` must stay the same across versions. Optional `display_name` <= 255.
   Request-time `container.skills: [{type: "custom", skill_id, version}]`,
   max 20 skills/request; versions `skver_...` or `latest`.
4. **Claude Code plugin archive** (marketplace `archive` source): zip over
   HTTPS, plugin root at top or one dir down, optional `sha256` pin.

-> SCP canonical skill zip = shape 1 (`<name>/...` single top folder, same
excludes, <= 30 MB uncompressed). One artifact then works for claude.ai
upload, Skills API, and `unzip -d .claude/skills/`.

---

## 3. Plugins and marketplaces (distribution format for a GROUP)

This is the closest existing standard to "an agent pulls a group". Verified
in `~/.claude/plugins/cache/` and anthropics/skills.

`plugin.json` (at `<plugin>/.claude-plugin/plugin.json`), real example:

```json
{ "name": "ecto", "version": "3.0.1",
  "description": "Compatibility namespace ...",
  "author": { "name": "Oliver Kriska" },
  "homepage": "https://github.com/oliver-kriska/claude-elixir-phoenix",
  "repository": "https://github.com/oliver-kriska/claude-elixir-phoenix" }
```

Default component dirs: `skills/<name>/SKILL.md`, `agents/*.md`,
`commands/*.md`, `hooks/hooks.json`, `.mcp.json`.

`marketplace.json` (at `<root>/.claude-plugin/marketplace.json`),
anthropics/skills real excerpt:

```json
{ "name": "anthropic-agent-skills",
  "owner": { "name": "Keith Lazuka", "email": "klazuka@anthropic.com" },
  "metadata": { "description": "Anthropic example skills", "version": "1.0.0" },
  "plugins": [
    { "name": "document-skills", "description": "...", "source": "./", "strict": false,
      "skills": ["./skills/xlsx", "./skills/docx", "./skills/pptx", "./skills/pdf"] } ] }
```

Required: `name`, `owner.name`, `plugins[]` with `name` + `source`. Entry
extras: `description`, `version`, `category`, `tags`, `strict`,
`dependencies`, `displayName`, `metadata`, `headers`, `headersHelper`,
`skills`, `agents`, `commands`, `hooks`. Names: letters, digits, `.`, `_`,
`-`, start alphanumeric, no `..`; Claude Desktop caps at 128 chars. Many
reserved marketplace names (`agent-skills`, `anthropic-*`, `claude-plugins-*`,
`claudeai-*` prefix, `npm`, `github`, JS object member names, any non-ASCII).

Plugin `source` types: relative `./path`, `github {repo, ref, sha}`,
`url {url, ref, sha}` (git), `git-subdir {url, path}`, `npm {package, version, registry}`,
**`archive {url, sha256}`** (zip over HTTPS, Claude Code >= 2.1.224),
`command`.

Marketplace sources: `claude plugin marketplace add <https-url>` that is not a
git form creates a **`url` marketplace source** = direct link to a
`marketplace.json`, with optional `headers` / `headersHelper` for auth. With
a `url` source Claude Code fetches only that file, so **relative plugin
sources cannot resolve; entries must use object sources** (e.g. `archive`).

Constraint: `archive.url` must be `https://` and must not be loopback,
link-local, or cloud-metadata. A docker-compose SCP on `http://localhost:8080`
**cannot** serve installable archives; it needs a real HTTPS hostname
(reverse proxy, e.g. Caddy). Plan a non-plugin fallback (plain zip + install
script) for local use.

-> SCP mapping: SCP instance (or one user's token-scoped view) =
marketplace; GROUP = plugin entry with `source: {source: "archive", url:
".../groups/<slug>/plugin.zip", sha256}` and `headers: {Authorization:
"Bearer <token>"}`. User runs `claude plugin marketplace add
https://scp.example.com/m/marketplace.json` then
`claude plugin install <group>@<marketplace>`. Skills become
`/<group>:<skill>`, agents `<group>:<agent>`.

---

## 4. AGENTS.md (agents.md standard)

- File `AGENTS.md` at repo root; nested `AGENTS.md` per subproject; **closest
  file to the edited file wins**; explicit chat instructions override.
- No required fields, no frontmatter, plain Markdown, any headings.
- Recommended sections: project overview, build and test commands, code
  style, testing instructions, security considerations; also PR/commit
  guidelines, deployment steps.
- Read by Codex, Jules, Factory, Aider (`read: AGENTS.md` in
  `.aider.conf.yml`), goose, opencode, Zed, Warp, VS Code, Devin, Junie, Amp,
  Cursor, RooCode, Gemini CLI (context file name in `.gemini/settings.json`),
  Kilo Code, Copilot coding agent, Windsurf, Augment, and others.
- Legacy migration: rename to `AGENTS.md`, symlink the old name.

Example from the spec:

```markdown
# AGENTS.md

## Setup commands
- Install dependencies: `npm install`

## Code style
- TypeScript strict mode

## Testing
- Run `npm test` before committing
```

Sibling instruction files of the same kind (plain Markdown, path-scoped,
no frontmatter required): `CLAUDE.md` (Claude Code; supports `@path` imports,
e.g. `@RTK.md` in the user's global CLAUDE.md), `GEMINI.md`,
`.github/copilot-instructions.md`. ponytail's plugin cache ships an
`AGENTS.md` beside `.cursor/`, `.windsurf/`, `.kiro/`, `.clinerules/`,
`.opencode/` variants of the same rules, which shows the real-world need:
**one logical instruction document, many target filenames**.

-> SCP kind `instructions`: body only; `target_path` default `AGENTS.md`;
export aliases (`CLAUDE.md`, `GEMINI.md`) chosen at install time, not stored
as copies. Never generate frontmatter for this kind (clients would render it
as text). SCP metadata lives in DB columns, not in the file.

---

## 5. DESIGN.md (google-labs-code/design.md, status: alpha)

Markdown with optional YAML frontmatter holding machine-readable tokens;
body holds rationale. Apache-2.0.

Frontmatter schema:

```yaml
version: <string>          # optional, current "alpha"
name: <string>
description: <string>      # optional
omitted: <string[] | OmittedSection[]>
colors:      { <token>: <Color> }               # any CSS color: "#1A1C1E", "oklch(62% 0.18 250)"
typography:  { <token>: { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, fontFeature, fontVariation } }
rounded:     { <level>: <Dimension> }           # 4px, 0.5rem
spacing:     { <level>: <Dimension | number> }
components:  { <component>: { backgroundColor, textColor, typography, rounded, padding, size, height, width } }
```

Token references: `"{colors.primary}"`, `"{rounded.sm}"`. Variants are
separate component keys (`button-primary-hover`).

Body `##` sections, fixed order (any may be omitted, present ones must stay
in order; duplicates are errors): 1 Overview (alias Brand & Style),
2 Colors, 3 Typography, 4 Layout (alias Layout & Spacing), 5 Elevation &
Depth (alias Elevation), 6 Shapes, 7 Components, 8 Do's and Don'ts.

CLI: `npx @google/design.md lint <file>` (exit 1 on errors, `--format json`),
`diff <before> <after>`, `export --format json-tailwind|css-tailwind|tailwind|dtcg <file>`,
`spec [--rules|--rules-only]`.

Example (abridged from the repo):

```markdown
---
version: alpha
name: Example Notes
colors:
  primary: "#1F2A44"
  tertiary: "#2E7D6B"
  on-tertiary: "#FFFFFF"
typography:
  body-md: { fontFamily: Inter, fontSize: 1rem, lineHeight: 1.5 }
rounded: { sm: 4px }
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.sm}"
---

## Overview
A calm, paper-like workspace for focused writing.
```

-> SCP kind `design`: frontmatter parsed and kept as JSON for search and
preview (render swatches from `colors`, type ramp from `typography`). Run
`@google/design.md lint` as an optional validator in the container
(alpha, pin the version). The DTCG export is a ready bridge to Artifact
theming: an artifact can declare `design: <name>` and SCP injects
`css-tailwind` output as CSS variables.

---

## 6. Other prompt/MD shapes worth one kind each

Not fetched this pass; listed from the local disk and known client formats,
verify before building validators.

| Shape | Path | Frontmatter |
|---|---|---|
| Claude Code slash command | `.claude/commands/<name>.md` | `description`, `argument-hint`, `allowed-tools`, `model` (same as skill extensions; skills now supersede commands, a skill beats a same-name command) |
| Copilot prompt file | `.github/prompts/<name>.prompt.md` | `description`, `mode`, `model`, `tools` |
| Cursor rule | `.cursor/rules/<name>.mdc` | `description`, `globs`, `alwaysApply` |
| Ticket / doc template | any, e.g. `~/.claude/rules/TICKET_TEMPLATE.md` | none; wrapped in `<ticket-template>` tags |
| Rule file | `~/.claude/rules/*.md` | none; loaded on demand by CLAUDE.md pointers |
| MCP prompt | served, not a file | `name`, `title`, `description`, `arguments[{name, description, required}]` -> `prompts/get` returns `messages[{role, content:{type:"text", text}}]` |

"Definition package" (the user's term) = a multi-file MD bundle that is not a
skill: e.g. a design system (`DESIGN.md` + `tokens.css` + `components/*.md`),
a PM brief set (MariaVimer/pm-claude-brief ships "1 skill plus 12 CLAUDE.md
brief templates"), or a rules pack (`rules/*.md` + root `CLAUDE.md` that
points at them). Structurally identical to a skill bundle minus the
`SKILL.md` requirement. -> model it as the same file-tree storage with
`kind = package` and a declared `entry` file.

---

## 7. Recommended SCP data model

### 7.1 Principles

1. **Bytes are the source of truth.** Store every file verbatim (including
   CRLF, BOM, comments, YAML block scalars). Parse frontmatter into derived
   columns for search; never re-serialize YAML on export. Re-serializing
   would turn `skeptic.md`'s `>-` scalar into a quoted string and reorder
   keys, breaking diff-ability against upstream.
2. **One storage shape for every kind**: an immutable version = a file tree.
   A single-file agent is a tree with one file.
3. **Lenient import, strict profiles on export.** Accept any frontmatter key
   (third-party keys are the norm). Validate per target profile
   (`claude-code`, `claude-api`, `agentskills`) and report errors/warnings;
   block only what makes the target silently ignore the item.
4. **Provenance is first-class** (pack rosters track upstream SHA).

### 7.2 Kinds

| kind | Entry file | Required frontmatter | Default install path (claude-code profile) |
|---|---|---|---|
| `skill` | `SKILL.md` | `name`, `description` | `.claude/skills/<name>/` |
| `agent` | `<name>.md` | `name`, `description` | `.claude/agents/<name>.md` |
| `command` | `<name>.md` | none | `.claude/commands/<name>.md` |
| `instructions` | `AGENTS.md` | none (no frontmatter) | `AGENTS.md` (alias `CLAUDE.md`, `GEMINI.md`) |
| `prompt` | `<name>.md` | optional `name`, `description`, `arguments` | not installed; served via MCP `prompts/get` and raw URL |
| `design` | `DESIGN.md` | optional (`name`, tokens) | `DESIGN.md` |
| `package` | declared `entry` | none | `<install_root>/<name>/` |

`agent`, `command`, `prompt`, `instructions`, `design` are the "MD control
plane"; `skill` is the skill control plane; artifacts are a separate table
(own research note) but reuse the same `blob` / `file` storage.

### 7.3 SQLite schema (sketch)

```sql
CREATE TABLE item (
  id            TEXT PRIMARY KEY,            -- ulid
  owner_id      TEXT NOT NULL REFERENCES user(id),
  kind          TEXT NOT NULL CHECK (kind IN ('skill','agent','command','instructions','prompt','design','package')),
  name          TEXT NOT NULL,               -- slug; for skills == dir name == frontmatter name
  title         TEXT,                        -- display; Skills API display_name analogue (<=255)
  description   TEXT,                        -- full, never truncated
  category      TEXT,                        -- free text, seeded with roster taxonomy
  tags          TEXT NOT NULL DEFAULT '[]',  -- JSON array
  visibility    TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','group','public')),
  source_repo   TEXT,                        -- upstream provenance, e.g. affaan-m/ECC
  source_ref    TEXT,                        -- commit sha
  source_path   TEXT,                        -- path in upstream repo
  latest_version_id TEXT,
  created_at    TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (owner_id, kind, name)
);

CREATE TABLE item_version (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,            -- 1,2,3... per item
  semver        TEXT,                        -- from metadata.version / version / VERSION file if present
  tree_sha256   TEXT NOT NULL,               -- digest over sorted (path, mode, sha256) lines
  entry_path    TEXT NOT NULL,               -- 'SKILL.md', 'product.md', 'AGENTS.md'
  frontmatter   TEXT,                        -- JSON of parsed entry frontmatter (derived)
  body_lines    INTEGER, body_tokens_est INTEGER, total_bytes INTEGER,
  lint          TEXT NOT NULL DEFAULT '[]',  -- JSON [{profile, level, code, message, path, line}]
  created_by    TEXT NOT NULL,               -- user id or agent token id (write-back)
  created_at    TEXT NOT NULL,
  UNIQUE (item_id, seq)
);

CREATE TABLE version_file (
  version_id    TEXT NOT NULL REFERENCES item_version(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,               -- POSIX, relative, validated (see 7.6)
  mode          INTEGER NOT NULL DEFAULT 420,-- 0644; 493 = 0755 for executables
  sha256        TEXT NOT NULL REFERENCES blob(sha256),
  size          INTEGER NOT NULL,
  media_type    TEXT,
  PRIMARY KEY (version_id, path)
);

CREATE TABLE blob (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, data BLOB);
-- ponytail: blobs in SQLite; move to a volume dir keyed by sha256 if total size outgrows ~1 GB.

CREATE VIRTUAL TABLE item_fts USING fts5(name, title, description, body, content='');
```

Group membership pins versions or floats:

```sql
CREATE TABLE group_member (
  group_id   TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES item(id)    ON DELETE CASCADE,
  version_id TEXT,                 -- NULL = follow latest
  install_as TEXT,                 -- override path/name, e.g. 'CLAUDE.md'
  PRIMARY KEY (group_id, item_id)
);
```

Immutable versions + full snapshots mirrors the Skills API ("each version is
a complete snapshot, not a delta").

### 7.4 Frontmatter parsing rules

- Frontmatter exists iff the file's first line is exactly `---` (after
  stripping a UTF-8 BOM and allowing `\r\n`). Close at the next line that is
  exactly `---` (or `...`). Claude Code requires `---` on line 1, so a BOM or
  leading blank line is a **lint error** for `skill`/`agent` (client would
  ignore the file), not a silent fix.
- Parse with the `yaml` npm package (eemeli/yaml): `parse(src, { schema: 'core', maxAliasCount: 100, uniqueKeys: true })`.
  Reject custom tags. Avoid gray-matter: it bundles js-yaml 3 and a `---js`
  engine that evaluates JavaScript, which is unacceptable for
  agent-uploaded content.
- Duplicate top-level keys = error (DESIGN.md spec also makes this an error).
- Normalize *derived* values only: `tools` / `allowed-tools` comma or space
  string or list -> JSON array in `frontmatter`; booleans `yes/no/on/off/1/0`
  -> bool (Claude Code accepts these).
- Unknown keys: keep in `frontmatter` JSON; under `claude-api` / `agentskills`
  profile emit `warn: non-portable key 'triggers'`.

### 7.5 Validation profiles (lint codes)

`skill`:

| Code | Level | Rule |
|---|---|---|
| `skill.name.format` | error | `^[a-z0-9]+(-[a-z0-9]+)*$`, len 1..64 |
| `skill.name.dir` | error | equals item `name` (the install dir) |
| `skill.name.reserved` | error (claude-api) / warn | contains `anthropic` or `claude`; dir starts `anthropic-skills` |
| `skill.description.missing` | error | empty |
| `skill.description.len` | error | > 1024 |
| `skill.description.angle` | error (claude-api) | contains `<` or `>` |
| `skill.listing.truncated` | warn | `description`+`when_to_use` > 1536 |
| `skill.compatibility.len` | error | > 500 |
| `skill.keys.nonportable` | error (claude-api) / info | key outside the 6-key portable set |
| `skill.body.long` | warn | > 500 lines or > ~5k tokens |
| `skill.size` | error | > 30 MB uncompressed |
| `skill.path.hardcoded` | warn | literal `~/.claude/skills/` or `$HOME/.claude/` |
| `skill.exec.inject` | warn | body has `` !`...` `` or ```` ```! ```` |
| `skill.hooks` | warn | frontmatter `hooks` present |

`agent`: `agent.name.missing`, `agent.name.colon`, `agent.name.dash`,
`agent.name.len>256`, `agent.description.missing` (all error: Claude Code
silently skips such files); `agent.model.unknown` (warn unless in
`sonnet|opus|haiku|fable|inherit` or matches `^claude-`);
`agent.color.invalid` (warn); `agent.skills.max32` (error).

`design`: run `@google/design.md lint --format json` when available; else
check section order + duplicate keys.

`instructions`: `instructions.frontmatter.present` (warn: will render as
text in most clients).

### 7.6 Import (upload) pipeline

Accept: single `.md`; a `.zip`/`.skill`; multipart `files[]` with
`filename` = path (same as Skills API, so the same client code can target
either); or a git URL + ref + path (records provenance).

Zip hardening (trust boundary, agents upload these):

- Reject entries with absolute paths, drive letters (`C:`), `..` segments,
  backslashes, NUL, or symlink/hardlink type (check external attrs
  `(attr >>> 16) & 0o170000 === 0o120000`).
- Cap: 30 MB uncompressed total, 1,000 files, per-file 10 MB, compression
  ratio guard (e.g. > 100:1 rejects).
- Unwrap one top-level folder if every entry shares it (`pdf/SKILL.md` ->
  `SKILL.md`), matching Skills API and plugin archive behaviour.
- Drop `__pycache__/`, `node_modules/`, `*.pyc`, `.DS_Store`, root `evals/`
  (package_skill.py set) and `.git/`.
- Keep the exec bit from zip external attrs or a git tree mode `100755`.
- Kind detection: `SKILL.md` at root -> `skill`; single `.md` with
  frontmatter `name`+`description` and no SKILL.md -> `agent` (user can
  change); filename `AGENTS.md`/`CLAUDE.md` without frontmatter ->
  `instructions`; `DESIGN.md` -> `design`; else ask (UI) or require `kind`
  (API). Never trust filename alone (see the roster-named-AGENTS.md case).
- Bulk import of a pack: walk `skills/*/SKILL.md` and `agents/**/*.md`
  (plugin layout) or `.claude/skills/*/SKILL.md` + `.claude/agents/*.md`
  (repo layout); read `.claude-plugin/marketplace.json` `plugins[].skills`
  arrays when present.

### 7.7 Export shapes

All exports stream from `version_file` rows; zips use ZIP_DEFLATED and
store `mode` in external attrs so `unzip` restores exec bits.

| Endpoint (sketch) | Output |
|---|---|
| `GET /api/v1/items/{kind}/{name}` | JSON: item + latest version metadata + file list (level 1+manifest) |
| `GET /api/v1/items/{kind}/{name}/raw/{path}` | Exact bytes of one file (level 2/3), `ETag: "<sha256>"` |
| `GET /api/v1/items/skill/{name}.zip` | `<name>/SKILL.md ...` (Anthropic `.skill` shape; works for claude.ai upload, Skills API, `unzip -d .claude/skills`) |
| `GET /api/v1/items/agent/{name}.json` | `--agents` JSON shape `{name: {description, prompt, ...}}` |
| `GET /api/v1/groups/{slug}/bundle.zip?profile=claude-code&scope=project` | Install tree (below) + `scp.lock.json` |
| `GET /api/v1/groups/{slug}/plugin.zip` | Claude Code plugin layout (below) |
| `GET /m/{token}/marketplace.json` | `url` marketplace; one `archive` entry per group the token can see |
| `GET /api/v1/groups/{slug}/catalog.md` | Generated roster in the AIBootstrap table format |

`bundle.zip` (profile `claude-code`, `scope=project`), extract at repo root:

```
.claude/skills/<skill>/SKILL.md ...       # verbatim tree
.claude/agents/<agent>.md
.claude/commands/<command>.md
AGENTS.md                                  # or install_as override (CLAUDE.md)
DESIGN.md
.scp/prompts/<prompt>.md                   # prompts have no client path; parked
scp.lock.json
```

`scope=user` swaps the prefix to `~/.claude/` (the install script resolves
`~`). Collisions between two `instructions` items targeting `AGENTS.md` are
a group-level lint error, not a silent overwrite.

`plugin.zip`:

```
.claude-plugin/plugin.json      # {name: <group-slug>, version: "<group seq>", description, author}
skills/<skill>/SKILL.md ...
agents/<agent>.md
commands/<command>.md
```

`instructions` and `design` have no plugin slot; they ship only in
`bundle.zip`. Plugin agents lose `hooks`, `mcpServers`, `permissionMode`
(Claude Code ignores them); lint warns when a group's agent uses them and is
exported as a plugin.

`scp.lock.json` (lets an agent re-sync cheaply and detect local edits):

```json
{
  "scp": "https://scp.example.com",
  "group": "coding-agents",
  "group_seq": 14,
  "generated_at": "2026-10-20T12:00:00Z",
  "items": [
    { "kind": "skill", "name": "zg-verify-claims", "version_seq": 3,
      "tree_sha256": "9f2c...", "path": ".claude/skills/zg-verify-claims/",
      "source": { "repo": "zacgoodwin/zg-skills", "ref": "abc1234" } },
    { "kind": "agent", "name": "product", "version_seq": 1,
      "tree_sha256": "41aa...", "path": ".claude/agents/product.md" }
  ]
}
```

`tree_sha256` = sha256 over the sorted lines `"<mode> <sha256> <path>\n"`,
computed identically server- and client-side so a sync script can diff
without downloading content.

### 7.8 Agent write-back

Agents creating MD/skills use the same multipart `files[]` upload as
`POST /api/v1/items` (new item) or `POST /api/v1/items/{kind}/{name}/versions`
(new version, full snapshot, `name` must match, exactly like Skills API).
`created_by` records the agent token. Lint runs on write; errors under the
`claude-code` profile reject the write so an agent cannot publish a skill
that clients would silently ignore.

---

## 8. Open questions for the plan

- Is Claude Code plugin export (requires HTTPS hostname) in v1, or is
  `bundle.zip` + an install script enough for the first docker deploy?
- Should `prompt` items be exposed as MCP `prompts` (native slash commands in
  many clients) or only as MCP tools/resources? MCP prompts are the natural
  fit for snippets with `arguments`.
- Non-Claude targets (Codex, Cursor, Copilot) as extra export profiles: the
  storage model supports them via `install_as`; validators can wait until a
  user asks.
