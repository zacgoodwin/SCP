import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { makeTestCtx, insertGroup, type TestCtx, type TestUser } from './helpers.ts';
import { buildZip, safeUnzip } from '../src/lib/zip.ts';
import { createItemTx, entryPathFor, insertRow, loadEditableItem, renameFrontmatter, searchItems } from '../src/items/service.ts';
import type { Principal } from '../src/types.ts';

const API = '/api/v1';
type H = Record<string, string>;

const SKILL_MD = '---\r\nname: pdf\r\ndescription: >-\r\n  Extract tables from PDF invoices.\r\n---\r\n\r\n# PDF\r\nUse scripts/run.sh.\r\n';
const AGENT_MD = '---\nname: reviewer\ndescription: Reviews pull requests for bugs.\nmodel: sonnet\n---\nYou review code.\n';

function setup() {
  const t = makeTestCtx();
  const u = t.createUser();
  return { t, u, h: t.key(u).headers };
}

const post = (t: TestCtx, h: H, json: unknown) => t.req('POST', `${API}/items`, { headers: h, json });

async function create(t: TestCtx, h: H, json: unknown) {
  const r = await post(t, h, json);
  assert.equal(r.status, 201, r.text);
  return r.json.item;
}

function importFile(t: TestCtx, h: H, filename: string, bytes: Uint8Array, fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('file', new File([bytes as Uint8Array<ArrayBuffer>], filename));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return t.req('POST', `${API}/items/import`, { headers: h, body: fd });
}

const principal = (u: TestUser, extra: Partial<Principal> = {}): Principal => ({
  userId: u.id,
  username: u.username,
  isAdmin: u.isAdmin,
  via: 'session',
  scopes: ['read', 'write'],
  groupIds: null,
  ...extra,
});

test('skill via files keeps exact CRLF bytes; derives name, title, description', async () => {
  const { t, h } = setup();
  const item = await create(t, h, {
    kind: 'skill',
    files: [
      { path: 'SKILL.md', content: SKILL_MD },
      { path: 'scripts/run.sh', content: '#!/bin/sh\r\necho hi\n', mode: 493 },
      { path: 'logo.bin', contentBase64: Buffer.from([0, 1, 2, 255]).toString('base64') },
    ],
  });
  assert.equal(item.name, 'pdf');
  assert.equal(item.plane, 'skill');
  assert.equal(item.title, 'pdf');
  assert.equal(item.description, 'Extract tables from PDF invoices.');
  assert.equal(item.latestSeq, 1);
  assert.equal(item.canEdit, true);
  assert.equal(item.version.entryPath, 'SKILL.md');
  assert.deepEqual(item.version.lint, []);
  assert.deepEqual(item.version.frontmatter, { name: 'pdf', description: 'Extract tables from PDF invoices.' });
  assert.deepEqual(
    item.version.files.map((f: { path: string; mode: number }) => [f.path, f.mode]),
    [['SKILL.md', 420], ['logo.bin', 420], ['scripts/run.sh', 493]],
  );
  const raw = await t.req('GET', `${API}/items/${item.id}/files/SKILL.md`, { headers: h });
  assert.equal(raw.status, 200);
  assert.deepEqual(raw.bytes, new TextEncoder().encode(SKILL_MD));
  const bin = await t.req('GET', `${API}/items/${item.id}/files/logo.bin`, { headers: h });
  assert.deepEqual([...bin.bytes], [0, 1, 2, 255]);
  assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await t.req('GET', `${API}/items/${item.id}/files/nope.md`, { headers: h })).status, 404);
  const audit = t.db.prepare("SELECT action FROM audit WHERE target_id = ?").all(item.id) as { action: string }[];
  assert.deepEqual(audit.map((a) => a.action), ['item.create']);
});

test('title from the first heading: trailing #s and CR trimmed, linear on long space runs', async () => {
  const { t, h } = setup();
  const ok = await create(t, h, { kind: 'instructions', name: 'rules', content: 'intro\r\n#   Hello  World ##\r\n# Second\n' });
  assert.equal(ok.title, 'Hello  World');
  // The old /^#[ \t]+(.+?)[ \t#]*\r?$/m took ~1.6 s here (quadratic backtracking).
  const content = `# a${' '.repeat(50_000)}b\n${'#'.repeat(5)}${' '.repeat(50_000)}\n`;
  const t0 = performance.now();
  const big = await create(t, h, { kind: 'instructions', name: 'big', content });
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `${ms} ms`);
  assert.equal(big.title, `a${' '.repeat(50_000)}b`);
});

