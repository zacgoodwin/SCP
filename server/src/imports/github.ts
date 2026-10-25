import { createHash } from 'node:crypto';
import { importLimit } from '../admin/settings.ts';
import { HttpError, MB, badRequest } from '../lib/http.ts';
import { isJunkPath, normalizePath } from '../lib/paths.ts';
import { LIMITS, modeOf, tooLarge, type TreeFile } from '../lib/tree.ts';
import type { ZipLink } from '../lib/zip.ts';
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

/** What fetchFolder found, repository-relative like an unpacked zipball: files, links (mode 120000) and submodules (160000). */
export interface Folder {
  files: TreeFile[];
  links: ZipLink[];
  submodules: { path: string; sha: string }[];
}

/**
 * a4q8: the files at or under `path` in repo@sha through the Git Data API, for a folder whose
 * repository archive is over the cap. One listing per path segment walks the tree shas down (a
 * recursive listing of a whole repository truncates on exactly the repositories that land here),
 * then one recursive listing of the folder itself. The folder is held to the per-version limits from
 * the listing's sizes, and to what GitHub says is left of the quota, before any blob is fetched.
 * `charge` spends every call on the caller's own bucket as it is made, a refused folder's listings
 * included. Links and submodules are returned
 * apart, to be reported: never imported, resolved or followed.
 */
export async function fetchFolder(ctx: Ctx, repo: string, sha: string, path: string, charge: (calls: number) => void): Promise<Folder> {
  const out: Folder = { files: [], links: [], submodules: [] };
  let remaining = Infinity;
  let at: GitEntry = { path: '', mode: '040000', type: 'tree', sha };
  for (const seg of path.split('/')) {
    if (at.type !== 'tree') return out;
    charge(1);
    const l = await gitTree(ctx, repo, at.sha, false);
    remaining = l.remaining;
    const next = l.entries.find((e) => e.path === seg);
    if (!next) {
      if (l.truncated) throw tooLarge(`GitHub cannot list the folder holding '${path}' in full`);
      return out;
    }
    at = next;
  }
  let listed: GitEntry[] = [{ ...at, path }];
  if (at.type === 'tree') {
    charge(1);
    const l = await gitTree(ctx, repo, at.sha, true);
    remaining = l.remaining;
    if (l.truncated) throw tooLarge(`'${path}' holds more files than GitHub lists at once`);
    listed = l.entries.map((e) => ({ ...e, path: `${path}/${e.path}` }));
  }
  const over = (what: string) => tooLarge(`the repository archive is over ${importLimit(ctx, 'maxArchiveMb')} MB, and '${path}' is too large to fetch file by file: ${what}`);
  const blobs: GitEntry[] = [];
  let total = 0;
  for (const e of listed) {
    if (isJunkPath(e.path)) continue;
    if (e.type === 'commit') out.submodules.push({ path: e.path, sha: e.sha });
    if (e.type !== 'blob') continue;
    normalizePath(e.path);
    if (blobs.push(e) > LIMITS.files) throw over(`at most ${LIMITS.files} files`);
    if (e.size! > LIMITS.fileBytes) throw over(`'${e.path}' is over ${LIMITS.fileBytes / MB} MB`);
    if ((total += e.size!) > LIMITS.totalBytes) throw over(`at most ${LIMITS.totalBytes / MB} MB`);
  }
  if (blobs.length > remaining) {
    throw badRequest(
      githubToken(ctx)
        ? `'${path}' needs ${blobs.length} GitHub requests and this server's token has ${remaining} left; try again after GitHub's hourly reset`
        : `'${path}' needs ${blobs.length} GitHub requests, more than the ${remaining} anonymous ones left this hour; set a github.token to import it`,
    );
  }
  charge(blobs.length);
  const bytes: Uint8Array[] = new Array(blobs.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < blobs.length) {
      const i = next++;
      try {
        bytes[i] = await gitBlob(ctx, repo, blobs[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, blobs.length) }, worker));
  blobs.forEach((e, i) => {
    if (e.mode === '120000') out.links.push({ path: e.path, target: new TextDecoder().decode(bytes[i]).slice(0, 255) });
    else out.files.push({ path: e.path, bytes: bytes[i], mode: modeOf(parseInt(e.mode, 8)) });
  });
  return out;
}
