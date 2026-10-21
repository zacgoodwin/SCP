import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { makeTestCtx, type TestCtx, type TestUser } from './helpers.ts';
import { AUTH_LIMITS } from '../src/lib/ratelimit.ts';
import { REGISTER_LIMIT } from '../src/oauth/routes.ts';
import { CLIENT_GRACE_MS, REFRESH_RACE_MS, SWEEP_CLIENTS_SQL, SWEEP_TOKENS_SQL } from '../src/oauth/service.ts';

const API = '/api/v1';
type H = Record<string, string>;
interface TokenRes {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}
interface ClientRes {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
}

const REDIRECT = 'https://client.example/cb';
const SKILL_MD = '---\nname: pdf\ndescription: Extract tables from PDF files.\n---\n# PDF\n';

async function fixture() {
  // trustProxy so each registration can come from its own "address" (the DCR limit is per IP).
  const t = makeTestCtx({ SCP_TRUST_PROXY: 'true' });
  const alice = t.createUser({ username: 'alice' });
  const bob = t.createUser({ username: 'bob' });
  const admin = t.createUser({ username: 'root', isAdmin: true });
  const h = t.session(alice);
  const skill = await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'skill', files: [{ path: 'SKILL.md', content: SKILL_MD }] } });
  assert.equal(skill.status, 201, skill.text);
  const kit = await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'kit', name: 'Kit' } });
  assert.equal(kit.status, 201, kit.text);
  assert.equal((await t.req('POST', `${API}/groups/kit/members`, { headers: h, json: { itemId: skill.json.item.id } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'other', name: 'Other' } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups`, { headers: t.session(bob), json: { slug: 'secret', name: 'Secret' } })).status, 201);
  return { t, alice, bob, admin, kitId: kit.json.group.id as string };
}

const f = await fixture();

let ipN = 0;
/** A fresh client address: registration and the token endpoint are limited per IP. */
const nextIp = () => `10.0.${Math.floor(++ipN / 200)}.${ipN % 200}`;
const register = (t: TestCtx, body: unknown = { redirect_uris: [REDIRECT], client_name: 'Test app' }, headers: H = {}) =>
  t.req('POST', '/oauth/register', { headers: { 'X-Forwarded-For': nextIp(), ...headers }, json: body });

async function newClient(body?: object): Promise<ClientRes> {
  const r = await register(f.t, body);
  assert.equal(r.status, 201, r.text);
  return r.json as ClientRes;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const authQuery = (clientId: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'st-1',
  ...extra,
});
const qs = (q: Record<string, string>) => '?' + new URLSearchParams(q).toString();

/** Browser + SPA half of the flow: /oauth/authorize -> /consent -> POST consent -> the client redirect. */
async function consent(user: TestUser, q: Record<string, string>, body: object = { approve: true }): Promise<URL> {
  const a = await f.t.req('GET', '/oauth/authorize' + qs(q));
  assert.equal(a.status, 302, a.text);
  const loc = a.headers.get('location')!;
  assert.ok(loc.startsWith('http://app.test/consent?'), loc);
  const query = Object.fromEntries(new URL(loc).searchParams);
  const r = await f.t.req('POST', `${API}/oauth/consent`, { headers: f.t.session(user), json: { ...query, ...body } });
  assert.equal(r.status, 200, r.text);
  return new URL(r.json.redirect as string);
}

const tokenPost = (body: Record<string, string>, headers: H = {}, t: TestCtx = f.t) =>
  t.req('POST', '/oauth/token', { headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': nextIp(), ...headers }, body: new URLSearchParams(body).toString() });

/** The whole dance for `user` (public client unless given); returns the token response. */
async function grant(user: TestUser, opts: { scopes?: string[]; groups?: string[] | null; scope?: string; client?: ClientRes } = {}) {
  const client = opts.client ?? (await newClient());
  const { verifier, challenge } = pkce();
  const redirect = await consent(user, authQuery(client.client_id, challenge, opts.scope ? { scope: opts.scope } : {}), {
    approve: true,
    scopes: opts.scopes,
    groups: opts.groups ?? null,
  });
  const code = redirect.searchParams.get('code')!;
  const r = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
  assert.equal(r.status, 200, r.text);
  return { client, tokens: r.json as TokenRes, code, verifier };
}

const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } };
const mcp = (path: string, token: string) =>
  f.t.req('POST', path, { headers: { Authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }, json: initBody });

const auditActions = (t: TestCtx = f.t) => (t.db.prepare("SELECT action FROM audit WHERE action LIKE 'oauth.%'").all() as { action: string }[]).map((r) => r.action);

// ---------- metadata ----------

test('authorization server and protected resource metadata documents', async () => {
  const as = await f.t.req('GET', '/.well-known/oauth-authorization-server');
  assert.equal(as.status, 200);
  assert.equal(as.json.issuer, 'http://app.test');
  assert.equal(as.json.authorization_endpoint, 'http://app.test/oauth/authorize');
  assert.equal(as.json.token_endpoint, 'http://app.test/oauth/token');
  assert.equal(as.json.registration_endpoint, 'http://app.test/oauth/register');
  assert.equal(as.json.revocation_endpoint, 'http://app.test/oauth/revoke');
  assert.deepEqual(as.json.scopes_supported, ['read', 'write']);
  assert.deepEqual(as.json.response_types_supported, ['code']);
  assert.deepEqual(as.json.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(as.json.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.json.token_endpoint_auth_methods_supported, ['none', 'client_secret_post', 'client_secret_basic']);

  // RFC 9728 3.3: each document names the path it was derived from as its resource, and the 401 on that path points at that document.
  for (const [path, resource] of [
    ['/.well-known/oauth-protected-resource', 'http://app.test/mcp'],
    ['/.well-known/oauth-protected-resource/mcp', 'http://app.test/mcp'],
    ['/.well-known/oauth-protected-resource/mcp/kit', 'http://app.test/mcp/kit'],
  ]) {
    const r = await f.t.req('GET', path);
    assert.equal(r.status, 200, path);
    assert.deepEqual(r.json, { resource, authorization_servers: ['http://app.test'], scopes_supported: ['read', 'write'], bearer_methods_supported: ['header'] });
  }
  assert.equal((await f.t.req('GET', '/.well-known/oauth-protected-resource/mcp/kit/deeper')).status, 404);
  for (const path of ['/mcp', '/mcp/kit']) {
    const r = await mcp(path, 'scp_at_nope');
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="http://app.test/.well-known/oauth-protected-resource${path}"`);
  }
  // Cross-origin probes from browser hosts.
  const pre = await f.t.req('OPTIONS', '/oauth/token', { headers: { Origin: 'https://claude.ai', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const nope = await f.t.req('GET', '/.well-known/nope');
  assert.equal(nope.status, 404);
  assert.equal(nope.json.error.code, 'not_found');
});

// ---------- registration ----------

test('DCR: a public client is echoed back; a confidential client gets its secret exactly once', async () => {
  const pub = await register(f.t, { redirect_uris: [REDIRECT, 'http://localhost:3000/cb'], client_name: 'Pub', scope: 'read write', contacts: ['x@y.z'] });
  assert.equal(pub.status, 201, pub.text);
  assert.ok(/^[0-9a-z]{26}$/.test(pub.json.client_id));
  assert.equal(pub.json.client_secret, undefined);
  assert.equal(pub.json.token_endpoint_auth_method, 'none');
  assert.deepEqual(pub.json.redirect_uris, [REDIRECT, 'http://localhost:3000/cb']);
  assert.deepEqual(pub.json.grant_types, ['authorization_code', 'refresh_token']);
  assert.equal(pub.json.scope, 'read write');
  assert.equal(typeof pub.json.client_id_issued_at, 'number');
  assert.equal(pub.headers.get('cache-control'), 'no-store');

  const conf = await register(f.t, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' });
  assert.equal(conf.status, 201, conf.text);
  assert.match(conf.json.client_secret, /^scp_cs_/);
  assert.equal(conf.json.client_secret_expires_at, 0);
  const row = f.t.db.prepare('SELECT secret_hash, name FROM oauth_clients WHERE id = ?').get(conf.json.client_id) as { secret_hash: string; name: string };
  assert.notEqual(row.secret_hash, conf.json.client_secret);
  assert.equal(row.secret_hash.length, 64);
  assert.equal(row.name, 'Unnamed client');
  assert.ok(auditActions().includes('oauth.client_register'));
});

test('DCR: redirect_uris and metadata are validated with RFC 7591 errors', async () => {
  const bad = async (body: unknown, error: string) => {
    const r = await register(f.t, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, error, r.text);
    assert.equal(typeof r.json.error_description, 'string');
  };
  await bad({ redirect_uris: ['http://client.example/cb'] }, 'invalid_redirect_uri');
  await bad({ redirect_uris: ['https://client.example/cb#frag'] }, 'invalid_redirect_uri');
  await bad({ redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri');
  await bad({ redirect_uris: ['https://user:pw@client.example/cb'] }, 'invalid_redirect_uri');
  await bad({ redirect_uris: ['not a url'] }, 'invalid_redirect_uri');
  await bad({ redirect_uris: [] }, 'invalid_request');
  await bad({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://c.example/${i}`) }, 'invalid_request');
  await bad({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' }, 'invalid_request');
  await bad({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }, 'invalid_client_metadata');
  await bad({ redirect_uris: [REDIRECT], grant_types: ['refresh_token'] }, 'invalid_client_metadata');
  await bad({ redirect_uris: [REDIRECT], response_types: ['token'] }, 'invalid_client_metadata');
  await bad({ redirect_uris: [REDIRECT], scope: 'read admin' }, 'invalid_scope');
  // client_uri is rendered as a link on the consent page; logo_uri may be shown: http(s) only.
  await bad({ redirect_uris: [REDIRECT], client_uri: 'javascript:alert(document.cookie)' }, 'invalid_client_metadata');
  await bad({ redirect_uris: [REDIRECT], client_uri: 'data:text/html,hi' }, 'invalid_client_metadata');
  await bad({ redirect_uris: [REDIRECT], logo_uri: 'javascript:alert(1)' }, 'invalid_client_metadata');
  assert.equal((await register(f.t, { redirect_uris: [REDIRECT], client_uri: 'https://app.example', logo_uri: 'http://app.example/logo.png' })).status, 201);
  const notJson = await f.t.req('POST', '/oauth/register', { headers: { 'content-type': 'text/plain', 'X-Forwarded-For': '10.9.9.9' }, body: 'nope' });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.json.error, 'invalid_request');
  // Loopback hosts on any port, https anywhere, and a native host's private-use scheme (RFC 8252 7.1); browser-executed schemes never.
  for (const uri of ['http://localhost:1234/cb', 'http://127.0.0.1/cb', 'http://[::1]:5/x?y=1', 'https://x.example:8443/cb', 'cursor://anysphere.cursor-mcp/oauth/callback', 'vscode://ms.mcp/cb', 'com.example.app:/oauth']) {
    assert.equal((await register(f.t, { redirect_uris: [uri] })).status, 201, uri);
  }
  for (const uri of ['data:text/html,hi', 'blob:https://x.example/uuid', 'file:///etc/passwd', 'vbscript:msgbox(1)', 'about:blank']) {
    await bad({ redirect_uris: [uri] }, 'invalid_redirect_uri');
  }
});

test('a native host with a private-use scheme redirect goes through authorize, consent and token', async () => {
  const redirect = 'cursor://anysphere.cursor-mcp/oauth/callback';
  const client = await newClient({ redirect_uris: [redirect], client_name: 'Cursor' });
  const { verifier, challenge } = pkce();
  const back = await consent(f.alice, authQuery(client.client_id, challenge, { redirect_uri: redirect }));
  assert.equal(back.protocol, 'cursor:');
  assert.ok(back.href.startsWith(`${redirect}?`), back.href);
  assert.equal(back.searchParams.get('state'), 'st-1');
  const r = await tokenPost({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: client.client_id, code_verifier: verifier });
  assert.equal(r.status, 200, r.text);
  assert.equal((await mcp('/mcp', (r.json as TokenRes).access_token)).status, 200);
  // Exact match only: no port or path relaxation for a private-use scheme.
  assert.equal((await f.t.req('GET', '/oauth/authorize' + qs(authQuery(client.client_id, challenge, { redirect_uri: 'cursor://anysphere.cursor-mcp/other' })))).status, 400);
});

test('DCR is rate limited per IP: 20 an hour, then 429', async () => {
  const t = makeTestCtx();
  for (let i = 0; i < REGISTER_LIMIT.max; i++) assert.equal((await t.req('POST', '/oauth/register', { json: { redirect_uris: [REDIRECT] } })).status, 201, `#${i}`);
  const r = await t.req('POST', '/oauth/register', { json: { redirect_uris: [REDIRECT] } });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
});

// ---------- authorize ----------

test('authorize: unknown or disabled client and a redirect_uri mismatch are a 400 page, never a redirect', async () => {
  const client = await newClient();
  const { challenge } = pkce();
  const page = async (q: Record<string, string>, error: string) => {
    const r = await f.t.req('GET', '/oauth/authorize' + qs(q));
    assert.equal(r.status, 400, r.text);
    assert.equal(r.headers.get('location'), null);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    assert.ok(r.text.includes(`<code>${error}</code>`), r.text);
    assert.ok(!r.text.includes('<script'));
  };
  await page(authQuery('nope', challenge), 'invalid_client');
  await page(authQuery(client.client_id, challenge, { redirect_uri: 'https://evil.example/cb' }), 'invalid_redirect_uri');
  await page(authQuery(client.client_id, challenge, { redirect_uri: REDIRECT + '?x=1' }), 'invalid_redirect_uri');
  await page(authQuery(client.client_id, challenge, { redirect_uri: '' }), 'invalid_redirect_uri');
  f.t.db.prepare('UPDATE oauth_clients SET disabled = 1 WHERE id = ?').run(client.client_id);
  await page(authQuery(client.client_id, challenge), 'invalid_client');
});

test('authorize: PKCE S256 is mandatory; scope and resource are checked and reported to the registered redirect_uri; loopback ports may vary', async () => {
  const client = await newClient({ redirect_uris: ['http://localhost:1111/cb'] });
  const { challenge } = pkce();
  const base = authQuery(client.client_id, challenge, { redirect_uri: 'http://localhost:1111/cb' });
  // RFC 6749 4.1.2.1: the client and redirect_uri are known good here, so the host hears about the
  // failure at its redirect_uri (with its state) instead of waiting forever for a code.
  const fails = async (q: Record<string, string>, error: string, text: RegExp) => {
    const r = await f.t.req('GET', '/oauth/authorize' + qs(q));
    assert.equal(r.status, 302, r.text);
    const loc = new URL(r.headers.get('location')!);
    assert.equal(loc.origin + loc.pathname, 'http://localhost:1111/cb');
    assert.equal(loc.searchParams.get('error'), error);
    assert.match(loc.searchParams.get('error_description') ?? '', text);
    assert.equal(loc.searchParams.get('state'), 'st-1');
    assert.equal(loc.searchParams.get('code'), null);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  };
  await fails({ ...base, code_challenge_method: 'plain' }, 'invalid_request', /S256/);
  const { code_challenge: _drop, ...noChallenge } = base;
  await fails(noChallenge, 'invalid_request', /code_challenge/);
  await fails({ ...base, code_challenge: 'short' }, 'invalid_request', /code_challenge/);
  await fails({ ...base, response_type: 'token' }, 'invalid_request', /response_type/);
  await fails({ ...base, scope: 'read admin' }, 'invalid_scope', /admin/);
  await fails({ ...base, scope: 'openid' }, 'invalid_scope', /openid/);
  await fails({ ...base, resource: 'https://other.example/mcp' }, 'invalid_target', /resource/);
  await fails({ ...base, resource: 'http://app.test/api/v1' }, 'invalid_target', /resource/);
  for (const resource of ['http://app.test/mcp', 'http://app.test/mcp/kit']) {
    assert.equal((await f.t.req('GET', '/oauth/authorize' + qs({ ...base, resource }))).status, 302, resource);
  }
  // RFC 8252 7.3: the port of a loopback redirect is not fixed at registration; the path is.
  assert.equal((await f.t.req('GET', '/oauth/authorize' + qs({ ...base, redirect_uri: 'http://localhost:2222/cb' }))).status, 302);
  assert.equal((await f.t.req('GET', '/oauth/authorize' + qs({ ...base, redirect_uri: 'http://localhost:2222/other' }))).status, 400);
  assert.equal((await f.t.req('GET', '/oauth/authorize' + qs({ ...base, redirect_uri: 'http://127.0.0.1:1111/cb' }))).status, 400);
  // Only the port may vary: a fragment or userinfo on an otherwise matching loopback URI is refused (a 400 page, no redirect).
  for (const redirect_uri of ['http://localhost:2222/cb#frag', 'http://user:pw@localhost:2222/cb']) {
    const r = await f.t.req('GET', '/oauth/authorize' + qs({ ...base, redirect_uri }));
    assert.equal(r.status, 400, redirect_uri);
    assert.equal(r.headers.get('location'), null, redirect_uri);
  }
});

test('authorize: a valid request hands the browser to the SPA consent page with the same query', async () => {
  const client = await newClient();
  const { challenge } = pkce();
  const q = authQuery(client.client_id, challenge, { scope: 'read write', state: 'a b&c' });
  const r = await f.t.req('GET', '/oauth/authorize' + qs(q));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'http://app.test/consent' + qs(q));
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

// ---------- consent ----------

test('consent GET: browser session only; describes the client, scopes, readable groups and redirect host', async () => {
  const client = await newClient({ redirect_uris: [REDIRECT], client_name: 'Claude Desktop', client_uri: 'https://claude.ai' });
  const { challenge } = pkce();
  const path = `${API}/oauth/consent` + qs(authQuery(client.client_id, challenge, { scope: 'write' }));
  assert.equal((await f.t.req('GET', path)).status, 401);
  const viaKey = await f.t.req('GET', path, { headers: f.t.key(f.alice).headers });
  assert.equal(viaKey.status, 403);
  const r = await f.t.req('GET', path, { headers: f.t.session(f.alice) });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.client, { id: client.client_id, name: 'Claude Desktop', clientUri: 'https://claude.ai', logoUri: null });
  assert.deepEqual(r.json.scopes, ['read', 'write']); // write implies read
  assert.deepEqual((r.json.groups as { slug: string }[]).map((g) => g.slug).sort(), ['kit', 'other']); // bob's secret is not readable
  assert.equal(r.json.redirectHost, 'client.example');
  // The same validation as /oauth/authorize, as JSON here.
  const bad = await f.t.req('GET', `${API}/oauth/consent` + qs(authQuery(client.client_id, challenge, { redirect_uri: 'https://evil.example/' })), { headers: f.t.session(f.alice) });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'invalid_redirect_uri');
});

test('consent POST: deny redirects with access_denied and the state; no code is issued', async () => {
  const client = await newClient();
  const { challenge } = pkce();
  const redirect = await consent(f.alice, authQuery(client.client_id, challenge, { state: 'xyz' }), { approve: false });
  assert.equal(redirect.origin + redirect.pathname, REDIRECT);
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), 'xyz');
  assert.equal(redirect.searchParams.get('code'), null);
  assert.equal((f.t.db.prepare('SELECT COUNT(*) AS n FROM oauth_codes WHERE client_id = ?').get(client.client_id) as { n: number }).n, 0);
});

test('consent POST: approve issues a code; granted scopes are a subset; groups must be readable; keys are refused', async () => {
  const client = await newClient();
  const { challenge } = pkce();
  const q = authQuery(client.client_id, challenge); // scope omitted = read
  const post = (user: TestUser, body: object, headers?: H) => f.t.req('POST', `${API}/oauth/consent`, { headers: headers ?? f.t.session(user), json: { ...q, ...body } });
  assert.equal((await post(f.alice, { approve: true }, f.t.key(f.alice).headers)).status, 403);
  assert.equal((await post(f.alice, { approve: true }, {})).status, 401);
  const more = await post(f.alice, { approve: true, scopes: ['write'] });
  assert.equal(more.status, 400, more.text);
  const unknown = await post(f.alice, { approve: true, groups: ['secret'] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, 'unknown_group');
  assert.equal((await post(f.alice, { approve: true, groups: [] })).status, 400);
  assert.equal((await post(f.alice, { approve: 'yes' })).status, 400);
  const ok = await post(f.alice, { approve: true, groups: ['kit', 'kit'] });
  assert.equal(ok.status, 200, ok.text);
  const u = new URL(ok.json.redirect);
  assert.equal(u.origin + u.pathname, REDIRECT);
  assert.equal(u.searchParams.get('state'), 'st-1');
  assert.ok(u.searchParams.get('code')!.length >= 43);
  const row = f.t.db.prepare('SELECT * FROM oauth_codes WHERE client_id = ?').get(client.client_id) as { group_ids: string; scopes: string; expires_at: string };
  assert.deepEqual(JSON.parse(row.group_ids), [f.kitId]);
  assert.deepEqual(JSON.parse(row.scopes), ['read']);
  assert.ok(Date.parse(row.expires_at) - Date.now() <= 10 * 60_000);
  assert.ok(auditActions().includes('oauth.consent'));
});

// ---------- token ----------

test('token: authorization_code issues an opaque pair (form or JSON); only hashes are stored', async () => {
  const { tokens, client } = await grant(f.alice, { scope: 'read write' });
  assert.match(tokens.access_token, /^scp_at_[A-Za-z0-9_-]{43}$/);
  assert.match(tokens.refresh_token, /^scp_rt_[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, 'read write');
  const rows = f.t.db.prepare('SELECT token_hash, kind, expires_at FROM oauth_tokens WHERE client_id = ?').all(client.client_id) as { token_hash: string; kind: string; expires_at: string }[];
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['access', 'refresh']);
  for (const r of rows) assert.ok(!r.token_hash.startsWith('scp_'));
  const refresh = rows.find((r) => r.kind === 'refresh')!;
  assert.ok(Date.parse(refresh.expires_at) - Date.now() > 29 * 86400_000);

  // JSON body, same grant.
  const { verifier, challenge } = pkce();
  const redirect = await consent(f.alice, authQuery(client.client_id, challenge));
  const r = await f.t.req('POST', '/oauth/token', {
    json: { grant_type: 'authorization_code', code: redirect.searchParams.get('code'), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.scope, 'read');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(auditActions().includes('oauth.token'));
  // The actor is the connected app: detail.oauthClientId, as every other OAuth event carries it (Admin logs show "app …").
  const row = f.t.db.prepare("SELECT key_id, detail FROM audit WHERE action = 'oauth.token' ORDER BY id DESC LIMIT 1").get() as { key_id: string | null; detail: string };
  assert.equal(row.key_id, null);
  assert.deepEqual(JSON.parse(row.detail), { grant: 'authorization_code', oauthClientId: client.client_id });

  // OAuth 2.1 shape: no redirect_uri at the token endpoint (PKCE binds the code).
  const p2 = pkce();
  const redirect2 = await consent(f.alice, authQuery(client.client_id, p2.challenge));
  const bare = await tokenPost({ grant_type: 'authorization_code', code: redirect2.searchParams.get('code')!, client_id: client.client_id, code_verifier: p2.verifier });
  assert.equal(bare.status, 200, bare.text);
  assert.match(bare.json.access_token, /^scp_at_/);
});

test('token: wrong verifier, wrong redirect_uri, another client, expired code and bad resource are refused', async () => {
  const client = await newClient();
  const other = await newClient();
  const fresh = async () => {
    const { verifier, challenge } = pkce();
    const redirect = await consent(f.alice, authQuery(client.client_id, challenge, { resource: 'http://app.test/mcp' }));
    return { verifier, code: redirect.searchParams.get('code')! };
  };
  const base = { grant_type: 'authorization_code', redirect_uri: REDIRECT, client_id: client.client_id };
  const refused = async (body: Record<string, string>, error = 'invalid_grant') => {
    const r = await tokenPost(body);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error, error, r.text);
  };
  const a = await fresh();
  await refused({ ...base, code: a.code, code_verifier: pkce().verifier });
  await refused({ ...base, code: a.code, code_verifier: 'tooshort' });
  await refused({ ...base, code: a.code, code_verifier: a.verifier, redirect_uri: 'https://client.example/cb2' });
  await refused({ ...base, code: a.code, code_verifier: a.verifier, client_id: other.client_id });
  await refused({ ...base, code: a.code, code_verifier: a.verifier, resource: 'http://app.test/mcp/kit' }, 'invalid_target');
  await refused({ ...base, code: a.code, code_verifier: a.verifier, resource: 'https://x.example/mcp' }, 'invalid_target');
  await refused({ ...base, code: 'scp_nope', code_verifier: a.verifier });
  // Failed attempts did not consume the code.
  const ok = await tokenPost({ ...base, code: a.code, code_verifier: a.verifier, resource: 'http://app.test/mcp' });
  assert.equal(ok.status, 200, ok.text);

  const b = await fresh();
  f.t.db.prepare('UPDATE oauth_codes SET expires_at = ? WHERE code_hash = ?').run(new Date(Date.now() - 1000).toISOString(), createHash('sha256').update(b.code).digest('hex'));
  await refused({ ...base, code: b.code, code_verifier: b.verifier });
});

test('token: a reused code is refused and revokes every token it issued', async () => {
  const { tokens, client, code, verifier } = await grant(f.alice);
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200);
  const again = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'invalid_grant');
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 401);
  const refresh = await tokenPost({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(refresh.json.error, 'invalid_grant');
});

test('token: a spent code presented without its PKCE verifier, by another client or by the victim\'s, is refused without revoking the grant', async () => {
  const { tokens, client, code } = await grant(f.alice);
  const stranger = await newClient();
  const revokes = () => (f.t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'oauth.revoke'").get() as { n: number }).n;
  const before = revokes();
  // A spent code leaks easily (browser history, a Referer from the callback page, proxy logs); PKCE already makes it
  // worthless, so a stranger must not be able to take the grant down with one request either.
  for (const client_id of [stranger.client_id, client.client_id]) {
    const r = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id, code_verifier: pkce().verifier });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error, 'invalid_grant');
    assert.doesNotMatch(r.json.error_description, /revoked/);
  }
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200, 'the victim keeps working');
  assert.equal(revokes(), before, 'no oauth.revoke row');
});

test('token: a client registered without the refresh_token grant gets no refresh token and may not refresh', async () => {
  const client = await newClient({ redirect_uris: [REDIRECT], client_name: 'No refresh', grant_types: ['authorization_code'] });
  const { tokens } = await grant(f.alice, { client });
  assert.equal(tokens.refresh_token, undefined, JSON.stringify(tokens));
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200);
  const r = await tokenPost({ grant_type: 'refresh_token', refresh_token: 'scp_rt_whatever', client_id: client.client_id });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, 'unauthorized_client');
  // The default registration keeps both grants.
  assert.ok((await grant(f.alice)).tokens.refresh_token);
});

test('token: grant_type, required fields and client_id are checked', async () => {
  const client = await newClient();
  const err = async (body: Record<string, string>, status: number, error: string) => {
    const r = await tokenPost(body);
    assert.equal(r.status, status, r.text);
    assert.equal(r.json.error, error);
  };
  await err({ grant_type: 'password', client_id: client.client_id }, 400, 'unsupported_grant_type');
  await err({ grant_type: 'authorization_code', client_id: client.client_id }, 400, 'invalid_request');
  await err({ grant_type: 'refresh_token', client_id: client.client_id }, 400, 'invalid_request');
  await err({ grant_type: 'authorization_code', code: 'x' }, 400, 'invalid_request');
  await err({ grant_type: 'authorization_code', code: 'x', client_id: 'nope' }, 401, 'invalid_client');
  const notObject = await f.t.req('POST', '/oauth/token', { json: [1] });
  assert.equal(notObject.status, 400);
  assert.equal(notObject.json.error, 'invalid_request');
  const big = await f.t.req('POST', '/oauth/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x='.padEnd(70_000, 'y') });
  assert.equal(big.status, 413);
  assert.equal(big.json.error, 'invalid_request');
});

