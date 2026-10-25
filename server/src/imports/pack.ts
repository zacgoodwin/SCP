import { importLimit } from '../admin/settings.ts';
import { requireScope } from '../auth/middleware.ts';
import { tx, type Db } from '../db.ts';
import { canEditGroup } from '../access.ts';
import { addMemberTx, createGroup, getGroupRow, isMember } from '../groups/service.ts';
import { FRONTMATTER_ERRORS } from '../items/lint.ts';
import { SINGLE_FILE, addVersion, createItemTx, getItemRow, listFiles, previewItem, readTree, refreshFts, renameFrontmatter, resolveVersion, slugify, suppliedOf, versionSha, type CreateItemInput, type Lint } from '../items/service.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { UNCLOSED, parseFrontmatter, prependFrontmatter } from '../lib/frontmatter.ts';
import { HttpError, MB, badRequest, notFound } from '../lib/http.ts';
import { isJunkPath, normalizePath, pathKey } from '../lib/paths.ts';
import { stripTopFolder, treeSha256, type TreeFile } from '../lib/tree.ts';
import { PACK_LIMITS, safeUnzip, type ZipLimits, type ZipLink } from '../lib/zip.ts';
import { MARKETPLACE_JSON, PLUGIN_JSON, isObject, marketplaceIgnored, parseManifest, pluginMeta, shownValue } from './manifest.ts';
import { aKind, type Ctx, type GroupRow, type ItemRow, type ItemSource, type Kind, type Principal, type SuppliedFrontmatter } from '../types.ts';

export const ARTIFACT_FROM_TREE = 'an artifact imports from a single file, not from a repository or pack';
export const PACKAGE_DESCRIPTION = 'description applies to an item kind with one entry file (skill, agent, command, prompt, instructions or design); a package has none';

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
  /**
   * A skill's plugin folder (or the folder holding its skills/ folder), an agent's or command's plugin
   * folder (7k2p): its prefix when another unit of the import shares its kind and name (5ef6). Each
   * next entry adds the folder above (`plugins-a` after `a`, 5vz2), for when two copies' folders share a name.
   */
  prefixes?: string[];
  /** 5ef6: the name the unit took before it was renamed (renamed); its item records what was put in front (source_prefix). */
  bare?: string;
  /** jcfm: frontmatter put in front of the unit's entry, which has none upstream (supply). `tree` stays upstream's. */
  supplied?: SuppliedFrontmatter;
  /** naming-8: the tool a unit at a plugin root is a port for (`antigravity/` as the plugin), set by detectUnits; else unitPort reads its path. */
  port?: string;
}

export interface Skipped {
  path: string;
  reason: string;
  /** 5ef6: the name another source's item holds; the unit imports as this name with onNameClash 'prefix'. */
  prefixed?: string;
}

/** 0rdh: a unit whose only lint errors are frontmatter errors, listed in a 409 frontmatter_errors. */
export interface FrontmatterUnit {
  path: string;
  kind: Kind;
  errors: string[];
}

export interface UnitResult {
  item: ItemRow;
  op: 'create' | 'version' | 'unchanged';
}

/** A folder whose loose .md files detection passed over (mvfp): the UI offers to import them as a kind (`folderKinds`). '' is the root. */
export interface SkippedFolder {
  path: string;
  count: number;
}

/** What `folderKinds` may map a folder to: each .md one item of that kind, or the folder one package. */
export const FOLDER_KINDS = ['agent', 'command', 'prompt', 'instructions', 'design', 'package'] as const;
export type FolderKind = (typeof FOLDER_KINDS)[number];

export interface ImportOutcome {
  group: GroupRow | null;
  /** The group was created by this import, not an existing one it added to (p2wf). */
  groupCreated: boolean;
  /** Members this import added to the group. */
  added: number;
  results: UnitResult[];
  skipped: Skipped[];
  skippedFolders: SkippedFolder[];
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
  /** Passed over before detection (symlinks linkCopies could not copy, submodules): reported first in `skipped`. */
  skipped?: Skipped[];
  /** jv9q: the links linkCopies copied into the tree (re-rooted with it): see linkUnits. */
  copied?: ZipLink[];
  note: string;
  visibility?: 'private' | 'public';
  /**
   * No detection: the whole tree is one item of this kind, or for a single-file kind (agent, command,
   * prompt, instructions) each .md in it is one item of that kind (jwz6).
   */
  kind?: Kind;
  name?: string;
  group?: string;
  /** An existing group (resolved editable by the route) every imported item joins (p2wf). Exclusive with `group`. */
  intoGroup?: GroupRow;
  /** Folders whose loose .md files import as a kind instead of being skipped (mvfp). Keys are validated tree paths, '' the root. */
  folderKinds?: Record<string, FolderKind>;
  /** The request's own group name: it wins over the plugin manifest's (pluginMeta). */
  groupName?: string;
  /** The group's name when neither the request nor the manifest names it (default: rootName). */
  defaultGroupName?: string;
  /** Import a repository's contributor tooling even when it ships a plugin or a skills/ folder (4ky8). */
  includeRepoTooling?: boolean;
  /** 5ef6: a unit whose name another source's item holds is skipped (default), or imported as `<clashPrefix>-<name>`. */
  onNameClash?: 'skip' | 'prefix';
  /** The repository (or zip) name a clash across imports is prefixed with (default: rootName). */
  clashPrefix?: string;
  /**
   * 0rdh: units whose only lint errors are frontmatter errors. 'ask' (default): a 409 naming them, nothing
   * written; 'import' them anyway (errors kept as waived warnings); 'skip' them, as before.
   */
  frontmatterErrors?: 'ask' | 'import' | 'skip';
  /** jcfm: frontmatter description (and a skill's or agent's name) SCP supplies when the one unit's entry has no frontmatter upstream. */
  description?: string;
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
/** File stems that name a convention, not a product (`skills.md`, `README.md`). */
const GENERIC_STEMS = new Set(['skill', 'skills', 'agent', 'agents', 'readme', 'index', 'claude', 'instructions']);
/** A skill's entry in any case; the unit re-homes it to SKILL.md the way mdKind does for a loose file. */
const isSkillMd = (name: string) => name.toLowerCase() === 'skill.md';
/**
 * The name of last resort for a one-file import (a GitHub `path` naming a file): its stem, never the
 * file name (`helper.md` is `helper`, y15q); a SKILL.md's folder (else the repository at its root); and
 * for a skill from one other .md (mas4), the repository when the stem is generic (cesarferreira/stax `skills.md` -> stax).
 */
export function fileRootName(path: string, repoName: string, skill: boolean): string {
  const file = baseOf(path);
  if (isSkillMd(file)) return baseOf(dirOf(path)) || repoName;
  return skill && GENERIC_STEMS.has(stem(file).toLowerCase()) ? repoName : stem(file);
}
/** y15q: fileRootName before v4, the file name (`go.md`, so go-md; SKILL.md, so skill-md), or for a skill the stem or repository (mas4, so a SKILL.md was the repository's). */
function preV4RootName(path: string, repoName: string, skill: boolean): string {
  const file = baseOf(path);
  return !skill ? file : GENERIC_STEMS.has(stem(file).toLowerCase()) ? repoName : stem(file);
}
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
/**
 * The tool a skill folder is a port for: the first folder above it named for one (its own name never
 * counts), but a plugin root's own folders count (naming-8): `antigravity/` as a plugin root is the port.
 */
const portOf = (dir: string, pluginRoot = false) => (pluginRoot ? dir : dirOf(dir)).split('/').find((s) => PORT_DIRS.has(s.toLowerCase()));
/** A unit's port: what detectUnits recorded (a plugin root's own folder), else read off its path. */
const unitPort = (u: Unit) => u.port ?? portOf(u.path);
/** Manifest problems listed per import: a 1 MB manifest can name half a million bad paths, each one a skipped entry. */
const MAX_MANIFEST_SKIPS = 500;
/** jv9q: links inside copied link targets listed per import, likewise: L copies of a target holding B links would otherwise be L x B entries. */
const MAX_HOP_SKIPS = 500;

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
 * in `links`, re-rooted with the files, for the import to copy or report (linkCopies).
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

const linkSkip = (l: ZipLink, why = ''): Skipped => ({ path: l.path, reason: `symlink to '${l.target}'${why && ` (${why})`}, not imported` });
const ONE_HOP = 'a symlink: links are followed one hop';
/** jv9q: a link inside a target reached through another link, listed at `path`, where its copy would sit: a second hop, never followed. */
export const hopSkip = (l: ZipLink, path: string): Skipped => linkSkip({ path, target: l.target }, ONE_HOP);

/**
 * Where a link's stored target points, read from the link's own folder; null when it is absolute, climbs
 * above the root, or was cut for display (`long`: its first 255 characters may name another folder).
 */
export function linkTarget(l: ZipLink): string | null {
  if (l.long || l.target.startsWith('/') || l.target.includes('\\') || /^[A-Za-z]:/.test(l.target)) return null;
  return relPath(join(dirOf(l.path), l.target));
}

/** The folders and files above `path`, outermost first, then `path` itself. */
function* selfAndAbove(path: string) {
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) yield path.slice(0, i);
  yield path;
}

