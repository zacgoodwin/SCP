// Regressions for the third review round: zip CPU amplification, unthrottled scrypt, YAML alias
// expansion, quadratic member replace, uncapped file arrays, slug recycling, spoofable proxy IPs,
// restricted-key audience changes, NFC/NFD bundle paths, HFS+ ignorables, the artifact resize loop
// and fork versions. Imports only symbols that predate the fixes, so each test fails on its own
// against the old source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { strToU8, zipSync } from 'fflate';
import { makeTestCtx, type TestCtx } from './helpers.ts';
import { renderArtifact } from '../src/artifacts/render.ts';
import { now } from '../src/db.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { parseFrontmatter } from '../src/lib/frontmatter.ts';
import { HttpError } from '../src/lib/http.ts';
import { normalizePath } from '../src/lib/paths.ts';
import { safeUnzip } from '../src/lib/zip.ts';
import { createItemTx } from '../src/items/service.ts';

const API = '/api/v1';
type H = Record<string, string>;

const ms = async (fn: () => Promise<unknown>) => {
  const s = performance.now();
  await fn();
  return performance.now() - s;
};

async function item(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/items`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.item as { id: string; name: string; latestSeq: number };
}

async function group(t: TestCtx, h: H, json: Record<string, unknown>) {
  return t.req('POST', `${API}/groups`, { headers: h, json });
}

// ---------- zip ----------

test('safeUnzip refuses central-directory entries that share one local entry', () => {
  // Every record pointing at one stream inflated it once per record: 1000 x 30 MB of CPU per upload.
  const one = zipSync({ 'a.txt': strToU8('hello') }, { level: 0 });
  const dv = new DataView(one.buffer, one.byteOffset, one.byteLength);
  const eocd = one.length - 22;
  const cdOff = dv.getUint32(eocd + 16, true);
  const cd = one.subarray(cdOff, eocd);
  const twin = cd.slice();
  twin.set(strToU8('b.txt'), 46); // same local offset, another name
  const out = new Uint8Array(cdOff + cd.length * 2 + 22);
  out.set(one.subarray(0, cdOff), 0);
  out.set(cd, cdOff);
  out.set(twin, cdOff + cd.length);
  out.set(one.subarray(eocd), cdOff + cd.length * 2);
  const odv = new DataView(out.buffer);
  const e = out.length - 22;
  odv.setUint16(e + 8, 2, true);
  odv.setUint16(e + 10, 2, true);
  odv.setUint32(e + 12, cd.length * 2, true);
  assert.throws(() => safeUnzip(out), (err: unknown) => err instanceof HttpError && err.status === 400 && /overlaps/.test(err.message));
  // The untouched archive still unzips.
  assert.equal(safeUnzip(one).length, 1);
});

// ---------- auth ----------

test('password hashing is async (libuv threadpool), not a sync scrypt on the event loop', async () => {
  const h: unknown = hashPassword('x');
  assert.ok(h instanceof Promise);
  await h;
});

test('login and register are rate limited per client IP, keyed on the rightmost forwarded hop', async () => {
  const t = makeTestCtx({ SCP_TRUST_PROXY: 'true' });
  const u = t.createUser({ username: 'alice' });
  const login = (xff: string, password = 'wrong-password', who = u.username) =>
    t.req('POST', `${API}/auth/login`, { headers: { Origin: t.config.publicUrl, 'X-Forwarded-For': xff }, json: { login: who, password } });
  const statuses: number[] = [];
  // A spoofed leftmost entry changes nothing: the proxy appended 192.0.2.9.
  for (let i = 0; i < 21; i++) statuses.push((await login(`10.9.${i}.1, 192.0.2.9`, 'wrong-password', `nobody${i}`)).status);
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(401));
  assert.equal(statuses[20], 429);
  const reg = await t.req('POST', `${API}/auth/register`, {
    headers: { Origin: t.config.publicUrl, 'X-Forwarded-For': '192.0.2.9' },
    json: { email: 'n@x.io', username: 'newbie', password: 'longenough' },
  });
  assert.equal(reg.status, 429, 'register shares the per-IP bucket');
  // Another client is unaffected.
  assert.equal((await login('198.51.100.7', u.password)).status, 200);
});

test('login is rate limited per login name across client IPs', async () => {
  const t = makeTestCtx({ SCP_TRUST_PROXY: 'true' });
  t.createUser({ username: 'bob' });
  const login = (i: number) =>
    t.req('POST', `${API}/auth/login`, {
      headers: { Origin: t.config.publicUrl, 'X-Forwarded-For': `203.0.${i >> 8}.${i & 255}` },
      json: { login: i % 2 ? 'BOB' : 'bob', password: 'guess' },
    });
  // The cross-IP backstop for one name (distributed guessing) is 100, then one per 6 s.
  const statuses = (await Promise.all(Array.from({ length: 100 }, (_, i) => login(i)))).map((r) => r.status);
  assert.deepEqual(statuses, Array(100).fill(401));
  assert.equal((await login(100)).status, 429);
});

// ---------- frontmatter ----------

test('frontmatter refuses YAML aliases instead of expanding them ~100x', () => {
  const src = `---\nname: a\ndescription: d\nx: &x "${'y'.repeat(60_000)}"\nb: [${Array(99).fill('*x').join(', ')}]\n---\nbody`;
  const fm = parseFrontmatter(src);
  assert.ok(fm.error, 'aliases are an error');
  assert.deepEqual(fm.data, {});
  assert.equal(fm.body, 'body');
  // Anchors without aliases are harmless and still parse.
  assert.equal(parseFrontmatter('---\nname: &n a\n---\n').data.name, 'a');
});

// ---------- items ----------

test('POST /items counts files before validating any of them', async () => {
  const t = makeTestCtx();
  const h = t.key(t.createUser()).headers;
  // A bad path at the end: the count is the first thing refused, before any path is checked or decoded.
  const files = Array.from({ length: 1001 }, (_, i) => ({ path: i === 1000 ? '../x' : `f${i}.md`, content: 'x' }));
  const r = await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'package', files } });
  assert.equal(r.status, 413, r.text);
  const src = await item(t, h, { kind: 'prompt', name: 'p', content: 'x' });
  const v = await t.req('POST', `${API}/items/${src.id}/versions`, { headers: h, json: { files } });
  assert.equal(v.status, 413, v.text);
  const long = await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'prompt', name: 'q', files: [{ path: 'a'.repeat(300), content: 'x' }] } });
  assert.equal(long.status, 400);
});

test('fork takes the selected version, not always the latest', async () => {
  const t = makeTestCtx();
  const h = t.key(t.createUser()).headers;
  const src = await item(t, h, { kind: 'prompt', name: 'note', content: 'one\n' });
  assert.equal((await t.req('POST', `${API}/items/${src.id}/versions`, { headers: h, json: { content: 'two\n' } })).status, 201);
  const f = await t.req('POST', `${API}/items/${src.id}/fork?version=1`, { headers: h });
  assert.equal(f.status, 201, f.text);
  const body = await t.req('GET', `${API}/items/${f.json.item.id}/files/${f.json.item.version.entryPath}`, { headers: h });
  assert.equal(body.text, 'one\n');
  const latest = await t.req('POST', `${API}/items/${src.id}/fork`, { headers: h });
  const lb = await t.req('GET', `${API}/items/${latest.json.item.id}/files/${latest.json.item.version.entryPath}`, { headers: h });
  assert.equal(lb.text, 'two\n');
});

test('an agent fork renamed beside its original gets its own frontmatter name', async () => {
  const t = makeTestCtx();
  const h = t.key(t.createUser()).headers;
  const src = await item(t, h, { kind: 'agent', content: '---\r\nname: reviewer\r\ndescription: Reviews.\r\n---\r\nBody.\r\n' });
  const f = await t.req('POST', `${API}/items/${src.id}/fork`, { headers: h });
  assert.equal(f.json.item.name, 'reviewer-fork');
  assert.equal(f.json.item.version.frontmatter.name, 'reviewer-fork');
  const body = await t.req('GET', `${API}/items/${f.json.item.id}/files/reviewer-fork.md`, { headers: h });
  assert.equal(body.text, '---\r\nname: reviewer-fork\r\ndescription: Reviews.\r\n---\r\nBody.\r\n', 'CRLF and the rest kept');
});

// ---------- groups ----------

test('a deleted group slug stays with its owner: another user gets 409, the owner and admins 201', async () => {
  const t = makeTestCtx();
  const alice = t.key(t.createUser({ username: 'alice' })).headers;
  const mallory = t.key(t.createUser({ username: 'mallory' })).headers;
  const admin = t.key(t.createUser({ username: 'root', isAdmin: true })).headers;
  assert.equal((await group(t, alice, { slug: 'team-tools', name: 'T', visibility: 'public' })).status, 201);
  assert.equal((await t.req('DELETE', `${API}/groups/team-tools`, { headers: alice })).status, 204);
  const stolen = await group(t, mallory, { slug: 'team-tools', name: 'Evil' });
  assert.equal(stolen.status, 409);
  assert.equal(stolen.json.error.code, 'slug_taken');
  assert.equal((await group(t, alice, { slug: 'Team-Tools', name: 'Back' })).status, 201);
  // A user delete cascades to their groups and leaves tombstones too.
  const bob = t.createUser({ username: 'bob' });
  assert.equal((await group(t, t.key(bob).headers, { slug: 'bobs', name: 'B' })).status, 201);
  assert.equal((await t.req('DELETE', `${API}/users/${bob.id}`, { headers: admin })).status, 204);
  assert.equal((await group(t, mallory, { slug: 'bobs', name: 'Evil' })).status, 409);
  assert.equal((await group(t, admin, { slug: 'bobs', name: 'Reclaimed' })).status, 201);
});

test('a group-restricted key cannot change a group or item visibility', async () => {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'alice' });
  const h = t.key(u).headers;
  const g = await group(t, h, { slug: 'agent-g', name: 'A' });
  const it = await item(t, h, { kind: 'prompt', name: 'secret', content: 'x' });
  assert.equal((await t.req('POST', `${API}/groups/agent-g/members`, { headers: h, json: { itemId: it.id } })).status, 201);
  const rk = t.key(u, { groupIds: [g.json.group.id] }).headers;
  const pg = await t.req('PATCH', `${API}/groups/agent-g`, { headers: rk, json: { visibility: 'public' } });
  assert.equal(pg.status, 403);
  assert.equal(pg.json.error.code, 'restricted_key');
  const pi = await t.req('PATCH', `${API}/items/${it.id}`, { headers: rk, json: { visibility: 'public' } });
  assert.equal(pi.status, 403);
  assert.equal(pi.json.error.code, 'restricted_key');
  // Unchanged visibility and other fields are still fine.
  assert.equal((await t.req('PATCH', `${API}/groups/agent-g`, { headers: rk, json: { visibility: 'private', name: 'B' } })).status, 200);
  assert.equal((await t.req('PATCH', `${API}/items/${it.id}`, { headers: rk, json: { title: 'T' } })).status, 200);
  assert.equal((await t.req('PATCH', `${API}/groups/agent-g`, { headers: h, json: { visibility: 'public' } })).status, 200, 'the account can');
});

test('installAs paths that differ only in NFC/NFD collide', async () => {
  const t = makeTestCtx();
  const h = t.key(t.createUser()).headers;
  assert.equal((await group(t, h, { slug: 'docs', name: 'D' })).status, 201);
  const a = await item(t, h, { kind: 'prompt', name: 'a', content: 'a' });
  const b = await item(t, h, { kind: 'prompt', name: 'b', content: 'b' });
  const nfc = 'docs/caf\u00e9.md';
  const nfd = 'docs/cafe\u0301.md';
  assert.equal((await t.req('POST', `${API}/groups/docs/members`, { headers: h, json: { itemId: a.id, installAs: nfc } })).status, 201);
  const r = await t.req('POST', `${API}/groups/docs/members`, { headers: h, json: { itemId: b.id, installAs: nfd } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error.code, 'path_conflict');
});

test('PUT members checks the group once, not once per member', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const h = t.key(u).headers;
  const p = { userId: u.id, username: u.username, isAdmin: false, via: 'session' as const, scopes: ['read' as const, 'write' as const], groupIds: null };
  const g = await group(t, h, { slug: 'big', name: 'Big' });
  const ids: string[] = [];
  for (let i = 0; i < 500; i++) {
    const it = createItemTx(t.ctx, p, {
      kind: 'skill',
      name: `s${i}`,
      files: [
        { path: 'SKILL.md', content: `---\nname: s${i}\ndescription: d\n---\n` },
        ...Array.from({ length: 30 }, (_, k) => ({ path: `ref/f${k}.md`, content: 'x' })),
      ],
    });
    ids.push(it.id);
    t.db.prepare('INSERT INTO group_members (group_id, item_id, position, added_at) VALUES (?, ?, ?, ?)').run(g.json.group.id, it.id, i, now());
  }
  const reversed = [...ids].reverse().map((itemId) => ({ itemId }));
  let r!: Awaited<ReturnType<TestCtx['req']>>;
  const took = await ms(async () => (r = await t.req('PUT', `${API}/groups/big/members`, { headers: h, json: { members: reversed } })));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.group.members[0].item.id, ids[499], 'order kept');
  assert.ok(took < 2000, `${Math.round(took)} ms`);
  // Still all-or-nothing: a duplicate is refused and nothing changes.
  const dup = await t.req('PUT', `${API}/groups/big/members`, { headers: h, json: { members: [{ itemId: ids[0] }, { itemId: ids[0] }] } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'member_exists');
  const after = await t.req('GET', `${API}/groups/big`, { headers: h });
  assert.equal(after.json.group.members.length, 500);
});

// ---------- paths ----------

test('HFS+ ignorable code points are rejected, so .g\\u206ait cannot become .git', () => {
  for (const p of ['.g\u206ait/config', '.gi\u206ft/hooks/x', 'a\u2028b', 'a\u2029b', 'a\u061cb']) {
    assert.throws(() => normalizePath(p), (e: unknown) => e instanceof HttpError && e.status === 400, JSON.stringify(p));
  }
});

// ---------- artifact size messages ----------

test('artifact helper stops reporting a viewport-height growth loop', () => {
  const html = renderArtifact('html', '<!doctype html><html><body style="min-height:100vh">x</body></html>', { title: 't', cdns: [] });
  const js = /<script data-scp-helper>([\s\S]*?)<\/script>/.exec(html)![1];
  let frame = 150;
  let posts = 0;
  let observer: (() => void) | null = null;
  const listeners: Record<string, () => void> = {};
  const parent = {
    postMessage(m: { scp: string; height: number }) {
      if (m.scp !== 'size') return;
      posts++;
      frame = Math.min(Math.max(m.height, 150), 50_000); // what the /s page does
    },
  };
  const sandbox: Record<string, unknown> = {
    addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
    // body{min-height:100vh} plus the default 8px margin: always the frame height + 16.
    document: { documentElement: { get scrollHeight() { return frame + 16; }, dataset: {} }, addEventListener() {} },
    ResizeObserver: class {
      constructor(fn: () => void) {
        observer = fn;
      }
      observe() {}
    },
  };
  sandbox.window = { parent, addEventListener: sandbox.addEventListener };
  vm.runInNewContext(js, sandbox);
  listeners.load();
  for (let i = 0; i < 1000; i++) observer!();
  assert.ok(posts <= 6, `${posts} size reports, frame ${frame}px`);
  assert.ok(frame < 300);
});
