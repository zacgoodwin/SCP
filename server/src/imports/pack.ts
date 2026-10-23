import { importLimit } from '../admin/settings.ts';
import { requireScope } from '../auth/middleware.ts';
import { tx, type Db } from '../db.ts';
import { addMemberTx, createGroup } from '../groups/service.ts';
import { addVersion, createItemTx, getItemRow, listFiles, resolveVersion, slugify, type Lint } from '../items/service.ts';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { HttpError, MB, badRequest } from '../lib/http.ts';
import { isJunkPath, normalizePath } from '../lib/paths.ts';
import { stripTopFolder, type TreeFile } from '../lib/tree.ts';
import { PACK_LIMITS, safeUnzip, type ZipLimits, type ZipLink } from '../lib/zip.ts';
import { MARKETPLACE_JSON, PLUGIN_JSON, isObject, marketplaceIgnored, parseManifest, pluginMeta, shownValue } from './manifest.ts';
import type { Ctx, GroupRow, ItemRow, ItemSource, Kind, Principal } from '../types.ts';

export const ARTIFACT_FROM_TREE = 'an artifact imports from a single file, not from a repository or pack';

/** One item-to-be inside an imported tree. */
export interface Unit {
  /** Folder or file path inside the tree; '' is the root. Becomes source_path (joined to the import's base path). */
  path: string;
  kind: Kind;
  tree: TreeFile[];
  name?: string;
  fallbackName: string;
  folderName?: string;
  /** 'tree' for a root unit that took the whole tree deliberately (a folder import), so updateTree keeps it whole; 'root' for a plugin root's skill carved from its components; else derived (importUnit). */
  scope?: 'tree' | 'root';
  /** A folder unit's paths (relative to it) that another unit or skip took first: a source update leaves them out (updateTree). */
  carve?: string[];
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
  /** `source.path` names a file (a GitHub `path` that is one), so it is every unit's source path, not joined to the unit's. */
  pathIsFile?: boolean;
  /** Passed over before detection (a pack's symlinks, linkSkips): reported first in `skipped`. */
  skipped?: Skipped[];
  note: string;
  visibility?: 'private' | 'public';
  /** Treat the whole tree as one item of this kind (no detection). */
  kind?: Kind;
  name?: string;
  group?: string;
  /** The request's own group name: it wins over the plugin manifest's (pluginMeta). */
  groupName?: string;
  /** The group's name when neither the request nor the manifest names it (default: rootName). */
  defaultGroupName?: string;
  /** Import a repository's contributor tooling even when it ships a plugin or a skills/ folder (4ky8). */
  includeRepoTooling?: boolean;
}

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
const INSTRUCTION_FILES = new Set(['agents.md', 'claude.md', 'gemini.md', 'instructions.md']);
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
// INSTRUCTIONS.md: the real file behind `CLAUDE.md -> INSTRUCTIONS.md`-style links (neuledge/context).
const ROOT_FILES: [string, Kind][] = [['AGENTS.md', 'instructions'], ['CLAUDE.md', 'instructions'], ['INSTRUCTIONS.md', 'instructions'], ['DESIGN.md', 'design']];
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
/** Plugin components SCP neither stores nor serves (dnxq; docs/PLAN-v3.md: report-only until a human decides). Hooks and MCP servers run commands on every installing machine. */
const PLUGIN_COMPONENTS = ['hooks/', '.mcp.json', 'output-styles/', 'settings.json', '.lsp.json', 'monitors/'];
const join = (root: string, p: string) => (root ? `${root}/${p}` : p);
/** Manifest component fields (4ky8): [field, kind, named by file], as FILE_DIRS. */
const DECLARED: [string, Kind, boolean][] = [['skills', 'skill', false], ['agents', 'agent', false], ['commands', 'command', true]];
/**
 * A repository's contributor tooling (4ky8 part 2): skipped when the repository says where its product
 * lives. The folders go on a plugin or a top-level skills/ folder; the root instruction files only on a
 * plugin, since a Claude Code plugin ships no instructions while a skills repository's AGENTS.md may be
 * the product itself.
 */
