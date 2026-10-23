import { z } from 'zod';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto.ts';
import { HttpError, conflict } from '../lib/http.ts';
import { canReadGroup } from '../access.ts';
import { isUniqueViolation, newId, now, type Db } from '../db.ts';
import type { Principal, Scope, UserRow } from '../types.ts';

export const SESSION_TTL_MS = 30 * 86400_000;

export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,31}$/, 'invalid username');
export const passwordSchema = z.string().min(8).max(200);

export interface UserJson {
  id: string;
  email: string;
  username: string;
  isAdmin: boolean;
  disabled: boolean;
  /** Linked to a single sign-on identity (auth/oidc.ts); admins see and can drop the link. */
  oidcLinked: boolean;
  createdAt: string;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scopes: string;
  group_ids: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface KeyJson {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  groupIds: string[] | null;
  groups: { id: string; slug: string }[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export const invalidCredentials = () => new HttpError(401, 'invalid_credentials', 'invalid login or password');

export const userJson = (u: UserRow): UserJson => ({
  id: u.id,
  email: u.email,
  username: u.username,
  isAdmin: !!u.is_admin,
  disabled: !!u.disabled,
  oidcLinked: !!u.oidc_sub,
  createdAt: u.created_at,
});

export const getUser = (db: Db, id: string) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;

export function sessionPrincipal(u: UserRow): Principal {
  return { userId: u.id, username: u.username, isAdmin: !!u.is_admin, via: 'session', scopes: ['read', 'write'], groupIds: null };
}

/** Insert a user. Username must already be normalized (usernameSchema). 409 on duplicate email/username. */
export async function createUser(db: Db, input: { email: string; username: string; password: string; isAdmin?: boolean }): Promise<UserRow> {
  const id = newId();
  const hash = await hashPassword(input.password);
  try {
    db.prepare(
      'INSERT INTO users (id, email, username, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).run(id, input.email, input.username, hash, input.isAdmin ? 1 : 0, now());
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('email or username already taken');
    throw e;
  }
  return getUser(db, id)!;
}

/** email and username columns are COLLATE NOCASE, so this is case-insensitive. */
export const findUserByLogin = (db: Db, login: string) =>
  db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(login, login) as UserRow | undefined;

let dummyHash: Promise<string> | undefined;

/**
 * The user for valid credentials, else null. Unknown users still pay one scrypt against a dummy
 * hash, and disabled users are checked after the hash, so all failures take about the same time.
 */
export async function verifyLogin(db: Db, login: string, password: string): Promise<UserRow | null> {
  const u = findUserByLogin(db, login.trim());
  const ok = await verifyPassword(password, u?.password_hash ?? (await (dummyHash ??= hashPassword('dummy-password'))));
  // Re-read after the await: the account may have been disabled or deleted meanwhile.
  const cur = u && getUser(db, u.id);
  return cur && ok && cur.password_hash === u.password_hash && !cur.disabled ? cur : null;
}

/** Create a session; returns the raw id for the cookie (only its sha256 is stored). `authMethod` 'oidc' marks an SSO sign-in. */
export function createSession(db: Db, userId: string, authMethod: 'oidc' | null = null): { sid: string; expiresAt: string } {
  const sid = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, auth_method) VALUES (?, ?, ?, ?, ?)').run(
    sha256Hex(sid),
    userId,
    now(),
    expiresAt,
    authMethod,
  );
  return { sid, expiresAt };
}

export const deleteSession = (db: Db, sid: string) => db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256Hex(sid));

export const deleteExpiredSessions = (db: Db) => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());

export function keyJson(db: Db, k: ApiKeyRow): KeyJson {
  const groupIds = k.group_ids ? (JSON.parse(k.group_ids) as string[]) : null;
  const groups = groupIds
    ? (db
        .prepare('SELECT id, slug FROM scp_groups WHERE id IN (SELECT value FROM json_each(?)) ORDER BY slug')
        .all(JSON.stringify(groupIds)) as unknown as { id: string; slug: string }[])
    : [];
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: normalizeScopes(JSON.parse(k.scopes) as string[]),
    groupIds,
    groups: groups.map((g) => ({ id: g.id, slug: g.slug })),
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    expiresAt: k.expires_at,
  };
}

export const listKeys = (db: Db, userId: string) =>
  (db.prepare('SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC').all(userId) as unknown as ApiKeyRow[]).map(
    (k) => keyJson(db, k),
  );

/** 'write' implies 'read' (PLAN.md access rules), so a write-only key cannot exist; canonical order. */
export const normalizeScopes = (s: readonly string[]): Scope[] =>
  s.includes('write') ? ['read', 'write'] : s.includes('read') ? ['read'] : [];

export const keyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(['read', 'write'])).min(1),
  groups: z.array(z.string().min(1).max(100)).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type KeyInput = z.infer<typeof keyInputSchema>;

/**
 * Mint a key for p's user. Each group slug must be readable by p (400 unknown_group otherwise, same
 * answer for missing and unreadable so slugs do not leak). The token is returned once and never stored.
 */
export function mintKey(db: Db, p: Principal, input: KeyInput): { key: KeyJson; token: string } {
  let groupIds: string[] | null = null;
  if (input.groups) {
    groupIds = [];
    for (const slug of input.groups) {
      const g = db.prepare('SELECT id FROM scp_groups WHERE slug = ?').get(slug) as { id: string } | undefined;
      if (!g || !canReadGroup(db, p, g.id)) throw new HttpError(400, 'unknown_group', `unknown group: ${slug}`);
      if (!groupIds.includes(g.id)) groupIds.push(g.id);
    }
  }
  const scopes = normalizeScopes(input.scopes);
  const token = randomToken('scp_');
  const id = newId();
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000).toISOString() : null;
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, token_hash, prefix, scopes, group_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, p.userId, input.name, sha256Hex(token), token.slice(0, 12), JSON.stringify(scopes), groupIds && JSON.stringify(groupIds), now(), expiresAt);
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as unknown as ApiKeyRow;
  return { key: keyJson(db, row), token };
}

/** Enabled admins other than excludeId. */
export const otherEnabledAdmins = (db: Db, excludeId: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND id != ?').get(excludeId) as { n: number }).n;
