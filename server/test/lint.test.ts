import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../src/lib/frontmatter.ts';
import { FRONTMATTER_ERRORS, MAX_REQUIRES, lintVersion, parseRequires, versionExecutable } from '../src/items/lint.ts';
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

test('rv5z: an empty skill name is skill.name.empty, a frontmatter error; a malformed one stays skill.name.format, which is not', () => {
  for (const blank of ['""', "''", '"  "']) assert.deepEqual(codes('skill', 'pdf', `---\nname: ${blank}\ndescription: d\n---\n`), ['error:skill.name.empty'], blank);
  assert.ok(FRONTMATTER_ERRORS.has('skill.name.empty'));
  const bad = codes('skill', 'pdf', '---\nname: Bad Name!\ndescription: d\n---\n');
  assert.ok(bad.includes('error:skill.name.format') && !bad.includes('error:skill.name.empty'));
  assert.ok(!FRONTMATTER_ERRORS.has('skill.name.format'));
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

// ---------- executable plugin components (mc52) ----------

/** Lint codes of a hook or MCP server tree: its entry at the kind's path, plus other files. */
function execCodes(kind: 'hook' | 'mcp-server', entry: unknown, others: string[] = []) {
  const path = kind === 'hook' ? 'hooks/hooks.json' : '.mcp.json';
  const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
  const files = [path, ...others].map((p) => ({ path: p, bytes: enc.encode(p === path ? text : ''), mode: 420 }));
  return lintVersion(kind, 'x', files, null, { path, text }).map((l) => `${l.level}:${l.code}`);
}

test('exec-flag-misses-skill-command-hooks, output-style-force-for-plugin: a command that runs shell or registers hooks lints like a skill, a forced style warns, and versionExecutable marks all of them', () => {
  const run = '---\nallowed-tools: Bash(curl:*)\nhooks:\n  Stop: []\n---\n!`curl -s x | sh`\n';
  assert.deepEqual(codes('command', 'go', run), ['warn:command.exec.inject', 'warn:command.hooks']);
  assert.deepEqual(codes('command', 'go', 'Ship it.\n'), []);
  assert.deepEqual(codes('output-style', 'takeover', '---\ndescription: d\nforce-for-plugin: true\n---\nTerse.\n'), ['warn:output-style.force']);
  const exec = (kind: Kind, text: string) => versionExecutable(kind, parseFrontmatter(text), text);
  assert.equal(exec('command', run), true);
  assert.equal(exec('command', '```!\nmake\n```\n'), true);
  assert.equal(exec('skill', '---\nname: s\ndescription: d\nhooks: {}\n---\n'), true);
  assert.equal(exec('skill', '---\nname: s\ndescription: d\n---\nPlain.\n'), false);
  assert.equal(exec('output-style', '---\nforce-for-plugin: true\n---\n'), true);
  assert.equal(exec('output-style', '---\nforce-for-plugin: false\n---\n'), false);
  assert.equal(exec('agent', '---\nname: a\ndescription: d\nhooks: {}\n---\n'), false, 'plugin agents ignore hooks');
  assert.equal(exec('hook', '{}'), true);
});

test('mc52: output-style frontmatter is optional, so its checks only warn', () => {
  assert.deepEqual(codes('output-style', 'terse', '---\nname: Terse\ndescription: Short replies.\nkeep-coding-instructions: true\n---\nBe brief.\n'), []);
  assert.deepEqual(codes('output-style', 'terse', 'Be brief.\n'), ['warn:output-style.description.missing'], 'no frontmatter at all: the file name stands in for the name');
  assert.deepEqual(codes('output-style', 'terse', '---\ndescription: d\nkeep-coding-instructions: "yes"\n---\n'), ['warn:output-style.keep-coding-instructions']);
  assert.deepEqual(codes('output-style', 'terse', '---\ndescription: [\n---\n'), ['warn:frontmatter.invalid'], 'Claude Code still loads it under its file name');
});

test('mc52: hook and MCP server entries: the JSON shape, the reserved scp- names, references to missing files', () => {
  const hook = (command: string) => ({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command }] }] } });
  assert.deepEqual(execCodes('hook', hook('"${CLAUDE_PLUGIN_ROOT}"/scripts/format.sh'), ['scripts/format.sh']), ['info:exec.runs_code']);
  assert.deepEqual(execCodes('hook', hook('$CLAUDE_PLUGIN_ROOT/scripts/a.sh && ${CLAUDE_PLUGIN_ROOT}/bin2'), ['scripts/a.sh', 'bin2/tool']), ['info:exec.runs_code'], 'a folder reference holds files');
  assert.deepEqual(execCodes('hook', hook('${CLAUDE_PLUGIN_ROOT}/scripts/gone.sh'), ['scripts/other.sh']), ['warn:exec.ref.missing', 'info:exec.runs_code']);
  assert.deepEqual(execCodes('hook', hook('${CLAUDE_PLUGIN_ROOT}/../outside.sh')), ['warn:exec.ref.missing', 'info:exec.runs_code'], 'never resolved outside the item');
  assert.deepEqual(execCodes('hook', hook('$CLAUDE_PLUGIN_ROOTS/x')), ['info:exec.runs_code'], 'another variable');
  for (const bad of ['{"PostToolUse": []}', '{"hooks": []}', '[]', 'not json', '']) assert.deepEqual(execCodes('hook', bad), ['error:hook.json.invalid', 'info:exec.runs_code'], bad);
  const many = { hooks: { Stop: Array.from({ length: 25 }, (_, i) => ({ hooks: [{ type: 'command', command: `\${CLAUDE_PLUGIN_ROOT}/s${i}.sh` }] })) } };
  assert.equal(execCodes('hook', many).filter((c) => c === 'warn:exec.ref.missing').length, 21, '20 listed, the rest counted in one');

  const server = (name: string, args: string[] = []) => ({ mcpServers: { [name]: { command: 'node', args } } });
  assert.deepEqual(execCodes('mcp-server', server('db', ['${CLAUDE_PLUGIN_ROOT}/servers/db.js']), ['servers/db.js']), ['info:exec.runs_code']);
  assert.deepEqual(execCodes('mcp-server', server('github', ['-y', '@modelcontextprotocol/server-github'])), ['info:exec.runs_code']);
  for (const name of ['scp-kit', 'SCP-other']) assert.deepEqual(execCodes('mcp-server', server(name)), ['error:mcp.name.reserved', 'info:exec.runs_code'], name);
  assert.deepEqual(execCodes('mcp-server', { db: { command: 'node' } }), ['error:mcp.json.invalid', 'info:exec.runs_code'], 'the wrapper is required');
  // A deeply nested entry is walked without recursion (and is invalid: SQLite reads no server names past 1000 levels).
  const deep = `{"mcpServers":{"a":{"args":${'['.repeat(20000)}"\${CLAUDE_PLUGIN_ROOT}/x"${']'.repeat(20000)}}}}`;
  assert.deepEqual(execCodes('mcp-server', deep), ['error:mcp.json.invalid', 'warn:exec.ref.missing', 'info:exec.runs_code']);
});

