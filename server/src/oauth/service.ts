import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canReadGroup } from '../access.ts';
import { normalizeScopes } from '../auth/service.ts';
import { newId, now, tx, type Db } from '../db.ts';
import { HttpError } from '../lib/http.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import type { Principal, Scope } from '../types.ts';

/*
 * OAuth 2.1 authorization server for hosted MCP clients (docs/PLAN-v2.md D2). Errors thrown here are
 * HttpErrors whose `code` is the RFC 6749 / 7591 error name; oauth/routes.ts renders them as
 * `{error, error_description}` on the app-root endpoints and the API error handler renders them as
 * usual under /api/v1 (the consent endpoints).
 */

export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 86400_000;
export const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const oauthError = (status: 400 | 401 | 429, error: string, description: string, details?: unknown) => new HttpError(status, error, description, details);

/**
 * HttpError.details of a redeemCode / refreshTokens failure that revoked a grant (a replayed code, a
 * reused refresh token): the token endpoint audits it, since nothing else is left of the grant.
 */
export interface RevokedGrant {
  revoked: { grantId: string; userId: string; clientId: string; by: 'code_replay' | 'reuse' };
}

export interface ClientRow {
  id: string;
  secret_hash: string | null;
  name: string;
  redirect_uris: string;
  grant_types: string;
  token_endpoint_auth_method: AuthMethod;
  client_uri: string | null;
  logo_uri: string | null;
  created_by: string | null;
  created_at: string;
  disabled: number;
  /** First consent (issueCode): a consented client is kept however long its tokens have been gone (sweepClients). */
  consented_at: string | null;
}

export interface CodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scopes: string;
  group_ids: string | null;
  resource: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface TokenRow {
  id: string;
  token_hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  user_id: string;
  grant_id: string;
  scopes: string;
  group_ids: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export const getClient = (db: Db, id: string) => db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id) as ClientRow | undefined;

// ---------- redirect URIs ----------

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Schemes the browser itself acts on; every other custom scheme is handed to the OS protocol handler, which asks the user. */
const BROWSER_SCHEMES = ['javascript:', 'data:', 'blob:', 'file:', 'vbscript:', 'about:'];

/**
 * Why `uri` cannot be a redirect URI, or null when it can: https, http on a loopback host, or the
 * private-use scheme a native host registers (RFC 8252 7.1): `cursor://anysphere.cursor-mcp/cb`,
 * `vscode://...`, `com.example.app:/oauth`. The code is bound by PKCE (mandatory here), and the
 * client picked the scheme at registration, so only browser-executed schemes are refused.
 */
export function redirectUriProblem(uri: string): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'must be an absolute URL';
  }
  if (uri.includes('#')) return 'must not contain a fragment';
  if (u.username || u.password) return 'must not contain credentials';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') return LOOPBACK.includes(u.hostname) ? null : 'must be https://, or http:// on localhost, 127.0.0.1 or [::1]';
  if (BROWSER_SCHEMES.includes(u.protocol)) return `must not use the ${u.protocol} scheme`;
  return null;
}

/**
 * Exact match against the registered list. The one exception is OAuth 2.1 / RFC 8252 7.3: a loopback
 * redirect may use any port, since native clients bind whatever port is free.
 */
