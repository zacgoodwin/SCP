import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestCtx, insertGroup, insertItem } from './helpers.ts';
import { canEditGroup, canEditItem, canReadGroup, canReadItem } from '../src/access.ts';
import { hashPassword, verifyPassword, signPayload, verifyPayload } from '../src/lib/crypto.ts';
import { migrate, newId, tx } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import type { Principal } from '../src/types.ts';

const asPrincipal = (u: { id: string; username: string; isAdmin: boolean }, extra: Partial<Principal> = {}): Principal => ({
  userId: u.id,
  username: u.username,
  isAdmin: u.isAdmin,
  via: 'session',
  scopes: ['read', 'write'],
  groupIds: null,
  ...extra,
});

test('password hashing round-trips and rejects wrong passwords', async () => {
  const h = await hashPassword('correct horse');
  assert.ok(h.startsWith('scrypt$16384$8$1$'));
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('signed payloads verify, expire, and reject tampering', () => {
  const tok = signPayload('s', { id: 'a', exp: Math.floor(Date.now() / 1000) + 60 });
  assert.deepEqual(verifyPayload('s', tok), { id: 'a', exp: JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString()).exp });
  assert.equal(verifyPayload('other', tok), null);
  assert.equal(verifyPayload('s', tok.slice(0, -2) + 'xx'), null);
  assert.equal(verifyPayload('s', signPayload('s', { exp: Math.floor(Date.now() / 1000) - 1 })), null);
  assert.equal(verifyPayload('s', 'nodot'), null);
});

test('migrations are idempotent and tx rolls back', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  migrate(db);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16);
  assert.throws(() =>
    tx(db, () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
      throw new Error('boom');
    }),
  );
  assert.equal(db.prepare("SELECT * FROM settings WHERE key = 'k'").get(), undefined);
});

test('newId is 26 chars, sortable, unique', () => {
  const a = newId();
  const ids = new Set(Array.from({ length: 1000 }, newId));
  assert.equal(a.length, 26);
  assert.equal(ids.size, 1000);
  assert.ok(/^[0-9a-z]{26}$/.test(a));
});

test('newId is monotonic within a millisecond', () => {
  // Many ids share a ms here; random suffixes alone made same-ms rows list in random order.
  const ids = Array.from({ length: 2000 }, newId);
  assert.deepEqual([...ids].sort(), ids);
});

test('config rejects same origin for app and artifacts', () => {
  assert.throws(() => loadConfig({ SCP_PUBLIC_URL: 'http://x:1', SCP_ARTIFACT_URL: 'http://x:1/' }));
  assert.equal(loadConfig({ SCP_PUBLIC_URL: 'https://a.example/' }).secureCookies, true);
  // compose passes an unset SCP_ARTIFACT_CDNS through as '': that is the default list, not "no CDNs"
  assert.ok(loadConfig({ SCP_ARTIFACT_CDNS: '' }).cdns.includes('https://cdn.jsdelivr.net'));
  assert.deepEqual(loadConfig({ SCP_ARTIFACT_CDNS: 'https://cdnjs.cloudflare.com' }).cdns, ['https://cdnjs.cloudflare.com']);
});

test('health endpoint and api 404 envelope', async () => {
  const t = makeTestCtx();
  assert.deepEqual((await t.req('GET', '/api/health')).json, { ok: true });
  const r = await t.req('GET', '/api/v1/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'not_found');
  assert.equal((await t.req('GET', '/api/whatever')).status, 404);
  assert.equal((await t.artReq('GET', '/api/v1/auth/me')).status, 404);
});

test('invalid bearer token is a hard 401 even with a valid cookie', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const r = await t.req('GET', '/api/v1/audit', { headers: { ...t.session(u), Authorization: 'Bearer scp_bogus' } });
  assert.equal(r.status, 401);
  assert.equal((await t.req('GET', '/api/v1/audit', { headers: t.session(u) })).status, 200);
  assert.equal((await t.req('GET', '/api/v1/audit')).status, 401);
});

test('expired and disabled keys are rejected', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const expired = t.key(u, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await t.req('GET', '/api/v1/audit', { headers: expired.headers })).status, 401);
  const d = t.createUser({ disabled: true });
  assert.equal((await t.req('GET', '/api/v1/audit', { headers: t.key(d).headers })).status, 401);
  assert.equal((await t.req('GET', '/api/v1/audit', { headers: t.key(u).headers })).status, 200);
});

