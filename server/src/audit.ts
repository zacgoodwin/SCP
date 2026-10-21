import { Hono, type Context } from 'hono';
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

/** Record one event. Never pass secrets or content bodies in detail. */
export function audit(c: Context<AppEnv>, p: Principal | null, e: AuditEvent): void {
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
      JSON.stringify(e.detail ?? {}),
      clientIp(c, c.var.ctx.config.trustProxy),
    );
}

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.get('/audit', (c) => {
  const p = requireAccountUser(c);
  const q = parseQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), all: z.string().optional() }));
  const all = p.isAdmin && q.all === '1';
  const rows = c.var.ctx.db
    .prepare(
      `SELECT a.id, a.ts, a.action, a.target_type, a.target_id, a.detail, a.ip, a.key_id, u.username
       FROM audit a LEFT JOIN users u ON u.id = a.user_id
       ${all ? '' : 'WHERE a.user_id = ?'} ORDER BY a.id DESC LIMIT ?`,
    )
    .all(...(all ? [q.limit] : [p.userId, q.limit])) as Record<string, string | number | null>[];
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
