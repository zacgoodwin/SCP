import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { FETCH_BLOCKED_PORTS, listenLocal, makeTestCtx, type Res, type TestCtx } from './helpers.ts';
import { OIDC_PASSWORD_HASH, clearOidcCache, endpointProblem, usernameBase, verifyIdToken } from '../src/auth/oidc.ts';
import { verifyLogin } from '../src/auth/service.ts';

// ---------- fake IdP: discovery, JWKS with a real key, token endpoint minting id_tokens ----------

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

interface Idp {
  issuer: string;
  alg: 'RS256' | 'ES256';
  key: KeyObject;
  /** Claims the next token exchange mints (merged over the defaults the test flow fills in). */
  claims: Record<string, unknown>;
  /** Sign with this key instead (bad signature tests). */
  signWith?: KeyObject;
  kid: string;
  /** The body of each token request, plus its Authorization header under `_authorization`. */
  tokenRequests: URLSearchParams[];
  /** Override pieces of the discovery document. */
  discoveryPatch: Record<string, unknown>;
  tokenStatus: number;
  /** Authelia-style: the token endpoint refuses anything but HTTP Basic client authentication. */
  requireBasic: boolean;
  server: Server;
}

const BASIC = `Basic ${Buffer.from('scp-client:shh').toString('base64')}`;

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function startIdp(alg: 'RS256' | 'ES256' = 'RS256'): Promise<Idp> {
  const pair = alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const idp: Idp = {
    issuer: '',
    alg,
    key: pair.privateKey,
    claims: {},
    kid: 'k1',
    tokenRequests: [],
    discoveryPatch: {},
    tokenStatus: 200,
    requireBasic: false,
    server: undefined as unknown as Server,
  };
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg, use: 'sig' };
  idp.server = createServer((req, res) => {
    const url = new URL(req.url!, idp.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        ...idp.discoveryPatch,
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        if (req.headers.authorization) params.set('_authorization', req.headers.authorization);
        idp.tokenRequests.push(params);
        if (idp.requireBasic && req.headers.authorization !== BASIC) return json(401, { error: 'invalid_client' });
        if (idp.tokenStatus !== 200) return json(idp.tokenStatus, { error: 'invalid_grant' });
        json(200, { access_token: 'at', token_type: 'Bearer', id_token: mint(idp, idp.claims) });
      });
      return;
    }
    json(404, { error: 'nope' });
  });
  idp.issuer = `http://127.0.0.1:${await listenLocal(idp.server)}`;
  servers.push(idp.server);
  return idp;
}

/** The same IdP answering on a second origin too (Google serves token and JWKS off the issuer's host). */
async function secondOrigin(idp: Idp): Promise<string> {
  const aux = createServer(idp.server.listeners('request')[0] as Parameters<typeof createServer>[0]);
  const port = await listenLocal(aux);
  servers.push(aux);
  return `http://127.0.0.1:${port}`;
}

function mint(idp: Idp, claims: Record<string, unknown>): string {
  const t = Math.floor(Date.now() / 1000);
  const payload = { iss: idp.issuer, aud: 'scp-client', iat: t, exp: t + 300, sub: 'sub-1', ...claims };
  const data = `${b64({ alg: idp.alg, kid: idp.kid })}.${b64(payload)}`;
  const sig = sign('sha256', Buffer.from(data), { key: idp.signWith ?? idp.key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

// ---------- flow helpers ----------

// trustProxy so each flow can come from its own address (start and callback share the anonymous per-IP bucket).
const env = (idp: Idp, extra: Record<string, string> = {}) => ({
  SCP_OIDC_ISSUER: idp.issuer,
  SCP_OIDC_CLIENT_ID: 'scp-client',
  SCP_OIDC_CLIENT_SECRET: 'shh',
  SCP_TRUST_PROXY: 'true',
  ...extra,
});

let addr = 0;
/** A fresh client address per anonymous call, so no test trips the per-IP limiter by accident. */
const xff = () => ({ 'X-Forwarded-For': `10.${(addr >> 16) & 255}.${(addr >> 8) & 255}.${addr++ & 255}` });

const cookieOf = (r: Res) => r.headers.get('set-cookie')!.split(';')[0];

/** GET /start (or, with `link`, POST /link as that session) and return the state cookie plus the authorization URL's parameters. */
async function start(t: TestCtx, next = '/items', link?: Record<string, string>) {
  const r = link
    ? await t.req('POST', '/api/v1/auth/oidc/link', { headers: { ...link, ...xff() }, json: { next } })
    : await t.req('GET', `/api/v1/auth/oidc/start?next=${encodeURIComponent(next)}`, { headers: xff() });
  assert.equal(r.status, link ? 200 : 302, r.text);
  const loc = new URL(link ? r.json.url : r.headers.get('location')!);
  const sc = r.headers.get('set-cookie')!;
  assert.match(sc, /^scp_oidc=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Max-Age=600/);
  return { cookie: cookieOf(r), q: loc.searchParams, loc };
}

/** Full happy flow: start, mint with the nonce, callback. Returns the callback response. */
async function signIn(t: TestCtx, idp: Idp, claims: Record<string, unknown>, opts: { next?: string; state?: string; cookie?: string | null; link?: Record<string, string> } = {}) {
  const s = await start(t, opts.next, opts.link);
  idp.claims = { nonce: s.q.get('nonce'), ...claims };
  const headers: Record<string, string> = xff();
  if (opts.cookie !== null) headers.Cookie = opts.cookie ?? s.cookie;
  const r = await t.req('GET', `/api/v1/auth/oidc/callback?code=the-code&state=${encodeURIComponent(opts.state ?? s.q.get('state')!)}`, { headers });
  return { r, s };
}

const sessionCookie = (r: Res) =>
  (r.headers.get('set-cookie') ?? '')
    .split(/,(?=\s*\w+=)/)
    .map((c) => c.trim())
    .find((c) => c.startsWith('scp_sid='));

async function expectErrorPage(r: Res, status: number, text: RegExp) {
  assert.equal(r.status, status, r.text);
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  assert.match(r.text, /<h1>Sign-in failed<\/h1>/);
  assert.match(r.text, text);
  assert.doesNotMatch(r.text, /\bat .*\.ts:\d+/); // no stack trace
  assert.equal(sessionCookie(r), undefined);
}

/** A callback that parked the identity for password confirmation (59b0): 302 to /login/link?t=, the binding cookie, no session. */
function pendingOf(r: Res) {
  assert.equal(r.status, 302, r.text);
  const loc = new URL(r.headers.get('location')!, 'http://app.test');
  assert.equal(loc.pathname, '/login/link');
  const token = loc.searchParams.get('t')!;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const cookie = (r.headers.get('set-cookie') ?? '')
    .split(/,(?=\s*\w+=)/)
    .map((c) => c.trim())
    .find((c) => c.startsWith('scp_oidc_link='))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/api\/v1\/auth\/oidc\/link/);
  assert.match(cookie, /Max-Age=300/);
  assert.equal(sessionCookie(r), undefined, 'no session before the password is proven');
  return { token, headers: { Cookie: cookie.split(';')[0], ...xff() } };
}

const confirmLink = (t: TestCtx, pend: { token: string; headers: Record<string, string> }, password: string) =>
  t.req('POST', '/api/v1/auth/oidc/link/confirm', { headers: pend.headers, json: { token: pend.token, password } });

// node:sqlite rows have a null prototype; spread them so deepEqual compares plain objects.
const users = (t: TestCtx) =>
  (t.db.prepare('SELECT username, email, password_hash, oidc_issuer, oidc_sub FROM users ORDER BY created_at, id').all() as any[]).map((r) => ({ ...r }));

// ---------- tests ----------

test('start is 404 and config says disabled when OIDC is not configured', async () => {
  const t = makeTestCtx();
  const r = await t.req('GET', '/api/v1/auth/oidc/start');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'not_found');
  assert.equal((await t.req('GET', '/api/v1/auth/oidc/callback?code=x&state=y')).status, 404);
  assert.deepEqual((await t.req('GET', '/api/v1/auth/config')).json.oidc, { enabled: false, label: '' });
  // issuer + client id without a secret is still not configured
  const half = makeTestCtx({ SCP_OIDC_ISSUER: 'http://idp.test', SCP_OIDC_CLIENT_ID: 'x' });
  assert.equal((await half.req('GET', '/api/v1/auth/oidc/start')).status, 404);
});

test('start redirects to the authorization endpoint with PKCE, state and nonce; config carries the default label', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  assert.deepEqual((await t.req('GET', '/api/v1/auth/config')).json.oidc, { enabled: true, label: 'Single sign-on' });
  const { q, loc } = await start(t, '/groups/x');
  assert.equal(loc.origin + loc.pathname, `${idp.issuer}/authorize`);
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), 'scp-client');
  assert.equal(q.get('redirect_uri'), 'http://app.test/api/v1/auth/oidc/callback');
  assert.equal(q.get('scope'), 'openid email profile');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('state')!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.get('nonce')!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
});

