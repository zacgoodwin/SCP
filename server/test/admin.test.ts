import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { insertGroup, makeTestCtx, type TestCtx, type TestUser } from './helpers.ts';
import { sweepBlobs } from '../src/items/gc.ts';
import { readSetting } from '../src/admin/settings.ts';
import { loadConfig } from '../src/config.ts';

const API = '/api/v1';
type H = Record<string, string>;

function setup(env: Record<string, string> = {}) {
  const t = makeTestCtx(env);
  const admin = t.createUser({ isAdmin: true });
  const user = t.createUser();
  return { t, admin, user, ah: t.session(admin), uh: t.session(user) };
}

const SKILL = (name: string, body: string) => `---\nname: ${name}\ndescription: d\n---\n${body}\n`;

async function createSkill(t: TestCtx, h: H, name: string, extra: { path: string; content: string }[] = []) {
  const r = await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'skill', files: [{ path: 'SKILL.md', content: SKILL(name, `# ${name}`) }, ...extra] } });
  assert.equal(r.status, 201, r.text);
  return r.json.item as { id: string; version: { files: { sha256: string }[] } };
}

const blobCount = (t: TestCtx) => (t.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
const hasBlob = (t: TestCtx, sha: string) => !!t.db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(sha);

// ---------- access ----------

test('admin endpoints: 401 anonymous, 403 for non-admins and for group-restricted admin keys', async () => {
  const { t, admin, uh } = setup();
  const gid = insertGroup(t, admin);
  const restricted = t.key(admin, { groupIds: [gid] }).headers;
  const readOnly = t.key(admin, { scopes: ['read'] }).headers;
  const calls: [string, string, unknown?][] = [
    ['GET', '/admin/settings'],
    ['PUT', '/admin/settings', { github: { token: 'x' } }],
    ['POST', '/admin/gc', {}], // a JSON body: a bare cookie-less POST is a CSRF 403 before auth runs
  ];
  for (const [method, path, json] of calls) {
    assert.equal((await t.req(method, `${API}${path}`, { json })).status, 401, `${method} ${path} anon`);
    assert.equal((await t.req(method, `${API}${path}`, { headers: uh, json })).status, 403, `${method} ${path} user`);
    assert.equal((await t.req(method, `${API}${path}`, { headers: restricted, json })).status, 403, `${method} ${path} restricted key`);
  }
  // Writes need the write scope; the read is fine with a read-only admin key.
  assert.equal((await t.req('GET', `${API}/admin/settings`, { headers: readOnly })).status, 200);
  assert.equal((await t.req('PUT', `${API}/admin/settings`, { headers: readOnly, json: { github: { token: 'x' } } })).status, 403);
  assert.equal((await t.req('POST', `${API}/admin/gc`, { headers: readOnly })).status, 403);
  // all=1 is silently own-only for non-admins (existing behaviour) and 403 for restricted keys.
  assert.equal((await t.req('GET', `${API}/audit?all=1`, { headers: restricted })).status, 403);
  assert.equal((await t.req('GET', `${API}/audit?all=1`, { headers: uh })).status, 200);
  assert.equal(readSetting(t.db, 'github.token'), null, 'a refused PUT wrote a setting');
});

// ---------- settings ----------

test('settings round trip: values persist under the plan keys, secrets are never echoed, "" clears, omitted keeps', async () => {
  const { t, admin, ah } = setup();
  const empty = await t.req('GET', `${API}/admin/settings`, { headers: ah });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.oidc, { issuer: null, clientId: null, clientSecretSet: false, autoRegister: true, label: 'Single sign-on', source: 'none', envFields: [] });
  assert.deepEqual(empty.json.github, { tokenSet: false, source: 'none' });
  assert.deepEqual(empty.json.registration, { enabled: true, source: 'env' });
  assert.deepEqual(Object.keys(empty.json.storage).sort(), ['blobBytes', 'blobs', 'groups', 'items', 'orphanBlobs', 'orphanBytes', 'users', 'versions']);
  assert.equal(empty.json.storage.users, 2);

  const put = await t.req('PUT', `${API}/admin/settings`, {
    headers: ah,
    json: { oidc: { issuer: 'https://idp.test/', clientId: 'cid', clientSecret: 'sekrit-value', autoRegister: false, label: 'Corp SSO' }, github: { token: 'ghp_topsecret' } },
  });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.json.oidc, { issuer: 'https://idp.test', clientId: 'cid', clientSecretSet: true, autoRegister: false, label: 'Corp SSO', source: 'settings', envFields: [] });
  assert.deepEqual(put.json.github, { tokenSet: true, source: 'settings' });
  assert.ok(!put.text.includes('sekrit') && !put.text.includes('ghp_'), 'secrets echoed');
  assert.deepEqual(
    (t.db.prepare('SELECT key, value FROM settings WHERE key != ? ORDER BY key').all('hmac_secret') as { key: string; value: string }[]).map((r) => ({ ...r })),
    [
      { key: 'github.token', value: 'ghp_topsecret' },
      { key: 'oidc.auto_register', value: 'false' },
      { key: 'oidc.client_id', value: 'cid' },
      { key: 'oidc.client_secret', value: 'sekrit-value' },
      { key: 'oidc.issuer', value: 'https://idp.test' },
      { key: 'oidc.label', value: 'Corp SSO' },
    ],
  );
  const log = t.db.prepare("SELECT detail FROM audit WHERE action = 'admin.settings' AND user_id = ?").all(admin.id) as { detail: string }[];
  assert.equal(log.length, 1);
  assert.ok(!log[0].detail.includes('sekrit') && !log[0].detail.includes('ghp_'), 'secrets audited');
  assert.deepEqual(JSON.parse(log[0].detail).keys.sort(), ['github.token', 'oidc.auto_register', 'oidc.client_id', 'oidc.client_secret', 'oidc.issuer', 'oidc.label']);

  // Omitted keeps, '' clears (the secret too), autoRegister '' falls back to the default.
  const partial = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { oidc: { label: 'Login', clientSecret: '', autoRegister: '' } } });
  assert.equal(partial.status, 200, partial.text);
  assert.deepEqual(partial.json.oidc, { issuer: 'https://idp.test', clientId: 'cid', clientSecretSet: false, autoRegister: true, label: 'Login', source: 'settings', envFields: [] });
  assert.equal(readSetting(t.db, 'oidc.client_secret'), null);
  assert.equal(readSetting(t.db, 'oidc.auto_register'), null);
  assert.equal(partial.json.github.tokenSet, true);
  const cleared = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { github: { token: '' } } });
  assert.deepEqual(cleared.json.github, { tokenSet: false, source: 'none' });
  // Clearing the IdP values reads as unconfigured even while the label row stays behind (QA: the UI
  // showed "configured" next to empty issuer and client id fields).
  const unset = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { oidc: { issuer: '', clientId: '' } } });
  assert.deepEqual(unset.json.oidc, { issuer: null, clientId: null, clientSecretSet: false, autoRegister: true, label: 'Login', source: 'none', envFields: [] });
  assert.equal(readSetting(t.db, 'oidc.label'), 'Login');

  // Validation: bad issuer, unknown shape, empty patch.
  assert.equal((await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { oidc: { issuer: 'idp.test' } } })).status, 400);
  assert.equal((await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { oidc: { autoRegister: 'yes' } } })).status, 400);
  assert.equal((await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: {} })).status, 400);
  assert.equal((await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { oidc: {} } })).status, 400);
});

