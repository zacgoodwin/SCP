import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { randomToken, sha256Hex, signPayload, verifyPayload } from '../lib/crypto.ts';
import { HttpError, notFound, parseJson, parseQuery } from '../lib/http.ts';
import { limitIp } from '../lib/ratelimit.ts';
import { THEME_CSS, escapeHtml } from '../artifacts/render.ts';
import { OIDC_DEFAULT_LABEL } from '../config.ts';
import { isUniqueViolation, newId, now, tx, type Db } from '../db.ts';
import { audit } from '../audit.ts';
import { SESSION_COOKIE } from './middleware.ts';
import { SESSION_TTL_MS, createSession, deleteExpiredSessions, getUser, sessionPrincipal, usernameSchema } from './service.ts';
import type { AppEnv, Ctx, UserRow } from '../types.ts';

/** D3 (docs/PLAN-v2.md): /auth/oidc/start and /auth/oidc/callback, mounted under /api/v1. */
export const oidcRoutes = new Hono<AppEnv>();

const STATE_COOKIE = 'scp_oidc';
const STATE_TTL_S = 600;
const DISCOVERY_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_S = 300;
/** OIDC-only accounts: never a valid scrypt string, so verifyPassword (and so password login) always fails. */
export const OIDC_PASSWORD_HASH = '!oidc';

// ---------- effective config: env, else settings row, else default ----------

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  autoRegister: boolean;
  label: string;
}

/** A settings row; '' counts as unset (the admin UI clears a value by writing ''). */
const readSetting = (db: Db, key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value || null;

/** The OIDC login config in force, or null when issuer, client id or secret is missing. */
export function effectiveOidc(ctx: Ctx): OidcConfig | null {
  const { db } = ctx;
  const env = ctx.config.oidc;
  const issuer = (env.issuer ?? readSetting(db, 'oidc.issuer'))?.replace(/\/+$/, '');
  const clientId = env.clientId ?? readSetting(db, 'oidc.client_id');
  const clientSecret = env.clientSecret ?? readSetting(db, 'oidc.client_secret');
  if (!issuer || !clientId || !clientSecret) return null;
  const autoRegister = env.autoRegister ?? (readSetting(db, 'oidc.auto_register') !== 'false');
  const label = env.label ?? readSetting(db, 'oidc.label') ?? OIDC_DEFAULT_LABEL;
  return { issuer, clientId, clientSecret, autoRegister, label };
}

/** What the login page needs: whether OIDC is configured and the button label. */
export function oidcPublicConfig(ctx: Ctx): { enabled: boolean; label: string } {
  const c = effectiveOidc(ctx);
  return c ? { enabled: true, label: c.label } : { enabled: false, label: '' };
}

// ---------- discovery + JWKS (cached per issuer) ----------

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  /** OIDC Discovery 1.0 3: absent means client_secret_basic. */
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});
type Discovery = z.infer<typeof discoverySchema>;

const jwkSchema = z.object({ kid: z.string().optional(), kty: z.string(), alg: z.string().optional(), use: z.string().optional() }).passthrough();
const jwksSchema = z.object({ keys: z.array(jwkSchema) });
type Jwk = z.infer<typeof jwkSchema>;

interface IssuerCache {
  at: number;
  discovery: Discovery;
  jwks: Jwk[];
}
const issuerCache = new Map<string, IssuerCache>();
/** Tests swap IdPs under one issuer URL. */
export const clearOidcCache = () => issuerCache.clear();

const idpError = (message: string) => new HttpError(502, 'idp_error', message);

/** Loopback, private, link-local and unspecified ranges; an IPv4-mapped IPv6 address matches its IPv4 rule. */
const INTERNAL = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) {
  INTERNAL.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) INTERNAL.addSubnet(net, prefix, 'ipv6');

function internalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v = isIP(h);
  return v !== 0 && INTERNAL.check(h, v === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Why SCP will not contact `url` for the IdP at `issuer`, or null. Discovery is remote input, so the
 * guard is on what the server fetches: the token endpoint and JWKS may sit on another public https
 * host (Google serves them from oauth2.googleapis.com and www.googleapis.com; Cognito likewise) but
 * not on plain http or an internal address, unless the issuer itself is there (a local or test IdP).
 * ponytail: hostnames are not resolved, so an internal service behind a public DNS name is not caught.
 */
export function endpointProblem(issuer: string, url: string): string | null {
  const i = new URL(issuer);
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && i.protocol === 'http:')) return `${url} is not https`;
  if (internalHost(u.hostname) && !internalHost(i.hostname)) return `${url} is an internal address`;
  return null;
}

