// Regressions for the second review round: superlinear parsing and rendering, request and bundle
// size caps, takedown and containment gaps, and path/zip/config edge cases. Imports only symbols
// that predate the fixes, so each test fails on its own against the old source.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { insertItem, makeTestCtx, type TestCtx } from './helpers.ts';
import { renderArtifact } from '../src/artifacts/render.ts';
import { renderVersionHtml } from '../src/artifacts/shares.ts';
import { loadConfig } from '../src/config.ts';
import { now } from '../src/db.ts';
import { parseFrontmatter } from '../src/lib/frontmatter.ts';
import { HttpError } from '../src/lib/http.ts';
import { assertNoCollisions, normalizePath } from '../src/lib/paths.ts';
import { buildZip, safeUnzip } from '../src/lib/zip.ts';
import { lintVersion } from '../src/items/lint.ts';
import { getItemRow } from '../src/items/service.ts';
import type { VersionRow } from '../src/types.ts';

const API = '/api/v1';
type H = Record<string, string>;
const MB = 1024 * 1024;
const opts = { title: 't', cdns: ['https://cdn.jsdelivr.net'] };

/** Wall time of one call, in ms. */
const ms = (fn: () => unknown) => {
  const s = performance.now();
  fn();
  return performance.now() - s;
};

const throws400 = (fn: () => unknown, label: string) =>
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 400, label);

async function item(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/items`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.item as { id: string; name: string; version: { files: { path: string }[] } };
}

async function group(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/groups`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.group as { id: string; slug: string };
}

const addMember = (t: TestCtx, h: H, slug: string, json: unknown) => t.req('POST', `${API}/groups/${slug}/members`, { headers: h, json });
const latestVersion = (t: TestCtx, id: string) =>
  t.db.prepare('SELECT * FROM item_versions WHERE item_id = ? ORDER BY seq DESC LIMIT 1').get(id) as unknown as VersionRow;

/** Give a version `n` more files, all pointing at its entry blob (cheap stand-ins for a big tree). */
function padVersion(t: TestCtx, versionId: string, prefix: string, n: number) {
  t.db
    .prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO version_files (version_id, path, mode, sha256, size)
       SELECT ?, ? || i || '.png', 420, (SELECT sha256 FROM version_files WHERE version_id = ? LIMIT 1), 1 FROM k`,
    )
    .run(n, versionId, prefix, versionId);
}

// ---------- rendering ----------

test('react: export-list and export-default scans are linear', () => {
  // Old: /export\s*\{([^}]*)\}/g re-scanned to EOF from every 'export{' (200 KB: ~1.6 s).
  const lists = `const s = "${'export{'.repeat(30_000)}";\nexport default function App() { return null; }`;
  assert.ok(ms(() => renderArtifact('react', lists, opts)) < 250);
  // Old: function\b\s*\*?\s* split one run of spaces two ways (O(n^2)).
  const spaces = `export default function${' '.repeat(200_000)}(){}`;
  assert.ok(ms(() => renderArtifact('react', spaces, opts)) < 250);
  // Behaviour kept: an export list default still mounts.
  assert.match(renderArtifact('react', 'function App() { return <p/>; }\nexport { App as default };', opts), /__scpJsx\(App, \{\}\)/);
});

test('markdown: unclosed emphasis runs render in linear time; email autolinks still work', () => {
  // Old: GFM's email lookahead re-scanned the rest of the run at every token ('_a' x 50k: ~4 s).
  for (const p of ['_a', '*a', '__a']) {
    const src = p.repeat(Math.ceil(100_000 / p.length));
    const took = ms(() => renderArtifact('markdown', src, opts));
    assert.ok(took < 750, `${p}: ${Math.round(took)} ms`);
  }
  const out = renderArtifact('markdown', 'Mail ann.lee@example.com or see https://x.test/a.', opts);
  assert.match(out, /<a href="mailto:ann\.lee@example\.com">ann\.lee@example\.com<\/a>/);
  assert.match(out, /<a href="https:\/\/x\.test\/a">/);
});

test('markdown: deep nesting and oversize bodies are shown as source, never thrown', () => {
  // Old: marked.parse threw RangeError (stack overflow) and the public share answered 500.
  for (const src of ['>'.repeat(10_000) + 'a', '> '.repeat(3000) + 'a\n' + 'x'.repeat(100_000), '1. '.repeat(3000) + 'a']) {
    let out = '';
    const took = ms(() => (out = renderArtifact('markdown', src, opts)));
    assert.match(out, /shown as source/);
    assert.ok(took < 250, `${Math.round(took)} ms`);
  }
  const big = renderArtifact('markdown', `# big\n\n${'word '.repeat(110_000)}`, opts);
  assert.match(big, /over 512 KB/);
  assert.doesNotMatch(big, /<h1>/);
  // Ordinary nesting still renders.
  assert.match(renderArtifact('markdown', '> a\n> > b\n\n- x\n  - y\n', opts), /<blockquote>[\s\S]*<blockquote>/);
});