const TOOLING_DIRS = ['.claude/skills', '.claude/agents', '.claude/commands', '.agents/skills', '.gemini/skills', '.opencode/skills'];
const TOOLING_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
/** Folders named for another agent tool (ypmn): a skill under one is that tool's port, ranked after every other copy. */
const PORT_DIRS = new Set(['.openclaw', '.opencode', '.gemini', '.cursor', '.kiro', '.windsurf', '.codex', 'antigravity', 'codex', 'openclaw', 'opencode', 'cursor', 'gemini']);
/** The tool a skill folder is a port for: the first folder above it named for one (its own name never counts). */
const portOf = (dir: string) => dirOf(dir).split('/').find((s) => PORT_DIRS.has(s.toLowerCase()));
/** Manifest problems listed per import: a 1 MB manifest can name half a million bad paths, each one a skipped entry. */
const MAX_MANIFEST_SKIPS = 500;

/**
 * The folders holding a plugin (bppq): each `.claude-plugin/plugin.json`'s, and every same-repository
 * `source` (`./x`, normalised, inside the tree) a root marketplace.json lists. A source naming another
 * repository, or escaping this one, is never followed and lands in `skipped`. Deepest first, so a
 * nested plugin claims its own files; '' is the repository root.
 */
function pluginRoots(tree: TreeFile[], skipped: { push: (s: Skipped) => void }): { roots: string[]; manifests: PluginManifest[] } {
  const roots = new Set<string>();
  const manifests: PluginManifest[] = [];
  for (const f of tree) {
    if (f.path !== PLUGIN_JSON && !f.path.endsWith('/' + PLUGIN_JSON)) continue;
    const root = dirOf(dirOf(f.path));
    roots.add(root);
    // A bad plugin.json is reported by pluginMeta when the import names a group; detection only reads its paths.
    const m = parseManifest(f.bytes);
    if (m.ok) manifests.push({ root, from: f.path, label: '', data: m.data });
  }
  const market = tree.find((f) => f.path === MARKETPLACE_JSON);
  const m = market && parseManifest(market.bytes);
  if (m && !m.ok) skipped.push(marketplaceIgnored(m.reason));
  const plugins = m && m.ok && Array.isArray(m.data.plugins) ? m.data.plugins : [];
  for (const entry of plugins) {
    const src = isObject(entry) ? entry.source : undefined;
    const name = isObject(entry) && typeof entry.name === 'string' ? entry.name.slice(0, 100) : '?';
    const shown =
      typeof src === 'string' ? `'${src.slice(0, 200)}'` : isObject(src) ? `${shownValue(src.source, 40)} ${shownValue(src.repo ?? src.url ?? '', 200)}`.trim() : 'missing';
    if (typeof src !== 'string' || !(src === '.' || src.startsWith('./')) || src.includes('\\')) {
      skipped.push({ path: MARKETPLACE_JSON, reason: `plugin '${name}': source ${shown} is not a path in this repository; not followed` });
      continue;
    }
    const root = relPath(src);
    if (root === null) skipped.push({ path: MARKETPLACE_JSON, reason: `plugin '${name}': source ${shown} escapes the repository; not followed` });
    else {
      roots.add(root);
      // A marketplace entry may carry the plugin's component paths itself, relative to its source.
      manifests.push({ root, from: MARKETPLACE_JSON, label: `plugin '${name}': `, data: entry as Record<string, unknown> });
    }
  }
  const depth = (p: string) => (p ? p.split('/').length : 0);
  return { roots: [...roots].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b)), manifests };
}

/** A `./`-style relative path with `.` and `..` resolved, or null when it climbs above where it starts. */
function relPath(p: string): string | null {
  const segs: string[] = [];
  for (const s of p.split('/')) {
    if (s === '..') {
      if (segs.pop() === undefined) return null;
    } else if (s && s !== '.') segs.push(s);
  }
  return segs.join('/');
}

/** A plugin's manifest object: `from` is the file it came from, `root` the folder its paths are relative to. */
interface PluginManifest {
  root: string;
  from: string;
  /** Prefix naming the marketplace entry, '' for a plugin.json. */
  label: string;
  data: Record<string, unknown>;
}

/**
 * Where a manifest's component path (`"skills": "./src/my-skill"`, 4ky8) points in the tree, or why it
 * is refused: anything absolute, escaping the plugin root (an installed plugin cannot reach outside
 * its folder), or not a path SCP would store.
 */