test('happy path: a new user is auto-registered, gets the login cookie and lands on next', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const { r, s } = await signIn(t, idp, { sub: 'alice-sub', email: 'Alice@Corp.io', email_verified: true, preferred_username: 'Alice' }, { next: '/items?x=1' });
  assert.equal(r.status, 302, r.text);
  assert.equal(r.headers.get('location'), '/items?x=1');
  const sc = sessionCookie(r)!;
  assert.match(sc, /^scp_sid=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Max-Age=2592000/);
  assert.doesNotMatch(sc, /Secure/);
  // state cookie cleared
  assert.match(r.headers.get('set-cookie')!, /scp_oidc=;/);

  // the token exchange carried the code, the client credentials as HTTP Basic (RFC 6749 2.3.1, the
  // discovery default), never beside them in the body, and a verifier matching the challenge
  const tr = idp.tokenRequests.at(-1)!;
  assert.equal(tr.get('grant_type'), 'authorization_code');
  assert.equal(tr.get('code'), 'the-code');
  assert.equal(tr.get('client_id'), 'scp-client');
  assert.equal(tr.get('client_secret'), null);
  assert.equal(tr.get('_authorization'), BASIC);
  assert.equal(tr.get('redirect_uri'), 'http://app.test/api/v1/auth/oidc/callback');
  assert.equal(createHash('sha256').update(tr.get('code_verifier')!).digest('base64url'), s.q.get('code_challenge'));

  const me = await t.req('GET', '/api/v1/auth/me', { headers: { Cookie: sc.split(';')[0] } });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.username, 'alice');
  assert.equal(me.json.user.email, 'Alice@Corp.io');
  assert.equal(me.json.user.isAdmin, false);
  assert.deepEqual(users(t), [{ username: 'alice', email: 'Alice@Corp.io', password_hash: OIDC_PASSWORD_HASH, oidc_issuer: idp.issuer, oidc_sub: 'alice-sub' }]);

  const actions = t.db.prepare('SELECT action, detail FROM audit ORDER BY id').all() as { action: string; detail: string }[];
  assert.deepEqual(actions.map((a) => a.action), ['user.register', 'login']);
  assert.equal(JSON.parse(actions[1].detail).via, 'oidc');

  // password login can never work for an OIDC-only account
  assert.equal(await verifyLogin(t.db, 'alice', OIDC_PASSWORD_HASH), null);
  const pw = await t.req('POST', '/api/v1/auth/login', { json: { login: 'alice', password: OIDC_PASSWORD_HASH } });
  assert.equal(pw.status, 401);
});

test('existing (issuer, sub) signs in without creating or changing anything', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const u = t.createUser({ username: 'bob' });
  t.db.prepare('UPDATE users SET oidc_issuer = ?, oidc_sub = ? WHERE id = ?').run(idp.issuer, 'bob-sub', u.id);
  // a different email claim does not matter once the sub is linked
  const { r } = await signIn(t, idp, { sub: 'bob-sub', email: 'other@x.io', email_verified: true, preferred_username: 'someone' });
  assert.equal(r.status, 302, r.text);
  assert.equal(r.headers.get('location'), '/items');
  const me = await t.req('GET', '/api/v1/auth/me', { headers: { Cookie: sessionCookie(r)!.split(';')[0] } });
  assert.equal(me.json.user.id, u.id);
  assert.equal(users(t).length, 1);
  assert.equal(users(t)[0].email, 'bob@example.com');
});

