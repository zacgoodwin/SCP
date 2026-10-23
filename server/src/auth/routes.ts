import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { hashPassword, sha256Hex, verifyPassword } from '../lib/crypto.ts';
import { HttpError, conflict, forbidden, notFound, parseJson, parseQuery } from '../lib/http.ts';
import { AUTH_LIMITS, limitIp, rateLimited, take } from '../lib/ratelimit.ts';
import { isUniqueViolation, now, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { sweepBlobs } from '../items/gc.ts';
import { SESSION_COOKIE, requireAccountUser, requireAdmin, requireScope, requireUser } from './middleware.ts';
import { OIDC_PASSWORD_HASH, oidcPublicConfig } from './oidc.ts';
import { touchGroupsOfUser } from '../groups/touch.ts';
import { deleteUserCodes, revokeUserGrants } from '../oauth/service.ts';
import {
  SESSION_TTL_MS,
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  getUser,
  invalidCredentials,
  keyInputSchema,
  listKeys,
  mintKey,
  otherEnabledAdmins,
  passwordSchema,
  sessionPrincipal,
  userJson,
  usernameSchema,
  verifyLogin,
  type ApiKeyRow,
} from './service.ts';
import type { AppEnv, Principal, UserRow } from '../types.ts';

export const authRoutes = new Hono<AppEnv>();

const newUserSchema = z.object({ email: z.email().max(254), username: usernameSchema, password: passwordSchema });

function startSession(c: Context<AppEnv>, u: UserRow) {
  const { db, config } = c.var.ctx;
  deleteExpiredSessions(db);
  const { sid } = createSession(db, u.id);
  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    secure: config.secureCookies,
  });
}

const requireSession = (c: Context<AppEnv>, what: string): Principal => {
  const p = requireUser(c);
  if (p.via !== 'session') throw forbidden(`${what} requires a browser session, not an API key`);
  return p;
};

// ---------- anonymous scrypt limiter (buckets in lib/ratelimit.ts, shared with the OIDC routes) ----------

function limitAnonymous(c: Context<AppEnv>, login?: string): void {
  const ip = limitIp(c);
  if (login === undefined) return;
  const name = JSON.stringify(login.trim().toLowerCase()); // quoted: a name cannot forge another key
  if (!take(c, `login:${ip}:${name}`, AUTH_LIMITS.login) || !take(c, `loginAll:${name}`, AUTH_LIMITS.loginAll)) throw rateLimited();
}

authRoutes.post('/auth/register', async (c) => {
  if (!c.var.ctx.config.allowRegistration) throw new HttpError(403, 'registration_disabled', 'registration is disabled');
  const body = await parseJson(c, newUserSchema);
  limitAnonymous(c);
  const u = await createUser(c.var.ctx.db, body);
  startSession(c, u);
  audit(c, sessionPrincipal(u), { action: 'user.register', targetType: 'user', targetId: u.id });
  return c.json({ user: userJson(u) }, 201);
});

authRoutes.post('/auth/login', async (c) => {
  const body = await parseJson(c, z.object({ login: z.string().min(1).max(254), password: z.string().max(200) }));
  limitAnonymous(c, body.login);
  const u = await verifyLogin(c.var.ctx.db, body.login, body.password);
  if (!u) throw invalidCredentials();
  startSession(c, u);
  audit(c, sessionPrincipal(u), { action: 'login' });
  return c.json({ user: userJson(u) });
});

authRoutes.post('/auth/logout', (c) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) deleteSession(c.var.ctx.db, sid);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.body(null, 204);
});

authRoutes.get('/auth/me', (c) => {
  const p = requireUser(c);
  const u = getUser(c.var.ctx.db, p.userId)!;
  return c.json({ user: userJson(u), principal: { via: p.via, scopes: p.scopes, groupIds: p.groupIds } });
});