test('env-managed settings read as source env and refuse writes with 400 env_managed, field by field', async () => {
  const { t, ah } = setup({ SCP_OIDC_ISSUER: 'https://env.idp/', SCP_OIDC_CLIENT_ID: 'env-cid', SCP_GITHUB_TOKEN: 'ghp_env' });
  const get = await t.req('GET', `${API}/admin/settings`, { headers: ah });
  assert.equal(get.json.oidc.source, 'env');
  assert.deepEqual(get.json.oidc.envFields, ['issuer', 'clientId'], 'per field, so the UI locks only these');
  assert.equal(get.json.oidc.issuer, 'https://env.idp');
  assert.equal(get.json.oidc.clientId, 'env-cid');
  assert.equal(get.json.oidc.clientSecretSet, false);
  assert.deepEqual(get.json.github, { tokenSet: true, source: 'env' });
  assert.ok(!get.text.includes('ghp_env'));

  for (const json of [{ oidc: { issuer: 'https://other.idp' } }, { oidc: { clientId: 'x' } }, { github: { token: 'x' } }]) {
    const r = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json });
    assert.equal(r.status, 400, JSON.stringify(json));
    assert.equal(r.json.error.code, 'env_managed');
  }
  // Nothing written when one field of the patch is env-managed.
  assert.equal((await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { oidc: { label: 'L', issuer: 'https://x.y' } } })).status, 400);
  assert.equal(readSetting(t.db, 'oidc.label'), null);
  // Fields the environment leaves alone stay editable; env values still win for the others.
  const ok = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { oidc: { label: 'Corp', clientSecret: 's' } } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.oidc.label, 'Corp');
  assert.equal(ok.json.oidc.clientSecretSet, true);
  assert.equal(ok.json.oidc.issuer, 'https://env.idp');
  assert.equal(ok.json.oidc.source, 'env');
});

