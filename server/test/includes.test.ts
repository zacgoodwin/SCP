import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { insertGroup, makeTestCtx, type TestCtx, type TestUser } from './helpers.ts';
import { newId, now, tx } from '../src/db.ts';
import { safeUnzip } from '../src/lib/zip.ts';
import { MAX_UP_ROWS } from '../src/access.ts';
import { MAX_EFFECTIVE_GROUPS, MAX_GROUP_FILES, MAX_INCLUDED_BY, MAX_INCLUDES, MAX_MEMBERS, effectiveGroups, getGroupRow } from '../src/groups/service.ts';

const API = '/api/v1';
type H = Record<string, string>;

async function item(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/items`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.item as { id: string; name: string };
}

async function group(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/groups`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.group as { id: string; slug: string };
}

const addMember = (t: TestCtx, h: H, slug: string, json: unknown) => t.req('POST', `${API}/groups/${slug}/members`, { headers: h, json });
const addInclude = (t: TestCtx, h: H, slug: string, include: string) => t.req('POST', `${API}/groups/${slug}/includes`, { headers: h, json: { slug: include } });
const putIncludes = (t: TestCtx, h: H, slug: string, includes: string[]) => t.req('PUT', `${API}/groups/${slug}/includes`, { headers: h, json: { includes } });
const detail = async (t: TestCtx, h: H, slug: string) => {
  const r = await t.req('GET', `${API}/groups/${slug}`, { headers: h });
  assert.equal(r.status, 200, r.text);
  return r.json.group;
};
const memberNames = (g: { members: { item: { name: string } }[] }) => g.members.map((m) => m.item.name);
const vias = (g: { members: { item: { name: string }; via: string | null }[] }) => Object.fromEntries(g.members.map((m) => [m.item.name, m.via]));

/** `n` raw public prompts of `owner`, one version each, as members of group `gid`: cheap stand-ins for a group grown big. */
function fillGroup(t: TestCtx, owner: TestUser, gid: string, n: number) {
  const ts = now();
  tx(t.db, () => {
    const item = t.db.prepare("INSERT INTO items (id, owner_id, kind, name, visibility, latest_seq, created_at, updated_at) VALUES (?, ?, 'prompt', ?, 'public', 1, ?, ?)");
    const ver = t.db.prepare("INSERT INTO item_versions (id, item_id, seq, entry_path, tree_sha256, total_bytes, created_at) VALUES (?, ?, 1, 'p.md', ?, 1, ?)");
    const member = t.db.prepare('INSERT INTO group_members (group_id, item_id, position, added_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < n; i++) {
      const id = newId();
      item.run(id, owner.id, `bulk-${gid.slice(-6)}-${i}`, ts, ts);
      ver.run(newId(), id, `sha-${id}`, ts);
      member.run(gid, id, i, ts);
    }
  });
}

