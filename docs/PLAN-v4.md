# SCP v4 plan: the v3 follow-up backlog

v3 (`docs/PLAN-v3.md`) shipped as v0.1.3 and filed 16 follow-up tickets. This batch is every open,
non-deferred Kata ticket on 2026-10-23. Every rule in `docs/PLAN.md`, `docs/PLAN-v2.md` and
`docs/PLAN-v3.md` still holds (access rules, 404-not-403 for resources, path rules, limits, no hosted
LLM calls). This file only adds. Import behaviour changes are recorded in PLAN-v2 D1 where the
tickets say so; this file holds the chunking, the decisions, and the one new contract (mc52).

## Chunks

One linear stax stack, bottom to top, one PR per branch. Lane I is built in order (each branch stacks
on the previous, since every one of them edits `server/src/imports/pack.ts`); lanes U and X are built
in parallel worktrees off `main` and restacked onto the top of lane I before shipping. Deferred tickets
(`deferred` label) are not in this batch.

| Branch | Kata | Ticket |
|---|---|---|
| `v4-import-naming` (I1) | y15q | Kind-override single file is named 'helper', not 'helper-md'; a blob URL with kind skill imports the file |
| | t1ge | An unclosed `---` fence imported with 'import' gets its description from the body, not the YAML |
| | rv5z | `name: ""` is a frontmatter error: asked about, importable with 'import', named after its folder |
| `v4-import-clash` (I2) | 5vz2 | Two copies whose plugin folders share a name lengthen the prefix instead of colliding |
| | 7k2p | In-import prefixing for agents and commands |
| | eg9k | Multi-harness ranking also orders plugin roots: a port folder's plugin.json loses to `plugins/x/` |
| `v4-import-tree` (I3) | jv9q | In-tree symlinks import as copies of their target (one hop, never outside the tree) |
| | m5wy | The Trees-API fallback honours the folder's `.gitattributes` `export-ignore` |
| | nenk | `includeRepoTooling` is stored on the item, re-applied on source update, offered in the Import dialog |
| | en8v | Import dialog: kind select on the pack tab, Description on the File tab |
| `v4-exec-kinds` (I4) | mc52 | Hooks, MCP servers and output styles become item kinds (contract below) |
| | snqk | Inline `hooks`/`mcpServers` in plugin.json, `.mcpb` bundles and `bin/` are reported in `skipped` |
| `v4-ui-fixes` (U) | mwre | `ItemSummary.canEdit` from the server; the client copy of canEditItem is deleted |
| | 5x0a | Tools "Used by" and the group Requires panel agree when one item reaches a group twice |
| `v4-sast` (X) | 7tg2 | SAST catches cross-function SQL interpolation, aliased `child_process` imports, `c.req.url` redirects |
| | c5j3 | Decision recorded: admin routes keep 403; docs that say 404 are corrected |

## Decisions taken for this batch

- c5j3 (human, 2026-10-23): every `/api/v1/admin` route keeps answering 403 to a signed-in non-admin
  (`requireAdmin`). An admin route's existence is not a secret; "unreadable resources are 404" is about
  resources. The dhje / 00tr criteria and any PLAN text saying admin routes answer 404 are corrected.
- mc52 (human, 2026-10-23): option (c), any owner may store and serve executable plugin components,
  with an install-time warning and a per-group flag. The kinds are `hook`, `mcp-server` and
  `output-style`. `.lsp.json`, `monitors/`, `bin/`, `themes/`, `workflows/` and `settings.json` stay
  report-only (`skipped`), as do inline manifest declarations and `.mcpb`/`.dxt` bundles (snqk).
- The MCP specification itself defines no hooks, output styles or packaging; these components and their
  layout come from the Claude Code plugin manifest (code.claude.com/docs/en/plugins-reference), which is
  the reference for every path below.
- Migrations stay append-only (`db.ts` `MIGRATIONS`). Lanes U and X add none.
- Squash commits: each PR's squash commit carries its PR title, not the first commit's subject (the v3
  blemish). Check the subject before `gh stack merge`.

## Executable plugin components (mc52)

### Kinds

`KINDS` gains `hook`, `mcp-server` and `output-style`, all in the `md` plane (`planeOf`, `MD_KINDS`,
web `KINDS_BY_PLANE.md`); a separate plane is out of scope (see deferred 6tac). `EXECUTABLE_KINDS =
['hook', 'mcp-server']` in `types.ts` is the one list every warning and flag below reads.

