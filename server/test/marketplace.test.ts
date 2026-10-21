import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestCtx, type TestCtx } from './helpers.ts';
import { newId, now, tx } from '../src/db.ts';
import { sha256Hex } from '../src/lib/crypto.ts';
import { AUTH_LIMITS } from '../src/lib/ratelimit.ts';
import { safeUnzip } from '../src/lib/zip.ts';
import { pluginPath, pluginProblem, pluginVersion } from '../src/groups/bundle.ts';
import type { ResolvedMember } from '../src/groups/service.ts';
import type { GroupRow } from '../src/types.ts';

const API = '/api/v1';
type H = Record<string, string>;

const SKILL_MD = '---\nname: pdf\ndescription: Extract tables.\n---\n# PDF\n';
const AGENT_MD = '---\nname: reviewer\ndescription: Reviews code.\n---\nYou review.\n';

async function item(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/items`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.item as { id: string; name: string };
}

/** alice: group kit (one of each component kind, plus a prompt and a design), group empty-one; bob: private secret, public open. */
async function fixture() {
  const t = makeTestCtx();
  const alice = t.createUser({ username: 'alice' });
  const bob = t.createUser({ username: 'bob' });
  const key = t.key(alice);
  const h = key.headers;
  const bh = t.key(bob).headers;
  const skill = await item(t, h, {
    kind: 'skill',
    files: [
      { path: 'SKILL.md', content: SKILL_MD },
      { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', mode: 493 },
    ],
  });
  const agent = await item(t, h, { kind: 'agent', content: AGENT_MD });
  const cmd = await item(t, h, { kind: 'command', name: 'ship', content: 'Ship it.' });
  const prompt = await item(t, h, { kind: 'prompt', name: 'summarize', content: 'Summarize.' });
  const design = await item(t, h, { kind: 'design', name: 'brand', files: [{ path: 'DESIGN.md', content: '## Overview\n' }, { path: 'tokens.css', content: ':root{}' }] });
  const g = await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'kit', name: 'Kit', description: 'All the things' } });
  assert.equal(g.status, 201, g.text);
  for (const it of [skill, agent, cmd, prompt, design]) {
    const m = await t.req('POST', `${API}/groups/kit/members`, { headers: h, json: { itemId: it.id } });
    assert.equal(m.status, 201, m.text);
  }
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'empty-one', name: 'Empty' } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups`, { headers: bh, json: { slug: 'secret', name: 'Secret' } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups`, { headers: bh, json: { slug: 'open', name: 'Open', visibility: 'public' } })).status, 201);
  return { t, alice, bob, key, h, bh, skill, agent, cmd, prompt, design, kitId: g.json.group.id as string };
}

const text = (f: { bytes: Uint8Array } | undefined) => new TextDecoder().decode(f!.bytes);
const unzip = (bytes: Uint8Array) => new Map(safeUnzip(bytes).map((f) => [f.path, f]));

test('pluginPath table', () => {
  assert.equal(pluginPath('skill', 'pdf'), 'skills/pdf/');
  assert.equal(pluginPath('agent', 'rev'), 'agents/rev.md');
  assert.equal(pluginPath('command', 'ship'), 'commands/ship.md');
  assert.equal(pluginPath('prompt', 'p'), 'docs/prompt/p/');
  assert.equal(pluginPath('instructions', 'r'), 'docs/instructions/r/');
  assert.equal(pluginPath('design', 'b'), 'docs/design/b/');
  assert.equal(pluginPath('package', 'k'), 'docs/package/k/');
  assert.equal(pluginPath('artifact', 'd'), 'docs/artifact/d/');
});

test('marketplace.json: one plugin per own or shared-by-name group, archive sources without a sha256 pin, no-store; 404 for a bad token', async () => {
  const { t, key } = await fixture();
  const r = await t.req('GET', `/m/${key.token}/marketplace.json`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.json.name, 'scp-alice');
  assert.deepEqual(r.json.owner, { name: 'alice' });
  const plugins = r.json.plugins as { name: string; description: string; version: string; source: { source: string; url: string; sha256?: string } }[];
  assert.deepEqual(plugins.map((p) => p.name).sort(), ['empty-one', 'kit'], "own groups only: not bob's private one, nor his public one (attacker-sized)");
  const kit = plugins.find((p) => p.name === 'kit')!;
  assert.equal(kit.description, 'All the things');
  assert.match(kit.version, /^\d{8}\.\d{9}$/, 'UTC date and time of the latest change');
  assert.equal(kit.source.source, 'archive');
  assert.equal(kit.source.url, `http://app.test/m/${key.token}/kit/plugin.zip`);
  assert.equal(kit.source.sha256, undefined, 'the optional pin would cost building every zip to list');
  const zip = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
  assert.equal(zip.status, 200, zip.text);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.equal(zip.headers.get('content-disposition'), 'attachment; filename="kit-plugin.zip"');
  assert.ok(sha256Hex(zip.bytes));
  // Unknown, revoked and expired tokens, and a wrong path shape, are plain 404s.
  for (const bad of ['scp_nope', '', 'x']) assert.equal((await t.req('GET', `/m/${bad}/marketplace.json`)).status, 404, bad);
  const revoked = t.key(t.createUser({ username: 'r' }));
  t.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), revoked.id);
  assert.equal((await t.req('GET', `/m/${revoked.token}/marketplace.json`)).status, 404);
  const expired = t.key(t.createUser({ username: 'e' }), { expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal((await t.req('GET', `/m/${expired.token}/marketplace.json`)).status, 404);
  assert.equal((await t.req('GET', `/m/${key.token}/nope/plugin.zip`)).status, 404);
  assert.equal((await t.req('GET', `/m/${key.token}/secret/plugin.zip`)).status, 404, 'unreadable group');
  assert.equal((await t.req('GET', `/m/${key.token}/other.json`)).status, 404);
  assert.equal((await t.req('GET', `/m/${key.token}/marketplace.json/x`)).status, 404);
  // Cookies never authenticate here.
  const { t: t2 } = await fixture();
  const alice2 = t2.db.prepare("SELECT id, username FROM users WHERE username = 'alice'").get() as { id: string; username: string };
  const sess = t2.session({ id: alice2.id, username: alice2.username, email: '', password: '', isAdmin: false });
  assert.equal((await t2.req('GET', `/m/${sess.Cookie.slice('scp_sid='.length)}/marketplace.json`, { headers: sess })).status, 404);
});