test('content shorthand: artifact and agent stored at their entry paths', async () => {
  const { t, h } = setup();
  const art = await create(t, h, { kind: 'artifact', format: 'html', title: 'Sales Dashboard', content: '<h1>hi</h1>' });
  assert.equal(art.name, 'sales-dashboard');
  assert.equal(art.format, 'html');
  assert.equal(art.plane, 'artifact');
  assert.deepEqual(art.version.files.map((f: { path: string }) => f.path), ['index.html']);
  const agent = await create(t, h, { kind: 'agent', content: AGENT_MD });
  assert.equal(agent.name, 'reviewer');
  assert.equal(agent.version.entryPath, 'reviewer.md');
  assert.equal(agent.description, 'Reviews pull requests for bugs.');
  // single-file kinds re-home whatever path was uploaded
  const cmd = await create(t, h, { kind: 'command', name: 'ship', files: [{ path: 'whatever/x.md', content: 'Ship it.' }] });
  assert.deepEqual(cmd.version.files.map((f: { path: string }) => f.path), ['ship.md']);
  assert.equal(entryPathFor('artifact', 'x', 'react'), 'App.jsx');
  assert.equal(entryPathFor('instructions', 'x'), 'AGENTS.md');
});

test('create validation: format, files/content, names, tags, duplicates, multi-file agent', async () => {
  const { t, h } = setup();
  assert.equal((await post(t, h, { kind: 'artifact', content: 'x', name: 'a' })).status, 400, 'artifact needs format');
  assert.equal((await post(t, h, { kind: 'prompt', format: 'html', content: 'x', name: 'a' })).status, 400, 'format only for artifacts');
  assert.equal((await post(t, h, { kind: 'prompt', name: 'a' })).status, 400, 'files or content');
  assert.equal((await post(t, h, { kind: 'prompt', name: 'a', content: 'x', files: [] })).status, 400, 'not both');
  assert.equal((await post(t, h, { kind: 'prompt', name: 'Bad Name', content: 'x' })).json.error.code, 'invalid_name');
  assert.equal((await post(t, h, { kind: 'prompt', content: 'no name anywhere' })).status, 400);
  const tags = Array.from({ length: 21 }, (_, i) => `t${i}`);
  assert.equal((await post(t, h, { kind: 'prompt', name: 'a', content: 'x', tags })).status, 400);
  const ok = await create(t, h, { kind: 'prompt', name: 'a', content: 'x', tags: ['Foo', 'foo', ' BAR '] });
  assert.deepEqual(ok.tags, ['foo', 'bar']);
  const dup = await post(t, h, { kind: 'prompt', name: 'a', content: 'y' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'name_taken');
  const two = [{ path: 'a.md', content: 'a' }, { path: 'b.md', content: 'b' }];
  assert.equal((await post(t, h, { kind: 'agent', name: 'z', files: two })).status, 400);
  assert.equal((await post(t, h, { kind: 'skill', name: 'z', files: [{ path: 'README.md', content: 'x' }] })).status, 400, 'skill needs SKILL.md');
  const slip = await post(t, h, { kind: 'package', name: 'p', files: [{ path: '../evil.md', content: 'x' }] });
  assert.equal(slip.status, 400);
  const many = Array.from({ length: 1001 }, (_, i) => ({ path: `f${i}.md`, content: 'x' }));
  const big = await post(t, h, { kind: 'package', name: 'p', files: many });
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, 'too_large');
  // package entry falls back to the first .md; junk is dropped and reported
  const pkg = await create(t, h, {
    kind: 'package',
    name: 'rules',
    files: [{ path: 'rules/b.md', content: '# B' }, { path: 'rules/a.md', content: '# A' }, { path: 'rules/.DS_Store', content: 'x' }],
  });
  assert.equal(pkg.version.entryPath, 'a.md');
  assert.equal(pkg.title, 'A');
  assert.deepEqual(pkg.version.lint, [{ level: 'info', code: 'path.junk', message: 'dropped build/OS junk file', path: 'rules/.DS_Store' }]);
});

test('lint gate: skill name mismatch, agent missing description, BOM before ---', async () => {
  const { t, h } = setup();
  const mismatch = await post(t, h, { kind: 'skill', name: 'pdf-tools', content: '---\nname: pdf\ndescription: d\n---\n' });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.json.error.code, 'lint_failed');
  assert.ok(mismatch.json.error.details.some((l: { code: string }) => l.code === 'skill.name.dir'));
  const noDesc = await post(t, h, { kind: 'agent', content: '---\nname: rev\n---\nbody' });
  assert.equal(noDesc.status, 422);
  assert.ok(noDesc.json.error.details.some((l: { code: string }) => l.code === 'agent.description.missing'));
  const bom = await post(t, h, { kind: 'agent', name: 'rev', content: '\uFEFF' + AGENT_MD });
  assert.equal(bom.status, 422);
  assert.ok(bom.json.error.details.some((l: { code: string }) => l.code === 'frontmatter.invalid'));
  const g = globalThis as { SCP_PWNED2?: number };
  const js = await post(t, h, { kind: 'agent', name: 'js', content: '---js\n({ name: (globalThis.SCP_PWNED2 = 1, "x") })\n---\n' });
  assert.equal(js.status, 422);
  assert.ok(js.json.error.details.some((l: { code: string }) => l.code === 'frontmatter.invalid'));
  assert.equal(g.SCP_PWNED2, undefined);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 0, 'nothing stored');
});

