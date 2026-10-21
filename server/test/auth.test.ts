import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertGroup, makeTestCtx, type Res, type TestCtx, type TestUser } from './helpers.ts';
import { otherEnabledAdmins } from '../src/auth/service.ts';

// Browsers send Origin on POST/DELETE; the C0 csrf check rejects body-less cookie requests without it.
const ORIGIN = { Origin: 'http://app.test' };
const cookieOf = (r: Res) => ({ Cookie: r.headers.get('set-cookie')!.split(';')[0], ...ORIGIN });
const sess = (t: TestCtx, u: TestUser) => ({ ...t.session(u), ...ORIGIN });

async function login(t: TestCtx, loginName: string, password = 'password123') {
  return t.req('POST', '/api/v1/auth/login', { json: { login: loginName, password } });
}

async function newKey(t: TestCtx, u: TestUser, json: object = { name: 'k', scopes: ['read', 'write'] }) {
  return t.req('POST', '/api/v1/keys', { headers: sess(t, u), json });
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test('register logs you in with a hardened cookie', async () => {
  const t = makeTestCtx();
  const r = await t.req('POST', '/api/v1/auth/register', { json: { email: 'a@x.io', username: 'Alice', password: 'longenough' } });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.json.user).sort(), ['createdAt', 'disabled', 'email', 'id', 'isAdmin', 'username']);
  assert.equal(r.json.user.username, 'alice');
  assert.equal(r.json.user.isAdmin, false);
  const sc = r.headers.get('set-cookie')!;
  assert.match(sc, /^scp_sid=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Max-Age=2592000/);
  assert.doesNotMatch(sc, /Secure/);
  const me = await t.req('GET', '/api/v1/auth/me', { headers: cookieOf(r) });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, r.json.user.id);
  assert.deepEqual(me.json.principal, { via: 'session', scopes: ['read', 'write'], groupIds: null });
  assert.equal((await t.req('GET', '/api/v1/auth/me')).status, 401);
});

test('registration disabled returns 403 registration_disabled; config reflects it', async () => {
  const t = makeTestCtx({ SCP_ALLOW_REGISTRATION: 'false' });
  const r = await t.req('POST', '/api/v1/auth/register', { json: { email: 'a@x.io', username: 'alice', password: 'longenough' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'registration_disabled');
  const cfg = await t.req('GET', '/api/v1/auth/config');
  assert.deepEqual(cfg.json, {
    registration: false,
    publicUrl: 'http://app.test',
    artifactUrl: 'http://art.test',
    artifactOrigin: 'http://art.test',
  });
});

test('duplicate username or email is 409, case-insensitively', async () => {
  const t = makeTestCtx();
  t.createUser({ username: 'bob' });
  const dupName = await t.req('POST', '/api/v1/auth/register', { json: { email: 'new@x.io', username: 'BOB', password: 'longenough' } });
  assert.equal(dupName.status, 409);
  const dupEmail = await t.req('POST', '/api/v1/auth/register', { json: { email: 'BOB@example.com', username: 'bobby', password: 'longenough' } });
  assert.equal(dupEmail.status, 409);
});

test('register validation is 400', async () => {
  const t = makeTestCtx();
  const bad = [
    { email: 'not-an-email', username: 'alice', password: 'longenough' },
    { email: 'a@x.io', username: 'a', password: 'longenough' },
    { email: 'a@x.io', username: '-alice', password: 'longenough' },
    { email: 'a@x.io', username: 'al ice', password: 'longenough' },
    { email: 'a@x.io', username: 'alice', password: 'short' },
    { email: 'a@x.io', username: 'alice', password: 'x'.repeat(201) },
    { email: 'a@x.io', username: 'alice' },
  ];
  for (const json of bad) {
    const r = await t.req('POST', '/api/v1/auth/register', { json });
    assert.equal(r.status, 400, JSON.stringify(json));
    assert.equal(r.json.error.code, 'bad_request');
  }
  assert.equal((await t.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0);
});

test('login by username or email, case-insensitive, sets a session and audits', async () => {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'carol' });
  for (const name of ['carol', 'CAROL', 'carol@example.com', 'Carol@Example.COM']) {
    const r = await login(t, name);
    assert.equal(r.status, 200, name);
    assert.equal(r.json.user.id, u.id);
    const me = await t.req('GET', '/api/v1/auth/me', { headers: cookieOf(r) });
    assert.equal(me.json.user.username, 'carol');
  }
  const n = t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'login' AND user_id = ?").get(u.id) as { n: number };
  assert.equal(n.n, 4);
});

test('wrong password, unknown user and disabled user give the identical 401', async () => {
  const t = makeTestCtx();
  t.createUser({ username: 'dave' });
  t.createUser({ username: 'erin', disabled: true });
  const results = [await login(t, 'dave', 'wrong-password'), await login(t, 'nobody'), await login(t, 'erin')];
  for (const r of results) {
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  assert.deepEqual(results[0].json, { error: { code: 'invalid_credentials', message: 'invalid login or password' } });
  assert.equal(results[1].text, results[0].text);
  assert.equal(results[2].text, results[0].text);
});

test('login clears expired sessions', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  t.db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES ('old', ?, '2000-01-01', '2000-01-02')").run(u.id);
  await login(t, u.username);
  assert.equal(t.db.prepare("SELECT 1 FROM sessions WHERE id_hash = 'old'").get(), undefined);
});

test('logout invalidates the session; anonymous logout is 204', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const r = await login(t, u.username);
  const c = cookieOf(r);
  const out = await t.req('POST', '/api/v1/auth/logout', { headers: c });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie')!, /scp_sid=;.*Max-Age=0/);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: c })).status, 401);
  assert.equal((await t.req('POST', '/api/v1/auth/logout', { headers: ORIGIN })).status, 204);
});

