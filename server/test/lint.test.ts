import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../src/lib/frontmatter.ts';
import { MAX_REQUIRES, lintVersion, parseRequires } from '../src/items/lint.ts';
import { migrate, newId, now } from '../src/db.ts';
import { makeTestCtx } from './helpers.ts';
import type { Kind } from '../src/types.ts';

const enc = new TextEncoder();

/** Lint codes for a single entry file. */
function codes(kind: Kind, name: string, text: string, extra: { path: string; text: string; mode?: number }[] = []) {
  const path = kind === 'skill' ? 'SKILL.md' : kind === 'design' ? 'DESIGN.md' : kind === 'instructions' ? 'AGENTS.md' : `${name}.md`;
  const files = [{ path, text }, ...extra].map((f) => ({ path: f.path, bytes: enc.encode(f.text), mode: 420 }));
  return lintVersion(kind, name, files, parseFrontmatter(text), { path, text }).map((l) => `${l.level}:${l.code}`);
}

test('frontmatter: CRLF, BOM, ... close, body preserved', () => {
  const fm = parseFrontmatter('---\r\nname: pdf\r\ndescription: >-\r\n  folded\r\n  text\r\n---\r\nbody\r\n');
  assert.deepEqual(fm.data, { name: 'pdf', description: 'folded text' });
  assert.equal(fm.body, 'body\r\n');
  assert.equal(fm.hasFrontmatter, true);
  assert.deepEqual(parseFrontmatter('﻿---\nname: x\n...\nrest').data, { name: 'x' });
  assert.equal(parseFrontmatter('---\nname: x\n...\nrest').body, 'rest');
  assert.deepEqual(parseFrontmatter('---\n---\n').data, {});
});

test('frontmatter: absent, unclosed, invalid, duplicate keys, custom tags', () => {
  assert.equal(parseFrontmatter('# title\n').hasFrontmatter, false);
  assert.equal(parseFrontmatter('\n---\nname: x\n---\n').hasFrontmatter, false, 'must be on line 1');
  assert.match(parseFrontmatter('---\nname: x\n').error!, /not closed/);
  assert.ok(parseFrontmatter('---\nname: [\n---\n').error);
  assert.ok(parseFrontmatter('---\n- a\n- b\n---\n').error, 'non-mapping');
  assert.ok(parseFrontmatter('---\nname: a\nname: b\n---\n').error, 'duplicate key');
  assert.ok(parseFrontmatter('---\nx: !!js/function "function(){}"\n---\n').error, 'custom tag');
  assert.ok(parseFrontmatter('---\na: &a [1]\nb: [*a, *a]\n---\n').data, 'small alias use is fine');
});

test("gray-matter style '---js' frontmatter never executes and lints invalid", () => {
  const g = globalThis as { SCP_PWNED?: number };
  const src = '---js\n({ name: (globalThis.SCP_PWNED = 1, "x"), description: "d" })\n---\nbody';
  const fm = parseFrontmatter(src);
  assert.equal(fm.hasFrontmatter, false);
  assert.equal(g.SCP_PWNED, undefined);
  assert.ok(codes('agent', 'x', src).includes('error:frontmatter.invalid'));
  assert.ok(codes('skill', 'x', src).includes('error:frontmatter.invalid'));
  assert.equal(g.SCP_PWNED, undefined);
});