const refuseEndpoint = (why: string) => idpError(`the identity provider advertised an endpoint SCP will not contact: ${why}`);

/** GET json from the IdP, from a URL endpointProblem allows (SSRF: discovery is remote input). */
async function fetchIdp(issuer: string, url: string, init: RequestInit = {}): Promise<unknown> {
  const why = endpointProblem(issuer, url);
  if (why) throw refuseEndpoint(why);
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw idpError('the identity provider did not respond');
  }
  if (!res.ok) throw idpError(`the identity provider answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw idpError('the identity provider sent an unreadable answer');
  }
}

async function loadIssuer(cfg: OidcConfig, force = false): Promise<IssuerCache> {
  const hit = issuerCache.get(cfg.issuer);
  if (hit && !force && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit;
  const d = discoverySchema.safeParse(await fetchIdp(cfg.issuer, `${cfg.issuer}/.well-known/openid-configuration`));
  if (!d.success) throw idpError('the identity provider discovery document is invalid');
  if (d.data.issuer.replace(/\/+$/, '') !== cfg.issuer) throw idpError('the identity provider discovery document names a different issuer');
  // Checked here, at /start, so a bad token endpoint fails before the user is sent to the IdP; fetchIdp
  // repeats it. The authorization endpoint is a browser redirect, so only its scheme matters.
  for (const ep of [d.data.token_endpoint, d.data.jwks_uri]) {
    const why = endpointProblem(cfg.issuer, ep);
    if (why) throw refuseEndpoint(why);
  }
  if (!/^https?:$/.test(new URL(d.data.authorization_endpoint).protocol)) throw refuseEndpoint(`${d.data.authorization_endpoint} is not http(s)`);
  const jwks = jwksSchema.safeParse(await fetchIdp(cfg.issuer, d.data.jwks_uri));
  if (!jwks.success) throw idpError('the identity provider JWKS is invalid');
  const entry = { at: Date.now(), discovery: d.data, jwks: jwks.data.keys };
  issuerCache.set(cfg.issuer, entry);
  return entry;
}

// ---------- id_token ----------

const ALGS: Record<string, { kty: string; dsaEncoding?: 'ieee-p1363' }> = {
  RS256: { kty: 'RSA' },
  ES256: { kty: 'EC', dsaEncoding: 'ieee-p1363' },
};

const claimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1).max(255),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  preferred_username: z.string().optional(),
});
export type IdClaims = z.infer<typeof claimsSchema>;

const b64json = (s: string): unknown => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString());
  } catch {
    return undefined;
  }
};

const badToken = (why: string) => new HttpError(403, 'invalid_id_token', `the identity provider sent an unacceptable id_token (${why})`);

function pickKey(jwks: Jwk[], alg: string, kid: string | undefined): KeyObject | null {
  const want = ALGS[alg].kty;
  const candidates = jwks.filter((k) => k.kty === want && (!k.alg || k.alg === alg) && (!k.use || k.use === 'sig'));
  const jwk = kid !== undefined ? candidates.find((k) => k.kid === kid) : candidates.length === 1 ? candidates[0] : undefined;
  if (!jwk) return null;
  try {
    return createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
  } catch {
    return null;
  }
}

/** Signature (RS256/ES256 from the JWKS, by kid), iss, aud (+azp), exp/iat within the skew, nonce. */
export async function verifyIdToken(cfg: OidcConfig, token: string, nonce: string): Promise<IdClaims> {
  const [h, p, s, extra] = token.split('.');
  if (!h || !p || !s || extra !== undefined) throw badToken('not a compact JWS');
  const header = z.object({ alg: z.string(), kid: z.string().optional() }).safeParse(b64json(h));
  if (!header.success) throw badToken('bad header');
  const { alg, kid } = header.data;
  if (!ALGS[alg]) throw badToken(`unsupported alg ${alg}`);
  let cache = await loadIssuer(cfg);
  let key = pickKey(cache.jwks, alg, kid);
  if (!key) {
    // Key rotation: an unknown kid refetches the JWKS once.
    cache = await loadIssuer(cfg, true);
    key = pickKey(cache.jwks, alg, kid);
  }
  if (!key) throw badToken('unknown signing key');
  const ok = verifySignature('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: ALGS[alg].dsaEncoding }, Buffer.from(s, 'base64url'));
  if (!ok) throw badToken('bad signature');
  const claims = claimsSchema.safeParse(b64json(p));
  if (!claims.success) throw badToken('bad claims');
  const c = claims.data;
  if (c.iss.replace(/\/+$/, '') !== cfg.issuer) throw badToken('wrong issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(cfg.clientId) || (aud.length > 1 && c.azp !== cfg.clientId)) throw badToken('wrong audience');
  const t = Math.floor(Date.now() / 1000);
  if (c.exp <= t - CLOCK_SKEW_S) throw badToken('expired');
  if (Math.abs(c.iat - t) > CLOCK_SKEW_S) throw badToken('issued outside the clock skew');
  if (c.nonce !== nonce) throw badToken('nonce mismatch');
  return c;
}

// ---------- user resolution ----------

/** usernameSchema-shaped base from a claim: lowercase, runs of other characters become '-', 2..32 chars. */
export function usernameBase(raw: string): string {
  const s = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 32);
  return s.length >= 2 ? s : s ? `${s}0` : 'user';
}

const noAccount = (why: string) => new HttpError(403, 'no_account', why);

const link = (db: Db, cfg: OidcConfig, claims: IdClaims, userId: string) => {
  db.prepare('UPDATE users SET oidc_issuer = ?, oidc_sub = ? WHERE id = ?').run(cfg.issuer, claims.sub, userId);
  return { user: getUser(db, userId)!, created: false, linked: true };
};

/**
 * The user for a verified identity. With `linkUserId` (a signed-in user linking from their account
 * menu): that user, linked to the identity. Else by (issuer, sub); else by verified email, linked
 * only when the account has no password (nobody else can hold it); else auto-register when enabled,
 * with -2/-3 suffixing on a username clash. 403 otherwise.
 */
export function resolveOidcUser(c: Context<AppEnv>, cfg: OidcConfig, claims: IdClaims, linkUserId?: string): { user: UserRow; created: boolean; linked: boolean } {
  const { db } = c.var.ctx;
  const bySub = db.prepare('SELECT * FROM users WHERE oidc_issuer = ? AND oidc_sub = ?').get(cfg.issuer, claims.sub) as UserRow | undefined;
  if (linkUserId !== undefined) {
    const me = getUser(db, linkUserId);
    if (!me) throw noAccount('the account to link no longer exists');
    if (bySub) {
      if (bySub.id === me.id) return { user: bySub, created: false, linked: false };
      throw noAccount('this identity is already linked to another account');
    }
    // A link survives an issuer URL change (realm rename, http -> https) as a stale (issuer, sub); say so.
    if (me.oidc_sub) throw noAccount('your account is already linked to a different identity, or to this provider under a previous issuer URL; unlink it first');
    return link(db, cfg, claims, me.id);
  }
  if (bySub) return { user: bySub, created: false, linked: false };
  const email = claims.email?.trim() || null;
  const verifiedEmail = email && claims.email_verified === true ? email : null;
  if (verifiedEmail) {
    const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(verifiedEmail) as UserRow | undefined;
    if (byEmail) {
      if (byEmail.oidc_sub) {
        throw noAccount('this email belongs to an account linked to a different identity, or to this provider under a previous issuer URL; an admin can unlink it');
      }
      // An unauthenticated callback must not take over a password account: anyone may have registered
      // this email first and kept the password (and keys). Only a signed-in session links one
      // (linkUserId above). An account with no password has no other holder, so it links here.
      if (byEmail.password_hash !== OIDC_PASSWORD_HASH) {
        throw noAccount('an account with this email already exists; sign in with your password and link single sign-on from your account menu');
      }
      return link(db, cfg, claims, byEmail.id);
    }
  }
  if (!cfg.autoRegister) throw noAccount('no SCP account is linked to this identity; ask an admin to create one');
  // Registration needs an email; an IdP that says it is unverified does not get to pick one.
  if (!email || claims.email_verified === false) throw noAccount('the identity provider sent no usable email address');
  const base = usernameBase(claims.preferred_username?.trim() || email.split('@')[0]);
  const user = tx(db, () => {
    for (let n = 1; n <= 50; n++) {
      const suffix = n === 1 ? '' : `-${n}`;
      const username = usernameSchema.safeParse(base.slice(0, 32 - suffix.length) + suffix);
      if (!username.success) break;
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.data)) continue;
      const id = newId();
      try {
        db.prepare(
          'INSERT INTO users (id, email, username, password_hash, is_admin, disabled, created_at, oidc_issuer, oidc_sub) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)',
        ).run(id, email, username.data, OIDC_PASSWORD_HASH, now(), cfg.issuer, claims.sub);
      } catch (e) {
        if (isUniqueViolation(e)) break; // the email is taken (unverified, or linked elsewhere)
        throw e;
      }
      return getUser(db, id)!;
    }
    throw noAccount('an account with this email or username already exists; ask an admin to link it');
  });
  return { user, created: true, linked: false };
}

// ---------- routes ----------

interface StateCookie {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
  /** Set by POST /link: the signed-in user the callback links the identity to, and the hash of the session that asked. */
  userId?: string;
  sid?: string;
}

/**
 * Only same-app paths, normalized by the URL parser (mirrors web/src/auth.tsx safeNext): a prefix
 * check alone lets `/\evil.com`, `/\/evil.com` and `/<TAB>/evil.com` through, which browsers resolve
 * to another host. The parsed path is returned, never the raw string. A parsed pathname that itself
 * starts with `//` (`/..//evil.com`, `/.//evil.com`: dot segments collapse to a scheme-relative URL)
 * is refused too, since the browser resolves a `//host` Location to that host.
 */
export function safeNext(next: string | undefined, publicUrl: string): string {
  // Longer rides in the signed state cookie past the 4 KB browsers keep, which would end the sign-in at
  // the callback (bad_state) instead: the dashboard is the fallback, never a refusal.
  if (!next || !next.startsWith('/') || next.length > NEXT_MAX) return '/';
  try {
    const u = new URL(next, publicUrl);
    return u.origin === new URL(publicUrl).origin && !u.pathname.startsWith('//') ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

/** `next` as long as the state cookie can carry; an OAuth consent URL (oauth/service.ts authorizeSchema) can run past it. */
export const NEXT_MAX = 2000;
// What a query or JSON body may carry: a consent URL at every authorizeSchema cap, with room to spare.
const nextSchema = z.string().max(8192).optional();

const s256 = (s: string) => createHash('sha256').update(s).digest('base64url');

function requireOidc(c: Context<AppEnv>): OidcConfig {
  const cfg = effectiveOidc(c.var.ctx);
  if (!cfg) throw notFound('route');
  return cfg;
}

const redirectUri = (c: Context<AppEnv>) => `${c.var.ctx.config.publicUrl}/api/v1/auth/oidc/callback`;

/** Small HTML page for a failed sign-in: the reason, never a stack. */
function errorPage(c: Context<AppEnv>, err: unknown) {
  const known = err instanceof HttpError;
  if (!known) console.error(err);
  const status = known ? err.status : 500;
  const message = known ? err.message : 'sign-in failed';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in failed</title><style>${THEME_CSS}main{max-width:560px;margin:15vh auto;padding:0 16px;text-align:center}h1{font-size:1.25rem}p{color:var(--muted)}</style></head>
<body><main><h1>Sign-in failed</h1><p>${escapeHtml(message)}</p><p><a href="/login">Back to sign in</a></p></main></body></html>`;
  return c.html(html, status, {
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
}

/** Begin the code flow: the signed state cookie (PKCE verifier, nonce, next, the user and session to link) and the IdP URL for the browser. */
async function beginSignIn(c: Context<AppEnv>, cfg: OidcConfig, next: string | undefined, link?: { userId: string; sid: string }): Promise<string> {
  const { discovery } = await loadIssuer(cfg);
  const payload: StateCookie = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomBytes(32).toString('base64url'),
    next: safeNext(next, c.var.ctx.config.publicUrl),
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_S,
    ...link,
  };
  setCookie(c, STATE_COOKIE, signPayload(c.var.ctx.secret, payload), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/api/v1/auth/oidc',
    maxAge: STATE_TTL_S,
    secure: c.var.ctx.config.secureCookies,
  });
  const url = new URL(discovery.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri(c),
    scope: 'openid email profile',
    state: payload.state,
    nonce: payload.nonce,
    code_challenge: s256(payload.verifier),
    code_challenge_method: 'S256',
  })) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

// Both anonymous routes take from the per-IP bucket login and register use: each costs an outbound
// call (the callback one carries the client secret), so a loop would throttle the IdP client for everyone.
oidcRoutes.get('/auth/oidc/start', async (c) => {
  const cfg = requireOidc(c);
  // Inside the try: this is a top-level navigation, so every failure is the page, never the API's JSON.
  try {
    const { next } = parseQuery(c, z.object({ next: nextSchema }));
    limitIp(c);
    return c.redirect(await beginSignIn(c, cfg, next), 302);
  } catch (e) {
    return errorPage(c, e);
  }
});

/**
 * Linking starts from a POST, never a GET: the Lax session cookie rides along on any top-level GET a
 * page can navigate the user to, and csrfForCookies (app.ts) checks the Origin of posts only. The
 * browser session is the proof that the caller owns the account; the SPA follows the returned URL.
 */
oidcRoutes.post('/auth/oidc/link', async (c) => {
  const cfg = requireOidc(c);
  const p = c.var.principal;
  if (!p || p.via !== 'session') throw new HttpError(401, 'unauthorized', 'sign in first to link single sign-on to your account');
  const { next } = await parseJson(c, z.object({ next: nextSchema }));
  return c.json({ url: await beginSignIn(c, cfg, next, { userId: p.userId, sid: sha256Hex(getCookie(c, SESSION_COOKIE) ?? '') }) });
});

/**
 * Drop the signed-in account's single sign-on link (the identity, or the issuer URL, changed). Works
 * with OIDC unconfigured too. Refused for an OIDC-only account: with no password it would be unreachable.
 */
oidcRoutes.post('/auth/oidc/unlink', (c) => {
  const p = c.var.principal;
  if (!p || p.via !== 'session') throw new HttpError(401, 'unauthorized', 'sign in first to unlink single sign-on from your account');
  const { db } = c.var.ctx;
  const me = getUser(db, p.userId)!;
  if (!me.oidc_sub) throw new HttpError(409, 'not_linked', 'this account is not linked to single sign-on');
  if (me.password_hash === OIDC_PASSWORD_HASH) throw new HttpError(409, 'no_password', 'this account has no password; ask an admin to set one before unlinking single sign-on');
  db.prepare('UPDATE users SET oidc_issuer = NULL, oidc_sub = NULL WHERE id = ?').run(me.id);
  audit(c, p, { action: 'user.oidc_unlink', targetType: 'user', targetId: me.id });
  return c.body(null, 204);
});

const callbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

oidcRoutes.get('/auth/oidc/callback', async (c) => {
  const cfg = requireOidc(c);
  const { db, config, secret } = c.var.ctx;
  const raw = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/api/v1/auth/oidc' });
  try {
    limitIp(c);
    const q = parseQuery(c, callbackQuery);
    const st = raw ? verifyPayload<StateCookie>(secret, raw) : null;
    if (!st || !q.state || st.state !== q.state) throw new HttpError(400, 'bad_state', 'the sign-in attempt expired or did not start here; try again');
    if (q.error) throw new HttpError(403, 'idp_denied', `the identity provider refused the sign-in (${q.error})`);
    if (!q.code) throw new HttpError(400, 'bad_request', 'the identity provider sent no code');
    // Link mode is bound to the browser session that started it: an admin reset (account recovery)
    // deletes the user's sessions, so a link begun before the reset must not complete after it.
    if (st.userId !== undefined && !db.prepare('SELECT 1 FROM sessions WHERE id_hash = ? AND user_id = ? AND expires_at > ?').get(st.sid ?? '', st.userId, now())) {
      throw noAccount('the session that started this link has ended; sign in and link again');
    }

    const { discovery } = await loadIssuer(cfg);
    // RFC 6749 2.3.1: HTTP Basic is the method every server must support and the OIDC Discovery
    // default when the list is absent; credentials go in the body only when the IdP lists
    // client_secret_post and not client_secret_basic. One method per request, never both.
    const methods = discovery.token_endpoint_auth_methods_supported;
    const inBody = !!methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: q.code,
      redirect_uri: redirectUri(c),
      client_id: cfg.clientId,
      ...(inBody ? { client_secret: cfg.clientSecret } : {}),
      code_verifier: st.verifier,
    });
    const basic = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')}`;
    const tokens = z.object({ id_token: z.string() }).safeParse(
      await fetchIdp(cfg.issuer, discovery.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(inBody ? {} : { authorization: basic }) },
        body,
      }),
    );
    if (!tokens.success) throw idpError('the identity provider sent no id_token');
    const claims = await verifyIdToken(cfg, tokens.data.id_token, st.nonce);

    const { user, created, linked } = resolveOidcUser(c, cfg, claims, st.userId);
    if (user.disabled) throw noAccount('this account is disabled');
    const p = sessionPrincipal(user);
    if (created) audit(c, p, { action: 'user.register', targetType: 'user', targetId: user.id, detail: { via: 'oidc' } });
    if (linked) audit(c, p, { action: 'user.oidc_link', targetType: 'user', targetId: user.id });

    // Exactly the cookie /auth/login sets (auth/routes.ts startSession).
    deleteExpiredSessions(db);
    const { sid } = createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
      secure: config.secureCookies,
    });
    audit(c, p, { action: 'login', detail: { via: 'oidc' } });
    return c.redirect(st.next, 302);
  } catch (e) {
    return errorPage(c, e);
  }
});