test('a label-only environment leaves the IdP fields editable and does not read as an env configuration', async () => {
  const { t, ah } = setup({ SCP_OIDC_LABEL: 'Corp SSO' });
  const get = await t.req('GET', `${API}/admin/settings`, { headers: ah });
  assert.deepEqual(get.json.oidc, { issuer: null, clientId: null, clientSecretSet: false, autoRegister: true, label: 'Corp SSO', source: 'none', envFields: ['label'] });
  const put = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { oidc: { issuer: 'https://idp.test', clientId: 'cid', clientSecret: 's' } } });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.json.oidc, { issuer: 'https://idp.test', clientId: 'cid', clientSecretSet: true, autoRegister: true, label: 'Corp SSO', source: 'settings', envFields: ['label'] });
  const label = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { oidc: { label: 'Other' } } });
  assert.equal(label.status, 400);
  assert.equal(label.json.error.code, 'env_managed');
});

test('dhje/00tr: import limits round trip under the import.* keys, are range-checked, audited, admin-only, and "" clears back to the default', async () => {
  const { t, admin, ah, uh } = setup();
  const get = await t.req('GET', `${API}/admin/settings`, { headers: ah });
  assert.deepEqual(get.json.imports, { maxItems: 200, maxArchiveMb: 35, maxPackMb: 64, envFields: [] });
  const put = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { imports: { maxItems: 2000, maxArchiveMb: 1, maxPackMb: 256 } } });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.json.imports, { maxItems: 2000, maxArchiveMb: 1, maxPackMb: 256, envFields: [] });
  assert.deepEqual(
    (t.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'import.%' ORDER BY key").all() as { key: string; value: string }[]).map((r) => ({ ...r })),
    [
      { key: 'import.max_archive_mb', value: '1' },
      { key: 'import.max_items', value: '2000' },
      { key: 'import.max_pack_mb', value: '256' },
    ],
  );
  const log = t.db.prepare("SELECT detail FROM audit WHERE action = 'admin.settings' AND user_id = ?").all(admin.id) as { detail: string }[];
  assert.deepEqual(JSON.parse(log[0].detail).keys.sort(), ['import.max_archive_mb', 'import.max_items', 'import.max_pack_mb']);

  // Outside 1..2000 (items) or 1..256 (MB), or not a whole number: 400, nothing written.
  const bad = [{ maxItems: 0 }, { maxItems: 2001 }, { maxItems: -1 }, { maxItems: '5' }, { maxArchiveMb: 0 }, { maxArchiveMb: 257 }, { maxPackMb: 257 }, { maxPackMb: 1.5 }];
  for (const imports of bad) {
    const r = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { imports } });
    assert.equal(r.status, 400, JSON.stringify(imports));
  }
  assert.equal((await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { imports: {} } })).status, 400, 'nothing to change');
  // Non-admins are refused like every admin route (403), and write nothing.
  assert.equal((await t.req('PUT', `${API}/admin/settings`, { headers: uh, json: { imports: { maxItems: 7 } } })).status, 403);
  assert.equal(readSetting(t.db, 'import.max_items'), '2000');

  const cleared = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { imports: { maxArchiveMb: '' } } });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(cleared.json.imports.maxArchiveMb, 35);
  assert.equal(readSetting(t.db, 'import.max_archive_mb'), null);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'admin.settings'").get() as { n: number }).n, 2, 'one audit row per change');
});