test('a password account is never linked by email from the callback; its owner links it from a signed-in session', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const u = t.createUser({ username: 'carol' });
  const un = await signIn(t, idp, { sub: 'carol-sub', email: 'CAROL@example.com', email_verified: false });
  await expectErrorPage(un.r, 403, /no usable email/);
  assert.equal(users(t)[0].oidc_sub, null);

  // A verified email alone is not ownership of the local account (anyone may have registered it first): it asks for the password.
  const byEmail = await signIn(t, idp, { sub: 'carol-sub', email: 'CAROL@example.com', email_verified: true });
  pendingOf(byEmail.r);
  assert.equal(users(t)[0].oidc_sub, null);
  assert.equal(users(t).length, 1);

  // Linking needs the browser session, and starts from a POST only (csrf: a GET rides the Lax cookie).
  const anon = await t.req('POST', '/api/v1/auth/oidc/link', { json: {} });
  assert.equal(anon.status, 401, anon.text);
  assert.match(anon.json.error.message, /sign in first/);
  const viaKey = await t.req('POST', '/api/v1/auth/oidc/link', { headers: t.key(u).headers, json: {} });
  assert.equal(viaKey.status, 401);
  // A signed-in GET /start?link=1 (what a hostile page can navigate the victim to) is a plain sign-in: it never reaches link().
  const navigated = await t.req('GET', '/api/v1/auth/oidc/start?link=1&next=/', { headers: t.session(u) });
  assert.equal(navigated.status, 302, navigated.text);
  const q = new URL(navigated.headers.get('location')!).searchParams;
  idp.claims = { nonce: q.get('nonce'), sub: 'attacker-sub', email: 'carol@example.com', email_verified: true };
  const cb = await t.req('GET', `/api/v1/auth/oidc/callback?code=c&state=${q.get('state')}`, { headers: { Cookie: cookieOf(navigated) } });
  pendingOf(cb); // the password confirmation, which the attacker cannot pass
  assert.equal(users(t)[0].oidc_sub, null, 'nothing was linked');
  const { r } = await signIn(t, idp, { sub: 'carol-sub', email: 'other@idp.io', email_verified: true }, { link: t.session(u), next: '/keys' });
  assert.equal(r.status, 302, r.text);
  assert.equal(r.headers.get('location'), '/keys');
  const me = await t.req('GET', '/api/v1/auth/me', { headers: { Cookie: sessionCookie(r)!.split(';')[0] } });
  assert.equal(me.json.user.id, u.id);
  const row = users(t)[0];
  assert.equal(row.oidc_issuer, idp.issuer);
  assert.equal(row.oidc_sub, 'carol-sub');
  assert.equal(row.email, 'carol@example.com', 'the email claim does not rewrite the account');
  assert.equal(users(t).length, 1);
  assert.ok(t.db.prepare("SELECT 1 FROM audit WHERE action = 'user.oidc_link' AND target_id = ?").get(u.id));
  // password login still works for a linked account, and the linked identity signs in without a session
  assert.equal((await t.req('POST', '/api/v1/auth/login', { json: { login: 'carol', password: u.password } })).status, 200);
  const again = await signIn(t, idp, { sub: 'carol-sub' });
  assert.equal(again.r.status, 302, again.r.text);
  // linking again is a no-op; linking a second identity, or an identity another account holds, is refused
  assert.equal((await signIn(t, idp, { sub: 'carol-sub' }, { link: t.session(u) })).r.status, 302);
  await expectErrorPage((await signIn(t, idp, { sub: 'carol-2' }, { link: t.session(u) })).r, 403, /already linked to a different identity/);
  const dan = t.createUser({ username: 'dan' });
  await expectErrorPage((await signIn(t, idp, { sub: 'carol-sub' }, { link: t.session(dan) })).r, 403, /already linked to another account/);
  assert.equal(users(t).find((x) => x.username === 'dan').oidc_sub, null);
  // another identity claiming the same verified email is refused
  const other = await signIn(t, idp, { sub: 'impostor', email: 'carol@example.com', email_verified: true });
  await expectErrorPage(other.r, 403, /different identity/);
});

test('pre-hijack: a self-registered account holding the victim email is not handed to the first SSO login', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  // The attacker registers the victim's address with their own password before the victim ever signs in.
  const reg = await t.req('POST', '/api/v1/auth/register', { json: { email: 'victim@corp.com', username: 'attacker', password: 'attacker-pw-1' } });
  assert.equal(reg.status, 201, reg.text);
  const { r } = await signIn(t, idp, { sub: 'victim-sub', email: 'victim@corp.com', email_verified: true, preferred_username: 'victim' });
  // The victim lands on the confirm screen and does not know the attacker's password: nothing links.
  const pend = pendingOf(r);
  const guess = await confirmLink(t, pend, 'victim-guess-1');
  assert.equal(guess.status, 401, guess.text);
  assert.deepEqual(users(t).map((x) => [x.username, x.oidc_sub]), [['attacker', null]]);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'user.oidc_link'").get() as { n: number }).n, 0);
});

test('auto-register slugifies the username and suffixes -2, -3 on a clash', async () => {
  assert.equal(usernameBase('Alice'), 'alice');
  assert.equal(usernameBase('José García'), 'jose-garcia');
  assert.equal(usernameBase('--x'), 'x0');
  assert.equal(usernameBase('!!!'), 'user');
  assert.equal(usernameBase('a'.repeat(50)).length, 32);

  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  t.createUser({ username: 'dave' });
  t.createUser({ username: 'dave-2' });
  const { r } = await signIn(t, idp, { sub: 's1', email: 'dave@corp.io', email_verified: true, preferred_username: 'Dave' });
  assert.equal(r.status, 302, r.text);
  assert.equal(users(t).at(-1).username, 'dave-3');
  // no preferred_username: the email local part, slugified
  const r2 = await signIn(t, idp, { sub: 's2', email: 'Erin.O+tag@corp.io' });
  assert.equal(r2.r.status, 302, r2.r.text);
  assert.equal(users(t).at(-1).username, 'erin-o-tag');
  // a 32-char base leaves room for the suffix
  const long = 'f'.repeat(40);
  await signIn(t, idp, { sub: 's3', email: `${long}@corp.io` });
  const r3 = await signIn(t, idp, { sub: 's4', email: `${long}@other.io` });
  assert.equal(r3.r.status, 302, r3.r.text);
  assert.equal(users(t).at(-1).username, 'f'.repeat(30) + '-2');
});

test('auto_register off is a 403 page for an unknown identity', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp, { SCP_OIDC_AUTO_REGISTER: 'false' }));
  const { r } = await signIn(t, idp, { sub: 'nobody', email: 'nobody@corp.io', email_verified: true });
  await expectErrorPage(r, 403, /no SCP account is linked/);
  assert.equal(users(t).length, 0);
  // a linked user still gets in
  const u = t.createUser({ username: 'frank' });
  t.db.prepare('UPDATE users SET oidc_issuer = ?, oidc_sub = ? WHERE id = ?').run(idp.issuer, 'frank-sub', u.id);
  assert.equal((await signIn(t, idp, { sub: 'frank-sub' })).r.status, 302);
});

test('a disabled user gets a 403 page and no session', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const u = t.createUser({ username: 'gina', disabled: true });
  t.db.prepare('UPDATE users SET oidc_issuer = ?, oidc_sub = ? WHERE id = ?').run(idp.issuer, 'gina-sub', u.id);
  const { r } = await signIn(t, idp, { sub: 'gina-sub' });
  await expectErrorPage(r, 403, /disabled/);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0);
});

test('an email taken by an unverified or other account cannot be auto-registered', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  t.createUser({ username: 'hank' }); // hank@example.com
  const { r } = await signIn(t, idp, { sub: 'hank-2', email: 'hank@example.com' }); // no email_verified claim: register path, not link
  await expectErrorPage(r, 403, /already exists/);
  assert.equal(users(t).length, 1);
});

