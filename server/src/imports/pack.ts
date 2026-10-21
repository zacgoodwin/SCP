import { requireScope } from '../auth/middleware.ts';
import { tx, type Db } from '../db.ts';
import { addMemberTx, createGroup } from '../groups/service.ts';
import { addVersion, createItemTx, getItemRow, listFiles, resolveVersion, slugify, type Lint } from '../items/service.ts';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { HttpError, badRequest } from '../lib/http.ts';
import { isJunkPath } from '../lib/paths.ts';
import { stripTopFolder, type TreeFile } from '../lib/tree.ts';
import { PACK_LIMITS, safeUnzip } from '../lib/zip.ts';
import type { Ctx, GroupRow, ItemRow, ItemSource, Kind, Principal } from '../types.ts';

export const MAX_ITEMS = 200;

/** One item-to-be inside an imported tree. */
export interface Unit {
  /** Folder or file path inside the tree; '' is the root. Becomes source_path (joined to the import's base path). */
  path: string;
  kind: Kind;
  tree: TreeFile[];
  name?: string;
  fallbackName: string;
  folderName?: string;
  /** 'tree' for a root unit that took the whole tree deliberately (a folder import), so updateTree keeps it whole; else derived (importUnit). */
  scope?: 'tree';
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface UnitResult {
  item: ItemRow;
  op: 'create' | 'version' | 'unchanged';
}

export interface ImportOutcome {
  group: GroupRow | null;
  results: UnitResult[];
  skipped: Skipped[];
}

export interface ImportOpts {
  /** Import-level provenance; `path` is the base folder every unit path is joined to. */
  source: ItemSource;
  /** Name of last resort for a root-level unit (repo, folder or zip name). */
  rootName: string;
  /** The folder the tree was re-rooted at (GitHub `path`); a layout folder names the kind of its loose .md files. */
  layoutDir?: string;
  /** The tree is one folder (a GitHub `path`, a zip's stripped wrapper), not a repository root: a SKILL.md in it is the whole folder's. */
  folderRoot?: boolean;
  note: string;
  visibility?: 'private' | 'public';
  /** Treat the whole tree as one item of this kind (no detection). */
  kind?: Kind;
  name?: string;
  group?: string;
  groupName?: string;
}

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
const INSTRUCTION_FILES = new Set(['agents.md', 'claude.md', 'gemini.md']);
/** README/LICENSE-style names, with a locale or variant suffix (README.de.md), never a stem that merely starts so (security-review.md). */
const REPO_DOCS = /^(readme|licen[cs]e|changelog|contributing|code_of_conduct|security)(\.[^/]*)?\.md$/i;
const SKILL_DIRS = ['.claude/skills', 'skills'];
/** [folder, kind, named by file]: commands and prompts are invoked by file name, agents by frontmatter name. */
const FILE_DIRS: [string, Kind, boolean][] = [
  ['.claude/agents', 'agent', false],
  ['.claude/commands', 'command', true],
  ['agents', 'agent', false],
  ['commands', 'command', true],
  ['prompts', 'prompt', true],
];
const ROOT_FILES: [string, Kind][] = [['AGENTS.md', 'instructions'], ['CLAUDE.md', 'instructions'], ['DESIGN.md', 'design']];
/** A lone top folder with one of these names is the layout, not packaging (`zip -r commands.zip commands/`). */
const LAYOUT_DIRS = new Set(['skills', 'agents', 'commands', 'prompts', '.claude', '.claude-plugin']);

const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const stem = (file: string) => file.replace(/\.(md|markdown)$/i, '');
const isMd = (p: string) => /\.md$/i.test(p);
/** A skill's entry in any case; the unit re-homes it to SKILL.md the way mdKind does for a loose file. */
const isSkillMd = (name: string) => name.toLowerCase() === 'skill.md';
/** A skill unit's files: the root entry, in whatever case the tree spelled it, lives at SKILL.md. */
const skillTree = (files: TreeFile[]) => files.map((f) => (isSkillMd(f.path) ? { ...f, path: 'SKILL.md' } : f));
const NOT_AN_ITEM = 'repository documentation, not an item';

/**
 * Unzip an untrusted pack: junk dropped, one wrapper folder stripped (GitHub always adds one) unless it
 * is a layout folder. Pack caps, not a version's: each unit is held to those as it becomes an item.
 */
export function unpack(bytes: Uint8Array, keep?: (name: string) => boolean): { files: TreeFile[]; top: string | null } {
  const files = safeUnzip(bytes, keep, PACK_LIMITS).filter((f) => !isJunkPath(f.path));
  const stripped = stripTopFolder(files);
  return stripped.top && LAYOUT_DIRS.has(stripped.top) ? { files, top: null } : stripped;
}

/**
 * safeUnzip predicate for a GitHub zipball: the entries at or under `path` below the one top folder
 * GitHub wraps the repository in, so the rest of a monorepo is never counted, sized or inflated.
 */
export function underPath(path: string | null): ((name: string) => boolean) | undefined {
  if (path === null) return undefined;
  return (name) => {
    const i = name.indexOf('/');
    if (i < 0) return false;
    const rest = name.slice(i + 1);
    return rest === path || rest.startsWith(path + '/');
  };
}

/** The files at or under path, re-rooted there; the whole tree when path is null. */
export function subtree(tree: TreeFile[], path: string | null): TreeFile[] {
  if (!path) return tree;
  const out: TreeFile[] = [];
  for (const f of tree) {
    if (f.path === path) out.push({ ...f, path: baseOf(f.path) });
    else if (f.path.startsWith(path + '/')) out.push({ ...f, path: f.path.slice(path.length + 1) });
  }
  return out;
}

/**
 * importUpload's .md rules (items/import.ts), mirrored: that function creates the item itself and
 * takes no source. Tree kinds need their entry at the root, so the file is re-homed like there.
 */
function mdKind(file: string, text: string): { kind: Kind; path: string } {
  const fm = parseFrontmatter(text);
  const lower = file.toLowerCase();
  if (INSTRUCTION_FILES.has(lower) && !fm.hasFrontmatter) return { kind: 'instructions', path: file };
  if (lower === 'design.md') return { kind: 'design', path: 'DESIGN.md' };
  if (lower === 'skill.md') return { kind: 'skill', path: 'SKILL.md' };
  if (fm.data.name && fm.data.description) return { kind: 'agent', path: file };
  return { kind: 'prompt', path: file };
}

/**
 * Pack layout detection (docs/PLAN-v2.md D1), in order; a file belongs to the first unit that claims it.
 * Plugin (`.claude-plugin/plugin.json`) and `.claude/` layouts share the same folders, so the plugin
 * marker itself adds nothing. `layoutDir` is the folder a GitHub `path` re-rooted the tree at: when it
 * is a FILE_DIRS folder (agents, commands, prompts), the loose .md files at the root are that kind.
 * `folderRoot` says the tree is one folder, not a repository root: a SKILL.md in it makes the whole
 * folder one skill (as the same folder is under skills/ in a whole-repository import), with no carving
 * of CLAUDE.md or agents/*.md into items of their own.
 */
export function detectUnits(tree: TreeFile[], rootName: string, opts: { layoutDir?: string; folderRoot?: boolean } = {}): { units: Unit[]; skipped: Skipped[] } {
  const units: Unit[] = [];
  const skipped: Skipped[] = [];
  const claimed = new Set<string>();
  const free = () => tree.filter((f) => !claimed.has(f.path));
  const under = (f: TreeFile, dir: string) => (f.path.startsWith(dir + '/') ? f.path.slice(dir.length + 1).split('/') : null);
  const rootSkillMd = tree.find((f) => !f.path.includes('/') && isSkillMd(f.path));
  if (opts.folderRoot && rootSkillMd) return { units: [{ path: '', kind: 'skill', tree: skillTree(tree), fallbackName: rootName, folderName: rootName, scope: 'tree' }], skipped };
  // The files under every folder (each ancestor), indexed once in tree order: a folder unit that
  // filtered the whole tree made detection O(folders x files), tens of seconds of blocked event loop
  // for a pack of 10,000 skill folders, before MAX_ITEMS was even checked.
  const byDir = new Map<string, TreeFile[]>();
  for (const f of tree) {
    for (let i = f.path.indexOf('/'); i >= 0; i = f.path.indexOf('/', i + 1)) {
      const dir = f.path.slice(0, i);
      let list = byDir.get(dir);
      if (!list) byDir.set(dir, (list = []));
      list.push(f);
    }
  }
  const folderUnit = (dir: string) => {
    const files = (byDir.get(dir) ?? []).filter((f) => !claimed.has(f.path));
    for (const f of files) claimed.add(f.path);
    units.push({ path: dir, kind: 'skill', tree: skillTree(subtree(files, dir)), fallbackName: baseOf(dir), folderName: baseOf(dir) });
  };
  const fileUnit = (f: TreeFile, kind: Kind, opts: { name?: string; fallbackName?: string; path?: string } = {}) => {
    claimed.add(f.path);
    const file = baseOf(f.path);
    units.push({ path: f.path, kind, tree: [{ ...f, path: opts.path ?? file }], name: opts.name, fallbackName: opts.fallbackName ?? stem(file) });
  };
  // A README inside agents/, commands/ or prompts/ would otherwise ship as a slash command named 'readme'.
  const fileDirUnit = (f: TreeFile, file: string, kind: Kind, byFile: boolean) => {
    if (REPO_DOCS.test(file)) {
      claimed.add(f.path);
      skipped.push({ path: f.path, reason: NOT_AN_ITEM });
    } else fileUnit(f, kind, { name: byFile ? slugify(stem(file)) || undefined : undefined });
  };

  for (const dir of SKILL_DIRS) {
    for (const f of tree) {
      const rest = under(f, dir);
      if (rest?.length === 2 && isSkillMd(rest[1]) && !claimed.has(f.path)) folderUnit(`${dir}/${rest[0]}`);
    }
  }
  for (const [dir, kind, byFile] of FILE_DIRS) {
    for (const f of tree) {
      const rest = under(f, dir);
      if (rest?.length === 1 && isMd(rest[0]) && !claimed.has(f.path)) fileDirUnit(f, rest[0], kind, byFile);
    }
  }
  const hinted = opts.layoutDir ? FILE_DIRS.find(([dir]) => baseOf(dir) === opts.layoutDir) : undefined;
  if (hinted) {
    for (const f of tree) if (!f.path.includes('/') && isMd(f.path) && !claimed.has(f.path)) fileDirUnit(f, f.path, hinted[1], hinted[2]);
  }
  // Any other folder holding a SKILL.md, shallowest first, so a skill keeps a nested example skill as its own files.
  const byDepth = (a: TreeFile, b: TreeFile) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path);
  for (const f of [...tree].sort(byDepth)) {
    if (f.path.includes('/') && isSkillMd(baseOf(f.path)) && !claimed.has(f.path)) folderUnit(dirOf(f.path));
  }
  // Root instruction/design files (exact case) come out before a root SKILL.md, in any case like a
  // folder's (README: "skill.md in any case counts"), takes every remaining file as its own.
  const root = (name: string) => tree.find((f) => f.path === name && !claimed.has(f.path));
  for (const [name, kind] of ROOT_FILES) {
    const f = root(name);
    if (f) fileUnit(f, kind, { fallbackName: rootName });
  }
  if (rootSkillMd && !claimed.has(rootSkillMd.path)) {
    const files = free();
    for (const f of files) claimed.add(f.path);
    units.push({ path: '', kind: 'skill', tree: skillTree(files), fallbackName: rootName, folderName: rootName });
  }
  const rest = free();
  if (!units.length && rest.length && rest.every((f) => isMd(f.path))) {
    for (const f of rest) {
      if (REPO_DOCS.test(baseOf(f.path))) skipped.push({ path: f.path, reason: NOT_AN_ITEM });
      else {
        const { kind, path } = mdKind(baseOf(f.path), utf8.decode(f.bytes));
        fileUnit(f, kind, { path });
      }
    }
  } else {
    // What detection passed over, so the import says why (docs/PLAN-v2.md D1: unknown units land in
    // skipped, and a 400 nothing_to_import carries them too): a folder under a skills/ dir with no
    // SKILL.md, a .md nested below a layout folder that takes its files at one level, and any other
    // loose .md apart from README-style docs, which a repository is expected to carry.
    const folders = new Set<string>();
    for (const f of rest) {
      const dir = SKILL_DIRS.find((d) => f.path.startsWith(d + '/'));
      const inner = dir ? f.path.slice(dir.length + 1) : '';
      if (dir && inner.includes('/')) folders.add(`${dir}/${inner.slice(0, inner.indexOf('/'))}`);
      else if (isMd(f.path) && !REPO_DOCS.test(baseOf(f.path))) {
        const fileDir = FILE_DIRS.find(([d]) => f.path.startsWith(d + '/'))?.[0];
        skipped.push({ path: f.path, reason: fileDir ? `nested under ${fileDir}/: only ${fileDir}/*.md is imported` : 'not inside a recognised layout folder' });
      }
    }
    for (const folder of folders) skipped.push({ path: folder, reason: 'no SKILL.md in this folder' });
  }
  return { units, skipped };
}