authRoutes.post('/auth/password', async (c) => {
  const p = requireSession(c, 'changing the password');
  const body = await parseJson(c, z.object({ current: z.string().max(200), next: passwordSchema }));
  const { db } = c.var.ctx;
  const u = getUser(db, p.userId)!;
  if (!(await verifyPassword(body.current, u.password_hash))) throw invalidCredentials();
  const hash = await hashPassword(body.next);
  const keep = sha256Hex(getCookie(c, SESSION_COOKIE) ?? '');
  await c.var.ctx.beforePasswordWrite?.();
  tx(db, () => {
    // Compare-and-swap: an admin reset (the account-recovery path) may have landed during the
    // awaits above, replacing the hash and ending this session. Then this change must not win.
    const live = db.prepare('SELECT 1 FROM sessions WHERE id_hash = ? AND user_id = ?').get(keep, u.id);
    const r = live && db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ? AND disabled = 0').run(hash, u.id, u.password_hash);
    if (!r || !r.changes) throw invalidCredentials();
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(u.id, keep);
  });
  audit(c, p, { action: 'user.password', targetType: 'user', targetId: u.id });
  return c.body(null, 204);
});

authRoutes.get('/auth/config', (c) => {
  const { config } = c.var.ctx;
  return c.json({
    registration: config.allowRegistration,
    publicUrl: config.publicUrl,
    artifactUrl: config.artifactUrl,
    artifactOrigin: new URL(config.artifactUrl).origin,
    oidc: oidcPublicConfig(c.var.ctx),
  });
});

// --- API keys

authRoutes.get('/keys', (c) => {
  const p = requireAccountUser(c);
  return c.json({ keys: listKeys(c.var.ctx.db, p.userId) });
});

authRoutes.post('/keys', async (c) => {
  const p = requireSession(c, 'minting keys');
  const body = await parseJson(c, keyInputSchema);
  const { key, token } = mintKey(c.var.ctx.db, p, body);
  audit(c, p, { action: 'key.create', targetType: 'key', targetId: key.id, detail: { name: key.name, scopes: key.scopes, groupIds: key.groupIds } });
  return c.json({ key, token }, 201);
});

authRoutes.delete('/keys/:id', (c) => {
  const p = requireUser(c);
  requireScope(p, 'write');
  const { db } = c.var.ctx;
  const k = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(c.req.param('id')) as ApiKeyRow | undefined;
  // A group-restricted key may revoke itself, never the account's other keys; it cannot see them,
  // so they are a 404 like anything else it cannot read.
  if (!k || (k.user_id !== p.userId && !p.isAdmin) || (p.groupIds && k.id !== p.keyId)) throw notFound('key');
  if (!k.revoked_at) db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now(), k.id);
  audit(c, p, { action: 'key.revoke', targetType: 'key', targetId: k.id });
  return c.body(null, 204);
});

// --- Users

authRoutes.get('/users/search', (c) => {
  requireAccountUser(c);
  const { q } = parseQuery(c, z.object({ q: z.string().max(32).default('') }));
  const pattern = q.trim().toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
  const users = c.var.ctx.db
    .prepare("SELECT id, username FROM users WHERE disabled = 0 AND username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 10")
    .all(pattern) as { id: string; username: string }[];
  return c.json({ users: users.map((u) => ({ id: u.id, username: u.username })) });
});

const requireAdminWrite = (c: Context<AppEnv>) => {
  const p = requireAdmin(c);
  requireScope(p, 'write');
  return p;
};

const targetUser = (c: Context<AppEnv>) => {
  const u = getUser(c.var.ctx.db, c.req.param('id') ?? '');
  if (!u) throw notFound('user');
  return u;
};

/** Refuse changes that would leave the caller locked out or the instance without an enabled admin. */
function guardAdminLoss(c: Context<AppEnv>, p: Principal, target: UserRow, what: string) {
  if (target.id === p.userId) throw conflict(`you cannot ${what} yourself`);
  if (target.is_admin && !target.disabled && otherEnabledAdmins(c.var.ctx.db, target.id) === 0) {
    throw conflict(`cannot ${what} the last enabled admin`);
  }
}

authRoutes.get('/users', (c) => {
  requireAdmin(c);
  const rows = c.var.ctx.db.prepare('SELECT * FROM users ORDER BY created_at, id').all() as unknown as UserRow[];
  return c.json({ users: rows.map(userJson) });
});

authRoutes.post('/users', async (c) => {
  const p = requireAdminWrite(c);
  const body = await parseJson(c, newUserSchema.extend({ isAdmin: z.boolean().optional() }));
  const u = await createUser(c.var.ctx.db, body);
  audit(c, p, { action: 'user.create', targetType: 'user', targetId: u.id, detail: { isAdmin: !!u.is_admin } });
  return c.json({ user: userJson(u) }, 201);
});