test('id_token validation: nonce, signature, expiry, iat, audience, issuer, alg', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const t0 = Math.floor(Date.now() / 1000);
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['nonce mismatch', { nonce: 'wrong' }, /nonce mismatch/],
    ['expired', { exp: t0 - 600 }, /expired/],
    ['iat too old', { iat: t0 - 900 }, /clock skew/],
    ['iat in the future', { iat: t0 + 900 }, /clock skew/],
    ['wrong aud', { aud: 'other-client' }, /wrong audience/],
    ['aud list without azp', { aud: ['scp-client', 'other'] }, /wrong audience/],
    ['wrong iss', { iss: 'http://evil.test' }, /wrong issuer/],
    ['no sub', { sub: undefined }, /bad claims/],
  ];
  for (const [name, claims, re] of cases) {
    const s = await start(t);
    idp.claims = { nonce: s.q.get('nonce'), ...claims };
    const r = await t.req('GET', `/api/v1/auth/oidc/callback?code=c&state=${s.q.get('state')}`, { headers: { Cookie: s.cookie } });
    await expectErrorPage(r, 403, re);
    assert.equal(users(t).length, 0, name);
  }
  // aud list with azp is fine
  const ok = await signIn(t, idp, { sub: 'azp-ok', aud: ['scp-client', 'other'], azp: 'scp-client', email: 'azp@x.io', email_verified: true });
  assert.equal(ok.r.status, 302, ok.r.text);

  // bad signature: signed by another key under the known kid
  idp.signWith = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const bad = await signIn(t, idp, { sub: 'forged', email: 'f@x.io', email_verified: true });
  await expectErrorPage(bad.r, 403, /bad signature/);
  idp.signWith = undefined;

  // unknown kid (after a JWKS refetch) and unsupported alg
  idp.kid = 'rotated-away';
  const kid = await signIn(t, idp, { sub: 'k' });
  await expectErrorPage(kid.r, 403, /unknown signing key/);
  idp.kid = 'k1';
  const s = await start(t);
  const none = `${b64({ alg: 'none' })}.${b64({ iss: idp.issuer, sub: 'x', aud: 'scp-client', exp: t0 + 300, iat: t0, nonce: s.q.get('nonce') })}.x`;
  // the fake IdP only mints signed tokens, so alg=none and junk go straight through verifyIdToken
  await assert.rejects(verifyIdToken({ issuer: idp.issuer, clientId: 'scp-client', clientSecret: 'shh', autoRegister: true, label: 'x' }, none, s.q.get('nonce')!), /unsupported alg/);
  await assert.rejects(verifyIdToken({ issuer: idp.issuer, clientId: 'scp-client', clientSecret: 'shh', autoRegister: true, label: 'x' }, 'not.a.jwt.at.all', 'n'), /not a compact JWS/);
});

test('ES256 id_tokens verify too', async () => {
  const idp = await startIdp('ES256');
  const t = makeTestCtx(env(idp));
  const { r } = await signIn(t, idp, { sub: 'ec-sub', email: 'ec@x.io', email_verified: true });
  assert.equal(r.status, 302, r.text);
  assert.equal(users(t)[0].oidc_sub, 'ec-sub');
});

test('state: missing cookie, mismatched state, reused cookie after expiry, IdP error, missing code', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const noCookie = await signIn(t, idp, { sub: 'x' }, { cookie: null });
  await expectErrorPage(noCookie.r, 400, /expired or did not start here/);
  const mismatch = await signIn(t, idp, { sub: 'x' }, { state: 'forged-state' });
  await expectErrorPage(mismatch.r, 400, /expired or did not start here/);
  // a cookie signed with another secret
  const other = makeTestCtx(env(idp));
  other.ctx.secret = 'other-secret';
  const foreign = await start(other);
  const forged = await t.req('GET', `/api/v1/auth/oidc/callback?code=c&state=${foreign.q.get('state')}`, { headers: { Cookie: foreign.cookie } });
  await expectErrorPage(forged, 400, /expired or did not start here/);
  assert.equal(idp.tokenRequests.length, 0, 'no token exchange without a valid state');

  const s = await start(t);
  const denied = await t.req('GET', `/api/v1/auth/oidc/callback?error=access_denied&state=${s.q.get('state')}`, { headers: { Cookie: s.cookie } });
  await expectErrorPage(denied, 403, /refused the sign-in \(access_denied\)/);
  const s2 = await start(t);
  const noCode = await t.req('GET', `/api/v1/auth/oidc/callback?state=${s2.q.get('state')}`, { headers: { Cookie: s2.cookie } });
  await expectErrorPage(noCode, 400, /sent no code/);
  assert.equal(users(t).length, 0);
});

test('token endpoint failures and malformed answers are a 502 page, never a stack', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  idp.tokenStatus = 400;
  const r = await signIn(t, idp, { sub: 'x' });
  await expectErrorPage(r.r, 502, /answered 400/);
  idp.tokenStatus = 200;
  // IdP down: a port nobody listens on, same discovery (cached) cannot be reached for the exchange
  const dead = await startIdp();
  const t2 = makeTestCtx(env(dead));
  await start(t2); // caches discovery
  dead.server.close();
  const s = await start(t2);
  dead.claims = {};
  const down = await t2.req('GET', `/api/v1/auth/oidc/callback?code=c&state=${s.q.get('state')}`, { headers: { Cookie: s.cookie } });
  await expectErrorPage(down, 502, /did not respond/);
});

test('endpointProblem: public https hosts off the issuer are fine (Google), plain http and internal addresses are not, unless the issuer is there', () => {
  const google = 'https://accounts.google.com';
  assert.equal(endpointProblem(google, 'https://oauth2.googleapis.com/token'), null);
  assert.equal(endpointProblem(google, 'https://www.googleapis.com/oauth2/v3/certs'), null);
  assert.equal(endpointProblem('https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_x', 'https://x.auth.eu-west-1.amazoncognito.com/oauth2/token'), null);
  for (const bad of [
    'http://oauth2.googleapis.com/token',
    'https://127.0.0.1/token',
    'https://localhost/token',
    'https://sub.localhost/token',
    'https://10.1.2.3/token',
    'https://172.16.0.9/token',
    'https://192.168.1.1/token',
    'https://169.254.169.254/latest/meta-data/',
    'https://0.0.0.0/token',
    'https://[::1]/token',
    'https://[::ffff:127.0.0.1]/token',
    'https://[fd00::1]/token',
    'https://[fe80::1]/token',
    'ftp://oauth2.googleapis.com/token',
  ]) {
    assert.ok(endpointProblem(google, bad), bad);
  }
  // A local or test issuer (http, loopback) may advertise local http endpoints, on another port too.
  assert.equal(endpointProblem('http://127.0.0.1:9000', 'http://127.0.0.1:9001/token'), null);
  assert.equal(endpointProblem('http://127.0.0.1:9000', 'https://keys.example/jwks'), null);
  assert.ok(endpointProblem('http://127.0.0.1:9000', 'ftp://127.0.0.1:9000/token'));
});