const reasonOf = (e: HttpError) =>
  e.code === 'lint_failed' && Array.isArray(e.details)
    ? (e.details as Lint[]).filter((l) => l.level === 'error').map((l) => l.message).join('; ') || e.message
    : e.message;

/**
 * A new version of an imported item from its source tree, with the provenance moved to `source`.
 * The tree is compared to what the source last wrote (source_tree_sha256), not to the latest
 * version: a commit elsewhere in the repository moves HEAD while this path is byte-identical, and
 * re-applying it would write the stale upstream tree over a local edit made since the import. A tree
 * equal to either adds no version (op 'unchanged') but still records the commit it was checked against.
 */
export function versionFromSource(ctx: Ctx, p: Principal, item: ItemRow, tree: TreeFile[], source: ItemSource, note: string): UnitResult {
  const { db } = ctx;
  return tx(db, () => {
    const prev = resolveVersion(db, item);
    db.exec('SAVEPOINT ver');
    const v = addVersion(ctx, p, item, { tree, note });
    // Items imported before source_tree_sha256 was recorded fall back to the latest version.
    const changed = v.tree_sha256 !== prev.tree_sha256 && v.tree_sha256 !== (item.source_tree_sha256 ?? prev.tree_sha256);
    db.exec(changed ? 'RELEASE ver' : 'ROLLBACK TO ver; RELEASE ver');
    db.prepare('UPDATE items SET source_ref = ?, source_commit = ?, source_tree_sha256 = ? WHERE id = ?').run(source.ref, source.commit, v.tree_sha256, item.id);
    return { item: getItemRow(db, item.id)!, op: changed ? 'version' : 'unchanged' };
  });
}