test('renderVersionHtml caches per version and re-renders when the title changes', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const h = t.key(u).headers;
  const art = await item(t, h, { kind: 'artifact', format: 'markdown', name: 'doc', title: 'First', content: '# Hello' });
  const row = getItemRow(t.db, art.id)!;
  const v = latestVersion(t, art.id);
  const first = renderVersionHtml(t.db, t.config, row, v);
  assert.match(first, /<h1>Hello<\/h1>/);
  // Versions are immutable; prove the second render never re-reads the stored bytes.
  t.db.prepare('UPDATE blobs SET data = ? WHERE sha256 = (SELECT sha256 FROM version_files WHERE version_id = ?)').run(strToU8('# Changed'), v.id);
  assert.equal(renderVersionHtml(t.db, t.config, row, v), first);
  const renamed = { ...row, title: 'Second' };
  assert.match(renderVersionHtml(t.db, t.config, renamed, v), /<title>Second<\/title>/);
});

// ---------- parsing ----------

test('frontmatter over 64 KB is an error without being parsed; duplicate keys still caught at any depth', () => {
  let y = '---\n';
  for (let i = 0; i < 30_000; i++) y += `k${i}: 1\n`;
  y += '---\nbody';
  let fm = parseFrontmatter('');
  const took = ms(() => (fm = parseFrontmatter(y)));
  assert.match(fm.error ?? '', /over 64 KB/);
  assert.equal(fm.body, 'body');
  assert.ok(took < 50, `${Math.round(took)} ms`);
  assert.ok(parseFrontmatter('---\na:\n  b: 1\n  b: 2\n---\n').error, 'nested duplicate');
  assert.ok(parseFrontmatter("---\na: 1\n'a': 2\n---\n").error, 'same value, different quoting');
  assert.equal(parseFrontmatter('---\n1: a\n"1": b\n---\n').error, undefined, 'a number and a string are different keys (as in yaml)');
  assert.deepEqual(parseFrontmatter('---\na: 1\nb:\n  a: 2\n---\n').data, { a: 1, b: { a: 2 } }, 'same key in different maps is fine');
});

test('design lint: a long run of spaces in a heading is linear; section order still checked', () => {
  const body = `## a${' '.repeat(60_000)}x\n`;
  const took = ms(() => lintVersion('design', 'd', [], parseFrontmatter(body), { path: 'DESIGN.md', text: body }));
  assert.ok(took < 100, `${Math.round(took)} ms`);
  const order = '## Colors   ##\r\n## Overview\n';
  const lint = lintVersion('design', 'd', [], parseFrontmatter(order), { path: 'DESIGN.md', text: order });
  assert.deepEqual(lint.map((l) => [l.code, l.message.slice(0, 18)]), [['design.section.order', "section 'Overview'"]]);
});

// ---------- request and bundle limits ----------

test('request bodies: 1 MB on /api/v1, uploads keep their larger limits, /mcp is capped', async () => {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'alice' });
  const h = t.key(u).headers;
  const big = (n: number) => JSON.stringify({ login: 'alice', password: 'x'.repeat(n) });
  const post = (path: string, body: string, headers: H = {}) =>
    t.req('POST', path, { headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...headers }, body });
  for (const path of [`${API}/auth/login`, `${API}/auth/register`]) {
    const r = await post(path, big(2 * MB));
    assert.equal(r.status, 413, `${path}: ${r.text.slice(0, 200)}`);
    assert.equal(r.json.error.code, 'too_large');
  }
  assert.equal((await post(`${API}/auth/login`, big(10))).status, 401, 'small bodies still reach the route');
  const upload = JSON.stringify({ kind: 'prompt', name: 'large', content: 'y'.repeat(2 * MB) });
  assert.equal((await post(`${API}/items`, upload, h)).status, 201, 'POST /items keeps its 45 MB limit');
  const mcp = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 'z'.repeat(13 * MB) } }), h);
  assert.equal(mcp.status, 413);
});

