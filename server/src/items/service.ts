import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { canEditItem, canReadItem, itemReadSql, servedByGroupSql, servingGroupsSql } from '../access.ts';
import { requireScope } from '../auth/middleware.ts';
import { isUniqueViolation, newId, now, tx, type Db } from '../db.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { parseFrontmatter, UNCLOSED, type Frontmatter } from '../lib/frontmatter.ts';
import { HttpError, badRequest, forbidden, notFound } from '../lib/http.ts';
import { assertNoCollisions, isJunkPath, isTextPath, mediaTypeFor, normalizePath, segmentProblem } from '../lib/paths.ts';
import { LIMITS, checkLimits, stripTopFolder, tooLarge, treeSha256, type TreeFile } from '../lib/tree.ts';
import { sweepBlobs } from './gc.ts';
import { FRONTMATTER_ERRORS, FRONTMATTER_KEYS, lintVersion, parseRequires, type Lint } from './lint.ts';
import { touchGroupsOfItem } from '../groups/touch.ts';
import { FORMATS, KINDS, aKind, planeOf, type Ctx, type Format, type ItemRow, type ItemSource, type Kind, type Plane, type Principal, type SuppliedFrontmatter, type VersionRow } from '../types.ts';

export { isTextPath, mediaTypeFor };
export type { Lint, TreeFile };

export interface FileIn {
  path: string;
  content?: string;
  contentBase64?: string;
  mode?: number;
}

export interface CreateItemInput {
  kind: Kind;
  name?: string;
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  visibility?: 'private' | 'public';
  format?: Format;
  files?: FileIn[];
  /** Shorthand: one UTF-8 file at the entry path. */
  content?: string;
  /** Already-decoded files (import, fork). */
  tree?: TreeFile[];
  note?: string;
  /** Name source of last resort, e.g. the uploaded file or folder name; slugified. */
  fallbackName?: string;
  /** The wrapper folder an imported tree came in: a skill without a frontmatter name takes it. */
  folderName?: string;
  forkedFrom?: string;
  /** Import provenance (D1), written to the item row's source_* columns. */
  source?: ItemSource;
  /** With source: whether the unit was the whole tree or a root SKILL.md carved from its siblings (ItemRow.source_scope). */
  sourceScope?: 'tree' | 'root';
  /** With source: the paths other units took out of this one (ItemRow.source_carve). */
  sourceCarve?: string[];
  /** With source: the prefix the import put in front of the unit's bare name (ItemRow.source_prefix). */
  sourcePrefix?: string;
  /** With source: the frontmatter the import put in front of the entry (jcfm), stored to re-apply on source writes. */
  suppliedFrontmatter?: SuppliedFrontmatter;
}

export interface VersionInput {
  files?: FileIn[];
  content?: string;
  tree?: TreeFile[];
  note?: string;
}

/** Omitted fields are kept; null or '' clears title, description and category. */
export interface MetaPatch {
  title?: string | null;
  description?: string | null;
  category?: string | null;
  tags?: string[];
  visibility?: 'private' | 'public';
}

export interface FileInfo {
  path: string;
  mode: number;
  size: number;
  sha256: string;
}

export interface ItemSummary {
  id: string;
  kind: Kind;
  plane: Plane;
  name: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  visibility: 'private' | 'public';
  format: Format | null;
  latestSeq: number;
  owner: { id: string; username: string };
  updatedAt: string;
}

export interface VersionSummary {
  seq: number;
  entryPath: string;
  treeSha256: string;
  totalBytes: number;
  note: string;
  createdAt: string;
  /** clientId: the connected OAuth app that wrote it (MCP), so two apps and the owner's own edits stay tellable apart. */
  createdBy: { userId: string | null; keyId: string | null; clientId: string | null };
}

export interface VersionDetail extends VersionSummary {
  frontmatter: Record<string, unknown>;
  lint: Lint[];
  files: FileInfo[];
}

export interface ItemDetail extends ItemSummary {
  createdAt: string;
  source: ItemSource | null;
  /** jcfm: frontmatter SCP supplied on import; upstreamFrontmatter: upstream now ships its own, so these wait as a fallback. */
  suppliedFrontmatter: SuppliedFrontmatter | null;
  upstreamFrontmatter: boolean;
  forkedFrom: string | null;
  version: VersionDetail;
  groups: { slug: string; name: string }[];
  canEdit: boolean;
}

export const SINGLE_FILE = new Set<Kind>(['agent', 'command', 'prompt', 'instructions', 'artifact']);
const ARTIFACT_ENTRY: Record<Format, string> = {
  html: 'index.html',
  markdown: 'index.md',
  svg: 'image.svg',
  mermaid: 'diagram.mmd',
  react: 'App.jsx',
  code: 'source.txt',
};
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const OTHER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** Entry file path. For packages this is the default; a tree without README.md uses its first .md. */
export function entryPathFor(kind: Kind, name: string, format?: Format | null): string {
  switch (kind) {
    case 'skill':
      return 'SKILL.md';
    case 'instructions':
      return 'AGENTS.md';
    case 'design':
      return 'DESIGN.md';
    case 'package':
      return 'README.md';
    case 'artifact':
      return ARTIFACT_ENTRY[format ?? 'code'];
    default:
      return `${name}.md`;
  }
}