test('import limits set by SCP_IMPORT_* win over a stored row and are read-only per field (400 env_managed); a bad value stops the boot', async () => {
  const { t, ah } = setup({ SCP_IMPORT_MAX_ITEMS: '50' });
  t.db.prepare("INSERT INTO settings (key, value) VALUES ('import.max_items', '900')").run();
  const get = await t.req('GET', `${API}/admin/settings`, { headers: ah });
  assert.deepEqual(get.json.imports, { maxItems: 50, maxArchiveMb: 35, maxPackMb: 64, envFields: ['maxItems'] });
  const locked = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { imports: { maxItems: 10, maxPackMb: 100 } } });
  assert.equal(locked.status, 400);
  assert.equal(locked.json.error.code, 'env_managed');
  assert.match(locked.json.error.message, /SCP_IMPORT_MAX_ITEMS/);
  assert.equal(readSetting(t.db, 'import.max_pack_mb'), null, 'nothing written');
  const ok = await t.req('PUT', `${API}/admin/settings`, { headers: ah, json: { imports: { maxPackMb: 100 } } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.imports, { maxItems: 50, maxArchiveMb: 35, maxPackMb: 100, envFields: ['maxItems'] });
  const base = { SCP_PUBLIC_URL: 'http://a.test', SCP_ARTIFACT_URL: 'http://b.test' };
  for (const [name, v] of [['SCP_IMPORT_MAX_ITEMS', '0'], ['SCP_IMPORT_MAX_ITEMS', '2001'], ['SCP_IMPORT_MAX_ARCHIVE_MB', '257'], ['SCP_IMPORT_MAX_PACK_MB', '1.5'], ['SCP_IMPORT_MAX_PACK_MB', 'lots']]) {
    assert.throws(() => loadConfig({ ...base, [name]: v }), new RegExp(name), `${name}=${v}`);
  }
  assert.equal(loadConfig({ ...base, SCP_IMPORT_MAX_ARCHIVE_MB: '' }).imports.maxArchiveMb, null, "compose's unset ''");
});

test('every variable the README Configuration table names reaches the container: docker-compose.yml passes it through', () => {
  const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const table = /### Configuration[\s\S]*?\n\n(\|[\s\S]*?)\n\s*\n/.exec(read('README.md'))![1];
  const names = new Set(table.match(/SCP_[A-Z_]+/g));
  assert.ok(names.has('SCP_IMPORT_MAX_ITEMS'), 'the table was found');
  const compose = read('docker-compose.yml');
  // SCP_HOST_* are compose's own port mappings, read where they are used.
  const missing = [...names].filter((n) => !n.startsWith('SCP_HOST_') && !new RegExp(`^\\s+${n}: \\$\\{${n}:-`, 'm').test(compose));
  assert.deepEqual(missing, []);
});

// ---------- blob GC ----------

