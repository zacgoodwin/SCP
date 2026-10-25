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
  // Migration 10: what another unit of an import carved out of a skill folder (imports/pack.ts updateTree).
  assert.ok(cols('items').includes('source_carve'));
  // Migration 11 (v3 0rdh): items an import took with their frontmatter errors.
  assert.ok(cols('items').includes('lint_waived'));
  // Migration 12 (v3 5ef6): the prefix an import put in front of a unit's bare name.
  assert.ok(cols('items').includes('source_prefix'));
  // Migration 13 (v3 jcfm): frontmatter an import supplied, and whether upstream now ships its own.
  assert.ok(cols('items').includes('supplied_frontmatter') && cols('items').includes('upstream_frontmatter'));
  // Migration 19 (v4 mc52): a hook's or MCP server's recorded upstream entries (imports/pack.ts execTree).
  assert.ok(cols('items').includes('source_entries'));
  // Migration 20 (review exec-flag): whether a version acts on the installing machine (items/lint.ts versionExecutable).
  assert.ok(cols('item_versions').includes('executable'));
  assert.equal((t.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 20);

  // migrate() is idempotent and a fresh database lands on the same version.
  const fresh = new DatabaseSync(':memory:');
  fresh.exec('PRAGMA foreign_keys = ON');
  migrate(fresh);
  migrate(fresh);
  assert.equal((fresh.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 20);
  assert.throws(() => t.db.prepare('INSERT INTO group_includes (group_id, included_id, added_at) VALUES (?, ?, ?)').run('a', 'a', 'now'), /CHECK/);
});