test('access matrix: groups', () => {
  const t = makeTestCtx();
  const owner = t.createUser();
  const other = t.createUser();
  const friend = t.createUser();
  const admin = t.createUser({ isAdmin: true });
  const priv = insertGroup(t, owner, { visibility: 'private' });
  const shared = insertGroup(t, owner, { visibility: 'shared', sharedWith: [friend] });
  const pub = insertGroup(t, owner, { visibility: 'public' });
  const P = (u: typeof owner, x?: Partial<Principal>) => asPrincipal(u, x);

  assert.equal(canReadGroup(t.db, P(owner), priv), true);
  assert.equal(canReadGroup(t.db, P(other), priv), false);
  assert.equal(canReadGroup(t.db, P(admin), priv), true);
  assert.equal(canReadGroup(t.db, P(friend), shared), true);
  assert.equal(canReadGroup(t.db, P(other), shared), false);
  assert.equal(canReadGroup(t.db, P(other), pub), true);
  // restricted key: only its groups, even for the owner and admin
  assert.equal(canReadGroup(t.db, P(owner, { groupIds: [pub] }), priv), false);
  assert.equal(canReadGroup(t.db, P(admin, { groupIds: [pub] }), priv), false);
  assert.equal(canReadGroup(t.db, P(owner, { groupIds: [priv] }), priv), true);

  const row = { id: priv, owner_id: owner.id };
  assert.equal(canEditGroup(P(owner), row), true);
  assert.equal(canEditGroup(P(other), row), false);
  assert.equal(canEditGroup(P(admin), row), true);
  assert.equal(canEditGroup(P(owner, { scopes: ['read'] }), row), false);
  assert.equal(canEditGroup(P(owner, { groupIds: [pub] }), row), false);
});

test('access matrix: items via groups and full containment', () => {
  const t = makeTestCtx();
  const owner = t.createUser();
  const other = t.createUser();
  const friend = t.createUser();
  const a = insertItem(t, owner);
  const b = insertItem(t, owner, { visibility: 'public' });
  const c = insertItem(t, owner);
  const shared = insertGroup(t, owner, { visibility: 'shared', members: [a], sharedWith: [friend] });
  const priv = insertGroup(t, owner, { members: [c] });
  const P = (u: typeof owner, x?: Partial<Principal>) => asPrincipal(u, x);

  assert.equal(canReadItem(t.db, P(owner), a), true);
  assert.equal(canReadItem(t.db, P(other), a), false);
  assert.equal(canReadItem(t.db, P(friend), a), true, 'shared group grants member read');
  assert.equal(canReadItem(t.db, P(friend), c), false);
  assert.equal(canReadItem(t.db, P(other), b), true, 'public item');
  // restricted owner key sees only its groups' members
  assert.equal(canReadItem(t.db, P(owner, { groupIds: [shared] }), a), true);
  assert.equal(canReadItem(t.db, P(owner, { groupIds: [shared] }), c), false);
  assert.equal(canReadItem(t.db, P(owner, { groupIds: [shared] }), b), false, 'public items hidden from restricted keys');
  assert.equal(canReadItem(t.db, P(friend, { groupIds: [priv] }), c), false, 'restriction cannot widen access');

  // edit follows read for restricted keys: once the owner's item stops flowing through a group,
  // the owner's key restricted to that group can neither read nor edit it
  const mine = insertItem(t, friend, { visibility: 'public' });
  const theirGroup = insertGroup(t, owner, { visibility: 'shared', members: [mine], sharedWith: [friend] });
  assert.equal(canEditItem(t.db, P(friend, { groupIds: [theirGroup] }), { id: mine, owner_id: friend.id }), true);
  t.db.prepare("UPDATE items SET visibility = 'private' WHERE id = ?").run(mine);
  assert.equal(canReadItem(t.db, P(friend, { groupIds: [theirGroup] }), mine), false);
  assert.equal(canEditItem(t.db, P(friend, { groupIds: [theirGroup] }), { id: mine, owner_id: friend.id }), false);

  // someone else's item in my group flows only while it is public
  const theirs = insertItem(t, other, { visibility: 'public' });
  const mixed = insertGroup(t, owner, { visibility: 'public', members: [theirs] });
  assert.equal(canReadItem(t.db, P(friend, { groupIds: [mixed] }), theirs), true);
  t.db.prepare("UPDATE items SET visibility = 'private' WHERE id = ?").run(theirs);
  assert.equal(canReadItem(t.db, P(friend, { groupIds: [mixed] }), theirs), false);
  assert.equal(canReadItem(t.db, P(friend), theirs), false);

  assert.equal(canEditItem(t.db, P(owner), { id: a, owner_id: owner.id }), true);
  assert.equal(canEditItem(t.db, P(friend), { id: a, owner_id: owner.id }), false);
  assert.equal(canEditItem(t.db, P(owner, { scopes: ['read'] }), { id: a, owner_id: owner.id }), false);
  assert.equal(canEditItem(t.db, P(owner, { groupIds: [shared] }), { id: a, owner_id: owner.id }), true);
  assert.equal(canEditItem(t.db, P(owner, { groupIds: [shared] }), { id: c, owner_id: owner.id }), false);
});