test('deleting a user sweeps the blobs only their items referenced, in the same transaction', async () => {
  const { t, admin, user, ah } = setup();
  const shared = { path: 'shared.txt', content: 'bytes both users stored' };
  const mine = await createSkill(t, t.key(admin).headers, 'mine', [shared]);
  const theirs = await createSkill(t, t.key(user).headers, 'theirs', [shared, { path: 'only-theirs.txt', content: 'unique to the deleted user' }]);
  const sha = (item: typeof mine, path: string) => (item.version.files as { path: string; sha256: string }[]).find((f) => f.path === path)!.sha256;
  const sharedSha = sha(theirs, 'shared.txt');
  assert.equal(sharedSha, sha(mine, 'shared.txt'));
  const before = blobCount(t);
  assert.equal((await t.req('DELETE', `${API}/users/${user.id}`, { headers: ah })).status, 204);
  assert.equal(hasBlob(t, sharedSha), true, "the admin's version still references it");
  assert.equal(hasBlob(t, sha(theirs, 'only-theirs.txt')), false, 'orphaned by the delete, gone with it');
  assert.equal(hasBlob(t, sha(theirs, 'SKILL.md')), false);
  assert.equal(blobCount(t), before - 2);
  const stats = await t.req('GET', `${API}/admin/settings`, { headers: ah });
  assert.equal(stats.json.storage.orphanBlobs, 0);
  assert.equal(stats.json.storage.users, 1);
  assert.equal((await t.req('GET', `${API}/items/${mine.id}/files/shared.txt`, { headers: t.key(admin).headers })).text, shared.content);
});

test('deleting an item sweeps only the blobs no other version references', async () => {
  const { t, admin, ah } = setup();
  const h = t.key(admin).headers;
  const shared = { path: 'shared.txt', content: 'the same bytes in two items' };
  const a = await createSkill(t, h, 'alpha', [shared, { path: 'only-a.txt', content: 'unique to alpha' }]);
  const b = await createSkill(t, h, 'beta', [shared]);
  const sha = (item: typeof a, path: string) => (item.version.files as { path: string; sha256: string }[]).find((f) => f.path === path)!.sha256;
  const sharedSha = sha(a, 'shared.txt');
  assert.equal(sharedSha, sha(b, 'shared.txt'));
  const onlyA = sha(a, 'only-a.txt');
  const before = blobCount(t);

  assert.equal((await t.req('DELETE', `${API}/items/${a.id}`, { headers: h })).status, 204);
  assert.equal(hasBlob(t, sharedSha), true, 'blob still used by beta survives');
  assert.equal(hasBlob(t, onlyA), false, 'orphaned blob is gone');
  assert.equal(hasBlob(t, sha(a, 'SKILL.md')), false);
  assert.equal(blobCount(t), before - 2);
  const stats = await t.req('GET', `${API}/admin/settings`, { headers: ah });
  assert.equal(stats.json.storage.orphanBlobs, 0);
  assert.equal(stats.json.storage.items, 1);

  assert.equal((await t.req('DELETE', `${API}/items/${b.id}`, { headers: h })).status, 204);
  assert.equal(blobCount(t), 0);
  // Beta's files can still be read while it exists: a version of another item is a reference.
});