test('skill zip import: top folder stripped, exec bit round-trips through download.zip', async () => {
  const { t, h } = setup();
  const zip = zipSync({
    'pdf/SKILL.md': strToU8(SKILL_MD),
    'pdf/scripts/run.sh': [strToU8('#!/bin/sh\necho hi\n'), { os: 3, attrs: (0o100755 << 16) >>> 0 }],
    'pdf/__pycache__/x.pyc': strToU8('junk'),
  });
  const r = await importFile(t, h, 'pdf.skill', zip);
  assert.equal(r.status, 201, r.text);
  const item = r.json.item;
  assert.equal(item.kind, 'skill');
  assert.equal(item.name, 'pdf');
  assert.deepEqual(
    item.version.files.map((f: { path: string; mode: number }) => [f.path, f.mode]),
    [['SKILL.md', 420], ['scripts/run.sh', 493]],
  );
  const dl = await t.req('GET', `${API}/items/${item.id}/download.zip`, { headers: h });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="pdf.zip"');
  const back = safeUnzip(dl.bytes);
  assert.deepEqual(back.map((f) => [f.path, f.mode]).sort(), [['pdf/SKILL.md', 420], ['pdf/scripts/run.sh', 493]]);
  assert.deepEqual(back.find((f) => f.path === 'pdf/SKILL.md')!.bytes, new TextEncoder().encode(SKILL_MD));
});