/** Give a version `n` more files, all pointing at its entry blob (cheap stand-ins for a big tree). */
function padVersion(t: TestCtx, versionId: string, n: number) {
  t.db
    .prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO version_files (version_id, path, mode, sha256, size)
       SELECT ?, 'assets/' || i || '.png', 420, (SELECT sha256 FROM version_files WHERE version_id = ? LIMIT 1), 1 FROM k`,
    )
    .run(n, versionId, versionId);
}
const groupId = (t: TestCtx, slug: string) => (t.db.prepare('SELECT id FROM scp_groups WHERE slug = ?').get(slug) as { id: string }).id;

/** alice owns base (two prompts) and team (one prompt + includes base); bob is another user. */
async function fixture() {
  const t = makeTestCtx();
  const alice = t.createUser({ username: 'alice' });
  const bob = t.createUser({ username: 'bob' });
  const h = t.key(alice).headers;
  const bh = t.key(bob).headers;
  const p1 = await item(t, h, { kind: 'prompt', name: 'p1', content: 'one' });
  const p2 = await item(t, h, { kind: 'prompt', name: 'p2', content: 'two' });
  const p3 = await item(t, h, { kind: 'prompt', name: 'p3', content: 'three' });
  const base = await group(t, h, { slug: 'base', name: 'Base' });
  const team = await group(t, h, { slug: 'team', name: 'Team' });
  for (const it of [p1, p2]) assert.equal((await addMember(t, h, 'base', { itemId: it.id })).status, 201);
  assert.equal((await addMember(t, h, 'team', { itemId: p3.id })).status, 201);
  return { t, alice, bob, h, bh, p1, p2, p3, base, team };
}

test('include: effective members are own first then included in order, with via and the edge pin/installAs; counts, manifest, bundle, catalog compose', async () => {
  const { t, h, p1, p2, p3 } = await fixture();
  // base pins p1 to v1 after a v2 exists, and re-homes p2.
  assert.equal((await t.req('POST', `${API}/items/${p1.id}/versions`, { headers: h, json: { content: 'one v2' } })).status, 201);
  const put = await t.req('PUT', `${API}/groups/base/members`, { headers: h, json: { members: [{ itemId: p1.id, pinnedSeq: 1 }, { itemId: p2.id, installAs: 'docs/p2.md' }] } });
  assert.equal(put.status, 200, put.text);

  const r = await addInclude(t, h, 'team', 'base');
  assert.equal(r.status, 201, r.text);
  const g = r.json.group;
  assert.deepEqual(memberNames(g), ['p3', 'p1', 'p2']);
  assert.deepEqual(vias(g), { p3: null, p1: 'base', p2: 'base' });
  const byName = Object.fromEntries(g.members.map((m: { item: { name: string } }) => [m.item.name, m]));
  assert.equal(byName.p1.pinnedSeq, 1, 'pin comes from the base edge');
  assert.equal(byName.p1.resolvedSeq, 1);
  assert.equal(byName.p2.installAs, 'docs/p2.md');
  assert.equal(byName.p2.installPath, 'docs/p2.md');
  assert.deepEqual(g.includes, [{ slug: 'base', name: 'Base', owner: { username: 'alice' }, memberCount: 2, flowing: true }]);
  assert.deepEqual(g.includedBy, []);
  assert.deepEqual(g.counts, { skill: 0, md: 3, artifact: 0 }, 'summary counts the effective set');
  assert.deepEqual((await detail(t, h, 'base')).includedBy, [{ slug: 'team', name: 'Team' }]);

  const list = (await t.req('GET', `${API}/groups`, { headers: h })).json.groups.find((x: { slug: string }) => x.slug === 'team');
  assert.deepEqual(list.counts, { skill: 0, md: 3, artifact: 0 });
  const man = await t.req('GET', `${API}/groups/team/manifest`, { headers: h });
  assert.deepEqual(man.json.items.map((i: { name: string; installPath: string }) => [i.name, i.installPath]), [
    ['p3', '.scp/prompts/p3.md'],
    ['p1', '.scp/prompts/p1.md'],
    ['p2', 'docs/p2.md'],
  ]);
  const zip = await t.req('GET', `${API}/groups/team/bundle.zip`, { headers: h });
  assert.equal(zip.status, 200, zip.text);
  const files = new Map(safeUnzip(zip.bytes).map((f) => [f.path, new TextDecoder().decode(f.bytes)]));
  assert.equal(files.get('.scp/prompts/p1.md'), 'one', 'pinned v1 bytes');
  assert.equal(files.get('docs/p2.md'), 'two');
  assert.equal(files.get('.scp/prompts/p3.md'), 'three');
  const cat = (await t.req('GET', `${API}/groups/team/catalog.md`, { headers: h })).text;
  assert.ok(cat.includes('| p1 | prompt |') && cat.includes('| p2 | prompt |') && cat.includes('| p3 | prompt |'), cat);

  // First occurrence wins: p1 added to team directly (unpinned) shadows the pinned one from base.
  assert.equal((await addMember(t, h, 'team', { itemId: p1.id })).status, 201);
  const g2 = await detail(t, h, 'team');
  assert.deepEqual(memberNames(g2), ['p3', 'p1', 'p2']);
  assert.deepEqual(vias(g2), { p3: null, p1: null, p2: 'base' });
  assert.equal(g2.members[1].resolvedSeq, 2, "team's own row follows latest");
  assert.deepEqual(g2.counts, { skill: 0, md: 3, artifact: 0 }, 'deduplicated');

  // PUT members replaces own rows only; the via member keeps flowing.
  const re = await t.req('PUT', `${API}/groups/team/members`, { headers: h, json: { members: [{ itemId: p3.id }] } });
  assert.equal(re.status, 200, re.text);
  assert.deepEqual(vias(re.json.group), { p3: null, p1: 'base', p2: 'base' });
  // Removing a via member here is a 404: it has no row in this group.
  assert.equal((await t.req('DELETE', `${API}/groups/team/members/${p2.id}`, { headers: h })).status, 404);

  const audit = (t.db.prepare("SELECT detail FROM audit WHERE action = 'group.includes' ORDER BY id").all() as { detail: string }[]).map((a) => JSON.parse(a.detail));
  assert.deepEqual(audit, [{ slug: 'team', op: 'add', include: 'base' }]);
});

test('transitive includes to depth 4; the fifth level is include_too_deep; depth cap also holds in itemReadSql', async () => {
  const t = makeTestCtx();
  const h = t.key(t.createUser({ username: 'alice' })).headers;
  const viewer = t.key(t.createUser({ username: 'viewer' })).headers;
  const leaf = await item(t, h, { kind: 'prompt', name: 'leaf', content: 'x' });
  const slugs = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'];
  for (const s of slugs) await group(t, h, { slug: s, name: s.toUpperCase(), visibility: s === 'g0' ? 'public' : 'private' });
  assert.equal((await addMember(t, h, 'g4', { itemId: leaf.id })).status, 201);
  // g0 -> g1 -> g2 -> g3 -> g4: four edges, leaf at depth 4.
  for (let i = 0; i < 4; i++) assert.equal((await addInclude(t, h, slugs[i], slugs[i + 1])).status, 201, slugs[i]);
  const g0 = await detail(t, h, 'g0');
  assert.deepEqual(vias(g0), { leaf: 'g4' });
  assert.deepEqual(g0.includes.map((i: { slug: string }) => i.slug), ['g1'], 'only direct includes are listed');
  // The viewer reads the private leaf through public g0 (itemReadSql walks the chain).
  assert.equal((await t.req('GET', `${API}/items/${leaf.id}`, { headers: viewer })).status, 200);
  // A fifth edge anywhere on the chain is refused.
  const deep = await addInclude(t, h, 'g4', 'g5');
  assert.equal(deep.status, 400, deep.text);
  assert.equal(deep.json.error.code, 'include_too_deep');
  const above = await group(t, h, { slug: 'top', name: 'Top' });
  const deep2 = await addInclude(t, h, 'top', 'g0');
  assert.equal(deep2.status, 400, deep2.text);
  assert.equal(deep2.json.error.code, 'include_too_deep');
  assert.ok(above.id);
  // Forced past the cap in the DB (as if written by an older build): the SQL cap hides depth 5 from readers, consistently with resolvedMembers.
  const g5 = t.db.prepare("SELECT id FROM scp_groups WHERE slug = 'g5'").get() as { id: string };
  const g4 = t.db.prepare("SELECT id FROM scp_groups WHERE slug = 'g4'").get() as { id: string };
  const deepLeaf = await item(t, h, { kind: 'prompt', name: 'deep-leaf', content: 'y' });
  assert.equal((await addMember(t, h, 'g5', { itemId: deepLeaf.id })).status, 201);
  t.db.prepare("INSERT INTO group_includes (group_id, included_id, position, added_at) VALUES (?, ?, 0, '2026-01-01T00:00:00.000Z')").run(g4.id, g5.id);
  assert.deepEqual(memberNames(await detail(t, viewer, 'g0')), ['leaf']);
  assert.equal((await t.req('GET', `${API}/items/${deepLeaf.id}`, { headers: viewer })).status, 404);
  // From g1 the same leaf is at depth 4 and flows.
  const g1 = await detail(t, h, 'g1');
  assert.deepEqual(memberNames(g1).sort(), ['deep-leaf', 'leaf']);
});

test('cycles are 409 include_cycle: self, direct, transitive; duplicates 409 include_exists', async () => {
  const { t, h } = await fixture();
  const self = await addInclude(t, h, 'team', 'team');
  assert.equal(self.status, 409);
  assert.equal(self.json.error.code, 'include_cycle');
  assert.equal((await addInclude(t, h, 'team', 'base')).status, 201);
  const direct = await addInclude(t, h, 'base', 'team');
  assert.equal(direct.status, 409);
  assert.equal(direct.json.error.code, 'include_cycle');
  await group(t, h, { slug: 'top', name: 'Top' });
  assert.equal((await addInclude(t, h, 'top', 'team')).status, 201);
  const trans = await addInclude(t, h, 'base', 'top');
  assert.equal(trans.status, 409, trans.text);
  assert.equal(trans.json.error.code, 'include_cycle');
  const dup = await addInclude(t, h, 'team', 'base');
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'include_exists');
  // Nothing leaked into the table from the refused calls.
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM group_includes').get() as { n: number }).n, 2);
});

test('include only own or public groups: 404 unreadable, 400 include_not_shareable for shared ones and for admins, restricted key contained', async () => {
  const { t, alice, h, bh, team } = await fixture();
  const admin = t.key(t.createUser({ username: 'root', isAdmin: true })).headers;
  const carol = t.createUser({ username: 'carol' });
  const bobPrivate = await group(t, bh, { slug: 'bob-private', name: 'BP' });
  await group(t, bh, { slug: 'bob-public', name: 'BPub', visibility: 'public' });
  await group(t, bh, { slug: 'bob-shared', name: 'BS', visibility: 'shared', sharedWith: ['alice'] });
  await group(t, bh, { slug: 'bob-shared-carol', name: 'BSC', visibility: 'shared', sharedWith: ['carol'] });
  const nf = await addInclude(t, h, 'team', 'bob-private');
  assert.equal(nf.status, 404);
  assert.equal((await addInclude(t, h, 'team', 'nope')).status, 404);
  assert.equal((await addInclude(t, h, 'team', 'bob-public')).status, 201);
  // Readable, but shared by name: not alice's to republish (the item_not_shareable rule for groups).
  const shared = await addInclude(t, h, 'team', 'bob-shared');
  assert.equal(shared.status, 400, shared.text);
  assert.equal(shared.json.error.code, 'include_not_shareable');
  assert.equal((await addInclude(t, h, 'team', 'bob-shared-carol')).status, 404);
  // An admin reads bob's private group but cannot publish it through alice's group.
  const ns = await addInclude(t, admin, 'team', 'bob-private');
  assert.equal(ns.status, 400, ns.text);
  assert.equal(ns.json.error.code, 'include_not_shareable');
  assert.ok(bobPrivate.id);
  // Restricted to team: cannot include base (outside its list) nor see it, 404 both ways.
  const rk = t.key(alice, { groupIds: [team.id] }).headers;
  assert.equal((await addInclude(t, rk, 'team', 'base')).status, 404);
  assert.equal((await t.req('GET', `${API}/groups/base`, { headers: rk })).status, 404);
  // Read-only key and a non-owner: 403 / 404 on include writes.
  const ro = t.key(alice, { scopes: ['read'] }).headers;
  assert.equal((await addInclude(t, ro, 'team', 'base')).status, 403);
  assert.equal((await putIncludes(t, ro, 'team', [])).status, 403);
  assert.equal((await t.req('DELETE', `${API}/groups/team/includes/base`, { headers: ro })).status, 403);
  assert.equal((await addInclude(t, bh, 'team', 'bob-public')).status, 404, "bob cannot see alice's private team");
  assert.equal((await addInclude(t, h, 'nope', 'base')).status, 404);
  // Validation
  assert.equal((await t.req('POST', `${API}/groups/team/includes`, { headers: h, json: {} })).status, 400);
  assert.equal((await t.req('PUT', `${API}/groups/team/includes`, { headers: h, json: { includes: 'base' } })).status, 400);
});

test('read time: an include flows only while the owner can still read it and each child publishes the item', async () => {
  const { t, h, bh, p3 } = await fixture();
  const viewer = t.key(t.createUser({ username: 'viewer' })).headers;
  const carol = t.createUser({ username: 'carol' });
  const ch = t.key(carol).headers;
  // bob's public group holds his own prompt and carol's public prompt.
  const bobs = await item(t, bh, { kind: 'prompt', name: 'bobs', content: 'b' });
  const carols = await item(t, ch, { kind: 'prompt', name: 'carols', content: 'c', visibility: 'public' });
  await group(t, bh, { slug: 'pack', name: 'Pack', visibility: 'public' });
  for (const it of [bobs, carols]) assert.equal((await addMember(t, bh, 'pack', { itemId: it.id })).status, 201);
  assert.equal((await t.req('PATCH', `${API}/groups/team`, { headers: h, json: { visibility: 'public' } })).status, 200);
  assert.equal((await addInclude(t, h, 'team', 'pack')).status, 201);
  assert.deepEqual(memberNames(await detail(t, viewer, 'team')), ['p3', 'bobs', 'carols']);
  assert.equal((await t.req('GET', `${API}/items/${bobs.id}`, { headers: viewer })).status, 200, 'readable through team');
  // carol makes hers private: pack no longer publishes it, so team does not either.
  assert.equal((await t.req('PATCH', `${API}/items/${carols.id}`, { headers: ch, json: { visibility: 'private' } })).status, 200);
  assert.deepEqual(memberNames(await detail(t, viewer, 'team')), ['p3', 'bobs']);
  assert.equal((await t.req('GET', `${API}/items/${carols.id}`, { headers: viewer })).status, 404);
  // Both ends of a flowing edge agree: pack's owner sees that public team republishes it.
  assert.deepEqual((await detail(t, bh, 'pack')).includedBy, [{ slug: 'team', name: 'Team' }]);
  assert.deepEqual((await detail(t, h, 'team')).includes, [{ slug: 'pack', name: 'Pack', owner: { username: 'bob' }, memberCount: 1, flowing: true }]);
  // bob makes pack private and renames it: alice can no longer read it, so nothing flows and readers see no include.
  assert.equal((await t.req('PATCH', `${API}/groups/pack`, { headers: bh, json: { visibility: 'private', name: 'Q3 layoffs plan' } })).status, 200);
  const stale = await detail(t, viewer, 'team');
  assert.deepEqual(memberNames(stale), ['p3']);
  assert.deepEqual(stale.includes, [], 'readers see only includes that flow');
  assert.equal((await t.req('GET', `${API}/items/${bobs.id}`, { headers: viewer })).status, 404);
  assert.deepEqual((await t.req('GET', `${API}/groups/team/manifest`, { headers: viewer })).json.items.map((i: { name: string }) => i.name), ['p3']);
  assert.deepEqual((await t.req('GET', `${API}/groups`, { headers: viewer })).json.groups.find((g: { slug: string }) => g.slug === 'team').counts, { skill: 0, md: 1, artifact: 0 });
  // The owner still sees the stale row and can remove it, but not the private group's live name, owner or member count.
  const own = await detail(t, h, 'team');
  assert.deepEqual(own.includes, [{ slug: 'pack', name: '', owner: { username: '' }, memberCount: 0, flowing: false }]);
  assert.deepEqual(memberNames(own), ['p3'], 'stale includes do not flow for the owner either');
  assert.deepEqual((await detail(t, bh, 'pack')).includedBy, [], 'and bob is not told that team still republishes it');
  // Shared with alice by name: she reads it again, but it is not hers to republish, so still nothing flows.
  assert.equal((await t.req('PATCH', `${API}/groups/pack`, { headers: bh, json: { visibility: 'shared', sharedWith: ['alice'] } })).status, 200);
  assert.deepEqual(memberNames(await detail(t, viewer, 'team')), ['p3']);
  assert.equal((await t.req('GET', `${API}/items/${bobs.id}`, { headers: viewer })).status, 404);
  assert.deepEqual((await detail(t, h, 'team')).includes, [{ slug: 'pack', name: 'Q3 layoffs plan', owner: { username: 'bob' }, memberCount: 1, flowing: false }], 'readable but not flowing');
  // Public again: flows again, bob's row restored.
  assert.equal((await t.req('PATCH', `${API}/groups/pack`, { headers: bh, json: { visibility: 'public' } })).status, 200);
  assert.deepEqual(memberNames(await detail(t, viewer, 'team')), ['p3', 'bobs']);
  // Disabling bob takes his group down with it.
  const bob = t.db.prepare("SELECT id FROM users WHERE username = 'bob'").get() as { id: string };
  t.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(bob.id);
  assert.deepEqual(memberNames(await detail(t, viewer, 'team')), ['p3']);
  t.db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(bob.id);
  // Back to shared with alice, so once the edge is gone nothing but pack itself (unreadable to the viewer) holds bobs.
  assert.equal((await t.req('PATCH', `${API}/groups/pack`, { headers: bh, json: { visibility: 'shared', sharedWith: ['alice'] } })).status, 200);
  const rm = await t.req('DELETE', `${API}/groups/team/includes/pack`, { headers: h });
  assert.equal(rm.status, 200, rm.text);
  assert.deepEqual(rm.json.group.includes, []);
  assert.equal((await t.req('DELETE', `${API}/groups/team/includes/pack`, { headers: h })).status, 404);
  assert.equal((await t.req('GET', `${API}/items/${bobs.id}`, { headers: viewer })).status, 404);
  assert.ok(p3.id);
});

test('restricted key reads via members through its group only; includedBy lists only readable includers', async () => {
  const { t, alice, bob, h, bh, p1, p2, base, team } = await fixture();
  const outside = await item(t, h, { kind: 'prompt', name: 'outside', content: 'o' });
  assert.equal((await addInclude(t, h, 'team', 'base')).status, 201);
  const rk = t.key(alice, { groupIds: [team.id] }).headers;
  assert.equal((await t.req('GET', `${API}/items/${p1.id}`, { headers: rk })).status, 200, 'served by team via base');
  assert.equal((await t.req('GET', `${API}/items/${outside.id}`, { headers: rk })).status, 404);
  assert.equal((await t.req('GET', `${API}/groups/base`, { headers: rk })).status, 404, 'the child group itself stays out of reach');
  const d = await detail(t, rk, 'team');
  assert.deepEqual(vias(d), { p3: null, p1: 'base', p2: 'base' });
  assert.deepEqual(d.includes.map((i: { slug: string }) => i.slug), ['base']);
  const listing = await t.req('GET', `${API}/items`, { headers: rk });
  assert.deepEqual(listing.json.items.map((i: { name: string }) => i.name).sort(), ['p1', 'p2', 'p3'], 'listings use itemReadSql: via members in, outside out');
  // includedBy: bob reads public base but cannot read private team.
  assert.equal((await t.req('PATCH', `${API}/groups/base`, { headers: h, json: { visibility: 'public' } })).status, 200);
  assert.deepEqual((await detail(t, bh, 'base')).includedBy, []);
  assert.deepEqual((await detail(t, h, 'base')).includedBy, [{ slug: 'team', name: 'Team' }]);
  assert.ok(bob.id && p2.id && base.id);
});

test("an include whose child the reader cannot open still reads as flowing: members[] says so via 'base'", async () => {
  const { t, alice, bob, h, bh, team } = await fixture();
  assert.equal((await addInclude(t, h, 'team', 'base')).status, 201);
  assert.equal((await t.req('PATCH', `${API}/groups/team`, { headers: h, json: { visibility: 'public' } })).status, 200);
  // bob reads public team but not alice's private base, which flows into it (alice vouches for her own group).
  const unreadableButFlowing = [{ slug: 'base', name: '', owner: { username: '' }, memberCount: 0, flowing: true }];
  const viewer = await detail(t, bh, 'team');
  assert.deepEqual(vias(viewer), { p3: null, p1: 'base', p2: 'base' });
  assert.deepEqual(viewer.includes, unreadableButFlowing);
  // A key restricted to team: the same.
  const rk = t.key(alice, { groupIds: [team.id] }).headers;
  assert.deepEqual((await detail(t, rk, 'team')).includes, unreadableButFlowing);
  assert.ok(bob.id);
});

test('PUT includes replaces in order, all-or-nothing; deleting the child drops the edge', async () => {
  const { t, h, p1 } = await fixture();
  const x = await item(t, h, { kind: 'prompt', name: 'x', content: 'x' });
  await group(t, h, { slug: 'extra', name: 'Extra' });
  assert.equal((await addMember(t, h, 'extra', { itemId: x.id })).status, 201);
  const r = await putIncludes(t, h, 'team', ['extra', 'base']);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(memberNames(r.json.group), ['p3', 'x', 'p1', 'p2']);
  assert.deepEqual(r.json.group.includes.map((i: { slug: string }) => i.slug), ['extra', 'base']);
  const rows = t.db.prepare('SELECT position FROM group_includes ORDER BY position').all() as { position: number }[];
  assert.deepEqual(rows.map((x) => x.position), [0, 1]);
  const r2 = await putIncludes(t, h, 'team', ['base', 'extra']);
  assert.deepEqual(memberNames(r2.json.group), ['p3', 'p1', 'p2', 'x']);
  // Bad lists change nothing.
  for (const [list, status, code] of [
    [['base', 'missing'], 404, 'not_found'],
    [['base', 'base'], 409, 'include_exists'],
    [['team'], 409, 'include_cycle'],
  ] as const) {
    const bad = await putIncludes(t, h, 'team', [...list]);
    assert.equal(bad.status, status, bad.text);
    assert.equal(bad.json.error.code, code);
    assert.deepEqual((await detail(t, h, 'team')).includes.map((i: { slug: string }) => i.slug), ['base', 'extra']);
  }
  assert.equal((await putIncludes(t, h, 'team', [])).status, 200);
  assert.deepEqual((await detail(t, h, 'team')).includes, []);
  assert.equal((await addInclude(t, h, 'team', 'extra')).status, 201);
  assert.equal((await t.req('DELETE', `${API}/groups/extra`, { headers: h })).status, 204);
  const after = await detail(t, h, 'team');
  assert.deepEqual(after.includes, []);
  assert.deepEqual(memberNames(after), ['p3']);
  assert.ok(p1.id);
  const ops = (t.db.prepare("SELECT detail FROM audit WHERE action = 'group.includes' ORDER BY id").all() as { detail: string }[]).map((a) => JSON.parse(a.detail).op);
  assert.deepEqual(ops, ['replace', 'replace', 'replace', 'add']);
});

test('path conflicts across the effective set: 409 on include add, installAs on the child edge resolves it, later clashes are manifest lints', async () => {
  const { t, h } = await fixture();
  const a = await item(t, h, { kind: 'instructions', name: 'house-rules', content: '# A\n' });
  const b = await item(t, h, { kind: 'instructions', name: 'team-rules', content: '# B\n' });
  assert.equal((await addMember(t, h, 'team', { itemId: a.id })).status, 201);
  assert.equal((await addMember(t, h, 'base', { itemId: b.id })).status, 201);
  const c = await addInclude(t, h, 'team', 'base');
  assert.equal(c.status, 409, c.text);
  assert.equal(c.json.error.code, 'path_conflict');
  assert.match(c.json.error.message, /'house-rules' and 'team-rules' both install to 'CLAUDE.md'/);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM group_includes').get() as { n: number }).n, 0, 'rolled back');
  const put = await t.req('PUT', `${API}/groups/base/members`, { headers: h, json: { members: [{ itemId: b.id, installAs: 'TEAM.md' }] } });
  assert.equal(put.status, 200, put.text);
  const ok = await addInclude(t, h, 'team', 'base');
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.group.members.find((m: { item: { name: string } }) => m.item.name === 'team-rules').installPath, 'TEAM.md');
  // The same clash arriving through the child later shows as a lint on the parent and blocks its bundle.
  const d = await item(t, h, { kind: 'instructions', name: 'more-rules', content: '# D\n' });
  const viaChild = await addMember(t, h, 'base', { itemId: d.id, installAs: 'TEAM.md' });
  assert.equal(viaChild.status, 409, 'base itself refuses the clash with team-rules');
  assert.equal((await t.req('DELETE', `${API}/groups/base/members/${b.id}`, { headers: h })).status, 200);
  assert.equal((await addMember(t, h, 'base', { itemId: d.id })).status, 201, 'CLAUDE.md is free inside base');
  const man = await t.req('GET', `${API}/groups/team/manifest`, { headers: h });
  assert.deepEqual(man.json.conflicts, [{ path: 'CLAUDE.md', items: ['house-rules', 'more-rules'] }]);
  assert.equal((await t.req('GET', `${API}/groups/team/bundle.zip`, { headers: h })).status, 409);
  // A direct member add on the parent sees the effective set too.
  const e = await item(t, h, { kind: 'prompt', name: 'e', content: 'e', visibility: 'public' });
  const clash = await addMember(t, h, 'team', { itemId: e.id, installAs: 'AGENTS.md' });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, 'path_conflict');
});

test("a group shared by name is not its recipient's to republish: the include is refused, and a stale edge flows nothing", async () => {
  const { t, h, bh, team } = await fixture();
  const viewer = t.key(t.createUser({ username: 'viewer' })).headers;
  const secret = await item(t, bh, { kind: 'prompt', name: 'secret', content: 's' });
  const pack = await group(t, bh, { slug: 'pack', name: 'Pack', visibility: 'shared', sharedWith: ['alice'] });
  assert.equal((await addMember(t, bh, 'pack', { itemId: secret.id })).status, 201);
  assert.equal((await t.req('PATCH', `${API}/groups/team`, { headers: h, json: { visibility: 'public' } })).status, 200);
  assert.equal((await t.req('GET', `${API}/groups/pack`, { headers: h })).status, 200, 'alice reads pack');
  // She could not add bob's private item to her public group directly, and including his group is the same act.
  assert.equal((await addMember(t, h, 'team', { itemId: secret.id })).json.error.code, 'item_not_shareable');
  const inc = await addInclude(t, h, 'team', 'pack');
  assert.equal(inc.status, 400, inc.text);
  assert.equal(inc.json.error.code, 'include_not_shareable');
  assert.equal((await putIncludes(t, h, 'team', ['pack'])).json.error.code, 'include_not_shareable');
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM group_includes').get() as { n: number }).n, 0);
  // An edge written anyway (an older build): the walk and the SQL agree that nothing flows through it.
  t.db.prepare("INSERT INTO group_includes (group_id, included_id, position, added_at) VALUES (?, ?, 0, '2026-01-01T00:00:00.000Z')").run(team.id, pack.id);
  assert.deepEqual(memberNames(await detail(t, viewer, 'team')), ['p3']);
  assert.equal((await t.req('GET', `${API}/items/${secret.id}`, { headers: viewer })).status, 404);
  assert.deepEqual((await t.req('GET', `${API}/items?group=team`, { headers: viewer })).json.items.map((i: { name: string }) => i.name), ['p3']);
  // Bob makes pack public: now anyone may republish it, and it flows.
  assert.equal((await t.req('PATCH', `${API}/groups/pack`, { headers: bh, json: { visibility: 'public' } })).status, 200);
  assert.deepEqual(memberNames(await detail(t, viewer, 'team')), ['p3', 'secret']);
  assert.equal((await t.req('GET', `${API}/items/${secret.id}`, { headers: viewer })).status, 200);
});

test('group-scoped search and item detail see via-include members: /items?group=, /search?group=, MCP search, item.groups', async () => {
  const { t, h, p1, p3 } = await fixture();
  const viewer = t.key(t.createUser({ username: 'viewer' })).headers;
  assert.equal((await t.req('PATCH', `${API}/groups/team`, { headers: h, json: { visibility: 'public' } })).status, 200);
  assert.equal((await addInclude(t, h, 'team', 'base')).status, 201);
  const names = (r: { json: { items?: { name: string }[]; results?: { name: string }[] } }) => (r.json.items ?? r.json.results)!.map((i) => i.name).sort();
  assert.deepEqual(names(await t.req('GET', `${API}/items?group=team`, { headers: h })), ['p1', 'p2', 'p3']);
  assert.deepEqual(names(await t.req('GET', `${API}/items?group=team&q=one`, { headers: h })), ['p1'], 'p1 flows in from base');
  assert.deepEqual(names(await t.req('GET', `${API}/search?group=team&q=one`, { headers: h })), ['p1']);
  assert.deepEqual(names(await t.req('GET', `${API}/items?group=team`, { headers: viewer })), ['p1', 'p2', 'p3'], 'a reader of team only');
  assert.deepEqual(names(await t.req('GET', `${API}/items?group=base`, { headers: h })), ['p1', 'p2'], 'the child itself is unchanged');
  // The MCP search tool on /mcp/team agrees with get_group.
  const client = new Client({ name: 'includes-test', version: '0' });
  const appFetch = (url: string | URL, init?: RequestInit) => Promise.resolve(t.app.fetch(new Request(url, init)));
  await client.connect(new StreamableHTTPClientTransport(new URL('http://app.test/mcp/team'), { requestInit: { headers: viewer }, fetch: appFetch }));
  try {
    const r = (await client.callTool({ name: 'search', arguments: { query: 'one' } })) as { content: { text?: string }[]; isError?: boolean; structuredContent?: { results: { name: string }[] } };
    assert.ok(!r.isError, JSON.stringify(r));
    assert.deepEqual(r.structuredContent?.results.map((x) => x.name), ['p1']);
  } finally {
    await client.close();
  }
  // Item detail lists the readable groups that serve the item, included groups too; base stays hidden from the viewer.
  const groupsOf = async (hh: Record<string, string>, id: string) => ((await t.req('GET', `${API}/items/${id}`, { headers: hh })).json.item.groups as { slug: string }[]).map((g) => g.slug);
  assert.deepEqual(await groupsOf(h, p1.id), ['base', 'team']);
  assert.deepEqual(await groupsOf(viewer, p1.id), ['team']);
  assert.deepEqual(await groupsOf(h, p3.id), ['team']);
});

test('include caps: MAX_INCLUDES direct includes per group, MAX_EFFECTIVE_GROUPS per effective set, and the walk stops at the cap', async () => {
  const { t, alice, h } = await fixture();
  const link = t.db.prepare("INSERT INTO group_includes (group_id, included_id, position, added_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')");
  // Fan-out: a hub with MAX_INCLUDES direct includes refuses one more.
  const hub = insertGroup(t, alice, { slug: 'hub' });
  for (let i = 0; i < MAX_INCLUDES; i++) link.run(hub, insertGroup(t, alice, { slug: `leaf-${i}` }), i);
  const extra = await group(t, h, { slug: 'extra', name: 'Extra' });
  const full = await addInclude(t, h, 'hub', 'extra');
  assert.equal(full.status, 400, full.text);
  assert.equal(full.json.error.code, 'include_too_many');
  assert.match(full.json.error.message, /includes at most/);
  // Size: mids of two leaves each; 33 of them put the set at exactly the cap, the 34th would pass it.
  const hub2 = insertGroup(t, alice, { slug: 'hub2' });
  const mid = (n: number) => {
    const m = insertGroup(t, alice, { slug: `mid-${n}` });
    link.run(m, insertGroup(t, alice, { slug: `mid-${n}-a` }), 0);
    link.run(m, insertGroup(t, alice, { slug: `mid-${n}-b` }), 1);
    return m;
  };
  for (let n = 0; n < 33; n++) link.run(hub2, mid(n), n);
  assert.equal(effectiveGroups(t.db, getGroupRow(t.db, hub2)).length, MAX_EFFECTIVE_GROUPS);
  const m33 = mid(33);
  const over = await addInclude(t, h, 'hub2', 'mid-33');
  assert.equal(over.status, 400, over.text);
  assert.equal(over.json.error.code, 'include_too_many');
  assert.match(over.json.error.message, /serves at most/);
  assert.equal((await putIncludes(t, h, 'hub2', Array.from({ length: 34 }, (_, n) => `mid-${n}`))).json.error.code, 'include_too_many');
  assert.deepEqual((await detail(t, h, 'hub2')).includes.length, 33, 'nothing changed');
  // Forced past the cap in the DB: the walk serves the first MAX_EFFECTIVE_GROUPS and the listing stays bounded.
  link.run(hub2, m33, 33);
  assert.equal(effectiveGroups(t.db, getGroupRow(t.db, hub2)).length, MAX_EFFECTIVE_GROUPS);
  assert.equal(effectiveGroups(t.db, getGroupRow(t.db, hub2), 1000).length, MAX_EFFECTIVE_GROUPS + 3);
  const list = await t.req('GET', `${API}/groups?limit=200`, { headers: h });
  assert.equal(list.status, 200, list.text);
  assert.ok(extra.id);
});

test('include caps hold for the owner\'s groups that include the edited one: growing a child cannot push its parent past MAX_EFFECTIVE_GROUPS', async () => {
  const { t, alice, h } = await fixture();
  // hub includes mid-a and mid-b; each mid grows through its own include writes (MAX_INCLUDES direct each).
  await group(t, h, { slug: 'hub', name: 'Hub' });
  for (const m of ['mid-a', 'mid-b']) {
    await group(t, h, { slug: m, name: m });
    assert.equal((await addInclude(t, h, 'hub', m)).status, 201);
  }
  let n = 0;
  const leaf = () => {
    const slug = `leaf-${n++}`;
    insertGroup(t, alice, { slug });
    return slug;
  };
  for (let i = 0; i < MAX_INCLUDES; i++) assert.equal((await addInclude(t, h, 'mid-a', leaf())).status, 201);
  // hub's set: hub + 2 mids + 50 leaves = 53; 47 more on mid-b reach exactly MAX_EFFECTIVE_GROUPS.
  for (let i = 0; i < MAX_EFFECTIVE_GROUPS - 53; i++) assert.equal((await addInclude(t, h, 'mid-b', leaf())).status, 201);
  assert.equal(effectiveGroups(t.db, getGroupRow(t.db, (await detail(t, h, 'hub')).id)).length, MAX_EFFECTIVE_GROUPS);
  // One more leaf on mid-b fits mid-b (49 groups) but not hub: refused, naming hub, and nothing is served half-way.
  const tail = await item(t, h, { kind: 'prompt', name: 'tail', content: 'tail' });
  const last = insertGroup(t, alice, { slug: 'leaf-last', members: [tail.id] });
  const over = await addInclude(t, h, 'mid-b', 'leaf-last');
  assert.equal(over.status, 400, over.text);
  assert.equal(over.json.error.code, 'include_too_many');
  assert.match(over.json.error.message, /'hub', which includes 'mid-b'/);
  assert.equal((await putIncludes(t, h, 'mid-b', [...Array.from({ length: MAX_EFFECTIVE_GROUPS - 53 }, (_, i) => `leaf-${MAX_INCLUDES + i}`), 'leaf-last'])).json.error.code, 'include_too_many');
  assert.ok(last);
  const names = (r: { json: { items: { name: string }[] } }) => r.json.items.map((i) => i.name);
  assert.ok(!names(await t.req('GET', `${API}/items?group=hub`, { headers: h })).includes('tail'));
  assert.ok(!memberNames(await detail(t, h, 'hub')).includes('tail'), 'search and get_group agree');
  // A member added to a leaf is fine (the member cap is far), and reaches hub.
  const deep = await item(t, h, { kind: 'prompt', name: 'deep', content: 'deep' });
  assert.equal((await addMember(t, h, 'leaf-0', { itemId: deep.id })).status, 201);
  assert.ok(memberNames(await detail(t, h, 'hub')).includes('deep'));
});

test('reordering or trimming includes keeps a stale one (child gone private) without re-checking it', async () => {
  const { t, h, bh } = await fixture();
  const pub = await item(t, bh, { kind: 'prompt', name: 'bobs', content: 'b', visibility: 'public' });
  await group(t, bh, { slug: 'pack', name: 'Pack', visibility: 'public' });
  assert.equal((await addMember(t, bh, 'pack', { itemId: pub.id })).status, 201);
  await group(t, h, { slug: 'mine', name: 'Mine' });
  assert.equal((await putIncludes(t, h, 'team', ['pack', 'mine'])).status, 200);
  assert.equal((await t.req('PATCH', `${API}/groups/pack`, { headers: bh, json: { visibility: 'private' } })).status, 200);
  // The editor still sees the row (includesOf), so the UI's reorder PUTs it back; that must not 404.
  const re = await putIncludes(t, h, 'team', ['mine', 'pack']);
  assert.equal(re.status, 200, re.text);
  assert.deepEqual(re.json.group.includes.map((i: { slug: string }) => i.slug), ['mine', 'pack']);
  assert.ok(!memberNames(re.json.group).includes('bobs'), 'the stale include still does not flow');
  const trimmed = await putIncludes(t, h, 'team', ['mine']);
  assert.equal(trimmed.status, 200, trimmed.text);
  assert.deepEqual(trimmed.json.group.includes.map((i: { slug: string }) => i.slug), ['mine']);
  // A slug that is not already an edge is checked as before.
  assert.equal((await putIncludes(t, h, 'team', ['mine', 'pack'])).status, 404);
});

test("include add keeps a lint already between the parent's own members a lint, even when the child also serves one of them", async () => {
  const { t, h } = await fixture();
  const brand = await item(t, h, { kind: 'design', name: 'brand', files: [{ path: 'DESIGN.md', content: '## B\n' }] });
  const q = await item(t, h, { kind: 'prompt', name: 'q', content: 'q' });
  assert.equal((await addMember(t, h, 'team', { itemId: brand.id })).status, 201);
  assert.equal((await addMember(t, h, 'team', { itemId: q.id, installAs: '.scp/design/brand/notes.md' })).status, 201);
  // brand v2 grows a notes.md: its extras now land on q's installAs, a lint team reports but refuses nobody for.
  const v2 = await t.req('POST', `${API}/items/${brand.id}/versions`, { headers: h, json: { files: [{ path: 'DESIGN.md', content: '## B\n' }, { path: 'notes.md', content: 'n' }] } });
  assert.equal(v2.status, 201, v2.text);
  const lint = [{ path: '.scp/design/brand/notes.md', items: ['brand', 'q'] }];
  assert.deepEqual((await t.req('GET', `${API}/groups/team/manifest`, { headers: h })).json.conflicts, lint);
  await group(t, h, { slug: 'kid', name: 'Kid' });
  assert.equal((await addMember(t, h, 'kid', { itemId: brand.id })).status, 201);
  // kid serves brand too, but adds nothing to team's footprint: not a reason to refuse the include.
  const inc = await addInclude(t, h, 'team', 'kid');
  assert.equal(inc.status, 201, inc.text);
  assert.deepEqual((await t.req('GET', `${API}/groups/team/manifest`, { headers: h })).json.conflicts, lint);
  const re = await putIncludes(t, h, 'team', ['kid', 'base']);
  assert.equal(re.status, 200, re.text);
  // A child that brings a new clash is still refused.
  const other = await item(t, h, { kind: 'prompt', name: 'other', content: 'o' });
  await group(t, h, { slug: 'kid2', name: 'Kid2' });
  assert.equal((await addMember(t, h, 'kid2', { itemId: other.id, installAs: '.scp/design/brand/notes.md' })).status, 201);
  const clash = await addInclude(t, h, 'team', 'kid2');
  assert.equal(clash.status, 409, clash.text);
  assert.equal(clash.json.error.code, 'path_conflict');
});

test('group includes compose through MCP-style listing: group detail of a public parent for another user', async () => {
  const { t, h, p1 } = await fixture();
  const other: TestUser = t.createUser({ username: 'other' });
  const oh = t.key(other).headers;
  assert.equal((await t.req('PATCH', `${API}/groups/team`, { headers: h, json: { visibility: 'public' } })).status, 200);
  assert.equal((await addInclude(t, h, 'team', 'base')).status, 201);
  const d = await detail(t, oh, 'team');
  assert.deepEqual(memberNames(d), ['p3', 'p1', 'p2']);
  assert.equal(d.canEdit, false);
  assert.equal((await t.req('GET', `${API}/items/${p1.id}`, { headers: oh })).status, 200);
  assert.equal((await t.req('GET', `${API}/groups/base`, { headers: oh })).status, 404, 'base itself is private');
  assert.equal((await addInclude(t, oh, 'team', 'base')).status, 403, 'readers cannot edit includes');
});

test("fan-in cap counts other users' includers only, and a kept edge is never re-judged on reorder or trim, whatever its case", async () => {
  const { t, alice, h } = await fixture();
  const bobUser = t.createUser({ username: 'fanin-bob' });
  const bob = t.key(bobUser).headers;
  const carolUser = t.createUser({ username: 'fanin-carol' });
  const link = t.db.prepare("INSERT INTO group_includes (group_id, included_id, position, added_at) VALUES (?, ?, 0, '2026-01-01T00:00:00.000Z')");
  // Alice includes her public 'pub' in 50 of her own groups: bob's first include of it still goes through.
  const pub = insertGroup(t, alice, { slug: 'pub', visibility: 'public' });
  for (let i = 0; i < MAX_INCLUDED_BY; i++) link.run(insertGroup(t, alice, { slug: `own-${i}` }), pub);
  await group(t, bob, { slug: 'bobg', name: 'Bob' });
  const first = await addInclude(t, bob, 'bobg', 'pub');
  assert.equal(first.status, 201, first.text);
  // Bob holds [pub2, pub3]; carol's 50 groups then include pub2. Bob's reorder, trim and a differently
  // cased spelling of the kept slug are all fine: only a NEW edge over pub2 is refused.
  const pub2 = insertGroup(t, alice, { slug: 'pub2', visibility: 'public' });
  insertGroup(t, alice, { slug: 'pub3', visibility: 'public' });
  await group(t, bob, { slug: 'hub', name: 'Hub' });
  assert.equal((await putIncludes(t, bob, 'hub', ['pub2', 'pub3'])).status, 200);
  for (let i = 0; i < MAX_INCLUDED_BY; i++) link.run(insertGroup(t, carolUser, { slug: `carol-${i}` }), pub2);
  assert.equal((await putIncludes(t, bob, 'hub', ['pub3', 'pub2'])).status, 200);
  assert.equal((await putIncludes(t, bob, 'hub', ['PUB2'])).status, 200);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM group_includes WHERE group_id = (SELECT id FROM scp_groups WHERE slug = ?)').get('hub') as { n: number }).n, 1);
  await group(t, bob, { slug: 'hub2', name: 'Hub 2' });
  const fresh = await addInclude(t, bob, 'hub2', 'pub2');
  assert.equal(fresh.status, 400, fresh.text);
  assert.equal(fresh.json.error.code, 'include_too_many');
  assert.match(fresh.json.error.message, /other users' groups/);
});

test("fan-in cap: a public group is included by at most MAX_INCLUDED_BY other users' groups, never refusing its owner; a DAG forced past the caps costs a stranger a bounded walk", async () => {
  const { t, alice, h } = await fixture();
  const strangerUser = t.createUser({ username: 'stranger' });
  const stranger = t.key(strangerUser).headers;
  const admin = t.key(t.createUser({ username: 'root', isAdmin: true })).headers;
  const link = t.db.prepare("INSERT INTO group_includes (group_id, included_id, position, added_at) VALUES (?, ?, 0, '2026-01-01T00:00:00.000Z')");
  // Fan-in: 50 of the stranger's groups include alice's public 'leaf'; the stranger's 51st is refused, by POST and by PUT alike.
  const leaf = insertGroup(t, alice, { slug: 'leaf', visibility: 'public' });
  for (let i = 0; i < MAX_INCLUDED_BY; i++) link.run(insertGroup(t, strangerUser, { slug: `by-${i}` }), leaf);
  await group(t, stranger, { slug: 'one-more', name: 'One more' });
  const full = await addInclude(t, stranger, 'one-more', 'leaf');
  assert.equal(full.status, 400, full.text);
  assert.equal(full.json.error.code, 'include_too_many');
  assert.match(full.json.error.message, /included by 50 other users' groups/);
  assert.equal((await putIncludes(t, stranger, 'one-more', ['leaf'])).json.error.code, 'include_too_many');
  // The owner is never locked out of her own group by strangers' hubs: she sees none of them (includedBy lists
  // readable includers only) and would have nothing to remove, so her include goes through, by POST and by PUT.
  await group(t, h, { slug: 'mine', name: 'Mine' });
  assert.deepEqual((await detail(t, h, 'leaf')).includedBy, []);
  const own = await addInclude(t, h, 'mine', 'leaf');
  assert.equal(own.status, 201, own.text);
  assert.equal((await putIncludes(t, h, 'mine', ['leaf'])).status, 200);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM group_includes WHERE included_id = ?').get(leaf) as { n: number }).n, MAX_INCLUDED_BY + 1);
  // The densest DAG the caps allow over one private group: 30 private items in g0, 50 hubs over g0, 50 hubs
  // over each of those (2,550 edges). Nothing is readable to the stranger, so EXISTS cannot stop early;
  // every item row walks the whole DAG, and with the fan-in capped that walk stays cheap on every listing.
  const items: string[] = [];
  for (let i = 0; i < 30; i++) items.push((await item(t, h, { kind: 'prompt', name: `secret-${i}`, content: 's' })).id);
  const g0 = insertGroup(t, alice, { slug: 'g0', members: items });
  const l1 = Array.from({ length: MAX_INCLUDED_BY }, (_, i) => insertGroup(t, alice, { slug: `l1-${i}` }));
  const l2 = Array.from({ length: MAX_INCLUDED_BY }, (_, i) => insertGroup(t, alice, { slug: `l2-${i}` }));
  t.db.exec('BEGIN');
  for (const p of l1) link.run(p, g0);
  for (const q of l2) for (const p of l1) link.run(q, p);
  t.db.exec('COMMIT');
  const t0 = performance.now();
  const r = await t.req('GET', `${API}/items?limit=50`, { headers: stranger });
  const ms = performance.now() - t0;
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.json.items.some((i: { name: string }) => i.name.startsWith('secret-')));
  assert.ok(ms < 1500, `a stranger's listing took ${Math.round(ms)} ms over the densest allowed DAG`);
  // Forced past the fan-in cap in raw SQL (an older build): the walk dequeues at most MAX_UP_ROWS rows, so of
  // the 1,103 groups now reachable from an item an admin is shown that many at most, and the rest serve nothing.
  for (let i = 0; i < 1000; i++) link.run(insertGroup(t, alice, { slug: `forced-${i}` }), l1[0]);
  const serving = (await t.req('GET', `${API}/items/${items[0]}`, { headers: admin })).json.item.groups as { slug: string }[];
  assert.ok(serving.length > 100 && serving.length <= MAX_UP_ROWS, `${serving.length} serving groups`);
});