/**
 * The tree a source/update versions a skill from: the source_path subtree, carved the way the import
 * carved it (source_scope). A root SKILL.md import ('root') leaves sibling units (AGENTS.md,
 * agents/*.md) to their own items, while a `skills/<name>/` folder or a kind override ('tree') takes
 * the whole folder. Items imported before the scope was recorded infer it from the stored version:
 * it holds none of the files detection would carve out exactly when the import carved them too (which
 * misreads a whole-folder import once upstream renamed every carvable file). Other kinds are one
 * file or a whole tree either way.
 */
export function updateTree(db: Db, item: ItemRow, tree: TreeFile[]): TreeFile[] {
  // A loose .md the md-only fallback re-homed (docs/design.md -> DESIGN.md, skill.md -> SKILL.md) is re-homed the same way.
  if (tree.length === 1 && !tree[0].path.includes('/')) {
    const { kind, path } = mdKind(tree[0].path, utf8.decode(tree[0].bytes));
    if (kind === item.kind) return [{ ...tree[0], path }];
  }
  if (item.kind !== 'skill') return tree;
  // The root entry is re-homed to SKILL.md as the import did (a folder's skill.md in any case), whatever the scope.
  const whole = skillTree(tree);
  if (item.source_scope === 'tree') return whole;
  const root = detectUnits(tree, item.name).units.find((u) => u.path === '' && u.kind === 'skill');
  if (!root || root.tree.length === tree.length) return whole;
  if (item.source_scope === 'root') return root.tree;
  const carved = new Set(whole.map((f) => f.path));
  for (const f of root.tree) carved.delete(f.path);
  const stored = listFiles(db, resolveVersion(db, item).id);
  return stored.some((f) => carved.has(f.path)) ? whole : root.tree;
}

