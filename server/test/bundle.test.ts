import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestCtx, type TestCtx } from './helpers.ts';
import { safeUnzip } from '../src/lib/zip.ts';
import { installPath, pathsOverlap } from '../src/groups/bundle.ts';

const API = '/api/v1';
type H = Record<string, string>;

const SKILL_MD = '---\nname: pdf\ndescription: >-\n  Extract | tables\n  from PDFs.\n---\n# PDF\n';
const AGENT_MD = '---\r\nname: reviewer\r\ndescription: Reviews code.\r\n---\r\nYou review.\r\n';

async function item(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/items`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.item as { id: string; name: string; version: { treeSha256: string } };
}

/** A group with one member of each install shape. */
async function fixture() {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'alice' });
  const h = t.key(u).headers;
  const skill = await item(t, h, {
    kind: 'skill',
    files: [
      { path: 'SKILL.md', content: SKILL_MD },
      { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', mode: 493 },
    ],
  });
  const agent = await item(t, h, { kind: 'agent', content: AGENT_MD });
  const ins = await item(t, h, { kind: 'instructions', name: 'rules', content: '# Rules\nBe terse.\n' });
  const design = await item(t, h, {
    kind: 'design',
    name: 'brand',
    files: [{ path: 'DESIGN.md', content: '## Overview\nCalm.\n' }, { path: 'tokens.css', content: ':root{}' }],
  });
  const art = await item(t, h, { kind: 'artifact', format: 'html', name: 'dash', content: '<h1>dash</h1>', description: 'KPI | board' });
  const prompt = await item(t, h, { kind: 'prompt', name: 'summarize', content: 'Summarize {{text}}' });
  const r = await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'kit', name: 'Kit', description: 'All the things', instructions: 'Start with pdf.\n' } });
  assert.equal(r.status, 201, r.text);
  for (const it of [skill, agent, ins, design, art, prompt]) {
    const m = await t.req('POST', `${API}/groups/kit/members`, { headers: h, json: { itemId: it.id } });
    assert.equal(m.status, 201, m.text);
  }
  return { t, u, h, skill, agent, ins, design, art, prompt };
}

const unzip = async (t: TestCtx, h: H, qs = '') => {
  const r = await t.req('GET', `${API}/groups/kit/bundle.zip${qs}`, { headers: h });
  assert.equal(r.status, 200, r.text);
  return { r, files: new Map(safeUnzip(r.bytes).map((f) => [f.path, f])) };
};
const text = (f: { bytes: Uint8Array } | undefined) => new TextDecoder().decode(f!.bytes);

test('installPath table and overlap rule', () => {
  const cc = { target: 'claude-code', scope: 'project' } as const;
  assert.equal(installPath('skill', 'pdf', 'SKILL.md', cc), '.claude/skills/pdf/');
  assert.equal(installPath('agent', 'rev', 'rev.md', cc), '.claude/agents/rev.md');
  assert.equal(installPath('command', 'ship', 'ship.md', cc), '.claude/commands/ship.md');
  assert.equal(installPath('instructions', 'r', 'AGENTS.md', cc), 'CLAUDE.md', 'Claude Code loads CLAUDE.md, not AGENTS.md');
  assert.equal(installPath('instructions', 'r', 'AGENTS.md', { ...cc, installAs: 'docs/RULES.md' }), 'docs/RULES.md', 'installAs wins');
  assert.equal(installPath('design', 'b', 'DESIGN.md', cc), 'DESIGN.md');
  assert.equal(installPath('prompt', 'p', 'p.md', cc), '.scp/prompts/p.md');
  assert.equal(installPath('package', 'k', 'README.md', cc), '.scp/packages/k/');
  assert.equal(installPath('artifact', 'd', 'index.html', cc), '.scp/artifacts/d/index.html');
  assert.equal(installPath('skill', 'pdf', 'SKILL.md', { ...cc, installAs: 'X.md' }), '.claude/skills/pdf/', 'installAs ignored for skills');
  const user = { target: 'claude-code', scope: 'user' } as const;
  assert.equal(installPath('instructions', 'r', 'AGENTS.md', user), '.claude/CLAUDE.md');
  assert.equal(installPath('instructions', 'r', 'AGENTS.md', { ...user, installAs: 'X.md' }), 'X.md', 'installAs wins');
  assert.equal(installPath('design', 'b', 'DESIGN.md', user), '.scp/design/b/DESIGN.md');
  assert.equal(installPath('skill', 'pdf', 'SKILL.md', user), '.claude/skills/pdf/');
  const codex = { target: 'codex', scope: 'project' } as const;
  assert.equal(installPath('skill', 'pdf', 'SKILL.md', codex), '.agents/skills/pdf/');
  assert.equal(installPath('agent', 'rev', 'rev.md', codex), '.codex/agents/rev.md');
  assert.equal(installPath('command', 'c', 'c.md', codex), '.codex/prompts/c.md');
  assert.equal(installPath('prompt', 'p', 'p.md', codex), '.codex/prompts/p.md');
  assert.equal(installPath('instructions', 'r', 'AGENTS.md', codex), 'AGENTS.md');
  const gen = { target: 'generic', scope: 'project' } as const;
  assert.equal(installPath('skill', 'pdf', 'SKILL.md', gen), 'skills/pdf/');
  assert.equal(installPath('instructions', 'r', 'AGENTS.md', gen), 'instructions/r.md');
  assert.equal(installPath('design', 'b', 'DESIGN.md', gen), 'design/b/DESIGN.md');
  assert.equal(installPath('artifact', 'd', 'App.jsx', gen), 'artifacts/d/App.jsx');
  assert.ok(pathsOverlap('AGENTS.md', 'agents.md'));
  assert.ok(pathsOverlap('.claude/skills/pdf/', '.claude/skills/PDF/x.md'));
  assert.ok(pathsOverlap('docs', 'docs/a.md'), 'file vs folder');
  assert.ok(!pathsOverlap('.claude/skills/pdf/', '.claude/skills/pdf-tools/'));
});

test('bundle.zip claude-code project: exact tree, modes, bytes, lock, instructions, audit', async () => {
  const { t, h, skill, agent, ins, design, art, prompt } = await fixture();
  const { r, files } = await unzip(t, h);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="kit-claude-code.zip"');
  assert.deepEqual([...files.keys()].sort(), [
    '.claude/agents/reviewer.md',
    '.claude/skills/pdf/SKILL.md',
    '.claude/skills/pdf/scripts/run.sh',
    '.scp/artifacts/dash/index.html',
    '.scp/design/brand/tokens.css',
    '.scp/groups/kit/INSTRUCTIONS.md',
    '.scp/prompts/summarize.md',
    'CLAUDE.md',
    'DESIGN.md',
    'scp.lock.json',
  ]);
  assert.equal(files.get('.claude/skills/pdf/scripts/run.sh')!.mode, 493, 'exec bit preserved');
  assert.equal(files.get('.claude/skills/pdf/SKILL.md')!.mode, 420);
  assert.deepEqual(files.get('.claude/agents/reviewer.md')!.bytes, new TextEncoder().encode(AGENT_MD), 'byte-identical, CRLF kept');
  assert.equal(text(files.get('CLAUDE.md')), '# Rules\nBe terse.\n');
  assert.equal(text(files.get('DESIGN.md')), '## Overview\nCalm.\n');
  assert.equal(text(files.get('.scp/artifacts/dash/index.html')), '<h1>dash</h1>');
  assert.equal(text(files.get('.scp/groups/kit/INSTRUCTIONS.md')), 'Start with pdf.\n');
  const lock = JSON.parse(text(files.get('scp.lock.json')));
  assert.equal(lock.scp, 'http://app.test');
  assert.equal(lock.group, 'kit');
  assert.equal(lock.target, 'claude-code');
  assert.equal(lock.scope, 'project');
  assert.match(lock.generatedAt, /^\d{4}-\d\d-\d\dT/);
  const byName = new Map(lock.items.map((i: { name: string }) => [i.name, i]));
  for (const it of [skill, agent, ins, design, art, prompt]) {
    const l = byName.get(it.name) as { id: string; treeSha256: string; version: number; owner: string };
    assert.equal(l.id, it.id);
    assert.equal(l.treeSha256, it.version.treeSha256, it.name);
    assert.equal(l.version, 1);
    assert.equal(l.owner, 'alice');
  }
  assert.equal((byName.get('pdf') as { path: string }).path, '.claude/skills/pdf/');
  assert.equal((byName.get('rules') as { path: string }).path, 'CLAUDE.md', 'the lock records where the instructions landed');
  const ev = t.db.prepare("SELECT detail FROM audit WHERE action = 'bundle.download'").get() as { detail: string };
  assert.deepEqual(JSON.parse(ev.detail), { slug: 'kit', target: 'claude-code', scope: 'project', items: 6 });
});

test('codex, generic and user-scope bundles; bad target/scope 400', async () => {
  const { t, h } = await fixture();
  const codex = (await unzip(t, h, '?target=codex')).files;
  assert.ok(codex.has('.agents/skills/pdf/SKILL.md'));
  assert.ok(codex.has('.codex/agents/reviewer.md'));
  assert.ok(codex.has('.codex/prompts/summarize.md'));
  assert.ok(codex.has('AGENTS.md'));
  const gen = (await unzip(t, h, '?target=generic')).files;
  for (const p of ['skills/pdf/scripts/run.sh', 'agents/reviewer.md', 'instructions/rules.md', 'design/brand/DESIGN.md', 'design/brand/tokens.css', 'prompts/summarize.md', 'artifacts/dash/index.html']) {
    assert.ok(gen.has(p), p);
  }
  const user = (await unzip(t, h, '?scope=user')).files;
  assert.ok(user.has('.claude/CLAUDE.md'));
  assert.ok(user.has('.scp/design/brand/DESIGN.md'));
  assert.ok(!user.has('AGENTS.md'));
  const cd = (await t.req('GET', `${API}/groups/kit/bundle.zip?target=generic`, { headers: h })).headers.get('content-disposition');
  assert.equal(cd, 'attachment; filename="kit-generic.zip"');
  for (const qs of ['?target=cursor', '?scope=global']) {
    assert.equal((await t.req('GET', `${API}/groups/kit/bundle.zip${qs}`, { headers: h })).status, 400, qs);
    assert.equal((await t.req('GET', `${API}/groups/kit/manifest${qs}`, { headers: h })).status, 400, qs);
  }
});

test('manifest: catalog without bodies; a codex-only collision is refused on add', async () => {
  const { t, h, skill } = await fixture();
  const m = await t.req('GET', `${API}/groups/kit/manifest`, { headers: h });
  assert.equal(m.status, 200);
  assert.deepEqual(m.json.group, {
    slug: 'kit',
    name: 'Kit',
    description: 'All the things',
    instructions: 'Start with pdf.\n',
    updatedAt: m.json.group.updatedAt,
  });
  assert.equal(m.json.target, 'claude-code');
  assert.deepEqual(m.json.conflicts, []);
  assert.deepEqual(m.json.items[0], {
    id: skill.id,
    kind: 'skill',
    plane: 'skill',
    name: 'pdf',
    title: 'pdf',
    description: 'Extract | tables from PDFs.',
    version: 1,
    treeSha256: skill.version.treeSha256,
    installPath: '.claude/skills/pdf/',
    owner: 'alice',
  });
  // command 'summarize' and prompt 'summarize' differ for claude-code but share .codex/prompts/summarize.md
  // so the add is refused up front instead of the codex download failing later.
  const cmd = await item(t, h, { kind: 'command', name: 'summarize', content: 'Do it.' });
  const add = await t.req('POST', `${API}/groups/kit/members`, { headers: h, json: { itemId: cmd.id } });
  assert.equal(add.status, 409);
  assert.equal(add.json.error.code, 'path_conflict');
  assert.match(add.json.error.message, /\.codex\/prompts\/summarize\.md/);
  // installAs resolves it on every target.
  const as = await t.req('POST', `${API}/groups/kit/members`, { headers: h, json: { itemId: cmd.id, installAs: '.claude/commands/summarize.md' } });
  assert.equal(as.status, 201, as.text);
  for (const target of ['claude-code', 'codex', 'generic']) {
    assert.deepEqual((await t.req('GET', `${API}/groups/kit/manifest?target=${target}`, { headers: h })).json.conflicts, [], target);
    assert.equal((await t.req('GET', `${API}/groups/kit/bundle.zip?target=${target}`, { headers: h })).status, 200, target);
  }
});

test('design extras install under .scp/design/<name>/, never at the project root or beside installAs', async () => {
  const t = makeTestCtx();
  const bob = t.createUser({ username: 'bob' });
  const alice = t.createUser({ username: 'alice' });
  const hb = t.key(bob).headers;
  const ha = t.key(alice).headers;
  const brand = await item(t, hb, {
    kind: 'design',
    name: 'brand',
    visibility: 'public',
    files: [
      { path: 'DESIGN.md', content: '## Overview\n' },
      { path: '.claude/settings.json', content: '{"hooks":{}}' },
      { path: '.vscode/tasks.json', content: '{}' },
      { path: 'scp.lock.json', content: '{}' },
    ],
  });
  assert.equal((await t.req('POST', `${API}/groups`, { headers: ha, json: { slug: 'kit', name: 'Kit' } })).status, 201);
  assert.equal((await t.req('POST', `${API}/groups/kit/members`, { headers: ha, json: { itemId: brand.id } })).status, 201);
  const root = (await unzip(t, ha)).files;
  assert.deepEqual([...root.keys()].sort(), [
    '.scp/design/brand/.claude/settings.json',
    '.scp/design/brand/.vscode/tasks.json',
    '.scp/design/brand/scp.lock.json',
    'DESIGN.md',
    'scp.lock.json',
  ]);
  const put = await t.req('PUT', `${API}/groups/kit/members`, { headers: ha, json: { members: [{ itemId: brand.id, installAs: '.claude/DESIGN.md' }] } });
  assert.equal(put.status, 200, put.text);
  const placed = (await unzip(t, ha)).files;
  assert.ok(placed.has('.claude/DESIGN.md'));
  assert.ok(!placed.has('.claude/.claude/settings.json') && placed.has('.scp/design/brand/.claude/settings.json'));
});

test('path conflicts count multi-file extras, in the manifest and on member add', async () => {
  const t = makeTestCtx();
  const u = t.createUser({ username: 'alice' });
  const h = t.key(u).headers;
  const brand = await item(t, h, { kind: 'design', name: 'brand', files: [{ path: 'DESIGN.md', content: '## Overview\n' }] });
  const notes = await item(t, h, { kind: 'prompt', name: 'notes', content: 'Notes.' });
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'kit', name: 'Kit' } })).status, 201);
  for (const json of [{ itemId: brand.id }, { itemId: notes.id, installAs: '.scp/design/brand/notes.md' }]) {
    const r = await t.req('POST', `${API}/groups/kit/members`, { headers: h, json });
    assert.equal(r.status, 201, r.text);
  }
  // A new design version adds an extra that lands exactly where the prompt installs.
  const v2 = await t.req('POST', `${API}/items/${brand.id}/versions`, {
    headers: h,
    json: { files: [{ path: 'DESIGN.md', content: '## Overview\n' }, { path: 'notes.md', content: 'design notes' }] },
  });
  assert.equal(v2.status, 201, v2.text);
  const m = await t.req('GET', `${API}/groups/kit/manifest`, { headers: h });
  assert.deepEqual(m.json.conflicts, [{ path: '.scp/design/brand/notes.md', items: ['brand', 'notes'] }]);
  // The manifest says bundle.zip cannot be built, with the very refusal the download answers, so the UI can gate the link.
  assert.equal(m.json.bundle.ok, false);
  assert.equal(m.json.bundle.code, 'path_conflict');
  assert.match(m.json.bundle.problem, /both install to '\.scp\/design\/brand\/notes\.md'/);
  assert.deepEqual(m.json.plugin, { ok: true, problem: null, code: null }, 'the plugin layout keeps the two apart');
  assert.equal((await t.req('GET', `${API}/groups/kit/bundle.zip`, { headers: h })).status, 409);
  // The same clash is refused up front when it is created by adding a member.
  const other = await item(t, h, { kind: 'prompt', name: 'other', content: 'Other.' });
  const add = await t.req('POST', `${API}/groups/kit/members`, { headers: h, json: { itemId: other.id, installAs: '.scp/design/brand/notes.md' } });
  assert.equal(add.status, 409, add.text);
  assert.equal(add.json.error.code, 'path_conflict');
  // A member's installAs onto its own extras is a clash too (manifest and bundle must agree).
  const self = await item(t, h, { kind: 'design', name: 'self', files: [{ path: 'DESIGN.md', content: '## Overview\n' }, { path: 'x.md', content: 'x' }] });
  const own = await t.req('POST', `${API}/groups/kit/members`, { headers: h, json: { itemId: self.id, installAs: '.scp/design/self/x.md' } });
  assert.equal(own.status, 409, own.text);
  assert.equal(own.json.error.code, 'path_conflict');
});

test('bundle refuses any member path that collides with SCP files as file vs folder', async () => {
  const { t, h, ins } = await fixture();
  // A row written before installAs reserved scp.lock.json: the bundle's own overlap check still holds.
  t.db.prepare("UPDATE group_members SET install_as = 'scp.lock.json/rules.md' WHERE item_id = ?").run(ins.id);
  const r = await t.req('GET', `${API}/groups/kit/bundle.zip`, { headers: h });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error.code, 'path_conflict');
});

test('pinned version is what gets bundled after a newer version exists', async () => {
  const { t, h, agent } = await fixture();
  const v2 = AGENT_MD.replace('You review.', 'You review harder.');
  assert.equal((await t.req('POST', `${API}/items/${agent.id}/versions`, { headers: h, json: { content: v2 } })).status, 201);
  const put = await t.req('PUT', `${API}/groups/kit/members`, { headers: h, json: { members: [{ itemId: agent.id, pinnedSeq: 1 }] } });
  assert.equal(put.status, 200, put.text);
  const { files } = await unzip(t, h);
  assert.deepEqual(files.get('.claude/agents/reviewer.md')!.bytes, new TextEncoder().encode(AGENT_MD));
  const lock = JSON.parse(text(files.get('scp.lock.json')));
  assert.equal(lock.items[0].version, 1);
  assert.equal(lock.items[0].treeSha256, agent.version.treeSha256);
  // unpinned follows latest
  await t.req('PUT', `${API}/groups/kit/members`, { headers: h, json: { members: [{ itemId: agent.id }] } });
  assert.equal(text((await unzip(t, h)).files.get('.claude/agents/reviewer.md')), v2);
});

test('catalog.md: one row per member, pipes and newlines escaped, full text', async () => {
  const { t, h } = await fixture();
  const r = await t.req('GET', `${API}/groups/kit/catalog.md`, { headers: h });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const md = r.text;
  assert.ok(md.startsWith('# Kit\n\nAll the things\n'));
  assert.ok(md.includes('## Skills') && md.includes('## Prompts & MDs') && md.includes('## Artifacts'));
  const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Name '));
  assert.equal(rows.length, 6);
  assert.ok(rows.includes('| pdf | skill | Extract \\| tables from PDFs. | 1 | `.claude/skills/pdf/` |'), md);
  assert.ok(rows.includes('| dash | artifact | KPI \\| board | 1 | `.scp/artifacts/dash/index.html` |'), md);
  // every row has exactly 6 unescaped pipes (5 columns)
  for (const row of rows) assert.equal(row.replace(/\\\|/g, '').split('|').length - 1, 6, row);
  const long = 'x'.repeat(3000);
  const big = await item(t, h, { kind: 'prompt', name: 'long', content: 'y', description: `${long}\nline two` });
  await t.req('POST', `${API}/groups/kit/members`, { headers: h, json: { itemId: big.id } });
  const md2 = (await t.req('GET', `${API}/groups/kit/catalog.md`, { headers: h })).text;
  assert.ok(md2.includes(`| long | prompt | ${long}<br>line two | 1 |`), 'no truncation, newline escaped');
});