test('token: confidential clients authenticate with client_secret_post or Basic; a wrong secret is invalid_client', async () => {
  const client = await newClient({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' });
  const secret = client.client_secret!;
  const code = async () => {
    const { verifier, challenge } = pkce();
    const redirect = await consent(f.alice, authQuery(client.client_id, challenge));
    return { grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: verifier };
  };
  const none = await tokenPost({ ...(await code()), client_id: client.client_id });
  assert.equal(none.status, 401);
  assert.equal(none.json.error, 'invalid_client');
  assert.equal(none.headers.get('www-authenticate'), null, 'no header-based attempt, no challenge');
  const wrong = await tokenPost({ ...(await code()), client_id: client.client_id, client_secret: 'scp_cs_wrong' });
  assert.equal(wrong.status, 401);
  // RFC 6749 5.2: a failed Authorization-header authentication answers with a challenge in that scheme.
  const basicWrong = await tokenPost(await code(), { Authorization: `Basic ${Buffer.from(`${client.client_id}:scp_cs_wrong`).toString('base64')}` });
  assert.equal(basicWrong.status, 401);
  assert.equal(basicWrong.json.error, 'invalid_client');
  assert.equal(basicWrong.headers.get('www-authenticate'), 'Basic realm="oauth"');
  const post = await tokenPost({ ...(await code()), client_id: client.client_id, client_secret: secret });
  assert.equal(post.status, 200, post.text);
  const basic = await tokenPost(await code(), { Authorization: `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString('base64')}` });
  assert.equal(basic.status, 200, basic.text);
  // The refresh grant authenticates the same way.
  const rt = (basic.json as TokenRes).refresh_token;
  assert.equal((await tokenPost({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id })).status, 401);
  assert.equal((await tokenPost({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id, client_secret: secret })).status, 200);
});

test('refresh: rotation issues a new pair, the old refresh token dies, and its reuse past the race window revokes the whole grant', async () => {
  const { tokens: t1, client } = await grant(f.alice, { scope: 'read write' });
  const r2 = await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
  assert.equal(r2.status, 200, r2.text);
  const t2 = r2.json as TokenRes;
  assert.notEqual(t2.access_token, t1.access_token);
  assert.notEqual(t2.refresh_token, t1.refresh_token);
  assert.equal(t2.scope, 'read write');
  assert.equal((await mcp('/mcp', t2.access_token)).status, 200);
  // Presented again right after its rotation: a second refresh in flight (the SDK does not serialize them), so only this call fails.
  const late = await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
  assert.equal(late.status, 400);
  assert.equal(late.json.error, 'invalid_grant');
  assert.match(late.json.error_description, /already rotated/);
  assert.equal((await mcp('/mcp', t2.access_token)).status, 200, 'the winner pair survives');
  // Past the window the same replay is an attacker or client bug: everything on the grant is revoked.
  f.t.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?').run(new Date(Date.now() - REFRESH_RACE_MS - 1000).toISOString(), createHash('sha256').update(t1.refresh_token).digest('hex'));
  const reuse = await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.json.error, 'invalid_grant');
  assert.match(reuse.json.error_description, /grant is revoked/);
  assert.equal((await mcp('/mcp', t2.access_token)).status, 401);
  const dead = await tokenPost({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: client.client_id });
  assert.equal(dead.json.error, 'invalid_grant');
  // Another client cannot use the refresh token; an expired one is refused.
  const { tokens: t3 } = await grant(f.alice);
  const other = await newClient();
  assert.equal((await tokenPost({ grant_type: 'refresh_token', refresh_token: t3.refresh_token, client_id: other.client_id })).json.error, 'invalid_grant');
  f.t.db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'refresh' AND token_hash = ?").run(new Date(Date.now() - 1).toISOString(), createHash('sha256').update(t3.refresh_token).digest('hex'));
  assert.equal((await tokenPost({ grant_type: 'refresh_token', refresh_token: t3.refresh_token, client_id: client.client_id })).json.error, 'invalid_grant');
});

test('the token endpoint sweeps expired rows and rows revoked over a day ago, so refreshing leaves O(1) rows per grant', async () => {
  const { tokens, client } = await grant(f.alice);
  const rows = () => (f.t.db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE client_id = ?').get(client.client_id) as { n: number }).n;
  let rt = tokens.refresh_token;
  for (let i = 0; i < 3; i++) {
    const r = await tokenPost({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id });
    assert.equal(r.status, 200, r.text);
    rt = (r.json as TokenRes).refresh_token;
  }
  assert.equal(rows(), 8, 'three rotations: the live pair, three dead refresh tokens, three stale access tokens');
  // Within the grace window a rotated refresh token is still recognised (and kills the grant on replay); past it, rows go.
  const dayAgo = new Date(Date.now() - 86400_000 - 1000).toISOString();
  f.t.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NOT NULL').run(dayAgo, client.client_id);
  f.t.db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE client_id = ? AND kind = 'access'").run(dayAgo, client.client_id);
  const r = await tokenPost({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id });
  assert.equal(r.status, 200, r.text);
  assert.equal(rows(), 3, 'the new pair plus the refresh token just rotated');
  assert.equal((await mcp('/mcp', (r.json as TokenRes).access_token)).status, 200);
});

// ---------- using the token ----------

test('an access token works on /mcp and /mcp/<group>, and is refused everywhere under /api/v1', async () => {
  const { tokens } = await grant(f.alice, { scope: 'read write' });
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200);
  assert.equal((await mcp('/mcp/kit', tokens.access_token)).status, 200);
  assert.equal((await mcp('/mcp/secret', tokens.access_token)).status, 404);
  for (const path of [`${API}/auth/me`, `${API}/keys`, `${API}/items`, `${API}/groups/kit`, `${API}/oauth/grants`]) {
    const r = await f.t.req('GET', path, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(r.status, 401, path);
    assert.equal(r.json.error.code, 'unauthorized', path);
  }
  // The refresh token is not a bearer credential anywhere.
  assert.equal((await mcp('/mcp', tokens.refresh_token)).status, 401);
  assert.equal((await f.t.req('GET', `${API}/auth/me`, { headers: { Authorization: `Bearer ${tokens.refresh_token}` } })).status, 401);
});

test("an admin's consent grants a plain user's reach: the token reads no other user's private items", async () => {
  const { tokens } = await grant(f.admin, { scope: 'read write' });
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200);
  assert.equal((await mcp('/mcp/kit', tokens.access_token)).status, 404, "alice's private group");
  const skillId = (f.t.db.prepare("SELECT id FROM items WHERE name = 'pdf'").get() as { id: string }).id;
  const client = new Client({ name: 'scp-oauth-admin', version: '0' });
  const appFetch = (url: string | URL, init?: RequestInit) => Promise.resolve(f.t.app.fetch(new Request(url, init)));
  await client.connect(new StreamableHTTPClientTransport(new URL('http://app.test/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }, fetch: appFetch }));
  try {
    const r = (await client.callTool({ name: 'get_skill', arguments: { id: skillId } })) as { isError?: boolean };
    assert.equal(r.isError, true, "an OAuth principal is never admin, so alice's private skill is a 404 for it");
    const groups = (await client.callTool({ name: 'list_groups', arguments: {} })) as { content: { text?: string }[] };
    assert.ok(!groups.content.map((c) => c.text ?? '').join('\n').includes('kit'));
  } finally {
    await client.close();
  }
  // The same admin's API key keeps admin reach: that is the deliberate way to get it over MCP.
  assert.equal((await mcp('/mcp/kit', f.t.key(f.admin).token)).status, 200);
});

test('a group-restricted grant cannot see other groups; a read-only grant cannot write', async () => {
  const { tokens, client: app } = await grant(f.alice, { groups: ['kit'] });
  assert.equal((await mcp('/mcp/kit', tokens.access_token)).status, 200);
  assert.equal((await mcp('/mcp/other', tokens.access_token)).status, 404);
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200);
  const client = new Client({ name: 'scp-oauth-test', version: '0' });
  const appFetch = (url: string | URL, init?: RequestInit) => Promise.resolve(f.t.app.fetch(new Request(url, init)));
  await client.connect(new StreamableHTTPClientTransport(new URL('http://app.test/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }, fetch: appFetch }));
  try {
    const kit = (await client.callTool({ name: 'get_group', arguments: { group: 'kit' } })) as { content: { text?: string }[]; isError?: boolean };
    assert.ok(!kit.isError && kit.content.map((c) => c.text ?? '').join('\n').includes('pdf'), JSON.stringify(kit));
    // The tool call is audited with the connected app's client id: two apps stay tellable apart.
    const last = f.t.db.prepare("SELECT key_id, detail FROM audit WHERE action = 'mcp.call' ORDER BY id DESC LIMIT 1").get() as { key_id: string | null; detail: string };
    assert.equal(last.key_id, null);
    assert.deepEqual(JSON.parse(last.detail), { tool: 'get_group', group: null, oauthClientId: app.client_id });
    const other = (await client.callTool({ name: 'get_group', arguments: { group: 'other' } })) as { isError?: boolean };
    assert.equal(other.isError, true, 'the grant is restricted to kit');
    const create = (await client.callTool({ name: 'create_artifact', arguments: { title: 'Nope', format: 'html', content: '<p>x</p>' } })) as { content: { text?: string }[]; isError?: boolean };
    assert.equal(create.isError, true);
    assert.match(create.content.map((c) => c.text ?? '').join('\n'), /read-only.*'write' scope/);
  } finally {
    await client.close();
  }
});

test('expired, revoked, disabled-client and disabled-user tokens are 401 on /mcp', async () => {
  const { tokens, client } = await grant(f.alice);
  const hash = createHash('sha256').update(tokens.access_token).digest('hex');
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200);
  f.t.db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 1).toISOString(), hash);
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 401);
  f.t.db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() + 60_000).toISOString(), hash);
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200);
  f.t.db.prepare('UPDATE oauth_clients SET disabled = 1 WHERE id = ?').run(client.client_id);
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 401);
  f.t.db.prepare('UPDATE oauth_clients SET disabled = 0 WHERE id = ?').run(client.client_id);

  const carol = f.t.createUser({ username: 'carol' });
  const c = await grant(carol);
  assert.equal((await mcp('/mcp', c.tokens.access_token)).status, 200);
  f.t.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(carol.id);
  assert.equal((await mcp('/mcp', c.tokens.access_token)).status, 401);
  assert.equal((await tokenPost({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.client.client_id })).json.error, 'invalid_grant');
});