test('cross-site cookie requests cannot log out or revoke keys', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const { key, token } = (await newKey(t, u)).json;
  const evil = { ...t.session(u), Origin: 'http://evil.test' };
  assert.equal((await t.req('DELETE', `/api/v1/keys/${key.id}`, { headers: evil })).status, 403);
  assert.equal((await t.req('POST', '/api/v1/auth/logout', { headers: evil })).status, 403);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: evil })).status, 200);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: bearer(token) })).status, 200);
});

test('password change keeps this session, kills others, rejects wrong current and keys', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const mine = cookieOf(await login(t, u.username));
  const other = sess(t, u);
  const k = t.key(u);

  const wrong = await t.req('POST', '/api/v1/auth/password', { headers: mine, json: { current: 'nope', next: 'brand-new-pw' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'invalid_credentials');
  const viaKey = await t.req('POST', '/api/v1/auth/password', { headers: k.headers, json: { current: u.password, next: 'brand-new-pw' } });
  assert.equal(viaKey.status, 403);
  const short = await t.req('POST', '/api/v1/auth/password', { headers: mine, json: { current: u.password, next: 'short' } });
  assert.equal(short.status, 400);

  const ok = await t.req('POST', '/api/v1/auth/password', { headers: mine, json: { current: u.password, next: 'brand-new-pw' } });
  assert.equal(ok.status, 204);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: mine })).status, 200);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: other })).status, 401);
  assert.equal((await login(t, u.username)).status, 401);
  assert.equal((await login(t, u.username, 'brand-new-pw')).status, 200);
});

test('key create returns the token once; list hides it; the key authenticates', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const r = await newKey(t, u, { name: 'agent', scopes: ['write', 'read', 'read'], expiresInDays: 30 });
  assert.equal(r.status, 201);
  const { key, token } = r.json;
  assert.match(token, /^scp_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.prefix, token.slice(0, 12));
  assert.deepEqual(key.scopes, ['read', 'write']);
  assert.equal(key.groupIds, null);
  assert.deepEqual(key.groups, []);
  assert.equal(key.lastUsedAt, null);
  const days = (Date.parse(key.expiresAt) - Date.now()) / 86400_000;
  assert.ok(days > 29.9 && days <= 30, String(days));
  assert.deepEqual(Object.keys(key).sort(), ['createdAt', 'expiresAt', 'groupIds', 'groups', 'id', 'lastUsedAt', 'name', 'prefix', 'scopes']);

  const list = await t.req('GET', '/api/v1/keys', { headers: sess(t, u) });
  assert.equal(list.json.keys.length, 1);
  assert.ok(!list.text.includes(token));
  assert.ok(!list.text.includes('token_hash') && !list.text.includes('tokenHash'));

  const me = await t.req('GET', '/api/v1/auth/me', { headers: bearer(token) });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.principal, { via: 'key', scopes: ['read', 'write'], groupIds: null });
  const after = await t.req('GET', '/api/v1/keys', { headers: sess(t, u) });
  assert.notEqual(after.json.keys[0].lastUsedAt, null);

  const detail = (t.db.prepare("SELECT detail FROM audit WHERE action = 'key.create'").get() as { detail: string }).detail;
  assert.ok(!detail.includes(token), 'token never logged');
});