test("a stranger's private chain stacked on a public group does not count toward its owner's depth; past depth 4 it serves nothing", async () => {
  const { t, h, bh } = await fixture();
  const shallow = await item(t, h, { kind: 'prompt', name: 'shallow', content: 's' });
  const deep = await item(t, h, { kind: 'prompt', name: 'deep', content: 'd' });
  await group(t, h, { slug: 'pub', name: 'Pub', visibility: 'public' });
  await group(t, h, { slug: 'qq', name: 'QQ' });
  assert.equal((await addMember(t, h, 'pub', { itemId: shallow.id })).status, 201);
  assert.equal((await addMember(t, h, 'qq', { itemId: deep.id })).status, 201);
  // bob stacks four private groups over alice's public one: h1 -> h2 -> h3 -> h4 -> pub, each add within the cap.
  for (const s of ['h1', 'h2', 'h3', 'h4']) await group(t, bh, { slug: s, name: s });
  for (const [from, to] of [['h4', 'pub'], ['h3', 'h4'], ['h2', 'h3'], ['h1', 'h2']]) assert.equal((await addInclude(t, bh, from, to)).status, 201, from);
  // alice's include under pub is her business: bob's chain is not hers to see (includedBy is empty) nor to be blocked by.
  assert.deepEqual((await detail(t, h, 'pub')).includedBy, []);
  const ok = await addInclude(t, h, 'pub', 'qq');
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(memberNames(ok.json.group), ['shallow', 'deep']);
  // bob's h1 reaches pub at depth 4 and qq at depth 5: the read side truncates there, in the walk and in SQL alike.
  assert.deepEqual(memberNames(await detail(t, bh, 'h1')), ['shallow']);
  assert.deepEqual((await t.req('GET', `${API}/items?group=h1`, { headers: bh })).json.items.map((i: { name: string }) => i.name), ['shallow']);
  assert.equal((await t.req('GET', `${API}/items/${deep.id}`, { headers: bh })).status, 200, 'readable through h2, where qq is at depth 4');
  assert.deepEqual(memberNames(await detail(t, bh, 'h2')), ['shallow', 'deep']);
  // Her own chain still counts: qq -> r2 -> r3 -> r4 fits (pub at depth 0, r4 at 4), a fifth level of her own is refused.
  for (const s of ['r2', 'r3', 'r4', 'r5']) await group(t, h, { slug: s, name: s });
  for (const [from, to] of [['qq', 'r2'], ['r2', 'r3'], ['r3', 'r4']]) assert.equal((await addInclude(t, h, from, to)).status, 201, from);
  const deep5 = await addInclude(t, h, 'r4', 'r5');
  assert.equal(deep5.status, 400, deep5.text);
  assert.equal(deep5.json.error.code, 'include_too_deep');
});