test('bundle.zip refuses over 100 MB uncompressed; groups cap members and files', async () => {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'alice' });
  const h = t.key(u).headers;
  const g = await group(t, h, { slug: 'kit', name: 'Kit' });
  const a = await item(t, h, { kind: 'skill', content: '---\nname: a\ndescription: d\n---\n' });
  const b = await item(t, h, { kind: 'skill', content: '---\nname: b\ndescription: d\n---\n' });
  for (const it of [a, b]) assert.equal((await addMember(t, h, 'kit', { itemId: it.id })).status, 201);
  assert.equal((await t.req('GET', `${API}/groups/kit/bundle.zip`, { headers: h })).status, 200);
  // Deduplicated blobs make this cheap on disk; the size check must run before any tree is read.
  t.db.prepare('UPDATE item_versions SET total_bytes = ? WHERE item_id IN (?, ?)').run(60 * MB, a.id, b.id);
  const r = await t.req('GET', `${API}/groups/kit/bundle.zip`, { headers: h });
  assert.equal(r.status, 413);
  assert.equal(r.json.error.code, 'bundle_too_large');
  // The manifest reports the same refusal for both downloads, so the UI never offers a link the server answers 413 to.
  const m = await t.req('GET', `${API}/groups/kit/manifest`, { headers: h });
  assert.equal(m.status, 200, m.text);
  assert.equal(m.json.bundle.code, 'bundle_too_large');
  assert.equal(m.json.bundle.problem, r.json.error.message);
  assert.equal(m.json.plugin.code, 'bundle_too_large');

  // 500 members at most (raw rows: the cap counts rows, not what resolves).
  const full = await group(t, h, { slug: 'full', name: 'Full' });
  const ins = t.db.prepare('INSERT INTO group_members (group_id, item_id, position, added_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 500; i++) ins.run(full.id, insertItem(t, u, { kind: 'prompt' }), i, now());
  const c = await item(t, h, { kind: 'prompt', name: 'c', content: 'c' });
  const over = await addMember(t, h, 'full', { itemId: c.id });
  assert.equal(over.status, 400, over.text);
  assert.equal(over.json.error.code, 'group_full');

  // 20,000 files across members at most.
  const huge = await item(t, h, { kind: 'skill', content: '---\nname: huge\ndescription: d\n---\n' });
  padVersion(t, latestVersion(t, huge.id).id, 'assets/', 20_000);
  const tooMany = await addMember(t, h, 'kit', { itemId: huge.id });
  assert.equal(tooMany.status, 400, tooMany.text);
  assert.equal(tooMany.json.error.code, 'group_full');
});

test('path conflict checks are indexed: 1000-file members add and list quickly, clashes still found', async () => {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'alice' });
  const h = t.key(u).headers;
  await group(t, h, { slug: 'big', name: 'Big', visibility: 'public' });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const d = await item(t, h, { kind: 'design', name: `d${i}`, content: '## Overview\n' });
    padVersion(t, latestVersion(t, d.id).id, 'assets/', 999);
    ids.push(d.id);
  }
  for (let i = 0; i < 4; i++) assert.equal((await addMember(t, h, 'big', { itemId: ids[i], installAs: `docs/d${i}.md` })).status, 201);
  // Old: pairwise over every footprint path, ~1 s per existing 1000-file member per add.
  let s = performance.now();
  assert.equal((await addMember(t, h, 'big', { itemId: ids[4], installAs: 'docs/d4.md' })).status, 201);
  assert.ok(performance.now() - s < 1500, `add: ${Math.round(performance.now() - s)} ms`);
  s = performance.now();
  const m = await t.req('GET', `${API}/groups/big/manifest`, { headers: h });
  assert.ok(performance.now() - s < 1000, `manifest: ${Math.round(performance.now() - s)} ms`);
  assert.deepEqual(m.json.conflicts, []);
  // A clash with the new member's extras is still a 409, and names the right items.
  const clash = await item(t, h, { kind: 'prompt', name: 'p', content: 'x' });
  const r = await addMember(t, h, 'big', { itemId: clash.id, installAs: '.scp/design/d2/assets/7.png/x.md' });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json.error.details.items, ['d2', 'p']);
});

// ---------- items ----------