/** GitHub resolves repository names case-insensitively, and a zip's name is a file name on a case-insensitive disk. */
const sameRepo = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

function importUnit(ctx: Ctx, p: Principal, u: Unit, opts: ImportOpts): UnitResult {
  const source: ItemSource = { ...opts.source, path: [opts.source.path, u.path].filter(Boolean).join('/') || null };
  // The root detection unit is the one carved from its siblings; a kind override, a folder import or any folder unit took the whole tree (updateTree).
  const sourceScope: NonNullable<ItemRow['source_scope']> = u.scope ?? (!opts.kind && u.path === '' && u.kind === 'skill' ? 'root' : 'tree');
  const input = { kind: u.kind, name: u.name, tree: u.tree, visibility: opts.visibility, source, sourceScope, note: opts.note, fallbackName: u.fallbackName, folderName: u.folderName };
  try {
    return { item: createItemTx(ctx, p, input), op: 'create' };
  } catch (e) {
    if (!(e instanceof HttpError) || e.code !== 'name_taken') throw e;
    const holder = ctx.db
      .prepare('SELECT * FROM items WHERE owner_id = ? AND kind = ? AND name = ?')
      .get(p.userId, u.kind, (e.details as { name: string }).name) as ItemRow | undefined;
    // Re-import = update, only when the item holding the name is this very unit (same repo and path):
    // a unit renamed upstream must not write its new name into the item that kept the old one.
    if (!holder || !sameRepo(holder.source_repo, source.repo) || holder.source_path !== source.path) {
      // A zip is identified by its file name (docs/PLAN-v2.md D1), so a renamed download reads as a new pack: say so.
      if (holder?.source_kind === 'zip') throw new HttpError(409, 'name_taken', `${e.message}, imported from ${holder.source_repo}; upload the file under that name to update it`, e.details);
      throw e;
    }
    // The same commit (or the same zip) again: nothing changed upstream, so a local edit made since stays
    // the latest version. The ref still follows the one named (a tag, then the branch at the same commit).
    if (holder.source_commit === source.commit) {
      if (holder.source_ref !== source.ref) ctx.db.prepare('UPDATE items SET source_ref = ? WHERE id = ?').run(source.ref, holder.id);
      return { item: getItemRow(ctx.db, holder.id)!, op: 'unchanged' };
    }
    return versionFromSource(ctx, p, holder, u.tree, source, opts.note);
  }
}

