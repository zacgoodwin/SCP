import { now, type Db } from '../db.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { HttpError, badRequest } from '../lib/http.ts';
import { pathKey } from '../lib/paths.ts';
import { buildZip } from '../lib/zip.ts';
import type { TreeFile } from '../lib/tree.ts';
import { listFiles, readTree } from '../items/service.ts';
import { MAX_GROUP_FILES, resolvedMembers, serverNames, usernameOf, type ResolvedMember, type WithheldMember } from './service.ts';
import { EXECUTABLE_KINDS, isExecutable, planeOf, type GroupRow, type ItemRow, type Kind, type Plane, type Principal, type VersionRow } from '../types.ts';

const MB = 1024 * 1024;
/** Uncompressed bytes per bundle.zip: it is built in memory (~5x that in RSS) on the request thread. */
export const MAX_BUNDLE_BYTES = 100 * MB;

export const TARGETS = ['claude-code', 'codex', 'generic'] as const;
export type Target = (typeof TARGETS)[number];
export const INSTALL_SCOPES = ['project', 'user'] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

export interface InstallOpts {
  target: Target;
  scope: InstallScope;
  installAs?: string | null;
}

/** Kinds whose install path a member may override (one file at a path the user picks). */
export const INSTALL_AS_KINDS = new Set<Kind>(['instructions', 'design', 'prompt', 'agent', 'command']);

type PathFn = (name: string, entry: string, user: boolean) => string;

// Folder kinds end in '/'; everything else is one file path, relative to the project (or home) root.
// mc52: hooks and MCP servers are inert copies here (only plugin.zip runs them), so never where a client loads them.
const PATHS: Record<Target, Record<Kind, PathFn>> = {
  'claude-code': {
    skill: (n) => `.claude/skills/${n}/`,
    agent: (n) => `.claude/agents/${n}.md`,
    command: (n) => `.claude/commands/${n}.md`,
    // Claude Code loads CLAUDE.md, not AGENTS.md; the stored entry file stays AGENTS.md (entryPathFor).
    instructions: (_n, _e, user) => (user ? '.claude/CLAUDE.md' : 'CLAUDE.md'),
    design: (n, _e, user) => (user ? `.scp/design/${n}/DESIGN.md` : 'DESIGN.md'),
    prompt: (n) => `.scp/prompts/${n}.md`,
    package: (n) => `.scp/packages/${n}/`,
    artifact: (n, e) => `.scp/artifacts/${n}/${e}`,
    'output-style': (n) => `.claude/output-styles/${n}.md`,
    hook: (n) => `.scp/hooks/${n}/`,
    'mcp-server': (n) => `.scp/mcp-servers/${n}/`,
  },
  codex: {
    skill: (n) => `.agents/skills/${n}/`,
    agent: (n) => `.codex/agents/${n}.md`,
    command: (n) => `.codex/prompts/${n}.md`,
    instructions: (_n, _e, user) => (user ? '.codex/AGENTS.md' : 'AGENTS.md'),
    design: (n, _e, user) => (user ? `.scp/design/${n}/DESIGN.md` : 'DESIGN.md'),
    prompt: (n) => `.codex/prompts/${n}.md`,
    package: (n) => `.scp/packages/${n}/`,
    artifact: (n, e) => `.scp/artifacts/${n}/${e}`,
    'output-style': (n) => `.scp/output-styles/${n}.md`,
    hook: (n) => `.scp/hooks/${n}/`,
    'mcp-server': (n) => `.scp/mcp-servers/${n}/`,
  },
  generic: {
    skill: (n) => `skills/${n}/`,
    agent: (n) => `agents/${n}.md`,
    command: (n) => `commands/${n}.md`,
    instructions: (n) => `instructions/${n}.md`,
    design: (n) => `design/${n}/DESIGN.md`,
    prompt: (n) => `prompts/${n}.md`,
    package: (n) => `packages/${n}/`,
    artifact: (n, e) => `artifacts/${n}/${e}`,
    'output-style': (n) => `output-styles/${n}.md`,
    hook: (n) => `hooks/${n}/`,
    'mcp-server': (n) => `mcp-servers/${n}/`,
  },
};

