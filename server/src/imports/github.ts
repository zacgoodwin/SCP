import { createHash } from 'node:crypto';
import { importLimit } from '../admin/settings.ts';
import { HttpError, MB, badRequest } from '../lib/http.ts';
import { isJunkPath, normalizePath } from '../lib/paths.ts';
import { LIMITS, modeOf, tooLarge, type TreeFile } from '../lib/tree.ts';
import { zipLink, type ZipLink } from '../lib/zip.ts';
import type { Ctx, Principal } from '../types.ts';

export interface GithubSource {
  /** `owner/repo` */
  repo: string;
  /** Branch, tag or sha; null = the repo's default branch. */
  ref: string | null;
  /** Folder inside the repo; null = the root. */
  path: string | null;
}

const TIMEOUT_MS = 60_000;
/**
 * Zipball downloads in flight at once, process-wide: each holds up to the archive cap
 * (`import.max_archive_mb`) of chunks, their concatenation and the inflated tree for up to a minute,
 * so an unbounded number is the memory bill of one write key. ponytail: refused (503, Retry-After) rather than queued.
 */
export const ZIPBALL_SLOTS = 3;
let zipballsInFlight = 0;

/** Run `fn` (download, unzip and import) holding one of ZIPBALL_SLOTS, or answer 503 at once. */
export async function withZipballSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (zipballsInFlight >= ZIPBALL_SLOTS) {
    throw new HttpError(503, 'busy', `${ZIPBALL_SLOTS} repository downloads are already in progress; try again in a moment`, { retryAfter: 5 });
  }
  zipballsInFlight++;
  try {
    return await fn();
  } finally {
    zipballsInFlight--;
  }
}
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,200}$/;
/** A ref that is itself a commit sha never moves, so such an item is always up to date. */
export const SHA_REF = /^[0-9a-f]{7,40}$/;

export const badSource = (why: string) => new HttpError(400, 'bad_source', why);
const githubError = (why: string) => new HttpError(502, 'github_error', why);
/** GitHub's own answer for a repository the caller may not see, private ones included: one text, no oracle. */
const noRepo = (what: string) => badSource(`GitHub has no ${what} (private repos need a github.token)`);

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw badSource('malformed URL');
  }
};

/**
 * `{url}` or `{repo, ref?, path?}` -> a validated source. URL forms: `https://github.com/{o}/{r}` (also
 * `www.github.com`, `http:` or no scheme at all),
 * `.../tree/{ref}/{path}` and `.../blob/{ref}/{path}/FILE.md` (the file's folder; with `kind: skill`
 * the file itself when it is a .md other than SKILL.md, y15q: one .md as a skill, mas4). Owner, repo and ref are
 * restricted to characters that cannot steer the API path (no `..`, `?`, `#`, `@`, `:`).
 */
export function parseGithubSource(input: { url?: string; repo?: string; ref?: string; path?: string; kind?: string }): GithubSource {
  let { repo, ref, path } = input;
  if (input.url !== undefined) {
    // The shapes people paste: no scheme, www., http: (only the web URL's path is read, never fetched).
    const raw = input.url.trim();
    let u: URL;
    try {
      u = new URL(/^(www\.)?github\.com\//i.test(raw) ? `https://${raw}` : raw);
    } catch {
      throw badSource('not a URL');
    }
    const host = u.hostname.toLowerCase();
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || (host !== 'github.com' && host !== 'www.github.com')) throw badSource('only https://github.com URLs are supported');
    const segs = u.pathname.split('/').filter(Boolean).map(decode);
    if (segs.length < 2) throw badSource('URL must name owner/repo');
    repo = `${segs[0]}/${segs[1].replace(/\.git$/, '')}`;
    if (segs.length > 2) {
      if ((segs[2] !== 'tree' && segs[2] !== 'blob') || segs.length < 4) throw badSource('URL must be a repo, /tree/<ref>/<path> or /blob/<ref>/<path>/<file> URL');
      ref = segs[3];
      const last = segs.at(-1)!;
      const folderOf = segs[2] === 'blob' && !(input.kind === 'skill' && /\.md$/i.test(last) && !/^skill\.md$/i.test(last));
      path = (folderOf ? segs.slice(4, -1) : segs.slice(4)).join('/');
    }
  }
  if (!repo) throw badSource('url or repo is required');
  const parts = repo.trim().split('/');
  if (parts.length !== 2 || parts.some((s) => !NAME.test(s) || s === '.' || s === '..')) throw badSource(`repo '${repo.slice(0, 80)}' must be owner/repo`);
  repo = parts.join('/');
  if (ref !== undefined) {
    ref = ref.trim();
    if (!REF.test(ref) || ref.includes('..') || ref.startsWith('/') || ref.endsWith('/')) throw badSource(`invalid ref '${ref.slice(0, 80)}'`);
  }
  path = path?.trim().replace(/^\/+|\/+$/g, '') || undefined;
  if (path !== undefined) {
    try {
      normalizePath(path);
    } catch (e) {
      throw badSource((e as Error).message);
    }
  }
  return { repo, ref: ref || null, path: path ?? null };
}

