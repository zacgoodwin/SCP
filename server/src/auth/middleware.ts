import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { sha256Hex } from '../lib/crypto.ts';
import { HttpError, forbidden } from '../lib/http.ts';
import { now } from '../db.ts';
import { normalizeScopes } from './service.ts';
import type { AppEnv, Principal, Scope, UserRow } from '../types.ts';

export const SESSION_COOKIE = 'scp_sid';

interface KeyRow {
  id: string;
  user_id: string;
  scopes: string;
  group_ids: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export const bearerToken = (c: Context) => {
  const h = c.req.header('authorization') ?? '';
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
};

/** Resolve a principal from a raw API key token. null when unknown, revoked, expired or user disabled. */
export function principalFromKey(c: Context<AppEnv>, token: string): Principal | null {
  const { db } = c.var.ctx;
  const key = db.prepare('SELECT * FROM api_keys WHERE token_hash = ?').get(sha256Hex(token)) as KeyRow | undefined;
  if (!key || key.revoked_at || (key.expires_at && key.expires_at <= now())) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(key.user_id) as UserRow | undefined;
  if (!user || user.disabled) return null;
  // Legacy write-only rows gain 'read'; a row with neither scope is unusable, so no route can be
  // reached without 'read' and the read routes need no per-route scope check.
  const scopes = normalizeScopes(JSON.parse(key.scopes) as string[]);
  if (!scopes.includes('read')) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), key.id);
  return {
    userId: user.id,
    username: user.username,
    isAdmin: !!user.is_admin,
    via: 'key',
    keyId: key.id,
    scopes,
    groupIds: key.group_ids ? (JSON.parse(key.group_ids) as string[]) : null,
  };
}

export function principalFromSession(c: Context<AppEnv>, sid: string): Principal | null {
  const { db } = c.var.ctx;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256Hex(sid), now()) as UserRow | undefined;
  if (!row || row.disabled) return null;
  return {
    userId: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    via: 'session',
    scopes: ['read', 'write'],
    groupIds: null,
  };
}

/**
 * Sets c.var.principal. A Bearer header that does not resolve is a hard 401 (never falls back to
 * the cookie), so a bad agent key cannot silently act as the browser user.
 */
export const principalMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c);
  if (token !== null) {
    const p = principalFromKey(c, token);
    if (!p) throw new HttpError(401, 'unauthorized', 'invalid or expired API key');
    c.set('principal', p);
  } else {
    const sid = getCookie(c, SESSION_COOKIE);
    c.set('principal', sid ? principalFromSession(c, sid) : null);
  }
  await next();
};

/**
 * The principal again, re-read from the request's key or session. Upload routes skip the pre-auth
 * body cap (app.ts), so their principal was resolved before a body that can take minutes to arrive;
 * call this once it is in, so a key revoked or an account reset meanwhile writes nothing.
 */
export function reauthenticate(c: Context<AppEnv>): Principal {
  const token = bearerToken(c);
  const sid = token === null ? getCookie(c, SESSION_COOKIE) : undefined;
  const p = token !== null ? principalFromKey(c, token) : sid ? principalFromSession(c, sid) : null;
  if (!p) throw new HttpError(401, 'unauthorized', 'the API key or session ended while the upload was arriving');
  c.set('principal', p);
  return p;
}

export function requireUser(c: Context<AppEnv>): Principal {
  const p = c.var.principal;
  if (!p) throw new HttpError(401, 'unauthorized', 'login or API key required');
  return p;
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!p.scopes.includes(scope)) throw forbidden(`API key lacks the '${scope}' scope`);
}

/**
 * Account-level endpoints (keys, audit log, stats, user admin) see the whole account, so a
 * group-restricted key may not use them: it would break full containment (PLAN.md access rules).
 */
export function requireAccountUser(c: Context<AppEnv>): Principal {
  const p = requireUser(c);
  if (p.groupIds) throw forbidden('a group-restricted API key cannot use account-level endpoints');
  return p;
}

export function requireAdmin(c: Context<AppEnv>): Principal {
  const p = requireAccountUser(c);
  if (!p.isAdmin) throw forbidden('admin only');
  return p;
}