test("a stranger's public group deepened or grown after the include fails none of the includer's own writes: the no-op reorder, her include, her member add", async () => {
  const { t, bob, h, bh, p3 } = await fixture();
  // alice's hub includes bob's public q0 while it is shallow and small.
  await group(t, h, { slug: 'hub', name: 'Hub' });
  for (const s of ['q0', 'q1', 'q2', 'q3', 'q4']) await group(t, bh, { slug: s, name: s.toUpperCase(), visibility: 'public' });
  const bq = await item(t, bh, { kind: 'prompt', name: 'bq', content: 'b', visibility: 'public' });
  assert.equal((await addMember(t, bh, 'q0', { itemId: bq.id })).status, 201);
  assert.equal((await addInclude(t, h, 'hub', 'q0')).status, 201);
  // bob then chains q0 -> q1 -> q2 -> q3 -> q4 (his own chain, each add within his cap) and grows q0 past MAX_MEMBERS.
  for (let i = 0; i < 4; i++) assert.equal((await addInclude(t, bh, `q${i}`, `q${i + 1}`)).status, 201, `q${i}`);
  fillGroup(t, bob, groupId(t, 'q0'), MAX_MEMBERS);
  // alice's writes judge her own chain and her own rows, not bob's: all succeed, and reads keep serving the tree.
  const re = await putIncludes(t, h, 'hub', ['q0']);
  assert.equal(re.status, 200, re.text);
  await group(t, h, { slug: 'mine', name: 'Mine' });
  const inc = await addInclude(t, h, 'hub', 'mine');
  assert.equal(inc.status, 201, inc.text);
  const add = await addMember(t, h, 'hub', { itemId: p3.id });
  assert.equal(add.status, 201, add.text);
  assert.equal((await t.req('GET', `${API}/groups/hub/manifest`, { headers: h })).status, 200);
  const hub = await detail(t, h, 'hub');
  assert.ok(memberNames(hub).includes('bq') && memberNames(hub).includes('p3'));
  // A stale edge (bob made q0 private) is judged the same way: her reorder and her add still go through.
  assert.equal((await t.req('PATCH', `${API}/groups/q0`, { headers: bh, json: { visibility: 'private' } })).status, 200);
  assert.equal((await putIncludes(t, h, 'hub', ['mine', 'q0'])).status, 200);
  const p4 = await item(t, h, { kind: 'prompt', name: 'p4', content: 'four' });
  assert.equal((await addMember(t, h, 'hub', { itemId: p4.id })).status, 201);
  // Her own chain still counts: hub -> mine -> m2 -> m3 -> m4 fits, a fifth level of her own is refused.
  for (const s of ['m2', 'm3', 'm4', 'm5']) await group(t, h, { slug: s, name: s });
  for (const [from, to] of [['mine', 'm2'], ['m2', 'm3'], ['m3', 'm4']]) assert.equal((await addInclude(t, h, from, to)).status, 201, from);
  assert.equal((await addInclude(t, h, 'm4', 'm5')).json.error.code, 'include_too_deep');
  // And a new edge in a PUT is still judged: a stranger's deep chain through a new include counts for her no more than before.
  assert.equal((await putIncludes(t, h, 'hub', ['q0', 'mine', 'base'])).status, 200, 'base is a new edge: checked, and fine');
});