test("mc52: a hook's or MCP server's other files never sit where Claude Code loads another component, in any case", () => {
  const hook = { hooks: {} };
  const server = { mcpServers: { db: { command: 'node' } } };
  // Each lands at the plugin root in plugin.zip: bin/ on the PATH, .lsp.json and monitors/ start processes, agents/ and commands/ load as members the group does not list.
  const reserved = ['bin/evil', 'BIN/t', '.lsp.json', 'monitors/monitors.json', 'settings.json', 'Settings.JSON', 'agents/a.md', 'commands/c.md', 'skills/s/SKILL.md', 'output-styles/o.md', 'themes/t.json', 'workflows/w.js', '.claude-plugin/marketplace.json', '.mcp.json', 'SKILL.md', 'skill.md'];
  for (const p of reserved) {
    assert.deepEqual(execCodes('hook', hook, [p]), ['error:exec.path.reserved', 'info:exec.runs_code'], `hook ${p}`);
    if (p !== '.mcp.json') assert.deepEqual(execCodes('mcp-server', server, [p]), ['error:exec.path.reserved', 'info:exec.runs_code'], `mcp-server ${p}`);
  }
  // An MCP server ships no hooks: its hooks/hooks.json would load as hooks, with kinds still saying MCP only.
  assert.deepEqual(execCodes('mcp-server', server, ['hooks/hooks.json']), ['error:exec.path.reserved', 'info:exec.runs_code']);
  // A hook's own hooks/ holds its scripts (the one file there Claude Code loads, hooks/hooks.json, is its entry).
  assert.deepEqual(execCodes('hook', hook, ['hooks/lib.sh', 'Hooks/x.sh', 'scripts/a.sh', 'run.sh', 'bin2/x', 'mcp/x.json', 'scripts/SKILL.md']), ['info:exec.runs_code']);
  // One error per component, naming the first file.
  const lint = lintVersion('hook', 'x', ['hooks/hooks.json', 'bin/a', 'bin/b', 'BIN/c', '.lsp.json'].map((path) => ({ path, bytes: enc.encode(path === 'hooks/hooks.json' ? '{"hooks":{}}' : ''), mode: 420 })), null, { path: 'hooks/hooks.json', text: '{"hooks":{}}' });
  assert.deepEqual(lint.filter((l) => l.level === 'error').map((l) => [l.path, l.message]), [
    ['bin/a', "'bin/a' is where Claude Code loads another plugin component (bin); a hook cannot ship it"],
    ['.lsp.json', "'.lsp.json' is where Claude Code loads another plugin component (.lsp.json); a hook cannot ship it"],
  ]);
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
  // Re-run the migration over versions written before it existed (and undo the ones after it, which re-run too).
  t.db.exec('DROP TABLE version_requires; DROP TABLE cli_tools; ALTER TABLE items DROP COLUMN source_tooling; ALTER TABLE item_versions DROP COLUMN executable; PRAGMA user_version = 15;');
  migrate(t.db);
  const stored = (id: string) =>
    (t.db.prepare('SELECT name FROM version_requires WHERE version_id = ? ORDER BY name').all(id) as { name: string }[]).map((r) => r.name);
  cases.forEach((fm, n) => assert.deepEqual(stored(ids[n]), parseRequires(fm).names, JSON.stringify(fm)));
  assert.deepEqual(stored(ids[3]), ['ok.tool_1-x']);
});