export const slugify = (s: string, max = 64) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');

// ---------- reads ----------

export const getItemRow = (db: Db, id: string) => db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;

export function loadReadableItem(db: Db, p: Principal, id: string): ItemRow {
  const row = getItemRow(db, id);
  if (!row || !canReadItem(db, p, id)) throw notFound('item');
  return row;
}

export function loadEditableItem(db: Db, p: Principal, id: string): ItemRow {
  const row = loadReadableItem(db, p, id);
  if (!canEditItem(db, p, row)) throw forbidden('you cannot edit this item');
  return row;
}

// Prepared once per database (tests open many): every member of every listed group resolves through this.
const versionStmts = new WeakMap<Db, StatementSync>();

export function resolveVersion(db: Db, item: ItemRow, seq?: number): VersionRow {
  let stmt = versionStmts.get(db);
  if (!stmt) versionStmts.set(db, (stmt = db.prepare('SELECT * FROM item_versions WHERE item_id = ? AND seq = ?')));
  const v = stmt.get(item.id, seq ?? item.latest_seq) as VersionRow | undefined;
  if (!v) throw notFound('version');
  return v;
}

export const listFiles = (db: Db, versionId: string) =>
  db.prepare('SELECT path, mode, size, sha256 FROM version_files WHERE version_id = ? ORDER BY path').all(versionId) as unknown as FileInfo[];

export function readFile(db: Db, versionId: string, path: string): { bytes: Uint8Array; mode: number; sha256: string } | null {
  const r = db
    .prepare('SELECT b.data, f.mode, f.sha256 FROM version_files f JOIN blobs b ON b.sha256 = f.sha256 WHERE f.version_id = ? AND f.path = ?')
    .get(versionId, path) as { data: Uint8Array; mode: number; sha256: string } | undefined;
  return r ? { bytes: r.data, mode: r.mode, sha256: r.sha256 } : null;
}

export function readTree(db: Db, versionId: string): TreeFile[] {
  const rows = db
    .prepare('SELECT f.path, f.mode, b.data FROM version_files f JOIN blobs b ON b.sha256 = f.sha256 WHERE f.version_id = ? ORDER BY f.path')
    .all(versionId) as { path: string; mode: number; data: Uint8Array }[];
  return rows.map((r) => ({ path: r.path, mode: r.mode, bytes: r.data }));
}

export function itemSummary(db: Db, row: ItemRow): ItemSummary {
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(row.owner_id) as { username: string } | undefined;
  return {
    id: row.id,
    kind: row.kind,
    plane: planeOf(row.kind),
    name: row.name,
    title: row.title,
    description: row.description,
    category: row.category,
    tags: JSON.parse(row.tags) as string[],
    visibility: row.visibility,
    format: row.format,
    latestSeq: row.latest_seq,
    owner: { id: row.owner_id, username: owner?.username ?? '' },
    updatedAt: row.updated_at,
  };
}

export const versionSummary = (v: VersionRow): VersionSummary => ({
  seq: v.seq,
  entryPath: v.entry_path,
  treeSha256: v.tree_sha256,
  totalBytes: v.total_bytes,
  note: v.note,
  createdAt: v.created_at,
  createdBy: { userId: v.created_by_user, keyId: v.created_by_key, clientId: v.created_by_client },
});

export const versionDetail = (db: Db, v: VersionRow): VersionDetail => ({
  ...versionSummary(v),
  frontmatter: JSON.parse(v.frontmatter) as Record<string, unknown>,
  lint: JSON.parse(v.lint) as Lint[],
  files: listFiles(db, v.id),
});

export function itemDetail(db: Db, p: Principal, row: ItemRow, seq?: number): ItemDetail {
  // Readable groups that serve the item, included groups too (a reader may know it only through those).
  const g = servingGroupsSql(p);
  const groups = db.prepare(g.sql).all(row.id, ...g.params) as { slug: string; name: string }[];
  return {
    ...itemSummary(db, row),
    createdAt: row.created_at,
    source: itemSource(row),
    suppliedFrontmatter: suppliedOf(row),
    upstreamFrontmatter: !!row.upstream_frontmatter,
    forkedFrom: row.forked_from,
    version: versionDetail(db, resolveVersion(db, row, seq)),
    groups: groups.map((r) => ({ slug: r.slug, name: r.name })),
    canEdit: canEditItem(db, p, row),
  };
}

/** Provenance of an imported item, null for items created in SCP. */
export const itemSource = (row: ItemRow): ItemSource | null =>
  row.source_kind ? { kind: row.source_kind, repo: row.source_repo, ref: row.source_ref, path: row.source_path, commit: row.source_commit } : null;

/** jcfm: the frontmatter fields an import supplied, null when it supplied none. */
export const suppliedOf = (row: ItemRow): SuppliedFrontmatter | null => (row.supplied_frontmatter ? (JSON.parse(row.supplied_frontmatter) as SuppliedFrontmatter) : null);

