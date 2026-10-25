import { badRequest } from './http.ts';

// C0, DEL and C1 controls, plus invisible and bidi formatting (U+202E makes 'txt.exe' read as
// 'exe.txt': trojan-source names), and the BOM. U+206A-206F are the deprecated format characters
// HFS+ ignores (git's is_hfs_dotgit lists them): '.g\u206ait' is '.git' on such a volume.
// U+061C (Arabic letter mark) and U+2028/2029 (line/paragraph separators) are invisible breaks too.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u061c\u2028\u2029\u206a-\u206f]/;

export const MAX_PATH_DEPTH = 32;

/**
 * Validate one uploaded file path and return it unchanged. Paths are re-served and re-zipped to
 * agents that write them to disk, so anything that could escape the target folder is rejected.
 */
export function normalizePath(p: string): string {
  const bad = (why: string) => badRequest(`invalid path '${p.slice(0, 120)}': ${why}`);
  if (!p) throw bad('empty');
  if (p.length > 255) throw bad('longer than 255 characters');
  if (CONTROL.test(p)) throw bad('control character');
  // A lone surrogate is stored as U+FFFD, so two different ones collide in the database (a 500).
  if (!p.isWellFormed()) throw bad('not valid Unicode');
  if (p.includes('\\')) throw bad('backslash');
  if (p.startsWith('/')) throw bad('absolute path');
  if (/^[A-Za-z]:/.test(p)) throw bad('drive letter');
  if (p.endsWith('/')) throw bad('trailing slash');
  // Windows: ':' opens an NTFS stream (.git::$INDEX_ALLOCATION is .git), the rest are invalid names.
  if (/[<>:"|?*]/.test(p)) throw bad('character not allowed on Windows (<>:"|?*)');
  const segs = p.split('/');
  // Conflict checks and bundles index every ancestor folder of every path; real trees are shallow.
  if (segs.length > MAX_PATH_DEPTH) throw bad(`more than ${MAX_PATH_DEPTH} segments deep`);
  for (const s of segs) {
    const why = segmentProblem(s);
    if (why) throw bad(why);
  }
  return p;
}

/**
 * Why one path segment is unsafe to write on every OS, or null. Item names and group slugs become
 * install-path segments too, so they go through this as well: Windows drops a trailing dot, which
 * would merge '.scp/packages/kit./' into 'kit/' without any conflict check noticing.
 */
export function segmentProblem(s: string): string | null {
  if (!s) return 'empty segment';
  if (s === '.' || s === '..') return `'${s}' segment`;
  if (s.endsWith(' ') || s.endsWith('.')) return 'segment ends in a space or dot';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) return `'${s}' is a Windows device name`;
  // 8.3 short-name aliases: GIT~1 is .git on NTFS volumes with short names enabled.
  if (/~\d+(\.|$)/.test(s)) return `'${s}' looks like a Windows 8.3 short name`;
  return null;
}

/** A `./`-style relative path with `.` and `..` resolved, or null when it climbs above where it starts. */
export function relPath(p: string): string | null {
  const segs: string[] = [];
  for (const s of p.split('/')) {
    if (s === '..') {
      if (segs.pop() === undefined) return null;
    } else if (s && s !== '.') segs.push(s);
  }
  return segs.join('/');
}

const JUNK_DIRS = new Set(['__pycache__', 'node_modules', '.git', '__macosx']);

/** Build/OS litter that package_skill.py also drops. Dropped silently (reported as info lint). Case-insensitive. */
export function isJunkPath(p: string): boolean {
  const segs = p.toLowerCase().split('/');
  const last = segs[segs.length - 1];
  return segs.some((s) => JUNK_DIRS.has(s)) || last === '.ds_store' || last.endsWith('.pyc');
}

/**
 * The identity of a path on a case-insensitive, normalizing filesystem (macOS stores 'café' as NFD,
 * so NFC and NFD spellings are one file). Every collision check compares paths through this.
 */
export const pathKey = (p: string) => p.normalize('NFC').toLowerCase();

/** Reject paths that collide on such a filesystem (pathKey), or a file that is also a folder. */
export function assertNoCollisions(paths: string[]): void {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const p of paths) {
    const l = pathKey(p);
    if (files.has(l) || dirs.has(l)) throw badRequest(`path '${p}' collides with another file`);
    files.add(l);
    const segs = l.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  for (const d of dirs) if (files.has(d)) throw badRequest(`path '${d}' is both a file and a folder`);
}

const TEXT_EXT = new Set(
  (
    'md markdown mdc txt text html htm svg mmd js jsx ts tsx mjs cjs json jsonc yaml yml toml css scss less py sh bash zsh fish ps1 psm1 ' +
    'bat cmd rb go rs java kt c h cc cpp hpp cs php sql xml csv tsv ini cfg conf env lock ex exs heex eex lua r swift vue svelte ' +
    'log rst tex graphql gql proto gradle tf hcl dockerfile makefile gitignore gitattributes editorconfig npmrc'
  ).split(' '),
);

const extOf = (path: string) => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
};

/** Text by extension; extensionless files (setup, LICENSE, VERSION) are treated as text. */
export const isTextPath = (path: string) => {
  const ext = extOf(path);
  return ext === '' || TEXT_EXT.has(ext);
};

const MEDIA: Record<string, string> = {
  html: 'text/html', htm: 'text/html', svg: 'image/svg+xml', md: 'text/markdown', markdown: 'text/markdown',
  json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript',
  css: 'text/css', csv: 'text/csv', xml: 'application/xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2',
  zip: 'application/zip', wasm: 'application/wasm',
};

/** The real media type of a path. Never use it to serve user content from the app origin. */
export const mediaTypeFor = (path: string) =>
  MEDIA[extOf(path)] ?? (isTextPath(path) ? 'text/plain' : 'application/octet-stream');