/** Env token first, then the `github.token` setting (D4 writes it). */
export function githubToken(ctx: Ctx): string | null {
  if (ctx.config.githubToken) return ctx.config.githubToken;
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'github.token'").get() as { value: string } | undefined;
  return row?.value.trim() || null;
}

/** One request to the configured GitHub API origin and nowhere else (redirects it issues are followed). */
async function ghGet(ctx: Ctx, path: string, accept: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'scp-import', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = githubToken(ctx);
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${ctx.config.githubApiUrl}${path}`, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw githubError(`GitHub request failed: ${(e as Error).message}`);
  }
  if (res.status === 404 || res.status === 422) {
    await res.body?.cancel();
    throw noRepo(path.replace(/^\/repos\//, ''));
  }
  if (!res.ok) {
    await res.body?.cancel();
    // The quota is the instance's one shared identity (its token, or the egress IP): name the reset instead of a vague 502.
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const at = reset ? ` until ${new Date(reset * 1000).toISOString()}` : '';
      throw new HttpError(429, 'rate_limited', `GitHub's rate limit for this server is exhausted${at}; ${githubToken(ctx) ? 'try again later' : 'set a github.token to raise it'}`);
    }
    throw githubError(`GitHub answered ${res.status}${res.status === 403 ? ' (rate limited or token refused)' : ''}`);
  }
  return res;
}

async function ghJson(ctx: Ctx, path: string): Promise<Record<string, unknown>> {
  const res = await ghGet(ctx, path, 'application/vnd.github+json');
  try {
    const v: unknown = await res.json();
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw githubError('GitHub answered with malformed JSON');
  }
}

/**
 * The repository as GitHub names it (`full_name`: names resolve case-insensitively and renames
 * redirect, so the canonical spelling is the one that identifies an item), the full sha `ref` points
 * at (the default branch when ref is null), and the ref actually used. The instance token
 * (githubToken) reaches every private repository it was granted; a plain account must not read those
 * through it, so a private repository imports for admins only, and is refused with the very answer a
 * missing one gets: GitHub hides private repositories behind a 404, and the token must not turn an
 * account into an oracle for their names. Every route that contacts GitHub for a repository goes
 * through here.
 */
export async function resolveCommit(ctx: Ctx, p: Principal, repo: string, ref: string | null): Promise<{ repo: string; ref: string; sha: string }> {
  const r = await ghJson(ctx, `/repos/${repo}`);
  if (r.private === true && !p.isAdmin) throw noRepo(repo);
  const full = typeof r.full_name === 'string' ? r.full_name.split('/') : [];
  if (full.length === 2 && full.every((s) => NAME.test(s))) repo = full.join('/');
  if (!ref) {
    if (typeof r.default_branch !== 'string' || !REF.test(r.default_branch)) throw githubError('GitHub did not name a default branch');
    ref = r.default_branch;
  }
  const c = await ghJson(ctx, `/repos/${repo}/commits/${ref}`);
  if (typeof c.sha !== 'string' || !/^[0-9a-f]{40}$/.test(c.sha)) throw githubError('GitHub did not return a commit sha');
  return { repo, ref, sha: c.sha };
}

/** The archive cap (00tr `import.max_archive_mb`), checked per download. */
export const archiveTooLarge = (ctx: Ctx) => tooLarge(`the repository archive is over ${importLimit(ctx, 'maxArchiveMb')} MB`);