/** At most this many distinct words of a query are searched. */
export const MAX_FTS_TERMS = 8;

/**
 * Each word becomes a quoted term, a prefix term from 3 characters on; terms are ANDed, or ORed with
 * anyTerm. Words are deduplicated and capped at MAX_FTS_TERMS: the index has no prefix table, so
 * every prefix term walks every token it covers ('a' x 250 was minutes per query). Control characters
 * separate words (a NUL inside a quoted FTS5 term is a syntax error). null when nothing searchable remains.
 */
export function ftsQuery(q?: string, anyTerm = false): string | null {
  const words = [
    ...new Set(
      (q ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => /[\p{L}\p{N}]/u.test(w)),
    ),
  ].slice(0, MAX_FTS_TERMS);
  const term = (w: string) => `"${w.replaceAll('"', '""')}"${[...w].length >= 3 ? '*' : ''}`;
  return words.length ? words.map(term).join(anyTerm ? ' OR ' : ' ') : null;
}

export function searchItems(
  db: Db,
  p: Principal,
  opts: { q?: string; anyTerm?: boolean; plane?: Plane; kind?: Kind; groupId?: string; ownerId?: string; limit?: number; offset?: number },
): { items: ItemSummary[]; total: number } {
  const read = itemReadSql(p);
  const where = [read.sql];
  const params: SQLInputValue[] = [...read.params];
  if (opts.kind) {
    where.push('i.kind = ?');
    params.push(opts.kind);
  }
  if (opts.plane) {
    const kinds = KINDS.filter((k) => planeOf(k) === opts.plane);
    where.push(`i.kind IN (${kinds.map(() => '?').join(', ')})`);
    params.push(...kinds);
  }
  if (opts.ownerId) {
    where.push('i.owner_id = ?');
    params.push(opts.ownerId);
  }
  if (opts.groupId) {
    // What the group serves, included groups too: the same effective set as get_group / resolvedMembers.
    const served = servedByGroupSql(opts.groupId);
    where.push(served.sql);
    params.push(...served.params);
  }
  const match = ftsQuery(opts.q, opts.anyTerm);
  if (match) {
    where.unshift('items_fts MATCH ?');
    params.unshift(match);
  }
  const from = match ? 'items_fts JOIN items i ON i.id = items_fts.item_id' : 'items i';
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${w}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT i.* FROM ${from} WHERE ${w} ORDER BY ${match ? 'bm25(items_fts),' : ''} i.updated_at DESC, i.id DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit ?? 50, opts.offset ?? 0) as unknown as ItemRow[];
  return { items: rows.map((r) => itemSummary(db, r)), total };
}

// ---------- writes ----------

interface Shaped {
  files: TreeFile[];
  entryPath: string;
  entryText: string;
  fm: Frontmatter | null;
  dropped: string[];
}

function decodeFileIn(f: FileIn): TreeFile {
  if ((f.content === undefined) === (f.contentBase64 === undefined)) {
    throw badRequest(`file '${f.path}': give exactly one of content or contentBase64`);
  }
  if (f.mode !== undefined && f.mode !== 420 && f.mode !== 493) throw badRequest(`file '${f.path}': mode must be 420 or 493`);
  let bytes: Uint8Array;
  if (f.content !== undefined) bytes = new TextEncoder().encode(f.content);
  else {
    // Strip whitespace first: a pattern with \s both inside the repeat and after it backtracks O(n^2).
    const b64 = f.contentBase64!.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw badRequest(`file '${f.path}': invalid base64`);
    bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  }
  return { path: f.path, bytes, mode: f.mode ?? 420 };
}

function inputTree(kind: Kind, format: Format | null, input: VersionInput): TreeFile[] {
  if ([input.files, input.content, input.tree].filter((x) => x !== undefined).length !== 1) {
    throw badRequest('give exactly one of files or content');
  }
  if (input.tree) return input.tree;
  if (input.content !== undefined) return [{ path: entryPathFor(kind, 'entry', format), bytes: new TextEncoder().encode(input.content), mode: 420 }];
  return input.files!.map(decodeFileIn);
}

/**
 * Validate paths and limits, drop junk, find the entry and parse its frontmatter.
 * unwrap 'always': a fresh upload's single shared top folder is packaging (PLAN.md), so strip it.
 * unwrap 'entry': a stored tree sent back (fork, new version) is stripped only when that is what
 * brings the entry to the root, so a real top-level folder like 'docs/' survives every round trip.
 * Never for a package: its entry need not be at the root (docs/README.md), so a stored tree whose
 * files all sit under docs/ is already its real shape.
 */