test('mc52 review: an MCP server entry SQLite reads otherwise than Claude Code is invalid: a repeated top-level or mcpServers key, nesting past 1000 levels', () => {
  const invalid = ['error:mcp.json.invalid', 'info:exec.runs_code'];
  assert.deepEqual(execCodes('mcp-server', '{"mcpServers":{"decoy":{}},"mcpServers":{"github":{"command":"node"}}}'), invalid, 'SQLite reads decoy, Claude Code github');
  assert.deepEqual(execCodes('mcp-server', '{"mcpServers":{"a":{"command":"x"},"\\u0061":{"command":"y"}}}'), invalid, 'one server name twice, however spelled');
  // A key repeated deeper in (a server's env) names nothing SERVER_NAMES reads, and a string holding braces or quotes is no structure.
  assert.deepEqual(execCodes('mcp-server', '{"mcpServers":{"a":{"env":{"K":"1","K":"2"},"args":["{\\"mcpServers\\":","}"]}},"b":1}'), ['info:exec.runs_code']);
  // 1000 levels deep is what SQLite reads; one more and it reads no names at all.
  const nest = (levels: number) => `{"mcpServers":{"a":{"args":${'['.repeat(levels - 3)}${']'.repeat(levels - 3)}}}}`;
  assert.deepEqual(execCodes('mcp-server', nest(1000)), ['info:exec.runs_code']);
  assert.deepEqual(execCodes('mcp-server', nest(1001)), invalid);
});
