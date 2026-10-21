import { now, type Db } from '../db.ts';
import { HttpError, badRequest } from '../lib/http.ts';
import { pathKey } from '../lib/paths.ts';
import { buildZip } from '../lib/zip.ts';
import type { TreeFile } from '../lib/tree.ts';
import { itemSummary, listFiles, readTree } from '../items/service.ts';
import { MAX_GROUP_FILES, resolvedMembers, type ResolvedMember } from './service.ts';
import { planeOf, type GroupRow, type Kind, type Plane, type Principal } from '../types.ts';

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
const PATHS: Record<Target, Record<Kind, PathFn>> = {
  'claude-code': {
    skill: (n) => `.claude/skills/${n}/`,
    agent: (n) => `.claude/agents/${n}.md`,
    command: (n) => `.claude/commands/${n}.md`,
    instructions: (_n, _e, user) => (user ? '.claude/CLAUDE.md' : 'AGENTS.md'),
    design: (n, _e, user) => (user ? `.scp/design/${n}/DESIGN.md` : 'DESIGN.md'),
    prompt: (n) => `.scp/prompts/${n}.md`,
    package: (n) => `.scp/packages/${n}/`,
    artifact: (n, e) => `.scp/artifacts/${n}/${e}`,
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

export const pathConflict = (c: Conflict) =>
  new HttpError(409, 'path_conflict', `${c.items.map((n) => `'${n}'`).join(' and ')} both install to '${c.path}'`, c);

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

export interface Manifest {
  group: { slug: string; name: string; description: string; instructions: string; updatedAt: string };
  target: Target;
  scope: InstallScope;
  items: ManifestItem[];
  conflicts: Conflict[];
}

interface Placed {
  member: ResolvedMember;
  path: string;
  paths: string[];
  owner: string;
}

function place(db: Db, p: Principal, group: GroupRow, opts: InstallOpts): Placed[] {
  checkInstallOpts(opts);
  const members = resolvedMembers(db, p, group);
  // Member adds enforce the cap, but unpinned members follow their latest version, which can grow
  // past it later; count before listing (and conflict-checking) every file of every member.
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM version_files WHERE version_id IN (SELECT value FROM json_each(?))')
    .get(JSON.stringify(members.map((m) => m.version.id))) as { n: number };
  if (n > MAX_GROUP_FILES) throw new HttpError(400, 'group_full', `this group's members hold ${n} files; groups are limited to ${MAX_GROUP_FILES}`);
  return members.map((m) => {
    const o = { ...opts, installAs: m.installAs };
    const files = listFiles(db, m.version.id).map((f) => f.path);
    return {
      member: m,
      path: installPath(m.item.kind, m.item.name, m.version.entry_path, o),
      paths: footprint(m.item.kind, m.item.name, m.version.entry_path, files, o),
      owner: itemSummary(db, m.item).owner.username,
    };
  });
}

const placedConflicts = (placed: Placed[]) =>
  findConflicts(placed.flatMap((x) => x.paths.map((path) => ({ path, name: x.member.item.name, id: x.member.item.id }))));

/** Catalog for agents: what the group holds and where each piece installs. No file bodies. */
export function buildManifest(db: Db, p: Principal, group: GroupRow, opts: { target: Target; scope: InstallScope }): Manifest {
  const placed = place(db, p, group, opts);
  return {
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
    conflicts: placedConflicts(placed),
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
  const placed = place(db, p, group, opts);
  // Blobs are deduplicated, so N members sharing one large blob cost one copy on disk but N in the zip.
  const total = placed.reduce((n, x) => n + x.member.version.total_bytes, 0);
  if (total > MAX_BUNDLE_BYTES) {
    throw new HttpError(413, 'bundle_too_large', `this group is ${Math.ceil(total / MB)} MB uncompressed; bundles are limited to ${MAX_BUNDLE_BYTES / MB} MB`);
  }
  const conflicts = placedConflicts(placed);
  if (conflicts.length) throw pathConflict(conflicts[0]);
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

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
const SECTIONS: [Plane, string][] = [
  ['skill', 'Skills'],
  ['md', 'Prompts & MDs'],
  ['artifact', 'Artifacts'],
];

/** Roster in the AIBootstrap table style; one row per readable member, full descriptions. */
export function catalogMarkdown(db: Db, p: Principal, group: GroupRow): string {
  const placed = place(db, p, group, { target: 'claude-code', scope: 'project' });
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