test('keys cannot mint keys, whatever their scope', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  for (const scopes of [['read'], ['read', 'write']] as const) {
    const k = t.key(u, { scopes: [...scopes] });
    const r = await t.req('POST', '/api/v1/keys', { headers: k.headers, json: { name: 'child', scopes: ['read'] } });
    assert.equal(r.status, 403);
  }
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n, 2);
});

test("'write' implies 'read': no write-only key is minted; legacy write-only rows gain read; keys without read are unusable", async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const r = await newKey(t, u, { name: 'w', scopes: ['write'] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.key.scopes, ['read', 'write']);
  assert.deepEqual(JSON.parse((t.db.prepare('SELECT scopes FROM api_keys WHERE id = ?').get(r.json.key.id) as { scopes: string }).scopes), ['read', 'write']);

  const legacy = t.key(u, { scopes: ['write'] });
  const me = await t.req('GET', '/api/v1/auth/me', { headers: legacy.headers });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.principal.scopes, ['read', 'write']);
  const listed = (await t.req('GET', '/api/v1/keys', { headers: sess(t, u) })).json.keys.find((k: any) => k.id === legacy.id);
  assert.deepEqual(listed.scopes, ['read', 'write']);

  const none = t.key(u, { scopes: [] });
  for (const path of ['/api/v1/items', '/api/v1/search?q=x', '/api/v1/groups', '/api/v1/auth/me']) {
    assert.equal((await t.req('GET', path, { headers: none.headers })).status, 401, path);
  }
});

test('key validation is 400', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  for (const json of [
    { name: '', scopes: ['read'] },
    { name: 'k', scopes: [] },
    { name: 'k', scopes: ['admin'] },
    { name: 'k', scopes: ['read'], expiresInDays: 0 },
    { name: 'k', scopes: ['read'], expiresInDays: 3651 },
    { name: 'x'.repeat(101), scopes: ['read'] },
  ]) {
    assert.equal((await newKey(t, u, json)).status, 400, JSON.stringify(json));
  }
});

test('group-restricted keys store group ids; unknown or unreadable slugs are 400', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const other = t.createUser();
  const mine = insertGroup(t, u, { slug: 'mine' });
  const pub = insertGroup(t, other, { slug: 'pub', visibility: 'public' });
  insertGroup(t, other, { slug: 'secret' });

  const r = await newKey(t, u, { name: 'k', scopes: ['read'], groups: ['mine', 'PUB', 'mine'] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.key.groupIds, [mine, pub]);
  assert.deepEqual(r.json.key.groups, [
    { id: mine, slug: 'mine' },
    { id: pub, slug: 'pub' },
  ]);
  const row = t.db.prepare('SELECT group_ids FROM api_keys WHERE id = ?').get(r.json.key.id) as { group_ids: string };
  assert.deepEqual(JSON.parse(row.group_ids), [mine, pub]);
  const me = await t.req('GET', '/api/v1/auth/me', { headers: bearer(r.json.token) });
  assert.deepEqual(me.json.principal, { via: 'key', scopes: ['read'], groupIds: [mine, pub] });

  for (const slug of ['nope', 'secret']) {
    const bad = await newKey(t, u, { name: 'k', scopes: ['read'], groups: [slug] });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'unknown_group');
    assert.match(bad.json.error.message, new RegExp(slug));
  }
});