authRoutes.patch('/users/:id', async (c) => {
  const p = requireAdminWrite(c);
  const body = await parseJson(
    c,
    z.object({
      username: usernameSchema.optional(),
      email: z.email().max(254).optional(),
      isAdmin: z.boolean().optional(),
      disabled: z.boolean().optional(),
      password: passwordSchema.optional(),
      /** Drop the single sign-on link (an admin cannot see the identity, only that one is bound). */
      oidcUnlink: z.literal(true).optional(),
    }),
  );
  const target = targetUser(c);
  // A reset revokes every session and key of the target, which would sign the admin out mid-click.
  if (body.password !== undefined && target.id === p.userId) throw conflict('use POST /auth/password to change your own password');
  if (body.oidcUnlink && body.password === undefined && target.password_hash === OIDC_PASSWORD_HASH) {
    throw conflict('this account has no password; set one in the same request, or it becomes unreachable');
  }
  // Recovery semantics: a reset also drops the single sign-on link, which an intruder may have bound to
  // their own IdP identity while they held a session (it would otherwise sign them straight back in).
  const unlink = (body.password !== undefined || !!body.oidcUnlink) && target.oidc_sub !== null;
  if (body.isAdmin === false && target.is_admin) guardAdminLoss(c, p, target, 'demote');
  if (body.disabled === true && !target.disabled) guardAdminLoss(c, p, target, 'disable');
  const { db } = c.var.ctx;
  const hash = body.password !== undefined ? await hashPassword(body.password) : null;
  let grantsRevoked: number | undefined;
  tx(db, () => {
    try {
      if (body.username !== undefined) db.prepare('UPDATE users SET username = ? WHERE id = ?').run(body.username, target.id);
      if (body.email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(body.email, target.id);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('email or username already taken');
      throw e;
    }
    if (body.isAdmin !== undefined) db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(body.isAdmin ? 1 : 0, target.id);
    if (body.disabled !== undefined && (body.disabled ? 1 : 0) !== target.disabled) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, target.id);
      // Their items and groups leave (or rejoin) every group that holds them: those plugins' versions must move.
      touchGroupsOfUser(db, target.id);
    }
    if (hash !== null) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, target.id);
    if (unlink) db.prepare('UPDATE users SET oidc_issuer = NULL, oidc_sub = NULL WHERE id = ?').run(target.id);
    // A disabled account or a reset password ends every live browser session of that user.
    if (body.disabled === true || body.password !== undefined) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    // Disabling and a password reset both end every OAuth grant and any code awaiting exchange: a
    // grant an intruder consented to must not come back when the account is enabled again, and
    // redeemCode checks only the code. API keys survive a disable (refused meanwhile, reversible)
    // but not a reset, which is the account-recovery path for whoever held the account.
    if (body.disabled === true || body.password !== undefined) {
      deleteUserCodes(db, target.id);
      grantsRevoked = revokeUserGrants(db, target.id);
    }
    if (body.password !== undefined) {
      db.prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), target.id);
    }
  });
  audit(c, p, {
    action: 'user.update',
    targetType: 'user',
    targetId: target.id,
    detail: {
      isAdmin: body.isAdmin,
      disabled: body.disabled,
      passwordReset: body.password !== undefined,
      oidcUnlinked: unlink || undefined,
      grantsRevoked,
      username: body.username,
      emailChanged: body.email !== undefined || undefined,
    },
  });
  return c.json({ user: userJson(getUser(db, target.id)!) });
});

authRoutes.delete('/users/:id', (c) => {
  const p = requireAdminWrite(c);
  const target = targetUser(c);
  guardAdminLoss(c, p, target, 'delete');
  const { db } = c.var.ctx;
  // The cascade removes the user's items, versions and files; blobs only those referenced are swept
  // in the same transaction, like deleteItem (items/service.ts), so nothing waits for the boot sweep.
  tx(db, () => {
    const hashes = (
      db
        .prepare('SELECT DISTINCT f.sha256 FROM version_files f JOIN item_versions v ON v.id = f.version_id JOIN items i ON i.id = v.item_id WHERE i.owner_id = ?')
        .all(target.id) as { sha256: string }[]
    ).map((r) => r.sha256);
    touchGroupsOfUser(db, target.id); // before the cascade takes the member and include rows with it
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    sweepBlobs(db, hashes);
  });
  audit(c, p, { action: 'user.delete', targetType: 'user', targetId: target.id, detail: { username: target.username } });
  return c.body(null, 204);
});