/**
 * Import every unit of a tree, plus the group when asked, in one transaction. A unit that fails
 * (lint, name taken by an unrelated item, install-path conflict) is rolled back on its own and
 * reported in `skipped`; only the group slug being taken fails the whole import.
 */
export function importTree(ctx: Ctx, p: Principal, tree: TreeFile[], opts: ImportOpts): ImportOutcome {
  requireScope(p, 'write');
  if (p.groupIds) throw new HttpError(403, 'restricted_key', 'a group-restricted API key cannot import items');
  let units: Unit[];
  let skipped: Skipped[] = [];
  // A tree has no format, which every artifact needs (checkFormat): the single-file import is the way in.
  if (opts.kind === 'artifact') throw badRequest('an artifact imports from a single file, not from a repository or pack');
  if (opts.kind) units = [{ path: '', kind: opts.kind, tree, name: opts.name, fallbackName: opts.rootName, folderName: opts.rootName }];
  else {
    ({ units, skipped } = detectUnits(tree, opts.rootName, { layoutDir: opts.layoutDir, folderRoot: opts.folderRoot }));
    if (opts.name !== undefined) {
      if (units.length !== 1) throw badRequest(`name applies to an import of exactly one item (found ${units.length})`);
      units[0].name = opts.name;
    }
  }
  // The skip reasons travel as details, like the 422 below, so the UI can list what was passed over and why.
  if (!units.length) throw new HttpError(400, 'nothing_to_import', 'no skills, agents, commands, prompts, instructions or design files found', skipped.length ? skipped : undefined);
  if (units.length > MAX_ITEMS) throw new HttpError(400, 'too_many_items', `at most ${MAX_ITEMS} items per import (found ${units.length})`);
  const { db } = ctx;
  return tx(db, () => {
    const group = opts.group ? createGroup(ctx, p, { slug: opts.group, name: opts.groupName ?? opts.rootName }) : null;
    const results: UnitResult[] = [];
    for (const u of units) {
      db.exec('SAVEPOINT unit');
      try {
        const r = importUnit(ctx, p, u, opts);
        if (group) addMemberTx(ctx, p, group, { itemId: r.item.id });
        db.exec('RELEASE unit');
        results.push(r);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        db.exec('ROLLBACK TO unit; RELEASE unit');
        skipped.push({ path: u.path, reason: reasonOf(e) });
      }
    }
    // Nothing imported is a failure, not a 201 with an empty list a script would record as success; and no
    // group either: an empty one would commit, burn its slug (deleted_group_slugs) and send the UI away
    // from the skip reasons, which travel in the error details instead.
    if (!results.length) throw new HttpError(422, 'nothing_imported', group ? 'every unit was skipped, so the group was not created' : 'every unit was skipped', skipped);
    return { group, results, skipped };
  });
}