test('revoked keys stop working; others cannot revoke your key; admin can', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const other = t.createUser();
  const admin = t.createUser({ isAdmin: true });
  const a = (await newKey(t, u)).json;
  const b = (await newKey(t, u)).json;

  assert.equal((await t.req('DELETE', `/api/v1/keys/${a.key.id}`, { headers: sess(t, other) })).status, 404);
  assert.equal((await t.req('DELETE', '/api/v1/keys/doesnotexist', { headers: sess(t, u) })).status, 404);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: bearer(a.token) })).status, 200);

  assert.equal((await t.req('DELETE', `/api/v1/keys/${a.key.id}`, { headers: sess(t, u) })).status, 204);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: bearer(a.token) })).status, 401);
  const list = await t.req('GET', '/api/v1/keys', { headers: sess(t, u) });
  assert.deepEqual(list.json.keys.map((k: { id: string }) => k.id), [b.key.id]);

  assert.equal((await t.req('DELETE', `/api/v1/keys/${b.key.id}`, { headers: sess(t, admin) })).status, 204);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: bearer(b.token) })).status, 401);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'key.revoke'").get() as { n: number }).n, 2);
});

test('admin user routes: 401 anonymous, 403 for non-admins', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const victim = t.createUser();
  const h = sess(t, u);
  assert.equal((await t.req('GET', '/api/v1/users')).status, 401);
  assert.equal((await t.req('GET', '/api/v1/users', { headers: h })).status, 403);
  assert.equal((await t.req('POST', '/api/v1/users', { headers: h, json: { email: 'z@x.io', username: 'zed', password: 'longenough' } })).status, 403);
  assert.equal((await t.req('PATCH', `/api/v1/users/${victim.id}`, { headers: h, json: { disabled: true } })).status, 403);
  assert.equal((await t.req('DELETE', `/api/v1/users/${victim.id}`, { headers: h })).status, 403);
  assert.equal((await t.req('PATCH', `/api/v1/users/${u.id}`, { headers: h, json: { isAdmin: true } })).status, 403);
});

test('admin creates, lists, updates and deletes users', async () => {
  const t = makeTestCtx();
  const admin = t.createUser({ isAdmin: true });
  const h = sess(t, admin);
  const created = await t.req('POST', '/api/v1/users', { headers: h, json: { email: 'z@x.io', username: 'Zed', password: 'longenough', isAdmin: true } });
  assert.equal(created.status, 201);
  assert.equal(created.json.user.username, 'zed');
  assert.equal(created.json.user.isAdmin, true);
  const id = created.json.user.id;
  const list = await t.req('GET', '/api/v1/users', { headers: h });
  assert.deepEqual(list.json.users.map((x: { username: string }) => x.username), [admin.username, 'zed']);
  assert.ok(!list.text.includes('password'));

  const zedSession = cookieOf(await login(t, 'zed', 'longenough'));
  const reset = await t.req('PATCH', `/api/v1/users/${id}`, { headers: h, json: { isAdmin: false, password: 'reset-password' } });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.user.isAdmin, false);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: zedSession })).status, 401, 'password reset ends sessions');
  assert.equal((await login(t, 'zed', 'reset-password')).status, 200);

  assert.equal((await t.req('PATCH', '/api/v1/users/nope', { headers: h, json: { disabled: true } })).status, 404);
  assert.equal((await t.req('DELETE', `/api/v1/users/${id}`, { headers: h })).status, 204);
  assert.equal((await t.req('DELETE', `/api/v1/users/${id}`, { headers: h })).status, 404);
  assert.equal((await login(t, 'zed', 'reset-password')).status, 401);
  const dup = await t.req('POST', '/api/v1/users', { headers: h, json: { email: 'q@x.io', username: admin.username, password: 'longenough' } });
  assert.equal(dup.status, 409);
});