test('plugin.zip layout, modes, .mcp.json with the token, deterministic bytes and fixed 1980 mtime', async () => {
  const { t, key, h } = await fixture();
  const first = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
  assert.equal(first.status, 200, first.text);
  const files = unzip(first.bytes);
  assert.deepEqual([...files.keys()].sort(), [
    '.claude-plugin/plugin.json',
    '.mcp.json',
    'agents/reviewer.md',
    'commands/ship.md',
    'docs/design/brand/DESIGN.md',
    'docs/design/brand/tokens.css',
    'docs/prompt/summarize/summarize.md',
    'skills/pdf/SKILL.md',
    'skills/pdf/scripts/run.sh',
  ]);
  assert.equal(files.get('skills/pdf/scripts/run.sh')!.mode, 493);
  assert.equal(text(files.get('agents/reviewer.md')), AGENT_MD);
  assert.equal(text(files.get('commands/ship.md')), 'Ship it.');
  const plugin = JSON.parse(text(files.get('.claude-plugin/plugin.json')));
  assert.equal(plugin.name, 'kit');
  assert.equal(plugin.description, 'All the things');
  assert.match(plugin.version, /^\d{8}\.\d{9}$/);
  assert.deepEqual(JSON.parse(text(files.get('.mcp.json'))), {
    mcpServers: { 'scp-kit': { type: 'http', url: 'http://app.test/mcp/kit', headers: { Authorization: `Bearer ${key.token}` } } },
  });
  // Byte-identical on a second request (cache or not), and the first local header is stamped 1980-01-01 00:00.
  const second = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
  assert.deepEqual(second.bytes, first.bytes);
  const dv = new DataView(first.bytes.buffer, first.bytes.byteOffset, first.bytes.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint16(10, true), 0, 'DOS time 00:00:00');
  assert.equal(dv.getUint16(12, true), 0x21, 'DOS date 1980-01-01');
  // A new member version changes the bytes and the version in the marketplace, which is the one in the zip.
  const before = (await t.req('GET', `/m/${key.token}/marketplace.json`)).json.plugins.find((p: { name: string }) => p.name === 'kit');
  assert.equal(before.version, plugin.version);
  const agent = (t.db.prepare("SELECT id FROM items WHERE name = 'reviewer'").get() as { id: string }).id;
  await new Promise((r) => setTimeout(r, 2)); // the version is a millisecond clock
  assert.equal((await t.req('POST', `${API}/items/${agent}/versions`, { headers: h, json: { content: AGENT_MD.replace('You review.', 'Harder.') } })).status, 201);
  const third = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
  assert.notDeepEqual(third.bytes, first.bytes);
  const after = (await t.req('GET', `/m/${key.token}/marketplace.json`)).json.plugins.find((p: { name: string }) => p.name === 'kit');
  assert.ok(after.version > before.version, `${after.version} > ${before.version}`);
  assert.equal(JSON.parse(text(unzip(third.bytes).get('.claude-plugin/plugin.json'))).version, after.version);
  // Two tokens of the same user get different zips (the .mcp.json differs) but the same tree.
  const other = t.key(t.db.prepare("SELECT id, username FROM users WHERE username = 'alice'").get() as never);
  const theirs = await t.req('GET', `/m/${other.token}/kit/plugin.zip`);
  assert.equal(theirs.status, 200);
  assert.notDeepEqual(theirs.bytes, third.bytes);
  assert.deepEqual([...unzip(theirs.bytes).keys()].sort(), [...unzip(third.bytes).keys()].sort());
  const ev = t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'bundle.download' AND detail LIKE '%\"target\":\"plugin\"%'").get() as { n: number };
  assert.equal(ev.n, 4);
});