test('audit lists own events; admin can list all', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const admin = t.createUser({ isAdmin: true });
  t.db.prepare("INSERT INTO audit (ts, user_id, action) VALUES ('2026-01-01', ?, 'x.one')").run(u.id);
  t.db.prepare("INSERT INTO audit (ts, user_id, action) VALUES ('2026-01-01', ?, 'x.two')").run(admin.id);
  const mine = await t.req('GET', '/api/v1/audit', { headers: t.session(u) });
  assert.deepEqual(mine.json.events.map((e: { action: string }) => e.action), ['x.one']);
  const all = await t.req('GET', '/api/v1/audit?all=1', { headers: t.session(admin) });
  assert.equal(all.json.events.length, 2);
  const notAll = await t.req('GET', '/api/v1/audit?all=1', { headers: t.session(u) });
  assert.equal(notAll.json.events.length, 1);
});

test('audit records the socket peer IP; proxy headers count only with SCP_TRUST_PROXY=true', async () => {
  for (const [env, want] of [
    [{}, ['203.0.113.7', '203.0.113.7']],
    // The rightmost hop is the one the trusted proxy appended; the rest is client-supplied.
    [{ SCP_TRUST_PROXY: 'true' }, ['203.0.113.7', '10.0.0.1']],
  ] as const) {
    const t = makeTestCtx(env);
    const ips = await loginIps(t);
    assert.deepEqual(ips, want, JSON.stringify(env));
  }
});

async function loginIps(t: ReturnType<typeof makeTestCtx>) {
  const u = t.createUser();
  const login = (headers: Record<string, string> = {}) =>
    t.app.fetch(
      new Request('http://app.test/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: 'http://app.test', ...headers },
        body: JSON.stringify({ login: u.username, password: u.password }),
      }),
      { incoming: { socket: { remoteAddress: '203.0.113.7' } } },
    );
  assert.equal((await login()).status, 200);
  assert.equal((await login({ 'X-Forwarded-For': '198.51.100.2, 10.0.0.1' })).status, 200);
  return (t.db.prepare("SELECT ip FROM audit WHERE action = 'login' ORDER BY id").all() as { ip: string }[]).map((r) => r.ip);
}

test('SPA: index.html revalidates, fingerprinted assets are immutable', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'scp-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  try {
    const t = makeTestCtx({ SCP_WEB_DIST: dist });
    for (const path of ['/', '/index.html', '/items/123']) {
      const r = await t.req('GET', path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get('cache-control'), 'no-cache', path);
    }
    const a = await t.req('GET', '/assets/index-abc123.js');
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const gone = await t.req('GET', '/assets/index-old999.js');
    assert.equal(gone.headers.get('cache-control'), 'no-cache', 'the SPA fallback for a missing asset is never immutable');
    for (const path of ['/', '/items/123']) {
      const r = await t.req('GET', path);
      assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'; frame-src http://art.test; object-src 'none'; base-uri 'none'", path);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    }
    // An unknown /.well-known path gets a JSON 404, not index.html with a 200 (the OAuth documents live in oauth/routes.ts).
    for (const path of ['/.well-known/oauth-protected-resource/other', '/.well-known/openid-configuration']) {
      const r = await t.req('GET', path);
      assert.equal(r.status, 404, path);
      assert.equal(r.json.error.code, 'not_found', path);
    }
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
