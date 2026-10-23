import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, prependFrontmatter } from '../src/lib/frontmatter.ts';

test('jcfm: prependFrontmatter puts a block in front of a file that has none, and leaves one that has its own alone', () => {
  const out = prependFrontmatter('# Stax\n\nBody.\n', { name: 'stax', description: 'Stacked branches.' });
  assert.equal(out, '---\nname: stax\ndescription: Stacked branches.\n---\n# Stax\n\nBody.\n');
  assert.equal(prependFrontmatter('---\nname: x\n---\nBody.\n', { description: 'ignored' }), null);
  // A broken upstream block is still upstream's: SCP never stacks a second one on top.
  assert.equal(prependFrontmatter('---\nname: [\n---\nBody.\n', { description: 'ignored' }), null);
  // A BOM would hide the block from Claude Code; it is dropped.
  assert.equal(prependFrontmatter('﻿# T\n', { description: 'd' }), '---\ndescription: d\n---\n# T\n');
});

test('jcfm: values with YAML-special characters round-trip; the same fields always give the same bytes', () => {
  const hostile = [
    'Use when: reviewing code # not a comment',
    'line one\nline two\n\n---\nafter a fence line',
    '- starts like a list',
    "'quoted' and \"double\"",
    '{ flow: mapping }',
    'true',
    '123',
    '*alias &anchor !!js/function',
    '...',
    'x'.repeat(1024),
  ];
  for (const description of hostile) {
    const fields = { name: 'my-skill', description };
    const out = prependFrontmatter('Body.\n', fields)!;
    const fm = parseFrontmatter(out);
    assert.equal(fm.error, undefined, description);
    assert.deepEqual(fm.data, fields, description);
    assert.equal(fm.body, 'Body.\n', description);
    assert.equal(prependFrontmatter('Body.\n', fields), out, 'deterministic');
  }
});