test('restricted key: marketplace lists only its groups; a group it cannot read is 404 even by slug', async () => {
  const { t, alice, key, kitId } = await fixture();
  const rk = t.key(alice, { groupIds: [kitId] });
  const r = await t.req('GET', `/m/${rk.token}/marketplace.json`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.plugins.map((p: { name: string }) => p.name), ['kit']);
  assert.equal((await t.req('GET', `/m/${rk.token}/open/plugin.zip`)).status, 404);
  assert.equal((await t.req('GET', `/m/${key.token}/open/plugin.zip`)).status, 200);
  // bob's token: his two groups plus nothing of alice's (kit is private).
  const bob = t.db.prepare("SELECT id, username FROM users WHERE username = 'bob'").get() as never;
  const bk = t.key(bob);
  assert.deepEqual((await t.req('GET', `/m/${bk.token}/marketplace.json`)).json.plugins.map((p: { name: string }) => p.name).sort(), ['open', 'secret']);
});

test('GET /groups/:slug/plugin.zip: same bytes for the key caller, placeholder token for a session, 404 unreadable', async () => {
  const { t, key, alice, bob } = await fixture();
  const viaApi = await t.req('GET', `${API}/groups/kit/plugin.zip`, { headers: key.headers });
  assert.equal(viaApi.status, 200, viaApi.text);
  assert.equal(viaApi.headers.get('content-type'), 'application/zip');
  const viaMarket = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
  assert.deepEqual(viaApi.bytes, viaMarket.bytes);
  const viaSession = await t.req('GET', `${API}/groups/kit/plugin.zip`, { headers: t.session(alice) });
  assert.equal(viaSession.status, 200, viaSession.text);
  const mcp = JSON.parse(text(unzip(viaSession.bytes).get('.mcp.json')));
  assert.equal(mcp.mcpServers['scp-kit'].headers.Authorization, 'Bearer <YOUR_KEY>');
  assert.equal((await t.req('GET', `${API}/groups/kit/plugin.zip`, { headers: t.key(bob).headers })).status, 404);
  assert.equal((await t.req('GET', `${API}/groups/kit/plugin.zip`)).status, 401);
});