test('POST /admin/gc and the boot sweep delete orphan blobs only, report counts and audit', async () => {
  const { t, admin, ah } = setup();
  const h = t.key(admin).headers;
  const live = await createSkill(t, h, 'live', [{ path: 'keep.txt', content: 'referenced' }]);
  const insert = t.db.prepare('INSERT INTO blobs (sha256, size, data) VALUES (?, ?, ?)');
  insert.run('a'.repeat(64), 100, new Uint8Array(100));
  insert.run('b'.repeat(64), 50, new Uint8Array(50));
  const stats = await t.req('GET', `${API}/admin/settings`, { headers: ah });
  assert.equal(stats.json.storage.orphanBlobs, 2);
  assert.equal(stats.json.storage.orphanBytes, 150);
  assert.equal(stats.json.storage.blobs, 4);

  const gc = await t.req('POST', `${API}/admin/gc`, { headers: ah });
  assert.equal(gc.status, 200, gc.text);
  assert.deepEqual(gc.json, { deletedBlobs: 2, freedBytes: 150 });
  assert.equal(blobCount(t), 2);
  for (const f of live.version.files) assert.ok(hasBlob(t, f.sha256));
  assert.deepEqual((await t.req('POST', `${API}/admin/gc`, { headers: ah })).json, { deletedBlobs: 0, freedBytes: 0 });
  const log = t.db.prepare("SELECT detail FROM audit WHERE action = 'admin.gc' ORDER BY id").all() as { detail: string }[];
  assert.deepEqual(log.map((l) => JSON.parse(l.detail)), [{ deletedBlobs: 2, freedBytes: 150 }, { deletedBlobs: 0, freedBytes: 0 }]);
  assert.equal((await t.req('GET', `${API}/items/${live.id}/files/keep.txt`, { headers: h })).text, 'referenced');

  // The boot path (main.ts) is a full sweep with no candidate list.
  insert.run('c'.repeat(64), 7, new Uint8Array(7));
  assert.deepEqual(sweepBlobs(t.db), { deletedBlobs: 1, freedBytes: 7 });
  assert.deepEqual(sweepBlobs(t.db, []), { deletedBlobs: 0, freedBytes: 0 });
  // A targeted sweep ignores orphans outside its list.
  insert.run('d'.repeat(64), 1, new Uint8Array(1));
  assert.deepEqual(sweepBlobs(t.db, ['e'.repeat(64)]), { deletedBlobs: 0, freedBytes: 0 });
  assert.ok(hasBlob(t, 'd'.repeat(64)));
  assert.deepEqual(sweepBlobs(t.db, ['d'.repeat(64), live.version.files[0].sha256]), { deletedBlobs: 1, freedBytes: 1 });
});

// ---------- audit filters ----------

async function seedAudit(t: TestCtx, users: TestUser[]) {
  for (const u of users) {
    const h = t.key(u).headers;
    await createSkill(t, h, `${u.username}-one`);
    const two = await createSkill(t, h, `${u.username}-two`);
    await t.req('PATCH', `${API}/items/${two.id}`, { headers: h, json: { title: `Hello ${u.username}` } });
  }
}

test('GET /audit filters: before pages, user, action prefix and q; non-admins stay inside their own events', async () => {
  const { t, admin, user, ah, uh } = setup();
  await seedAudit(t, [admin, user]);
  const list = async (h: H, query: string) => {
    const r = await t.req('GET', `${API}/audit${query}`, { headers: h });
    assert.equal(r.status, 200, r.text);
    return r.json.events as { id: number; action: string; username: string | null; targetId: string | null; detail: Record<string, unknown> }[];
  };

  const all = await list(ah, '?all=1');
  assert.equal(all.length, 6);
  assert.ok(all.every((e, i) => i === 0 || e.id < all[i - 1].id), 'newest first');

  // Paging by id cursor.
  const page1 = await list(ah, '?all=1&limit=4');
  const page2 = await list(ah, `?all=1&limit=4&before=${page1.at(-1)!.id}`);
  assert.equal(page1.length, 4);
  assert.equal(page2.length, 2);
  assert.deepEqual([...page1, ...page2].map((e) => e.id), all.map((e) => e.id));
  assert.deepEqual(await list(ah, `?all=1&before=${all.at(-1)!.id}`), []);

  // user (case-insensitive), action prefix, q over target_id and detail.
  const byUser = await list(ah, `?all=1&user=${user.username.toUpperCase()}`);
  assert.equal(byUser.length, 3);
  assert.ok(byUser.every((e) => e.username === user.username));
  assert.deepEqual(await list(ah, '?all=1&user=nobody'), []);
  const updates = await list(ah, '?all=1&action=item.upd');
  assert.equal(updates.length, 2);
  assert.ok(updates.every((e) => e.action === 'item.update'));
  assert.equal((await list(ah, '?all=1&action=item.')).length, 6);
  assert.equal((await list(ah, '?all=1&action=item_')).length, 0, 'LIKE wildcards are escaped');
  const target = all[0].targetId!;
  const byTarget = await list(ah, `?all=1&q=${target.slice(-8)}`);
  assert.ok(byTarget.length >= 1 && byTarget.every((e) => e.targetId === target));
  const byDetail = await list(ah, `?all=1&q=${user.username}-one`);
  assert.equal(byDetail.length, 1);
  assert.equal(byDetail[0].detail.name, `${user.username}-one`);
  assert.deepEqual(await list(ah, '?all=1&q=%25'), [], 'percent is literal');
  assert.equal((await list(ah, `?all=1&user=${user.username}&action=item.create&limit=1`)).length, 1);

  // A non-admin's filters apply to their own events only; all=1 and another user's name change nothing.
  const own = await list(uh, '?all=1');
  assert.equal(own.length, 3);
  assert.ok(own.every((e) => e.username === user.username));
  assert.deepEqual(await list(uh, `?all=1&user=${admin.username}`), []);
  assert.equal((await list(uh, '?action=item.create')).length, 2);
  assert.equal((await list(uh, `?before=${own[0].id}`)).length, 2);

  // Validation.
  assert.equal((await t.req('GET', `${API}/audit?before=0`, { headers: ah })).status, 400);
  assert.equal((await t.req('GET', `${API}/audit?before=abc`, { headers: ah })).status, 400);
  assert.equal((await t.req('GET', `${API}/audit?limit=501`, { headers: ah })).status, 400);
});