/**
 * The repo zipball at sha, read in chunks and abandoned once it passes the archive cap: null then, and
 * the caller answers archiveTooLarge or, for a folder, fetches it file by file (fetchFolder).
 */
export async function fetchZipball(ctx: Ctx, repo: string, sha: string): Promise<Uint8Array | null> {
  const cap = importLimit(ctx, 'maxArchiveMb') * MB;
  const res = await ghGet(ctx, `/repos/${repo}/zipball/${sha}`, '*/*');
  if (Number(res.headers.get('content-length')) > cap) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((total += value.length) > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch (e) {
    throw githubError(`GitHub download failed: ${(e as Error).message}`);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

interface GitEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}
const GIT_SHA = /^[0-9a-f]{40}$/;
/** Blob downloads in flight at once for one folder. */
const BLOB_CONCURRENCY = 8;

/** One git/trees listing, with what GitHub says is left of the quota (Infinity when it does not say). */
async function gitTree(ctx: Ctx, repo: string, sha: string, recursive: boolean): Promise<{ entries: GitEntry[]; truncated: boolean; remaining: number }> {
  const res = await ghGet(ctx, `/repos/${repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, 'application/vnd.github+json');
  const left = res.headers.get('x-ratelimit-remaining');
  let v: { tree?: unknown; truncated?: unknown } | null;
  try {
    v = await res.json();
  } catch {
    throw githubError('GitHub answered with malformed JSON');
  }
  const ok = (e: unknown) => {
    const x = e as Partial<GitEntry> | null;
    return typeof x?.path === 'string' && typeof x.mode === 'string' && typeof x.type === 'string' && typeof x.sha === 'string' && GIT_SHA.test(x.sha) && (x.type !== 'blob' || typeof x.size === 'number');
  };
  if (!Array.isArray(v?.tree) || !v.tree.every(ok)) throw githubError('GitHub answered with a malformed tree');
  return { entries: v.tree as GitEntry[], truncated: v.truncated === true, remaining: left === null ? Infinity : Number(left) };
}

/** One blob's bytes, checked against its git object id. */
async function gitBlob(ctx: Ctx, repo: string, e: GitEntry): Promise<Uint8Array> {
  const res = await ghGet(ctx, `/repos/${repo}/git/blobs/${e.sha}`, 'application/vnd.github.raw+json');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw githubError(`GitHub download failed: ${(err as Error).message}`);
  }
  // A git blob's object id is SHA-1 by definition: this checks the bytes against the tree listing, not a secret.
  // nosemgrep: scp.crypto.weak-hash
  if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== e.sha) throw githubError(`GitHub sent the wrong bytes for '${e.path}'`);
  return bytes;
}

/** One token of a pattern segment: '*' (any run of characters), else a test of exactly one character. */
type Tok = '*' | ((c: string) => boolean);
/** One segment of a pattern: its tokens, or '**' for a whole `**` segment, which spans folders ('**+' at least one). */
type Seg = Tok[] | '**' | '**+';
/** An attribute on a line, as git holds it: true `x`, false `-x`, null `!x` (unspecified), else the value of `x=value`. */
type State = [name: string, value: boolean | null | string];
const EXPORT_IGNORE = 'export-ignore';

/** m5wy: one line of a .gitattributes in `dir` ('' the root) that names `export-ignore` or a macro. */
interface IgnoreRule {
  /** As bytes (asBytes), like the paths it is matched against. */
  dir: string;
  /** How many segments `dir` has: a path's segments past them are matched. */
  depth: number;
  segs: Seg[];
  /** The pattern ended in '/': it matches folders only. */
  dirOnly: boolean;
  /** The line's `export-ignore` and macro attributes, in line order. */
  states: State[];
}

/**
 * A string as its UTF-8 bytes, one character each: git reads a .gitattributes and matches paths byte by
 * byte, so `?` is one byte of 'é' and a line's length is its bytes.
 */
const asBytes = (s: string) => Buffer.from(s).toString('latin1');

/**
 * Steps one folder's export-ignore matching may take in all, a refusal past it (`refuse`). The
 * matchers below are polynomial, never exponential, but rules x paths x name length is still the
 * repository's to choose, and it runs on the event loop.
 */
interface Budget {
  left: number;
  refuse: () => HttpError;
}
const MATCH_STEPS = 20_000_000;
/** git skips an attribute line of this many bytes or more (attr.c `>=`), its CR and leading blanks counted; so does this. */
const ATTR_LINE = 2048;
/**
 * A .gitattributes over this is refused before it is fetched (a real one is a few KB), and so are the
 * ones a download reads past it together, counted per file read (one blob may sit in many folders).
 */
const ATTR_BYTES = MB;
/** More .gitattributes than this in and above one download's folders is refused before any is fetched: each is a request. */
const MAX_ATTR_FILES = 50;
/** More export-ignore lines than this in one download is refused as they are parsed: each is a rule held and matched. */
const MAX_ATTR_RULES = 10_000;

const spend = (b: Budget) => {
  if (--b.left < 0) throw b.refuse();
};

/** POSIX classes in a bracket expression as git's own ASCII ctype reads them (its space is not \v or \f), as lo/hi byte pairs. */
const POSIX_CLASSES = new Map(
  Object.entries({ alnum: '09AZaz', alpha: 'AZaz', blank: '  \t\t', cntrl: '\x00\x1f\x7f\x7f', digit: '09', graph: '!~', lower: 'az', print: ' ~', punct: '!/:@[`{~', space: '\t\n\r\r  ', upper: 'AZ', xdigit: '09AFaf' }),
);

/**
 * The bracket expression at p[i] as git's wildmatch reads it: its test and its closing index. A ']'
 * first (after '!' or '^', which negate) is a member, '\' escapes, `a-z` is a range (its first end a
 * member even when reversed), `[:name:]` a class and a '[:' with no ':]' a '['. Members are a 256-bit
 * set, so the test is constant time. null where wildmatch gives up on the whole pattern: no closing ']', an unknown class.
 */
function bracket(p: string, i: number): [Tok, number] | null {
  const bits = [0, 0, 0, 0, 0, 0, 0, 0];
  const add = (lo: number, hi: number) => {
    for (let c = lo; c <= hi; c++) bits[c >> 5] |= 1 << (c & 31);
  };
  let j = i + 1;
  const negated = p[j] === '!' || p[j] === '^';
  if (negated) j++;
  // The member before, which may open a range; '' after a range or a class, as wildmatch's prev_ch = 0.
  let prev = '';
  for (let first = true; first || p[j] !== ']'; first = false, j++) {
    let c = p[j];
    if (c === undefined) return null;
    if (c === '\\') {
      if ((c = p[++j]) === undefined) return null;
      add(c.charCodeAt(0), c.charCodeAt(0));
    } else if (c === '-' && prev && p[j + 1] !== undefined && p[j + 1] !== ']') {
      let hi = p[++j];
      if (hi === '\\' && (hi = p[++j]) === undefined) return null;
      add(prev.charCodeAt(0), hi.charCodeAt(0));
      c = '';
    } else if (c === '[' && p[j + 1] === ':') {
      const end = p.indexOf(']', j + 2);
      if (end < 0) return null;
      if (end > j + 2 && p[end - 1] === ':') {
        const cls = POSIX_CLASSES.get(p.slice(j + 2, end - 1));
        if (!cls) return null;
        for (let k = 0; k < cls.length; k += 2) add(cls.charCodeAt(k), cls.charCodeAt(k + 1));
        j = end;
        c = '';
      } else add(91, 91);
    } else add(c.charCodeAt(0), c.charCodeAt(0));
    prev = c;
  }
  const want = negated ? 0 : 1;
  return [(ch) => ((bits[ch.charCodeAt(0) >> 5] >>> (ch.charCodeAt(0) & 31)) & 1) === want, j];
}

/**
 * A pattern as git's wildmatch reads it, in segments split at each '/' outside brackets ('\/' too):
 * `?`, `[...]`, `\x` and a literal match one character, a run of `*` is one '*', and a segment of
 * stars alone is '**' (followed by '\/' it skips git's no-folder shortcut, so '**+'). null where the
 * pattern matches nothing: wildmatch gives up on a trailing '\' or a bracket it cannot read.
 */
function patternSegs(p: string): Seg[] | null {
  const segs: Seg[] = [];
  let toks: Tok[] = [];
  let stars = 0;
  for (let i = 0; ; i++) {
    const c = p[i];
    const escSlash = c === '\\' && p[i + 1] === '/';
    if (c === undefined || c === '/' || escSlash) {
      segs.push(stars > 1 && toks.length === 1 ? (escSlash ? '**+' : '**') : toks);
      if (c === undefined) return segs;
      if (escSlash) i++;
      toks = [];
      stars = 0;
    } else if (c === '*') {
      // A run of stars matches what one does; each extra one would only add a backtrack point.
      stars++;
      if (toks.at(-1) !== '*') toks.push('*');
    } else if (c === '?') toks.push(() => true);
    else if (c === '[') {
      const b = bracket(p, i);
      if (!b) return null;
      toks.push(b[0]);
      i = b[1];
    } else {
      const lit = c === '\\' ? p[++i] : c;
      if (lit === undefined) return null;
      toks.push((ch) => ch === lit);
    }
  }
}

/** One path segment against one pattern segment: greedy, going back to the last '*' only (wildmatch), so O(name x pattern). */
function segMatch(toks: Tok[], s: string, b: Budget): boolean {
  let t = 0;
  let i = 0;
  let star = -1;
  let from = 0;
  while (i < s.length) {
    spend(b);
    const tok = toks[t];
    if (tok === '*') {
      star = t++;
      from = i;
    } else if (t < toks.length && tok(s[i])) {
      t++;
      i++;
    } else if (star >= 0) {
      t = star + 1;
      i = ++from;
    } else return false;
  }
  while (toks[t] === '*') t++;
  return t === toks.length;
}

/**
 * A path's segments against a pattern's: a '**' segment spans any number of folders, at least one when
 * it ends the pattern (`a/**` is what is inside a/) or is '**+'. Memoised per (pattern segment, path segment), so polynomial too.
 */
function pathMatch(segs: Seg[], path: string[], b: Budget): boolean {
  const memo = new Map<number, boolean>();
  const go = (p: number, s: number): boolean => {
    if (p === segs.length) return s === path.length;
    const key = p * (path.length + 1) + s;
    let r = memo.get(key);
    if (r !== undefined) return r;
    spend(b);
    const seg = segs[p];
    if (seg === '**' || seg === '**+') {
      r = false;
      for (let k = seg === '**+' || p === segs.length - 1 ? s + 1 : s; k <= path.length && !r; k++) r = go(p + 1, k);
    } else r = s < path.length && segMatch(seg, path[s], b) && go(p + 1, s + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** A valid attribute name (attr.c attr_name_valid); `builtin_` ones are reserved. */
const ATTR_NAME = /^(?!-|builtin_)[-.\w]+$/;
/** A pattern git can C-unquote (quote.c unquote_c_style); one it cannot is read bare, quote and all. */
const QUOTED = /^"((?:[^"\\]|\\(?:[abfnrtv\\"]|[0-3][0-7]{2}))*)"/;
const C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/**
 * One .gitattributes line as git's parse_attr_line reads it, split on git's blanks only (a BOM, which
 * git keeps in one read from the tree, stays part of the first pattern): its pattern, or `[attr]` and
 * a macro name, and its attributes. A quoted pattern's attributes start right after its closing quote.
 * null for a line git drops: a comment, 2048 bytes or more, or any attribute name that is not valid.
 */
function attrLine(line: string): [name: string, states: State[]] | null {
  if (line.length >= ATTR_LINE) return null;
  const rest = line.replace(/^[ \t\r]+/, '');
  if (!rest || rest[0] === '#') return null;
  const q = QUOTED.exec(rest);
  const name = q ? q[1].replace(/\\([0-3][0-7]{2}|.)/g, (_, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : (C_ESCAPES[e] ?? e))) : rest.split(/[ \t\r]/, 1)[0];
  const states: State[] = [];
  for (const a of rest.slice(q ? q[0].length : name.length).split(/[ \t\r]+/)) {
    if (!a) continue;
    const [, sign, attr, value] = /^([-!]?)([^=]*)(?:=(.*))?$/.exec(a)!;
    if (!ATTR_NAME.test(attr)) return null;
    states.push([attr, sign === '-' ? false : sign === '!' ? null : (value ?? true)]);
  }
  return [name, states];
}

/** The macro an `[attr]` line defines ('' if its name is not valid), or undefined for a pattern line ('[attr]' alone is a pattern). */
const macroName = (name: string) => (name.length > 6 && name.startsWith('[attr]') ? (/^[ \t\r\n]*([^ \t\r\n\0]*)/.exec(name.slice(6))![1].match(ATTR_NAME)?.[0] ?? '') : undefined);

/**
 * The lines of the .gitattributes in `dir` that can set `export-ignore`, as .gitignore globs over a path
 * relative to that folder: one with a '/' is anchored there, one without matches a name at any depth;
 * `*` and `?` stay inside one segment, `**` spans them. Text is bytes (asBytes); git stops at a NUL and
 * splits on '\n' alone. Macros (`[attr]name attrs`) are git's: defined in the top-level file alone
 * (into `macros`, the last definition winning, a line elsewhere dropped), and a line keeps only the
 * attributes that are `export-ignore` or a macro. Each rule spends one of `room` before it is made, so
 * a padded file is refused part way, not held whole.
 */
function exportIgnoreRules(dir: string, text: string, room: Budget, macros: Map<string, State[]>): IgnoreRule[] {
  const lines = text.split('\0')[0].split('\n');
  const kept = (states: State[]) => states.filter(([a]) => a === EXPORT_IGNORE || macros.has(a));
  // A macro may be defined below its first use, so the top-level file is read for them first.
  if (!dir) {
    for (const line of lines) {
      const l = attrLine(line);
      const m = l && macroName(l[0]);
      if (m) macros.set(m, l[1]);
    }
    for (const [m, states] of macros) macros.set(m, kept(states));
  }
  const rules: IgnoreRule[] = [];
  const depth = dir ? dir.split('/').length : 0;
  for (const line of lines) {
    const l = attrLine(line);
    if (!l || macroName(l[0]) !== undefined) continue;
    const states = kept(l[1]);
    // git reads a pattern up to a NUL in it (a quoted \000); a negative one it refuses.
    const pattern = l[0].split('\0')[0];
    if (!states.length || pattern[0] === '!') continue;
    const dirOnly = pattern.endsWith('/');
    const p = dirOnly ? pattern.slice(0, -1) : pattern;
    const segs = p && patternSegs(p.replace(/^\//, ''));
    if (!segs) continue;
    spend(room);
    rules.push({ dir: asBytes(dir), depth, segs: p.includes('/') ? segs : ['**', ...segs], dirOnly, states });
  }
  return rules;
}

/**
 * m5wy: whether `git archive` (so a zipball) leaves `path` out: it, or a folder above it, has
 * `export-ignore` set. Rules come shallowest file first, and git's fill (attr.c) reads them backwards:
 * the deepest file's last line first, a line's last attribute first. The first state an attribute
 * takes stays, and a macro that takes true then fills in its own attributes the same way, before the
 * line's earlier ones. Paths are repository-relative.
 */
function exportIgnored(rules: IgnoreRule[], macros: Map<string, State[]>, path: string, b: Budget): boolean {
  const segs = asBytes(path).split('/');
  for (let i = 1; i <= segs.length; i++) {
    const p = segs.slice(0, i).join('/');
    const known = new Map<string, State[1]>();
    for (let k = rules.length - 1; k >= 0 && !known.has(EXPORT_IGNORE); k--) {
      const r = rules[k];
      spend(b);
      if ((r.dir && !p.startsWith(r.dir + '/')) || (r.dirOnly && i === segs.length) || !pathMatch(r.segs, segs.slice(r.depth, i), b)) continue;
      // A stack, not git's recursion: a chain of macros as deep as the file allows cannot overflow it.
      const todo = [...r.states];
      for (let s = todo.pop(); s; s = todo.pop()) {
        spend(b);
        if (known.has(s[0])) continue;
        known.set(s[0], s[1]);
        if (s[1] === true) todo.push(...(macros.get(s[0]) ?? []));
      }
    }
    if (known.get(EXPORT_IGNORE) === true) return true;
  }
  return false;
}

/** What fetchFolder found, repository-relative like an unpacked zipball: files, links (mode 120000) and submodules (160000). */
export interface Folder {
  files: TreeFile[];
  links: ZipLink[];
  submodules: { path: string; sha: string }[];
}

/**
 * What one download already fetched (its folder, then each link target, jv9q), so the limits bind them
 * together (I3-3): files and bytes, the .gitattributes counted and their export-ignore rules, parsed once
 * per path (a target's walk passes the root's again), and the macros the root's defines.
 */
export interface Spent {
  files: number;
  bytes: number;
  attrFiles: number;
  attrBytes: number;
  rules: number;
  attrs: Map<string, IgnoreRule[]>;
  macros: Map<string, State[]>;
}
export const freshSpent = (): Spent => ({ files: 0, bytes: 0, attrFiles: 0, attrBytes: 0, rules: 0, attrs: new Map(), macros: new Map() });

/**
 * a4q8: the files at or under `path` in repo@sha through the Git Data API, for a folder whose
 * repository archive is over the cap. One listing per path segment walks the tree shas down (a
 * recursive listing of a whole repository truncates on exactly the repositories that land here),
 * then one recursive listing of the folder itself. The folder is held to the per-version limits from
 * the listing's sizes, and to what GitHub says is left of the quota, before any blob is fetched.
 * `charge` spends every call on the caller's own bucket as it is made, a refused folder's listings
 * included. Links and submodules are returned
 * apart, for the caller to copy (jv9q) or report. m5wy: what the `export-ignore` lines of the .gitattributes
 * files above and inside the folder leave out of a zipball is left out here too (one more call per
 * such file), so either path gives one commit the same tree. ponytail: `export-subst` is not applied.
 * A link at a folder above `path` ends the walk and is returned in `links`, for the caller to follow.
 * `spent`: what one download already fetched (Spent); the limits, the .gitattributes caps included, bind
 * them together, so link targets never fetch or parse more than one folder may (I3-3).
 */
export async function fetchFolder(ctx: Ctx, repo: string, sha: string, path: string, charge: (calls: number) => void, spent = freshSpent()): Promise<Folder> {
  const out: Folder = { files: [], links: [], submodules: [] };
  let remaining = Infinity;
  let at: GitEntry = { path: '', mode: '040000', type: 'tree', sha };
  let dir = '';
  const attrFiles: GitEntry[] = [];
  const isAttrs = (e: GitEntry) => e.type === 'blob' && (e.path === '.gitattributes' || e.path.endsWith('/.gitattributes'));
  for (const seg of path.split('/')) {
    if (at.type !== 'tree') {
      if (at.mode === '120000') {
        charge(1);
        out.links.push(zipLink(dir, await gitBlob(ctx, repo, at)));
      }
      return out;
    }
    charge(1);
    const l = await gitTree(ctx, repo, at.sha, false);
    remaining = l.remaining;
    const attrs = l.entries.find(isAttrs);
    if (attrs) attrFiles.push({ ...attrs, path: dir ? `${dir}/.gitattributes` : '.gitattributes' });
    const next = l.entries.find((e) => e.path === seg);
    if (!next) {
      if (l.truncated) throw tooLarge(`GitHub cannot list the folder holding '${path}' in full`);
      return out;
    }
    at = next;
    dir = dir ? `${dir}/${seg}` : seg;
  }
  let listed: GitEntry[] = [{ ...at, path }];
  if (at.type === 'tree') {
    charge(1);
    const l = await gitTree(ctx, repo, at.sha, true);
    remaining = l.remaining;
    if (l.truncated) throw tooLarge(`'${path}' holds more files than GitHub lists at once`);
    listed = l.entries.map((e) => ({ ...e, path: `${path}/${e.path}` }));
    attrFiles.push(...listed.filter(isAttrs).sort((a, b) => a.path.split('/').length - b.path.split('/').length));
  }
  const over = (what: string) => tooLarge(`the repository archive is over ${importLimit(ctx, 'maxArchiveMb')} MB, and '${path}' is too large to fetch file by file: ${what}`);
  const quota = (calls: number) =>
    // Transient, unlike the caps: a source/update refuses rather than drop a link copy this would leave out (routes.ts download).
    Object.assign(
      badRequest(
        githubToken(ctx)
          ? `'${path}' needs ${calls} GitHub requests and this server's token has ${remaining} left; try again after GitHub's hourly reset`
          : `'${path}' needs ${calls} GitHub requests, more than the ${remaining} anonymous ones left this hour; set a github.token to import it`,
      ),
      { quota: true },
    );
  // The .gitattributes requests come out of the one shared quota too, so they are capped and checked against
  // it before any is fetched. One under a junk path only scopes files that are dropped anyway. The caps are
  // the download's (spent): one already read for an earlier folder of it is not read or counted again.
  const attrs = attrFiles.filter((e) => !isJunkPath(e.path));
  const fresh = attrs.filter((e) => !spent.attrs.has(e.path));
  if (spent.attrFiles + fresh.length > MAX_ATTR_FILES) throw over(`more than ${MAX_ATTR_FILES} .gitattributes files`);
  const big = fresh.find((e) => e.size! > ATTR_BYTES);
  if (big) throw over(`'${big.path}' is over ${ATTR_BYTES / MB} MB`);
  // Each file is parsed, so each counts, though identical ones are one blob.
  const attrBytes = fresh.reduce((n, e) => n + e.size!, spent.attrBytes);
  if (attrBytes > ATTR_BYTES) throw over(`its .gitattributes files are over ${ATTR_BYTES / MB} MB together`);
  const attrCalls = new Set(fresh.map((e) => e.sha)).size;
  if (attrCalls > remaining) throw quota(attrCalls);
  remaining -= attrCalls;
  spent.attrFiles += fresh.length;
  spent.attrBytes = attrBytes;
  // Fetched once: an in-folder .gitattributes is one of the folder's files too.
  const got = new Map<string, Uint8Array>();
  const rules: IgnoreRule[] = [];
  const room: Budget = { left: MAX_ATTR_RULES - spent.rules, refuse: () => over(`more than ${MAX_ATTR_RULES} .gitattributes export-ignore lines`) };
  for (const e of attrs) {
    let parsed = spent.attrs.get(e.path);
    if (!parsed) {
      if (!got.has(e.sha)) {
        charge(1);
        got.set(e.sha, await gitBlob(ctx, repo, e));
      }
      // As bytes, as git reads it (asBytes): the root's first, so its macros are known to the rest.
      parsed = exportIgnoreRules(e.path.slice(0, -'.gitattributes'.length).replace(/\/$/, ''), Buffer.from(got.get(e.sha)!).toString('latin1'), room, spent.macros);
      spent.attrs.set(e.path, parsed);
      spent.rules = MAX_ATTR_RULES - room.left;
    }
    for (const r of parsed) rules.push(r);
  }
  const budget: Budget = { left: MATCH_STEPS, refuse: () => over('its .gitattributes export-ignore lines take too long to apply') };
  if (rules.length) listed = listed.filter((e) => !exportIgnored(rules, spent.macros, e.path, budget));
  const blobs: GitEntry[] = [];
  let total = 0;
  const maxFiles = LIMITS.files - spent.files;
  const maxBytes = LIMITS.totalBytes - spent.bytes;
  for (const e of listed) {
    if (isJunkPath(e.path)) continue;
    if (e.type === 'commit') out.submodules.push({ path: e.path, sha: e.sha });
    if (e.type !== 'blob') continue;
    normalizePath(e.path);
    if (blobs.push(e) > maxFiles) throw over(`at most ${maxFiles} files`);
    if (e.size! > LIMITS.fileBytes) throw over(`'${e.path}' is over ${LIMITS.fileBytes / MB} MB`);
    if ((total += e.size!) > maxBytes) throw over(`at most ${maxBytes / MB} MB`);
  }
  const calls = blobs.filter((e) => !got.has(e.sha)).length;
  if (calls > remaining) throw quota(calls);
  charge(calls);
  spent.files += blobs.length;
  spent.bytes += total;
  const bytes: Uint8Array[] = new Array(blobs.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < blobs.length) {
      const i = next++;
      try {
        bytes[i] = got.get(blobs[i].sha) ?? (await gitBlob(ctx, repo, blobs[i]));
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, blobs.length) }, worker));
  blobs.forEach((e, i) => {
    if (e.mode === '120000') out.links.push(zipLink(e.path, bytes[i]));
    else out.files.push({ path: e.path, bytes: bytes[i], mode: modeOf(parseInt(e.mode, 8)) });
  });
  return out;
}
