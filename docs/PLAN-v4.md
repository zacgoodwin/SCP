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
| | m5wy | The Trees-API fallback honours the folder's `.gitattributes` `export-ignore`, read as git reads them (quoted patterns, root macros, byte-wise wildmatch) |
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
  `-hooks` / `-mcp` (a second unit of the kind adds `-2`, `-3` in manifest order, on first import: an
  item keeps its name after, see Source path and updates); 5ef6 prefixing and the 64-char rule apply as
  for any unit.
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
by the existing `pluginConflicts`/`findConflicts` (409), never silently overwritten. So are two MCP
servers declaring one server name (Claude Code keeps the one declared later, the other gone without a
word): `pluginConflicts` adds a pseudo-path `mcpServers:<name>` per name each MCP server member's entry
declares (`groups/service.ts SERVER_NAMES`, read in SQL from the stored entry, compared folded like
paths), so the manifest's `plugin`, the marketplace listing and plugin.zip refuse it alike, a plugin
whose `.mcp.json` and a manifest `mcpServers` file share a name included. `INSTALL_AS_KINDS`
does not gain them.

### The flag and the warnings

- `executable: {kinds: ('hook'|'mcp-server')[], items: [{id, kind, name}]} | null` on `GET
  /api/v1/groups/:slug`, on each group in list responses (`null` or the same object without `items`),
  on the MCP `get_group` first page and `get_bundle`, and on the marketplace entry. Derived from the
  effective members (`resolvedMembers`: includes and pins count, but not another owner's included
  group's hooks and MCP servers, which are withheld: see Includes below), never stored, so it cannot drift.
- MCP `get_bundle` / `get_group` add a warning string when `executable` is set: these items run commands
  on the installing machine when installed as a Claude Code plugin; show the user, do not install
  without their consent.
- The marketplace entry's and plugin.json's `description` start with `Runs code (hooks, MCP servers): `
  when the group's plugin carries an executable member.
- Web: the group page shows a warning banner above the install options and a "runs code" badge on each
  member whose served version is executable; item rows and item pages of an executable version show the
  same badge; the item page of a `hook`/`mcp-server` shows its entry JSON before anything else. The
  badges read the per-version flag (refinements below), never the kind: `ItemSummary.executable` (the
  latest version) on item rows and cards, `members[].executable` (the served version: the pin, else
  latest) on a group member row, `version.executable` (`VersionSummary`) for the version on the item page.

### Refinements made while building it (I4)

Where the contract above met the code or the Claude Code docs (plugins-reference, components,
output-styles, marketplace-reference, read 2026-10-24), the safer reading was taken:

- Output styles: every frontmatter field is optional in Claude Code (the file name stands in for `name`,
  and a style whose YAML does not parse still loads), so "like an agent" became warnings only:
  `output-style.description.missing`, `output-style.keep-coding-instructions` (not a boolean). An
  agent-style error would refuse files Claude Code loads.
- References: the docs write `"${CLAUDE_PLUGIN_ROOT}"/scripts/format.sh` (the quote closes the variable
  before the slash), so a quote may sit between the variable and `/`. `<p>` still ends at whitespace, a
  quote or `}`; `relPath` resolves it and one climbing out is `exec.ref.missing`.
- What a unit takes: only files no other unit claimed (exec units are made after the declared paths and
  each root's layout folders, before the root skill and the any-`SKILL.md` pass), only inside its own
  plugin root (not a nested one's), and never from another component: a reference whose first segment
  is `skills`, `agents`, `commands`, `output-styles`, `hooks` (a hook takes its own `hooks/` anyway),
  `monitors`, `themes`, `workflows`, `bin`, `.claude-plugin`, `settings.json`, `.lsp.json`,
  `.mcp.json` or a root `SKILL.md` (any case) takes nothing. Otherwise `bin/` would reach the plugin's
  PATH inside a hook item, a nested agent file would load as an agent, or a root `SKILL.md` would load
  as a skill no group member declared (plugins-reference: a plugin with `SKILL.md` at its root, no
  `skills/` and no `skills` key loads as a single skill); such a reference stays an `exec.ref.missing` warning
  (the file belongs to another item). Folder references are swept once per root, so a manifest naming
  many files stays linear.
- The same rule binds every write, not only the import (verifier, I4): a hook's or MCP server's other
  files land at their stored paths at the plugin root, so one stored through `POST /items` or a new
  version at `bin/x`, `.lsp.json`, `monitors/`, `settings.json`, `agents/x.md`, `SKILL.md` or
  `.claude-plugin/` would run or load in every installed plugin, and an MCP server's `hooks/hooks.json` would load as
  hooks while the flag's `kinds` said MCP only. Lint refuses a non-entry file whose first segment is one
  of those components (error `exec.path.reserved`, one per component; `items/lint.ts componentOf`, the
  one list the import reads too), except a hook's own `hooks/` (its scripts; the one file there Claude
  Code loads, `hooks/hooks.json`, is its entry, and a case variant of it collides with the entry). The
  segment is compared folded (`pathKey`): on a case-insensitive install disk `BIN/` is `bin/`. So
  detection takes no `BIN/` for a reference either, and reports a plugin's `BIN/` or `Settings.json`
  in `skipped` like `bin/` and `settings.json`.
- Source path and updates: a hook's or MCP server's `source_path` is its plugin root (the entry and its
  files are plugin-relative), and `updateTree` re-detects that root (`pluginFolder`, which now makes
  `''` a plugin root even when its manifest is a marketplace entry). The unit is found by its upstream
  entry, which the import records (`source_entries`: `[kind, plugin-relative path]` of the root's hook
  and MCP server entries up to the item's own, last), not by the name's suffix: a `hooks` or
  `mcpServers` file a marketplace entry names is in no manifest of the plugin folder alone (verifier,
  I4: every such update was 400), and a manifest that reorders its files no longer swaps two items'
  trees. A re-import finds the item the same way (`importUnit`: kind, repository, plugin root and the
  last recorded entry; a row without the record by name), so an entry added before another, removed or
  reordered upstream versions the item of its own entry, which keeps its name; a new entry whose
  positional name such a sibling still holds takes the next free `-<n>`. The recorded entries are re-made first and in order, so each takes what it took at import (a
  server whose `scripts/` reference found the folder taken by the hook made before it takes none
  again); at most the 49 before its own are kept, so a manifest naming thousands stays linear. A row
  without the record is the kind's default file. A unit gone upstream is 400 `bad_source`, never the
  whole root written into the item. A plugin root's own skill carves the exec files out
  (`source_carve`), on import and on update alike. A root skill imported before mc52 held those files
  (no unit carved them): while its latest version still holds a file only an exec unit takes now,
  `updateTree` detects it without exec units (`detectUnits` `exec: false`), so an update never drops
  them unreported; a re-import makes the hook, MCP server and output-style items and writes the carved
  skill, after which updates carve. ponytail: a re-import at the commit the item already holds writes
  no version, so the skill keeps its copies (inert inside its skill folder) until upstream moves.
- `outputStyles` in the manifest replaces the default `output-styles/` folder, as in Claude Code; the
  declared paths go through the existing 4ky8 `DECLARED` pass (named by file, prefixed like commands).
- snqk wording: `inline '<key>' in the manifest is not supported by SCP; it was not imported`, and
  `MCP bundle '<x>' is not supported by SCP; it was not imported` (a `.mcpb`/`.dxt` path or any
  `http(s):` value); a declared `hooks`/`mcpServers` path that is not a `.json` file of the plugin is
  reported like a 4ky8 path (`names no .json file; not imported`). `themes/`, `workflows/` and `bin/`
  join `PLUGIN_COMPONENTS`; `hooks/`, `.mcp.json` and `output-styles/` stay there for what no unit
  took (a `hooks/` without `hooks.json`).
- `.mcp.json` must carry the `mcpServers` wrapper, as the contract says, although Claude Code also reads a
  bare server map in a plugin's `.mcp.json`: a bare map is refused (`mcp.json.invalid`, in `skipped`), the
  side that stores no code. The reserved-name check is case-insensitive (`SCP-x` too).
- There is no MCP `create_item` tool (the MCP server writes artifacts only); the items API
  (`POST /items`, new versions) accepts the kinds with their entry paths, and a fresh upload whose only
  folder holds the entry (`hooks/hooks.json`) is not unwrapped. The kind override is refused on the
  single-file `POST /items/import` too.
- plugin.zip: a hook named `hooks` lands on `hooks/hooks.json`, which Claude Code loads by itself, so
  plugin.json does not list it again (a duplicate hooks file is a load error). SCP's own
  `.claude-plugin/plugin.json` and `.mcp.json` are paths in `pluginConflicts`, so a member's stored file
  there is the same 409 as two members' clash, in the manifest, the marketplace listing and the build.
  Lint (`exec.path.reserved`, above) refuses storing one there in the first place; the conflict stays
  as the builder's last line.
- The flag: list responses compute it from the members the group publishes (the same walk as `counts`);
  the detail, MCP and the marketplace entry from `resolvedMembers`. The marketplace entry carries the
  flag with `items` (Claude Code ignores an unknown entry key), and the bundle manifest carries it too,
  which `get_bundle` reads.
- Includes (review, exec-include-injection): a hook or MCP server is served only from a group reached
  through the including group's owner's own groups alone, the group itself included
  (`effectiveGroups` marks each group `own`; `resolvedMembers`, `pluginMembers` and `groupSummary`
  skip the rest). Another owner's public group flows by design (`includeVouchSql`), so without this a
  hook its owner adds after the include was made would ship in every installed plugin's next update
  with no consent step: every include made before mc52 was made when nothing could run code. The
  withheld members leave the members list, the flag, bundle.zip, MCP, plugin.zip and the marketplace
  alike, so they all agree; so do the SQL walks (`access.ts upCte` climbs a hook or MCP server only to
  a parent of the child's owner: `?group=` listing and search, the item's groups, a key restricted to
  the group), and the write checks (`memberRows`, `servedItemIds`: a withheld member neither conflicts
  with nor counts against an add or include); the manifest lists them (`withheld: [{id, kind, name, via}]`) and the
  group page names them beside the install options. Adding such an item to the group directly (a
  member row of the owner's own) is the consent that serves it. Human decision (2026-10-24): withholding
  stays by kind, hooks and MCP servers only, and there is no per-group opt-in; foreign hooks and MCP
  servers stay withheld, and adding the item directly remains the consent.
- Executable is a property of the version, not only of the kind (review, exec-flag-misses-skill-command-hooks
  and output-style-force-for-plugin). Claude Code keeps a plugin skill's frontmatter `hooks` (run once it is
  invoked), runs a skill's or command's `` !`cmd` `` and ` ```! ` blocks as it renders them (without a prompt
  when `allowed-tools` pre-approves them; commands take skills' frontmatter), and applies an output style
  with `force-for-plugin` in every session of an enabled plugin, over the user's own `outputStyle`. So
  `item_versions.executable` (migration 20, backfilled from each entry by the same rule) is written at
  every version by `items/lint.ts versionExecutable`: 1 for a hook or MCP server, for a skill or command
  whose entry frontmatter has `hooks` or whose body matches the `skill.exec.inject` test, and for an output
  style with `force-for-plugin` set; agents never (plugin agents ignore `hooks`). The flag reads the served
  version's column (the member row's pin, else latest): `kinds` may now hold `skill`, `command` and
  `output-style`, and so do the badges, the MCP warning and the description prefix (`Forces an output
  style: ` for a forced style, after `Runs code (hooks, MCP servers): ` when both apply). Human decision
  (2026-10-24): the withholding does not read it. It keys on the kind alone (`withheldExec`, `memberRows`,
  `servedItemIds`, `pluginMembers`, `groupSummary`, `access.ts upCte`), so another owner's included skill,
  command or output style that runs code or forces a style is served as before v4, and, being served, sets
  the including group's flag, warnings and prefix; a withheld foreign hook or MCP server sets none of them.
  A member row pinned to a version that does none of this drops it from the flag. Lint warns
  `command.exec.inject`, `command.hooks` and `output-style.force`. `isExecutable(kind)` stays the list of
  kinds laid out at the plugin root and withheld from another owner's include.
- Output style names (review, outputstyle-prefix-not-pinned): Claude Code lists a plugin's styles by their
  frontmatter `name`, else the file name. An output style prefixed in an import takes the prefixed name in
  its frontmatter when it names itself (`pinName`, kept on source updates by `keepPrefix`, as for an agent);
  one without a `name` already goes by its file name, the item's. `pluginConflicts` adds a pseudo-path
  `outputStyle:<name>` per output-style member (compared folded), so two members under one name are a
  `path_conflict` in the manifest, the marketplace listing and plugin.zip alike, like two server names.
- Server names in SQL (review): `SERVER_NAMES` reads `.mcp.json` with SQLite's JSON, which keeps the
  first of repeated keys and refuses nesting past 1000 levels, while `JSON.parse` (and Claude Code)
  keep the last. So lint refuses (`mcp.json.invalid`) an MCP server entry that repeats a key at its
  top level or in `mcpServers`, or nests deeper than 1000 levels (`items/lint.ts sqlJsonDivergence`):
  every stored entry then names, in SQL, the servers Claude Code installs.
- Badges and the description (review of PR #32, mc52): the web badges keyed on the kind, so a skill that
  runs shell went unbadged and a member pinned to a plain version was badged by its latest. The DTOs now
  carry the flag (`ItemSummary.executable`, `GroupMember.executable`, `VersionSummary.executable`) and the
  badges read it. `flaggedDescription` trims the group's description, so one of whitespace alone is none
  and the prefix drops its `: ` as for an empty one.
- Migration: `MIGRATIONS` entries may be `{fkOff: true, sql}`; `migrate()` turns `foreign_keys` off around
  such a one, runs `PRAGMA foreign_key_check` before commit, and restores the pragma. `migrate(db, to)`
  stops early, for the migration test. Migration 19 adds `items.source_entries` (above).

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