test('includes compose into the plugin; a second item with the same kind and name is 409 and skipped by the marketplace', async () => {
  const { t, key, h, bh } = await fixture();
  // bob's public group with a public skill of his own named pdf, and an agent 'helper'.
  const bobSkill = await item(t, bh, { kind: 'skill', visibility: 'public', files: [{ path: 'SKILL.md', content: SKILL_MD }] });
  const helper = await item(t, bh, { kind: 'agent', visibility: 'public', content: '---\nname: helper\ndescription: Helps.\n---\nhi\n' });
  assert.equal((await t.req('POST', `${API}/groups/open/members`, { headers: bh, json: { itemId: helper.id } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups/kit/includes`, { headers: h, json: { slug: 'open' } })).status, 201);
  const zip = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
  assert.equal(zip.status, 200, zip.text);
  assert.ok(unzip(zip.bytes).has('agents/helper.md'), 'included member is in the plugin');
  // bob adds his pdf skill to open: kit now serves two skills named pdf.
  assert.equal((await t.req('POST', `${API}/groups/open/members`, { headers: bh, json: { itemId: bobSkill.id } })).status, 201);
  const clash = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
  assert.equal(clash.status, 409, clash.text);
  assert.equal(clash.json.error.code, 'path_conflict');
  const market = await t.req('GET', `/m/${key.token}/marketplace.json`);
  assert.equal(market.status, 200);
  assert.deepEqual(market.json.plugins.map((p: { name: string }) => p.name), ['empty-one'], 'the broken group is left out, the rest still ships');
});

test("marketplace.json enumerates own and shared-by-name groups only; a stranger's public group stays installable by slug", async () => {
  const { t, key, bh } = await fixture();
  // bob shares secret with alice by name: hers to list. His public 'open' is any account's to create and is not.
  assert.equal((await t.req('PATCH', `${API}/groups/secret`, { headers: bh, json: { visibility: 'shared', sharedWith: ['alice'] } })).status, 200);
  const r = await t.req('GET', `/m/${key.token}/marketplace.json`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.plugins.map((p: { name: string }) => p.name).sort(), ['empty-one', 'kit', 'secret']);
  assert.equal(r.json.metadata.description, 'SCP groups of alice');
  assert.equal((await t.req('GET', `/m/${key.token}/open/plugin.zip`)).status, 200, 'readable, so installable by slug');
  assert.equal((await t.req('GET', `/m/${key.token}/secret/plugin.zip`)).status, 200);
  // Listing never built a zip: bundle.download is audited only on plugin.zip, and the listing wrote nothing.
  const downloads = (t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'bundle.download'").get() as { n: number }).n;
  assert.equal(downloads, 2);
  // The share rows outlive a visibility change, but count only while the group is 'shared' (as for reading
  // it): made public, secret is a stranger's public group to alice, listed again once bob flips it back.
  const listed = async () => ((await t.req('GET', `/m/${key.token}/marketplace.json`)).json.plugins as { name: string }[]).map((p) => p.name).sort();
  assert.equal((await t.req('PATCH', `${API}/groups/secret`, { headers: bh, json: { visibility: 'public' } })).status, 200);
  assert.deepEqual(await listed(), ['empty-one', 'kit']);
  assert.equal((await t.req('PATCH', `${API}/groups/secret`, { headers: bh, json: { visibility: 'shared' } })).status, 200);
  assert.deepEqual(await listed(), ['empty-one', 'kit', 'secret']);
});

test('pluginVersion is a clock of the latest change: climbs on a pin back or a swap, never repeats for different trees', () => {
  const group = { updated_at: '2026-03-04T10:00:00.000Z' } as GroupRow;
  const member = (seq: number, created_at: string) => ({ version: { seq, created_at, total_bytes: 1 }, item: { kind: 'prompt', name: `p${seq}` } }) as unknown as ResolvedMember;
  const v1 = pluginVersion(group, [member(2, '2026-03-04T09:00:00.000Z'), member(2, '2026-03-04T09:30:00.500Z')]);
  assert.equal(v1, '20260304.100000000');
  // Pinning a member back to v1 lowers the version sum but touches the group row: the version climbs.
  const pinned = pluginVersion({ updated_at: '2026-03-04T10:00:00.001Z' } as GroupRow, [member(1, '2026-03-04T08:00:00.000Z'), member(2, '2026-03-04T09:30:00.500Z')]);
  assert.ok(pinned > v1, `${pinned} > ${v1}`);
  // Two member sets with the same seq sum on the same day differ by their timestamps, never collide.
  const swapped = pluginVersion(group, [member(1, '2026-03-04T09:00:00.000Z'), member(3, '2026-03-04T11:00:00.000Z')]);
  assert.equal(swapped, '20260304.110000000');
  assert.notEqual(swapped, v1);
  // A member version newer than the group row wins.
  assert.equal(pluginVersion(group, [member(1, '2026-03-05T01:02:03.456Z')]), '20260305.010203456');
  // Listing predicate: the files cap, duplicate kind+name and the size cap are the cheap refusals.
  assert.equal(pluginProblem([member(1, '2026-03-04T09:00:00.000Z'), member(2, '2026-03-04T09:00:00.000Z')], 2), null);
  assert.equal(pluginProblem([member(1, '2026-03-04T09:00:00.000Z'), member(1, '2026-03-04T09:00:00.000Z')], 2)?.code, 'path_conflict');
  assert.equal(pluginProblem([{ version: { total_bytes: 101 * 1024 * 1024 }, item: { kind: 'skill', name: 'x' } } as unknown as ResolvedMember], 1)?.code, 'bundle_too_large');
  assert.equal(pluginProblem([member(1, '2026-03-04T09:00:00.000Z')], 20_001)?.code, 'group_full', 'the same cap place() holds every other download to');
});

test('a change inside an included group climbs the including group\'s plugin version, which stays the one in its plugin.json', async () => {
  const { t, key, h, prompt } = await fixture();
  const p2 = await item(t, h, { kind: 'prompt', name: 'p2', content: 'two' });
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'base', name: 'Base' } })).status, 201);
  for (const it of [prompt, p2]) assert.equal((await t.req('POST', `${API}/groups/base/members`, { headers: h, json: { itemId: it.id } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'team', name: 'Team' } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups/team/includes`, { headers: h, json: { slug: 'base' } })).status, 201);
  const version = async () => {
    const market = await t.req('GET', `/m/${key.token}/marketplace.json`);
    const listed = (market.json.plugins as { name: string; version: string }[]).find((p) => p.name === 'team')!.version;
    const zip = await t.req('GET', `/m/${key.token}/team/plugin.zip`);
    assert.equal(zip.status, 200, zip.text);
    assert.equal(JSON.parse(text(unzip(zip.bytes).get('.claude-plugin/plugin.json'))).version, listed, 'the listing and the zip agree');
    return listed;
  };
  const v0 = await version();
  await new Promise((r) => setTimeout(r, 2));
  // Removing a member from base changes what team serves: team's version must climb, not stay (or fall).
  assert.equal((await t.req('DELETE', `${API}/groups/base/members/${p2.id}`, { headers: h })).status, 200);
  const v1 = await version();
  assert.ok(v1 > v0, `${v1} > ${v0}`);
  await new Promise((r) => setTimeout(r, 2));
  // Pinning the remaining prompt back to v1 after a v2 exists: the newest member version is older, the clock still climbs.
  assert.equal((await t.req('POST', `${API}/items/${prompt.id}/versions`, { headers: h, json: { content: 'Summarize v2.' } })).status, 201);
  const v2 = await version();
  assert.ok(v2 > v1, `${v2} > ${v1}`);
  await new Promise((r) => setTimeout(r, 2));
  assert.equal((await t.req('PUT', `${API}/groups/base/members`, { headers: h, json: { members: [{ itemId: prompt.id, pinnedSeq: 1 }] } })).status, 200);
  const v3 = await version();
  assert.ok(v3 > v2, `${v3} > ${v2}`);
});

test('plugin layout conflicts: the manifest reports them, plugin.zip refuses them and the marketplace skips them, in agreement', async () => {
  const { t, key, h, bh } = await fixture();
  // (a) bob's public agent 'reviewer' joins kit beside alice's, resolved for the bundle with installAs: the bundle manifest is clean,
  // but the plugin layout has no installAs, so agents/reviewer.md clashes there.
  const bobsReviewer = await item(t, bh, { kind: 'agent', visibility: 'public', content: AGENT_MD.replace('Reviews code.', 'Reviews harder.') });
  const add = await t.req('POST', `${API}/groups/kit/members`, { headers: h, json: { itemId: bobsReviewer.id, installAs: '.claude/agents/bob-reviewer.md' } });
  assert.equal(add.status, 201, add.text);
  const man = await t.req('GET', `${API}/groups/kit/manifest`, { headers: h });
  assert.equal(man.status, 200, man.text);
  assert.deepEqual(man.json.conflicts, []);
  assert.equal(man.json.plugin.ok, false);
  assert.match(man.json.plugin.problem, /two members named 'reviewer' install to 'agents\/reviewer\.md'/);
  const zip = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
  assert.equal(zip.status, 409, zip.text);
  assert.equal(zip.json.error.message, man.json.plugin.problem, 'the manifest names what the builder refuses');
  assert.ok(!(await t.req('GET', `/m/${key.token}/marketplace.json`)).json.plugins.some((p: { name: string }) => p.name === 'kit'));
  assert.equal((await t.req('DELETE', `${API}/groups/kit/members/${bobsReviewer.id}`, { headers: h })).status, 200);
  assert.equal((await t.req('GET', `${API}/groups/kit/manifest`, { headers: h })).json.plugin.ok, true);
  assert.equal((await t.req('GET', `/m/${key.token}/kit/plugin.zip`)).status, 200);

  // (b) two artifacts named 'dash' from two owners would share docs/artifact/dash/: the folder is the unit, so this is a conflict
  // everywhere, not a zip that builds while the listing skips it.
  const mine = await item(t, h, { kind: 'artifact', format: 'html', title: 'Dash', content: '<h1>d</h1>' });
  const theirs = await item(t, bh, { kind: 'artifact', format: 'markdown', title: 'Dash', visibility: 'public', content: '# d' });
  assert.equal(mine.name, 'dash');
  assert.equal(theirs.name, 'dash');
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'dashes', name: 'Dashes' } })).status, 201);
  for (const it of [mine, theirs]) assert.equal((await t.req('POST', `${API}/groups/dashes/members`, { headers: h, json: { itemId: it.id } })).status, 201);
  const man2 = await t.req('GET', `${API}/groups/dashes/manifest`, { headers: h });
  assert.equal(man2.json.plugin.ok, false);
  assert.match(man2.json.plugin.problem, /docs\/artifact\/dash\//);
  const zip2 = await t.req('GET', `/m/${key.token}/dashes/plugin.zip`);
  assert.equal(zip2.status, 409, zip2.text);
  assert.equal(zip2.json.error.code, 'path_conflict');
  const listed = (await t.req('GET', `/m/${key.token}/marketplace.json`)).json.plugins.map((p: { name: string }) => p.name);
  assert.ok(!listed.includes('dashes'));
  assert.ok(listed.includes('kit'));
});