/** Where a member lands in a bundle: a folder prefix ending '/' (skill, package) or a file path. */
export function installPath(kind: Kind, name: string, entryPath: string, opts: InstallOpts): string {
  if (opts.installAs && INSTALL_AS_KINDS.has(kind)) return opts.installAs;
  const entry = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  return PATHS[opts.target][kind](name, entry, opts.scope === 'user');
}

export function checkInstallOpts(opts: { target: string; scope: string }): void {
  if (!(TARGETS as readonly string[]).includes(opts.target)) throw badRequest(`target must be one of ${TARGETS.join(', ')}`);
  if (!(INSTALL_SCOPES as readonly string[]).includes(opts.scope)) throw badRequest(`scope must be one of ${INSTALL_SCOPES.join(', ')}`);
}

const base = (p: string) => pathKey(p.replace(/\/$/, ''));

/** Same path, or one inside the other, compared as pathKey (case and NFC/NFD: macOS/Windows checkouts). */
export function pathsOverlap(a: string, b: string): boolean {
  const x = base(a);
  const y = base(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

export interface Conflict {
  path: string;
  items: string[];
}

/**
 * Every path a member writes: its folder (skill, package), or its entry file plus the extra files
 * placeTree puts in extrasDir. Conflict checks must use this, not just the entry path, or a group
 * whose manifest says conflicts: [] can still fail at bundle time.
 */
export function footprint(kind: Kind, name: string, entryPath: string, filePaths: string[], opts: InstallOpts): string[] {
  const at = installPath(kind, name, entryPath, opts);
  if (at.endsWith('/')) return [at];
  const extras = extrasDir(kind, name, entryPath, opts.target);
  return [at, ...filePaths.filter((f) => f !== entryPath).map((f) => extras + f)];
}

/** One footprint path. Pairs from the same member count too: an installAs onto its own extras clashes. */
export interface PathEntry {
  path: string;
  name: string;
  id: string;
}

/** Proper ancestors of a lowercased, slash-trimmed path: 'a/b/c' -> ['a', 'a/b']. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i));
  return out;
}

const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

/**
 * Every pair of overlapping paths (pathsOverlap), grouped by the shorter path. Indexed, not pairwise:
 * group footprints are attacker-sized (public groups, 1000-file items), so this is O(paths x depth)
 * plus the overlaps found. With focus, only pairs that involve one of those item ids are reported.
 */
export function findConflicts(entries: PathEntry[], focus?: ReadonlySet<string>): Conflict[] {
  const out = new Map<string, Conflict>();
  const at = new Map<string, PathEntry[]>(); // path -> entries there
  const below = new Map<string, PathEntry[]>(); // folder -> entries inside it
  const pair = (a: PathEntry, b: PathEntry) => {
    if (focus && !focus.has(a.id) && !focus.has(b.id)) return;
    const path = a.path.length <= b.path.length ? a.path : b.path;
    const c = out.get(base(path)) ?? { path, items: [] };
    for (const n of [a.name, b.name]) if (!c.items.includes(n)) c.items.push(n);
    out.set(base(path), c);
  };
  for (const e of entries) {
    const x = base(e.path);
    const up = ancestors(x);
    for (const o of at.get(x) ?? []) pair(o, e);
    for (const y of up) for (const o of at.get(y) ?? []) pair(o, e);
    for (const o of below.get(x) ?? []) pair(o, e);
    push(at, x, e);
    for (const y of up) push(below, y, e);
  }
  return [...out.values()];
}

/** findConflicts lists each name once, so two owners' items with one name are "two members named". */
export const pathConflict = (c: Conflict) =>
  new HttpError(
    409,
    'path_conflict',
    c.items.length === 1 ? `two members named '${c.items[0]}' install to '${c.path}'` : `${c.items.map((n) => `'${n}'`).join(' and ')} both install to '${c.path}'`,
    c,
  );

export interface ManifestItem {
  id: string;
  kind: Kind;
  plane: Plane;
  name: string;
  title: string;
  description: string;
  version: number;
  treeSha256: string;
  installPath: string;
  owner: string;
}

/** Why a download cannot be built (`code` is the HttpError code it would answer with: group_full, bundle_too_large, path_conflict), or ok. */
export interface BuildProblem {
  ok: boolean;
  problem: string | null;
  code: string | null;
  /** With path_conflict: the path and the members' names, so the UI can say what fixes it (a rename fixes no server name or stored path). */
  conflict?: Conflict;
}

export interface Manifest {
  group: { slug: string; name: string; description: string; instructions: string; updatedAt: string };
  target: Target;
  scope: InstallScope;
  items: ManifestItem[];
  conflicts: Conflict[];
  /** Whether plugin.zip builds (and the marketplace lists the group), else the refusal buildPlugin would answer with. */
  plugin: BuildProblem;
  /** Whether bundle.zip builds for this target and scope, else the refusal buildBundle would answer with. */
  bundle: BuildProblem;
  /** mc52: the members that run code as a plugin (executableOf); in bundle.zip they are inert copies. */
  executable: ExecutableFlag | null;
  /** mc52 (review): hooks and MCP servers another owner's included group holds, which this group does not serve (service.ts resolvedMembers). */
  withheld: WithheldMember[];
}

const asProblem = (e: HttpError | null): BuildProblem => ({ ok: e === null, problem: e && e.message, code: e && e.code, ...(e?.code === 'path_conflict' && { conflict: e.details as Conflict }) });

interface Placed {
  member: ResolvedMember;
  path: string;
  paths: string[];
  /** The member's stored paths (an executable kind's land at those paths in plugin.zip: pluginFootprint). */
  files: string[];
  owner: string;
}

/** Files across these versions, in one statement; MAX_GROUP_FILES is checked against it on read and on the owner's writes (service.ts). */
export function fileCount(db: Db, versionIds: string[]): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM version_files WHERE version_id IN (SELECT value FROM json_each(?))').get(JSON.stringify(versionIds)) as { n: number }).n;
}

const groupFull = (n: number) => new HttpError(400, 'group_full', `this group's members hold ${n} files; groups are limited to ${MAX_GROUP_FILES}`);

function place(db: Db, p: Principal, group: GroupRow, opts: InstallOpts): { placed: Placed[]; files: number; withheld: WithheldMember[] } {
  checkInstallOpts(opts);
  const withheld: WithheldMember[] = [];
  const members = resolvedMembers(db, p, group, withheld);
  // Member adds enforce the cap, but unpinned members follow their latest version, which can grow
  // past it later; count before listing (and conflict-checking) every file of every member.
  const files = fileCount(db, members.map((m) => m.version.id));
  if (files > MAX_GROUP_FILES) throw groupFull(files);
  const placed = members.map((m) => {
    const o = { ...opts, installAs: m.installAs };
    const files = listFiles(db, m.version.id).map((f) => f.path);
    return {
      member: m,
      path: installPath(m.item.kind, m.item.name, m.version.entry_path, o),
      paths: footprint(m.item.kind, m.item.name, m.version.entry_path, files, o),
      files,
      owner: usernameOf(db, m.item.owner_id),
    };
  });
  return { placed, files, withheld };
}

const placedConflicts = (placed: Placed[]) =>
  findConflicts(placed.flatMap((x) => x.paths.map((path) => ({ path, name: x.member.item.name, id: x.member.item.id }))));

const totalBytes = (members: PluginMember[]) => members.reduce((n, m) => n + m.version.total_bytes, 0);

const tooLargeBundle = (total: number) =>
  new HttpError(413, 'bundle_too_large', `this group is ${Math.ceil(total / MB)} MB uncompressed; bundles are limited to ${MAX_BUNDLE_BYTES / MB} MB`);

/** The error buildBundle throws for what place() returned, or null: the size cap, then the first conflict. */
function bundleProblem(placed: Placed[], conflicts: Conflict[]): HttpError | null {
  const total = totalBytes(placed.map((x) => x.member));
  if (total > MAX_BUNDLE_BYTES) return tooLargeBundle(total);
  return conflicts[0] ? pathConflict(conflicts[0]) : null;
}

/** Catalog for agents: what the group holds and where each piece installs. No file bodies. */
export function buildManifest(db: Db, p: Principal, group: GroupRow, opts: { target: Target; scope: InstallScope }): Manifest {
  const { placed, files, withheld } = place(db, p, group, opts);
  const conflicts = placedConflicts(placed);
  const servers = serverNames(db, placed.filter((x) => x.member.item.kind === 'mcp-server').map((x) => x.member.version.id));
  return {
    plugin: asProblem(pluginProblem(placed.map((x) => ({ ...x.member, paths: x.files, servers: servers.get(x.member.version.id) })), files)),
    bundle: asProblem(bundleProblem(placed, conflicts)),
    executable: executableOf(placed.map((x) => x.member)),
    withheld,
    group: { slug: group.slug, name: group.name, description: group.description, instructions: group.instructions, updatedAt: group.updated_at },
    target: opts.target,
    scope: opts.scope,
    items: placed.map(({ member: { item, version }, path, owner }) => ({
      id: item.id,
      kind: item.kind,
      plane: planeOf(item.kind),
      name: item.name,
      title: item.title,
      description: item.description,
      version: version.seq,
      treeSha256: version.tree_sha256,
      installPath: path,
      owner,
    })),
    conflicts,
  };
}

export interface LockFile {
  scp: string;
  group: string;
  target: Target;
  scope: InstallScope;
  generatedAt: string;
  items: { kind: Kind; name: string; id: string; version: number; treeSha256: string; path: string; owner: string }[];
}

/**
 * Where a file kind's extra files go: its per-item folder (the user-scope layout, e.g.
 * `.scp/design/<name>/`), never beside an entry placed at the project root or at an installAs path,
 * where extras like `.claude/settings.json` or `.vscode/tasks.json` would run code.
 */
function extrasDir(kind: Kind, name: string, entryPath: string, target: Target): string {
  const p = installPath(kind, name, entryPath, { target, scope: 'user' });
  return p.slice(0, p.lastIndexOf('/') + 1);
}

/** Folder kinds keep their tree under the prefix; file kinds put the entry at the path, extras in extrasDir. */
function placeTree(path: string, entryPath: string, tree: TreeFile[], extras: string): TreeFile[] {
  if (path.endsWith('/')) return tree.map((f) => ({ ...f, path: path + f.path }));
  return tree.map((f) => ({ ...f, path: f.path === entryPath ? path : extras + f.path }));
}

const enc = (s: string) => new TextEncoder().encode(s);

/** Install tree for one target, extracted at the project (or home) root, plus scp.lock.json. */
export function buildBundle(
  db: Db,
  p: Principal,
  group: GroupRow,
  opts: { target: Target; scope: InstallScope; publicUrl: string },
): { zip: Uint8Array; lock: LockFile } {
  const { placed } = place(db, p, group, opts);
  // Blobs are deduplicated, so N members sharing one large blob cost one copy on disk but N in the zip.
  // Refuses exactly what the manifest reports as `bundle`, before any tree is read.
  const problem = bundleProblem(placed, placedConflicts(placed));
  if (problem) throw problem;
  const files: TreeFile[] = [];
  const owners = new Map<string, string>(); // file path -> member name
  const folders = new Map<string, string>(); // every folder some file sits in -> member name
  // Last line of defence for every file written, SCP's own included: the same path, or a file where
  // another entry needs a folder ('scp.lock.json' vs 'scp.lock.json/x.md'), makes an unextractable zip.
  const add = (f: TreeFile, name: string) => {
    const key = pathKey(f.path);
    if (key.split('/').includes('.git')) throw badRequest(`'${name}' would write into .git ('${f.path}')`);
    const up = ancestors(key);
    const prev = owners.get(key) ?? folders.get(key) ?? up.map((d) => owners.get(d)).find((n) => n !== undefined);
    if (prev !== undefined) throw pathConflict({ path: f.path, items: [prev, name] });
    owners.set(key, name);
    for (const d of up) if (!folders.has(d)) folders.set(d, name);
    files.push(f);
  };
  for (const { member, path } of placed) {
    const { item, version } = member;
    const extras = extrasDir(item.kind, item.name, version.entry_path, opts.target);
    for (const f of placeTree(path, version.entry_path, readTree(db, version.id), extras)) add(f, item.name);
  }
  if (group.instructions.trim()) add({ path: `.scp/groups/${group.slug}/INSTRUCTIONS.md`, bytes: enc(group.instructions), mode: 420 }, 'scp');
  const lock: LockFile = {
    scp: opts.publicUrl,
    group: group.slug,
    target: opts.target,
    scope: opts.scope,
    generatedAt: now(),
    items: placed.map(({ member: { item, version }, path, owner }) => ({
      kind: item.kind,
      name: item.name,
      id: item.id,
      version: version.seq,
      treeSha256: version.tree_sha256,
      path,
      owner,
    })),
  };
  add({ path: 'scp.lock.json', bytes: enc(JSON.stringify(lock, null, 2) + '\n'), mode: 420 }, 'scp');
  // ponytail: the whole zip is built in memory, synchronously (capped at MAX_BUNDLE_BYTES); stream it
  // from a worker if groups get huge.
  return { zip: buildZip(files), lock };
}

// ---------- Claude Code plugin (docs/research/formats.md 3, PLAN-v2 D5) ----------

/** DOS zip epoch, in local time: fflate stamps entries from local getters, so these bytes are the same in every TZ. */
const PLUGIN_MTIME = new Date(1980, 0, 1);

/**
 * Where a member lands in a plugin: Claude Code's component folders; every other kind under docs/. mc52: a
 * hook's or MCP server's entry is one file plugin.json names (its other files keep their stored paths, at
 * the plugin root, where `${CLAUDE_PLUGIN_ROOT}` finds them).
 */
export function pluginPath(kind: Kind, name: string): string {
  switch (kind) {
    case 'skill':
      return `skills/${name}/`;
    case 'agent':
      return `agents/${name}.md`;
    case 'command':
      return `commands/${name}.md`;
    case 'output-style':
      return `output-styles/${name}.md`;
    case 'hook':
      return `hooks/${name}.json`;
    case 'mcp-server':
      return `mcp/${name}.json`;
    default:
      return `docs/${kind}/${name}/`;
  }
}

/** What listing a group as a plugin reads of a member (service.ts pluginMembers); a ResolvedMember is one. */
export interface PluginMember {
  item: Pick<ItemRow, 'id' | 'kind' | 'name'>;
  /** `frontmatter` is read for an output style only (styleName). */
  version: Pick<VersionRow, 'total_bytes' | 'created_at' | 'entry_path' | 'executable'> & Partial<Pick<VersionRow, 'frontmatter'>>;
  /** An executable kind's stored paths (pluginFootprint); unread for the other kinds. */
  paths?: string[];
  /** An MCP server's server names (service.ts serverNames), which pluginConflicts compares. */
  servers?: string[];
}

/**
 * mc52: the effective members that act on the installing machine as a plugin (their served version's
 * `executable`: hooks, MCP servers, skills and commands that run code, forced output styles), derived from
 * them (never stored on the group, so it cannot drift); null when none.
 */
export interface ExecutableFlag {
  kinds: Kind[];
  items?: { id: string; kind: Kind; name: string }[];
}
/** The order `kinds` lists them in. */
const FLAG_KINDS: Kind[] = [...EXECUTABLE_KINDS, 'skill', 'command', 'output-style'];

export function executableOf(members: { item: Pick<ItemRow, 'id' | 'kind' | 'name'>; version: Pick<VersionRow, 'executable'> }[], withItems = true): ExecutableFlag | null {
  const exec = members.filter((m) => m.version.executable).map((m) => m.item);
  if (!exec.length) return null;
  const kinds = FLAG_KINDS.filter((k) => exec.some((i) => i.kind === k));
  return withItems ? { kinds, items: exec.map((i) => ({ id: i.id, kind: i.kind, name: i.name })) } : { kinds };
}

/** mc52: what the marketplace entry's and plugin.json's description start with when the plugin carries a member that runs code. */
export const RUNS_CODE = 'Runs code (hooks, MCP servers): ';
/** Review (output-style-force): and when it carries a forced output style. */
export const FORCES_STYLE = 'Forces an output style: ';
export const flagPrefix = (f: ExecutableFlag | null) =>
  f ? (f.kinds.some((k) => k !== 'output-style') ? RUNS_CODE : '') + (f.kinds.includes('output-style') ? FORCES_STYLE : '') : '';
/**
 * The plugin description: the flag prefix, then the group's own, trimmed; with no description of its own (or only
 * whitespace, which would leave the prefix's ': ' dangling) the prefix drops its trailing ': '.
 */
export function flaggedDescription(f: ExecutableFlag | null, description: string): string {
  const d = description.trim();
  return d ? flagPrefix(f) + d : flagPrefix(f).replace(/: $/, '');
}
/** mc52: the warning MCP get_group and get_bundle carry with an `executable` flag. */
export const EXECUTABLE_WARNING =
  "This group holds items that run commands on the installing machine when the group is installed as a Claude Code plugin (hooks, MCP servers, skills or commands that run shell), or an output style that replaces the user's own there. Show the user which ones, and do not install the plugin without their consent.";

/** Every path a member writes in plugin.zip: its pluginPath, plus an executable kind's other stored files at their own paths. */
export function pluginFootprint(m: PluginMember): string[] {
  const at = pluginPath(m.item.kind, m.item.name);
  return isExecutable(m.item.kind) ? [at, ...(m.paths ?? []).filter((p) => p !== m.version.entry_path)] : [at];
}

/** SCP's own files in every plugin.zip (buildPlugin): an executable member's file there is a conflict like any other. */
const PLUGIN_OWN = ['.claude-plugin/plugin.json', '.mcp.json'];

/**
 * `<yyyymmdd>.<hhmmssmmm>` (UTC) of the latest change: the newest member version, or the group row,
 * which every membership, pin and include change touches, inside an included group too (service.ts
 * touch walks up the includes). A clock, not a sum of version numbers, so pinning a member back or
 * swapping one still climbs, and two different trees never share a version.
 */
export function pluginVersion(group: GroupRow, members: PluginMember[]): string {
  const latest = members.reduce((d, m) => (m.version.created_at > d ? m.version.created_at : d), group.updated_at);
  return `${latest.slice(0, 10).replaceAll('-', '')}.${latest.slice(11, 23).replace(/[:.]/g, '')}`;
}

/**
 * Members at one plugin path. pluginPath is kind and name alone (installAs does not apply, extras
 * stay under docs/<kind>/<name>/), so this is two members of one kind with the same name as pathKey
 * sees it, which two owners can produce; the folder is the unit, whatever files are in it. mc52: an
 * executable member's other files sit at their stored paths, so two hooks both shipping
 * scripts/format.sh, or one writing into another member's folder or over SCP's own files, conflict too.
 * So do two MCP servers declaring one server name: Claude Code keeps whichever loads last, the other gone
 * without a word. Each name is a pseudo-path `mcpServers:<name>` (URI-encoded, so a '/' in it is no
 * folder), which no stored path can be (':' is refused in paths). Review (outputstyle-prefix-not-pinned):
 * likewise two output styles under one name (styleName), `outputStyle:<name>`: Claude Code lists a plugin's
 * styles by that name, so one of them would be unreachable.
 */
export const pluginConflicts = (members: PluginMember[]): Conflict[] =>
  findConflicts([
    ...PLUGIN_OWN.map((path) => ({ path, name: 'scp', id: '' })),
    ...members.flatMap((m) => pluginFootprint(m).map((path) => ({ path, name: m.item.name, id: m.item.id }))),
    ...members.flatMap((m) => [...new Set(m.servers)].map((s) => ({ path: `mcpServers:${encodeURIComponent(s)}`, name: m.item.name, id: m.item.id }))),
    ...members.filter((m) => m.item.kind === 'output-style').map((m) => ({ path: `outputStyle:${encodeURIComponent(styleName(m))}`, name: m.item.name, id: m.item.id })),
  ]);

/** An output style's name in Claude Code: its frontmatter `name`, else its file name, which in a plugin is the item's. */
function styleName(m: PluginMember): string {
  const n: unknown = m.version.frontmatter ? (JSON.parse(m.version.frontmatter) as Record<string, unknown>).name : undefined;
  return typeof n === 'string' && n.trim() ? n : m.item.name;
}

/**
 * The error buildPlugin throws for these members (holding `files` across their versions), or null,
 * without reading a file: the files cap place() applies to every other download, the size cap, then
 * pluginConflicts. The marketplace lists a group exactly when this is null, and the manifest reports
 * it as `plugin`, so listing, manifest and builder agree.
 */
export function pluginProblem(members: PluginMember[], files: number): HttpError | null {
  if (files > MAX_GROUP_FILES) return groupFull(files);
  const total = totalBytes(members);
  if (total > MAX_BUNDLE_BYTES) return tooLargeBundle(total);
  const [c] = pluginConflicts(members);
  return c ? pathConflict(c) : null;
}

export interface PluginBuild {
  zip: Uint8Array;
  sha256: string;
  version: string;
  items: number;
}

/**
 * plugin.zip for a group: `.claude-plugin/plugin.json`, components at pluginPath, and `.mcp.json`
 * pointing at the group's MCP endpoint with `token` as the bearer. Deterministic bytes for one
 * effective tree (sorted entries, fixed mtime), so the marketplace sha256 is stable. installAs does
 * not apply: the layout is Claude Code's. Refuses exactly what pluginProblem reports; `add` below is
 * the last line of defence for every file written, SCP's own included.
 */
export function buildPlugin(db: Db, group: GroupRow, members: ResolvedMember[], opts: { publicUrl: string; token: string }): PluginBuild {
  const servers = serverNames(db, members.filter((m) => m.item.kind === 'mcp-server').map((m) => m.version.id));
  const withPaths = members.map((m) => (isExecutable(m.item.kind) ? { ...m, paths: listFiles(db, m.version.id).map((f) => f.path), servers: servers.get(m.version.id) } : m));
  const problem = pluginProblem(withPaths, fileCount(db, members.map((m) => m.version.id)));
  if (problem) throw problem;
  const files: TreeFile[] = [];
  const owners = new Map<string, string>(); // pathKey -> member name
  const add = (f: TreeFile, name: string) => {
    const key = pathKey(f.path);
    if (key.split('/').includes('.git')) throw badRequest(`'${name}' would write into .git ('${f.path}')`);
    const prev = owners.get(key);
    if (prev !== undefined) throw pathConflict({ path: f.path, items: [prev, name] });
    owners.set(key, name);
    files.push(f);
  };
  for (const { item, version } of members) {
    const at = pluginPath(item.kind, item.name);
    // An executable kind's other files resolve against the plugin root (${CLAUDE_PLUGIN_ROOT}/scripts/x.sh): stored paths, no folder of their own.
    const extras = isExecutable(item.kind) ? '' : `docs/${item.kind}/${item.name}/`;
    for (const f of placeTree(at, version.entry_path, readTree(db, version.id), extras)) add(f, item.name);
  }
  const version = pluginVersion(group, members);
  const json = (v: unknown) => enc(JSON.stringify(v, null, 2) + '\n');
  // mc52: Claude Code merges these with hooks/hooks.json (which it loads by itself, so a hook named 'hooks' is not listed again) and SCP's own .mcp.json.
  const listed = (kind: Kind, skip?: string) => members.filter((m) => m.item.kind === kind && m.item.name !== skip).map((m) => `./${pluginPath(kind, m.item.name)}`).sort();
  const hooks = listed('hook', 'hooks');
  const mcpServers = listed('mcp-server');
  const description = flaggedDescription(executableOf(members), group.description);
  add({ path: '.claude-plugin/plugin.json', bytes: json({ name: group.slug, version, description, ...(hooks.length ? { hooks } : {}), ...(mcpServers.length ? { mcpServers } : {}) }), mode: 420 }, 'scp');
  const server = { type: 'http', url: `${opts.publicUrl}/mcp/${group.slug}`, headers: { Authorization: `Bearer ${opts.token}` } };
  add({ path: '.mcp.json', bytes: json({ mcpServers: { [`scp-${group.slug}`]: server } }), mode: 420 }, 'scp');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const zip = buildZip(files, { mtime: PLUGIN_MTIME });
  return { zip, sha256: sha256Hex(zip), version, items: members.length };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
const SECTIONS: [Plane, string][] = [
  ['skill', 'Skills'],
  ['md', 'Prompts & MDs'],
  ['artifact', 'Artifacts'],
];

/** Roster in the AIBootstrap table style; one row per readable member, full descriptions. */
export function catalogMarkdown(db: Db, p: Principal, group: GroupRow): string {
  const { placed } = place(db, p, group, { target: 'claude-code', scope: 'project' });
  const out = [`# ${group.name.replace(/\s+/g, ' ')}`, ''];
  if (group.description.trim()) out.push(group.description.trim(), '');
  for (const [plane, heading] of SECTIONS) {
    const rows = placed.filter((x) => planeOf(x.member.item.kind) === plane);
    if (!rows.length) continue;
    out.push(`## ${heading}`, '', '| Name | Kind | What it does | Version | Install path |', '|---|---|---|---|---|');
    for (const { member: { item, version }, path } of rows) {
      out.push(`| ${item.name} | ${item.kind} | ${cell(item.description || item.title)} | ${version.seq} | \`${cell(path)}\` |`);
    }
    out.push('');
  }
  return out.join('\n');
}