function shapeTree(kind: Kind, format: Format | null, raw: TreeFile[], unwrap: 'always' | 'entry'): Shaped {
  const dropped: string[] = [];
  let files: TreeFile[] = [];
  for (const f of raw) {
    normalizePath(f.path);
    if (isJunkPath(f.path)) dropped.push(f.path);
    else files.push(f);
  }
  if (!files.length) throw badRequest('no files');
  checkLimits(files);
  let entryPath: string;
  if (SINGLE_FILE.has(kind)) {
    if (files.length !== 1) throw badRequest(`${aKind(kind)} holds exactly one file`);
    entryPath = files[0].path; // re-homed to the entry path once the name is known
    if (kind === 'artifact' && files[0].bytes.length > LIMITS.artifactEntryBytes) throw tooLarge('artifact content is over 5 MB');
  } else {
    entryPath = entryPathFor(kind, '', format);
    const stripped = stripTopFolder(files).files;
    const unwrapsEntry = kind !== 'package' && !files.some((f) => f.path === entryPath) && stripped.some((f) => f.path === entryPath);
    if (unwrap === 'always' || unwrapsEntry) files = stripped;
    if (kind === 'package' && !files.some((f) => f.path === entryPath)) {
      entryPath = files.map((f) => f.path).filter((p) => p.toLowerCase().endsWith('.md')).sort()[0] ?? entryPath;
    }
    if (!files.some((f) => f.path === entryPath)) throw badRequest(`${aKind(kind)} needs ${entryPath} at the root`);
  }
  assertNoCollisions(files.map((f) => f.path));
  const entry = files.find((f) => f.path === entryPath)!;
  const entryText = utf8.decode(entry.bytes);
  const isMd = kind === 'artifact' ? format === 'markdown' : SINGLE_FILE.has(kind) || entryPath.toLowerCase().endsWith('.md');
  return { files, entryPath, entryText, fm: isMd ? parseFrontmatter(entryText) : null, dropped };
}

/** Single-file kinds store their one file at the entry path, whatever it was uploaded as. */
function placeEntry(s: Shaped, kind: Kind, name: string, format: Format | null): Shaped {
  if (!SINGLE_FILE.has(kind)) return s;
  const entryPath = entryPathFor(kind, name, format);
  return { ...s, entryPath, files: [{ ...s.files[0], path: entryPath }] };
}

/** The tree_sha256 addVersion would give `tree` as a version of item: shaped and placed the same way, not stored. */
export function versionSha(item: ItemRow, tree: TreeFile[]): string {
  const s = placeEntry(shapeTree(item.kind, item.format, tree, 'entry'), item.kind, item.name, item.format);
  return treeSha256(s.files.map((f) => ({ path: f.path, mode: f.mode, sha256: sha256Hex(f.bytes) })));
}

/** waive: frontmatter errors (FRONTMATTER_ERRORS) are kept as waived warnings, for an import that accepted them (0rdh). */
function lintShaped(kind: Kind, name: string, s: Shaped, waive = false): Lint[] {
  const lint = lintVersion(kind, name, s.files, s.fm, { path: s.entryPath, text: s.entryText });
  for (const path of s.dropped) lint.push({ level: 'info', code: 'path.junk', message: 'dropped build/OS junk file', path });
  return waive ? lint.map((l) => (l.level === 'error' && FRONTMATTER_ERRORS.has(l.code) ? { ...l, level: 'warn', waived: true } : l)) : lint;
}

function gateLint(lint: Lint[]): Lint[] {
  if (lint.some((l) => l.level === 'error')) throw new HttpError(422, 'lint_failed', 'content failed validation', lint);
  return lint;
}