test('the plugin version climbs when the effective tree shrinks: a member deleted or made private, an included group made private or deleted', async () => {
  const { t, key, h, bh, prompt } = await fixture();
  // carol's public agent sits in bob's public group: it flows into kit only while it stays public (publishedSql).
  const ch = t.key(t.createUser({ username: 'carol' })).headers;
  const helper = await item(t, ch, { kind: 'agent', visibility: 'public', content: '---\nname: helper\ndescription: Helps.\n---\nhi\n' });
  assert.equal((await t.req('POST', `${API}/groups/open/members`, { headers: bh, json: { itemId: helper.id } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups/kit/includes`, { headers: h, json: { slug: 'open' } })).status, 201);
  const snapshot = async () => {
    const market = await t.req('GET', `/m/${key.token}/marketplace.json`);
    const listed = (market.json.plugins as { name: string; version: string }[]).find((p) => p.name === 'kit')!.version;
    const zip = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
    assert.equal(zip.status, 200, zip.text);
    const files = unzip(zip.bytes);
    assert.equal(JSON.parse(text(files.get('.claude-plugin/plugin.json'))).version, listed, 'the listing and the zip agree');
    return { version: listed, paths: [...files.keys()].sort() };
  };
  const tick = () => new Promise((r) => setTimeout(r, 2)); // the version is a millisecond clock
  let prev = await snapshot();
  assert.ok(prev.paths.includes('agents/helper.md') && prev.paths.includes('docs/prompt/summarize/summarize.md'));
  // Every shrink below moves the version with the bytes: `claude plugin update` only looks at the version.
  const climbed = async (what: string, gone: string) => {
    const next = await snapshot();
    assert.ok(next.version > prev.version, `${what}: ${next.version} > ${prev.version}`);
    assert.ok(!next.paths.includes(gone), `${what}: ${gone} left the zip`);
    prev = next;
  };
  await tick();
  assert.equal((await t.req('DELETE', `${API}/items/${prompt.id}`, { headers: h })).status, 204);
  await climbed('own member deleted', 'docs/prompt/summarize/summarize.md');
  await tick();
  assert.equal((await t.req('PATCH', `${API}/items/${helper.id}`, { headers: ch, json: { visibility: 'private' } })).status, 200);
  await climbed('included member made private', 'agents/helper.md');
  assert.equal((await t.req('PATCH', `${API}/items/${helper.id}`, { headers: ch, json: { visibility: 'public' } })).status, 200);
  prev = await snapshot();
  await tick();
  assert.equal((await t.req('PATCH', `${API}/groups/open`, { headers: bh, json: { visibility: 'private' } })).status, 200);
  await climbed('included group made private', 'agents/helper.md');
  assert.equal((await t.req('PATCH', `${API}/groups/open`, { headers: bh, json: { visibility: 'public' } })).status, 200);
  prev = await snapshot();
  await tick();
  assert.equal((await t.req('DELETE', `${API}/groups/open`, { headers: bh })).status, 204);
  await climbed('included group deleted', 'agents/helper.md');
});

test("the plugin version climbs when an included group's owner is disabled, enabled again, or deleted", async () => {
  const { t, key, h, bh } = await fixture();
  const bob = t.db.prepare("SELECT id FROM users WHERE username = 'bob'").get() as { id: string };
  const helper = await item(t, bh, { kind: 'agent', visibility: 'public', content: '---\nname: helper\ndescription: Helps.\n---\nhi\n' });
  assert.equal((await t.req('POST', `${API}/groups/open/members`, { headers: bh, json: { itemId: helper.id } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups/kit/includes`, { headers: h, json: { slug: 'open' } })).status, 201);
  const admin = t.key(t.createUser({ isAdmin: true })).headers;
  const snapshot = async () => {
    const market = await t.req('GET', `/m/${key.token}/marketplace.json`);
    const listed = (market.json.plugins as { name: string; version: string }[]).find((p) => p.name === 'kit')!.version;
    const zip = await t.req('GET', `/m/${key.token}/kit/plugin.zip`);
    assert.equal(zip.status, 200, zip.text);
    const files = unzip(zip.bytes);
    assert.equal(JSON.parse(text(files.get('.claude-plugin/plugin.json'))).version, listed, 'the listing and the zip agree');
    return { version: listed, paths: [...files.keys()].sort() };
  };
  const tick = () => new Promise((r) => setTimeout(r, 2));
  let prev = await snapshot();
  assert.ok(prev.paths.includes('agents/helper.md'));
  // Nothing in kit's rows changes, yet what it serves does (access.ts ownerEnabled): `claude plugin update` only looks at the version.
  const step = async (what: string, fn: () => Promise<unknown>, has: boolean) => {
    await tick();
    await fn();
    const next = await snapshot();
    assert.ok(next.version > prev.version, `${what}: ${next.version} > ${prev.version}`);
    assert.equal(next.paths.includes('agents/helper.md'), has, what);
    prev = next;
  };
  await step('owner disabled', async () => assert.equal((await t.req('PATCH', `${API}/users/${bob.id}`, { headers: admin, json: { disabled: true } })).status, 200), false);
  await step('owner enabled again', async () => assert.equal((await t.req('PATCH', `${API}/users/${bob.id}`, { headers: admin, json: { disabled: false } })).status, 200), true);
  await step('owner deleted', async () => assert.equal((await t.req('DELETE', `${API}/users/${bob.id}`, { headers: admin })).status, 204), false);
});

test('marketplace.json at the caps (200 groups x 500 members) lists in one statement per group, and /m/* is rate limited per key', async () => {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'big' });
  const key = t.key(u);
  const ts = now();
  tx(t.db, () => {
    const item = t.db.prepare("INSERT INTO items (id, owner_id, kind, name, latest_seq, created_at, updated_at) VALUES (?, ?, 'prompt', ?, 1, ?, ?)");
    const ver = t.db.prepare("INSERT INTO item_versions (id, item_id, seq, entry_path, tree_sha256, total_bytes, created_at) VALUES (?, ?, 1, 'p.md', ?, 10, ?)");
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      const id = newId();
      ids.push(id);
      item.run(id, u.id, `p${i}`, ts, ts);
      ver.run(newId(), id, `sha${i}`, ts);
    }
    const group = t.db.prepare("INSERT INTO scp_groups (id, owner_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 'G', ?, ?)");
    const member = t.db.prepare('INSERT INTO group_members (group_id, item_id, position, added_at) VALUES (?, ?, ?, ?)');
    for (let g = 0; g < 200; g++) {
      const gid = newId();
      group.run(gid, u.id, `g${g}`, ts, ts);
      for (const [i, id] of ids.entries()) member.run(gid, id, i, ts);
    }
  });
  let prepared = 0;
  const prepare = t.db.prepare.bind(t.db);
  (t.db as { prepare: typeof t.db.prepare }).prepare = ((sql: string) => (prepared++, prepare(sql))) as typeof t.db.prepare;
  const started = Date.now();
  const r = await t.req('GET', `/m/${key.token}/marketplace.json`);
  const took = Date.now() - started;
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.plugins.length, 200);
  // Resolving a version row per member was 100,000 statements and seconds of blocked event loop per request.
  assert.ok(prepared < 2000, `${prepared} statements prepared`);
  assert.ok(took < 3000, `took ${took} ms`);
  // The key is in the URL, so a leaked link replays at wire speed: one bucket per key.
  const small = t.key(t.createUser({ username: 'small' }));
  const statuses: number[] = [];
  for (let i = 0; i < AUTH_LIMITS.marketplace.burst + 5; i++) statuses.push((await t.req('GET', `/m/${small.token}/marketplace.json`)).status);
  assert.ok(statuses.slice(0, AUTH_LIMITS.marketplace.burst).every((s) => s === 200), statuses.join(','));
  const limited = await t.req('GET', `/m/${small.token}/marketplace.json`);
  assert.equal(limited.status, 429, limited.text);
  assert.equal(limited.json.error.code, 'rate_limited');
  assert.equal((await t.req('GET', `/m/${small.token}/g0/plugin.zip`)).status, 429, 'plugin.zip shares the bucket');
  assert.equal((await t.req('GET', `/m/${key.token}/marketplace.json`)).status, 200, 'another key is unaffected');
});