// The fake IdPs listen through listenLocal: a raw listen(0) that drew one of these ports turned a
// random test into a 502 "did not respond" page. This keeps the skip list honest against fetch.
test('every port listenLocal skips is one fetch refuses', async () => {
  for (const port of FETCH_BLOCKED_PORTS) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), (e: Error) => (e.cause as Error)?.message === 'bad port', `${port}`);
  }
});

test('discovery: endpoints on a second origin work (Google-shaped IdP); a scheme SCP will not fetch is refused at /start', async () => {
  const idp = await startIdp();
  const aux = await secondOrigin(idp);
  idp.discoveryPatch = { token_endpoint: `${aux}/token`, jwks_uri: `${aux}/jwks` };
  const t = makeTestCtx(env(idp));
  const { r } = await signIn(t, idp, { sub: 'g-sub', email: 'g@corp.io', email_verified: true });
  assert.equal(r.status, 302, r.text);
  assert.equal(users(t)[0].oidc_sub, 'g-sub');
  assert.ok(idp.tokenRequests.length > 0, 'the token exchange went to the second origin');

  clearOidcCache();
  idp.discoveryPatch = { token_endpoint: 'ftp://127.0.0.1:1/token' };
  await expectErrorPage(await t.req('GET', '/api/v1/auth/oidc/start'), 502, /will not contact.*not https/);
  clearOidcCache();
  idp.discoveryPatch = { authorization_endpoint: 'ftp://127.0.0.1:1/authorize' };
  await expectErrorPage(await t.req('GET', '/api/v1/auth/oidc/start'), 502, /will not contact.*not http\(s\)/);
});

test('discovery must name the configured issuer and be well formed', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  idp.discoveryPatch = { issuer: 'http://other.test' };
  const r2 = await t.req('GET', '/api/v1/auth/oidc/start');
  await expectErrorPage(r2, 502, /different issuer/);

  clearOidcCache();
  idp.discoveryPatch = { jwks_uri: 'not a url' };
  const r3 = await t.req('GET', '/api/v1/auth/oidc/start');
  await expectErrorPage(r3, 502, /discovery document is invalid/);

  // a configured issuer whose host is down
  const t4 = makeTestCtx(env(idp, { SCP_OIDC_ISSUER: 'http://127.0.0.1:1' }));
  await expectErrorPage(await t4.req('GET', '/api/v1/auth/oidc/start'), 502, /did not respond/);
});

test('discovery is cached across requests and for 10 minutes', async () => {
  const idp = await startIdp();
  let hits = 0;
  idp.server.prependListener('request', (req) => {
    if ((req.url ?? '').includes('openid-configuration')) hits++;
  });
  const t = makeTestCtx(env(idp));
  await start(t);
  await start(t);
  await signIn(t, idp, { sub: 'c', email: 'c@x.io', email_verified: true });
  assert.equal(hits, 1);
});

test('settings rows configure OIDC when env is unset; env fields override them', async () => {
  const idp = await startIdp();
  const t = makeTestCtx();
  const set = (k: string, v: string) => t.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  set('oidc.issuer', `${idp.issuer}/`);
  set('oidc.client_id', 'scp-client');
  assert.equal((await t.req('GET', '/api/v1/auth/oidc/start')).status, 404, 'no secret yet');
  set('oidc.client_secret', 'shh');
  set('oidc.label', 'Corp SSO');
  set('oidc.auto_register', 'false');
  assert.deepEqual((await t.req('GET', '/api/v1/auth/config')).json.oidc, { enabled: true, label: 'Corp SSO' });
  const off = await signIn(t, idp, { sub: 'z', email: 'z@x.io', email_verified: true });
  await expectErrorPage(off.r, 403, /no SCP account is linked/);
  set('oidc.auto_register', 'true');
  const on = await signIn(t, idp, { sub: 'z', email: 'z@x.io', email_verified: true });
  assert.equal(on.r.status, 302, on.r.text);
  assert.equal(idp.tokenRequests.at(-1)!.get('_authorization'), BASIC);
  // '' clears a setting
  set('oidc.client_secret', '');
  assert.equal((await t.req('GET', '/api/v1/auth/oidc/start')).status, 404);

  // env wins field by field over the rows
  const t2 = makeTestCtx({ SCP_OIDC_LABEL: 'Env SSO', SCP_OIDC_CLIENT_SECRET: 'env-secret', SCP_OIDC_AUTO_REGISTER: 'false' });
  const set2 = (k: string, v: string) => t2.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  set2('oidc.issuer', idp.issuer);
  set2('oidc.client_id', 'scp-client');
  set2('oidc.client_secret', 'row-secret');
  set2('oidc.label', 'Row SSO');
  set2('oidc.auto_register', 'true');
  assert.deepEqual((await t2.req('GET', '/api/v1/auth/config')).json.oidc, { enabled: true, label: 'Env SSO' });
  const r = await signIn(t2, idp, { sub: 'q', email: 'q@x.io', email_verified: true });
  await expectErrorPage(r.r, 403, /no SCP account/);
  assert.equal(idp.tokenRequests.at(-1)!.get('_authorization'), `Basic ${Buffer.from('scp-client:env-secret').toString('base64')}`);
});

test('next is confined to same-app paths', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  for (const [next, want] of [
    ['https://evil.test/x', '/'],
    ['//evil.test', '/'],
    ['/\\evil.test', '/'],
    ['/\\/evil.test/x', '/'],
    ['/\t/evil.test', '/'],
    // Dot segments collapse to a scheme-relative path: the origin stays ours, the browser's does not.
    ['/..//evil.test', '/'],
    ['/.//evil.test/x', '/'],
    ['/consent/..//evil.test', '/'],
    ['/ok?a=1', '/ok?a=1'],
    ['/ok?a=1#frag', '/ok?a=1#frag'],
    ['/a/../b', '/b'],
    ['', '/'],
  ]) {
    const { r } = await signIn(t, idp, { sub: `n-${want}`, email: `${Math.random()}@x.io`, email_verified: true }, { next });
    assert.equal(r.status, 302, r.text);
    assert.equal(r.headers.get('location'), want, next);
  }
});

// ---------- v2 review ----------