test('admins cannot demote, disable or delete themselves or the last enabled admin', async () => {
  const t = makeTestCtx();
  const a = t.createUser({ isAdmin: true });
  const h = sess(t, a);
  for (const json of [{ isAdmin: false }, { disabled: true }]) {
    const r = await t.req('PATCH', `/api/v1/users/${a.id}`, { headers: h, json });
    assert.equal(r.status, 409, JSON.stringify(json));
  }
  assert.equal((await t.req('DELETE', `/api/v1/users/${a.id}`, { headers: h })).status, 409);
  const me = await t.req('GET', '/api/v1/auth/me', { headers: h });
  assert.equal(me.json.user.isAdmin, true);

  // With a second admin, one admin may demote the other, but not below one enabled admin.
  const b = t.createUser({ isAdmin: true });
  assert.equal((await t.req('PATCH', `/api/v1/users/${b.id}`, { headers: h, json: { isAdmin: false } })).status, 200);
  const disabledAdmin = t.createUser({ isAdmin: true, disabled: true });
  assert.equal((await t.req('PATCH', `/api/v1/users/${disabledAdmin.id}`, { headers: h, json: { isAdmin: false } })).status, 200);
  // Read-only admin keys cannot change users.
  const ro = t.key(a, { scopes: ['read'] });
  assert.equal((await t.req('PATCH', `/api/v1/users/${b.id}`, { headers: ro.headers, json: { isAdmin: true } })).status, 403);
});

test('an admin may disable a co-admin; the sole remaining admin stays protected', async () => {
  const t = makeTestCtx();
  const a = t.createUser({ isAdmin: true });
  const b = t.createUser({ isAdmin: true });
  const hb = sess(t, b);
  assert.equal(otherEnabledAdmins(t.db, a.id), 1);
  assert.equal((await t.req('PATCH', `/api/v1/users/${a.id}`, { headers: hb, json: { disabled: true } })).status, 200);
  assert.equal(otherEnabledAdmins(t.db, b.id), 0, 'disabled admins do not count');
  assert.equal((await t.req('DELETE', `/api/v1/users/${b.id}`, { headers: hb })).status, 409);
  assert.equal((await t.req('GET', '/api/v1/users', { headers: sess(t, a) })).status, 401);
});

test('disabling a user kills their sessions and keys', async () => {
  const t = makeTestCtx();
  const admin = t.createUser({ isAdmin: true });
  const u = t.createUser();
  const s = cookieOf(await login(t, u.username));
  const k = (await newKey(t, u)).json.token;
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: bearer(k) })).status, 200);
  const r = await t.req('PATCH', `/api/v1/users/${u.id}`, { headers: sess(t, admin), json: { disabled: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.disabled, true);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(u.id) as { n: number }).n, 0);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: s })).status, 401);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: bearer(k) })).status, 401);
  assert.equal((await login(t, u.username)).status, 401);

  await t.req('PATCH', `/api/v1/users/${u.id}`, { headers: sess(t, admin), json: { disabled: false } });
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: bearer(k) })).status, 200, 're-enabled keys work again');
});

test('/users/search returns up to 10 enabled prefix matches', async () => {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'searcher' });
  for (let i = 0; i < 12; i++) t.createUser({ username: `sam${String(i).padStart(2, '0')}` });
  t.createUser({ username: 'sally', disabled: true });
  t.createUser({ username: 's_x' });
  t.createUser({ username: 'sax' });
  const h = sess(t, u);

  assert.equal((await t.req('GET', '/api/v1/users/search?q=sam')).status, 401);
  const r = await t.req('GET', '/api/v1/users/search?q=SAM', { headers: h });
  assert.equal(r.status, 200);
  assert.equal(r.json.users.length, 10);
  assert.deepEqual(Object.keys(r.json.users[0]).sort(), ['id', 'username']);
  assert.equal(r.json.users[0].username, 'sam00');
  assert.deepEqual((await t.req('GET', '/api/v1/users/search?q=sal', { headers: h })).json.users, []);
  // LIKE wildcards in q are literal
  const lit = await t.req('GET', '/api/v1/users/search?q=s_', { headers: h });
  assert.deepEqual(lit.json.users.map((x: { username: string }) => x.username), ['s_x']);
  const keyed = await t.req('GET', '/api/v1/users/search?q=sea', { headers: t.key(u, { scopes: ['read'] }).headers });
  assert.deepEqual(keyed.json.users, [{ id: u.id, username: 'searcher' }]);
  // A group-restricted key is contained to its groups; the user directory is account-level.
  const restricted = await t.req('GET', '/api/v1/users/search?q=sam', { headers: t.key(u, { groupIds: ['some-group'] }).headers });
  assert.equal(restricted.status, 403);
});