export function redirectUriRegistered(client: ClientRow, uri: string): boolean {
  const registered = JSON.parse(client.redirect_uris) as string[];
  if (registered.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  // The port is the only thing that may vary: a fragment or credentials would never have registered
  // (redirectUriProblem) and must not ride in on the exemption either.
  if (u.protocol !== 'http:' || !LOOPBACK.includes(u.hostname) || redirectUriProblem(uri) !== null) return false;
  return registered.some((r) => {
    const x = new URL(r);
    return x.protocol === 'http:' && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search;
  });
}

// ---------- registration (RFC 7591) ----------

export const registerSchema = z.looseObject({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().max(200).optional(),
  token_endpoint_auth_method: z.enum(AUTH_METHODS).default('none'),
  grant_types: z.array(z.string().max(50)).max(10).optional(),
  response_types: z.array(z.string().max(50)).max(10).optional(),
  client_uri: z.url().max(2000).optional(),
  logo_uri: z.url().max(2000).optional(),
  scope: z.string().max(200).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

const GRANT_TYPES = ['authorization_code', 'refresh_token'];

/** Insert a client; returns the row and, for confidential clients, the secret (shown once). */
export function registerClient(db: Db, input: RegisterInput, createdBy: string | null): { client: ClientRow; secret: string | null } {
  for (const uri of input.redirect_uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw oauthError(400, 'invalid_redirect_uri', `redirect_uri ${uri} ${problem}`);
  }
  const grants = input.grant_types ?? GRANT_TYPES;
  const unknown = grants.filter((g) => !GRANT_TYPES.includes(g));
  if (unknown.length) throw oauthError(400, 'invalid_client_metadata', `unsupported grant_types: ${unknown.join(', ')}`);
  if (!grants.includes('authorization_code')) throw oauthError(400, 'invalid_client_metadata', 'grant_types must include authorization_code');
  if (input.response_types && input.response_types.some((r) => r !== 'code')) {
    throw oauthError(400, 'invalid_client_metadata', 'response_types may only contain code');
  }
  // The consent page links client_uri and may show logo_uri: a javascript: or data: URL there is a
  // clickable script on an authenticated page, planted by an anonymous registration.
  for (const [field, uri] of [['client_uri', input.client_uri], ['logo_uri', input.logo_uri]] as const) {
    if (uri !== undefined && !/^https?:\/\//i.test(uri)) throw oauthError(400, 'invalid_client_metadata', `${field} must be an http(s) URL`);
  }
  if (input.scope !== undefined) parseScope(input.scope); // 400 invalid_scope
  const secret = input.token_endpoint_auth_method === 'none' ? null : randomToken('scp_cs_');
  const id = newId();
  db.prepare(
    `INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, grant_types, token_endpoint_auth_method, client_uri, logo_uri, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    secret && sha256Hex(secret),
    input.client_name || 'Unnamed client',
    JSON.stringify(input.redirect_uris),
    JSON.stringify(grants),
    input.token_endpoint_auth_method,
    input.client_uri ?? null,
    input.logo_uri ?? null,
    createdBy,
    now(),
  );
  return { client: getClient(db, id)!, secret };
}

/** RFC 7591 registration response / admin view of a client. */
export function clientJson(client: ClientRow) {
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
    client_name: client.name,
    redirect_uris: JSON.parse(client.redirect_uris) as string[],
    grant_types: JSON.parse(client.grant_types) as string[],
    response_types: ['code'],
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    ...(client.client_uri ? { client_uri: client.client_uri } : {}),
    ...(client.logo_uri ? { logo_uri: client.logo_uri } : {}),
  };
}

// ---------- authorize request ----------

/** Space-separated scope string -> canonical scopes; omitted/empty = read. 400 invalid_scope otherwise. */
export function parseScope(scope: string | undefined): Scope[] {
  const parts = (scope ?? '').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ['read'];
  for (const s of parts) if (s !== 'read' && s !== 'write') throw oauthError(400, 'invalid_scope', `unknown scope: ${s}`);
  return normalizeScopes(parts);
}

/** RFC 8707: the resource must be this server's MCP endpoint, or one group's. */
export function checkResource(publicUrl: string, resource: string | undefined): string | null {
  if (resource === undefined) return null;
  const mcp = `${publicUrl}/mcp`;
  // The slug segment is case-insensitive: slugs are COLLATE NOCASE (db.ts), so /mcp/Kit serves with a
  // key and the host derives `resource` from the URL the user typed.
  const ok = resource === mcp || (resource.startsWith(`${mcp}/`) && /^[a-z0-9][a-z0-9-]{1,63}$/i.test(resource.slice(mcp.length + 1)));
  if (!ok) throw oauthError(400, 'invalid_target', `resource must be ${mcp} or ${mcp}/<group>`);
  return resource;
}

export const authorizeSchema = z.object({
  response_type: z.literal('code', 'response_type must be code'),
  client_id: z.string().min(1).max(100),
  redirect_uri: z.string().min(1).max(2000),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/, 'code_challenge must be a base64url S256 digest'),
  code_challenge_method: z.literal('S256', 'code_challenge_method must be S256 (PKCE plain is not accepted)'),
  state: z.string().max(1000).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(2000).optional(),
});
export type AuthorizeRequest = z.infer<typeof authorizeSchema>;

export interface ValidAuthorize {
  client: ClientRow;
  req: AuthorizeRequest;
  scopes: Scope[];
  resource: string | null;
}

/**
 * Validate an authorize request (query or consent body). The client and redirect_uri are checked
 * first, and before anything else is reported: a failure there must never produce a redirect, so
 * /oauth/authorize can tell "page" errors from the rest by `code`.
 */
export function validateAuthorize(db: Db, publicUrl: string, raw: Record<string, unknown>): ValidAuthorize {
  const clientId = typeof raw.client_id === 'string' ? raw.client_id : '';
  const client = clientId ? getClient(db, clientId) : undefined;
  if (!client || client.disabled) throw oauthError(400, 'invalid_client', 'unknown or disabled client_id');
  const redirectUri = typeof raw.redirect_uri === 'string' ? raw.redirect_uri : '';
  if (!redirectUri || !redirectUriRegistered(client, redirectUri)) {
    throw oauthError(400, 'invalid_redirect_uri', 'redirect_uri is not registered for this client');
  }
  const parsed = authorizeSchema.safeParse(raw);
  if (!parsed.success) throw oauthError(400, 'invalid_request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const scopes = parseScope(parsed.data.scope);
  const resource = checkResource(publicUrl, parsed.data.resource);
  return { client, req: parsed.data, scopes, resource };
}

/** Append query parameters to a redirect URI (its own query survives). */
export function withParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.href;
}

// ---------- codes ----------

/** Resolve consented group slugs to ids p can read (400 unknown_group, like mintKey); null = all. */
export function resolveGroupIds(db: Db, p: Principal, slugs: string[] | null): string[] | null {
  if (slugs === null) return null;
  const ids: string[] = [];
  for (const slug of slugs) {
    const g = db.prepare('SELECT id FROM scp_groups WHERE slug = ?').get(slug) as { id: string } | undefined;
    if (!g || !canReadGroup(db, p, g.id)) throw new HttpError(400, 'unknown_group', `unknown group: ${slug}`);
    if (!ids.includes(g.id)) ids.push(g.id);
  }
  if (ids.length === 0) throw new HttpError(400, 'unknown_group', 'pick at least one group, or allow all');
  return ids;
}

/** Store a one-shot code for the consented grant; returns the raw code for the redirect. */
export function issueCode(db: Db, v: ValidAuthorize, userId: string, scopes: Scope[], groupIds: string[] | null): string {
  const code = randomToken();
  const t = now();
  db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(t);
  db.prepare('UPDATE oauth_clients SET consented_at = COALESCE(consented_at, ?) WHERE id = ?').run(t, v.client.id);
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scopes, group_ids, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256Hex(code),
    v.client.id,
    userId,
    v.req.redirect_uri,
    v.req.code_challenge,
    v.req.code_challenge_method,
    JSON.stringify(scopes),
    groupIds && JSON.stringify(groupIds),
    v.resource,
    t,
    new Date(Date.now() + CODE_TTL_MS).toISOString(),
  );
  return code;
}

// ---------- tokens ----------

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  /** Absent for a client registered without the refresh_token grant (RFC 7591 grant_types). */
  refresh_token?: string;
  scope: string;
}

/** Whether the client registered for the refresh_token grant; one that did not gets access tokens alone and may not refresh. */
export const clientRefreshes = (client: ClientRow) => (JSON.parse(client.grant_types) as string[]).includes('refresh_token');

function insertToken(db: Db, kind: 'access' | 'refresh', src: Pick<TokenRow, 'client_id' | 'user_id' | 'grant_id' | 'scopes' | 'group_ids'>): string {
  const token = randomToken(kind === 'access' ? 'scp_at_' : 'scp_rt_');
  const ttl = kind === 'access' ? ACCESS_TTL_MS : REFRESH_TTL_MS;
  db.prepare(
    'INSERT INTO oauth_tokens (id, token_hash, kind, client_id, user_id, grant_id, scopes, group_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(newId(), sha256Hex(token), kind, src.client_id, src.user_id, src.grant_id, src.scopes, src.group_ids, now(), new Date(Date.now() + ttl).toISOString());
  return token;
}

export interface Issued {
  tokens: TokenPair;
  userId: string;
  grantId: string;
}

function mintPair(db: Db, src: Pick<TokenRow, 'client_id' | 'user_id' | 'grant_id' | 'scopes' | 'group_ids'>, refresh: boolean): Issued {
  const tokens: TokenPair = {
    access_token: insertToken(db, 'access', src),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_MS / 1000,
    ...(refresh ? { refresh_token: insertToken(db, 'refresh', src) } : {}),
    scope: (JSON.parse(src.scopes) as string[]).join(' '),
  };
  return { tokens, userId: src.user_id, grantId: src.grant_id };
}

export const revokeGrant = (db: Db, grantId: string) =>
  db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(now(), grantId).changes;

/** A user's codes awaiting exchange: redeemCode checks only the code, so a disable or reset must take them, or one minted a live grant afterwards. */
export const deleteUserCodes = (db: Db, userId: string) => db.prepare('DELETE FROM oauth_codes WHERE user_id = ?').run(userId).changes;

/** Every live grant of a user, codes awaiting exchange included; returns how many grants. The admin password reset: whoever held the account consented them. */
export function revokeUserGrants(db: Db, userId: string): number {
  deleteUserCodes(db, userId);
  const { n } = db.prepare('SELECT COUNT(DISTINCT grant_id) AS n FROM oauth_tokens WHERE user_id = ? AND revoked_at IS NULL').get(userId) as { n: number };
  if (n) db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), userId);
  return n;
}

/** Revoked rows stay this long so a rotated refresh token presented again still revokes its grant (refreshTokens). */
export const TOKEN_GRACE_MS = 86400_000;

/** Two range deletes, each on its own index (db.ts): one OR query scanned the table on every token request. */
export const SWEEP_TOKENS_SQL = ['DELETE FROM oauth_tokens WHERE expires_at <= ?', 'DELETE FROM oauth_tokens WHERE revoked_at <= ?'] as const;

/**
 * Drop expired rows and rows revoked over TOKEN_GRACE_MS ago. Every refresh leaves two dead rows
 * (the rotated pair), so without this the table only grows; mirrors issueCode's sweep of oauth_codes.
 */
export function sweepTokens(db: Db): void {
  const t = Date.now();
  db.prepare(SWEEP_TOKENS_SQL[0]).run(new Date(t).toISOString());
  db.prepare(SWEEP_TOKENS_SQL[1]).run(new Date(t - TOKEN_GRACE_MS).toISOString()); // NULL <= ? is not true: live rows stay
}

/** An anonymous registration nobody ever consented to is dropped after this long; its host re-registers through the usual 401 flow. */
export const CLIENT_GRACE_MS = 7 * 86400_000;

/**
 * The candidate rows come off the partial index oauth_clients_sweep (db.ts: created_at, WHERE created_by
 * IS NULL AND consented_at IS NULL, the same two terms spelled the same way), and each NOT EXISTS off the
 * client index of its table: this runs on every token request, and anonymous registration makes the
 * table attacker-sized (every row unsweepable for CLIENT_GRACE_MS), so a scan here was a per-request cost.
 */
export const SWEEP_CLIENTS_SQL = `DELETE FROM oauth_clients WHERE created_by IS NULL AND consented_at IS NULL AND created_at < ?
       AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = oauth_clients.id)
       AND NOT EXISTS (SELECT 1 FROM oauth_codes x WHERE x.client_id = oauth_clients.id)`;

/**
 * Drop anonymous (DCR) clients past CLIENT_GRACE_MS that nobody ever consented to, with no token and
 * no pending code: registration needs only a redirect URI, so without this the table grows by the
 * per-IP limit forever. A consented client stays however long its tokens have been gone: the host
 * keeps its client_id, and dropping it would send its next authorize to the invalid_client page
 * (the SDK re-registers only on invalid_client at the token endpoint, which an expired grant never
 * answers). Runs with sweepTokens on the token endpoint and on every registration.
 */
export function sweepClients(db: Db): void {
  db.prepare(SWEEP_CLIENTS_SQL).run(new Date(Date.now() - CLIENT_GRACE_MS).toISOString());
}

/** S256 check: the hash is always computed and compared in constant time, so timing says nothing about the verifier. */
function pkceOk(verifier: string, challenge: string): boolean {
  const digest = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  const wellFormed = /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
  const same = digest.length === expected.length && timingSafeEqual(digest, expected);
  return wellFormed && same;
}

/**
 * authorization_code grant. The code is consumed atomically (one-shot); a replay revokes every token
 * it ever produced (OAuth 2.1 4.1.3), which is why the grant id is the code's hash.
 */
export function redeemCode(db: Db, client: ClientRow, input: { code: string; redirect_uri?: string; code_verifier?: string; resource?: string }): Issued {
  const hash = sha256Hex(input.code);
  const invalid = (why: string) => oauthError(400, 'invalid_grant', why);
  // Synchronous end to end (no await), so nothing interleaves between the read and the writes; the
  // revocation on replay must commit, so it runs outside the issuing transaction that the throw ends.
  const code = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash) as CodeRow | undefined;
  if (!code) throw invalid('unknown authorization code');
  if (code.client_id !== client.id) throw invalid('authorization code was issued to another client');
  const proven = !!input.code_verifier && pkceOk(input.code_verifier, code.code_challenge);
  if (code.used_at) {
    // A second use revokes the grant only from a presenter who holds the PKCE verifier (the client's own
    // double submit): a spent code leaks easily (browser history, a Referer, proxy logs) and anyone could
    // otherwise take the victim's grant down with one request, so without the verifier it is a plain refusal.
    // Carried only when something was live to revoke: a replay against an already-revoked grant is nothing new to log.
    const revoked: RevokedGrant | undefined =
      proven && revokeGrant(db, hash) ? { revoked: { grantId: hash, userId: code.user_id, clientId: code.client_id, by: 'code_replay' } } : undefined;
    throw oauthError(400, 'invalid_grant', proven ? 'authorization code already used; its tokens are revoked' : 'authorization code already used', revoked);
  }
  if (code.expires_at <= now()) throw invalid('authorization code expired');
  // OAuth 2.1 drops redirect_uri from the token request (PKCE binds the code); when a client does send it, it must match.
  if (input.redirect_uri !== undefined && input.redirect_uri !== code.redirect_uri) throw invalid('redirect_uri does not match the authorization request');
  if (input.resource !== undefined && code.resource !== null && input.resource !== code.resource) throw oauthError(400, 'invalid_target', 'resource does not match the authorization request');
  if (!proven) throw invalid('code_verifier does not match code_challenge');
  return tx(db, () => {
    db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?').run(now(), hash);
    return mintPair(db, { client_id: client.id, user_id: code.user_id, grant_id: hash, scopes: code.scopes, group_ids: code.group_ids }, clientRefreshes(client));
  });
}

/**
 * A rotated refresh token presented again this soon after its rotation, while the grant still holds a
 * live one, is two refreshes in flight at access-token expiry (the MCP SDK does not serialize them),
 * not a theft: only the late call fails and the pair the first one issued survives. Past the window,
 * or once nothing live is left (a user or admin revoke), reuse revokes the whole grant.
 */
export const REFRESH_RACE_MS = 60_000;

/** refresh_token grant: rotation; a rotated (revoked) token presented again revokes the whole grant (REFRESH_RACE_MS excepted). */
export function refreshTokens(db: Db, client: ClientRow, refreshToken: string): Issued {
  const invalid = (why: string) => oauthError(400, 'invalid_grant', why);
  // RFC 6749 5.2: a client that did not register for this grant type (so was never issued a refresh token).
  if (!clientRefreshes(client)) throw oauthError(400, 'unauthorized_client', 'this client was not registered for the refresh_token grant');
  const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(sha256Hex(refreshToken)) as TokenRow | undefined;
  if (!row) throw invalid('unknown refresh token');
  if (row.client_id !== client.id) throw invalid('refresh token was issued to another client');
  if (row.revoked_at) {
    const raced =
      Date.now() - Date.parse(row.revoked_at) < REFRESH_RACE_MS &&
      db.prepare("SELECT 1 FROM oauth_tokens WHERE grant_id = ? AND kind = 'refresh' AND revoked_at IS NULL").get(row.grant_id);
    if (raced) throw invalid('refresh token already rotated; use the one issued in its place');
    // Outside the transaction below, so the throw does not undo it; audited by the caller only when something was live to revoke.
    const revoked: RevokedGrant | undefined = revokeGrant(db, row.grant_id) ? { revoked: { grantId: row.grant_id, userId: row.user_id, clientId: row.client_id, by: 'reuse' } } : undefined;
    throw oauthError(400, 'invalid_grant', 'refresh token reused; the grant is revoked', revoked);
  }
  if (row.expires_at <= now()) throw invalid('refresh token expired');
  const user = db.prepare('SELECT disabled FROM users WHERE id = ?').get(row.user_id) as { disabled: number } | undefined;
  if (!user || user.disabled) throw invalid('account disabled');
  return tx(db, () => {
    db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?').run(now(), row.id);
    return mintPair(db, row, true);
  });
}

/** RFC 7009: revoke the grant behind any token of `client` (or of any client when none is given). */
export function revokeByToken(db: Db, token: string, client: ClientRow | null): { grantId: string; userId: string; clientId: string } | null {
  const row = db.prepare('SELECT grant_id, client_id, user_id FROM oauth_tokens WHERE token_hash = ?').get(sha256Hex(token)) as
    | Pick<TokenRow, 'grant_id' | 'client_id' | 'user_id'>
    | undefined;
  if (!row || (client && row.client_id !== client.id)) return null;
  revokeGrant(db, row.grant_id);
  return { grantId: row.grant_id, userId: row.user_id, clientId: row.client_id };
}

// ---------- grants (account view) ----------

export interface GrantJson {
  grantId: string;
  client: { id: string; name: string };
  /** An admin disabled the client: its tokens are refused until it is enabled again (the grant itself stays). */
  clientDisabled: boolean;
  scopes: Scope[];
  groups: { id: string; slug: string }[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export function listGrants(db: Db, userId: string): GrantJson[] {
  const rows = db
    .prepare(
      `SELECT t.grant_id, t.client_id, c.name, c.disabled, t.scopes, t.group_ids, MIN(t.created_at) AS created_at, MAX(t.last_used_at) AS last_used_at, MAX(t.expires_at) AS expires_at
       FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
       WHERE t.user_id = ? AND t.revoked_at IS NULL AND t.expires_at > ?
       GROUP BY t.grant_id ORDER BY created_at DESC`,
    )
    .all(userId, now()) as unknown as { grant_id: string; client_id: string; name: string; disabled: number; scopes: string; group_ids: string | null; created_at: string; last_used_at: string | null; expires_at: string }[];
  return rows.map((r) => ({
    grantId: r.grant_id,
    client: { id: r.client_id, name: r.name },
    clientDisabled: !!r.disabled,
    scopes: normalizeScopes(JSON.parse(r.scopes) as string[]),
    groups: r.group_ids
      ? (db.prepare('SELECT id, slug FROM scp_groups WHERE id IN (SELECT value FROM json_each(?)) ORDER BY slug').all(r.group_ids) as unknown as { id: string; slug: string }[])
      : null,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }));
}

/** Admin view: one page of clients, newest first, each with its live grant count. Paged: anonymous registration makes the table attacker-sized. */
export function listClientsAdmin(db: Db, opts: { limit?: number; offset?: number } = {}): { clients: ReturnType<typeof adminClientJson>[]; total: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(DISTINCT t.grant_id) FROM oauth_tokens t WHERE t.client_id = c.id AND t.revoked_at IS NULL AND t.expires_at > ?) AS grants
       FROM oauth_clients c ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    )
    .all(now(), opts.limit ?? 50, opts.offset ?? 0) as unknown as (ClientRow & { grants: number })[];
  return { clients: rows.map((c) => adminClientJson(c, c.grants)), total };
}

export const adminClientJson = (c: ClientRow, grants: number) => ({
  id: c.id,
  name: c.name,
  redirectUris: JSON.parse(c.redirect_uris) as string[],
  authMethod: c.token_endpoint_auth_method,
  clientUri: c.client_uri,
  createdAt: c.created_at,
  disabled: !!c.disabled,
  grants,
});

export const liveGrantCount = (db: Db, clientId: string) =>
  (db.prepare('SELECT COUNT(DISTINCT grant_id) AS n FROM oauth_tokens WHERE client_id = ? AND revoked_at IS NULL AND expires_at > ?').get(clientId, now()) as { n: number }).n;
