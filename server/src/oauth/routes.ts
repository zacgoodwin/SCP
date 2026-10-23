import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { escapeHtml } from '../artifacts/render.ts';
import { audit } from '../audit.ts';
import { requireAccountUser, requireAdmin } from '../auth/middleware.ts';
import { normalizeScopes } from '../auth/service.ts';
import { listReadableGroups } from '../groups/service.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { HttpError, badRequest, clientIp, forbidden, notFound, parseJson, parseQuery } from '../lib/http.ts';
import { AUTH_LIMITS, take } from '../lib/ratelimit.ts';
import {
  AUTH_METHODS,
  adminClientJson,
  checkResource,
  clientJson,
  getClient,
  issueCode,
  listClientsAdmin,
  listGrants,
  liveGrantCount,
  oauthError,
  redeemCode,
  refreshTokens,
  registerClient,
  registerSchema,
  resolveGroupIds,
  revokeByToken,
  revokeGrant,
  sweepClients,
  sweepTokens,
  validateAuthorize,
  withParams,
  type ClientRow,
  type Issued,
  type RevokedGrant,
} from './service.ts';
import type { AppEnv, Principal } from '../types.ts';

const SCOPES = ['read', 'write'];

// ---------- app root: /.well-known/*, /oauth/* (no cookies; RFC 6749 JSON errors) ----------

/** D2 (docs/PLAN-v2.md): /oauth/* and /.well-known/* on the app root. No cookie auth here. */
export const oauthRoutes = new Hono<AppEnv>();

// Hono wraps every handler of a mounted sub-app with its own onError, so these endpoints answer in
// the RFC 6749 5.2 shape while /api/v1 keeps {error: {code, message}}.
oauthRoutes.onError((err, c) => {
  if (err instanceof HttpError) {
    // RFC 6749 5.2: a client that authenticated through the Authorization header gets a challenge in its scheme.
    if (err.status === 401 && /^Basic\s/i.test(c.req.header('authorization') ?? '')) c.header('WWW-Authenticate', 'Basic realm="oauth"');
    return c.json({ error: err.code === 'bad_request' ? 'invalid_request' : err.code, error_description: err.message }, err.status);
  }
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return c.json({ error: 'invalid_request', error_description: err.message }, status as ContentfulStatusCode);
  }
  console.error(err);
  return c.json({ error: 'server_error', error_description: 'internal error' }, 500);
});