// ---------- users PATCH username/email ----------

test('PATCH /users/:id changes username and email, 409 on a clash, 400 when invalid, audits without the address', async () => {
  const { t, admin, user, ah } = setup();
  const other = t.createUser({ username: 'taken' });
  const r = await t.req('PATCH', `${API}/users/${user.id}`, { headers: ah, json: { username: 'Renamed', email: 'New@Example.org' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.user.username, 'renamed');
  assert.equal(r.json.user.email, 'New@Example.org');
  // The renamed user's session keeps working and shows the new name.
  const me = await t.req('GET', `${API}/auth/me`, { headers: t.session(user) });
  assert.equal(me.json.user.username, 'renamed');
  assert.equal((await t.req('POST', `${API}/auth/login`, { json: { login: 'renamed', password: user.password } })).status, 200);

  for (const json of [{ username: 'taken' }, { username: 'TAKEN' }, { email: other.email }, { email: other.email.toUpperCase() }]) {
    const clash = await t.req('PATCH', `${API}/users/${user.id}`, { headers: ah, json });
    assert.equal(clash.status, 409, JSON.stringify(json));
    assert.equal(clash.json.error.code, 'conflict');
  }
  // A clash rolls the whole patch back.
  assert.equal((await t.req('PATCH', `${API}/users/${user.id}`, { headers: ah, json: { username: 'taken', disabled: true } })).status, 409);
  const row = t.db.prepare('SELECT username, disabled FROM users WHERE id = ?').get(user.id) as { username: string; disabled: number };
  assert.deepEqual({ ...row }, { username: 'renamed', disabled: 0 });

  for (const json of [{ username: 'a' }, { username: '-bad' }, { username: 'has space' }, { email: 'not-an-email' }, { username: 123 }]) {
    assert.equal((await t.req('PATCH', `${API}/users/${user.id}`, { headers: ah, json })).status, 400, JSON.stringify(json));
  }
  // Admins may rename themselves (no session loss, unlike a password reset).
  assert.equal((await t.req('PATCH', `${API}/users/${admin.id}`, { headers: ah, json: { username: 'root' } })).status, 200);
  assert.equal((await t.req('GET', `${API}/auth/me`, { headers: ah })).json.user.username, 'root');

  const log = t.db.prepare("SELECT detail FROM audit WHERE action = 'user.update' AND target_id = ? ORDER BY id").all(user.id) as { detail: string }[];
  assert.deepEqual(JSON.parse(log[0].detail), { passwordReset: false, username: 'renamed', emailChanged: true });
  assert.ok(!log.some((l) => l.detail.includes('example.org')), 'email address in the audit log');
  // Non-admins cannot rename anyone, themselves included.
  assert.equal((await t.req('PATCH', `${API}/users/${user.id}`, { headers: t.session(user), json: { username: 'self' } })).status, 403);
});