test('token exchange: HTTP Basic by default (an IdP that refuses body credentials works); client_secret_post only when the IdP lists that alone', async () => {
  const idp = await startIdp();
  idp.requireBasic = true;
  const t = makeTestCtx(env(idp));
  const { r } = await signIn(t, idp, { sub: 'b-sub', email: 'b@x.io', email_verified: true });
  assert.equal(r.status, 302, r.text);
  const tr = idp.tokenRequests.at(-1)!;
  assert.equal(tr.get('client_secret'), null);
  assert.equal(tr.get('_authorization'), BASIC);
  // The IdP lists client_secret_post only: credentials go in the body, no header.
  clearOidcCache();
  idp.requireBasic = false;
  idp.discoveryPatch = { token_endpoint_auth_methods_supported: ['client_secret_post'] };
  const r2 = await signIn(t, idp, { sub: 'b-sub' });
  assert.equal(r2.r.status, 302, r2.r.text);
  const tr2 = idp.tokenRequests.at(-1)!;
  assert.equal(tr2.get('client_secret'), 'shh');
  assert.equal(tr2.get('_authorization'), null);
  // Both listed: Basic.
  clearOidcCache();
  idp.discoveryPatch = { token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] };
  const r3 = await signIn(t, idp, { sub: 'b-sub' });
  assert.equal(r3.r.status, 302, r3.r.text);
  assert.equal(idp.tokenRequests.at(-1)!.get('client_secret'), null);
  assert.equal(idp.tokenRequests.at(-1)!.get('_authorization'), BASIC);
});

test('an admin password reset drops the single sign-on link, so an identity an intruder bound cannot sign back in; a link begun before the reset cannot finish after it', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp, { SCP_OIDC_AUTO_REGISTER: 'false' }));
  const admin = t.createUser({ username: 'root', isAdmin: true });
  const carol = t.createUser({ username: 'carol' });
  // Whoever holds a session can link: here an intruder binds their own IdP identity to carol's account.
  const linked = await signIn(t, idp, { sub: 'intruder-sub' }, { link: t.session(carol) });
  assert.equal(linked.r.status, 302, linked.r.text);
  const list = await t.req('GET', '/api/v1/users', { headers: t.session(admin) });
  assert.equal((list.json.users as { id: string; oidcLinked: boolean }[]).find((u) => u.id === carol.id)!.oidcLinked, true, 'admins can see that a link exists');
  // Recovery: the reset ends sessions, keys and grants, and the link with them.
  const reset = await t.req('PATCH', `/api/v1/users/${carol.id}`, { headers: t.session(admin), json: { password: 'new-password-1' } });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.json.user.oidcLinked, false);
  assert.equal(users(t).find((u) => u.username === 'carol').oidc_sub, null);
  const detail = JSON.parse((t.db.prepare("SELECT detail FROM audit WHERE action = 'user.update' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail);
  assert.equal(detail.oidcUnlinked, true);
  await expectErrorPage((await signIn(t, idp, { sub: 'intruder-sub' })).r, 403, /no SCP account is linked/);
  // A link begun before the reset: the callback checks that the session which asked is still alive, before any exchange.
  const dan = t.createUser({ username: 'dan' });
  const s = await start(t, '/', t.session(dan));
  assert.equal((await t.req('PATCH', `/api/v1/users/${dan.id}`, { headers: t.session(admin), json: { password: 'new-password-2' } })).status, 200);
  idp.claims = { nonce: s.q.get('nonce'), sub: 'late-sub' };
  const before = idp.tokenRequests.length;
  const cb = await t.req('GET', `/api/v1/auth/oidc/callback?code=c&state=${s.q.get('state')}`, { headers: { Cookie: s.cookie, ...xff() } });
  await expectErrorPage(cb, 403, /session that started this link has ended/);
  assert.equal(users(t).find((u) => u.username === 'dan').oidc_sub, null);
  assert.equal(idp.tokenRequests.length, before, 'no token exchange for a dead link');
});

test('unlink: an admin drops a link with PATCH {oidcUnlink}, a user from the account menu; an OIDC-only account keeps its link until it has a password', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const admin = t.createUser({ username: 'root', isAdmin: true });
  const erin = t.createUser({ username: 'erin' });
  assert.equal((await signIn(t, idp, { sub: 'erin-sub' }, { link: t.session(erin) })).r.status, 302);
  const un = await t.req('PATCH', `/api/v1/users/${erin.id}`, { headers: t.session(admin), json: { oidcUnlink: true } });
  assert.equal(un.status, 200, un.text);
  assert.equal(un.json.user.oidcLinked, false);
  assert.equal(JSON.parse((t.db.prepare("SELECT detail FROM audit WHERE action = 'user.update' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail).oidcUnlinked, true);
  assert.equal(users(t).find((u) => u.username === 'erin').oidc_sub, null);
  assert.ok(t.db.prepare('SELECT 1 FROM sessions WHERE user_id = ?').get(erin.id), 'an unlink alone keeps her sessions');
  // She relinks, then unlinks herself; the link is not a recovery path, so it needs the session and nothing else.
  assert.equal((await signIn(t, idp, { sub: 'erin-sub' }, { link: t.session(erin) })).r.status, 302);
  assert.equal((await t.req('POST', '/api/v1/auth/oidc/unlink', { json: {} })).status, 401);
  assert.equal((await t.req('POST', '/api/v1/auth/oidc/unlink', { headers: t.key(erin).headers, json: {} })).status, 401);
  const self = await t.req('POST', '/api/v1/auth/oidc/unlink', { headers: t.session(erin), json: {} });
  assert.equal(self.status, 204, self.text);
  assert.equal(users(t).find((u) => u.username === 'erin').oidc_sub, null);
  assert.ok(t.db.prepare("SELECT 1 FROM audit WHERE action = 'user.oidc_unlink' AND target_id = ?").get(erin.id));
  const twice = await t.req('POST', '/api/v1/auth/oidc/unlink', { headers: t.session(erin), json: {} });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.error.code, 'not_linked');
  // The identity signing in again finds a password account with that email: never linked from the callback alone, it asks for the password.
  pendingOf((await signIn(t, idp, { sub: 'erin-sub', email: erin.email, email_verified: true })).r);
  assert.equal(users(t).find((u) => u.username === 'erin').oidc_sub, null);
  // An auto-registered account has no password: unlinking it would leave it unreachable.
  assert.equal((await signIn(t, idp, { sub: 'frank-sub', email: 'frank@x.io', email_verified: true })).r.status, 302);
  const frankId = (t.db.prepare('SELECT id FROM users WHERE email = ?').get('frank@x.io') as { id: string }).id;
  const no = await t.req('POST', '/api/v1/auth/oidc/unlink', { headers: t.session({ id: frankId, username: 'frank', email: 'frank@x.io', password: '', isAdmin: false }), json: {} });
  assert.equal(no.status, 409, no.text);
  assert.equal(no.json.error.code, 'no_password');
  assert.equal((await t.req('PATCH', `/api/v1/users/${frankId}`, { headers: t.session(admin), json: { oidcUnlink: true } })).status, 409);
  // With a password in the same request it is fine, and frank signs in with it.
  const both = await t.req('PATCH', `/api/v1/users/${frankId}`, { headers: t.session(admin), json: { oidcUnlink: true, password: 'frank-password-1' } });
  assert.equal(both.status, 200, both.text);
  assert.equal(both.json.user.oidcLinked, false);
  assert.equal((await t.req('POST', '/api/v1/auth/login', { json: { login: 'frank', password: 'frank-password-1' } })).status, 200);
});

test('start and callback share the anonymous per-IP bucket: a replayed state cannot drive token exchanges at any rate', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const ip = { 'X-Forwarded-For': '203.0.113.77' };
  const s = await t.req('GET', '/api/v1/auth/oidc/start', { headers: ip });
  assert.equal(s.status, 302, s.text);
  const q = new URL(s.headers.get('location')!).searchParams;
  idp.claims = { nonce: q.get('nonce'), sub: 'replay', email: 'r@x.io', email_verified: true };
  const before = idp.tokenRequests.length;
  let ok = 0;
  let status = 0;
  for (let i = 0; i < 25 && status !== 429; i++) {
    status = (await t.req('GET', `/api/v1/auth/oidc/callback?code=c&state=${q.get('state')}`, { headers: { Cookie: cookieOf(s), ...ip } })).status;
    if (status === 302) ok++;
  }
  assert.equal(status, 429);
  assert.ok(ok >= 19 && ok <= 20, `${ok} callbacks went through before the bucket emptied`);
  assert.equal(idp.tokenRequests.length - before, ok, 'the limiter runs before the outbound exchange');
  await expectErrorPage(await t.req('GET', `/api/v1/auth/oidc/callback?code=c&state=${q.get('state')}`, { headers: { Cookie: cookieOf(s), ...ip } }), 429, /too many attempts/);
  // Another address is unaffected.
  assert.equal((await t.req('GET', '/api/v1/auth/oidc/start', { headers: { 'X-Forwarded-For': '203.0.113.78' } })).status, 302);
});

// ---------- v3: break-glass password (0nhr) ----------

/** Sign a new SSO-only account in; its session cookie (with the Origin a browser sends) and its id. */
async function ssoUser(t: TestCtx, idp: Idp, sub: string) {
  const { r } = await signIn(t, idp, { sub, email: `${sub}@corp.io`, email_verified: true });
  assert.equal(r.status, 302, r.text);
  const id = (t.db.prepare('SELECT id FROM users WHERE oidc_sub = ?').get(sub) as { id: string }).id;
  return { id, headers: { Cookie: sessionCookie(r)!.split(';')[0], Origin: 'http://app.test' } };
}

const setPassword = (t: TestCtx, headers: Record<string, string>, next = 'break-glass-1') => t.req('POST', '/api/v1/auth/password', { headers, json: { next } });

test('break-glass: an SSO-only account sets a password without current from a fresh SSO session; both logins then work and other sessions end', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const a = await ssoUser(t, idp, 'bg-sub');
  const other = await ssoUser(t, idp, 'bg-sub'); // a second SSO session of the same account
  assert.equal(other.id, a.id);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: a.headers })).json.hasPassword, false);
  // Before: unlinking an account without a password is refused.
  assert.equal((await t.req('POST', '/api/v1/auth/oidc/unlink', { headers: a.headers, json: {} })).status, 409);

  const r = await setPassword(t, a.headers);
  assert.equal(r.status, 204, r.text);
  const detail = JSON.parse((t.db.prepare("SELECT detail FROM audit WHERE action = 'user.password' AND target_id = ?").get(a.id) as { detail: string }).detail);
  assert.deepEqual(detail, { via: 'oidc-set' });
  const me = await t.req('GET', '/api/v1/auth/me', { headers: a.headers });
  assert.equal(me.status, 200, 'this session survives');
  assert.equal(me.json.hasPassword, true);
  assert.equal(me.json.user.oidcLinked, true, 'the SSO link stays');
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: other.headers })).status, 401, 'other sessions are ended');
  // Password login works, SSO login still works.
  const pw = await t.req('POST', '/api/v1/auth/login', { json: { login: 'bg-sub@corp.io', password: 'break-glass-1' } });
  assert.equal(pw.status, 200, pw.text);
  assert.equal(pw.json.user.id, a.id);
  assert.equal((await ssoUser(t, idp, 'bg-sub')).id, a.id);
  // Now it has a password: setting another needs current, and unlinking no longer 409s.
  const again = await setPassword(t, a.headers, 'another-one-1');
  assert.equal(again.status, 400, again.text);
  assert.equal((await t.req('POST', '/api/v1/auth/login', { json: { login: 'bg-sub@corp.io', password: 'another-one-1' } })).status, 401);
  const un = await t.req('POST', '/api/v1/auth/oidc/unlink', { headers: a.headers, json: {} });
  assert.equal(un.status, 204, un.text);
});