// Browser-based MCP hosts fetch the metadata and the token endpoint cross-origin; none of these read
// cookies, so '*' is safe (same reasoning as mcp/routes.ts). /oauth/authorize is a navigation.
const open = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'mcp-protocol-version'] });
oauthRoutes.use('/.well-known/*', open);
for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke']) oauthRoutes.use(path, open);
// Outside /api/v1, so the app's pre-auth body cap does not apply; registration and token bodies are tiny.
oauthRoutes.use('/oauth/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'invalid_request', error_description: 'request body too large' }, 413) }));

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

oauthRoutes.get('/.well-known/oauth-authorization-server', (c) => {
  const u = c.var.ctx.config.publicUrl;
  return c.json({
    issuer: u,
    authorization_endpoint: `${u}/oauth/authorize`,
    token_endpoint: `${u}/oauth/token`,
    registration_endpoint: `${u}/oauth/register`,
    revocation_endpoint: `${u}/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
  });
});

const PRM_PATH = '/.well-known/oauth-protected-resource';

/**
 * RFC 9728. The document for /mcp/<slug> names that path as its `resource` (3.3: a client discards
 * metadata whose resource is not the identifier it was derived from); the 401 on /mcp/<slug>
 * points here (mcp/routes.ts). One token still covers every MCP path (checkResource).
 */
const protectedResource = (c: Context<AppEnv>) => {
  const u = c.var.ctx.config.publicUrl;
  return c.json({ resource: u + (c.req.path.slice(PRM_PATH.length) || '/mcp'), authorization_servers: [u], scopes_supported: SCOPES, bearer_methods_supported: ['header'] });
};
oauthRoutes.get(PRM_PATH, protectedResource);
oauthRoutes.get(`${PRM_PATH}/mcp`, protectedResource);
oauthRoutes.get(`${PRM_PATH}/mcp/:slug`, protectedResource);

// --- registration (RFC 7591), anonymous: 20 per hour per IP

export const REGISTER_LIMIT = { max: 20, windowMs: 3600_000 };
// Per app (keyed by its db) like the login limiter. ponytail: in-memory, per process.
const registerHits = new WeakMap<object, Map<string, { n: number; since: number }>>();

function limitRegistration(c: Context<AppEnv>): void {
  let m = registerHits.get(c.var.ctx.db);
  if (!m) registerHits.set(c.var.ctx.db, (m = new Map()));
  const ip = clientIp(c, c.var.ctx.config.trustProxy) ?? 'unknown';
  const t = Date.now();
  if (m.size > 10_000) {
    for (const [k, h] of m) if (t - h.since > REGISTER_LIMIT.windowMs) m.delete(k);
    if (m.size > 10_000) m.clear();
  }
  const h = m.get(ip);
  if (!h || t - h.since > REGISTER_LIMIT.windowMs) {
    m.set(ip, { n: 1, since: t });
    return;
  }
  if (++h.n > REGISTER_LIMIT.max) throw oauthError(429, 'rate_limited', 'too many client registrations from this address; try again in an hour');
}

oauthRoutes.post('/oauth/register', async (c) => {
  limitRegistration(c);
  const body = await parseJson(c, registerSchema);
  sweepClients(c.var.ctx.db); // the growth path pays for its own cleanup
  const { client, secret } = registerClient(c.var.ctx.db, body, null);
  audit(c, null, { action: 'oauth.client_register', targetType: 'oauth_client', targetId: client.id, detail: { name: client.name, authMethod: client.token_endpoint_auth_method } });
  return c.json(
    {
      ...clientJson(client),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
    },
    201,
    noStore,
  );
});

// --- authorize: validate, then hand the browser to the SPA consent page

const errorPage = (error: string, description: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorization failed</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
  `<h1>Authorization failed</h1><p><code>${escapeHtml(error)}</code>: ${escapeHtml(description)}</p>` +
  `<p>The application that sent you here has a configuration problem. Nothing was shared with it.</p></body></html>`;

oauthRoutes.get('/oauth/authorize', (c) => {
  const { db, config } = c.var.ctx;
  const q = c.req.query();
  c.header('Cache-Control', 'no-store');
  try {
    validateAuthorize(db, config.publicUrl, q);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    // RFC 6749 4.1.2.1: an unknown client or an unregistered redirect_uri is a page, never a redirect
    // (validateAuthorize checks those two first). Every other failure (PKCE, scope, resource) goes to
    // the registered redirect_uri as error=, or the host's pending flow waits for a code that never comes.
    // OpenGrep cannot see that check (it throws from validateAuthorize), hence the nosemgrep.
    if (e.code === 'invalid_client' || e.code === 'invalid_redirect_uri') return c.html(errorPage(e.code, e.message), 400, noStore);
    // nosemgrep: scp.open-redirect.request-input-in-redirect
    return c.redirect(withParams(q.redirect_uri, { error: e.code, error_description: e.message, state: q.state }), 302);
  }
  return c.redirect(`${config.publicUrl}/consent${new URL(c.req.url).search}`, 302);
});

// --- token (RFC 6749 4.1.3, 6) and revocation (RFC 7009)

/** Form-encoded or JSON body as flat strings. */
async function tokenBody(c: Context<AppEnv>): Promise<Record<string, string>> {
  if (/json/i.test(c.req.header('content-type') ?? '')) {
    const raw: unknown = await c.req.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw oauthError(400, 'invalid_request', 'body must be a JSON object');
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return Object.fromEntries(new URLSearchParams(await c.req.text()));
}

const formDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** client_secret_basic, client_secret_post, or none; confidential clients must present their secret. */
function authenticateClient(c: Context<AppEnv>, body: Record<string, string>): ClientRow {
  let id = body.client_id;
  let secret: string | undefined = body.client_secret;
  const h = c.req.header('authorization') ?? '';
  if (/^Basic\s+/i.test(h)) {
    const [user, ...rest] = Buffer.from(h.replace(/^Basic\s+/i, '').trim(), 'base64').toString().split(':');
    id = formDecode(user ?? '');
    secret = formDecode(rest.join(':'));
  }
  if (!id) throw oauthError(400, 'invalid_request', 'client_id is required');
  const client = getClient(c.var.ctx.db, id);
  if (!client) throw oauthError(401, 'invalid_client', 'unknown client');
  if (client.token_endpoint_auth_method !== 'none') {
    const ok = !!secret && !!client.secret_hash && timingSafeEqual(Buffer.from(sha256Hex(secret)), Buffer.from(client.secret_hash));
    if (!ok) throw oauthError(401, 'invalid_client', 'client authentication failed');
  }
  return client;
}

/** audit() reads userId and oauthClientId: the token holder is the user behind the grant, acting through the client. */
const grantActor = (userId: string, oauthClientId: string): Principal => ({ userId, username: '', isAdmin: false, via: 'oauth', oauthClientId, scopes: [], groupIds: null });

const tooManyTokenRequests = () => oauthError(429, 'rate_limited', 'too many token requests; try again in a few seconds');

oauthRoutes.post('/oauth/token', async (c) => {
  // Any client_id gets this far (a public client is just an id), and each call sweeps the token
  // table: one bucket per address before the body is read, one per client after it authenticated.
  if (!take(c, `oauthToken:ip:${clientIp(c, c.var.ctx.config.trustProxy) ?? 'unknown'}`, AUTH_LIMITS.oauthToken)) throw tooManyTokenRequests();
  const body = await tokenBody(c);
  const client = authenticateClient(c, body);
  if (!take(c, `oauthToken:client:${client.id}`, AUTH_LIMITS.oauthToken)) throw tooManyTokenRequests();
  // A disabled client is suspended, not unknown: on 401 invalid_client the MCP SDK discards its client id,
  // registers afresh through anonymous DCR and is back under a client the admin never disabled after one
  // re-consent. invalid_grant makes it drop its tokens and re-authorize with the same client id, which
  // lands on the "unknown or disabled client_id" page (validateAuthorize) until the admin enables it again.
  if (client.disabled) throw oauthError(400, 'invalid_grant', 'this client is disabled by an administrator');
  const { db, config } = c.var.ctx;
  sweepTokens(db);
  sweepClients(db);
  let issued: Issued;
  try {
    if (body.grant_type === 'authorization_code') {
      if (!body.code) throw oauthError(400, 'invalid_request', 'code is required');
      checkResource(config.publicUrl, body.resource);
      issued = redeemCode(db, client, body as { code: string; redirect_uri?: string; code_verifier?: string; resource?: string });
    } else if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) throw oauthError(400, 'invalid_request', 'refresh_token is required');
      issued = refreshTokens(db, client, body.refresh_token);
    } else {
      throw oauthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
  } catch (e) {
    // A replayed code or a reused refresh token revoked the grant (service.ts): the user's Connected
    // apps entry just vanished, so the log is the only place a stolen-token detection leaves a trace.
    const r = e instanceof HttpError ? (e.details as Partial<RevokedGrant> | undefined)?.revoked : undefined;
    if (r) audit(c, grantActor(r.userId, r.clientId), { action: 'oauth.revoke', targetType: 'oauth_grant', targetId: r.grantId, detail: { by: r.by } });
    throw e;
  }
  audit(c, grantActor(issued.userId, client.id), { action: 'oauth.token', targetType: 'oauth_grant', targetId: issued.grantId, detail: { grant: body.grant_type } });
  return c.json(issued.tokens, 200, noStore);
});

oauthRoutes.post('/oauth/revoke', async (c) => {
  const body = await tokenBody(c);
  if (!body.token) throw oauthError(400, 'invalid_request', 'token is required');
  // A client that identifies itself must own the token; an anonymous call revokes whatever it holds.
  const client = body.client_id || /^Basic\s/i.test(c.req.header('authorization') ?? '') ? authenticateClient(c, body) : null;
  const r = revokeByToken(c.var.ctx.db, body.token, client);
  // The actor is the token's own client (the grant's app), also when the call named no client.
  if (r) audit(c, grantActor(r.userId, r.clientId), { action: 'oauth.revoke', targetType: 'oauth_grant', targetId: r.grantId, detail: { by: 'client' } });
  return c.json({}, 200, noStore); // RFC 7009 2.2: 200 whether or not the token was known
});

// ---------- /api/v1: consent, grants, admin clients (browser session only) ----------

/** D2: consent, grants and admin client management under /api/v1 (session principal). */
export const oauthApiRoutes = new Hono<AppEnv>();

const requireSession = (c: Context<AppEnv>): Principal => {
  const p = requireAccountUser(c);
  if (p.via !== 'session') throw forbidden('OAuth consent and grants require a browser session, not an API key');
  return p;
};

const requireAdminSession = (c: Context<AppEnv>): Principal => {
  const p = requireAdmin(c);
  if (p.via !== 'session') throw forbidden('OAuth client management requires a browser session, not an API key');
  return p;
};

/**
 * The principal the token will act as (tokens.ts: never admin), so an admin is offered, and may pick,
 * only what a plain user with the account reads: a grant restricted to another user's private group
 * would otherwise be issued and read nothing.
 */
const asTokenHolder = (p: Principal): Principal => ({ ...p, isAdmin: false });

oauthApiRoutes.get('/oauth/consent', (c) => {
  const p = requireSession(c);
  const { db, config } = c.var.ctx;
  const v = validateAuthorize(db, config.publicUrl, c.req.query());
  // Where the browser goes next: the host, or for a private-use scheme without an authority
  // (`com.example.app:/oauth`, RFC 8252) the scheme itself, which is the app's name.
  const to = new URL(v.req.redirect_uri);
  return c.json({
    client: { id: v.client.id, name: v.client.name, clientUri: v.client.client_uri, logoUri: v.client.logo_uri },
    scopes: v.scopes,
    groups: listReadableGroups(db, asTokenHolder(p), { limit: 200 }).groups,
    redirectHost: to.host || to.protocol.replace(/:$/, ''),
  });
});

const consentSchema = z.looseObject({
  approve: z.boolean(),
  scopes: z.array(z.enum(['read', 'write'])).optional(),
  groups: z.array(z.string().min(1).max(100)).max(200).nullable().default(null),
});

oauthApiRoutes.post('/oauth/consent', async (c) => {
  const p = requireSession(c);
  const { db, config } = c.var.ctx;
  const body = await parseJson(c, consentSchema);
  const v = validateAuthorize(db, config.publicUrl, body);
  if (!body.approve) {
    audit(c, p, { action: 'oauth.consent', targetType: 'oauth_client', targetId: v.client.id, detail: { approved: false } });
    return c.json({ redirect: withParams(v.req.redirect_uri, { error: 'access_denied', error_description: 'the user denied the request', state: v.req.state }) });
  }
  const scopes = body.scopes ? normalizeScopes(body.scopes) : v.scopes;
  if (scopes.length === 0 || scopes.some((s) => !v.scopes.includes(s))) throw badRequest('granted scopes must be a non-empty subset of the requested scopes');
  const groupIds = resolveGroupIds(db, asTokenHolder(p), body.groups);
  const code = issueCode(db, v, p.userId, scopes, groupIds);
  audit(c, p, { action: 'oauth.consent', targetType: 'oauth_client', targetId: v.client.id, detail: { approved: true, scopes, groupIds } });
  return c.json({ redirect: withParams(v.req.redirect_uri, { code, state: v.req.state }) });
});

oauthApiRoutes.get('/oauth/grants', (c) => {
  const p = requireSession(c);
  return c.json({ grants: listGrants(c.var.ctx.db, p.userId) });
});

oauthApiRoutes.delete('/oauth/grants/:grantId', (c) => {
  const p = requireSession(c);
  const { db } = c.var.ctx;
  const grantId = c.req.param('grantId');
  if (!db.prepare('SELECT 1 FROM oauth_tokens WHERE grant_id = ? AND user_id = ?').get(grantId, p.userId)) throw notFound('grant');
  revokeGrant(db, grantId);
  audit(c, p, { action: 'oauth.revoke', targetType: 'oauth_grant', targetId: grantId, detail: { by: 'user' } });
  return c.body(null, 204);
});

const clientsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

oauthApiRoutes.get('/oauth/clients', (c) => {
  requireAdminSession(c);
  return c.json(listClientsAdmin(c.var.ctx.db, parseQuery(c, clientsQuery)));
});

oauthApiRoutes.patch('/oauth/clients/:id', async (c) => {
  const p = requireAdminSession(c);
  const body = await parseJson(c, z.object({ disabled: z.boolean() }));
  const { db } = c.var.ctx;
  const client = getClient(db, c.req.param('id'));
  if (!client) throw notFound('client');
  db.prepare('UPDATE oauth_clients SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, client.id);
  audit(c, p, { action: 'oauth.client_update', targetType: 'oauth_client', targetId: client.id, detail: { disabled: body.disabled } });
  return c.json({ client: adminClientJson(getClient(db, client.id)!, liveGrantCount(db, client.id)) });
});