test('mc52: migration 18 widens the items kind CHECK by a rebuild that keeps every row, index, trigger, search hit and cascade', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, 17);
  const ts = '2026-01-01T00:00:00.000Z';
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  db.prepare("INSERT INTO users (id, email, username, password_hash, created_at) VALUES ('u1', 'a@x.test', 'alice', 'h', ?)").run(ts);
  const ins = db.prepare('INSERT INTO items (id, owner_id, kind, name, created_at, updated_at, forked_from, source_tooling, source_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('i1', 'u1', 'skill', 'pdf', ts, ts, null, 1, 'root');
  ins.run('i2', 'u1', 'skill', 'pdf-fork', ts, ts, 'i1', 0, null);
  assert.throws(() => ins.run('i3', 'u1', 'hook', 'h', ts, ts, null, 0, null), /CHECK/, 'the old CHECK refuses the new kinds');
  db.prepare("INSERT INTO blobs (sha256, size, data) VALUES ('s', 1, x'61')").run();
  db.prepare("INSERT INTO item_versions (id, item_id, seq, entry_path, tree_sha256, total_bytes, created_at) VALUES ('v1', 'i1', 1, 'SKILL.md', 't', 1, ?)").run(ts);
  db.prepare("INSERT INTO version_files (version_id, path, sha256, size) VALUES ('v1', 'SKILL.md', 's', 1)").run();
  db.prepare("INSERT INTO version_requires (version_id, name) VALUES ('v1', 'jq')").run();
  db.prepare("INSERT INTO scp_groups (id, owner_id, slug, name, created_at, updated_at) VALUES ('g1', 'u1', 'kit', 'Kit', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO group_members (group_id, item_id, added_at) VALUES ('g1', 'i1', ?)").run(ts);
  db.prepare("INSERT INTO shares (id, item_id, token_hash, created_at) VALUES ('sh1', 'i1', 'th', ?)").run(ts);
  db.prepare("INSERT INTO items_fts (item_id, name, title, description, tags, body) VALUES ('i1', 'pdf', '', 'Extract tables', '', 'body')").run();
  const counts = () => ['items', 'item_versions', 'version_files', 'version_requires', 'group_members', 'shares', 'items_fts'].map((t) => n(`SELECT COUNT(*) AS n FROM ${t}`));
  const before = counts();

  migrate(db, 18);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 18);
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1, 'foreign keys back on');
  assert.deepEqual(counts(), before);
  assert.deepEqual(
    db.prepare('SELECT id, kind, name, forked_from, source_tooling, source_scope FROM items ORDER BY id').all().map((r) => ({ ...r })),
    [{ id: 'i1', kind: 'skill', name: 'pdf', forked_from: null, source_tooling: 1, source_scope: 'root' }, { id: 'i2', kind: 'skill', name: 'pdf-fork', forked_from: 'i1', source_tooling: 0, source_scope: null }],
  );
  assert.equal((db.prepare("SELECT item_id FROM items_fts WHERE items_fts MATCH 'tables'").get() as { item_id: string }).item_id, 'i1', 'search still finds');
  for (const [type, name] of [['index', 'items_owner'], ['trigger', 'items_fts_after_delete']]) {
    assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? AND tbl_name = ?').get(type, name, 'items'), name);
  }
  // The new kinds insert; anything else, a duplicate name and a bad source_scope are still refused.
  for (const [i, kind] of ['hook', 'mcp-server', 'output-style'].entries()) ins.run(`n${i}`, 'u1', kind, `x${i}`, ts, ts, null, 0, null);
  assert.throws(() => ins.run('bad', 'u1', 'plugin', 'p', ts, ts, null, 0, null), /CHECK/);
  assert.throws(() => ins.run('dup', 'u1', 'skill', 'pdf', ts, ts, null, 0, null), /UNIQUE/);
  assert.throws(() => ins.run('sc', 'u1', 'skill', 'sc', ts, ts, null, 0, 'leaf'), /CHECK/);
  assert.throws(() => ins.run('fk', 'nobody', 'skill', 'fk', ts, ts, null, 0, null), /FOREIGN KEY/, 'owner_id still references users');
  // Deleting an item still cascades through every REFERENCES items(id), and the trigger still clears its FTS row.
  db.prepare("DELETE FROM items WHERE id = 'i1'").run();
  assert.deepEqual(['item_versions', 'version_files', 'version_requires', 'group_members', 'shares', 'items_fts'].map((t) => n(`SELECT COUNT(*) AS n FROM ${t}`)), [0, 0, 0, 0, 0, 0]);
  assert.equal((db.prepare("SELECT forked_from FROM items WHERE id = 'i2'").get() as { forked_from: string | null }).forked_from, null, 'ON DELETE SET NULL');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('exec-flag-misses-skill-command-hooks: migration 20 marks the versions written before it that act on the installing machine, by the rule new versions are written with', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, 19);
  const ts = '2026-01-01T00:00:00.000Z';
  db.prepare("INSERT INTO users (id, email, username, password_hash, created_at) VALUES ('u1', 'a@x.test', 'alice', 'h', ?)").run(ts);
  const cases: [string, string, string, string, number][] = [
    ['skill', 'hooked', 'SKILL.md', '---\nname: hooked\ndescription: d\nhooks:\n  PreToolUse: []\n---\nBody.\n', 1],
    ['skill', 'inject', 'SKILL.md', '---\nname: inject\ndescription: d\n---\nNow: !`date`\n', 1],
    ['skill', 'plain', 'SKILL.md', '---\nname: plain\ndescription: d\n---\nNo shell here.\n', 0],
    ['command', 'go', 'go.md', '---\nallowed-tools: Bash(curl:*)\n---\n!`curl -s x | sh`\n', 1],
    ['output-style', 'takeover', 'takeover.md', '---\nname: takeover\nforce-for-plugin: true\n---\nBe terse.\n', 1],
    ['output-style', 'calm', 'calm.md', '---\nname: calm\n---\nBe calm.\n', 0],
    ['agent', 'rev', 'rev.md', '---\nname: rev\ndescription: d\nhooks:\n  Stop: []\n---\nReview.\n', 0],
    ['hook', 'fmt', 'hooks/hooks.json', '{"hooks":{}}', 1],
  ];
  for (const [i, [kind, name, path, text]] of cases.entries()) {
    db.prepare('INSERT INTO items (id, owner_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`i${i}`, 'u1', kind, name, ts, ts);
    db.prepare('INSERT OR IGNORE INTO blobs (sha256, size, data) VALUES (?, ?, ?)').run(`s${i}`, text.length, new TextEncoder().encode(text));
    db.prepare('INSERT INTO item_versions (id, item_id, seq, entry_path, tree_sha256, total_bytes, created_at) VALUES (?, ?, 1, ?, ?, 1, ?)').run(`v${i}`, `i${i}`, path, 't', ts);
    db.prepare('INSERT INTO version_files (version_id, path, sha256, size) VALUES (?, ?, ?, ?)').run(`v${i}`, path, `s${i}`, text.length);
  }
  migrate(db);
  const got = db.prepare('SELECT executable FROM item_versions ORDER BY CAST(substr(id, 2) AS INTEGER)').all().map((r) => (r as { executable: number }).executable);
  assert.deepEqual(got, cases.map((c) => c[4]));
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