test('break-glass: refused from an SSO session older than 10 minutes, a password-login session and an API key', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const a = await ssoUser(t, idp, 'stale-sub');
  const hashOf = () => (t.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(a.id) as { password_hash: string }).password_hash;
  const age = (min: number) => t.db.prepare('UPDATE sessions SET created_at = ? WHERE user_id = ?').run(new Date(Date.now() - min * 60_000).toISOString(), a.id);
  age(11);
  const stale = await setPassword(t, a.headers);
  assert.equal(stale.status, 400, stale.text);
  assert.equal(stale.json.error.code, 'reauth_required');
  assert.equal(hashOf(), OIDC_PASSWORD_HASH);
  // A session not created by the SSO callback (here inserted directly, as a password login would) does not count, however fresh.
  const tu = { id: a.id, username: 'stale-sub', email: 'stale-sub@corp.io', password: '', isAdmin: false };
  assert.equal((await setPassword(t, t.session(tu))).json.error.code, 'reauth_required');
  const viaKey = await setPassword(t, t.key(tu).headers);
  assert.equal(viaKey.status, 403, viaKey.text);
  assert.equal(hashOf(), OIDC_PASSWORD_HASH);
  // Inside the window it works.
  age(9);
  assert.equal((await setPassword(t, a.headers)).status, 204);
  assert.notEqual(hashOf(), OIDC_PASSWORD_HASH);
});

// ---------- v3: link to a password account after confirming its password (59b0) ----------

const pendingRows = (t: TestCtx) => (t.db.prepare('SELECT COUNT(*) AS n FROM oidc_pending_links').get() as { n: number }).n;

