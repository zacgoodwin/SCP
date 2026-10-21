// Regressions for the fourth review round: superlinear markdown emphasis, unbounded FTS prefix
// terms, group file caps bypassed by new versions, conflict-index depth, unpaged group listings,
// prompt argument blowup, the self password change racing an admin reset, targeted login lockout,
// uploads that outlive their key, stale share pins and imported skill names. Imports only symbols
// that predate the fixes, so each test fails on its own against the old source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { makeTestCtx, type TestCtx } from './helpers.ts';
import { renderArtifact } from '../src/artifacts/render.ts';
import { now } from '../src/db.ts';
import { HttpError } from '../src/lib/http.ts';
import { normalizePath } from '../src/lib/paths.ts';
import { createItemTx, ftsQuery } from '../src/items/service.ts';

const API = '/api/v1';
type H = Record<string, string>;
const opts = { title: 't', cdns: ['https://cdn.jsdelivr.net'] };

const ms = (fn: () => unknown) => {
  const s = performance.now();
  fn();
  return performance.now() - s;
};

async function item(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/items`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.item as { id: string; name: string; latestSeq: number };
}

async function group(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/groups`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.group as { id: string; slug: string };
}

const login = (t: TestCtx, ip: string, who: string, password: string) =>
  t.req('POST', `${API}/auth/login`, { headers: { Origin: t.config.publicUrl, 'X-Forwarded-For': ip }, json: { login: who, password } });

/** One stateless JSON-RPC call to an MCP endpoint. */
async function rpc(t: TestCtx, path: string, h: H, method: string, params: Record<string, unknown> = {}) {
  const r = await t.req('POST', path, {
    headers: { ...h, Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    json: { jsonrpc: '2.0', id: 1, method, params },
  });
  assert.equal(r.status, 200, r.text);
  return r.json.result;
}

// ---------- rendering ----------

test('markdown: unclosed emphasis and strikethrough openers render in bounded time', () => {
  // Old: every unmatched '*', '_' or '~' opener scanned to the end of the paragraph for a closer,
  // O(n^2): '*a ' x 20k (60 KB) took ~24 s, and the 512 KB cap allowed minutes.
  for (const p of ['*a ', '_a ', '~a ', '**a ']) {
    const src = p.repeat(20_000);
    const took = ms(() => renderArtifact('markdown', src, opts));
    assert.ok(took < 500, `${JSON.stringify(p)}: ${Math.round(took)} ms`);
  }
  // Behaviour kept: emphasis, strong, strikethrough; intraword underscores stay literal.
  const out = renderArtifact('markdown', '*a* **b** ~~c~~ _d_ x_y_z ***e***', opts);
  assert.match(out, /<em>a<\/em> <strong>b<\/strong> <del>c<\/del> <em>d<\/em> x_y_z <em><strong>e<\/strong><\/em>/);
});

// ---------- search ----------

test('ftsQuery dedupes words, caps the term count and only prefix-matches words of 3+ chars', () => {
  // Old: 250 x 'a' became 250 unindexed prefix terms, each walking every token starting with 'a'.
  const terms = (q: string | null) => q?.match(/"(?:[^"]|"")*"\*?/g) ?? [];
  assert.deepEqual(terms(ftsQuery(Array(250).fill('a').join(' '))), ['"a"']);
  assert.deepEqual(terms(ftsQuery('PDF pdf Pdf')), ['"pdf"*']);
  const distinct = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
  assert.equal(terms(ftsQuery(distinct)).length, 8);
  assert.equal(ftsQuery('ab invoice', true), '"ab" OR "invoice"*');
});

test('search still finds prefixes of 3+ characters and exact short words', async () => {
  const t = makeTestCtx();
  const h = t.key(t.createUser()).headers;
  await item(t, h, { kind: 'prompt', name: 'inv', content: 'Summarize invoices in QA style.' });
  const hits = async (q: string) => (await t.req('GET', `${API}/items?q=${encodeURIComponent(q)}`, { headers: h })).json.total;
  assert.equal(await hits('invo'), 1);
  assert.equal(await hits('qa'), 1);
  assert.equal(await hits('in'), 1, 'exact short word');
  assert.equal(await hits(Array(99).fill('invo').join(' ')), 1, 'repeats are one term');
});

// ---------- groups ----------

