import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeTestCtx } from './helpers.ts';
import { migrate } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createItem } from '../src/items/service.ts';

const t = makeTestCtx();

test('migration 4 adds the v2 tables and columns, and upgrades a v3 database', () => {
  const cols = (table: string) => (t.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols('items').includes('source_kind') && cols('items').includes('source_commit'));
  assert.ok(cols('users').includes('oidc_sub'));
  for (const table of ['group_includes', 'oauth_clients', 'oauth_codes', 'oauth_tokens']) {
    assert.ok(t.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  // Migration 5: the OAuth client a version was written through, and the token index the client sweep and admin listing use.
  assert.ok(cols('item_versions').includes('created_by_client'));
  assert.ok(t.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'oauth_tokens_client'").get());
  // Migration 6: what an import's source last wrote and how it carved the tree, consented DCR clients, and the token sweep's indexes.
  assert.ok(cols('items').includes('source_tree_sha256') && cols('items').includes('source_scope'));
  assert.ok(cols('oauth_clients').includes('consented_at'));
  // Migration 7: the client sweep's partial index and the code indexes (oauth/service.ts sweepClients, issueCode).
  for (const index of ['oauth_tokens_expires', 'oauth_tokens_revoked', 'oauth_clients_sweep', 'oauth_codes_client', 'oauth_codes_expires']) {
    assert.ok(t.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index), index);
  }
  assert.equal((t.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8);

  // migrate() is idempotent and a fresh database lands on the same version.
  const fresh = new DatabaseSync(':memory:');
  fresh.exec('PRAGMA foreign_keys = ON');
  migrate(fresh);
  migrate(fresh);
  assert.equal((fresh.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8);
  assert.throws(() => t.db.prepare('INSERT INTO group_includes (group_id, included_id, added_at) VALUES (?, ?, ?)').run('a', 'a', 'now'), /CHECK/);
});

test('config reads the v2 environment and treats unset as null', () => {
  const base = { SCP_PUBLIC_URL: 'http://a.test', SCP_ARTIFACT_URL: 'http://b.test' };
  const c = loadConfig(base);
  assert.equal(c.githubApiUrl, 'https://api.github.com');
  assert.equal(c.githubToken, null);
  assert.deepEqual(c.oidc, { issuer: null, clientId: null, clientSecret: null, autoRegister: null, label: null });
  const d = loadConfig({
    ...base,
    SCP_GITHUB_API: 'http://gh.test/',
    SCP_GITHUB_TOKEN: ' ghp_x ',
    SCP_OIDC_ISSUER: 'https://idp.test/',
    SCP_OIDC_CLIENT_ID: 'cid',
    SCP_OIDC_CLIENT_SECRET: 's',
    SCP_OIDC_AUTO_REGISTER: 'no',
    SCP_OIDC_LABEL: 'Corp SSO',
  });
  assert.equal(d.githubApiUrl, 'http://gh.test');
  assert.equal(d.githubToken, 'ghp_x');
  assert.deepEqual(d.oidc, { issuer: 'https://idp.test', clientId: 'cid', clientSecret: 's', autoRegister: false, label: 'Corp SSO' });
  assert.throws(() => loadConfig({ ...base, SCP_OIDC_AUTO_REGISTER: 'maybe' }), /SCP_OIDC_AUTO_REGISTER/);
});

test('an item created with a source keeps its provenance and shows it in the detail', async () => {
  const u = t.createUser();
  const p = { userId: u.id, username: u.username, isAdmin: false, via: 'session' as const, scopes: ['read', 'write'] as ('read' | 'write')[], groupIds: null };
  const item = createItem(t.ctx, p, {
    kind: 'skill',
    name: 'from-github',
    content: '---\nname: from-github\ndescription: d\n---\n# x\n',
    source: { kind: 'github', repo: 'o/r', ref: 'main', path: 'skills/x', commit: 'a'.repeat(40) },
  });
  assert.equal(item.source_kind, 'github');
  assert.equal(item.source_commit, 'a'.repeat(40));
  const res = await t.req('GET', `/api/v1/items/${item.id}`, { headers: t.session(u) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.item.source, { kind: 'github', repo: 'o/r', ref: 'main', path: 'skills/x', commit: 'a'.repeat(40) });
  const plain = createItem(t.ctx, p, { kind: 'prompt', name: 'plain', content: 'hi' });
  const res2 = await t.req('GET', `/api/v1/items/${plain.id}`, { headers: t.session(u) });
  assert.equal(res2.json.item.source, null);
});

test('v2 seams: MCP 401 points at the resource metadata, /auth/config carries oidc, stubs 404 as JSON', async () => {
  const mcp = await t.req('POST', '/mcp', { json: {} });
  assert.equal(mcp.status, 401);
  assert.equal(mcp.headers.get('www-authenticate'), `Bearer resource_metadata="${t.config.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
  const bad = await t.req('POST', '/mcp', { json: {}, headers: { Authorization: 'Bearer scp_at_nope' } });
  assert.equal(bad.status, 401);

  const cfg = await t.req('GET', '/api/v1/auth/config');
  assert.deepEqual(cfg.json.oidc, { enabled: false, label: '' });

  // Unknown paths under the root-mounted v2 routers (oauth, marketplace) are JSON 404s, never the SPA.
  for (const path of ['/.well-known/nope', '/oauth/nope', '/m/not-a-key/marketplace.json', '/m/not-a-key/g/plugin.zip']) {
    const r = await t.req('GET', path);
    assert.equal(r.status, 404, path);
    assert.equal(r.json?.error?.code, 'not_found', path);
  }
  // Every v2 route is filled now; the import routes are POST-only, so a GET still 404s.
  const u = t.createUser();
  for (const path of ['/api/v1/items/import/github', '/api/v1/items/import/pack']) {
    const r = await t.req('GET', path, { headers: t.session(u) });
    assert.equal(r.status, 404, path);
  }
});