test('a group-restricted admin key has no user-admin or all-audit powers', async () => {
  const t = makeTestCtx();
  const admin = t.createUser({ isAdmin: true });
  const victim = t.createUser();
  const g = insertGroup(t, admin, { slug: 'docs' });
  const rw = t.key(admin, { scopes: ['read', 'write'], groupIds: [g] }).headers;
  const ro = t.key(admin, { scopes: ['read'], groupIds: [g] }).headers;
  assert.equal((await t.req('PATCH', `/api/v1/users/${victim.id}`, { headers: rw, json: { password: 'attacker-pw' } })).status, 403);
  assert.equal((await t.req('POST', '/api/v1/users', { headers: rw, json: { email: 'e@x.io', username: 'evil', password: 'longenough', isAdmin: true } })).status, 403);
  assert.equal((await t.req('DELETE', `/api/v1/users/${victim.id}`, { headers: rw })).status, 403);
  assert.equal((await t.req('GET', '/api/v1/users', { headers: ro })).status, 403);
  assert.equal((await t.req('GET', '/api/v1/audit?all=1', { headers: ro })).status, 403);
  assert.equal((await login(t, victim.username)).status, 200, 'victim password unchanged');
  // An unrestricted admin key keeps working.
  assert.equal((await t.req('GET', '/api/v1/users', { headers: t.key(admin, { scopes: ['read'] }).headers })).status, 200);
});

test('a group-restricted key cannot read account keys, audit or stats, and can revoke only itself', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const g = insertGroup(t, u, { slug: 'pub' });
  const full = t.key(u);
  const restricted = t.key(u, { scopes: ['read', 'write'], groupIds: [g] });
  for (const path of ['/api/v1/keys', '/api/v1/audit', '/api/v1/stats']) {
    assert.equal((await t.req('GET', path, { headers: restricted.headers })).status, 403, path);
    assert.equal((await t.req('GET', path, { headers: full.headers })).status, 200, path);
  }
  // The account's other keys are invisible to a restricted key: 404, the unreadable-resource rule.
  assert.equal((await t.req('DELETE', `/api/v1/keys/${full.id}`, { headers: restricted.headers })).status, 404);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: full.headers })).status, 200, 'the other key still works');
  assert.equal((await t.req('DELETE', `/api/v1/keys/${restricted.id}`, { headers: restricted.headers })).status, 204);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: restricted.headers })).status, 401);
});

test('deleting a user also drops the search index rows of their items and groups', async () => {
  const t = makeTestCtx();
  const admin = t.createUser({ isAdmin: true });
  const u = t.createUser();
  const h = t.key(u).headers;
  assert.equal((await t.req('POST', '/api/v1/items', { headers: h, json: { kind: 'prompt', name: 'p', content: 'findme' } })).status, 201);
  assert.equal((await t.req('POST', '/api/v1/groups', { headers: h, json: { slug: 'gone', name: 'Gone' } })).status, 201);
  const count = (table: string) => (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.deepEqual([count('items_fts'), count('groups_fts')], [1, 1]);
  assert.equal((await t.req('DELETE', `/api/v1/users/${u.id}`, { headers: sess(t, admin) })).status, 204);
  assert.deepEqual([count('items_fts'), count('groups_fts')], [0, 0]);
});

test('an admin password reset revokes the user API keys', async () => {
  const t = makeTestCtx();
  const admin = t.createUser({ isAdmin: true });
  const u = t.createUser();
  const k = t.key(u);
  assert.equal((await t.req('PATCH', `/api/v1/users/${u.id}`, { headers: sess(t, admin), json: { password: 'new-password' } })).status, 200);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: k.headers })).status, 401);
  assert.equal((await t.req('GET', '/api/v1/auth/me', { headers: t.key(admin).headers })).status, 200, 'other users keep their keys');
});