const fmString = (fm: Frontmatter | null, key: string) => {
  const v = fm?.data[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

/** `--- ` or `... `: the closer the author meant, which lib/frontmatter.ts does not take as a fence (trailing blanks). */
const nearCloser = (line: string) => {
  const t = line.trimEnd();
  return (t === '---' || t === '...') && t.length < line.length;
};

/** t1ge: an unclosed fence's YAML is looked for in at most this many paragraph ends and bytes (a parse each). */
// ponytail: YAML past 16 blank-separated paragraphs or 8 KB is read as body; parse incrementally if real entries ever need more.
const UNCLOSED_CUTS = 16;
const UNCLOSED_BYTES = 8 * 1024;

/** The keys `text` parses to as frontmatter (lib/frontmatter.ts: no aliases, no custom tags), or null when it does not parse to a mapping. */
function yamlKeys(text: string): string[] | null {
  const fm = parseFrontmatter(`---\n${text}\n---\n`);
  return fm.error ? null : Object.keys(fm.data);
}

/**
 * The entry's body. t1ge: an unclosed fence's body is the whole text, so its YAML is skipped. The run of
 * non-blank lines after the opener is YAML whatever it holds. Past it, the YAML runs to the furthest
 * paragraph end whose text, from the opener, still parses as YAML that adds only known frontmatter keys
 * (FRONTMATTER_KEYS): so blank lines between keys, inside a block scalar or a list, and comments are
 * YAML, while `Note: text` past a blank line is the body (an unknown key there is the likelier body line).
 * A near closer ends the YAML wherever it comes, and the body starts right after it.
 * preV4: the whole text, as before v4, for the name an earlier import gave such an entry (importUnit).
 */
function bodyOf(s: Shaped, preV4 = false): string {
  const body = s.fm?.body ?? s.entryText;
  if (preV4 || s.fm?.error !== UNCLOSED) return body;
  const raw = body.split('\n');
  const lines = raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const blank = (i: number) => !lines[i].trim();
  let i = 1; // past the opening ---
  while (i < lines.length && !blank(i)) if (nearCloser(lines[i++])) return raw.slice(i).join('\n');
  const closer = lines.findIndex((l, j) => j > i && nearCloser(l));
  const stop = closer === -1 ? lines.length : closer;
  const own = new Set(yamlKeys(lines.slice(1, i).join('\n')) ?? []);
  let cut = i;
  let content = false; // the paragraph holds a line that is not a `#` comment: a heading alone never extends the YAML
  for (let k = i + 1, cuts = 0, bytes = 0; k <= stop && cuts < UNCLOSED_CUTS; k++) {
    if (k < stop) bytes += lines[k - 1].length + 1;
    if (bytes > UNCLOSED_BYTES) break;
    if (!blank(k - 1) && lines[k - 1][0] !== '#') content = true;
    if ((k < stop && !blank(k)) || blank(k - 1)) continue; // a cut is a paragraph's end
    if (!content) continue;
    content = false;
    cuts++;
    const keys = yamlKeys(lines.slice(1, k).join('\n'));
    if (keys && keys.every((key) => own.has(key) || FRONTMATTER_KEYS.has(key))) cut = k;
  }
  return raw.slice(cut === stop && closer !== -1 ? stop + 1 : cut).join('\n');
}

function firstHeading(s: Shaped, preV4 = false): string | undefined {
  if (!s.fm) return undefined;
  // Linear on purpose: a lazy group before a trailing [ \t#]* (or a /[ \t#]+$/ trim) backtracks
  // quadratically over a long run of spaces and blocks the event loop. `.` stops at \r and \n.
  const line = /^#[ \t]+(.*)/m.exec(bodyOf(s, preV4))?.[1] ?? '';
  let end = line.length;
  while (end > 0 && ' \t#'.includes(line[end - 1])) end--;
  return line.slice(0, end) || undefined;
}

/** The body's first paragraph that is not a heading: Claude Code's description when frontmatter has none (0rdh). */
function firstParagraph(s: Shaped): string {
  for (const para of bodyOf(s).replace(/^#.*$/gm, '').split(/\n[ \t\r]*\n/)) {
    const text = para.replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 1024);
  }
  return '';
}

function checkFormat(kind: Kind, format: Format | null | undefined): Format | null {
  if (kind === 'artifact' && !format) throw badRequest('format is required for artifacts');
  if (kind !== 'artifact' && format) throw badRequest('format is only valid for artifacts');
  if (format && !FORMATS.includes(format)) throw badRequest(`format must be one of ${FORMATS.join(', ')}`);
  return format ?? null;
}

function checkName(kind: Kind, name: string): void {
  const ok = kind === 'skill' ? SKILL_NAME.test(name) && name.length <= 64 : OTHER_NAME.test(name);
  if (!ok) {
    const rule = kind === 'skill' ? '^[a-z0-9]+(-[a-z0-9]+)*$ (max 64)' : '^[a-z0-9][a-z0-9._-]{0,63}$';
    throw new HttpError(400, 'invalid_name', `name '${name}' must match ${rule}`);
  }
  // The name is an install-path segment (.claude/agents/<name>.md, .scp/packages/<name>/).
  const why = segmentProblem(name);
  if (why) throw new HttpError(400, 'invalid_name', `name '${name}' cannot be installed as a file name: ${why}`);
}

function normalizeTags(tags: string[] = []): string[] {
  const out = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  if (out.length > 20) throw badRequest('at most 20 tags');
  if (out.some((t) => t.length > 40)) throw badRequest('tags are at most 40 chars');
  return out;
}

function checkVisibility(v: unknown): void {
  if (v !== undefined && v !== 'private' && v !== 'public') throw badRequest("visibility must be 'private' or 'public'");
}

// Column names come from these fixed lists, never from the row object, so SQL text cannot be
// steered by whatever keys a row happens to carry.
const INSERT_COLUMNS = {
  items: ['id', 'owner_id', 'kind', 'name', 'title', 'description', 'category', 'tags', 'visibility', 'format',
    'latest_seq', 'source_repo', 'source_ref', 'source_path', 'source_kind', 'source_commit', 'source_tree_sha256', 'source_scope', 'source_carve', 'lint_waived', 'source_prefix', 'supplied_frontmatter', 'upstream_frontmatter', 'forked_from', 'created_at', 'updated_at'],
  item_versions: ['id', 'item_id', 'seq', 'entry_path', 'tree_sha256', 'frontmatter', 'lint', 'total_bytes', 'note',
    'created_by_user', 'created_by_key', 'created_by_client', 'created_at'],
} as const;

export function insertRow(db: Db, table: keyof typeof INSERT_COLUMNS, row: object): void {
  const cols: readonly string[] = INSERT_COLUMNS[table];
  const keys = Object.keys(row);
  if (keys.length !== cols.length || keys.some((k) => !cols.includes(k))) {
    throw new Error(`insertRow(${table}): row keys do not match the table columns`);
  }
  const values = cols.map((k) => (row as Record<string, SQLInputValue>)[k]);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...values);
}

function insertVersion(db: Db, p: Principal, itemId: string, seq: number, s: Shaped, lint: Lint[], note = ''): VersionRow {
  const entries = s.files.map((f) => ({ path: f.path, mode: f.mode, sha256: sha256Hex(f.bytes), size: f.bytes.length, bytes: f.bytes }));
  const v: VersionRow = {
    id: newId(),
    item_id: itemId,
    seq,
    entry_path: s.entryPath,
    tree_sha256: treeSha256(entries),
    frontmatter: JSON.stringify(s.fm?.data ?? {}),
    lint: JSON.stringify(lint),
    total_bytes: entries.reduce((n, e) => n + e.size, 0),
    note,
    created_by_user: p.userId,
    created_by_key: p.keyId ?? null,
    created_by_client: p.oauthClientId ?? null,
    created_at: now(),
  };
  insertRow(db, 'item_versions', v);
  const req = db.prepare('INSERT INTO version_requires (version_id, name) VALUES (?, ?)');
  for (const name of s.fm && !s.fm.error ? parseRequires(s.fm.data).names : []) req.run(v.id, name);
  const blob = db.prepare('INSERT OR IGNORE INTO blobs (sha256, size, data) VALUES (?, ?, ?)');
  const file = db.prepare('INSERT INTO version_files (version_id, path, mode, sha256, size) VALUES (?, ?, ?, ?, ?)');
  for (const e of entries) {
    blob.run(e.sha256, e.size, e.bytes);
    file.run(v.id, e.path, e.mode, e.sha256, e.size);
  }
  db.prepare('UPDATE items SET latest_seq = ?, updated_at = ? WHERE id = ?').run(seq, v.created_at, itemId);
  return v;
}

// ponytail: FTS rows are found by an UNINDEXED column (full scan per write); key by a stable rowid if items grow past ~100k.
export function refreshFts(db: Db, itemId: string): void {
  db.prepare('DELETE FROM items_fts WHERE item_id = ?').run(itemId);
  const item = getItemRow(db, itemId)!;
  const v = resolveVersion(db, item);
  const entry = isTextPath(v.entry_path) ? readFile(db, v.id, v.entry_path) : null;
  const body = entry ? utf8.decode(entry.bytes).slice(0, 50_000) : '';
  db.prepare('INSERT INTO items_fts (item_id, name, title, description, tags, body) VALUES (?, ?, ?, ?, ?, ?)').run(
    item.id,
    item.name,
    item.title,
    item.description,
    (JSON.parse(item.tags) as string[]).join(' '),
    body,
  );
}

/** An input shaped, named and linted (not gated): everything createItemTx decides before it writes. */
function prepareItem(input: CreateItemInput, waive: boolean, preV4 = false) {
  if (!KINDS.includes(input.kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
  checkVisibility(input.visibility);
  const kind = input.kind;
  const format = checkFormat(kind, input.format);
  // An internal tree (fork, import) is already stored or unwrapped; only fresh API files get unwrapped.
  const shaped = shapeTree(kind, format, inputTree(kind, format, input), input.tree ? 'entry' : 'always');
  const title = input.title ?? fmString(shaped.fm, 'title') ?? fmString(shaped.fm, 'name') ?? firstHeading(shaped, preV4) ?? '';
  // A skill installs as .claude/skills/<name>/, so its imported folder outranks its heading.
  const folder = kind === 'skill' && input.folderName ? slugify(input.folderName) : '';
  const fmName = fmString(shaped.fm, 'name');
  // With frontmatter errors accepted (0rdh), a skill or agent without a name takes its folder or file name, as Claude Code does.
  const heading = waive && (kind === 'skill' || kind === 'agent') ? '' : slugify(title);
  const name = input.name ?? ((fmName ? slugify(fmName) : folder || heading) || (input.fallbackName ? slugify(input.fallbackName) : ''));
  if (!name) throw badRequest('name is required (could not derive one from frontmatter or title)');
  checkName(kind, name);
  const s = placeEntry(shaped, kind, name, format);
  return { kind, format, s, title, name, lint: lintShaped(kind, name, s, waive) };
}

/**
 * The name and lint createItemTx would give input, without writing (an import names and classifies
 * its units before it writes any, 5ef6 and 0rdh); null when it would refuse the input before linting.
 * preV4: the name an import before v4 gave it, its heading found anywhere in an unclosed fence's text (t1ge).
 */
export function previewItem(input: CreateItemInput, waive = false, preV4 = false): { name: string; lint: Lint[] } | null {
  try {
    const { name, lint } = prepareItem(input, waive, preV4);
    return { name, lint };
  } catch (e) {
    if (e instanceof HttpError) return null;
    throw e;
  }
}

/**
 * Create an item with its first version. Joins an outer transaction when called inside one (the MCP
 * chunk creates an artifact and adds it to a group atomically, so it passes skipRestrictedCheck).
 */
export function createItemTx(
  ctx: Ctx,
  p: Principal,
  input: CreateItemInput,
  opts: { skipRestrictedCheck?: boolean; skipLintGate?: boolean; waiveFrontmatter?: boolean } = {},
): ItemRow {
  const { db } = ctx;
  requireScope(p, 'write');
  if (p.groupIds && !opts.skipRestrictedCheck) {
    throw new HttpError(403, 'restricted_key', 'a group-restricted API key cannot create items it could not see');
  }
  const { kind, format, s, title, name, lint } = prepareItem(input, !!opts.waiveFrontmatter);
  if (!opts.skipLintGate) gateLint(lint);
  const waived = lint.some((l) => l.waived);
  const ts = now();
  const row: ItemRow = {
    id: newId(),
    owner_id: p.userId,
    kind,
    name,
    title,
    description: input.description ?? fmString(s.fm, 'description') ?? (waived ? firstParagraph(s) : ''),
    category: input.category ?? '',
    tags: JSON.stringify(normalizeTags(input.tags)),
    visibility: input.visibility ?? 'private',
    format,
    latest_seq: 0,
    source_repo: input.source?.repo ?? null,
    source_ref: input.source?.ref ?? null,
    source_path: input.source?.path ?? null,
    source_kind: input.source?.kind ?? null,
    source_commit: input.source?.commit ?? null,
    source_tree_sha256: null,
    source_scope: input.source ? (input.sourceScope ?? null) : null,
    source_carve: input.source && input.sourceCarve?.length ? JSON.stringify(input.sourceCarve) : null,
    lint_waived: waived ? 1 : 0,
    source_prefix: (input.source && input.sourcePrefix) || null,
    supplied_frontmatter: input.source && input.suppliedFrontmatter ? JSON.stringify(input.suppliedFrontmatter) : null,
    upstream_frontmatter: 0,
    forked_from: input.forkedFrom ?? null,
    created_at: ts,
    updated_at: ts,
  };
  return tx(db, () => {
    try {
      insertRow(db, 'items', row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'name_taken', `you already have ${aKind(kind)} named '${name}'`, { name });
      throw e;
    }
    const v = insertVersion(db, p, row.id, 1, s, lint, input.note);
    if (input.source) db.prepare('UPDATE items SET source_tree_sha256 = ? WHERE id = ?').run(v.tree_sha256, row.id);
    refreshFts(db, row.id);
    return getItemRow(db, row.id)!;
  });
}

export const createItem = (ctx: Ctx, p: Principal, input: CreateItemInput): ItemRow => createItemTx(ctx, p, input);

/**
 * New full-snapshot version. Frontmatter title/description, when present, refresh the item's.
 * waiveFrontmatter: an import's source write that accepts frontmatter errors (0rdh); the item is marked for later updates.
 */
export function addVersion(ctx: Ctx, p: Principal, item: ItemRow, input: VersionInput, opts: { waiveFrontmatter?: boolean } = {}): VersionRow {
  const { db } = ctx;
  if (!canEditItem(db, p, item)) throw forbidden('you cannot edit this item');
  const s = placeEntry(shapeTree(item.kind, item.format, inputTree(item.kind, item.format, input), 'entry'), item.kind, item.name, item.format);
  const lint = gateLint(lintShaped(item.kind, item.name, s, opts.waiveFrontmatter));
  return tx(db, () => {
    const cur = getItemRow(db, item.id);
    if (!cur) throw notFound('item');
    const v = insertVersion(db, p, cur.id, cur.latest_seq + 1, s, lint, input.note);
    if (lint.some((l) => l.waived)) db.prepare('UPDATE items SET lint_waived = 1 WHERE id = ?').run(cur.id);
    db.prepare('UPDATE items SET title = ?, description = ? WHERE id = ?').run(
      fmString(s.fm, 'title') ?? cur.title,
      fmString(s.fm, 'description') ?? cur.description,
      cur.id,
    );
    refreshFts(db, cur.id);
    return v;
  });
}

export function updateItemMeta(ctx: Ctx, p: Principal, item: ItemRow, patch: MetaPatch): ItemRow {
  const { db } = ctx;
  if (!canEditItem(db, p, item)) throw forbidden('you cannot edit this item');
  checkVisibility(patch.visibility);
  // Choosing an audience is an account-level act (groups/service.ts updateGroup): a key contained
  // to its groups must not publish an item to every account.
  if (p.groupIds && patch.visibility !== undefined && patch.visibility !== item.visibility) {
    throw new HttpError(403, 'restricted_key', "a group-restricted API key cannot change an item's visibility");
  }
  const tags = patch.tags ? JSON.stringify(normalizeTags(patch.tags)) : item.tags;
  const text = (v: string | null | undefined, old: string) => (v === undefined ? old : (v?.trim() ?? '')); // columns are NOT NULL DEFAULT ''
  return tx(db, () => {
    db.prepare('UPDATE items SET title = ?, description = ?, category = ?, tags = ?, visibility = ?, updated_at = ? WHERE id = ?').run(
      text(patch.title, item.title),
      text(patch.description, item.description),
      text(patch.category, item.category),
      tags,
      patch.visibility ?? item.visibility,
      now(),
      item.id,
    );
    // Visibility decides whether other owners' groups publish it (publishedSql): what they serve changed.
    if (patch.visibility !== undefined && patch.visibility !== item.visibility) touchGroupsOfItem(db, item.id);
    refreshFts(db, item.id);
    return getItemRow(db, item.id)!;
  });
}

/** Cascades to versions and files; blobs those files referenced are swept in the same transaction (gc.ts). */
export function deleteItem(ctx: Ctx, p: Principal, item: ItemRow): void {
  const { db } = ctx;
  if (!canEditItem(db, p, item)) throw forbidden('you cannot edit this item');
  tx(db, () => {
    const hashes = (
      db
        .prepare('SELECT DISTINCT f.sha256 FROM version_files f JOIN item_versions v ON v.id = f.version_id WHERE v.item_id = ?')
        .all(item.id) as { sha256: string }[]
    ).map((r) => r.sha256);
    touchGroupsOfItem(db, item.id); // before the cascade takes the member rows with it
    db.prepare('DELETE FROM items_fts WHERE item_id = ?').run(item.id);
    db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
    sweepBlobs(db, hashes);
  });
}

/**
 * A copy of the entry text with its top-level frontmatter `name:` set to name (5ef6): the `name:` line
 * replaced, or added first in a block that names nothing, every other byte kept; a block those edits
 * cannot set (a block-scalar or quoted key) is re-emitted by the yaml library. Text with no frontmatter
 * gets a block of its own. Null when the frontmatter cannot be parsed (invalid YAML or fence): no name
 * can be set in it safely.
 */
export function renameFrontmatter(text: string, name: string): string | null {
  const fm = parseFrontmatter(text);
  const line = stringifyYaml({ name }).trimEnd();
  // A fence that is not on line 1 is a frontmatter error (lint frontmatter.invalid), not a body.
  if (!fm.hasFrontmatter) return /^[\uFEFF\s]*---/.test(text) ? null : `---\n${line}\n---\n${text}`;
  if (fm.error) return null;
  const lines = text.split('\n');
  const cr = lines[0].endsWith('\r') ? '\r' : '';
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\r?$/.test(l));
  const at = lines.findIndex((l, i) => i > 0 && i < close && /^name[ \t]*:/.test(l));
  const withBlock = (block: string[]) => [lines[0], ...block, ...lines.slice(close)].join('\n');
  const named = (out: string) => (parseFrontmatter(out).data.name === name ? out : null);
  const edited =
    at > 0 ? withBlock([...lines.slice(1, at), line + cr, ...lines.slice(at + 1, close)])
    : 'name' in fm.data ? null
    : withBlock([line + cr, ...lines.slice(1, close)]);
  if (edited !== null && named(edited)) return edited;
  const doc = parseDocument(lines.slice(1, close).join('\n'), { schema: 'core', uniqueKeys: false });
  doc.set('name', name);
  return named(withBlock(String(doc).trimEnd().split('\n').map((l) => l.replace(/\r$/, '') + cr)));
}

/**
 * Copy one version (default latest) into a new private item owned by p. The lint gate is skipped:
 * the source version was already accepted.
 */
export function forkItem(ctx: Ctx, p: Principal, item: ItemRow, seq?: number): ItemRow {
  const { db } = ctx;
  const v = resolveVersion(db, item, seq);
  let tree = readTree(db, v.id);
  return tx(db, () => {
    const taken = db.prepare('SELECT 1 FROM items WHERE owner_id = ? AND kind = ? AND name = ?');
    // A skill's name must equal its SKILL.md frontmatter name (its install folder), so a skill
    // fork keeps the name when it is free; other kinds re-home their entry file under the new name.
    let name = item.kind === 'skill' && !taken.get(p.userId, item.kind, item.name) ? item.name : '';
    for (let n = 1; !name || taken.get(p.userId, item.kind, name); n++) {
      const suffix = n === 1 ? '-fork' : `-fork-${n}`;
      name = item.name.slice(0, 64 - suffix.length).replace(/[-._]+$/, '') + suffix;
    }
    // Skills and agents are identified by their frontmatter name (formats.md), not their path: a
    // renamed fork that kept the original name would fail skill.name.dir, and an agent fork bundled
    // beside its original would be one identity in two files. The fork gets its own name.
    if (name !== item.name && (item.kind === 'skill' || item.kind === 'agent')) {
      tree = tree.map((f) => {
        const renamed = f.path === v.entry_path ? renameFrontmatter(utf8.decode(f.bytes), name) : null;
        return renamed === null ? f : { ...f, bytes: new TextEncoder().encode(renamed) };
      });
    }
    return createItemTx(
      ctx,
      p,
      {
        kind: item.kind,
        name,
        title: item.title,
        description: item.description,
        category: item.category,
        tags: JSON.parse(item.tags) as string[],
        format: item.format ?? undefined,
        tree,
        note: `fork of ${item.id} v${v.seq}`,
        forkedFrom: item.id,
      },
      { skipLintGate: true },
    );
  });
}