test('link confirm: a first SSO sign-in matching a password account lands on the confirm screen; the right password links and signs in; the next SSO sign-in goes straight through', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const u = t.createUser({ username: 'carol' });
  const { r } = await signIn(t, idp, { sub: 'carol-sub', email: 'CAROL@example.com', email_verified: true }, { next: '/keys' });
  const pend = pendingOf(r);
  assert.equal(users(t)[0].oidc_sub, null);
  // Only the token's hash is stored.
  const stored = t.db.prepare('SELECT token_hash, user_id, sub, next FROM oidc_pending_links').get() as Record<string, string>;
  assert.deepEqual({ ...stored }, { token_hash: createHash('sha256').update(pend.token).digest('hex'), user_id: u.id, sub: 'carol-sub', next: '/keys' });
  const info = await t.req('GET', `/api/v1/auth/oidc/link/pending?t=${pend.token}`, { headers: pend.headers });
  assert.equal(info.status, 200, info.text);
  assert.deepEqual(info.json, { email: 'carol@example.com', username: 'carol' });

  const ok = await confirmLink(t, pend, u.password);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.user.id, u.id);
  assert.equal(ok.json.user.oidcLinked, true);
  assert.equal(ok.json.next, '/keys');
  assert.match(ok.headers.get('set-cookie')!, /scp_oidc_link=;/, 'the binding cookie is cleared');
  const me = await t.req('GET', '/api/v1/auth/me', { headers: { Cookie: sessionCookie(ok)!.split(';')[0] } });
  assert.equal(me.json.user.id, u.id);
  const row = users(t)[0];
  assert.equal(row.oidc_issuer, idp.issuer);
  assert.equal(row.oidc_sub, 'carol-sub');
  const link = t.db.prepare("SELECT detail FROM audit WHERE action = 'user.oidc_link' AND target_id = ?").get(u.id) as { detail: string };
  assert.deepEqual(JSON.parse(link.detail), { via: 'callback-confirm' });
  assert.equal(pendingRows(t), 0, 'single use');
  // Reused: 400, and nothing changes.
  const reused = await confirmLink(t, pend, u.password);
  assert.equal(reused.status, 400, reused.text);
  assert.equal(reused.json.error.code, 'bad_link_token');
  // The next SSO sign-in finds the identity by (issuer, sub) and signs straight in.
  const again = await signIn(t, idp, { sub: 'carol-sub', email: 'carol@example.com', email_verified: true });
  assert.equal(again.r.status, 302, again.r.text);
  assert.equal(again.r.headers.get('location'), '/items');
  assert.ok(sessionCookie(again.r));
  assert.equal(pendingRows(t), 0);
});

test('link confirm: a wrong password is invalid_credentials and links nothing; 5 failures kill the token', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const u = t.createUser({ username: 'dave' });
  const pend = pendingOf((await signIn(t, idp, { sub: 'dave-sub', email: u.email, email_verified: true })).r);
  for (let i = 0; i < 5; i++) {
    const bad = await confirmLink(t, pend, `wrong-${i}`);
    assert.equal(bad.status, 401, bad.text);
    assert.deepEqual(bad.json, { error: { code: 'invalid_credentials', message: 'invalid login or password' } });
    assert.equal(sessionCookie(bad), undefined);
  }
  const dead = await confirmLink(t, pend, u.password);
  assert.equal(dead.status, 400, dead.text);
  assert.equal(dead.json.error.code, 'bad_link_token');
  assert.equal(users(t)[0].oidc_sub, null);
  // Four misses leave the fifth attempt: the right password still links.
  const pend2 = pendingOf((await signIn(t, idp, { sub: 'dave-sub', email: u.email, email_verified: true })).r);
  for (let i = 0; i < 4; i++) assert.equal((await confirmLink(t, pend2, `wrong-${i}`)).status, 401);
  assert.equal((await confirmLink(t, pend2, u.password)).status, 200);
  assert.equal(users(t)[0].oidc_sub, 'dave-sub');
});

test('link confirm: an expired, reused, forged or other-browser token is 400 and links nothing', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const u = t.createUser({ username: 'erin' });
  const pend = pendingOf((await signIn(t, idp, { sub: 'erin-sub', email: u.email, email_verified: true })).r);
  const refused = async (r: Res) => {
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error.code, 'bad_link_token');
    assert.equal(users(t)[0].oidc_sub, null);
  };
  // Forged: a token the server never issued, with a matching cookie.
  const forged = randomBytes(32).toString('base64url');
  await refused(await confirmLink(t, { token: forged, headers: { Cookie: `scp_oidc_link=${forged}`, ...xff() } }, u.password));
  // The URL token from another browser (no binding cookie, or another one).
  await refused(await confirmLink(t, { token: pend.token, headers: xff() }, u.password));
  await refused(await confirmLink(t, { token: pend.token, headers: { Cookie: `scp_oidc_link=${forged}`, ...xff() } }, u.password));
  await refused(await t.req('GET', `/api/v1/auth/oidc/link/pending?t=${pend.token}`, { headers: xff() }));
  // Expired.
  t.db.prepare('UPDATE oidc_pending_links SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  await refused(await t.req('GET', `/api/v1/auth/oidc/link/pending?t=${pend.token}`, { headers: pend.headers }));
  await refused(await confirmLink(t, pend, u.password));
  // An expired row is swept by the next parked sign-in; reuse after a success is refused.
  const pend2 = pendingOf((await signIn(t, idp, { sub: 'erin-sub', email: u.email, email_verified: true })).r);
  assert.equal(pendingRows(t), 1);
  assert.equal((await confirmLink(t, pend2, u.password)).status, 200);
  const reused = await confirmLink(t, pend2, u.password);
  assert.equal(reused.status, 400, reused.text);
  assert.equal(reused.json.error.code, 'bad_link_token');
});

test('link confirm: an unverified email never reaches it; an account linked to another identity keeps the 403; a disabled account cannot be linked', async () => {
  const idp = await startIdp();
  const t = makeTestCtx(env(idp));
  const frank = t.createUser({ username: 'frank' });
  await expectErrorPage((await signIn(t, idp, { sub: 'f1', email: frank.email, email_verified: false })).r, 403, /no usable email/);
  await expectErrorPage((await signIn(t, idp, { sub: 'f1', email: frank.email })).r, 403, /already exists/);
  assert.equal(pendingRows(t), 0);

  t.db.prepare('UPDATE users SET oidc_issuer = ?, oidc_sub = ? WHERE id = ?').run(idp.issuer, 'frank-old', frank.id);
  await expectErrorPage((await signIn(t, idp, { sub: 'f2', email: frank.email, email_verified: true })).r, 403, /different identity/);
  assert.equal(pendingRows(t), 0);

  const gina = t.createUser({ username: 'gina', disabled: true });
  await expectErrorPage((await signIn(t, idp, { sub: 'g1', email: gina.email, email_verified: true })).r, 403, /disabled/);
  assert.equal(pendingRows(t), 0);
  // Disabled between the callback and the confirmation: the password check refuses it.
  const hank = t.createUser({ username: 'hank' });
  const pend = pendingOf((await signIn(t, idp, { sub: 'h1', email: hank.email, email_verified: true })).r);
  t.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(hank.id);
  const r = await confirmLink(t, pend, hank.password);
  assert.equal(r.status, 401, r.text);
  assert.equal(sessionCookie(r), undefined);
  assert.equal(users(t).find((x) => x.username === 'hank').oidc_sub, null);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'user.oidc_link'").get() as { n: number }).n, 0);
});