// ---------- grants, admin, revocation ----------

test('grants: the account lists its connected apps and revokes one; others get 404; keys 403', async () => {
  const dave = f.t.createUser({ username: 'dave' });
  const { tokens, client } = await grant(f.alice, { groups: ['kit'], scope: 'read write' });
  assert.equal((await mcp('/mcp/kit', tokens.access_token)).status, 200);
  const list = await f.t.req('GET', `${API}/oauth/grants`, { headers: f.t.session(f.alice) });
  assert.equal(list.status, 200, list.text);
  const g = (list.json.grants as any[]).find((x) => x.client.id === client.client_id);
  assert.ok(g, list.text);
  assert.equal(g.client.name, 'Test app');
  assert.deepEqual(g.scopes, ['read', 'write']);
  assert.deepEqual(g.groups, [{ id: f.kitId, slug: 'kit' }]);
  assert.ok(g.lastUsedAt, 'stamped on use');
  assert.ok(Date.parse(g.expiresAt) - Date.now() > 29 * 86400_000, 'the grant lives as long as its refresh token');
  assert.equal((await f.t.req('GET', `${API}/oauth/grants`, { headers: f.t.session(dave) })).json.grants.length, 0);
  assert.equal((await f.t.req('GET', `${API}/oauth/grants`, { headers: f.t.key(f.alice).headers })).status, 403);

  assert.equal((await f.t.req('DELETE', `${API}/oauth/grants/${g.grantId}`, { headers: f.t.session(dave) })).status, 404);
  assert.equal((await f.t.req('DELETE', `${API}/oauth/grants/nope`, { headers: f.t.session(f.alice) })).status, 404);
  const del = await f.t.req('DELETE', `${API}/oauth/grants/${g.grantId}`, { headers: f.t.session(f.alice) });
  assert.equal(del.status, 204, del.text);
  assert.equal((await mcp('/mcp/kit', tokens.access_token)).status, 401);
  assert.equal((await tokenPost({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json.error, 'invalid_grant');
  const after = await f.t.req('GET', `${API}/oauth/grants`, { headers: f.t.session(f.alice) });
  assert.ok(!(after.json.grants as any[]).some((x) => x.grantId === g.grantId));
  assert.ok(auditActions().includes('oauth.revoke'));
});

test('admin: lists clients with live grant counts and disables one; non-admins and keys get 403', async () => {
  const { tokens, client } = await grant(f.alice);
  assert.equal((await f.t.req('GET', `${API}/oauth/clients`, { headers: f.t.session(f.alice) })).status, 403);
  assert.equal((await f.t.req('GET', `${API}/oauth/clients`, { headers: f.t.key(f.admin).headers })).status, 403);
  const list = await f.t.req('GET', `${API}/oauth/clients`, { headers: f.t.session(f.admin) });
  assert.equal(list.status, 200, list.text);
  const c = (list.json.clients as any[]).find((x) => x.id === client.client_id);
  assert.deepEqual(c, { id: client.client_id, name: 'Test app', redirectUris: [REDIRECT], authMethod: 'none', clientUri: null, createdAt: c.createdAt, disabled: false, grants: 1 });

  assert.equal((await f.t.req('PATCH', `${API}/oauth/clients/nope`, { headers: f.t.session(f.admin), json: { disabled: true } })).status, 404);
  assert.equal((await f.t.req('PATCH', `${API}/oauth/clients/${client.client_id}`, { headers: f.t.session(f.alice), json: { disabled: true } })).status, 403);
  const off = await f.t.req('PATCH', `${API}/oauth/clients/${client.client_id}`, { headers: f.t.session(f.admin), json: { disabled: true } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.client.disabled, true);
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 401);
  // invalid_grant, not invalid_client: on the latter an SDK host discards its client id and re-registers through
  // anonymous DCR, back under a client the admin never disabled; on the former it re-authorizes with the same id and is refused.
  const refused = await tokenPost({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.json.error, 'invalid_grant');
  assert.equal((await f.t.req('GET', '/oauth/authorize' + qs(authQuery(client.client_id, pkce().challenge)))).status, 400);
  // Disabling suspends, it does not revoke: the grant stays listed, flagged, and works again once enabled.
  const grantOf = async () => ((await f.t.req('GET', `${API}/oauth/grants`, { headers: f.t.session(f.alice) })).json.grants as { client: { id: string }; clientDisabled: boolean }[]).find((g) => g.client.id === client.client_id)!;
  assert.equal((await grantOf()).clientDisabled, true);
  const on = await f.t.req('PATCH', `${API}/oauth/clients/${client.client_id}`, { headers: f.t.session(f.admin), json: { disabled: false } });
  assert.equal(on.json.client.disabled, false);
  assert.equal((await grantOf()).clientDisabled, false);
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200);
});

test('revocation endpoint: 200 whatever the token; a known token takes its whole grant down', async () => {
  const { tokens, client } = await grant(f.alice);
  const other = await newClient();
  const revoke = (body: Record<string, string>) => f.t.req('POST', '/oauth/revoke', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  assert.equal((await revoke({ token: 'scp_at_unknown' })).status, 200);
  // Another client naming itself cannot revoke what it does not own.
  assert.equal((await revoke({ token: tokens.access_token, client_id: other.client_id })).status, 200);
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 200);
  assert.equal((await revoke({ token: tokens.refresh_token, client_id: client.client_id })).status, 200);
  assert.equal((await mcp('/mcp', tokens.access_token)).status, 401);
  assert.equal((await tokenPost({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json.error, 'invalid_grant');
  const row = f.t.db.prepare("SELECT detail FROM audit WHERE action = 'oauth.revoke' ORDER BY id DESC LIMIT 1").get() as { detail: string };
  assert.deepEqual(JSON.parse(row.detail), { by: 'client', oauthClientId: client.client_id });
  const missing = await revoke({});
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'invalid_request');
});

// ---------- end to end with the MCP SDK ----------

/** The SDK's OAuthClientProvider with a fake redirect capture: what Claude Code or an MCP host does. */
class TestProvider implements OAuthClientProvider {
  readonly redirectUrl = 'http://localhost:4321/callback';
  readonly clientMetadata: OAuthClientMetadata = {
    redirect_uris: [this.redirectUrl],
    client_name: 'SDK test client',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  info?: OAuthClientInformationMixed;
  toks?: OAuthTokens;
  verifier = '';
  authorizeUrl?: URL;
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.toks;
  }
  saveTokens(t: OAuthTokens) {
    this.toks = t;
  }
  redirectToAuthorization(url: URL) {
    this.authorizeUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  state() {
    return 'sdk-state';
  }
  /** What a real host does on invalid_client ('all': register afresh) and on invalid_grant ('tokens': re-authorize as the same client). */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier') {
    if (scope === 'all' || scope === 'client') this.info = undefined;
    if (scope === 'all' || scope === 'tokens') this.toks = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = '';
  }
}

test('end to end: an MCP SDK client probes 401, discovers, registers, is authorized through consent and calls tools; refresh is transparent', async () => {
  const provider = new TestProvider();
  const appFetch = (url: string | URL, init?: RequestInit) => Promise.resolve(f.t.app.fetch(new Request(url, init)));
  const url = new URL('http://app.test/mcp/kit');
  const mkTransport = () => new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: appFetch });

  // 1. First contact: 401 -> resource metadata -> AS metadata -> DCR -> authorization URL for the browser.
  const t1 = mkTransport();
  await assert.rejects(new Client({ name: 'e2e', version: '0' }).connect(t1), UnauthorizedError);
  assert.ok(provider.info?.client_id, 'registered through DCR');
  assert.ok(provider.authorizeUrl, 'sent the user to authorize');
  const a = provider.authorizeUrl!;
  assert.equal(a.origin + a.pathname, 'http://app.test/oauth/authorize');
  assert.equal(a.searchParams.get('client_id'), provider.info!.client_id);
  assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(a.searchParams.get('resource'), 'http://app.test/mcp/kit', 'the resource the metadata document for /mcp/kit names (RFC 9728)');
  assert.equal(a.searchParams.get('scope'), 'read write');
  assert.equal(a.searchParams.get('state'), 'sdk-state');

  // 2. The browser follows it; the SPA consent page asks the API and the user approves.
  const authorize = await f.t.req('GET', a.pathname + a.search);
  assert.equal(authorize.status, 302, authorize.text);
  const consentQuery = new URL(authorize.headers.get('location')!).search;
  const info = await f.t.req('GET', `${API}/oauth/consent${consentQuery}`, { headers: f.t.session(f.alice) });
  assert.equal(info.status, 200, info.text);
  assert.equal(info.json.client.name, 'SDK test client');
  assert.equal(info.json.redirectHost, 'localhost:4321');
  assert.deepEqual(info.json.scopes, ['read', 'write']);
  const approve = await f.t.req('POST', `${API}/oauth/consent`, {
    headers: f.t.session(f.alice),
    json: { ...Object.fromEntries(new URL(authorize.headers.get('location')!).searchParams), approve: true, scopes: ['read', 'write'], groups: null },
  });
  assert.equal(approve.status, 200, approve.text);
  const redirect = new URL(approve.json.redirect);
  assert.equal(redirect.origin + redirect.pathname, provider.redirectUrl);
  assert.equal(redirect.searchParams.get('state'), 'sdk-state');

  // 3. The client's callback finishes the exchange with its PKCE verifier.
  await t1.finishAuth(redirect.searchParams.get('code')!);
  assert.match(provider.toks!.access_token, /^scp_at_/);
  assert.match(provider.toks!.refresh_token!, /^scp_rt_/);

  // 4. Connected: tools work with the OAuth principal.
  const c2 = new Client({ name: 'e2e', version: '0' });
  await c2.connect(mkTransport());
  try {
    const { tools } = await c2.listTools();
    assert.ok(tools.some((t) => t.name === 'get_skill'));
    const r = (await c2.callTool({ name: 'get_group' })) as { content: { text?: string }[]; isError?: boolean };
    assert.ok(!r.isError, JSON.stringify(r));
    assert.match(r.content.map((c) => c.text ?? '').join('\n'), /pdf/);
  } finally {
    await c2.close();
  }

  // 5. The access token expires; the SDK refreshes on the 401 without bothering the user.
  const before = { ...provider.toks! };
  f.t.db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'access' AND client_id = ?").run(new Date(Date.now() - 1).toISOString(), provider.info!.client_id);
  const c3 = new Client({ name: 'e2e', version: '0' });
  await c3.connect(mkTransport());
  try {
    assert.ok((await c3.listTools()).tools.length > 0);
  } finally {
    await c3.close();
  }
  assert.notEqual(provider.toks!.access_token, before.access_token);
  assert.notEqual(provider.toks!.refresh_token, before.refresh_token, 'refresh token rotated');
  assert.equal((await mcp('/mcp/kit', provider.toks!.access_token)).status, 200);
  assert.equal((await mcp('/mcp/kit', before.access_token)).status, 401);
  assert.ok(provider.authorizeUrl === a, 'no second authorization round trip');
});

test('an admin-disabled client stays disabled for an SDK host: it keeps its client id, drops its tokens and is refused at authorize instead of re-registering', async () => {
  const provider = new TestProvider();
  const client = await newClient({ redirect_uris: [provider.redirectUrl], client_name: 'SDK host' });
  const { verifier, challenge } = pkce();
  const redirect = await consent(f.alice, { ...authQuery(client.client_id, challenge), redirect_uri: provider.redirectUrl });
  const tok = await tokenPost({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, client_id: client.client_id, code_verifier: verifier });
  assert.equal(tok.status, 200, tok.text);
  // Stamped with the authorization server, as the SDK stores them (an unstamped pair draws a warning and is used as-is).
  provider.info = { client_id: client.client_id, redirect_uris: [provider.redirectUrl], token_endpoint_auth_method: 'none', issuer: 'http://app.test' } as OAuthClientInformationMixed;
  provider.toks = { ...(tok.json as OAuthTokens), issuer: 'http://app.test' } as OAuthTokens;
  const appFetch = (url: string | URL, init?: RequestInit) => Promise.resolve(f.t.app.fetch(new Request(url, init)));
  const mkTransport = () => new StreamableHTTPClientTransport(new URL('http://app.test/mcp/kit'), { authProvider: provider, fetch: appFetch });
  const c1 = new Client({ name: 'sdk-disabled', version: '0' });
  await c1.connect(mkTransport());
  await c1.close();

  assert.equal((await f.t.req('PATCH', `${API}/oauth/clients/${client.client_id}`, { headers: f.t.session(f.admin), json: { disabled: true } })).status, 200);
  const clients = () => (f.t.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
  const n = clients();
  // Its token is refused, its refresh answers invalid_grant: the SDK drops the tokens, keeps the client id and
  // sends the user to authorize, where the disabled client gets the refusal page. Nothing was registered anew.
  await assert.rejects(new Client({ name: 'sdk-disabled', version: '0' }).connect(mkTransport()), UnauthorizedError);
  assert.equal(provider.info?.client_id, client.client_id, 'no re-registration');
  assert.equal(clients(), n);
  assert.equal(provider.toks, undefined, 'tokens dropped');
  assert.equal(provider.authorizeUrl?.searchParams.get('client_id'), client.client_id);
  const page = await f.t.req('GET', provider.authorizeUrl!.pathname + provider.authorizeUrl!.search);
  assert.equal(page.status, 400, page.text);
  assert.match(page.text, /disabled client_id/);
});

// ---------- v2 review ----------

test('two refreshes in flight at expiry: the late one fails alone and the winner pair survives', async () => {
  const { tokens, client } = await grant(f.alice);
  const body = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id };
  const [a, b] = await Promise.all([tokenPost(body), tokenPost(body)]);
  const [won, lost] = a.status === 200 ? [a, b] : [b, a];
  assert.equal(won.status, 200, won.text);
  assert.equal(lost.status, 400, lost.text);
  assert.equal(lost.json.error, 'invalid_grant');
  const t2 = won.json as TokenRes;
  assert.equal((await mcp('/mcp', t2.access_token)).status, 200, 'the grant is intact');
  const r3 = await tokenPost({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: client.client_id });
  assert.equal(r3.status, 200, r3.text);
  const live = f.t.db
    .prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE kind = 'refresh' AND revoked_at IS NULL AND grant_id = (SELECT grant_id FROM oauth_tokens WHERE token_hash = ?)")
    .get(createHash('sha256').update(t2.refresh_token).digest('hex')) as { n: number };
  assert.equal(live.n, 1, 'exactly one live refresh token on the grant');
});

test("admin consent is evaluated as the token will act: another user's private group is neither offered nor accepted", async () => {
  const client = await newClient();
  const { challenge } = pkce();
  const q = authQuery(client.client_id, challenge);
  const info = await f.t.req('GET', `${API}/oauth/consent` + qs(q), { headers: f.t.session(f.admin) });
  assert.equal(info.status, 200, info.text);
  const offered = (info.json.groups as { slug: string }[]).map((g) => g.slug);
  assert.ok(!offered.includes('secret') && !offered.includes('kit'), `private groups of other users are not offered: ${offered}`);
  const r = await f.t.req('POST', `${API}/oauth/consent`, { headers: f.t.session(f.admin), json: { ...q, approve: true, groups: ['secret'] } });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error.code, 'unknown_group');
});

test('a version written through a connected app records its client id', async () => {
  const { tokens, client: app } = await grant(f.alice, { scope: 'read write' });
  const c = new Client({ name: 'writer', version: '0' });
  const appFetch = (url: string | URL, init?: RequestInit) => Promise.resolve(f.t.app.fetch(new Request(url, init)));
  await c.connect(new StreamableHTTPClientTransport(new URL('http://app.test/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }, fetch: appFetch }));
  let id = '';
  try {
    const r = (await c.callTool({ name: 'create_artifact', arguments: { title: 'Written by an app', format: 'html', content: '<p>x</p>' } })) as { isError?: boolean; structuredContent?: { id: string } };
    assert.ok(!r.isError, JSON.stringify(r));
    id = r.structuredContent!.id;
  } finally {
    await c.close();
  }
  const versions = await f.t.req('GET', `${API}/items/${id}/versions`, { headers: f.t.session(f.alice) });
  assert.equal(versions.status, 200, versions.text);
  assert.deepEqual(versions.json.versions[0].createdBy, { userId: f.alice.id, keyId: null, clientId: app.client_id });
  const own = await f.t.req('POST', `${API}/items/${id}/versions`, { headers: f.t.session(f.alice), json: { content: '<p>y</p>' } });
  assert.equal(own.status, 201, own.text);
  assert.deepEqual(own.json.item.version.createdBy, { userId: f.alice.id, keyId: null, clientId: null });
});

test('a mixed-case group URL authorizes: the slug is case-insensitive wherever a key accepts it', async () => {
  const client = await newClient();
  const { verifier, challenge } = pkce();
  const probe = await mcp('/mcp/Kit', 'scp_at_nope');
  assert.equal(probe.status, 401);
  assert.equal(probe.headers.get('www-authenticate'), 'Bearer resource_metadata="http://app.test/.well-known/oauth-protected-resource/mcp/Kit"');
  assert.equal((await f.t.req('GET', '/.well-known/oauth-protected-resource/mcp/Kit')).json.resource, 'http://app.test/mcp/Kit');
  const redirect = await consent(f.alice, authQuery(client.client_id, challenge, { resource: 'http://app.test/mcp/Kit' }));
  const r = await tokenPost({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, client_id: client.client_id, code_verifier: verifier, resource: 'http://app.test/mcp/Kit' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await mcp('/mcp/Kit', (r.json as TokenRes).access_token)).status, 200);
  const upper = await f.t.req('GET', '/oauth/authorize' + qs(authQuery(client.client_id, challenge, { resource: 'http://app.test/MCP/kit' })));
  assert.equal(upper.status, 302, 'only the slug is case-insensitive');
  assert.equal(new URL(upper.headers.get('location')!).searchParams.get('error'), 'invalid_target');
});

test('anonymous clients nobody consented to are swept after the grace period, consented ones stay, and the admin listing is paged', async () => {
  const old = await newClient({ redirect_uris: [REDIRECT], client_name: 'Stale' });
  const used = await newClient({ redirect_uris: [REDIRECT], client_name: 'Used' });
  await grant(f.alice, { client: used });
  const backdate = new Date(Date.now() - CLIENT_GRACE_MS - 60_000).toISOString();
  f.t.db.prepare('UPDATE oauth_clients SET created_at = ? WHERE id IN (?, ?)').run(backdate, old.client_id, used.client_id);
  const fresh = await newClient(); // every registration sweeps
  const ids = (f.t.db.prepare('SELECT id FROM oauth_clients').all() as { id: string }[]).map((r) => r.id);
  assert.ok(!ids.includes(old.client_id), 'never consented and past the grace: gone');
  assert.ok(ids.includes(used.client_id), 'a grant keeps it');
  assert.ok(ids.includes(fresh.client_id));
  const page = await f.t.req('GET', `${API}/oauth/clients?limit=2`, { headers: f.t.session(f.admin) });
  assert.equal(page.status, 200, page.text);
  assert.equal(page.json.clients.length, 2);
  assert.equal(page.json.clients[0].id, fresh.client_id, 'newest first');
  assert.equal(page.json.total, ids.length);
  const rest = await f.t.req('GET', `${API}/oauth/clients?limit=200&offset=2`, { headers: f.t.session(f.admin) });
  assert.equal(rest.json.clients.length, ids.length - 2);
  assert.equal((await f.t.req('GET', `${API}/oauth/clients?limit=201`, { headers: f.t.session(f.admin) })).status, 400);
});

test('a consented client outlives its tokens: its host keeps the client_id and lands on consent again, not on the invalid_client page', async () => {
  const { client, tokens } = await grant(f.alice);
  // Every token expired (the next token request sweeps them), no code pending, and the registration past the grace period.
  f.t.db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE client_id = ?').run(new Date(Date.now() - 1000).toISOString(), client.client_id);
  f.t.db.prepare('DELETE FROM oauth_codes WHERE client_id = ?').run(client.client_id);
  f.t.db.prepare('UPDATE oauth_clients SET created_at = ? WHERE id = ?').run(new Date(Date.now() - CLIENT_GRACE_MS - 60_000).toISOString(), client.client_id);
  const refresh = await tokenPost({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(refresh.status, 400, refresh.text);
  assert.equal(refresh.json.error, 'invalid_grant');
  assert.ok(f.t.db.prepare('SELECT 1 FROM oauth_clients WHERE id = ?').get(client.client_id), 'the sweep kept the consented client');
  // The MCP SDK drops its tokens on invalid_grant and re-enters authorize with the client_id it stored.
  const a = await f.t.req('GET', '/oauth/authorize' + qs(authQuery(client.client_id, pkce().challenge)));
  assert.equal(a.status, 302, a.text);
  assert.ok(a.headers.get('location')!.startsWith('http://app.test/consent?'), a.headers.get('location') ?? '');
});

test('the token sweep runs on indexes, and the token endpoint is rate limited per address and per client', async () => {
  for (const sql of SWEEP_TOKENS_SQL) {
    const plan = (f.t.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x') as { detail: string }[]).map((r) => r.detail).join('\n');
    assert.doesNotMatch(plan, /SCAN oauth_tokens/, plan);
    assert.match(plan, /INDEX oauth_tokens_(expires|revoked)/, plan);
  }
  // The client sweep runs on every token request too, over a table anonymous registration makes attacker-sized.
  const clientsPlan = (f.t.db.prepare(`EXPLAIN QUERY PLAN ${SWEEP_CLIENTS_SQL}`).all('x') as { detail: string }[]).map((r) => r.detail).join('\n');
  assert.doesNotMatch(clientsPlan, /SCAN (oauth_clients|oauth_codes|oauth_tokens|x|t)\b/, clientsPlan);
  assert.match(clientsPlan, /INDEX oauth_clients_sweep/, clientsPlan);
  assert.match(clientsPlan, /INDEX oauth_codes_client/, clientsPlan);
  const bogus = (client: ClientRes, headers: H = {}) => tokenPost({ grant_type: 'refresh_token', refresh_token: 'scp_rt_nope', client_id: client.client_id }, headers);
  const limitedShape = (r: Awaited<ReturnType<typeof bogus>>) => {
    assert.equal(r.status, 429, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['error', 'error_description']);
    assert.equal(r.json.error, 'rate_limited');
  };
  // One address, any client_id: the per-IP bucket, before the body is even read.
  const ip = nextIp();
  const byIp: number[] = [];
  for (let i = 0; i < AUTH_LIMITS.oauthToken.burst + 10; i++) byIp.push((await bogus(await newClient(), { 'X-Forwarded-For': ip })).status);
  assert.ok(byIp.slice(0, AUTH_LIMITS.oauthToken.burst).every((s) => s === 400), byIp.join(','));
  assert.equal(byIp.at(-1), 429);
  limitedShape(await bogus(await newClient(), { 'X-Forwarded-For': ip }));
  // One client from many addresses: the per-client bucket.
  const client = await newClient();
  const byClient: number[] = [];
  for (let i = 0; i < AUTH_LIMITS.oauthToken.burst + 10; i++) byClient.push((await bogus(client)).status);
  assert.ok(byClient.slice(0, AUTH_LIMITS.oauthToken.burst).every((s) => s === 400), byClient.join(','));
  assert.equal(byClient.at(-1), 429);
  limitedShape(await bogus(client));
  assert.equal((await bogus(await newClient())).status, 400, 'another client from another address is unaffected');
});

test('a grant revoked by an authorization-code replay or a refresh-token reuse is audited as oauth.revoke', async () => {
  const { client, code, verifier } = await grant(f.alice);
  const replay = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
  assert.equal(replay.json.error, 'invalid_grant');
  const revokeOf = (grantId: string) =>
    (f.t.db.prepare("SELECT user_id, detail FROM audit WHERE action = 'oauth.revoke' AND target_id = ?").all(grantId) as { user_id: string; detail: string }[]).map((r) => ({
      userId: r.user_id,
      ...(JSON.parse(r.detail) as { by: string; oauthClientId: string }),
    }));
  assert.deepEqual(revokeOf(createHash('sha256').update(code).digest('hex')), [{ userId: f.alice.id, by: 'code_replay', oauthClientId: client.client_id }]);
  // A rotated refresh token presented again past the race window.
  const { tokens: t1, client: c2 } = await grant(f.alice);
  assert.equal((await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: c2.client_id })).status, 200);
  const hash = createHash('sha256').update(t1.refresh_token).digest('hex');
  f.t.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?').run(new Date(Date.now() - REFRESH_RACE_MS - 1000).toISOString(), hash);
  assert.equal((await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: c2.client_id })).json.error, 'invalid_grant');
  const { grant_id } = f.t.db.prepare('SELECT grant_id FROM oauth_tokens WHERE token_hash = ?').get(hash) as { grant_id: string };
  assert.deepEqual(revokeOf(grant_id), [{ userId: f.alice.id, by: 'reuse', oauthClientId: c2.client_id }]);
});

test('consent GET names the app itself for a private-use redirect without an authority (RFC 8252)', async () => {
  const client = await newClient({ redirect_uris: ['com.example.app:/oauth'] });
  const q = authQuery(client.client_id, pkce().challenge, { redirect_uri: 'com.example.app:/oauth' });
  const info = await f.t.req('GET', `${API}/oauth/consent` + qs(q), { headers: f.t.session(f.alice) });
  assert.equal(info.status, 200, info.text);
  assert.equal(info.json.redirectHost, 'com.example.app');
});

test('get_bundle and large-file hints over an OAuth connection do not hand out $SCP_KEY commands the token cannot run', async () => {
  const { tokens } = await grant(f.alice);
  const c = new Client({ name: 'oauth-bundle', version: '0' });
  const appFetch = (url: string | URL, init?: RequestInit) => Promise.resolve(f.t.app.fetch(new Request(url, init)));
  await c.connect(new StreamableHTTPClientTransport(new URL('http://app.test/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }, fetch: appFetch }));
  try {
    const r = (await c.callTool({ name: 'get_bundle', arguments: { group: 'kit' } })) as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
    assert.ok(!r.isError, JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('SCP_KEY'), JSON.stringify(r));
    assert.match(r.content[0].text, /OAuth token, which that URL does not accept.*API key minted on http:\/\/app\.test\/keys/);
    assert.equal(r.structuredContent!.url, 'http://app.test/api/v1/groups/kit/bundle.zip?target=claude-code&scope=project');
    assert.equal(r.structuredContent!.bash, undefined);
    assert.equal(r.structuredContent!.items, 1);
  } finally {
    await c.close();
  }
});