test('contentBase64: whitespace is allowed, a long whitespace run is rejected in linear time', async () => {
  const { t, h } = setup();
  const ok = await create(t, h, { kind: 'skill', files: [{ path: 'SKILL.md', content: SKILL_MD }, { path: 'a.bin', contentBase64: ' AAEC\n/w==\n' }] });
  assert.ok(ok.version.files.some((f: { path: string; size: number }) => f.path === 'a.bin' && f.size === 4));
  const started = Date.now();
  const r = await post(t, h, { kind: 'skill', files: [{ path: 'SKILL.md', content: SKILL_MD }, { path: 'a.bin', contentBase64: ' '.repeat(200_000) + '!' }] });
  assert.equal(r.status, 400);
  // The old pattern backtracked O(n^2): about 10 s here. Linear is a few ms.
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('insertRow takes column names only from its fixed lists', () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const row = {
    id: 'x1', owner_id: u.id, kind: 'skill', name: 'n', title: '', description: '', category: '', tags: '[]',
    visibility: 'private', format: null, latest_seq: 0, source_repo: null, source_ref: null, source_path: null,
    source_kind: null, source_commit: null, source_tree_sha256: null, source_scope: null, source_carve: null, lint_waived: 0, source_prefix: null, supplied_frontmatter: null, upstream_frontmatter: 0, forked_from: null, created_at: 'now', updated_at: 'now',
  };
  assert.throws(() => insertRow(t.db, 'items', { ...row, 'name) VALUES (1); DROP TABLE users; --': 1 }), /do not match/);
  assert.throws(() => insertRow(t.db, 'items', { id: 'x2' }), /do not match/);
  insertRow(t.db, 'items', row);
  assert.equal((t.db.prepare("SELECT name FROM items WHERE id = 'x1'").get() as { name: string }).name, 'n');
});

test('import detection and rejection', async () => {
  const { t, h } = setup();
  const kindOf = async (name: string, body: string | Uint8Array, fields?: Record<string, string>) => {
    const r = await importFile(t, h, name, typeof body === 'string' ? strToU8(body) : body, fields);
    assert.equal(r.status, 201, `${name}: ${r.text}`);
    return [r.json.item.kind, r.json.item.name, r.json.item.format];
  };
  assert.deepEqual(await kindOf('reviewer.md', AGENT_MD), ['agent', 'reviewer', null]);
  assert.deepEqual(await kindOf('CLAUDE.md', '# Rules\n'), ['instructions', 'rules', null], 'heading title beats file name');
  assert.deepEqual(await kindOf('GEMINI.md', 'Be terse.\n'), ['instructions', 'gemini', null]);
  assert.deepEqual(await kindOf('INSTRUCTIONS.md', 'Be terse.\n'), ['instructions', 'instructions', null], 'as a pack import detects it');
  assert.deepEqual(await kindOf('DESIGN.md', '---\nname: Example Notes\n---\n## Overview\n'), ['design', 'example-notes', null]);
  assert.deepEqual(await kindOf('Snippet.md', 'Summarize {{text}}'), ['prompt', 'snippet', null]);
  assert.deepEqual(await kindOf('notes.md', 'x', { kind: 'command', name: 'notes-cmd' }), ['command', 'notes-cmd', null]);
  assert.deepEqual(await kindOf('My Tool.html', '<b>x</b>'), ['artifact', 'my-tool', 'html']);
  assert.deepEqual(await kindOf('flow.mmd', 'graph TD; a-->b'), ['artifact', 'flow', 'mermaid']);
  assert.deepEqual(await kindOf('App.tsx', 'export default () => null'), ['artifact', 'app', 'react']);
  assert.deepEqual(await kindOf('SKILL.md', SKILL_MD), ['skill', 'pdf', null], 'a lone SKILL.md is a skill, not an agent');
  assert.deepEqual(await kindOf('doc.md', '# Doc\n', { kind: 'artifact' }), ['artifact', 'doc', 'markdown']);
  const zipArt = await importFile(t, h, 'a.zip', zipSync({ 'index.html': strToU8('<b>x</b>') }), { kind: 'artifact' });
  assert.equal(zipArt.status, 400);
  assert.match(zipArt.json.error.message, /an artifact is one file/);
  assert.deepEqual(await kindOf('bundle.zip', zipSync({ 'ds/DESIGN.md': strToU8('## Colors\n'),'ds/tokens.css': strToU8(':root{}') })), ['design', 'ds', null]);
  const bad = await importFile(t, h, 'x.exe', strToU8('MZ'));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'unsupported_file');
  for (const name of ['../x', '/abs', 'C:/x', 'a\\b']) {
    assert.equal((await importFile(t, h, 's.zip', zipSync({ [name]: strToU8('x') }))).status, 400, name);
  }
  const link = zipSync({ 'SKILL.md': strToU8(SKILL_MD), l: [strToU8('/etc'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] });
  assert.equal((await importFile(t, h, 's.zip', link)).status, 400);
  const bomb = zipSync({ 'SKILL.md': strToU8(SKILL_MD), 'big.txt': new Uint8Array(2 * 1024 * 1024) }, { level: 9 });
  assert.equal((await importFile(t, h, 's.zip', bomb)).status, 413);
  // multipart with a cookie session needs a same-origin Origin header (CSRF)
  const s = t.session(t.createUser());
  assert.equal((await importFile(t, { ...s, Origin: 'http://evil.test' }, 'a.md', strToU8('x'))).status, 403);
  assert.equal((await importFile(t, s, 'a.md', strToU8('x'))).status, 201);
});

test('versions increment, old versions stay readable, tree hash is content-addressed', async () => {
  const { t, h } = setup();
  const v1 = await create(t, h, { kind: 'agent', content: AGENT_MD });
  const AGENT2 = AGENT_MD.replace('bugs', 'security bugs');
  const r = await t.req('POST', `${API}/items/${v1.id}/versions`, { headers: h, json: { content: AGENT2, note: 'sec' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.item.latestSeq, 2);
  assert.equal(r.json.item.description, 'Reviews pull requests for security bugs.');
  const old = await t.req('GET', `${API}/items/${v1.id}/files/reviewer.md?version=1`, { headers: h });
  assert.equal(old.text, AGENT_MD);
  assert.equal((await t.req('GET', `${API}/items/${v1.id}/files/reviewer.md`, { headers: h })).text, AGENT2);
  const list = await t.req('GET', `${API}/items/${v1.id}/versions`, { headers: h });
  assert.deepEqual(list.json.versions.map((v: { seq: number }) => v.seq), [2, 1]);
  const d1 = await t.req('GET', `${API}/items/${v1.id}/versions/1`, { headers: h });
  assert.equal(d1.json.version.treeSha256, v1.version.treeSha256);
  assert.equal((await t.req('GET', `${API}/items/${v1.id}/versions/9`, { headers: h })).status, 404);
  assert.equal((await t.req('GET', `${API}/items/${v1.id}?version=1`, { headers: h })).json.item.version.seq, 1);
  // same bytes again -> same tree hash, blob deduplicated
  const r3 = await t.req('POST', `${API}/items/${v1.id}/versions`, { headers: h, json: { content: AGENT_MD } });
  assert.equal(r3.json.item.version.treeSha256, v1.version.treeSha256);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n, 2);
  // lint gate applies to new versions too
  const bad = await t.req('POST', `${API}/items/${v1.id}/versions`, { headers: h, json: { content: '---\nname: reviewer\n---\n' } });
  assert.equal(bad.status, 422);
  const actions = (t.db.prepare('SELECT action FROM audit WHERE target_id = ? ORDER BY id').all(v1.id) as { action: string }[]).map((a) => a.action);
  assert.deepEqual(actions, ['item.create', 'item.version', 'item.version']);
});

test('access: private 404, public 200, PATCH 404/403, read-only key 403', async () => {
  const { t, u, h } = setup();
  const other = t.createUser();
  const oh = t.key(other).headers;
  const item = await create(t, h, { kind: 'prompt', name: 'secret', content: 'x' });
  assert.equal((await t.req('GET', `${API}/items/${item.id}`, { headers: oh })).status, 404);
  assert.equal((await t.req('GET', `${API}/items/${item.id}/files/secret.md`, { headers: oh })).status, 404);
  assert.equal((await t.req('GET', `${API}/items/${item.id}/download.zip`, { headers: oh })).status, 404);
  assert.equal((await t.req('PATCH', `${API}/items/${item.id}`, { headers: oh, json: { title: 'x' } })).status, 404);
  assert.equal((await t.req('DELETE', `${API}/items/${item.id}`, { headers: oh })).status, 404);
  assert.equal((await t.req('GET', `${API}/items/${item.id}`)).status, 401);
  const pub = await t.req('PATCH', `${API}/items/${item.id}`, { headers: h, json: { visibility: 'public', title: 'Shared', tags: ['A'] } });
  assert.equal(pub.status, 200);
  assert.equal(pub.json.item.title, 'Shared');
  assert.deepEqual(pub.json.item.tags, ['a']);
  const seen = await t.req('GET', `${API}/items/${item.id}`, { headers: oh });
  assert.equal(seen.status, 200);
  assert.equal(seen.json.item.canEdit, false);
  assert.equal(seen.json.item.owner.username, u.username);
  const patch = await t.req('PATCH', `${API}/items/${item.id}`, { headers: oh, json: { title: 'x' } });
  assert.equal(patch.status, 403);
  assert.equal((await t.req('POST', `${API}/items/${item.id}/versions`, { headers: oh, json: { content: 'y' } })).status, 403);
  const ro = t.key(u, { scopes: ['read'] }).headers;
  assert.equal((await t.req('PATCH', `${API}/items/${item.id}`, { headers: ro, json: { title: 'x' } })).status, 403);
  assert.equal((await post(t, ro, { kind: 'prompt', name: 'b', content: 'x' })).status, 403);
  assert.equal((await t.req('GET', `${API}/items/${item.id}`, { headers: ro })).status, 200);
  assert.throws(() => loadEditableItem(t.db, principal(other), item.id), { status: 403 });
});

test('restricted key cannot create and reads only its groups', async () => {
  const { t, u, h } = setup();
  const inGroup = await create(t, h, { kind: 'prompt', name: 'in', content: 'x' });
  const outside = await create(t, h, { kind: 'prompt', name: 'out', content: 'x', visibility: 'public' });
  const g = insertGroup(t, u, { slug: 'team', members: [inGroup.id] });
  const rk = t.key(u, { groupIds: [g] }).headers;
  const r = await post(t, rk, { kind: 'prompt', name: 'new', content: 'x' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'restricted_key');
  assert.equal((await importFile(t, rk, 'a.md', strToU8('x'))).status, 403);
  assert.equal((await t.req('POST', `${API}/items/${inGroup.id}/fork`, { headers: rk })).status, 403);
  assert.equal((await t.req('GET', `${API}/items/${inGroup.id}`, { headers: rk })).status, 200);
  assert.equal((await t.req('GET', `${API}/items/${outside.id}`, { headers: rk })).status, 404);
  const list = await t.req('GET', `${API}/items`, { headers: rk });
  assert.deepEqual(list.json.items.map((i: { name: string }) => i.name), ['in']);
  assert.equal(list.json.total, 1);
  // the restricted key may still version an item inside its group
  assert.equal((await t.req('POST', `${API}/items/${inGroup.id}/versions`, { headers: rk, json: { content: 'y' } })).status, 201);
  // the MCP chunk's escape hatch: create inside its own transaction and add to the group
  const p = principal(u, { via: 'key', groupIds: [g] });
  assert.equal(createItemTx(t.ctx, p, { kind: 'artifact', format: 'svg', name: 'pic', content: '<svg/>' }, { skipRestrictedCheck: true }).name, 'pic');
  const detail = await t.req('GET', `${API}/items/${inGroup.id}`, { headers: h });
  assert.deepEqual(detail.json.item.groups, [{ slug: 'team', name: 'Group' }]);
});

test('raw files are served inert: text/plain, sandbox CSP, nosniff, ETag 304, download', async () => {
  const { t, h } = setup();
  const art = await create(t, h, { kind: 'artifact', format: 'html', name: 'page', content: '<script>alert(1)</script>' });
  const r = await t.req('GET', `${API}/items/${art.id}/files/index.html`, { headers: h });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(r.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const etag = r.headers.get('etag')!;
  assert.match(etag, /^"[0-9a-f]{64}"$/);
  const cached = await t.req('GET', `${API}/items/${art.id}/files/index.html`, { headers: { ...h, 'If-None-Match': etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.bytes.length, 0);
  const stale = await t.req('GET', `${API}/items/${art.id}/files/index.html`, { headers: { ...h, 'If-None-Match': '"abc"' } });
  assert.equal(stale.status, 200);
  const dl = await t.req('GET', `${API}/items/${art.id}/files/index.html?download=1`, { headers: h });
  assert.equal(dl.headers.get('content-disposition'), "attachment; filename*=UTF-8''index.html");
  const svg = await create(t, h, { kind: 'artifact', format: 'svg', name: 'pic', content: '<svg onload="x()"/>' });
  const s = await t.req('GET', `${API}/items/${svg.id}/files/image.svg`, { headers: h });
  assert.equal(s.headers.get('content-type'), 'text/plain; charset=utf-8');
  // encoded paths resolve
  const pkg = await create(t, h, { kind: 'package', name: 'p', files: [{ path: 'README.md', content: 'r' }, { path: 'my notes.md', content: 'n' }] });
  assert.equal((await t.req('GET', `${API}/items/${pkg.id}/files/my%20notes.md`, { headers: h })).text, 'n');
});

test('search: description words, prefixes, access, plane/kind/group filters, owner=me', async () => {
  const { t, u, h } = setup();
  const other = t.createUser();
  const oh = t.key(other).headers;
  const a = await create(t, h, { kind: 'agent', content: AGENT_MD });
  await create(t, h, { kind: 'prompt', name: 'invoice-helper', content: 'x', description: 'Parses supplier invoices' });
  await create(t, h, { kind: 'artifact', format: 'markdown', name: 'notes', content: '# Weekly notes\nquarterly revenue' });
  const theirs = await create(t, oh, { kind: 'prompt', name: 'their-invoices', content: 'x', description: 'private invoices' });
  const search = async (qs: string, hh: H = h) => {
    const r = await t.req('GET', `${API}/search?${qs}`, { headers: hh });
    assert.equal(r.status, 200, r.text);
    return r.json.results.map((i: { name: string }) => i.name).sort();
  };
  assert.deepEqual(await search('q=pull'), ['reviewer']);
  assert.deepEqual(await search('q=invoi'), ['invoice-helper'], 'prefix match, other user private hidden');
  assert.deepEqual(await search('q=invoi', oh), ['their-invoices']);
  assert.deepEqual(await search('q=quarterly'), ['notes'], 'entry body is indexed');
  assert.deepEqual(await search('q=reviews%20code'), ['reviewer']);
  assert.deepEqual(await search('q=reviews%20zebra'), [], 'all terms must match');
  assert.deepEqual(await search('q=%22%20OR%20*'), [], 'FTS syntax is quoted, never interpreted');
  assert.deepEqual(await search('q=pull%00x'), [], 'a control character separates words instead of a 500');
  for (const path of [`${API}/items?q=x%00y`, `${API}/groups?q=x%00y`]) assert.equal((await t.req('GET', path, { headers: h })).status, 200, path);
  assert.deepEqual(await search('plane=md'), ['invoice-helper', 'reviewer']);
  assert.deepEqual(await search('kind=artifact'), ['notes']);
  const g = insertGroup(t, other, { slug: 'pub', visibility: 'public', members: [theirs.id] });
  assert.deepEqual(await search('group=pub'), ['their-invoices'], 'public group publishes its members');
  assert.equal((await t.req('GET', `${API}/search?group=nope`, { headers: h })).status, 404);
  insertGroup(t, other, { slug: 'hidden', members: [theirs.id] });
  assert.equal((await t.req('GET', `${API}/search?group=hidden`, { headers: h })).status, 404);
  assert.equal(searchItems(t.db, principal(u), { groupId: g }).total, 1);
  const mine = await t.req('GET', `${API}/items?owner=me&limit=2`, { headers: h });
  assert.equal(mine.json.total, 3);
  assert.equal(mine.json.items.length, 2);
  const all = await t.req('GET', `${API}/items`, { headers: h });
  assert.equal(all.json.total, 4, 'includes the group-published item');
  // /items honours ?group= like /search, with the same 404 for unreadable groups
  const inPub = await t.req('GET', `${API}/items?group=pub`, { headers: h });
  assert.deepEqual(inPub.json.items.map((i: { name: string }) => i.name), ['their-invoices']);
  assert.equal(inPub.json.total, 1);
  assert.equal((await t.req('GET', `${API}/items?group=hidden`, { headers: h })).status, 404);
  assert.equal((await t.req('GET', `${API}/items?limit=0`, { headers: h })).status, 400);
  // metadata edits are re-indexed
  await t.req('PATCH', `${API}/items/${a.id}`, { headers: h, json: { tags: ['golang'] } });
  assert.deepEqual(await search('q=golang'), ['reviewer']);
});

test('PATCH keeps omitted fields and clears text fields with null or empty string', async () => {
  const { t, h } = setup();
  const a = await create(t, h, { kind: 'agent', content: AGENT_MD, title: 'T', description: 'D', category: 'review' });
  const patch = (json: unknown) => t.req('PATCH', `${API}/items/${a.id}`, { headers: h, json });
  // The web details form sends category: null when no category is picked.
  const r1 = await patch({ title: 'T2', description: 'D', category: null, tags: [], visibility: 'public' });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.item.category, '');
  assert.equal(r1.json.item.title, 'T2');
  assert.equal(r1.json.item.visibility, 'public');
  const r2 = await patch({ tags: ['x'] });
  assert.equal(r2.json.item.title, 'T2', 'omitted fields are kept');
  assert.equal(r2.json.item.description, 'D');
  const r3 = await patch({ title: '', description: '  ' });
  assert.equal(r3.json.item.title, '');
  assert.equal(r3.json.item.description, '');
  assert.equal((await patch({ category: 5 })).status, 400);
});

test('fork copies files and sets forkedFrom; delete removes item and FTS row', async () => {
  const { t, h } = setup();
  const other = t.createUser();
  const oh = t.key(other).headers;
  const src = await create(t, h, { kind: 'agent', content: AGENT_MD, visibility: 'public', tags: ['x'] });
  const f1 = await t.req('POST', `${API}/items/${src.id}/fork`, { headers: oh });
  assert.equal(f1.status, 201, f1.text);
  assert.equal(f1.json.item.forkedFrom, src.id);
  assert.equal(f1.json.item.name, 'reviewer-fork');
  assert.equal(f1.json.item.visibility, 'private');
  assert.deepEqual(f1.json.item.tags, ['x']);
  const body = await t.req('GET', `${API}/items/${f1.json.item.id}/files/reviewer-fork.md`, { headers: oh });
  // The agent's identity is its frontmatter name, so the fork gets its own; the rest is verbatim.
  assert.equal(body.text, AGENT_MD.replace('name: reviewer\n', 'name: reviewer-fork\n'));
  const f2 = await t.req('POST', `${API}/items/${src.id}/fork`, { headers: oh });
  assert.equal(f2.json.item.name, 'reviewer-fork-2');
  const skill = await create(t, h, { kind: 'skill', content: '---\nname: pdf\ndescription: d\n---\n' });
  const sf = await t.req('POST', `${API}/items/${skill.id}/fork`, { headers: h });
  assert.equal(sf.status, 201);
  // Renamed to pdf-fork, and its SKILL.md frontmatter with it, so it passes its own lint.
  assert.equal(sf.json.item.name, 'pdf-fork');
  assert.equal(sf.json.item.version.frontmatter.name, 'pdf-fork');
  assert.ok(!sf.json.item.version.lint.some((l: { code: string }) => l.code === 'skill.name.dir'));
  // Another user's skill fork keeps the name (it is bound to the SKILL.md frontmatter), so it lints clean.
  const pub = await create(t, h, { kind: 'skill', visibility: 'public', content: '---\nname: csv\ndescription: d\n---\n' });
  const of = await t.req('POST', `${API}/items/${pub.id}/fork`, { headers: oh });
  assert.equal(of.status, 201, of.text);
  assert.equal(of.json.item.name, 'csv');
  assert.ok(!of.json.item.version.lint.some((l: { level: string }) => l.level === 'error'), JSON.stringify(of.json.item.version.lint));
  const of2 = await t.req('POST', `${API}/items/${pub.id}/fork`, { headers: oh });
  assert.equal(of2.json.item.name, 'csv-fork', 'a taken name still gets the suffix');

  const ftsCount = () => (t.db.prepare('SELECT COUNT(*) AS n FROM items_fts WHERE item_id = ?').get(src.id) as { n: number }).n;
  assert.equal(ftsCount(), 1);
  assert.equal((await t.req('DELETE', `${API}/items/${src.id}`, { headers: h })).status, 204);
  assert.equal(ftsCount(), 0);
  assert.equal((await t.req('GET', `${API}/items/${src.id}`, { headers: h })).status, 404);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM item_versions WHERE item_id = ?').get(src.id) as { n: number }).n, 0);
  const forked = await t.req('GET', `${API}/items/${f1.json.item.id}`, { headers: oh });
  assert.equal(forked.json.item.forkedFrom, null, 'fork survives with the link cleared');
  const actions = (t.db.prepare("SELECT action FROM audit WHERE action IN ('item.fork', 'item.delete')").all() as { action: string }[]).map((a) => a.action);
  assert.deepEqual(actions.sort(), ['item.delete', 'item.fork', 'item.fork', 'item.fork', 'item.fork', 'item.fork']);
});

test('item names follow the same Windows segment rules as file paths', async () => {
  const { t, h } = setup();
  const bad: [string, string][] = [
    ['package', 'kit.'],
    ['agent', 'aux'],
    ['prompt', 'con.md'],
    ['skill', 'nul'],
    ['package', 'git~1'],
  ];
  for (const [kind, name] of bad) {
    const files = kind === 'skill' ? [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: d\n---\n` }] : undefined;
    const r = await post(t, h, { kind, name, ...(files ? { files } : { content: '# x' }) });
    assert.equal(r.status, 400, `${kind} ${name}: ${r.text}`);
    assert.equal(r.json.error.code, 'invalid_name');
  }
  // Names that only look similar are fine.
  for (const name of ['kit', 'aux-tools', 'console']) assert.equal((await post(t, h, { kind: 'package', name, content: '# x' })).status, 201, name);
});

test('a stored tree keeps its real top folder through fork and new versions', async () => {
  const { t, h } = setup();
  // The upload's wrapper folder is stripped once at create: stored as docs/guide.md.
  const pkg = await create(t, h, { kind: 'package', name: 'guide', files: [{ path: 'wrap/docs/guide.md', content: '# Guide' }] });
  assert.deepEqual(pkg.version.files.map((f: { path: string }) => f.path), ['docs/guide.md']);
  const fork = await t.req('POST', `${API}/items/${pkg.id}/fork`, { headers: h });
  assert.equal(fork.status, 201, fork.text);
  assert.deepEqual(fork.json.item.version.files.map((f: { path: string }) => f.path), ['docs/guide.md']);
  const v2 = await t.req('POST', `${API}/items/${pkg.id}/versions`, { headers: h, json: { files: [{ path: 'docs/guide.md', content: '# Guide v2' }] } });
  assert.equal(v2.status, 201, v2.text);
  assert.deepEqual(v2.json.item.version.files.map((f: { path: string }) => f.path), ['docs/guide.md']);
  // A version upload that wraps a skill still gets unwrapped, because that brings SKILL.md to the root.
  const skill = await create(t, h, { kind: 'skill', files: [{ path: 'SKILL.md', content: SKILL_MD }] });
  const wrapped = await t.req('POST', `${API}/items/${skill.id}/versions`, { headers: h, json: { files: [{ path: 'pdf/SKILL.md', content: SKILL_MD }] } });
  assert.equal(wrapped.status, 201, wrapped.text);
  assert.deepEqual(wrapped.json.item.version.files.map((f: { path: string }) => f.path), ['SKILL.md']);
});

test('buildZip output imports back as the same tree', async () => {
  const { t, h } = setup();
  const zip = buildZip([
    { path: 'SKILL.md', bytes: strToU8('---\nname: roundtrip\ndescription: d\n---\n'), mode: 420 },
    { path: 'bin/x', bytes: strToU8('#!/bin/sh'), mode: 493 },
  ]);
  const r = await importFile(t, h, 'roundtrip.zip', zip);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.item.version.files.map((f: { path: string; mode: number }) => [f.path, f.mode]), [['SKILL.md', 420], ['bin/x', 493]]);
});

test('renameFrontmatter (5ef6): replaces or inserts the name line keeping every other byte, re-emits what a line edit cannot set, null when the frontmatter does not parse', () => {
  assert.equal(renameFrontmatter('---\nname: a\ndescription: d # kept\n---\nBody.\n', 'x-a'), '---\nname: x-a\ndescription: d # kept\n---\nBody.\n');
  assert.equal(renameFrontmatter('---\r\ndescription: d\r\n---\r\nBody.\r\n', 'x-a'), '---\r\nname: x-a\r\ndescription: d\r\n---\r\nBody.\r\n');
  assert.equal(renameFrontmatter('# Title\n', 'x-a'), '---\nname: x-a\n---\n# Title\n');
  // A slug YAML would read as another type is quoted, so it parses back as the name.
  assert.equal(renameFrontmatter('---\nname: a\n---\n', 'null'), '---\nname: "null"\n---\n');
  assert.equal(renameFrontmatter('---\n"name": a\ndescription: d\n---\n', 'x-a'), '---\n"name": x-a\ndescription: d\n---\n');
  assert.equal(renameFrontmatter('---\nname: >\n  a\ndescription: d\n---\n', 'x-a'), '---\nname: >-\n  x-a\ndescription: d\n---\n');
  assert.equal(renameFrontmatter('---\nname: a\ndescription: Use when: x\n---\n', 'x-a'), null);
  assert.equal(renameFrontmatter('---\nname: a\n', 'x-a'), null);
  assert.equal(renameFrontmatter('\n---\nname: a\n---\n', 'x-a'), null);
});