/**
 * jv9q: each link whose target is a file or folder of `files` (the whole repository or pack, never
 * anything outside it) becomes a copy of that target at the link's path, as Claude Code copies a
 * plugin's links when it installs it (Arize-ai/phoenix: `skills/phoenix-cli -> ../../../../.agents/skills/phoenix-cli`).
 * One hop: only real files are copied, never other copies, so a link to a link (a cycle included) or
 * into a linked folder stays a skip, and so does a link to a folder holding it (the tree inside itself).
 * A target that is missing, absolute or above the root is reported as before and never read; one in
 * or under an `unfetched` target (the download refused it) is reported with that reason. The
 * copies together are held to `limits` (their bytes are shared with the target, not duplicated), checked
 * before a copy is made, so a pack of thousands of links to one big folder costs one lookup per refused link.
 * `beyond`: the links inside targets the download fetched from outside the folder. The links inside a copied
 * target, those and the tree's own alike, are listed at its first copy at their copy paths (hopSkip), a
 * later copy one entry counting them, so the item never silently lacks them; past MAX_HOP_SKIPS the rest
 * are counted in one entry.
 */
export function linkCopies(files: TreeFile[], links: ZipLink[], limits: ZipLimits, unfetched = new Map<string, string>(), beyond: ZipLink[] = []): { files: TreeFile[]; copied: ZipLink[]; skipped: Skipped[] } {
  if (!links.length) return { files, copied: [], skipped: [] };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const byDir = new Map<string, TreeFile[]>();
  const dirBytes = new Map<string, number>();
  for (const f of files) {
    for (const dir of selfAndAbove(dirOf(f.path))) {
      if (!dir) continue;
      (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
      dirBytes.set(dir, (dirBytes.get(dir) ?? 0) + f.bytes.length);
    }
  }
  // The links inside targets, in the tree or fetched, under every folder above them: a copy finds its own in one lookup.
  const inner = new Map<string, ZipLink[]>();
  for (const n of [...links, ...beyond]) for (const dir of selfAndAbove(dirOf(n.path))) if (dir) (inner.get(dir) ?? inner.set(dir, []).get(dir)!).push(n);
  const linkAt = new Set(links.map((l) => l.path));
  // I3-2: paths as a case-insensitive install disk sees them (pathKey), folders apart, so a copy that folds
  // onto a file or folder of the tree (readme.md -> README.md beside README.md) is that link's skip, never a
  // collision that refuses the whole unit later (assertNoCollisions).
  const takenFiles = new Set<string>();
  const takenDirs = new Set<string>();
  const take = (path: string) => {
    const k = pathKey(path);
    takenFiles.add(k);
    for (const d of selfAndAbove(dirOf(k))) if (d) takenDirs.add(d);
  };
  const clashes = (path: string) => {
    const k = pathKey(path);
    return takenFiles.has(k) || takenDirs.has(k) || [...selfAndAbove(dirOf(k))].some((d) => takenFiles.has(d));
  };
  for (const f of files) take(f.path);
  const out = [...files];
  const copied: ZipLink[] = [];
  const skipped: Skipped[] = [];
  let count = 0;
  let bytes = 0;
  // Copy paths checked: a copy that lands checks its own (count caps those), and one refused part way (a
  // folded clash, a path too long) checks some too. ponytail: past twice the file cap the remaining links are
  // refused unread, so crafted links that each fail on their target's last file stay linear; no real tree comes near it.
  let checked = 0;
  const listedAt = new Set<string>();
  let hops = 0;
  let unlisted = 0;
  let overflowAt = '';
  for (const l of links) {
    const t = linkTarget(l);
    const file = t ? byPath.get(t) : undefined;
    const src = file ? [file] : t ? (byDir.get(t) ?? []) : [];
    let why = '';
    if (t !== null && (t === '' || l.path === t || l.path.startsWith(t + '/'))) why = 'a folder holding it';
    else if (t !== null && [...selfAndAbove(t)].some((p) => linkAt.has(p))) why = ONE_HOP;
    else if (!src.length) {
      const gone = t && [...selfAndAbove(t)].find((p) => unfetched.has(p));
      skipped.push(linkSkip(l, gone ? unfetched.get(gone) : l.long ? 'its target is longer than 255 characters' : ''));
      continue;
    }
    // Held to the limits before anything is made. Unpacked and fetched trees hold no junk path, and re-rooting
    // under a link path (never junk either) cannot make one, so a copy is its target file for file.
    const size = file ? file.bytes.length : (dirBytes.get(t!) ?? 0);
    if (!why && (count + src.length > limits.files || bytes + size > limits.totalBytes || checked + src.length > 2 * limits.files)) why = `its copy would pass ${limits.what}'s limits`;
    const made: TreeFile[] = [];
    if (!why) {
      checked += src.length;
      try {
        for (const f of src) {
          const path = file ? l.path : `${l.path}/${f.path.slice(t!.length + 1)}`;
          normalizePath(path);
          if (clashes(path)) throw badRequest(`'${path}' is in the tree already`);
          made.push({ ...f, path });
        }
      } catch (e) {
        why = (e as Error).message;
      }
    }
    if (why) {
      skipped.push(linkSkip(l, why));
      continue;
    }
    for (const f of made) take(f.path);
    out.push(...made);
    copied.push(l);
    count += made.length;
    bytes += size;
    const nested = file ? undefined : inner.get(t!);
    if (!nested) continue;
    // A target's links are listed at its first copy; each later copy says how many it lacks, in one entry.
    if (listedAt.has(t!)) {
      if (hops < MAX_HOP_SKIPS) {
        hops++;
        skipped.push({ path: l.path, reason: `${nested.length} symlink${nested.length === 1 ? '' : 's'} inside its target '${l.target}' (${ONE_HOP}), not imported; listed under its first copy` });
      } else unlisted += nested.length;
    } else {
      listedAt.add(t!);
      const room = Math.min(nested.length, MAX_HOP_SKIPS - hops);
      for (const n of nested.slice(0, room)) skipped.push(hopSkip(n, l.path + n.path.slice(t!.length)));
      hops += room;
      unlisted += nested.length - room;
    }
    if (unlisted && !overflowAt) overflowAt = l.path;
  }
  if (unlisted) skipped.push({ path: overflowAt, reason: `${unlisted} more symlinks inside copied link targets (${ONE_HOP}), not imported and not listed` });
  return { files: out, copied, skipped };
}

/**
 * jv9q: at most this many targets elsewhere in the repository are fetched for one folder (the download
 * reports the links to the rest naming the cap, I3-4). ponytail: a whole-repository import holds every
 * target and copies them all, so a source/update of a folder past the cap keeps fewer copies than its
 * import made; raise it if real plugins need more.
 */
export const MAX_OUTSIDE_TARGETS = 20;

/**
 * jv9q: the targets a folder's links (repository-relative) name outside the folder, for the download
 * to fetch as well (outermost only, sorted); none for a whole repository, which holds them already. A
 * target that is the folder or holds it is left to linkCopies to refuse.
 */
export function outsideTargets(links: ZipLink[], path: string | null): string[] {
  if (path === null) return [];
  const targets = links.map(linkTarget).filter((t): t is string => !!t && t !== path && !t.startsWith(path + '/') && !path.startsWith(t + '/'));
  const kept = new Set<string>();
  for (const t of [...new Set(targets)].sort()) if (![...selfAndAbove(t)].some((p) => kept.has(p))) kept.add(t);
  return [...kept];
}

/**
 * safeUnzip predicate for a GitHub zipball: the entries at or under `path` below the one top folder
 * GitHub wraps the repository in, so the rest of a monorepo is never counted, sized or inflated.
 * `above`: the entries at a folder above `path` too, where a link stands in for the folder (I3-1).
 */
export function underPath(path: string | null, above = false): ((name: string) => boolean) | undefined {
  if (path === null) return undefined;
  return (name) => {
    const i = name.indexOf('/');
    if (i < 0) return false;
    const rest = name.slice(i + 1);
    return rest === path || rest.startsWith(path + '/') || (above && !!rest && path.startsWith(rest + '/'));
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
 * One .md as an item of a kind the user chose (jwz6 `kind`, mvfp `folderKinds`): commands and prompts
 * are named by file, like FILE_DIRS; a design's entry is DESIGN.md.
 */
function chosenUnit(f: TreeFile, kind: Kind): Unit {
  const file = baseOf(f.path);
  const name = kind === 'command' || kind === 'prompt' ? slugify(stem(file)) || undefined : undefined;
  return { path: f.path, kind, tree: [{ ...f, path: kind === 'design' ? 'DESIGN.md' : file }], name, fallbackName: stem(file) };
}

/**
 * jwz6: `kind` of a single-file kind on a folder: each .md directly in it (README-style docs never) is
 * one item of that kind; subfolders' files are skipped, as their names could collide. A folder of one
 * .md stays the one item named after the folder, source path the folder, as before jwz6, so
 * re-importing an item made then versions it.
 */
function fileUnits(tree: TreeFile[], kind: Kind, rootName: string, skipped: Skipped[]): Unit[] {
  const mds: TreeFile[] = [];
  for (const f of tree) {
    if (!isMd(f.path)) skipped.push({ path: f.path, reason: `not a .md file: ${aKind(kind)} is one .md` });
    else if (dirOf(f.path)) skipped.push({ path: f.path, reason: `in a subfolder: only the folder's own .md files are each ${aKind(kind)}` });
    else if (REPO_DOCS.test(f.path)) skipped.push({ path: f.path, reason: NOT_AN_ITEM });
    else mds.push(f);
  }
  if (mds.length === 1) return [{ path: '', kind, tree: mds, fallbackName: rootName, folderName: rootName }];
  return mds.map((f) => chosenUnit(f, kind));
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
export function detectUnits(
  tree: TreeFile[],
  rootName: string,
  opts: { layoutDir?: string; folderRoot?: boolean; includeRepoTooling?: boolean; pluginFolder?: boolean; folderKinds?: Record<string, FolderKind> } = {},
): { units: Unit[]; skipped: Skipped[]; skippedFolders: SkippedFolder[] } {
  const units: Unit[] = [];
  const skipped: Skipped[] = [];
  /** Each claimed file's owner: the folder unit holding it, else the file itself (a file unit, a skip). */
  const claimed = new Map<string, string>();
  const free = () => tree.filter((f) => !claimed.has(f.path));
  const under = (f: TreeFile, dir: string) => (f.path.startsWith(dir + '/') ? f.path.slice(dir.length + 1).split('/') : null);
  const rootSkillMd = tree.find((f) => !f.path.includes('/') && isSkillMd(f.path));
  if (opts.folderRoot && rootSkillMd) return { units: [{ path: '', kind: 'skill', tree: skillTree(tree), fallbackName: rootName, folderName: rootName, scope: 'tree' }], skipped, skippedFolders: [] };
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
    const prefixes = prefixesOf(dir);
    units.push({ path: dir, kind: 'skill', tree: skillTree(subtree(files, dir)), fallbackName: baseOf(dir), folderName: baseOf(dir), scope, carve, ...(prefixes && { prefixes }) });
  };
  const fileUnit = (f: TreeFile, kind: Kind, opts: { name?: string; fallbackName?: string; path?: string; prefixes?: string[] } = {}) => {
    claimed.set(f.path, f.path);
    const file = baseOf(f.path);
    units.push({ path: f.path, kind, tree: [{ ...f, path: opts.path ?? file }], name: opts.name, fallbackName: opts.fallbackName ?? stem(file), ...(opts.prefixes && { prefixes: opts.prefixes }) });
  };
  // A README inside agents/, commands/ or prompts/ would otherwise ship as a slash command named 'readme'.
  const fileDirUnit = (f: TreeFile, file: string, kind: Kind, byFile: boolean) => {
    if (REPO_DOCS.test(file)) {
      claimed.set(f.path, f.path);
      skipped.push({ path: f.path, reason: NOT_AN_ITEM });
    } else fileUnit(f, kind, { name: byFile ? slugify(stem(file)) || undefined : undefined, prefixes: kind === 'agent' || kind === 'command' ? prefixesOf(f.path) : undefined });
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
  /**
   * 5ef6 (Unit.prefixes): the plugin's folder, else the folder holding skills/, then each with the folders
   * above it (5vz2) up to a dot folder or the root; none for a port (ypmn) or under a dot folder (.claude).
   */
  const prefixesOf = (path: string) => {
    if (portOf(path)) return undefined;
    const [r] = rootOf(path);
    const segs = dirOf(path).split('/');
    const folder = r ? r.split('/') : segs.at(-1) === 'skills' ? segs.slice(0, -1) : [];
    const out: string[] = [];
    // Past 64 characters no prefixed name fits (prefixed), so the chain stops there; a first prefix that
    // long is kept, so the copy is skipped on the name limit (prefixClashes), not taken as having none.
    for (let i = folder.length - 1; i >= 0 && folder[i] && !folder[i].startsWith('.'); i--) {
      const px = slugify(folder.slice(i).join('-'), Infinity);
      if (px.length > 64) {
        if (!out.length) out.push(px);
        break;
      }
      if (px && px !== out.at(-1)) out.push(px);
    }
    return out.length ? out : undefined;
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
    return { units, skipped, skippedFolders: [] };
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
    if (portOf(dir, pluginSet.has(dir))) return 3;
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
  // Folders the user mapped to a kind after an import offered them (mvfp): last, so only what every
  // pass above left is taken. Their loose .md files (README-style docs never) become one item each,
  // or the whole folder one package.
  for (const [dir, kind] of Object.entries(opts.folderKinds ?? {})) {
    const files = filesIn(dir).filter((f) => !claimed.has(f.path));
    const loose = kind === 'package' ? files : files.filter((f) => dirOf(f.path) === dir && isMd(f.path) && !REPO_DOCS.test(baseOf(f.path)));
    for (const f of loose) claimed.set(f.path, kind === 'package' ? dir : f.path);
    if (!loose.length) skipped.push({ path: dir, reason: 'folderKinds: no unrecognised files in this folder; ignored' });
    else if (kind === 'package') units.push({ path: dir, kind, tree: subtree(loose, dir), fallbackName: baseOf(dir) || rootName, scope: 'tree' });
    else units.push(...loose.map((f) => chosenUnit(f, kind)));
  }
  const rest = free();
  const looseMd = new Map<string, number>();
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
        looseMd.set(dirOf(f.path), (looseMd.get(dirOf(f.path)) ?? 0) + 1);
      }
    }
    for (const folder of folders) skipped.push({ path: folder, reason: 'no SKILL.md in this folder' });
    for (const [path, c] of components) skipped.push({ path, reason: `plugin ${c} is not supported by SCP; it was not imported` });
  }
  // ypmn, eg9k: units import in this order and the first takes a name, so another tool's port goes after
  // every other unit, whichever pass found it (its own plugin.json, a manifest path, antigravity/ as a plugin,
  // whose root skill sits at the root itself, naming-8).
  for (const u of units) if (pluginSet.has(u.path)) u.port = portOf(u.path, true);
  units.sort((a, b) => +!!unitPort(a) - +!!unitPort(b));
  return { units, skipped, skippedFolders: [...looseMd].map(([path, count]) => ({ path, count })) };
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
 * Frontmatter errors are accepted when this write was asked to (waive) or the import accepted them
 * (0rdh: the user already chose), and a prefixed item keeps its prefix (5ef6, keepPrefix).
 * jcfm: the frontmatter an import supplies (`supplied`, this import's; else the item's stored fields)
 * goes in front of an upstream entry that has none, byte for byte the same each time. An upstream entry
 * with its own wins, but for a name SCP supplied (sourceTree); the stored fields stay as the fallback and the item says so (upstream_frontmatter).
 */
export function versionFromSource(ctx: Ctx, p: Principal, item: ItemRow, tree: TreeFile[], source: ItemSource, note: string, waive = false, supplied?: SuppliedFrontmatter): UnitResult {
  const { db } = ctx;
  const fields = supplied ?? suppliedOf(item);
  const own = fields && suppliedFor(item, fields);
  const withFm = own && supply(item.kind, tree, own);
  return tx(db, () => {
    const prev = resolveVersion(db, item);
    db.exec('SAVEPOINT ver');
    const v = addVersion(ctx, p, item, { tree: sourceTree(item, tree, own), note }, { waiveFrontmatter: waive || !!item.lint_waived });
    // Items imported before source_tree_sha256 was recorded fall back to the latest version.
    const changed = v.tree_sha256 !== prev.tree_sha256 && v.tree_sha256 !== (item.source_tree_sha256 ?? prev.tree_sha256);
    db.exec(changed ? 'RELEASE ver' : 'ROLLBACK TO ver; RELEASE ver');
    db.prepare('UPDATE items SET source_ref = ?, source_commit = ?, source_tree_sha256 = ? WHERE id = ?').run(source.ref, source.commit, v.tree_sha256, item.id);
    // The stored fields describe the block the latest version carries: a tree that did not land (a local edit since stays the latest) leaves them.
    if (changed || v.tree_sha256 === prev.tree_sha256) {
      db.prepare('UPDATE items SET supplied_frontmatter = ?, upstream_frontmatter = ? WHERE id = ?').run(own ? JSON.stringify(own) : null, own && !withFm ? 1 : 0, item.id);
    }
    return { item: getItemRow(db, item.id)!, op: changed ? 'version' : 'unchanged' };
  });
}

/**
 * jcfm: the item page's edit of the supplied description. While the supplied block is in use, the latest
 * version's entry has it swapped for the new one in a new version; while upstream ships its own, only the
 * stored fallback changes. A block edited by hand since is not overwritten (409). What the source last
 * wrote (source_tree_sha256) takes the new block too, so a source write of the same upstream file is still
 * no change (versionFromSource) and a local edit made before this one survives it.
 */
export function editSupplied(ctx: Ctx, p: Principal, item: ItemRow, description: string): ItemRow {
  const old = suppliedOf(item);
  if (!old) throw notFound('supplied frontmatter');
  return swapSupplied(ctx, p, item, suppliedFor(item, { ...old, description }), 'edit supplied frontmatter');
}

/**
 * editSupplied's write, shared with a re-import whose only news is the supplied frontmatter (importUnit: the same commit, or one that left the unit alone):
 * the stored block (none yet: the new one goes in front of an entry without frontmatter) swapped for `next`.
 */
function swapSupplied(ctx: Ctx, p: Principal, item: ItemRow, next: SuppliedFrontmatter, note: string, waive = false): ItemRow {
  const { db } = ctx;
  const old = suppliedOf(item);
  const block = old ? prependFrontmatter('', suppliedFor(item, old))! : '';
  // tree with the old block swapped for the new one, or null when its entry no longer opens with the old block.
  const swap = (tree: TreeFile[]) => {
    const entry = entryOf(item.kind, tree);
    const text = entry ? utf8.decode(entry.bytes) : '';
    return text.startsWith(block) ? supply(item.kind, tree.map((f) => (f === entry ? { ...f, bytes: new TextEncoder().encode(text.slice(block.length)) } : f)), next) : null;
  };
  return tx(db, () => {
    let sourceSha = item.source_tree_sha256;
    if (!item.upstream_frontmatter) {
      const latest = resolveVersion(db, item);
      const swapped = swap(readTree(db, latest.id));
      if (!swapped) throw new HttpError(409, 'frontmatter_edited', "the entry's frontmatter was written by hand, not the block SCP supplied; edit the file instead");
      const v = addVersion(ctx, p, item, { tree: swapped, note }, { waiveFrontmatter: waive });
      if (sourceSha === latest.tree_sha256) sourceSha = v.tree_sha256;
      else if (sourceSha) {
        const src = db.prepare('SELECT id FROM item_versions WHERE item_id = ? AND tree_sha256 = ? ORDER BY seq DESC LIMIT 1').get(item.id, sourceSha) as { id: string } | undefined;
        const t = src && swap(readTree(db, src.id));
        if (t) sourceSha = treeSha256(t.map((f) => ({ path: f.path, mode: f.mode, sha256: sha256Hex(f.bytes) })));
      }
    }
    db.prepare('UPDATE items SET supplied_frontmatter = ?, source_tree_sha256 = ? WHERE id = ?').run(JSON.stringify(next), sourceSha, item.id);
    return getItemRow(db, item.id)!;
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
    // A loose .md imported as a design (mvfp folderKinds) holds it as DESIGN.md.
    if (item.kind === 'design' && isMd(tree[0].path)) return [{ ...tree[0], path: 'DESIGN.md' }];
    // mas4: the one .md file a skill was imported from (its source path names that file) is its SKILL.md again.
    if (item.kind === 'skill' && isMd(tree[0].path) && item.source_path !== null && baseOf(item.source_path) === tree[0].path) return [{ ...tree[0], path: 'SKILL.md' }];
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
  // nenk: an import that kept the repository's tooling keeps it in the root skill on every update too.
  const pluginFolder = item.source_scope === 'root' && !!item.source_path;
  const rootOf = (includeRepoTooling: boolean) => detectUnits(kept, item.name, { pluginFolder, includeRepoTooling }).units.find((u) => u.path === '' && u.kind === 'skill');
  const root = rootOf(!!item.source_tooling);
  if (!root || root.tree.length === kept.length) return whole;
  if (item.source_scope === 'root') {
    if (item.source_tooling) return root.tree;
    // source_tooling is 0 on every row from before it was recorded, ones imported with the flag included.
    // While the latest version holds a file only the tooling detection keeps, it is detected with it, so an
    // update never drops GEMINI.md or .claude/ unreported; a re-import records the flag either way.
    const tooled = rootOf(true);
    const toolingOnly = new Set(tooled?.tree.map((f) => f.path));
    for (const f of root.tree) toolingOnly.delete(f.path);
    if (!tooled || !toolingOnly.size) return root.tree;
    return listFiles(db, resolveVersion(db, item).id).some((f) => toolingOnly.has(f.path)) ? tooled.tree : root.tree;
  }
  const carved = new Set(whole.map((f) => f.path));
  for (const f of root.tree) carved.delete(f.path);
  const stored = listFiles(db, resolveVersion(db, item).id);
  return stored.some((f) => carved.has(f.path)) ? whole : root.tree;
}

/** GitHub resolves repository names case-insensitively, and a zip's name is a file name on a case-insensitive disk. */
const sameRepo = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/**
 * `<prefix>-<name>` as a slug (5ef6); undefined past the 64-character name cap, where the unit is not
 * prefixed: a cut name no longer ends in `-<name>` (keepPrefix), and two long names can cut to one.
 */
const prefixed = (prefix: string, name: string) => {
  const s = slugify(`${prefix}-${name}`, Infinity);
  return s.length <= 64 ? s : undefined;
};
const TOO_LONG = 'would exceed the 64-character name limit';

/**
 * A skill's SKILL.md or an agent's one file with its frontmatter name set to name, inserted when it
 * names none (5ef6). Frontmatter that does not parse cannot take it: 422, the unit skipped at import and
 * the source write refused, never stored under its bare name. what: 'prefixed name' or 'name' (supplied).
 */
function pinName(kind: Kind, tree: TreeFile[], name: string, what = 'prefixed name'): TreeFile[] {
  if (kind !== 'skill' && kind !== 'agent') return tree;
  return tree.map((f) => {
    if (kind === 'skill' ? f.path !== 'SKILL.md' : tree.length !== 1) return f;
    // jcfm: an entry with no frontmatter takes the block SCP supplies (supply), which carries the name;
    // a name-only block here would keep it out. ponytail: with no description to supply it stays nameless.
    if (!parseFrontmatter(utf8.decode(f.bytes)).hasFrontmatter) return f;
    const text = renameFrontmatter(utf8.decode(f.bytes), name);
    if (text === null) throw new HttpError(422, 'frontmatter_invalid', `its frontmatter is not valid YAML, so it cannot take the ${what} '${name}'`);
    return { ...f, bytes: new TextEncoder().encode(text) };
  });
}

/**
 * u, which took the name `from`, under the name `to` (5ef6). Its frontmatter name follows, as a renamed
 * fork's does (a supplied one too, jcfm): a skill's must match its install folder. A second rename (an
 * in-import prefix, then a cross-source one) keeps the first `from` as the bare name.
 */
const renamed = (u: Unit, from: string, to: string): Unit => ({
  ...u,
  name: to,
  tree: pinName(u.kind, u.tree, to),
  bare: u.bare ?? from,
  ...(u.supplied?.name !== undefined && { supplied: { ...u.supplied, name: to } }),
});

/** 5ef6: what u's renames put in front of its bare name ('fork-discord' for fork-discord-access), recorded as source_prefix. */
const prefixOfName = (u: Unit) => (u.bare && u.name?.endsWith(`-${u.bare}`) ? u.name.slice(0, -(u.bare.length + 1)) : undefined);

/** 5ef6: the item is its source's unit `bare` under the prefix it recorded at import (source_prefix); else wasPrefixed. */
const isPrefixed = (item: ItemRow, bare: string) => (item.source_prefix ? item.name === `${item.source_prefix}-${bare}` : wasPrefixed(item, bare));

/**
 * 5ef6, for an item with no recorded source_prefix: the item is its source's unit `bare` under a prefix an
 * import of that source gives: the repository (or zip) name for a clash across sources (clashPrefix), or a
 * folder above the unit for one inside the import (Unit.prefixes). One candidate only, so an item that took
 * both (fork-discord-access) is not recognised. ponytail: inferred, so an unprefixed `pdf-tools` under a
 * `pdf/` folder (or from a repository named pdf) still reads as prefixed. It serves rows from before the
 * source_prefix column; an unprefixed row since also records null, so it is inferred the same way.
 */
function wasPrefixed(item: ItemRow, bare: string): boolean {
  const repo = item.source_repo ?? '';
  const own = item.source_kind === 'zip' ? repo.replace(/\.(zip|skill)$/i, '') : baseOf(repo);
  return [own, ...dirOf(item.source_path ?? '').split('/')].some((px) => !!px && prefixed(px, bare) === item.name);
}

/**
 * 5ef6: the upstream entry of a prefixed skill or agent names it bare, or nothing at all (or its YAML
 * does not parse); it takes the item's prefixed name again, as at import (pinName refuses what it cannot set).
 * pin (mas4): SCP supplied the name, so whatever name upstream's own frontmatter gives becomes the item's (its install folder).
 * ponytail: a nameless entry counts as prefixed only by a recorded source_prefix; a row from before the
 * column keeps upstream's nameless entry, still installed under its prefixed folder.
 */
function keepPrefix(item: ItemRow, tree: TreeFile[], pin = false): TreeFile[] {
  const entry = item.kind === 'skill' ? tree.find((f) => f.path === 'SKILL.md') : item.kind === 'agent' && tree.length === 1 ? tree[0] : undefined;
  if (!entry) return tree;
  const fmName = parseFrontmatter(utf8.decode(entry.bytes)).data.name;
  if (fmName === item.name) return tree;
  const bare = typeof fmName === 'string' ? slugify(fmName) : '';
  const isPre = bare ? isPrefixed(item, bare) : !!item.source_prefix && item.name.startsWith(`${item.source_prefix}-`);
  return pin || isPre ? pinName(item.kind, tree, item.name, isPre ? 'prefixed name' : 'name') : tree;
}

/**
 * The tree a source write versions upstream's unit tree as: `own` (the supplied fields) in front of an
 * entry without frontmatter; else upstream's own block, wins for everything but a skill's or agent's name
 * when SCP supplied it or a prefix (keepPrefix).
 */
const sourceTree = (item: ItemRow, tree: TreeFile[], own: SuppliedFrontmatter | null | undefined): TreeFile[] =>
  (own && supply(item.kind, tree, own)) || keepPrefix(item, tree, own?.name !== undefined);

/** The file a kind's frontmatter lives in, when the tree has it at the entry path. */
function entryOf(kind: Kind, tree: TreeFile[]): TreeFile | undefined {
  if (kind === 'skill' || kind === 'design') return tree.find((f) => f.path === (kind === 'skill' ? 'SKILL.md' : 'DESIGN.md'));
  return SINGLE_FILE.has(kind) && tree.length === 1 ? tree[0] : undefined;
}

/** jcfm: tree with `fields` as its entry's frontmatter, or null when upstream's entry has its own (which wins) or there is no entry. */
export function supply(kind: Kind, tree: TreeFile[], fields: SuppliedFrontmatter): TreeFile[] | null {
  const entry = entryOf(kind, tree);
  const text = entry && prependFrontmatter(utf8.decode(entry.bytes), fields);
  return text ? tree.map((f) => (f === entry ? { ...f, bytes: new TextEncoder().encode(text) } : f)) : null;
}

/** A skill's or agent's supplied name is always its item's: a prefixed (5ef6) item keeps the prefix. */
const suppliedFor = (item: ItemRow, fields: SuppliedFrontmatter): SuppliedFrontmatter => (fields.name === undefined ? fields : { ...fields, name: item.name });

function unitInput(u: Unit, opts: ImportOpts): CreateItemInput & { source: ItemSource } {
  // A file path re-rooted to its name (subtree) would otherwise join to '<file>/<name>', which no update finds.
  const source: ItemSource = { ...opts.source, path: opts.pathIsFile ? opts.source.path : [opts.source.path, u.path].filter(Boolean).join('/') || null };
  // The root detection unit is the one carved from its siblings; a kind override, a folder import or any folder unit took the whole tree (updateTree).
  const sourceScope: NonNullable<ItemRow['source_scope']> = u.scope ?? (!opts.kind && u.path === '' && u.kind === 'skill' ? 'root' : 'tree');
  const supplied = u.supplied && supply(u.kind, u.tree, u.supplied);
  return {
    kind: u.kind,
    name: u.name,
    tree: supplied || u.tree,
    visibility: opts.visibility,
    source,
    sourceScope,
    sourceCarve: u.carve,
    sourcePrefix: prefixOfName(u),
    note: opts.note,
    fallbackName: u.fallbackName,
    folderName: u.folderName,
    suppliedFrontmatter: supplied ? u.supplied : undefined,
    sourceTooling: opts.includeRepoTooling,
  };
}

/**
 * waive: accept the unit's frontmatter errors (0rdh). retried: this is the `<repo>-` prefixed attempt, of the name that was taken (5ef6).
 * carried: `kind:name` of every name this import's units take (naming-1).
 */
function importUnit(ctx: Ctx, p: Principal, u: Unit, opts: ImportOpts, waive: boolean, retried?: string, carried?: Set<string>): UnitResult {
  const input = unitInput(u, opts);
  const { source } = input;
  // Re-import = update: the item of this kind from this very unit (same repo and path) under the name the
  // unit takes, or under that name's prefix (5ef6) once the clash that forced it is gone. A unit renamed
  // upstream must not write its new name into the item that kept the old one: it is a new unit, created
  // beside it or skipped on the name. A recorded prefix is matched against the unit's bare name, so
  // fork-discord-access is found whether this import prefixes the unit inside it again (discord-access) or
  // not (access). A name SCP supplied (mas4) is the item's identity whatever name upstream's own
  // frontmatter later gives (sourceTree pins it). The oldest wins should an earlier bug have left two.
  const takes = previewItem(input, waive)?.name;
  const bare = u.bare ?? takes;
  // y15q: the name a one-file unit took before v4 (go-md for commands/go.md, where its name of last resort was
  // the file name): an item under it is this unit and keeps that name, written with upstream's tree as then.
  // ponytail: an old name that a clash also prefixed (<repo>-go-md) is not matched, so that one comes back as a new item.
  const old = opts.pathIsFile && source.path ? preV4RootName(source.path, baseOf(source.repo ?? ''), opts.kind === 'skill') : undefined;
  const was = (n?: string) => (n === opts.rootName ? old : n);
  const legacy = old && previewItem({ ...input, fallbackName: was(input.fallbackName), folderName: was(input.folderName) }, waive)?.name;
  // t1ge: an unclosed fence was named before v4 from a heading anywhere in its text, the YAML's lines
  // included ('---\n# Project Guide\n...' was project-guide): an item under that name is this unit too.
  // Upstream's entry: a supplied block (input.tree) goes only where there was none, so never on an unclosed one.
  const entry = entryOf(u.kind, u.tree);
  const headed = entry && parseFrontmatter(utf8.decode(entry.bytes)).error === UNCLOSED ? previewItem(input, waive, true)?.name : undefined;
  let own = takes
    ? (ctx.db.prepare('SELECT * FROM items WHERE owner_id = ? AND kind = ? AND source_path IS ? AND source_repo IS NOT NULL ORDER BY created_at, rowid').all(p.userId, u.kind, source.path) as unknown as ItemRow[])
      .find(
        (h) =>
          sameRepo(h.source_repo, source.repo) &&
          (h.name === takes || h.name === legacy || h.name === headed || h.name === u.bare || (h.source_prefix ? h.name === `${h.source_prefix}-${bare}` : wasPrefixed(h, takes)) || suppliedOf(h)?.name !== undefined),
      )
    : undefined;
  // naming-1: found under its recorded prefix, or under its bare name (an unprefixed copy of this import takes
  // that now, prefixClashes), while another unit of this import now carries that name (so prefixClashes gave
  // this one a longer prefix, or none): the item takes the name this import gives the unit, as a fresh import
  // names it, so the other unit is not refused on it. A name held elsewhere keeps the old one.
  let renamedNow = false;
  const underOld = !!own && (own.name === bare || (!!own.source_prefix && own.name === `${own.source_prefix}-${bare}`));
  if (own && takes && own.name !== takes && underOld && carried?.has(`${u.kind}:${own.name}`)) {
    if (!ctx.db.prepare('SELECT 1 FROM items WHERE owner_id = ? AND kind = ? AND name = ?').get(p.userId, u.kind, takes)) {
      ctx.db.prepare('UPDATE items SET name = ?, source_prefix = ? WHERE id = ?').run(takes, prefixOfName(u) ?? null, own.id);
      own = getItemRow(ctx.db, own.id)!;
      refreshFts(ctx.db, own.id);
      renamedNow = true;
    }
  }
  if (own) {
    // Found under its prefix: the unit's tree names it takes (or bare), and the item keeps its own name.
    const tree = own.name === takes || own.name === legacy || own.name === headed ? u.tree : pinName(u.kind, u.tree, own.name);
    // nenk: carved otherwise than last time (the same zip or commit with includeRepoTooling toggled): the stored
    // tree is not this carving's, so the same commit alone does not make it untouched below.
    const carve = u.carve?.length ? JSON.stringify(u.carve) : null; // as createItemTx stores it
    const recarved = !!own.source_tooling !== !!input.sourceTooling || own.source_carve !== carve;
    // How this import carved the unit replaces the last one's: the next source/update follows the manifest as it is now, with or without the tooling (nenk).
    ctx.db
      .prepare('UPDATE items SET source_scope = ?, source_carve = ?, source_tooling = ? WHERE id = ?')
      .run(input.sourceScope ?? null, carve, input.sourceTooling ? 1 : 0, own.id);
    // The same commit (or the same zip) again, or one whose unit tree, with the stored block, is what the
    // source last wrote: nothing changed upstream here, so a local edit made since stays the latest version.
    // The ref and commit still follow the ones named (a tag, then the branch at the same commit).
    // jcfm: frontmatter supplied that the item does not store yet is news of its own, but only the block
    // changes (swapSupplied, as the item page's edit): the rest of the latest version stays.
    // naming-6: never after a rename just now, even at the same commit (the same zip with includeRepoTooling
    // toggled): the stored entry still says the old `name:`, and a skill's name is its install folder, so the
    // unit's tree is written under the new name, as a different commit writes it.
    const stored = suppliedOf(own);
    const untouched = !renamedNow && ((!recarved && own.source_commit === source.commit) || (!!own.source_tree_sha256 && versionSha(own, sourceTree(own, tree, stored && suppliedFor(own, stored))) === own.source_tree_sha256));
    if (untouched) {
      ctx.db.prepare('UPDATE items SET source_ref = ?, source_commit = ? WHERE id = ?').run(source.ref, source.commit, own.id);
      const fm = u.supplied && suppliedFor(own, u.supplied);
      if (!fm || JSON.stringify(fm) === own.supplied_frontmatter) return { item: getItemRow(ctx.db, own.id)!, op: 'unchanged' };
      const item = swapSupplied(ctx, p, own, fm, opts.note, waive || !!own.lint_waived);
      return { item, op: item.latest_seq === own.latest_seq ? 'unchanged' : 'version' };
    }
    return versionFromSource(ctx, p, own, tree, source, opts.note, waive, u.supplied);
  }
  try {
    return { item: createItemTx(ctx, p, input, { waiveFrontmatter: waive }), op: 'create' };
  } catch (e) {
    if (!(e instanceof HttpError) || e.code !== 'name_taken') throw e;
    const taken = (e.details as { name: string }).name;
    const holder = ctx.db.prepare('SELECT * FROM items WHERE owner_id = ? AND kind = ? AND name = ?').get(p.userId, u.kind, taken) as ItemRow | undefined;
    // Two units of one source with the same name (two marketplace plugins shipping agents/code-reviewer.md): say which one holds it.
    // A skill under another tool's folder lost to a better-ranked copy (ypmn, detectUnits): say it is that tool's port.
    if (holder && sameRepo(holder.source_repo, source.repo)) {
      // Any kind: eg9k ranks a port plugin root's agents and commands last too.
      const port = unitPort(u);
      const at = holder.source_path ?? 'the root';
      throw new HttpError(409, 'name_taken', port ? `another copy of this ${u.kind} (${at}) was imported; this one is the ${port} port` : `${e.message}, imported from ${at} of ${holder.source_repo}`, e.details);
    }
    // 5ef6: another source's item (or a local one) holds the name. With onNameClash 'prefix' the unit
    // takes `<repo>-<name>`; otherwise the skip offers that name.
    const prefix = opts.clashPrefix ?? opts.rootName;
    const name = prefixed(prefix, taken);
    if (!retried && name && opts.onNameClash === 'prefix') return importUnit(ctx, p, renamed(u, taken, name), opts, waive, taken);
    // The prefixed name is held too: no upload or option would import it under either, so say that.
    if (retried) throw new HttpError(409, 'name_taken', `you already have ${aKind(u.kind)} named '${retried}', and its prefixed name '${taken}' is taken too${holder?.source_repo ? ` (imported from ${holder.source_repo})` : ''}`, e.details);
    // Past the name cap there is no prefixed name to offer, only the reason.
    const details = !name ? e.details : { ...(e.details as object), prefixed: name };
    const tooLong = name ? '' : `; '${prefix}-${taken}' ${TOO_LONG}, so it cannot take the prefix`;
    // A zip is identified by its file name (docs/PLAN-v2.md D1), so a renamed download reads as a new pack: say so.
    if (holder?.source_kind === 'zip') throw new HttpError(409, 'name_taken', `${e.message}, imported from ${holder.source_repo}; upload the file under that name to update it${tooLong}`, details);
    throw new HttpError(409, 'name_taken', e.message + tooLong, details);
  }
}

/**
 * 5ef6: units of one import sharing a kind and name (skills, and 7k2p agents and commands) each take their
 * prefix (Unit.prefixes), so a repository never drops its own; a copy an earlier import of this source
 * holds under the bare name (held) keeps it, so a re-import updates that item instead of stranding it.
 * Copies whose prefixed names still meet (plugins/a and other/a, 5vz2), or meet a name another unit of
 * the import carries, lengthen the prefix a folder at a time; a copy that runs out of folders, or whose
 * prefixed name would pass the name cap, is skipped (of copies out of folders on one name, the first keeps
 * it). Ports (ypmn) still give way, and are skipped when
 * every other copy was prefixed away from the bare name. Returns the indexes of the units skipped.
 */
function prefixClashes(units: Unit[], names: (string | undefined)[], opts: ImportOpts, skipped: Skipped[], held: (i: number, name: string) => boolean): Set<number> {
  const byName = new Map<string, number[]>();
  units.forEach((u, i) => {
    const n = names[i];
    if (!n) return;
    const list = byName.get(`${u.kind}:${n}`);
    if (list) list.push(i);
    else byName.set(`${u.kind}:${n}`, [i]);
  });
  const dropped = new Set<number>();
  // A generated name another unit of this import already carries would make that unit the clash's loser.
  const used = new Set(byName.keys());
  for (const idx of byName.values()) {
    const { kind } = units[idx[0]];
    const name = names[idx[0]]!;
    const copies = idx.filter((i) => !unitPort(units[i]));
    if (copies.length < 2) continue;
    // A copy with no prefixes keeps the bare name, as a fresh import names it, and a held copy with prefixes
    // takes its prefixed name (importUnit renames its item); with none, a copy an earlier import holds keeps it.
    const unprefixed = copies.filter((i) => !units[i].prefixes);
    const bare = unprefixed.length ? unprefixed : copies.filter((i) => held(i, name));
    // Each copy's prefixed names, shortest first, up to the name cap (a longer prefix only gets longer).
    const tries = new Map<number, string[]>();
    for (const i of copies) if (!bare.includes(i)) tries.set(i, units[i].prefixes!.map((px) => prefixed(px, name)).filter((n) => n !== undefined));
    for (let level = 0; tries.size; level++) {
      // A copy out of longer prefixes keeps offering its longest, which a copy still lengthening may free.
      const at = (i: number) => tries.get(i)!.at(Math.min(level, tries.get(i)!.length - 1));
      const stuck = [...tries.values()].every((c) => level >= c.length - 1);
      const meets = new Map<string | undefined, number>();
      for (const i of tries.keys()) meets.set(at(i), (meets.get(at(i)) ?? 0) + 1);
      for (const i of [...tries.keys()]) {
        const n = at(i);
        let why = n ? `'${n}' is the name of another ${kind} of this import` : `'${units[i].prefixes![0]}-${name}' ${TOO_LONG}`;
        // Once every copy is at its last prefix nothing can free a name, so the first of those meeting takes it.
        if (n && (meets.get(n) === 1 || stuck) && !used.has(`${kind}:${n}`)) {
          try {
            units[i] = renamed(units[i], name, n);
            used.add(`${kind}:${n}`);
            tries.delete(i);
            continue;
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            why = e.message;
          }
        } else if (n && !stuck) continue;
        tries.delete(i);
        dropped.add(i);
        skipped.push({ path: units[i].path, reason: `another ${kind} of this import is named '${name}', and ${why}` });
      }
    }
    // A held copy that found no free prefixed name keeps the bare name after all, as before v4: its item keeps
    // updating, and the unprefixed copies give way, where they would only be refused on its name (importUnit).
    const keep = unprefixed.length ? copies.find((i) => dropped.has(i) && held(i, name)) : undefined;
    if (keep !== undefined) {
      dropped.delete(keep);
      skipped.splice(skipped.findLastIndex((s) => s.path === units[keep].path), 1);
      const at = unitInput(units[keep], opts).source.path ?? 'the root';
      for (const i of unprefixed) {
        dropped.add(i);
        skipped.push({ path: units[i].path, reason: `another ${kind} of this import (${at}) is named '${name}', which an earlier import of this source gave it, and it has no free prefixed name to give way with` });
      }
      continue;
    }
    if (bare.length) continue;
    const at = unitInput(units[copies[0]], opts).source.path ?? 'the root';
    for (const i of idx.filter((i) => unitPort(units[i]))) {
      dropped.add(i);
      skipped.push({ path: units[i].path, reason: `another copy of this ${kind} (${at}) was imported; this one is the ${unitPort(units[i])} port` });
    }
  }
  return dropped;
}

/**
 * jv9q: detection's units and reports once the copied links took part. A unit wholly inside a copied
 * link whose every file another unit of its kind already imports (`CLAUDE.md -> AGENTS.md`,
 * `.agents/skills -> ../.claude/skills`) is that unit again, so it is dropped. A copied link no
 * remaining unit holds is reported as before; what detection said about its copies (a loose .md, a
 * folder to offer) is not, since the link's own entry says it. `unheld`: those links' paths.
 */
function linkUnits(units: Unit[], found: Skipped[], folders: SkippedFolder[], copied: ZipLink[]): { units: Unit[]; skipped: Skipped[]; skippedFolders: SkippedFolder[]; unheld: string[] } {
  if (!copied.length) return { units, skipped: found, skippedFolders: folders, unheld: [] };
  const at = new Set(copied.map((l) => l.path));
  const inLink = (p: string) => [...selfAndAbove(p)].some((x) => at.has(x));
  const copyKinds = new Set(units.filter((u) => inLink(u.path)).map((u) => u.kind));
  const own = new Set<string>();
  for (const u of units) if (copyKinds.has(u.kind) && !inLink(u.path)) for (const f of u.tree) own.add(`${u.kind}:${sha256Hex(f.bytes)}`);
  const kept = units.filter((u) => !inLink(u.path) || !u.tree.every((f) => own.has(`${u.kind}:${sha256Hex(f.bytes)}`)));
  // A unit holds the link it is, or sits in, or the folder unit around it took the link's copies (a skill's `scripts -> ../shared`).
  const holds = (u: Unit, l: string) => {
    if (u.path === l || u.path.startsWith(l + '/')) return true;
    if (u.path && !l.startsWith(u.path + '/')) return false;
    const rel = u.path ? l.slice(u.path.length + 1) : l;
    return u.tree.some((f) => f.path === rel || f.path.startsWith(rel + '/'));
  };
  const unheld = copied.filter((l) => !kept.some((u) => holds(u, l.path)));
  return {
    units: kept,
    skipped: [...unheld.map((l) => linkSkip(l)), ...found.filter((s) => !inLink(s.path))],
    skippedFolders: folders.filter((f) => !inLink(f.path)),
    unheld: unheld.map((l) => l.path),
  };
}

/**
 * Import every unit of a tree, plus the group when asked (created, or `intoGroup` added to), in one transaction. A unit that fails
 * (lint, name taken by an unrelated item, install-path conflict) is rolled back on its own and
 * reported in `skipped`; only the group slug being taken fails the whole import, and, before anything
 * is written, units with frontmatter errors when frontmatterErrors is 'ask' (409 frontmatter_errors, 0rdh).
 */
export function importTree(ctx: Ctx, p: Principal, tree: TreeFile[], opts: ImportOpts): ImportOutcome {
  requireScope(p, 'write');
  if (p.groupIds) throw new HttpError(403, 'restricted_key', 'a group-restricted API key cannot import items');
  let units: Unit[];
  const skipped: Skipped[] = [...(opts.skipped ?? [])];
  // A tree has no format, which every artifact needs (checkFormat): the single-file import is the way in.
  if (opts.kind === 'artifact') throw badRequest(ARTIFACT_FROM_TREE);
  let skippedFolders: SkippedFolder[] = [];
  // A kind override makes the tree one item, except a single-file kind on a folder (jwz6): one item per .md.
  if (opts.kind && (!SINGLE_FILE.has(opts.kind) || opts.pathIsFile)) {
    // mas4: one .md imported as a skill is that skill's SKILL.md, re-homed the same way on every source update (updateTree).
    const fileSkill = opts.kind === 'skill' && opts.pathIsFile && tree.length === 1 && isMd(tree[0].path);
    const unitTree = fileSkill ? [{ ...tree[0], path: 'SKILL.md' }] : tree;
    // A supplied name is the entry's frontmatter name too (5ef6 pinName), as a prefixed one is.
    units = [{ path: '', kind: opts.kind, tree: opts.name === undefined ? unitTree : pinName(opts.kind, unitTree, opts.name, 'name'), name: opts.name, fallbackName: opts.rootName, folderName: opts.rootName }];
  } else {
    const found: Skipped[] = [];
    if (opts.kind) units = fileUnits(tree, opts.kind, opts.rootName, found);
    else {
      const { folderKinds, layoutDir, folderRoot, includeRepoTooling } = opts;
      const detected = detectUnits(tree, opts.rootName, { layoutDir, folderRoot, includeRepoTooling, folderKinds });
      units = detected.units;
      found.push(...detected.skipped);
      skippedFolders = detected.skippedFolders;
    }
    const linked = linkUnits(units, found, skippedFolders, opts.copied ?? []);
    units = linked.units;
    // The links inside a copy no unit holds (linkCopies' hop entries) went with it: the link's own entry says it.
    // ponytail: a later copy of the same target still says its links are listed under this first one.
    const gone = (s: Skipped) => linked.unheld.some((l) => s.path.startsWith(l + '/'));
    skipped.splice(0, skipped.length, ...skipped.filter((s) => !gone(s)), ...linked.skipped);
    skippedFolders = linked.skippedFolders;
    if (opts.name !== undefined) {
      if (units.length !== 1) throw badRequest(`name applies to an import of exactly one item (found ${units.length})`);
      units[0] = { ...units[0], name: opts.name, tree: pinName(units[0].kind, units[0].tree, opts.name, 'name') };
    }
  }
  const meta = opts.group ? pluginMeta(tree) : null;
  // Detection reports a bad marketplace.json too, when its plugin pass ran (not for a kind override or a folder's SKILL.md): listed once.
  if (meta) skipped.push(...meta.skipped.filter((s) => !skipped.some((x) => x.path === s.path && x.reason === s.reason)));
  // The skip reasons travel as details, like the 422 below, so the UI can list what was passed over and
  // why, and the offered folders (mvfp) alongside: a code repository's docs/prompts/ is the case to ask about.
  const failed = (status: 400 | 422, code: string, message: string, details?: Skipped[]) =>
    Object.assign(new HttpError(status, code, message, details), { extra: skippedFolders.length ? { skippedFolders } : undefined });
  if (!units.length) throw failed(400, 'nothing_to_import', 'no skills, agents, commands, prompts, instructions or design files found', skipped.length ? skipped : undefined);
  const maxItems = importLimit(ctx, 'maxItems');
  if (units.length > maxItems) throw new HttpError(400, 'too_many_items', `at most ${maxItems} item${maxItems === 1 ? '' : 's'} per import (found ${units.length})`);
  // jcfm: one description cannot fit many items.
  if (opts.description !== undefined && units.length !== 1) throw badRequest(`description applies to an import of exactly one item (found ${units.length})`);
  // A package's entry is README.md or else its first .md, which can move between source updates: no one file to supply.
  if (opts.description !== undefined && units[0].kind === 'package') throw badRequest(PACKAGE_DESCRIPTION);
  const { db } = ctx;
  // A one-file import's unit is the root of its one-file tree (''): it is reported at the file's path.
  const at = (u: Unit) => (opts.pathIsFile && opts.source.path) || u.path;
  // jcfm: the description, else the fields an earlier import of the same unit stored, become the frontmatter of
  // a unit whose entry has none upstream (a skill or agent gets its name too); before the previews, so lint sees them.
  const storedFm = db.prepare('SELECT supplied_frontmatter AS s FROM items WHERE owner_id = ? AND kind = ? AND lower(source_repo) = lower(?) AND source_path IS ? AND supplied_frontmatter IS NOT NULL');
  units.forEach((u, i) => {
    const stored = opts.description === undefined && (storedFm.get(p.userId, u.kind, opts.source.repo, unitInput(u, opts).source.path) as { s: string } | undefined);
    const description = opts.description ?? (stored ? (JSON.parse(stored.s) as SuppliedFrontmatter).description : undefined);
    if (description === undefined) return;
    const name = u.kind === 'skill' || u.kind === 'agent' ? previewItem(unitInput(u, opts))?.name : undefined;
    const fields: SuppliedFrontmatter = name ? { name, description } : { description };
    if (supply(u.kind, u.tree, fields)) units[i] = { ...u, supplied: fields };
  });
  // Each unit named and linted as createItemTx will see it, before anything is written (5ef6, 0rdh).
  const mode = opts.frontmatterErrors ?? 'ask';
  const previews = units.map((u) => previewItem(unitInput(u, opts), mode === 'import'));
  const fmErrors = previews.map((pv) => {
    const errs = pv?.lint.filter((l) => l.level === 'error') ?? [];
    return errs.length > 0 && errs.every((l) => FRONTMATTER_ERRORS.has(l.code)) ? errs : null;
  });
  // A unit an earlier import of this source took with its frontmatter errors is taken again without asking (0rdh).
  const waivedBefore = db.prepare('SELECT 1 FROM items WHERE owner_id = ? AND kind = ? AND lower(source_repo) = lower(?) AND source_path IS ? AND lint_waived = 1');
  const waive = units.map((u, i) => mode === 'import' || (!!fmErrors[i] && !!waivedBefore.get(p.userId, u.kind, opts.source.repo, unitInput(u, opts).source.path)));
  if (mode === 'ask') {
    const asked: FrontmatterUnit[] = units.flatMap((u, i) => (fmErrors[i] && !waive[i] ? [{ path: at(u), kind: u.kind, errors: fmErrors[i].map((l) => l.message) }] : []));
    // Nothing is written yet, so no group either: the UI re-posts with the user's choice.
    if (asked.length) {
      throw new HttpError(409, 'frontmatter_errors', `${asked.length} of ${units.length} units have frontmatter errors: send frontmatterErrors 'import' to import them anyway or 'skip' to skip them`, asked);
    }
  }
  // Each unit named as importUnit names it, with its own waive: a unit an earlier import took with its errors is
  // waived now too, and a waived skill or agent takes no name from its heading (prepareItem). The unwaived
  // previews above only classify the errors.
  const named = units.map((u, i) => (waive[i] === (mode === 'import') ? previews[i] : previewItem(unitInput(u, opts), waive[i])));
  const holds = db.prepare('SELECT 1 FROM items WHERE owner_id = ? AND kind = ? AND name = ? AND lower(source_repo) = lower(?) AND source_path IS ?');
  const held = (i: number, name: string) => !!holds.get(p.userId, units[i].kind, name, opts.source.repo, unitInput(units[i], opts).source.path);
  // A unit its lint will refuse never imports, so its name forces no prefix on a twin that does.
  const imports = (i: number) => {
    const errs = named[i]?.lint.filter((l) => l.level === 'error' && !l.waived) ?? [];
    return !errs.length || (waive[i] && errs.every((l) => FRONTMATTER_ERRORS.has(l.code)));
  };
  const dropped = prefixClashes(units, named.map((pv, i) => (imports(i) ? pv?.name : undefined)), opts, skipped, held);
  // naming-1: the names this import's units take. A unit whose item holds, under its recorded prefix or its bare
  // name, a name another unit now takes imports first: importUnit renames that item before the other unit asks for the name.
  const final = (i: number) => units[i].name ?? named[i]?.name;
  const carried = new Set(units.flatMap((u, i) => (dropped.has(i) || !final(i) ? [] : [`${u.kind}:${final(i)}`])));
  const prefixedAt = db.prepare('SELECT name FROM items WHERE owner_id = ? AND kind = ? AND lower(source_repo) = lower(?) AND source_path IS ? AND (source_prefix IS NOT NULL OR name = ?)');
  const yields = units.map(
    (u, i) =>
      !dropped.has(i) &&
      (prefixedAt.all(p.userId, u.kind, opts.source.repo, unitInput(u, opts).source.path, u.bare ?? null) as { name: string }[]).some((r) => r.name !== final(i) && carried.has(`${u.kind}:${r.name}`)),
  );
  const order = [...units.keys()].sort((a, b) => +!yields[a] - +!yields[b]);
  return tx(db, () => {
    // intoGroup is re-read here: the route resolved it before a GitHub download that can take a minute,
    // and a group deleted meanwhile would fail every member insert on its foreign key (a 500).
    const into = opts.intoGroup && (getGroupRow(db, opts.intoGroup.id) as GroupRow | undefined);
    if (opts.intoGroup && !(into && canEditGroup(p, into))) throw notFound('group');
    const group = opts.group
      ? createGroup(ctx, p, { slug: opts.group, name: opts.groupName ?? meta?.name ?? opts.defaultGroupName ?? opts.rootName, description: meta?.description })
      : (into || null);
    const results: UnitResult[] = [];
    let added = 0;
    for (const i of order) {
      if (dropped.has(i)) continue;
      const u = units[i];
      db.exec('SAVEPOINT unit');
      try {
        const r = importUnit(ctx, p, u, opts, waive[i], undefined, carried);
        // 0rdh: the unit's upstream frontmatter errors were accepted, also when an in-import prefix wrote the
        // missing name (pinName) so no waived lint is left: a later ask-mode import takes it without asking (waivedBefore).
        if (named[i]?.lint.some((l) => l.waived) && !r.item.lint_waived) db.prepare('UPDATE items SET lint_waived = 1 WHERE id = ?').run(r.item.id);
        // A re-import into the same group versions its members; they stay members once (p2wf).
        if (group && !isMember(db, group.id, r.item.id)) {
          addMemberTx(ctx, p, group, { itemId: r.item.id });
          added++;
        }
        db.exec('RELEASE unit');
        results.push(r);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        db.exec('ROLLBACK TO unit; RELEASE unit');
        const offer = e.code === 'name_taken' ? (e.details as { prefixed?: string } | undefined)?.prefixed : undefined;
        skipped.push({ path: at(u), reason: reasonOf(e), ...(offer && { prefixed: offer }) });
      }
    }
    // Nothing imported is a failure, not a 201 with an empty list a script would record as success; and no
    // group either: an empty one would commit, burn its slug (deleted_group_slugs) and send the UI away
    // from the skip reasons, which travel in the error details instead.
    if (!results.length) throw failed(422, 'nothing_imported', opts.group ? 'every unit was skipped, so the group was not created' : 'every unit was skipped', skipped);
    return { group, groupCreated: !!opts.group, added, results, skipped, skippedFolders };
  });
}