| Kind | Shape | Entry path | Lint |
|---|---|---|---|
| `output-style` | one `.md` file (`SINGLE_FILE`) | `<name>.md` | frontmatter `name`/`description` like an agent; `keep-coding-instructions` boolean if present |
| `hook` | a tree | `hooks/hooks.json` | entry parses as JSON with a top-level `hooks` object (error `hook.json.invalid`); info `exec.runs_code` |
| `mcp-server` | a tree | `.mcp.json` | entry parses as JSON with a top-level `mcpServers` object (error `mcp.json.invalid`); a server name starting `scp-` is an error (`mcp.name.reserved`: SCP's own plugin entry is `scp-<group>`); info `exec.runs_code` |

A tree item's other files keep their paths relative to the plugin root (`scripts/format.sh`), so
`${CLAUDE_PLUGIN_ROOT}/scripts/format.sh` in the entry and `$CLAUDE_PLUGIN_ROOT` inside the scripts
both keep working when the files are installed at the plugin root.

### Database

The `items.kind` CHECK constraint is widened by a new migration that rebuilds `items` (SQLite cannot
alter a CHECK). The rebuild keeps every row, index, trigger (`items_fts_after_delete`) and foreign key
(`item_versions`, group members, `forked_from` and the other `REFERENCES items(id)`), and runs with
`foreign_keys` off (the pragma is a no-op inside a transaction), then `PRAGMA foreign_key_check` must
return nothing before commit. A test migrates a database at the previous `user_version` holding items,
versions, group members and FTS rows: counts match, search still finds, and deleting an item still
cascades.

### Import (`server/src/imports/pack.ts`)

Inside a plugin root (bppq's `pluginRoots`), these leave `PLUGIN_COMPONENTS` and become units:

- `hooks/hooks.json` → one `hook` unit; `.mcp.json` → one `mcp-server` unit. A `.json` file named by the
  manifest's `hooks` or `mcpServers` (string or array of `./` paths) is one more unit of that kind, its
  file stored as the entry. Name: the plugin's name (5w3w manifest name, else folder name), suffixed
  `-hooks` / `-mcp` (a second unit of the kind adds `-2`, `-3` in manifest order); 5ef6 prefixing and the
  64-char rule apply as for any unit.
- A unit's tree is its entry plus, for each `${CLAUDE_PLUGIN_ROOT}/<p>` or `$CLAUDE_PLUGIN_ROOT/<p>`
  reference in the entry's strings (`<p>` ends at whitespace, a quote, or `}`), every plugin file under
  `<p>`'s first segment (`scripts/` for `scripts/format.sh`), or `<p>` itself when it is a root file;
  for a `hook`, also every other file under `hooks/`. A reference that resolves to no file is a lint warn
  (`exec.ref.missing`), never a read outside the tree. Files a unit takes are claimed and not reported.
- `output-styles/*.md` (or the manifest `outputStyles` paths) → one `output-style` unit per file.
- Still reported in `skipped`, unchanged wording style: `.lsp.json`, `monitors/`, `settings.json`,
  `themes/`, `workflows/`, `bin/` outside a skill folder, and (snqk) an inline `hooks`/`mcpServers`/
  `lspServers` object in plugin.json and an `mcpServers` entry naming a `.mcpb`/`.dxt` bundle or URL.
- A `.mcp.json` or `hooks/` outside any plugin root is repository tooling: not an item, not reported.
- `kind` overrides and `folderKinds` (jwz6) do not offer the new kinds; the items create/update API and
  MCP `create_item` accept them with their entry path.

### Serving

`bundle.ts` `PATHS` and `pluginPath`:

| Kind | claude-code | codex | generic | plugin.zip |
|---|---|---|---|---|
| `output-style` | `.claude/output-styles/<n>.md` | `.scp/output-styles/<n>.md` | `output-styles/<n>.md` | `output-styles/<n>.md` |
| `hook` | `.scp/hooks/<n>/` | `.scp/hooks/<n>/` | `hooks/<n>/` | entry at `hooks/<n>.json`, other files at their stored paths |
| `mcp-server` | `.scp/mcp-servers/<n>/` | `.scp/mcp-servers/<n>/` | `mcp-servers/<n>/` | entry at `mcp/<n>.json`, other files at their stored paths |

Only the plugin.zip runs them: its `plugin.json` gains `"hooks": ["./hooks/<n>.json", ...]` and
`"mcpServers": ["./mcp/<n>.json", ...]` (sorted by name; omitted when empty), merged by Claude Code with
SCP's own root `.mcp.json`. In bundle.zip they are inert copies (hooks live in settings.json, and
`${CLAUDE_PLUGIN_ROOT}` is unset outside a plugin); the bundle's install text says so. Two members
writing the same stored path (two hooks both shipping `scripts/format.sh`) are a path conflict, refused
by the existing `pluginConflicts`/`findConflicts` (409), never silently overwritten. `INSTALL_AS_KINDS`
does not gain them.

### The flag and the warnings

- `executable: {kinds: ('hook'|'mcp-server')[], items: [{id, kind, name}]} | null` on `GET
  /api/v1/groups/:slug`, on each group in list responses (`null` or the same object without `items`),
  on the MCP `get_group` first page and `get_bundle`, and on the marketplace entry. Derived from the
  effective members (`resolvedMembers`: includes and pins count), never stored, so it cannot drift.
- MCP `get_bundle` / `get_group` add a warning string when `executable` is set: these items run commands
  on the installing machine when installed as a Claude Code plugin; show the user, do not install
  without their consent.
- The marketplace entry's and plugin.json's `description` start with `Runs code (hooks, MCP servers): `
  when the group's plugin carries an executable member.
- Web: the group page shows a warning banner above the install options and a "runs code" badge on each
  executable member; item rows and item pages of an executable kind show the same badge; the item page
  of a `hook`/`mcp-server` shows its entry JSON before anything else.

### Tests

`imports.test.ts` (a plugin with hooks/hooks.json + scripts/, .mcp.json with a bundled server and an
`npx` server, output-styles/, the manifest path forms, inline forms reported, a reference to a missing
file, `scp-` reserved name), `bundle.test.ts` and `marketplace.test.ts` (paths per target, plugin.json
`hooks`/`mcpServers` arrays, description prefix, a script path conflict refused, plugin.zip bytes still
deterministic), `groups.test.ts` / `includes.test.ts` (flag through an include and a pin), `mcp.test.ts`
(warning present), the migration test above, and `lint.test.ts` for the new codes.

## Shared files

Lanes U and X touch `web/src/api*.ts`, `README.md` and docs alongside lane I. Each appends rather than
rewrites (its own README section) so the restack conflicts are mechanical.