test('a package whose entry is not at the root keeps its folder through version, fork and zip import', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const h = t.key(u).headers;
  const files = [
    { path: 'kit/docs/README.md', content: '# Kit' },
    { path: 'kit/docs/guide.md', content: '# Guide' },
  ];
  const pkg = await item(t, h, { kind: 'package', name: 'kit', files });
  const want = ['docs/README.md', 'docs/guide.md'];
  assert.deepEqual(pkg.version.files.map((f) => f.path), want, 'the upload wrapper is stripped once');
  const stored = want.map((path, i) => ({ path, content: files[i].content }));
  const v2 = await t.req('POST', `${API}/items/${pkg.id}/versions`, { headers: h, json: { files: stored } });
  assert.equal(v2.status, 201, v2.text);
  assert.deepEqual(v2.json.item.version.files.map((f: { path: string }) => f.path), want, 'resent from the Edit tab');
  const fork = await t.req('POST', `${API}/items/${pkg.id}/fork`, { headers: h });
  assert.equal(fork.status, 201, fork.text);
  assert.deepEqual(fork.json.item.version.files.map((f: { path: string }) => f.path), want, 'fork');
  const fd = new FormData();
  const zip = buildZip(files.map((f) => ({ path: f.path, bytes: strToU8(f.content), mode: 420 })));
  fd.set('file', new File([zip as Uint8Array<ArrayBuffer>], 'kit.zip'));
  fd.set('name', 'kit2');
  const imp = await t.req('POST', `${API}/items/import`, { headers: h, body: fd });
  assert.equal(imp.status, 201, imp.text);
  assert.deepEqual(imp.json.item.version.files.map((f: { path: string }) => f.path), want, 'zip import strips only the zip wrapper');
});

// ---------- access ----------

test("a disabled owner's groups and items stop flowing to others; admins still see them; re-enable restores", async () => {
  const t = makeTestCtx();
  const admin = t.createUser({ username: 'root', isAdmin: true });
  const bob = t.createUser({ username: 'bob' });
  const alice = t.createUser({ username: 'alice' });
  const hb = t.key(bob).headers;
  const ha = t.key(alice).headers;
  const ad = t.session(admin);
  const skill = await item(t, hb, { kind: 'skill', visibility: 'public', content: '---\nname: backdoor\ndescription: Totally fine.\n---\n' });
  await group(t, hb, { slug: 'bobs', name: 'Bobs', visibility: 'public' });
  assert.equal((await addMember(t, hb, 'bobs', { itemId: skill.id })).status, 201);
  await group(t, ha, { slug: 'mine', name: 'Mine' });
  assert.equal((await addMember(t, ha, 'mine', { itemId: skill.id })).status, 201);
  const reads = async (h: H) => ({
    group: (await t.req('GET', `${API}/groups/bobs`, { headers: h })).status,
    item: (await t.req('GET', `${API}/items/${skill.id}`, { headers: h })).status,
    bundle: (await t.req('GET', `${API}/groups/bobs/bundle.zip`, { headers: h })).status,
    search: (await t.req('GET', `${API}/search?q=totally`, { headers: h })).json.results.length,
    viaOwnGroup: (await t.req('GET', `${API}/groups/mine`, { headers: ha })).json.group.members.length,
  });
  assert.deepEqual(await reads(ha), { group: 200, item: 200, bundle: 200, search: 1, viaOwnGroup: 1 });
  t.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(bob.id);
  assert.deepEqual(await reads(ha), { group: 404, item: 404, bundle: 404, search: 0, viaOwnGroup: 0 });
  const asAdmin = await reads(ad);
  assert.deepEqual([asAdmin.group, asAdmin.item, asAdmin.bundle, asAdmin.search], [200, 200, 200, 1]);
  t.db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(bob.id);
  assert.deepEqual(await reads(ha), { group: 200, item: 200, bundle: 200, search: 1, viaOwnGroup: 1 });
});

test('a group-restricted key cannot change sharedWith (no username oracle); a full key can', async () => {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'alice' });
  t.createUser({ username: 'bob' });
  const g = await group(t, t.key(u).headers, { slug: 'kit', name: 'Kit', visibility: 'shared' });
  const restricted = t.key(u, { groupIds: [g.id] }).headers;
  for (const sharedWith of [['bob'], ['nobody-here']]) {
    const r = await t.req('PATCH', `${API}/groups/kit`, { headers: restricted, json: { sharedWith } });
    assert.equal(r.status, 403, `${sharedWith}: ${r.text}`);
    assert.equal(r.json.error.code, 'restricted_key');
  }
  assert.equal((await t.req('PATCH', `${API}/groups/kit`, { headers: restricted, json: { description: 'ok' } })).status, 200, 'other fields still editable');
  const full = await t.req('PATCH', `${API}/groups/kit`, { headers: t.key(u).headers, json: { sharedWith: ['bob'] } });
  assert.deepEqual(full.json.group.sharedWith, ['bob']);
});

