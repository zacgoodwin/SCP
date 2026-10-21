import { Hono, type Context } from 'hono';
import type { SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { now } from './db.ts';
import { clientIp, parseQuery } from './lib/http.ts';
import { requireAccountUser } from './auth/middleware.ts';
import type { AppEnv, Principal } from './types.ts';

export interface AuditEvent {
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Record one event. Never pass secrets or content bodies in detail. An OAuth principal names its
 * client in detail.oauthClientId: it carries no key id, and two connected apps must stay tellable
 * apart from each other and from the user's own actions.
 */
export function audit(c: Context<AppEnv>, p: Principal | null, e: AuditEvent): void {
  const detail = p?.via === 'oauth' && p.oauthClientId ? { ...e.detail, oauthClientId: p.oauthClientId } : (e.detail ?? {});
  c.var.ctx.db
    .prepare(
      'INSERT INTO audit (ts, user_id, key_id, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      now(),
      p?.userId ?? null,
      p?.keyId ?? null,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      JSON.stringify(detail),
      clientIp(c, c.var.ctx.config.trustProxy),
    );
}

export const auditRoutes = new Hono<AppEnv>();

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  all: z.string().optional(),
  /** Page cursor: events with a smaller id (the list is newest first). */
  before: z.coerce.number().int().min(1).optional(),
  user: z.string().trim().max(32).optional(),
  /** Action prefix, e.g. `item.` or `user.update`. */
  action: z.string().trim().max(64).optional(),
  /** Substring of target_id or detail. */
  q: z.string().trim().max(200).optional(),
});

const like = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/**
 * Own events, or every user's with all=1 as admin (D4 /admin/logs). Filters apply on top of that
 * scope, so a non-admin filtering by another username sees nothing rather than that user's events.
 */
auditRoutes.get('/audit', (c) => {
  const p = requireAccountUser(c);
  const q = parseQuery(c, auditQuery);
  const all = p.isAdmin && q.all === '1';
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (!all) {
    where.push('a.user_id = ?');
    params.push(p.userId);
  }
  if (q.before !== undefined) {
    where.push('a.id < ?');
    params.push(q.before);
  }
  if (q.user) {
    where.push('u.username = ?'); // the column is COLLATE NOCASE
    params.push(q.user);
  }
  if (q.action) {
    where.push("a.action LIKE ? ESCAPE '\\'");
    params.push(like(q.action) + '%');
  }
  if (q.q) {
    where.push("(a.target_id LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\')");
    params.push(`%${like(q.q)}%`, `%${like(q.q)}%`);
  }
  const rows = c.var.ctx.db
    .prepare(
      `SELECT a.id, a.ts, a.action, a.target_type, a.target_id, a.detail, a.ip, a.key_id, u.username
       FROM audit a LEFT JOIN users u ON u.id = a.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`,
    )
    .all(...params, q.limit) as Record<string, string | number | null>[];
  return c.json({
    events: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: JSON.parse(String(r.detail)),
      ip: r.ip,
      keyId: r.key_id,
      username: r.username,
    })),
  });
});
