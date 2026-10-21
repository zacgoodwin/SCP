import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../src/lib/frontmatter.ts';
import { lintVersion } from '../src/items/lint.ts';
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