test('an admin cannot reset their own password through the user admin (it would revoke their keys)', async () => {
  const t = makeTestCtx();
  const admin = t.createUser({ username: 'root', isAdmin: true });
  const other = t.createUser({ username: 'bob' });
  const s = t.session(admin);
  const self = await t.req('PATCH', `${API}/users/${admin.id}`, { headers: s, json: { password: 'brand-new-pass' } });
  assert.equal(self.status, 409, self.text);
  assert.match(self.json.error.message, /POST \/auth\/password/);
  assert.equal((await t.req('GET', `${API}/auth/me`, { headers: s })).status, 200, 'still signed in');
  assert.equal((await t.req('PATCH', `${API}/users/${other.id}`, { headers: s, json: { password: 'brand-new-pass' } })).status, 200);
});

test('stats count live keys only: an expired key is not counted', async () => {
  const t = makeTestCtx();
  const u = t.createUser();
  t.key(u);
  t.key(u, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const r = await t.req('GET', `${API}/stats`, { headers: t.session(u) });
  assert.equal(r.json.keys, 1);
});

// ---------- config ----------

test('boolean env vars: any case, 1/0, yes/no; empty is the default; anything else stops the boot', () => {
  const base = { SCP_PUBLIC_URL: 'http://a.test', SCP_ARTIFACT_URL: 'http://b.test' };
  const reg = (v: string) => loadConfig({ ...base, SCP_ALLOW_REGISTRATION: v }).allowRegistration;
  for (const v of ['FALSE', 'False', 'false', '0', 'no', ' No ']) assert.equal(reg(v), false, v);
  for (const v of ['TRUE', '1', 'yes', '']) assert.equal(reg(v), true, v);
  assert.equal(loadConfig(base).allowRegistration, true);
  assert.throws(() => reg('flase'), /SCP_ALLOW_REGISTRATION/);
  assert.equal(loadConfig({ ...base, SCP_TRUST_PROXY: 'TRUE' }).trustProxy, true);
  assert.throws(() => loadConfig({ ...base, SCP_TRUST_PROXY: 'on' }), /SCP_TRUST_PROXY/);
});

test('SCP_ARTIFACT_CDNS: trailing slashes are trimmed; unusable entries are dropped with a warning', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const c = loadConfig({ SCP_PUBLIC_URL: 'http://a.test', SCP_ARTIFACT_URL: 'http://b.test', SCP_ARTIFACT_CDNS: 'https://cdn.jsdelivr.net/ https://x.test/path' });
    assert.deepEqual(c.cdns, ['https://cdn.jsdelivr.net']);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /x\.test\/path/);
  } finally {
    warn.mock.restore();
  }
});

// ---------- paths and zips ----------

test('paths: C1, zero-width and bidi controls, BOM and lone surrogates are rejected; NFC/NFD collide', () => {
  for (const p of ['a\u0085b.md', 'a\u009fb.md', '‮txt.exe', 'a​.md', 'a⁦b.md', '﻿a.md', 'a\ud800.md', 'a\udc00b.md']) {
    throws400(() => normalizePath(p), JSON.stringify(p));
  }
  assert.equal(normalizePath('café/naïve.md'), 'café/naïve.md');
  throws400(() => assertNoCollisions(['café.md', 'café.md']), 'NFC vs NFD');
  throws400(() => assertNoCollisions(['Café/a.md', 'café']), 'NFD file vs NFC folder');
});

/** Clear the UTF-8 flag (bit 11) in every local and central header, as macOS Archive Utility writes. */
function unflag(zip: Uint8Array, rename?: [number, number]): Uint8Array {
  const out = new Uint8Array(zip);
  const dv = new DataView(out.buffer);
  for (let o = 0; o + 4 <= out.length; o++) {
    const sig = dv.getUint32(o, true);
    const at = sig === 0x04034b50 ? { flags: 6, name: 30 } : sig === 0x02014b50 ? { flags: 8, name: 46 } : null;
    if (!at) continue;
    dv.setUint16(o + at.flags, dv.getUint16(o + at.flags, true) & ~0x800, true);
    if (rename) out[o + at.name + rename[0]] = rename[1];
  }
  return out;
}

test('zip names without the UTF-8 flag: UTF-8 first (macOS), CP437 for bytes that are not UTF-8', () => {
  const mac = unflag(zipSync({ 'skill/référence.md': strToU8('x') }));
  assert.deepEqual(safeUnzip(mac).map((f) => f.path), ['skill/référence.md']);
  // 'rXf.md' with X patched to 0x82: not valid UTF-8, CP437 'é'.
  const dos = unflag(zipSync({ 'rXf.md': strToU8('x') }), [1, 0x82]);
  assert.deepEqual(safeUnzip(dos).map((f) => f.path), ['réf.md']);
});