test('skill lint codes', () => {
  assert.deepEqual(codes('skill', 'pdf', '---\nname: pdf\ndescription: Read PDFs.\n---\nbody\n'), []);
  assert.ok(codes('skill', 'pdf', '---\nname: other\ndescription: d\n---\n').includes('error:skill.name.dir'));
  assert.ok(codes('skill', 'pdf', '---\nname: Bad_Name\ndescription: d\n---\n').includes('error:skill.name.format'));
  assert.ok(codes('skill', 'claude-pdf', '---\nname: claude-pdf\ndescription: d\n---\n').includes('warn:skill.name.reserved'));
  assert.ok(codes('skill', 'pdf', '---\nname: pdf\n---\n').includes('error:skill.description.missing'));
  assert.ok(codes('skill', 'pdf', `---\nname: pdf\ndescription: ${'d'.repeat(1025)}\n---\n`).includes('error:skill.description.len'));
  assert.ok(codes('skill', 'pdf', `---\nname: pdf\ndescription: d\nwhen_to_use: ${'w'.repeat(1600)}\n---\n`).includes('warn:skill.listing.truncated'));
  assert.ok(codes('skill', 'pdf', `---\nname: pdf\ndescription: d\ncompatibility: ${'c'.repeat(501)}\n---\n`).includes('error:skill.compatibility.len'));
  assert.ok(codes('skill', 'pdf', '---\nname: pdf\ndescription: d\ntriggers: [a]\n---\n').includes('info:skill.keys.nonportable'));
  assert.ok(codes('skill', 'pdf', `---\nname: pdf\ndescription: d\n---\n${'line\n'.repeat(501)}`).includes('warn:skill.body.long'));
  assert.ok(codes('skill', 'pdf', '---\nname: pdf\ndescription: d\n---\nrun !`git status` now\n').includes('warn:skill.exec.inject'));
  assert.ok(codes('skill', 'pdf', '---\nname: pdf\ndescription: d\n---\n```!\nls\n```\n').includes('warn:skill.exec.inject'));
  assert.ok(codes('skill', 'pdf', '---\nname: pdf\ndescription: d\nhooks: {}\n---\n').includes('warn:skill.hooks'));
  const hard = codes('skill', 'pdf', '---\nname: pdf\ndescription: d\n---\n', [{ path: 'bin/x.sh', text: 'bash $HOME/.claude/skills/pdf/x' }]);
  assert.ok(hard.includes('warn:skill.path.hardcoded'));
  assert.ok(codes('skill', 'pdf', '﻿---\nname: pdf\ndescription: d\n---\n').includes('error:frontmatter.invalid'), 'BOM');
  assert.ok(codes('skill', 'pdf', '\n---\nname: pdf\ndescription: d\n---\n').includes('error:frontmatter.invalid'), 'blank line');
});

test('agent lint codes', () => {
  assert.deepEqual(codes('agent', 'rev', '---\nname: rev\ndescription: Reviews.\nmodel: sonnet\ncolor: blue\n---\nYou review.\n'), []);
  assert.ok(codes('agent', 'rev', '---\ndescription: d\n---\n').includes('error:agent.name.missing'));
  assert.ok(codes('agent', 'rev', '---\nname: a:b\ndescription: d\n---\n').includes('error:agent.name.colon'));
  assert.ok(codes('agent', 'rev', '---\nname: "-a"\ndescription: d\n---\n').includes('error:agent.name.dash'));
  assert.ok(codes('agent', 'rev', `---\nname: ${'a'.repeat(257)}\ndescription: d\n---\n`).includes('error:agent.name.len'));
  assert.ok(codes('agent', 'rev', '---\nname: rev\n---\n').includes('error:agent.description.missing'));
  assert.ok(codes('agent', 'rev', '---\nname: rev\ndescription: d\nmodel: gpt-9\n---\n').includes('warn:agent.model.unknown'));
  assert.deepEqual(codes('agent', 'rev', '---\nname: rev\ndescription: d\nmodel: claude-opus-5-5\n---\n'), []);
  assert.ok(codes('agent', 'rev', '---\nname: rev\ndescription: d\ncolor: mauve\n---\n').includes('warn:agent.color.invalid'));
  const many = Array.from({ length: 33 }, (_, i) => `s${i}`).join(', ');
  assert.ok(codes('agent', 'rev', `---\nname: rev\ndescription: d\nskills: ${many}\n---\n`).includes('error:agent.skills.max32'));
  assert.ok(codes('agent', 'rev', '﻿---\nname: rev\ndescription: d\n---\n').includes('error:frontmatter.invalid'));
  assert.ok(codes('agent', 'rev', '---\nname: rev\ndescription: [\n---\n').includes('error:frontmatter.invalid'));
});

test('instructions, design and other kinds', () => {
  assert.ok(codes('instructions', 'agents', '---\na: 1\n---\n# Rules\n').includes('warn:instructions.frontmatter.present'));
  assert.deepEqual(codes('instructions', 'agents', '# Rules\n'), []);
  assert.deepEqual(codes('design', 'd', '## Overview\n## Colors\r\n## Do’s and Don’ts\n## Random\n'), []);
  assert.ok(codes('design', 'd', '## Colors\n## Overview\n').includes('warn:design.section.order'));
  assert.ok(codes('design', 'd', '## Colors\n## Colors\n').includes('warn:design.section.order'));
  assert.deepEqual(codes('prompt', 'p', '---\nx: [\n---\n'), ['warn:frontmatter.invalid']);
});

// ---------- required CLIs (f9j0) ----------