test("the files cap holds for the owner's groups that include the edited one, and plugin.zip and the marketplace refuse a group over it like the manifest", async () => {
  const { t, alice, h, p3 } = await fixture();
  const key = t.key(alice);
  await group(t, h, { slug: 'hub', name: 'Hub' });
  await group(t, h, { slug: 'kid', name: 'Kid' });
  assert.equal((await addInclude(t, h, 'hub', 'kid')).status, 201);
  // hub's own member holds exactly MAX_GROUP_FILES files: one more anywhere in its effective set is one too many.
  const big = await item(t, h, { kind: 'skill', content: '---\nname: big\ndescription: d\n---\n' });
  const vid = (t.db.prepare('SELECT id FROM item_versions WHERE item_id = ?').get(big.id) as { id: string }).id;
  padVersion(t, vid, MAX_GROUP_FILES - 1);
  assert.equal((await addMember(t, h, 'hub', { itemId: big.id })).status, 201);
  assert.equal((await t.req('GET', `${API}/groups/hub/manifest`, { headers: h })).status, 200);
  // A one-file add to kid would push hub over: refused, naming hub, and hub's manifest stays 200.
  const over = await addMember(t, h, 'kid', { itemId: p3.id });
  assert.equal(over.status, 400, over.text);
  assert.equal(over.json.error.code, 'group_full');
  assert.match(over.json.error.message, /'hub', which includes 'kid'.*files/);
  assert.equal((await t.req('GET', `${API}/groups/hub/manifest`, { headers: h })).status, 200);
  // Forced past the cap in raw SQL (an older build): manifest, bundle, plugin.zip and the marketplace refuse together.
  t.db.prepare('INSERT INTO group_members (group_id, item_id, position, added_at) VALUES (?, ?, 0, ?)').run(groupId(t, 'kid'), p3.id, now());
  for (const path of ['manifest', 'bundle.zip', 'plugin.zip']) {
    const r = await t.req('GET', `${API}/groups/hub/${path}`, { headers: h });
    assert.equal(r.status, 400, path);
    assert.equal(r.json.error.code, 'group_full', path);
  }
  assert.equal((await t.req('GET', `/m/${key.token}/hub/plugin.zip`)).status, 400);
  const listed = ((await t.req('GET', `/m/${key.token}/marketplace.json`)).json.plugins as { name: string }[]).map((p) => p.name);
  assert.ok(!listed.includes('hub') && listed.includes('kid'), listed.join(','));
});