test('a new version that pushes a group past MAX_GROUP_FILES makes its bundles group_full', async () => {
  const t = makeTestCtx();
  const h = t.key(t.createUser()).headers;
  const g = await group(t, h, { slug: 'kit', name: 'Kit', visibility: 'public' });
  const s = await item(t, h, { kind: 'skill', content: '---\nname: pdf\ndescription: d\n---\n# PDF\n' });
  assert.equal((await t.req('POST', `${API}/groups/${g.slug}/members`, { headers: h, json: { itemId: s.id } })).status, 201);
  // Members are checked on add only; an unpinned member follows its latest version, which grows.
  const v2 = await t.req('POST', `${API}/items/${s.id}/versions`, { headers: h, json: { files: [{ path: 'SKILL.md', content: '---\nname: pdf\ndescription: d\n---\n# v2\n' }] } });
  assert.equal(v2.status, 201, v2.text);
  const vid = (t.db.prepare('SELECT id FROM item_versions WHERE item_id = ? AND seq = 2').get(s.id) as { id: string }).id;
  t.db
    .prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 20000)
       INSERT INTO version_files (version_id, path, mode, sha256, size)
       SELECT ?, 'refs/f' || i || '.md', 420, (SELECT sha256 FROM version_files WHERE version_id = ? LIMIT 1), 1 FROM k`,
    )
    .run(vid, vid);
  for (const path of ['manifest', 'bundle.zip', 'catalog.md', 'manifest?target=codex&scope=user']) {
    const r = await t.req('GET', `${API}/groups/${g.slug}/${path}`, { headers: h });
    assert.equal(r.status, 400, path);
    assert.equal(r.json.error.code, 'group_full', path);
  }
});

test('paths deeper than 32 segments are rejected', () => {
  // Old: only length was capped, so 'a/a/.../f' gave ~125 ancestors per path to every conflict index.
  assert.equal(normalizePath(`${'a/'.repeat(31)}f`), `${'a/'.repeat(31)}f`);
  assert.throws(() => normalizePath(`${'a/'.repeat(32)}f`), (e: unknown) => e instanceof HttpError && e.status === 400 && /32 segments/.test(e.message));
});

test('GET /groups is paged in SQL, own groups first, with a total', async () => {
  const t = makeTestCtx();
  const alice = t.createUser({ username: 'alice' });
  const mallory = t.createUser({ username: 'mallory' });
  const ha = t.key(alice).headers;
  await group(t, ha, { slug: 'mine', name: 'Mine' });
  // Strangers' public groups, all newer than alice's.
  const ins = t.db.prepare("INSERT INTO scp_groups (id, owner_id, slug, name, visibility, created_at, updated_at) VALUES (?, ?, ?, 'Spam', 'public', ?, ?)");
  for (let i = 0; i < 70; i++) ins.run(`spam${String(i).padStart(22, '0')}`, mallory.id, `spam-${i}`, now(), `2999-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
  const r = await t.req('GET', `${API}/groups`, { headers: ha });
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 71);
  assert.equal(r.json.groups.length, 50);
  assert.equal(r.json.groups[0].slug, 'mine', 'own groups are not buried by strangers');
  const rest = await t.req('GET', `${API}/groups?limit=200&offset=50`, { headers: ha });
  assert.equal(rest.json.groups.length, 21);
  const mine = await t.req('GET', `${API}/groups?owner=me`, { headers: ha });
  assert.deepEqual(mine.json.groups.map((g: { slug: string }) => g.slug), ['mine']);
  assert.equal(mine.json.total, 1);
  assert.equal((await t.req('GET', `${API}/groups?limit=201`, { headers: ha })).status, 400);
});

// ---------- MCP ----------

test('/mcp/:group caps prompt arguments at 32 and prompts at 200', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const k = t.key(u);
  const g = await group(t, k.headers, { slug: 'kit', name: 'Kit' });
  // ~4,000 arguments fit the 64 KB frontmatter cap in flow style.
  const args = Array.from({ length: 4000 }, (_, i) => `{name: a${i}}`).join(', ');
  const wide = await item(t, k.headers, { kind: 'prompt', name: 'wide', content: `---\narguments: [${args}]\n---\nHi {{a0}}.\n` });
  const p = { userId: u.id, username: u.username, isAdmin: false, via: 'key' as const, scopes: ['read' as const, 'write' as const], groupIds: null };
  const add = t.db.prepare('INSERT INTO group_members (group_id, item_id, position, added_at) VALUES (?, ?, ?, ?)');
  add.run(g.id, wide.id, 0, now());
  for (let i = 0; i < 205; i++) add.run(g.id, createItemTx(t.ctx, p, { kind: 'prompt', name: `p${i}`, content: `prompt ${i}` }).id, i + 1, now());
  const { prompts } = await rpc(t, `/mcp/${g.slug}`, k.headers, 'prompts/list');
  assert.equal(prompts.length, 200);
  const w = prompts.find((x: { name: string }) => x.name === 'wide');
  assert.equal(w.arguments.length, 32);
  assert.equal(w.arguments[0].name, 'a0');
});

