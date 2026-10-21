import { canEditItem } from '../access.ts';
import { requireScope } from '../auth/middleware.ts';
import type { Config } from '../config.ts';
import { newId, now, type Db } from '../db.ts';
import { randomToken, sha256Hex, signPayload } from '../lib/crypto.ts';
import { HttpError, badRequest, forbidden, notFound } from '../lib/http.ts';
import { getItemRow, readFile } from '../items/service.ts';
import { sanitizeCspDomains } from './csp.ts';
import { renderArtifact } from './render.ts';
import type { Ctx, ItemRow, Principal, VersionRow } from '../types.ts';

export interface ShareRow {
  id: string;
  item_id: string;
  token_hash: string;
  token: string | null;
  pinned_seq: number | null;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ShareJson {
  id: string;
  itemId: string;
  pinnedSeq: number | null;
  createdAt: string;
  revokedAt: string | null;
  /** Public share page on the app origin. null only for rows minted before tokens were kept. */
  url: string | null;
  /** Raw rendered artifact on the artifact origin. */
  rawUrl: string | null;
}

export const PREVIEW_TTL_S = 600;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function assertArtifact(item: ItemRow): void {
  if (item.kind !== 'artifact') throw new HttpError(400, 'not_artifact', 'only artifacts can be previewed or shared');
}

export const shareJson = (config: Config, s: ShareRow): ShareJson => ({
  id: s.id,
  itemId: s.item_id,
  pinnedSeq: s.pinned_seq,
  createdAt: s.created_at,
  revokedAt: s.revoked_at,
  url: s.token ? `${config.publicUrl}/s/${s.token}` : null,
  rawUrl: s.token ? `${config.artifactUrl}/r/${s.token}` : null,
});

/**
 * Mint a public link. Caller-agnostic: checks write scope and edit rights itself (the MCP chunk calls it too).
 * pinnedSeq pins the version the caller reviewed; pinVersion alone pins whatever is latest right now.
 */
export function createShare(ctx: Ctx, p: Principal, item: ItemRow, opts: { pinVersion?: boolean; pinnedSeq?: number } = {}): ShareJson {
  requireScope(p, 'write');
  assertArtifact(item);
  if (!canEditItem(ctx.db, p, item)) throw forbidden('you cannot share this item');
  const seq = opts.pinnedSeq;
  if (seq !== undefined && (!Number.isInteger(seq) || seq < 1 || seq > item.latest_seq)) {
    throw badRequest(`pinnedSeq must be between 1 and ${item.latest_seq}`);
  }
  const token = randomToken();
  const row: ShareRow = {
    id: newId(),
    item_id: item.id,
    token_hash: sha256Hex(token),
    token,
    pinned_seq: seq ?? (opts.pinVersion ? item.latest_seq : null),
    created_by: p.userId,
    created_at: now(),
    revoked_at: null,
  };
  ctx.db
    .prepare('INSERT INTO shares (id, item_id, token_hash, token, pinned_seq, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.item_id, row.token_hash, row.token, row.pinned_seq, row.created_by, row.created_at, row.revoked_at);
  return shareJson(ctx.config, row);
}

/** Every share of an item, revoked included, newest first. The caller has checked edit rights. */
export function listShares(ctx: Ctx, itemId: string): ShareJson[] {
  const rows = ctx.db.prepare('SELECT * FROM shares WHERE item_id = ? ORDER BY created_at DESC, id DESC').all(itemId) as unknown as ShareRow[];
  return rows.map((r) => shareJson(ctx.config, r));
}

/** Revoke by id. 404 unless p can edit the shared item (no existence leak). Idempotent. */
export function revokeShare(ctx: Ctx, p: Principal, shareId: string): ShareJson {
  const { db } = ctx;
  const share = db.prepare('SELECT * FROM shares WHERE id = ?').get(shareId) as ShareRow | undefined;
  const item = share && getItemRow(db, share.item_id);
  if (!share || !item || !canEditItem(db, p, item)) throw notFound('share');
  if (!share.revoked_at) {
    share.revoked_at = now();
    db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(share.revoked_at, share.id);
  }
  return shareJson(ctx.config, share);
}

/** null when the token is malformed, unknown or revoked, its item/version is gone, or its owner is disabled. */
export function resolveShare(db: Db, token: string): { share: ShareRow; item: ItemRow; version: VersionRow } | null {
  if (!TOKEN.test(token)) return null;
  const share = db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(sha256Hex(token)) as ShareRow | undefined;
  if (!share || share.revoked_at) return null;
  const item = getItemRow(db, share.item_id);
  if (!item || item.kind !== 'artifact') return null;
  if (ownerDisabled(db, item.owner_id)) return null;
  const version = getVersion(db, item.id, share.pinned_seq ?? item.latest_seq);
  return version ? { share, item, version } : null;
}

/** Disabling an account takes its share links and previews down too, reversibly (re-enable restores them). */
export const ownerDisabled = (db: Db, ownerId: string) => !!db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 1').get(ownerId);

export const getVersion = (db: Db, itemId: string, seq: number) =>
  db.prepare('SELECT * FROM item_versions WHERE item_id = ? AND seq = ?').get(itemId, seq) as VersionRow | undefined;

/** Signed owner preview on the artifact origin (which has no cookies), valid PREVIEW_TTL_S. */
export function previewUrl(ctx: Ctx, item: ItemRow, seq: number, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + PREVIEW_TTL_S;
  return `${ctx.config.artifactUrl}/p/${signPayload(ctx.secret, { i: item.id, s: seq, exp })}`;
}

const utf8 = new TextDecoder('utf-8');

// Versions are immutable, so a render is keyed by the version plus everything else that feeds it.
// ponytail: per-process LRU bounded by total chars; share it (or pre-render on write) past one process.
const RENDER_CACHE_CHARS = 32 * 1024 * 1024;
const rendered = new Map<string, string>();
let renderedChars = 0;

/**
 * Rendered HTML for one stored version (its single entry file). Cached: every anonymous /r and /p
 * hit, MCP resource read and viewer page lands here, and a render can take a few hundred ms.
 */
export function renderVersionHtml(db: Db, config: Config, item: ItemRow, version: VersionRow): string {
  const format = item.format ?? 'code';
  const title = item.title || item.name;
  const cdns = sanitizeCspDomains(config.cdns);
  const key = JSON.stringify([version.id, format, title, cdns]);
  const hit = rendered.get(key);
  if (hit !== undefined) {
    rendered.delete(key);
    rendered.set(key, hit);
    return hit;
  }
  const f = readFile(db, version.id, version.entry_path);
  const html = renderArtifact(format, f ? utf8.decode(f.bytes) : '', { title, cdns });
  rendered.set(key, html);
  renderedChars += html.length;
  for (const [k, v] of rendered) {
    if (renderedChars <= RENDER_CACHE_CHARS) break;
    rendered.delete(k);
    renderedChars -= v.length;
  }
  return html;
}