test('requires: metadata.requires (portable) and top-level requires both report their CLI; lint says which', () => {
  const portable = '---\nname: rev\ndescription: d\nmetadata:\n  requires: [roborev]\n---\n';
  assert.deepEqual(codes('skill', 'rev', portable), ['info:requires.found']);
  assert.deepEqual(parseRequires(parseFrontmatter(portable).data).names, ['roborev']);
  const top = '---\nname: cb\ndescription: d\nrequires: [context-builder]\n---\n';
  assert.deepEqual(codes('skill', 'cb', top).sort(), ['info:requires.found', 'info:requires.toplevel', 'info:skill.keys.nonportable']);
  assert.deepEqual(parseRequires(parseFrontmatter(top).data).names, ['context-builder']);
  const fm = parseFrontmatter(top);
  const found = lintVersion('skill', 'cb', [], fm, { path: 'SKILL.md', text: top }).find((l) => l.code === 'requires.found');
  assert.equal(found?.message, 'requires CLIs: context-builder');
});

test('requires: one name, both spellings merged and deduplicated, invalid names warned and dropped, capped', () => {
  const r = parseRequires({ metadata: { requires: ['stax', 'kata', 'Bad Name', 42] }, requires: 'kata' });
  assert.deepEqual(r.names, ['kata', 'stax']);
  assert.deepEqual(r.invalid, ['Bad Name', '42']);
  assert.ok(codes('skill', 'x', '---\nname: x\ndescription: d\nmetadata:\n  requires: ["rm -rf /", ok]\n---\n').includes('warn:requires.invalid'));
  assert.deepEqual(parseRequires({ metadata: 'nope', requires: { a: 'x' } }).names, [], 'only lists and strings count');
  const many = Array.from({ length: MAX_REQUIRES + 3 }, (_, i) => `t${String(i).padStart(2, '0')}`);
  const capped = parseRequires({ metadata: { requires: many } });
  assert.equal(capped.names.length, MAX_REQUIRES);
  assert.equal(capped.dropped, 3);
  assert.ok(codes('skill', 'x', `---\nname: x\ndescription: d\nmetadata:\n  requires: [${many.join(', ')}]\n---\n`).includes('warn:requires.max'));
  assert.deepEqual(codes('skill', 'x', '---\nname: x\ndescription: d\n---\n'), [], 'nothing required, nothing said');
});

test('requires: migration 16 backfills older versions with the same rule as parseRequires', () => {
  const t = makeTestCtx();
  const u = t.createUser();
  const cases: Record<string, unknown>[] = [
    { metadata: { requires: ['roborev', 'kata'] } },
    { requires: ['context-builder'] },
    { metadata: { requires: 'stax' }, requires: ['stax', 'graphify'] },
    { metadata: { requires: ['Bad Name', 'ok.tool_1-x', 7, `${'a'.repeat(65)}`] } },
    { metadata: 'string', requires: { a: 'x' } },
    {},
    // Over the cap, unsorted, split across both spellings: the first MAX_REQUIRES by name are kept.
    { metadata: { requires: Array.from({ length: MAX_REQUIRES + 3 }, (_, i) => `t${String(MAX_REQUIRES + 2 - i).padStart(2, '0')}`) }, requires: ['a0'] },
  ];
  const ids = cases.map((fm, n) => {
    const itemId = newId();
    t.db.prepare('INSERT INTO items (id, owner_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(itemId, u.id, 'skill', `s${n}`, now(), now());
    const id = newId();
    t.db
      .prepare('INSERT INTO item_versions (id, item_id, seq, entry_path, tree_sha256, frontmatter, total_bytes, created_at) VALUES (?, ?, 1, ?, ?, ?, 0, ?)')
      .run(id, itemId, 'SKILL.md', 'x', JSON.stringify(fm), now());
    return id;
  });
  // Re-run the migration over versions written before it existed.
  t.db.exec('DROP TABLE version_requires; DROP TABLE cli_tools; PRAGMA user_version = 15;');
  migrate(t.db);
  const stored = (id: string) =>
    (t.db.prepare('SELECT name FROM version_requires WHERE version_id = ? ORDER BY name').all(id) as { name: string }[]).map((r) => r.name);
  cases.forEach((fm, n) => assert.deepEqual(stored(ids[n]), parseRequires(fm).names, JSON.stringify(fm)));
  assert.deepEqual(stored(ids[3]), ['ok.tool_1-x']);
});