// ---------- auth ----------

test('a self password change that races an admin reset loses (401), and the reset password works', async () => {
  const t = makeTestCtx({ SCP_TRUST_PROXY: 'true' });
  const admin = t.createUser({ username: 'root', isAdmin: true });
  const victim = t.createUser({ username: 'victim' });
  // Old: the self change read the hash, awaited two scrypts, then wrote unconditionally, undoing the
  // reset that landed in between (the admin's one scrypt finishes first).
  const self = t.req('POST', `${API}/auth/password`, { headers: t.session(victim), json: { current: victim.password, next: 'attacker-pass' } });
  const reset = await t.req('PATCH', `${API}/users/${victim.id}`, { headers: t.session(admin), json: { password: 'admin-chosen' } });
  assert.equal(reset.status, 200, reset.text);
  const r = await self;
  assert.equal(r.status, 401, r.text);
  assert.equal((await login(t, '198.51.100.1', 'victim', 'admin-chosen')).status, 200);
  assert.equal((await login(t, '198.51.100.2', 'victim', 'attacker-pass')).status, 401);
});

test('failed logins from one client do not lock the account out for another client', async () => {
  const t = makeTestCtx({ SCP_TRUST_PROXY: 'true' });
  const admin = t.createUser({ username: 'admin', isAdmin: true });
  // Old: the per-name bucket ignored the client, so 10 bad tries from anywhere locked everyone out.
  for (let i = 0; i < 10; i++) assert.equal((await login(t, '203.0.113.9', 'admin', 'wrong-guess')).status, 401);
  assert.equal((await login(t, '203.0.113.9', 'admin', 'wrong-guess')).status, 429, 'the guessing client is throttled');
  assert.equal((await login(t, '198.51.100.7', 'admin', admin.password)).status, 200, 'the real admin still gets in');
});

test('an upload whose key is revoked before the body arrives writes nothing (401)', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const k = t.key(u);
  const art = await item(t, k.headers, { kind: 'artifact', format: 'html', name: 'page', content: '<p>1</p>' });
  const body = new TextEncoder().encode(JSON.stringify({ content: '<p>2</p>' }));
  let reading!: () => void;
  let go!: () => void;
  const started = new Promise<void>((r) => (reading = r));
  const gate = new Promise<void>((r) => (go = r));
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(body.slice(0, 4));
    },
    async pull(ctrl) {
      reading(); // the route is reading the body: the principal was resolved already
      await gate;
      ctrl.enqueue(body.slice(4));
      ctrl.close();
    },
  });
  const res = t.app.fetch(
    new Request(`${t.config.publicUrl}${API}/items/${art.id}/versions`, {
      method: 'POST',
      headers: { ...k.headers, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit),
  );
  await started;
  t.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now(), k.id);
  go();
  const r = await res;
  assert.equal(r.status, 401, await r.text());
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM item_versions WHERE item_id = ?').get(art.id) as { n: number }).n, 1);
});

// ---------- shares ----------

test('a share pins the version the caller names, not whatever is latest by then', async () => {
  const t = makeTestCtx();
  const h = t.key(t.createUser()).headers;
  const art = await item(t, h, { kind: 'artifact', format: 'html', name: 'page', content: '<p>1</p>' });
  // An agent pushed v2 after the owner looked at v1.
  assert.equal((await t.req('POST', `${API}/items/${art.id}/versions`, { headers: h, json: { content: '<p>2</p>' } })).status, 201);
  const s = await t.req('POST', `${API}/items/${art.id}/shares`, { headers: h, json: { pinnedSeq: 1 } });
  assert.equal(s.status, 201, s.text);
  assert.equal(s.json.share.pinnedSeq, 1);
  assert.equal((await t.req('POST', `${API}/items/${art.id}/shares`, { headers: h, json: { pinnedSeq: 3 } })).status, 400);
  assert.equal((await t.req('POST', `${API}/items/${art.id}/shares`, { headers: h, json: { pinVersion: true } })).json.share.pinnedSeq, 2);
});

// ---------- import ----------

test('an imported skill without a frontmatter name is named after its folder, titled by its heading', async () => {
  const t = makeTestCtx();
  const h = t.key(t.createUser()).headers;
  const zip = zipSync({ 'pdf/SKILL.md': strToU8('---\ndescription: Extract tables from PDFs.\n---\n# PDF Processing Toolkit\n') });
  const form = new FormData();
  form.set('file', new File([zip], 'pdf.zip'));
  const r = await t.req('POST', `${API}/items/import`, { headers: h, body: form });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.item.name, 'pdf');
  assert.equal(r.json.item.title, 'PDF Processing Toolkit');
});