function declaredPath(root: string, raw: unknown): { path: string } | { reason: string } {
  if (typeof raw !== 'string' || !raw) return { reason: 'is not a path' };
  if (raw.startsWith('/') || raw.includes('\\') || /^[A-Za-z]:/.test(raw)) return { reason: 'is not relative to the plugin; not followed' };
  const rel = relPath(raw);
  if (rel === null) return { reason: 'escapes the plugin; not followed' };
  const path = [root, rel].filter(Boolean).join('/');
  try {
    if (path) normalizePath(path);
  } catch (e) {
    return { reason: (e as Error).message };
  }
  return { path };
}

/**
 * Unzip an untrusted pack: junk dropped, one wrapper folder stripped (GitHub always adds one) unless it
 * is a layout folder. Pack caps, not a version's: each unit is held to those as it becomes an item.
 * Symlinks (`CLAUDE.md -> AGENTS.md`, `.agents/skills -> ../.claude/skills`) are left out and returned
 * in `links`, re-rooted with the files, for the import to report (linkSkips).
 */
export function unpack(bytes: Uint8Array, keep?: (name: string) => boolean, limits: ZipLimits = PACK_LIMITS): { files: TreeFile[]; top: string | null; links: ZipLink[] } {
  const links: ZipLink[] = [];
  const entries: (TreeFile | ZipLink)[] = [...safeUnzip(bytes, keep, limits, links), ...links].filter((f) => !isJunkPath(f.path));
  let { files: all, top } = stripTopFolder(entries);
  if (top && LAYOUT_DIRS.has(top)) [all, top] = [entries, null];
  const isLink = (f: TreeFile | ZipLink): f is ZipLink => 'target' in f;
  return { files: all.filter((f): f is TreeFile => !isLink(f)), top, links: all.filter(isLink) };
}

/** PACK_LIMITS with the instance's `import.max_pack_mb` (00tr) as the per-file and total cap. */
export function packLimits(ctx: Ctx): ZipLimits {
  const bytes = importLimit(ctx, 'maxPackMb') * MB;
  return { ...PACK_LIMITS, fileBytes: bytes, totalBytes: bytes };
}

/** A pack's symlinks as skip reasons. */
export const linkSkips = (links: ZipLink[]): Skipped[] => links.map((l) => ({ path: l.path, reason: `symlink to '${l.target}', not imported` }));

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
export function subtree<T extends { path: string }>(tree: T[], path: string | null): T[] {
  if (!path) return tree;
  const out: T[] = [];
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
 * Plugin (`.claude-plugin/plugin.json`) and `.claude/` layouts share the same folders. The plugin marker
 * makes its folder a plugin root (pluginRoots), whose layout folders are read like the repository
 * root's; its manifest's `displayName` (else `name`) and `description` name a group the import creates
 * (manifest.ts pluginMeta). `layoutDir` is the folder a GitHub `path` re-rooted the tree at: when it
 * is a FILE_DIRS folder (agents, commands, prompts), the loose .md files at the root are that kind.
 * `folderRoot` says the tree is one folder, not a repository root: a SKILL.md in it makes the whole
 * folder one skill (as the same folder is under skills/ in a whole-repository import), with no carving
 * of CLAUDE.md or agents/*.md into items of their own. `pluginFolder` says the tree is a plugin root
 * whose SKILL.md a whole-repository import made one skill (updateTree): only the plugin passes carve.
 */
export function detectUnits(tree: TreeFile[], rootName: string, opts: { layoutDir?: string; folderRoot?: boolean; includeRepoTooling?: boolean; pluginFolder?: boolean } = {}): { units: Unit[]; skipped: Skipped[] } {
  const units: Unit[] = [];
  const skipped: Skipped[] = [];
  /** Each claimed file's owner: the folder unit holding it, else the file itself (a file unit, a skip). */
  const claimed = new Map<string, string>();
  const free = () => tree.filter((f) => !claimed.has(f.path));
  const under = (f: TreeFile, dir: string) => (f.path.startsWith(dir + '/') ? f.path.slice(dir.length + 1).split('/') : null);
  const rootSkillMd = tree.find((f) => !f.path.includes('/') && isSkillMd(f.path));
  if (opts.folderRoot && rootSkillMd) return { units: [{ path: '', kind: 'skill', tree: skillTree(tree), fallbackName: rootName, folderName: rootName, scope: 'tree' }], skipped };
  // The files under every folder (each ancestor), indexed once in tree order: a folder unit that
  // filtered the whole tree made detection O(folders x files), tens of seconds of blocked event loop
  // for a pack of 10,000 skill folders, before the item cap was even checked.
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
    const all = byDir.get(dir) ?? [];
    const files = all.filter((f) => !claimed.has(f.path));
    // What was carved out of the folder (a nested declared skill, a marketplace entry's agents): its
    // subtree alone cannot show that on update, which sees no marketplace.json and no sibling path.
    const carve = files.length < all.length ? [...new Set(all.filter((f) => claimed.has(f.path)).map((f) => claimed.get(f.path)!.slice(dir.length + 1)))] : undefined;
    for (const f of files) claimed.set(f.path, dir);
    // A plugin root's skill with components carved out of it (bppq) is re-detected on update too (updateTree), for components added upstream.
    const scope = carve && pluginSet.has(dir) ? 'root' : undefined;
    units.push({ path: dir, kind: 'skill', tree: skillTree(subtree(files, dir)), fallbackName: baseOf(dir), folderName: baseOf(dir), scope, carve });
  };
  const fileUnit = (f: TreeFile, kind: Kind, opts: { name?: string; fallbackName?: string; path?: string } = {}) => {
    claimed.set(f.path, f.path);
    const file = baseOf(f.path);
    units.push({ path: f.path, kind, tree: [{ ...f, path: opts.path ?? file }], name: opts.name, fallbackName: opts.fallbackName ?? stem(file) });
  };
  // A README inside agents/, commands/ or prompts/ would otherwise ship as a slash command named 'readme'.
  const fileDirUnit = (f: TreeFile, file: string, kind: Kind, byFile: boolean) => {
    if (REPO_DOCS.test(file)) {
      claimed.set(f.path, f.path);
      skipped.push({ path: f.path, reason: NOT_AN_ITEM });
    } else fileUnit(f, kind, { name: byFile ? slugify(stem(file)) || undefined : undefined });
  };

  // Manifest problems are listed up to MAX_MANIFEST_SKIPS; the rest are counted in one entry.
  let listed = 0;
  let unlisted = 0;
  const manifestSkips = { push: (s: Skipped) => (listed++ < MAX_MANIFEST_SKIPS ? skipped.push(s) : unlisted++) };
  const { roots: plugins, manifests } = pluginRoots(tree, manifestSkips);
  const pluginSet = new Set(plugins);
  /** The deepest plugin root strictly above `path` ('' when none or only the repository root's), and the path relative to it. */
  const rootOf = (path: string): [string, string] => {
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      if (pluginSet.has(path.slice(0, i))) return [path.slice(0, i), path.slice(i + 1)];
    }
    return ['', path];
  };
  const filesIn = (dir: string) => (dir ? (byDir.get(dir) ?? []) : tree);
  // The paths a manifest declares come first (4ky8), so a component outside SCP's folder conventions
  // imports as its kind and the convention passes below skip what it claimed.
  const seen = new Set<string>();
  let byPath: Map<string, TreeFile> | undefined;
  for (const m of manifests) {
    for (const [key, kind, byFile] of DECLARED) {
      const v = m.data[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string' && !Array.isArray(v)) {
        manifestSkips.push({ path: m.from, reason: `${m.label}'${key}' is not a path or a list of paths` });
        continue;
      }
      for (const raw of typeof v === 'string' ? [v] : v) {
        const at = declaredPath(m.root, raw);
        const shown = `${key} path '${shownValue(raw, 200)}'`;
        if ('reason' in at) {
          manifestSkips.push({ path: m.from, reason: `${m.label}${shown} ${at.reason}` });
          continue;
        }
        if (seen.has(`${key}:${at.path}`)) continue;
        seen.add(`${key}:${at.path}`);
        const inside = filesIn(at.path).map((f) => [f, at.path ? f.path.slice(at.path.length + 1) : f.path] as const);
        let found = false;
        if (kind === 'skill') {
          // The skill folder itself, else a folder of skill folders.
          const own = inside.find(([, rel]) => isSkillMd(rel));
          for (const [f] of own ? [own] : inside.filter(([, rel]) => rel.split('/').length === 2 && isSkillMd(baseOf(rel)))) {
            found = true;
            if (at.path && !claimed.has(f.path)) folderUnit(dirOf(f.path));
          }
        } else {
          // A map, not tree.find: a 1 MB manifest can list tens of thousands of paths.
          byPath ??= new Map(tree.map((f) => [f.path, f]));
          const file = byPath.get(at.path);
          for (const [f, rel] of file ? [[file, baseOf(file.path)] as const] : inside.filter(([, rel]) => !rel.includes('/'))) {
            if (!isMd(rel)) continue;
            found = true;
            if (!claimed.has(f.path)) fileDirUnit(f, baseOf(f.path), kind, byFile);
          }
        }
        if (!found) manifestSkips.push({ path: m.from, reason: `${m.label}${shown} holds no ${kind === 'skill' ? 'SKILL.md' : '.md file'}; not imported` });
      }
    }
  }
  if (unlisted) skipped.push({ path: '.claude-plugin', reason: `${unlisted} more plugin manifest problems, not listed` });
  // Contributor tooling when the repository says where its product lives (4ky8 part 2): claimed into
  // skipped before the convention passes, so a tool's own dev skills and agents are not its items.
  const hasSkillsDir = (byDir.get('skills') ?? []).some((f) => under(f, 'skills')!.length === 2 && isSkillMd(baseOf(f.path)));
  if (!opts.includeRepoTooling && !opts.pluginFolder && (plugins.length || hasSkillsDir)) {
    const reason = `maintainer tooling (repo ships ${plugins.length ? 'a plugin' : 'a skills/ folder'})`;
    for (const dir of TOOLING_DIRS) {
      const files = (byDir.get(dir) ?? []).filter((f) => !claimed.has(f.path));
      for (const f of files) claimed.set(f.path, f.path);
      if (files.length) skipped.push({ path: dir, reason });
    }
    for (const name of plugins.length ? TOOLING_FILES : []) {
      const f = tree.find((x) => x.path === name && !claimed.has(x.path));
      if (f) {
        claimed.set(f.path, f.path);
        skipped.push({ path: name, reason });
      }
    }
  }
  // Each plugin root's layout folders, deepest root first, then the repository root's. byDir, not the
  // whole tree, per folder: a pack can hold thousands of plugin roots.
  const roots = plugins.at(-1) === '' ? plugins : [...plugins, ''];
  for (const r of roots) {
    for (const dir of SKILL_DIRS.map((d) => join(r, d))) {
      for (const f of byDir.get(dir) ?? []) {
        const rest = under(f, dir)!;
        if (rest.length === 2 && isSkillMd(rest[1]) && !claimed.has(f.path)) folderUnit(`${dir}/${rest[0]}`);
      }
    }
    for (const [d, kind, byFile] of FILE_DIRS) {
      for (const f of byDir.get(join(r, d)) ?? []) {
        const rest = under(f, join(r, d))!;
        if (rest.length === 1 && isMd(rest[0]) && !claimed.has(f.path)) fileDirUnit(f, rest[0], kind, byFile);
      }
    }
  }
  // As in the whole repository, the plugin root's skill keeps everything else: nested skill folders, CLAUDE.md.
  if (opts.pluginFolder && rootSkillMd && !claimed.has(rootSkillMd.path)) {
    units.push({ path: '', kind: 'skill', tree: skillTree(free()), fallbackName: rootName, folderName: rootName });
    return { units, skipped };
  }
  const hinted = opts.layoutDir ? FILE_DIRS.find(([dir]) => baseOf(dir) === opts.layoutDir) : undefined;
  if (hinted) {
    for (const f of tree) if (!f.path.includes('/') && isMd(f.path) && !claimed.has(f.path)) fileDirUnit(f, f.path, hinted[1], hinted[2]);
  }
  // Any other folder holding a SKILL.md. A skill keeps a nested example skill as its own files, so only
  // the outermost folders are units, and they are disjoint. Their order decides which copy of a skill a
  // multi-tool repository keeps (ypmn; the rest are name clashes): a plugin's or .claude/'s first, then
  // one under a skills/ folder, then neutral folders, and last another tool's port (.openclaw/,
  // antigravity/). Depth, then path, within a rank.
  const candidates = tree.filter((f) => f.path.includes('/') && isSkillMd(baseOf(f.path)) && !claimed.has(f.path));
  const skillDirs = new Set(candidates.map((f) => dirOf(f.path)));
  const nested = (dir: string) => {
    for (let i = dir.lastIndexOf('/'); i > 0; i = dir.lastIndexOf('/', i - 1)) if (skillDirs.has(dir.slice(0, i))) return true;
    return false;
  };
  const rank = (dir: string) => {
    const segs = dirOf(dir).split('/');
    if (portOf(dir)) return 3;
    if (rootOf(dir)[0] || segs.includes('.claude')) return 0;
    return segs.includes('skills') ? 1 : 2;
  };
  const ranked = candidates.filter((f) => !nested(dirOf(f.path))).map((f) => ({ f, rank: rank(dirOf(f.path)), depth: f.path.split('/').length }));
  ranked.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.f.path.localeCompare(b.f.path));
  for (const { f } of ranked) if (!claimed.has(f.path)) folderUnit(dirOf(f.path));
  // Root instruction/design files (exact case) come out before a root SKILL.md, in any case like a
  // folder's (README: "skill.md in any case counts"), takes every remaining file as its own.
  const root = (name: string) => tree.find((f) => f.path === name && !claimed.has(f.path));
  for (const [name, kind] of ROOT_FILES) {
    const f = root(name);
    if (f) fileUnit(f, kind, { fallbackName: rootName });
  }
  if (rootSkillMd && !claimed.has(rootSkillMd.path)) {
    const files = free();
    for (const f of files) claimed.set(f.path, '');
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
    // loose .md apart from README-style docs, which a repository is expected to carry. Each file is read
    // relative to the deepest plugin root above it (bppq), and a plugin's hooks, MCP servers and other
    // unsupported components are reported once each (dnxq), not file by file.
    const folders = new Set<string>();
    const components = new Map<string, string>();
    for (const f of rest) {
      const [r, rel] = rootOf(f.path);
      const component = pluginSet.has(r) ? PLUGIN_COMPONENTS.find((c) => (c.endsWith('/') ? rel.startsWith(c) : rel === c)) : undefined;
      if (component) {
        components.set(join(r, component.replace(/\/$/, '')), component);
        continue;
      }
      const dir = SKILL_DIRS.find((d) => rel.startsWith(d + '/'));
      const inner = dir ? rel.slice(dir.length + 1) : '';
      if (dir && inner.includes('/')) folders.add(join(r, `${dir}/${inner.slice(0, inner.indexOf('/'))}`));
      else if (isMd(f.path) && !REPO_DOCS.test(baseOf(f.path))) {
        const fileDir = FILE_DIRS.find(([d]) => rel.startsWith(d + '/'))?.[0];
        // The nearest agents/ or commands/ folder above the file, at any depth (agents/<x>/agent.md).
        const parent = dirOf(rel).split('/').reverse().find((s) => s === 'agents' || s === 'commands');
        const reason = fileDir
          ? `nested under ${join(r, fileDir)}/: only ${join(r, fileDir)}/*.md is imported`
          : parent
            ? pluginSet.has(r)
              ? `${parent}/ is imported only at the plugin root: ${join(r, parent)}/*.md`
              : `${parent}/ below the repository root is imported only inside a plugin (.claude-plugin/plugin.json)`
            : 'not inside a recognised layout folder';
        skipped.push({ path: f.path, reason });
      }
    }
    for (const folder of folders) skipped.push({ path: folder, reason: 'no SKILL.md in this folder' });
    for (const [path, c] of components) skipped.push({ path, reason: `plugin ${c} is not supported by SCP; it was not imported` });
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
 * carved it. What another unit took out of a folder unit (source_carve: a nested declared skill, a
 * marketplace entry's agents) stays out, since the subtree alone shows neither the marketplace.json
 * nor the other declared paths. Then by source_scope: a root SKILL.md import ('root') leaves sibling units (AGENTS.md,
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
  const cut = new Set<string>(item.source_carve ? JSON.parse(item.source_carve) : []);
  const isCut = (p: string) => {
    for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) if (cut.has(p.slice(0, i))) return true;
    return cut.has(p);
  };
  const kept = cut.size ? tree.filter((f) => !isCut(f.path)) : tree;
  // The root entry is re-homed to SKILL.md as the import did (a folder's skill.md in any case), whatever the scope.
  const whole = skillTree(kept);
  if (item.source_scope === 'tree') return whole;
  // A carved skill with a source path is a plugin root's (detectUnits folderUnit); one at the repository root has none.
  const root = detectUnits(kept, item.name, { pluginFolder: item.source_scope === 'root' && !!item.source_path }).units.find((u) => u.path === '' && u.kind === 'skill');
  if (!root || root.tree.length === kept.length) return whole;
  if (item.source_scope === 'root') return root.tree;
  const carved = new Set(whole.map((f) => f.path));
  for (const f of root.tree) carved.delete(f.path);
  const stored = listFiles(db, resolveVersion(db, item).id);
  return stored.some((f) => carved.has(f.path)) ? whole : root.tree;
}

/** GitHub resolves repository names case-insensitively, and a zip's name is a file name on a case-insensitive disk. */
const sameRepo = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

function importUnit(ctx: Ctx, p: Principal, u: Unit, opts: ImportOpts): UnitResult {
  // A file path re-rooted to its name (subtree) would otherwise join to '<file>/<name>', which no update finds.
  const source: ItemSource = { ...opts.source, path: opts.pathIsFile ? opts.source.path : [opts.source.path, u.path].filter(Boolean).join('/') || null };
  // The root detection unit is the one carved from its siblings; a kind override, a folder import or any folder unit took the whole tree (updateTree).
  const sourceScope: NonNullable<ItemRow['source_scope']> = u.scope ?? (!opts.kind && u.path === '' && u.kind === 'skill' ? 'root' : 'tree');
  const input = { kind: u.kind, name: u.name, tree: u.tree, visibility: opts.visibility, source, sourceScope, sourceCarve: u.carve, note: opts.note, fallbackName: u.fallbackName, folderName: u.folderName };
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
      // Two units of one source with the same name (two marketplace plugins shipping agents/code-reviewer.md): say which one holds it.
      // A skill under another tool's folder lost to a better-ranked copy (ypmn, detectUnits): say it is that tool's port.
      if (holder && sameRepo(holder.source_repo, source.repo)) {
        const port = u.kind === 'skill' ? portOf(u.path) : undefined;
        const at = holder.source_path ?? 'the root';
        throw new HttpError(409, 'name_taken', port ? `another copy of this skill (${at}) was imported; this one is the ${port} port` : `${e.message}, imported from ${at} of ${holder.source_repo}`, e.details);
      }
      // A zip is identified by its file name (docs/PLAN-v2.md D1), so a renamed download reads as a new pack: say so.
      if (holder?.source_kind === 'zip') throw new HttpError(409, 'name_taken', `${e.message}, imported from ${holder.source_repo}; upload the file under that name to update it`, e.details);
      throw e;
    }
    // How this import carved the unit replaces the last one's: the next source/update follows the manifest as it is now.
    ctx.db.prepare('UPDATE items SET source_scope = ?, source_carve = ? WHERE id = ?').run(sourceScope, u.carve ? JSON.stringify(u.carve) : null, holder.id);
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
  const skipped: Skipped[] = [...(opts.skipped ?? [])];
  // A tree has no format, which every artifact needs (checkFormat): the single-file import is the way in.
  if (opts.kind === 'artifact') throw badRequest(ARTIFACT_FROM_TREE);
  if (opts.kind) units = [{ path: '', kind: opts.kind, tree, name: opts.name, fallbackName: opts.rootName, folderName: opts.rootName }];
  else {
    const detected = detectUnits(tree, opts.rootName, { layoutDir: opts.layoutDir, folderRoot: opts.folderRoot, includeRepoTooling: opts.includeRepoTooling });
    units = detected.units;
    skipped.push(...detected.skipped);
    if (opts.name !== undefined) {
      if (units.length !== 1) throw badRequest(`name applies to an import of exactly one item (found ${units.length})`);
      units[0].name = opts.name;
    }
  }
  const meta = opts.group ? pluginMeta(tree) : null;
  // Detection reports a bad marketplace.json too, when its plugin pass ran (not for a kind override or a folder's SKILL.md): listed once.
  if (meta) skipped.push(...meta.skipped.filter((s) => !skipped.some((x) => x.path === s.path && x.reason === s.reason)));
  // The skip reasons travel as details, like the 422 below, so the UI can list what was passed over and why.
  if (!units.length) throw new HttpError(400, 'nothing_to_import', 'no skills, agents, commands, prompts, instructions or design files found', skipped.length ? skipped : undefined);
  const maxItems = importLimit(ctx, 'maxItems');
  if (units.length > maxItems) throw new HttpError(400, 'too_many_items', `at most ${maxItems} item${maxItems === 1 ? '' : 's'} per import (found ${units.length})`);
  const { db } = ctx;
  return tx(db, () => {
    const group = opts.group
      ? createGroup(ctx, p, { slug: opts.group, name: opts.groupName ?? meta?.name ?? opts.defaultGroupName ?? opts.rootName, description: meta?.description })
      : null;
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
