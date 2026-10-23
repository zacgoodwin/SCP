import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { strToU8, zipSync } from 'fflate';
import { listenLocal, makeTestCtx, type TestCtx } from './helpers.ts';
import { buildZip } from '../src/lib/zip.ts';
import { sha256Hex } from '../src/lib/crypto.ts';
import { HttpError } from '../src/lib/http.ts';
import { ZIPBALL_SLOTS, parseGithubSource, withZipballSlot } from '../src/imports/github.ts';
import { ARTIFACT_FROM_TREE, detectUnits, subtree, unpack } from '../src/imports/pack.ts';
import { UNDOUBLE_SOURCE_PATHS } from '../src/db.ts';

const API = '/api/v1';
type H = Record<string, string>;
type Files = Record<string, string>;

const skill = (name: string, desc = `Does ${name} things.`) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nBody.\n`;
const AGENT = '---\nname: reviewer\ndescription: Reviews pull requests.\n---\nYou review code.\n';
const PLUGIN: Files = {
  '.claude-plugin/plugin.json': '{"name":"kit"}',
  'skills/pdf/SKILL.md': skill('pdf'),
  'skills/pdf/scripts/run.sh': '#!/bin/sh\necho hi\n',
  'skills/broken/SKILL.md': '---\nname: broken\n---\nno description\n',
  'agents/reviewer.md': AGENT,
  'commands/ship.md': 'Ship it.\n',
  'README.md': '# Kit\n',
  '.github/workflows/ci.yml': 'on: push\n',
};
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_HUGE = 'f'.repeat(40);
/** The fake serves a zipball by sha across every repo, so a repo with its own tree needs its own shas. */
const sha = (ch: string) => ch.repeat(40);
/** More unique shas: a two-hex-digit pattern, so 'a0' never collides with SHA_A. */
const sha2 = (pair: string) => pair.repeat(20);
/** A Files value that is a symlink to `target` (fake zipballs and pack()). */
const LINK = '\u0000symlink:';
const link = (target: string) => LINK + target;
/** A Files value that is a git submodule (a mode 160000 tree entry; `git archive` leaves it out of the zipball). */
const SUBMODULE = '\u0000submodule';
/** Incompressible text of about `mb` MB, so a fake zipball or pack really is that large. */
const noise = (mb: number) => randomBytes(Math.ceil(mb * 786432)).toString('base64');
const zipEntry = (text: string): Uint8Array | [Uint8Array, { os: number; attrs: number }] =>
  text.startsWith(LINK) ? [strToU8(text.slice(LINK.length)), { os: 3, attrs: (0o120777 << 16) >>> 0 }] : strToU8(text);

interface Repo {
  default_branch: string;
  refs: Record<string, string>;
  trees: Record<string, Files>;
  private?: boolean;
}

const sha1 = (...parts: (string | Uint8Array)[]) => parts.reduce((h, p) => h.update(p), createHash('sha1')).digest('hex');

/**
 * A node:http stand-in for api.github.com: repo metadata, commit resolution, zipballs behind a
 * redirect, and the Git Data API (git/trees, git/blobs) over the same trees. Tree ids are the sha1 of
 * '<commit>:<dir>', blob ids the real git object id. `quota.remaining`, when set, is sent as
 * x-ratelimit-remaining on tree listings.
 */
async function fakeGithub() {
  const repos: Record<string, Repo> = {};
  const requests: { url: string; headers: IncomingHttpHeaders }[] = [];
  const quota: { remaining: number | null } = { remaining: null };
  const treeIds = new Map<string, { files: Files; dir: string }>();
  const blobs = new Map<string, Uint8Array>();
  const entry = (rel: string, text: string) => {
    if (text === SUBMODULE) return { path: rel, mode: '160000', type: 'commit', sha: sha1('submodule', rel) };
    const bytes = strToU8(text.startsWith(LINK) ? text.slice(LINK.length) : text);
    const id = sha1(`blob ${bytes.length}\0`, bytes);
    blobs.set(id, bytes);
    return { path: rel, mode: text.startsWith(LINK) ? '120000' : rel.endsWith('.sh') ? '100755' : '100644', type: 'blob', sha: id, size: bytes.length };
  };
  const listing = (files: Files, commit: string, dir: string, recursive: boolean) => {
    const prefix = dir ? dir + '/' : '';
    const out = new Map<string, object>();
    for (const [p, text] of Object.entries(files)) {
      if (!p.startsWith(prefix)) continue;
      const segs = p.slice(prefix.length).split('/');
      for (let i = 1; i <= (recursive ? segs.length : 1); i++) {
        const rel = segs.slice(0, i).join('/');
        if (i === segs.length) out.set(rel, entry(rel, text));
        else if (!out.has(rel)) {
          const id = sha1(`${commit}:${prefix}${rel}`);
          treeIds.set(id, { files, dir: prefix + rel });
          out.set(rel, { path: rel, mode: '040000', type: 'tree', sha: id });
        }
      }
    }
    return [...out.values()];
  };
  const server = createServer((req, res) => {
    requests.push({ url: req.url!, headers: req.headers });
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const git = /^\/repos\/[^/]+\/[^/]+\/git\/(trees|blobs)\/([0-9a-f]{40})(\?recursive=1)?$/.exec(req.url!);
    if (git) {
      if (git[1] === 'blobs') {
        const bytes = blobs.get(git[2]);
        return bytes ? res.writeHead(200, { 'content-type': 'application/vnd.github.raw' }).end(bytes) : json(404, { message: 'Not Found' });
      }
      // A commit sha lists its root tree, as on GitHub.
      const owner = Object.values(repos).find((r) => r.trees[git[2]]);
      const at = owner ? { files: owner.trees[git[2]], dir: '' } : treeIds.get(git[2]);
      if (!at) return json(404, { message: 'Not Found' });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (quota.remaining !== null) headers['x-ratelimit-remaining'] = String(quota.remaining);
      return res.writeHead(200, headers).end(JSON.stringify({ sha: git[2], tree: listing(at.files, git[2], at.dir, !!git[3]), truncated: false }));
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(?:\/(commits|zipball)\/(.+))?$/.exec(req.url!);
    const zip = /^\/zip\/([0-9a-f]{40})$/.exec(req.url!);
    if (zip) {
      if (zip[1] === SHA_HUGE) {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.on('error', () => {});
        const chunk = new Uint8Array(1024 * 1024);
        let n = 0;
        // Exactly 40 MiB: every write counts, the one that fills the buffer included.
        const pump = () => {
          while (n < 40) {
            n++;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        pump();
        return;
      }
      const owner = Object.values(repos).find((r) => r.trees[zip[1]]);
      if (!owner) return json(404, { message: 'Not Found' });
      const files = owner.trees[zip[1]];
      // Like `git archive`: a symlink is a mode 120000 entry holding its target; a submodule is left out.
      const bytes = buildZip(
        Object.entries(files).filter(([, text]) => text !== SUBMODULE).map(([path, text]) => ({
          path: `owner-repo-${zip[1].slice(0, 7)}/${path}`,
          bytes: strToU8(text.startsWith(LINK) ? text.slice(LINK.length) : text),
          mode: text.startsWith(LINK) ? 0o120777 : path.endsWith('.sh') ? 493 : 420,
        })),
      );
      return res.writeHead(200, { 'content-type': 'application/zip' }).end(bytes);
    }
    // GitHub's quota exhausted: 403 with the rate-limit headers (the anonymous 60/h, or the token's 5,000/h).
    if (m && m[1] === 'acme/quota') {
      res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) });
      return res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
    }
    // Like GitHub: names resolve case-insensitively and the metadata carries the canonical spelling.
    const key = m && Object.keys(repos).find((k) => k.toLowerCase() === m[1].toLowerCase());
    const repo = key ? repos[key] : undefined;
    if (!m || !repo) return json(404, { message: 'Not Found' });
    if (!m[2]) return json(200, { full_name: key, default_branch: repo.default_branch, private: !!repo.private });
    if (m[2] === 'commits') {
      const sha = repo.refs[m[3]] ?? Object.keys(repo.trees).find((s) => s.startsWith(m[3]));
      return sha ? json(200, { sha }) : json(422, { message: 'No commit found' });
    }
    return res.writeHead(302, { location: `/zip/${m[3]}` }).end();
  });
  const base = `http://127.0.0.1:${await listenLocal(server)}`;
  return { base, repos, requests, server, quota };
}

const gh = await fakeGithub();
after(() => {
  gh.server.closeAllConnections();
  gh.server.close();
});

function setup(env: Record<string, string> = {}) {
  const t = makeTestCtx({ SCP_GITHUB_API: gh.base, ...env });
  const u = t.createUser();
  return { t, u, h: t.key(u).headers };
}

const github = (t: TestCtx, h: H, json: unknown) => t.req('POST', `${API}/items/import/github`, { headers: h, json });

/** `files` may be prebuilt zip bytes, so one archive can be uploaded twice byte for byte. */
function pack(t: TestCtx, h: H, filename: string, files: Files | Uint8Array, fields: Record<string, string> = {}) {
  const fd = new FormData();
  const zip = files instanceof Uint8Array ? files : zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, zipEntry(v)])));
  fd.set('file', new File([zip as Uint8Array<ArrayBuffer>], filename));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return t.req('POST', `${API}/items/import/pack`, { headers: h, body: fd });
}

const names = (items: { kind: string; name: string }[]) => items.map((i) => `${i.kind}:${i.name}`).sort();
const tree = (files: Files) => Object.entries(files).map(([path, text]) => ({ path, bytes: strToU8(text), mode: 420 }));

test('parseGithubSource: url forms, repo/ref/path fields, and what is refused', () => {
  assert.deepEqual(parseGithubSource({ url: 'https://github.com/anthropics/skills' }), { repo: 'anthropics/skills', ref: null, path: null });
  assert.deepEqual(parseGithubSource({ url: 'https://github.com/o/r.git/' }), { repo: 'o/r', ref: null, path: null });
  assert.deepEqual(parseGithubSource({ url: 'https://github.com/o/r/tree/main/skills/pdf' }), { repo: 'o/r', ref: 'main', path: 'skills/pdf' });
  assert.deepEqual(parseGithubSource({ url: 'https://github.com/o/r/tree/v1.2' }), { repo: 'o/r', ref: 'v1.2', path: null });
  assert.deepEqual(parseGithubSource({ url: 'https://github.com/o/r/blob/main/skills/pdf/SKILL.md' }), { repo: 'o/r', ref: 'main', path: 'skills/pdf' });
  assert.deepEqual(parseGithubSource({ url: 'https://github.com/o/r/blob/main/CLAUDE.md' }), { repo: 'o/r', ref: 'main', path: null });
  assert.deepEqual(parseGithubSource({ repo: ' o/r ', ref: 'abc1234', path: '/skills/' }), { repo: 'o/r', ref: 'abc1234', path: 'skills' });
  for (const bad of [
    { url: 'https://evil.com/o/r' },
    { url: 'https://github.com/o' },
    { url: 'https://github.com/o/r/pulls/1' },
    { url: 'not a url' },
    { repo: 'o' },
    { repo: 'o/r/x' },
    { repo: '../r' },
    { repo: 'o/r?x=1' },
    { repo: 'o/r', ref: 'a..b' },
    { repo: 'o/r', ref: 'x y' },
    { repo: 'o/r', ref: '/main' },
    { repo: 'o/r', path: '../etc' },
    { repo: 'o/r', path: 'a\\b' },
    {},
  ]) {
    assert.throws(() => parseGithubSource(bad), { code: 'bad_source' }, JSON.stringify(bad));
  }
});

test('parseGithubSource: www., scheme-less and http: GitHub URLs parse like the canonical one; other hosts are still refused', () => {
  const canonical = parseGithubSource({ url: 'https://github.com/o/r' });
  for (const url of ['github.com/o/r', 'www.github.com/o/r', 'https://www.github.com/o/r', 'http://github.com/o/r', 'HTTP://WWW.GitHub.com/o/r/', ' github.com/o/r.git ']) {
    assert.deepEqual(parseGithubSource({ url }), canonical, url);
  }
  assert.deepEqual(parseGithubSource({ url: 'https://www.github.com/o/r/tree/main/skills' }), parseGithubSource({ url: 'https://github.com/o/r/tree/main/skills' }));
  assert.deepEqual(parseGithubSource({ url: 'github.com/o/r/blob/v1/skills/pdf/SKILL.md' }), { repo: 'o/r', ref: 'v1', path: 'skills/pdf' });
  for (const url of ['https://gitlab.com/o/r', 'https://github.com.evil.example/o/r', 'https://raw.githubusercontent.com/o/r/main/x', 'https://gist.github.com/o/r', 'github.com.evil.example/o/r', 'ftp://github.com/o/r', 'http://www.github.com.evil.example/o/r']) {
    assert.throws(() => parseGithubSource({ url }), { code: 'bad_source' }, url);
  }
});

test('detectUnits: plugin, .claude, nested SKILL.md, root skill, root docs, md-only fallback', () => {
  const plugin = detectUnits(tree(PLUGIN), 'kit');
  assert.deepEqual(plugin.units.map((u) => [u.kind, u.path]), [
    ['skill', 'skills/pdf'],
    ['skill', 'skills/broken'],
    ['agent', 'agents/reviewer.md'],
    ['command', 'commands/ship.md'],
  ]);
  const pdf = plugin.units[0];
  assert.deepEqual(pdf.tree.map((f) => f.path).sort(), ['SKILL.md', 'scripts/run.sh']);
  assert.equal(pdf.folderName, 'pdf');
  assert.equal(plugin.units[3].name, 'ship');
  assert.deepEqual(plugin.skipped, []);

  const dot = detectUnits(tree({ '.claude/skills/a/SKILL.md': skill('a'), '.claude/agents/x.md': AGENT, '.claude/commands/go.md': 'go', 'src/index.ts': '' }), 'repo');
  assert.deepEqual(dot.units.map((u) => [u.kind, u.path]), [['skill', '.claude/skills/a'], ['agent', '.claude/agents/x.md'], ['command', '.claude/commands/go.md']]);

  // A skill keeps a nested example skill; sibling folders become their own skills.
  const nested = detectUnits(tree({ 'x/SKILL.md': skill('x'), 'x/examples/mini/SKILL.md': skill('mini'), 'y/z/SKILL.md': skill('z') }), 'repo');
  assert.deepEqual(nested.units.map((u) => u.path), ['x', 'y/z']);
  assert.deepEqual(nested.units[0].tree.map((f) => f.path).sort(), ['SKILL.md', 'examples/mini/SKILL.md']);

  const root = detectUnits(tree({ 'SKILL.md': skill('solo'), 'scripts/a.sh': '', 'README.md': '# r', 'CLAUDE.md': '# Rules', 'DESIGN.md': '## Colors' }), 'solo-repo');
  assert.deepEqual(root.units.map((u) => [u.kind, u.path]), [['instructions', 'CLAUDE.md'], ['design', 'DESIGN.md'], ['skill', '']]);
  assert.equal(root.units[2].folderName, 'solo-repo');
  assert.deepEqual(root.units[2].tree.map((f) => f.path).sort(), ['README.md', 'SKILL.md', 'scripts/a.sh']);

  const md = detectUnits(tree({ 'summarize.md': 'Summarize {{text}}', 'reviewer.md': AGENT, 'README.md': '# docs', 'LICENSE.md': 'MIT' }), 'prompts');
  assert.deepEqual(md.units.map((u) => [u.kind, u.path]), [['prompt', 'summarize.md'], ['agent', 'reviewer.md']]);
  assert.deepEqual(md.skipped.map((s) => s.path), ['README.md', 'LICENSE.md']);

  assert.deepEqual(detectUnits(tree({ 'src/a.ts': '', 'README.md': '' }), 'code').units, []);
  assert.deepEqual(subtree(tree({ 'a/b.md': '1', 'a/c/d.md': '2', 'x.md': '3' }), 'a').map((f) => f.path), ['b.md', 'c/d.md']);
  assert.deepEqual(subtree(tree({ 'a/b.md': '1' }), 'a/b.md').map((f) => f.path), ['b.md']);

  // md-only fallback re-homes design.md to its entry path, like the single-file import does. A root skill.md in any
  // case is the root skill, the same unit SKILL.md makes (README: "skill.md in any case counts"), whatever else is there.
  const rehomed = detectUnits(tree({ 'docs/design.md': '# Brand\n', 'notes.md': 'n' }), 'x');
  assert.deepEqual(rehomed.units.map((u) => [u.kind, u.path, u.tree[0].path]), [['design', 'docs/design.md', 'DESIGN.md'], ['prompt', 'notes.md', 'notes.md']]);
  const lower = detectUnits(tree({ 'skill.md': skill('tools'), 'scripts/run.py': 'print(1)', 'notes.md': 'n' }), 'x');
  assert.deepEqual(lower.units.map((u) => [u.kind, u.path]), [['skill', '']]);
  assert.deepEqual(lower.units[0].tree.map((f) => f.path).sort(), ['SKILL.md', 'notes.md', 'scripts/run.py'], 'the entry is re-homed to SKILL.md');
  // A tree re-rooted at a layout folder (GitHub path=.claude/commands): its loose .md files are that kind, named by file.
  const hinted = detectUnits(tree({ 'ship.md': 'Ship it.\n', 'review.md': AGENT }), 'commands', { layoutDir: 'commands' });
  assert.deepEqual(hinted.units.map((u) => [u.kind, u.path, u.name]), [['command', 'ship.md', 'ship'], ['command', 'review.md', 'review']]);
  assert.deepEqual(detectUnits(tree({ 'x.md': AGENT }), 'agents', { layoutDir: 'agents' }).units.map((u) => [u.kind, u.name]), [['agent', undefined]]);
  assert.deepEqual(detectUnits(tree({ 'x.md': 'p' }), 'docs', { layoutDir: 'docs' }).units.map((u) => u.kind), ['prompt'], 'no hint from other folders');
  // unpack strips a lone wrapper folder unless it is the layout itself.
  const zipOf = (files: Files) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  const wrapped = unpack(zipOf({ 'wrap/SKILL.md': 'x' }));
  assert.deepEqual([wrapped.top, wrapped.files.map((f) => f.path)], ['wrap', ['SKILL.md']]);
  for (const dir of ['commands', 'agents', 'prompts', 'skills', '.claude', '.claude-plugin']) {
    const u = unpack(zipOf({ [`${dir}/a.md`]: 'x' }));
    assert.deepEqual([u.top, u.files.map((f) => f.path)], [null, [`${dir}/a.md`]], dir);
  }
});

test('pack import: items, group, provenance, skipped lint failures, one audit row per unit', async () => {
  const { t, u, h } = setup();
  const r = await pack(t, h, 'My Kit.zip', PLUGIN, { group: 'kit', visibility: 'public' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['agent:reviewer', 'command:ship', 'skill:pdf']);
  assert.deepEqual(r.json.skipped, [{ path: 'skills/broken', reason: 'frontmatter description is required' }]);
  assert.equal(r.json.group.slug, 'kit');
  assert.equal(r.json.group.name, 'My Kit');
  assert.equal(r.json.group.owner.username, u.username);
  assert.deepEqual(r.json.group.members.map((m: { item: { name: string } }) => m.item.name).sort(), ['pdf', 'reviewer', 'ship']);
  assert.equal(r.json.source.kind, 'zip');
  assert.equal(r.json.source.repo, 'My Kit.zip');
  assert.match(r.json.source.commit, /^[0-9a-f]{64}$/);
  const pdf = r.json.items.find((i: { name: string }) => i.name === 'pdf');
  assert.deepEqual(pdf.source, { kind: 'zip', repo: 'My Kit.zip', ref: null, path: 'skills/pdf', commit: r.json.source.commit });
  assert.equal(pdf.visibility, 'public');
  assert.equal(pdf.version.note, 'import zip My Kit.zip');
  assert.deepEqual(pdf.version.files.map((f: { path: string }) => f.path), ['SKILL.md', 'scripts/run.sh']);
  assert.equal(r.json.items.find((i: { name: string }) => i.name === 'ship').source.path, 'commands/ship.md');
  const actions = (t.db.prepare('SELECT action FROM audit ORDER BY id').all() as { action: string }[]).map((a) => a.action);
  assert.deepEqual(actions, ['item.create', 'item.create', 'item.create', 'group.create']);
  // Nothing of the skipped unit survived.
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 3);
});

test('pack import: wrapper folder stripped, root skill named after it, md-only pack, nothing to import', async () => {
  const { t, h } = setup();
  const one = await pack(t, h, 'x.zip', { 'pdf-tools/SKILL.md': skill('pdf-tools'), 'pdf-tools/ref.md': 'ref' });
  assert.equal(one.status, 201, one.text);
  assert.deepEqual(names(one.json.items), ['skill:pdf-tools']);
  assert.equal(one.json.items[0].source.path, null);
  assert.deepEqual(one.json.items[0].version.files.map((f: { path: string }) => f.path), ['SKILL.md', 'ref.md']);
  const md = await pack(t, h, 'prompts.zip', { 'a.md': 'A {{x}}', 'README.md': 'docs' });
  assert.equal(md.status, 201, md.text);
  assert.deepEqual(names(md.json.items), ['prompt:a']);
  assert.deepEqual(md.json.skipped, [{ path: 'README.md', reason: 'repository documentation, not an item' }]);
  // A loose design.md lands at its entry path instead of being skipped for "needs DESIGN.md at the root".
  const loose = await pack(t, h, 'loose.zip', { 'docs/design.md': '# Brand\n', 'notes.md': 'n' });
  assert.equal(loose.status, 201, loose.text);
  assert.deepEqual(names(loose.json.items), ['design:brand', 'prompt:notes']);
  assert.deepEqual(loose.json.skipped, []);
  assert.equal(loose.json.items.find((i: { kind: string }) => i.kind === 'design').version.entryPath, 'DESIGN.md');
  // A zipped skill folder whose entry is lowercase skill.md imports as one skill, non-.md files and all (README: "skill.md in any case").
  const lower = await pack(t, h, 'my-skill.zip', { 'my-skill/skill.md': skill('my-skill'), 'my-skill/scripts/run.py': 'print(1)' });
  assert.equal(lower.status, 201, lower.text);
  assert.deepEqual(names(lower.json.items), ['skill:my-skill']);
  assert.deepEqual(lower.json.items[0].version.files.map((f: { path: string }) => f.path), ['SKILL.md', 'scripts/run.py']);
  assert.equal(lower.json.items[0].version.entryPath, 'SKILL.md');
  const none = await pack(t, h, 'code.zip', { 'src/a.ts': 'x', 'package.json': '{}' });
  assert.equal(none.status, 400);
  assert.equal(none.json.error.code, 'nothing_to_import');
  const noFile = await t.req('POST', `${API}/items/import/pack`, { headers: h, body: new FormData() });
  assert.equal(noFile.status, 400);
  const badZip = new FormData();
  badZip.set('file', new File([strToU8('not a zip') as Uint8Array<ArrayBuffer>], 'x.zip'));
  assert.equal((await t.req('POST', `${API}/items/import/pack`, { headers: h, body: badZip })).status, 400);
});

test('pack import: a commands-only zip keeps its layout folder; a GitHub path at a layout folder names the kind', async () => {
  const { t, h } = setup();
  const cmds = await pack(t, h, 'commands.zip', { 'commands/ship.md': 'Ship it.\n', 'commands/review.md': AGENT });
  assert.equal(cmds.status, 201, cmds.text);
  assert.deepEqual(names(cmds.json.items), ['command:review', 'command:ship']);
  assert.deepEqual(cmds.json.skipped, []);
  assert.deepEqual(cmds.json.items.map((i: { source: { path: string } }) => i.source.path).sort(), ['commands/review.md', 'commands/ship.md']);
  const prompts = await pack(t, h, 'p.zip', { 'prompts/a.md': 'A', 'prompts/b.md': AGENT });
  assert.deepEqual(names(prompts.json.items), ['prompt:a', 'prompt:b']);
  gh.repos['acme/cmds'] = { default_branch: 'main', refs: { main: sha('1') }, trees: { [sha('1')]: { '.claude/commands/go.md': 'go', '.claude/commands/check.md': AGENT, 'README.md': '# r' } } };
  const t2 = setup();
  const r = await github(t2.t, t2.h, { repo: 'acme/cmds', path: '.claude/commands' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['command:check', 'command:go']);
  assert.deepEqual(r.json.items.map((i: { source: { path: string } }) => i.source.path).sort(), ['.claude/commands/check.md', '.claude/commands/go.md']);
});

test('pack import: group slug taken rolls the whole import back; too many items; restricted and read-only keys', async () => {
  const { t, u, h } = setup();
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'kit', name: 'Kit' } })).status, 201);
  const r = await pack(t, h, 'kit.zip', PLUGIN, { group: 'kit' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'slug_taken');
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 0);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'item.%'").get() as { n: number }).n, 0);
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`prompts/p${i}.md`, 'x']));
  const big = await pack(t, h, 'many.zip', many);
  assert.equal(big.status, 400);
  assert.equal(big.json.error.code, 'too_many_items');
  const g = t.db.prepare('SELECT id FROM scp_groups WHERE slug = ?').get('kit') as { id: string };
  const rk = await pack(t, t.key(u, { groupIds: [g.id] }).headers, 'kit.zip', PLUGIN);
  assert.equal(rk.status, 403);
  assert.equal(rk.json.error.code, 'restricted_key');
  assert.equal((await pack(t, t.key(u, { scopes: ['read'] }).headers, 'kit.zip', PLUGIN)).status, 403);
  // Same-origin (CSRF passes) but no session or key.
  assert.equal((await pack(t, { Origin: t.config.publicUrl }, 'kit.zip', PLUGIN)).status, 401);
});

test('github import: url -> pinned commit, provenance, note, group named after the repo, path subtree', async () => {
  gh.repos['acme/kit'] = { default_branch: 'main', refs: { main: SHA_A, 'v1.0': SHA_A }, trees: { [SHA_A]: PLUGIN } };
  const { t, h } = setup();
  const r = await github(t, h, { url: 'https://github.com/acme/kit', group: 'acme-kit' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['agent:reviewer', 'command:ship', 'skill:pdf']);
  assert.deepEqual(r.json.source, { kind: 'github', repo: 'acme/kit', ref: 'main', path: null, commit: SHA_A });
  assert.equal(r.json.group.name, 'acme/kit');
  assert.equal(r.json.group.members.length, 3);
  const pdf = r.json.items.find((i: { name: string }) => i.name === 'pdf');
  assert.deepEqual(pdf.source, { kind: 'github', repo: 'acme/kit', ref: 'main', path: 'skills/pdf', commit: SHA_A });
  assert.equal(pdf.version.note, 'import github acme/kit@aaaaaaa');
  assert.equal(pdf.version.files.find((f: { path: string }) => f.path === 'scripts/run.sh').mode, 493, 'zipball modes survive');
  assert.deepEqual(r.json.skipped.map((s: { path: string }) => s.path), ['skills/broken']);

  // A tree URL imports only that folder; the folder name becomes the root name and the note carries the path.
  const t2 = setup();
  const sub = await github(t2.t, t2.h, { url: 'https://github.com/acme/kit/tree/v1.0/skills/pdf' });
  assert.equal(sub.status, 201, sub.text);
  assert.deepEqual(names(sub.json.items), ['skill:pdf']);
  assert.deepEqual(sub.json.items[0].source, { kind: 'github', repo: 'acme/kit', ref: 'v1.0', path: 'skills/pdf', commit: SHA_A });
  assert.equal(sub.json.items[0].version.note, 'import github acme/kit@aaaaaaa skills/pdf');
  assert.equal(sub.json.group, null);
  // kind + name override: the subtree is one item of that kind.
  const forced = await github(t2.t, t2.h, { repo: 'acme/kit', path: 'skills/pdf', kind: 'package', name: 'pdf-pack' });
  assert.equal(forced.status, 201, forced.text);
  assert.deepEqual(names(forced.json.items), ['package:pdf-pack']);
  const multi = await github(t2.t, t2.h, { repo: 'acme/kit', name: 'x' });
  assert.equal(multi.status, 400);
  const gone = await github(t2.t, t2.h, { repo: 'acme/kit', path: 'nope' });
  assert.equal(gone.status, 400);
  assert.equal(gone.json.error.code, 'bad_source');
});

test('github import: re-import updates in place, unchanged content adds no version, foreign name clash is skipped', async () => {
  gh.repos['acme/again'] = { default_branch: 'main', refs: { main: SHA_A }, trees: { [SHA_A]: PLUGIN, [SHA_B]: { ...PLUGIN, 'skills/pdf/SKILL.md': skill('pdf', 'Better.') } } };
  const { t, h } = setup();
  // An unrelated local item already owns the agent's name.
  assert.equal((await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'agent', content: AGENT } })).status, 201);
  const first = await github(t, h, { repo: 'acme/again' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(names(first.json.items), ['command:ship', 'skill:pdf']);
  assert.deepEqual(first.json.skipped.map((s: { path: string; reason: string }) => [s.path, /name_taken|already have/.test(s.reason)]), [['skills/broken', false], ['agents/reviewer.md', true]]);
  const pdfId = first.json.items.find((i: { name: string }) => i.name === 'pdf').id;

  const same = await github(t, h, { repo: 'acme/again' });
  assert.equal(same.status, 201, same.text);
  const samePdf = same.json.items.find((i: { name: string }) => i.name === 'pdf');
  assert.equal(samePdf.id, pdfId);
  assert.equal(samePdf.latestSeq, 1, 'identical content adds no version');

  gh.repos['acme/again'].refs.main = SHA_B;
  const next = await github(t, h, { repo: 'acme/again' });
  assert.equal(next.status, 201, next.text);
  const pdf2 = next.json.items.find((i: { name: string }) => i.name === 'pdf');
  assert.equal(pdf2.id, pdfId);
  assert.equal(pdf2.latestSeq, 2);
  assert.equal(pdf2.description, 'Better.');
  assert.equal(pdf2.source.commit, SHA_B);
  const ship = next.json.items.find((i: { name: string }) => i.name === 'ship');
  assert.equal(ship.latestSeq, 1);
  assert.equal(ship.source.commit, SHA_B, 'an unchanged item still records the commit it matches');
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 3);
  const audit = (t.db.prepare("SELECT action, detail FROM audit WHERE target_id = ? ORDER BY id").all(pdfId) as { action: string; detail: string }[]);
  assert.deepEqual(audit.map((a) => a.action), ['item.create', 'item.version']);
  assert.equal(JSON.parse(audit[1].detail).via, 'github');
});

test('source/check and source/update: up to date, new commit, 409 up_to_date, sha ref never fetches, 404 cases', async () => {
  gh.repos['acme/live'] = { default_branch: 'main', refs: { main: SHA_A }, trees: { [SHA_A]: PLUGIN, [SHA_B]: { ...PLUGIN, 'skills/pdf/SKILL.md': skill('pdf', 'Better.') } } };
  const { t, u, h } = setup();
  const imp = await github(t, h, { url: 'https://github.com/acme/live/tree/main/skills/pdf' });
  assert.equal(imp.status, 201, imp.text);
  const id = imp.json.items[0].id;
  const check = (hh: H = h) => t.req('POST', `${API}/items/${id}/source/check`, { headers: hh });
  const update = (hh: H = h, json?: unknown) => t.req('POST', `${API}/items/${id}/source/update`, { headers: hh, json });

  let c = await check();
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(c.json, { source: imp.json.items[0].source, upToDate: true, latestCommit: SHA_A });
  let up = await update();
  assert.equal(up.status, 409);
  assert.equal(up.json.error.code, 'up_to_date');

  gh.repos['acme/live'].refs.main = SHA_B;
  c = await check();
  assert.deepEqual([c.json.upToDate, c.json.latestCommit], [false, SHA_B]);
  up = await update(h, { note: 'pull upstream' });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.latestSeq, 2);
  assert.equal(up.json.item.description, 'Better.');
  assert.equal(up.json.item.source.commit, SHA_B);
  assert.equal(up.json.item.version.note, 'pull upstream');
  assert.equal((await check()).json.upToDate, true);
  const actions = (t.db.prepare('SELECT action, detail FROM audit WHERE target_id = ? ORDER BY id').all(id) as { action: string; detail: string }[]);
  assert.deepEqual(actions.map((a) => a.action), ['item.create', 'item.source_check', 'item.source_check', 'item.version', 'item.source_check']);
  assert.equal(JSON.parse(actions[3].detail).via, 'github');

  // Same content at a newer commit: no version, 409, but the item now records that commit.
  const SHA_C = 'c'.repeat(40);
  gh.repos['acme/live'].trees[SHA_C] = gh.repos['acme/live'].trees[SHA_B];
  gh.repos['acme/live'].refs.main = SHA_C;
  up = await update();
  assert.equal(up.status, 409);
  const row = t.db.prepare('SELECT source_commit, latest_seq FROM items WHERE id = ?').get(id) as { source_commit: string; latest_seq: number };
  assert.deepEqual({ ...row }, { source_commit: SHA_C, latest_seq: 2 });

  // A sha-pinned import is always up to date and never asks GitHub.
  const pinned = await github(t, h, { repo: 'acme/live', ref: SHA_A.slice(0, 7), path: 'commands' });
  assert.equal(pinned.status, 201, pinned.text);
  const before = gh.requests.length;
  const pc = await t.req('POST', `${API}/items/${pinned.json.items[0].id}/source/check`, { headers: h });
  assert.deepEqual([pc.json.upToDate, pc.json.latestCommit], [true, SHA_A]);
  assert.equal((await t.req('POST', `${API}/items/${pinned.json.items[0].id}/source/update`, { headers: h })).status, 409);
  assert.equal(gh.requests.length, before);

  // 404: a non-GitHub item, an unreadable item; 403: another user's public item, a read-only key.
  const local = await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'prompt', name: 'p', content: 'x' } });
  assert.equal((await t.req('POST', `${API}/items/${local.json.item.id}/source/check`, { headers: h })).status, 404);
  const other = t.key(t.createUser()).headers;
  assert.equal((await check(other)).status, 404);
  assert.equal((await t.req('PATCH', `${API}/items/${id}`, { headers: h, json: { visibility: 'public' } })).status, 200);
  assert.equal((await check(other)).status, 403);
  assert.equal((await update(other)).status, 403);
  assert.equal((await check(t.key(u, { scopes: ['read'] }).headers)).status, 403);
  assert.equal((await t.req('POST', `${API}/items/nope/source/check`, { headers: h })).status, 404);
});

test('github import: a group-restricted key is refused before anything is fetched', async () => {
  gh.repos['acme/rk'] = { default_branch: 'main', refs: { main: sha('2') }, trees: { [sha('2')]: { 'SKILL.md': skill('rk') } } };
  const { t, u, h } = setup();
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'gg', name: 'G' } })).status, 201);
  const g = t.db.prepare('SELECT id FROM scp_groups WHERE slug = ?').get('gg') as { id: string };
  const rk = t.key(u, { groupIds: [g.id] }).headers;
  const before = gh.requests.length;
  const r = await github(t, rk, { repo: 'acme/rk' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'restricted_key');
  assert.equal(gh.requests.length, before, 'no GitHub request left');
  assert.equal((await github(t, t.key(u, { scopes: ['read'] }).headers, { repo: 'acme/rk' })).status, 403);
  assert.equal(gh.requests.length, before);
});

test('source/update carves a root skill the way the import did; a skills/ folder keeps its subfolders; a renamed upstream unit is skipped', async () => {
  const ROOT: Files = { 'SKILL.md': skill('root-kit'), 'scripts/run.sh': 'echo', 'AGENTS.md': '# Rules\n', 'agents/x.md': AGENT, 'README.md': '# r\n' };
  gh.repos['acme/root'] = { default_branch: 'main', refs: { main: sha('3') }, trees: { [sha('3')]: ROOT, [sha('4')]: { ...ROOT, 'agents/x.md': AGENT.replace('You review code.', 'Harder.') } } };
  const { t, h } = setup();
  const imp = await github(t, h, { repo: 'acme/root' });
  assert.equal(imp.status, 201, imp.text);
  assert.deepEqual(names(imp.json.items), ['agent:reviewer', 'instructions:rules', 'skill:root-kit']);
  const sk = imp.json.items.find((i: { kind: string }) => i.kind === 'skill');
  const files = (it: { version: { files: { path: string }[] } }) => it.version.files.map((f) => f.path);
  assert.deepEqual(files(sk), ['README.md', 'SKILL.md', 'scripts/run.sh']);
  // A new commit touching only a sibling unit: the skill is still up to date and keeps its carved tree.
  gh.repos['acme/root'].refs.main = sha('4');
  const up = await t.req('POST', `${API}/items/${sk.id}/source/update`, { headers: h });
  assert.equal(up.status, 409, up.text);
  assert.equal(up.json.error.code, 'up_to_date');
  const after = await t.req('GET', `${API}/items/${sk.id}`, { headers: h });
  assert.equal(after.json.item.latestSeq, 1);
  assert.deepEqual(files(after.json.item), ['README.md', 'SKILL.md', 'scripts/run.sh']);
  assert.equal(after.json.item.source.commit, sha('4'));

  // A skill imported as a skills/<name>/ folder keeps a prompts/ subfolder that root detection would carve out.
  const FOLDER: Files = { 'skills/pdf/SKILL.md': skill('pdf'), 'skills/pdf/prompts/ref.md': 'ref' };
  gh.repos['acme/folder'] = { default_branch: 'main', refs: { main: sha('5') }, trees: { [sha('5')]: FOLDER, [sha('6')]: { ...FOLDER, 'skills/pdf/SKILL.md': skill('pdf', 'Better.') } } };
  const t2 = setup();
  const f1 = await github(t2.t, t2.h, { repo: 'acme/folder' });
  assert.equal(f1.status, 201, f1.text);
  assert.deepEqual(files(f1.json.items[0]), ['SKILL.md', 'prompts/ref.md']);
  gh.repos['acme/folder'].refs.main = sha('6');
  const up2 = await t2.t.req('POST', `${API}/items/${f1.json.items[0].id}/source/update`, { headers: t2.h });
  assert.equal(up2.status, 200, up2.text);
  assert.equal(up2.json.item.latestSeq, 2);
  assert.deepEqual(files(up2.json.item), ['SKILL.md', 'prompts/ref.md']);

  // Upstream renames agent foo to bar while an unrelated local agent bar exists: skipped, foo untouched.
  const foo = (name: string) => `---\nname: ${name}\ndescription: Agent.\n---\nbody\n`;
  gh.repos['acme/rename'] = { default_branch: 'main', refs: { main: sha('7') }, trees: { [sha('7')]: { 'agents/x.md': foo('foo') }, [sha('8')]: { 'agents/x.md': foo('bar') } } };
  const t3 = setup();
  assert.equal((await t3.t.req('POST', `${API}/items`, { headers: t3.h, json: { kind: 'agent', content: foo('bar') } })).status, 201);
  const r1 = await github(t3.t, t3.h, { repo: 'acme/rename' });
  assert.deepEqual(names(r1.json.items), ['agent:foo']);
  gh.repos['acme/rename'].refs.main = sha('8');
  const r2 = await github(t3.t, t3.h, { repo: 'acme/rename' });
  assert.equal(r2.status, 422, r2.text);
  assert.equal(r2.json.error.code, 'nothing_imported');
  assert.match(r2.json.error.details[0].reason, /already have an? agent named 'bar'/);
  const rows = t3.t.db.prepare("SELECT name, latest_seq FROM items WHERE kind = 'agent' ORDER BY name").all() as { name: string; latest_seq: number }[];
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ name: 'bar', latest_seq: 1 }, { name: 'foo', latest_seq: 1 }]);
});

test('github import: a folder of a repository over the per-version caps imports and updates; so does the whole repository, its units each held to the caps', async () => {
  const big: Files = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`src/f${i}.ts`, `export const f${i} = ${i};\n`]));
  const folder = (desc: string): Files => ({ ...big, 'skills/pdf/SKILL.md': skill('pdf', desc), 'skills/pdf/ref.md': 'ref\n' });
  gh.repos['acme/mono'] = { default_branch: 'main', refs: { main: sha2('90') }, trees: { [sha2('90')]: folder('v1'), [sha2('91')]: folder('v2') } };
  const { t, h } = setup();
  const r = await github(t, h, { url: 'https://github.com/acme/mono/tree/main/skills/pdf' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:pdf']);
  assert.deepEqual(r.json.items[0].version.files.map((f: { path: string }) => f.path), ['SKILL.md', 'ref.md']);
  gh.repos['acme/mono'].refs.main = sha2('91');
  const up = await t.req('POST', `${API}/items/${r.json.items[0].id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.latestSeq, 2);
  assert.equal(up.json.item.description, 'v2');
  // Without a path the archive is held to the pack caps, not a version's: 1001 source files beside the skill are not content.
  const t2 = setup();
  const whole = await github(t2.t, t2.h, { repo: 'acme/mono' });
  assert.equal(whole.status, 201, whole.text);
  assert.deepEqual(names(whole.json.items), ['skill:pdf'], whole.text);
  assert.deepEqual(whole.json.skipped, []);
  // A single unit over the per-version cap is the one that is refused, as a skip with the reason.
  const bigSkill: Files = { 'skills/tiny/SKILL.md': skill('tiny'), ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`skills/huge/ref${i}.md`, 'x'])), 'skills/huge/SKILL.md': skill('huge') };
  gh.repos['acme/mono2'] = { default_branch: 'main', refs: { main: sha2('92') }, trees: { [sha2('92')]: bigSkill } };
  const r3 = await github(t2.t, t2.h, { repo: 'acme/mono2' });
  assert.equal(r3.status, 201, r3.text);
  assert.deepEqual(names(r3.json.items), ['skill:tiny'], JSON.stringify(r3.json.skipped));
  assert.deepEqual(r3.json.skipped, [{ path: 'skills/huge', reason: 'at most 1000 files per version' }]);
});

test('github import: a private repository (reachable through the instance token) imports for admins only, and is refused like one that does not exist', async () => {
  gh.repos['acme/hidden'] = { default_branch: 'main', refs: { main: sha2('a0') }, trees: { [sha2('a0')]: { 'SKILL.md': skill('hidden') } }, private: true };
  const { t, h } = setup({ SCP_GITHUB_TOKEN: 'ghp_instance' });
  const before = gh.requests.length;
  const r = await github(t, h, { repo: 'acme/hidden' });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error.code, 'bad_source');
  assert.equal(gh.requests.length - before, 1, 'the repository metadata, nothing else');
  // GitHub hides private repositories behind a 404; so does SCP, or the instance token would let any account map the org's private repo names.
  const missing = await github(t, h, { repo: 'acme/hidden-not-there' });
  assert.equal(missing.status, 400);
  assert.equal(r.json.error.message, missing.json.error.message.replace('acme/hidden-not-there', 'acme/hidden'));
  assert.doesNotMatch(r.json.error.message, /private repository;|admins only/);
  assert.equal((await github(t, h, { repo: 'acme/hidden', ref: 'main', path: '' })).status, 400, 'an explicit ref too');
  const admin = t.key(t.createUser({ isAdmin: true })).headers;
  const ok = await github(t, admin, { repo: 'acme/hidden' });
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(names(ok.json.items), ['skill:hidden']);
});

test('github import: an artifact never comes from a tree; every unit skipped is 422 (with a group requested it creates nothing)', async () => {
  gh.repos['acme/art'] = { default_branch: 'main', refs: { main: sha2('b0') }, trees: { [sha2('b0')]: { 'index.html': '<h1>x</h1>' } } };
  const { t, h } = setup();
  const art = await github(t, h, { repo: 'acme/art', kind: 'artifact' });
  assert.equal(art.status, 400, art.text);
  assert.match(art.json.error.message, /single file/);
  const r = await pack(t, h, 'broken.zip', { 'skills/broken/SKILL.md': PLUGIN['skills/broken/SKILL.md'] }, { group: 'empty-kit' });
  assert.equal(r.status, 422, r.text);
  assert.equal(r.json.error.code, 'nothing_imported');
  assert.match(r.json.error.details[0].reason, /description is required/);
  assert.equal(r.json.error.details[0].path, 'skills/broken');
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM scp_groups').get() as { n: number }).n, 0);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM deleted_group_slugs').get() as { n: number }).n, 0, 'the slug is not burnt');
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'empty-kit', name: 'G' } })).status, 201);
  // Without a group too: a 201 with items: [] reads as success to any client branching on 2xx.
  const loose = await pack(t, h, 'broken2.zip', { 'skills/broken/SKILL.md': PLUGIN['skills/broken/SKILL.md'] });
  assert.equal(loose.status, 422, loose.text);
  assert.equal(loose.json.error.code, 'nothing_imported');
  assert.equal(loose.json.error.message, 'every unit was skipped');
  assert.deepEqual(loose.json.error.details.map((s: { path: string }) => s.path), ['skills/broken']);
});

test('source/update re-homes a loose design.md the way its import did; a lone skill.md is the root skill and updates at SKILL.md', async () => {
  const loose = (v: string): Files => ({ 'docs/design.md': `# Brand ${v}\n`, 'notes.md': `n ${v}\n` });
  gh.repos['acme/loose'] = { default_branch: 'main', refs: { main: sha2('e0') }, trees: { [sha2('e0')]: loose('v1'), [sha2('e1')]: loose('v2') } };
  const { t, h } = setup();
  const imp = await github(t, h, { repo: 'acme/loose' });
  assert.equal(imp.status, 201, imp.text);
  assert.deepEqual(names(imp.json.items), ['design:brand-v1', 'prompt:notes']);
  gh.repos['acme/loose'].refs.main = sha2('e1');
  for (const it of imp.json.items as { id: string; kind: string }[]) {
    const up = await t.req('POST', `${API}/items/${it.id}/source/update`, { headers: h });
    assert.equal(up.status, 200, `${it.kind}: ${up.text}`);
    assert.equal(up.json.item.latestSeq, 2, it.kind);
    if (it.kind === 'design') assert.deepEqual(up.json.item.version.files.map((f: { path: string }) => f.path), ['DESIGN.md']);
  }
  // A root skill.md in any case is the root skill (not a loose file among md files), stored and updated as SKILL.md.
  const lone = (v: string): Files => ({ 'skill.md': skill('tools', v), 'notes.md': `n ${v}\n` });
  gh.repos['acme/lone'] = { default_branch: 'main', refs: { main: sha2('e2') }, trees: { [sha2('e2')]: lone('v1'), [sha2('e3')]: lone('v2') } };
  const sk = await github(t, h, { repo: 'acme/lone' });
  assert.equal(sk.status, 201, sk.text);
  assert.deepEqual(names(sk.json.items), ['skill:tools']);
  const paths = (it: { version: { files: { path: string }[] } }) => it.version.files.map((f) => f.path);
  assert.deepEqual(paths(sk.json.items[0]), ['SKILL.md', 'notes.md']);
  gh.repos['acme/lone'].refs.main = sha2('e3');
  const up = await t.req('POST', `${API}/items/${sk.json.items[0].id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual(paths(up.json.item), ['SKILL.md', 'notes.md']);
  assert.equal(up.json.item.description, 'v2');
});

test('github token: env first, then the github.token setting, else no Authorization header', async () => {
  gh.repos['acme/tok'] = { default_branch: 'main', refs: { main: SHA_A }, trees: { [SHA_A]: { 'SKILL.md': skill('tok') } } };
  const auth = () => gh.requests.slice(-3).map((r) => r.headers.authorization ?? null);
  const plain = setup();
  assert.equal((await github(plain.t, plain.h, { repo: 'acme/tok' })).status, 201);
  assert.deepEqual(auth(), [null, null, null]);
  const set = setup();
  set.t.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('github.token', 'ghp_setting');
  assert.equal((await github(set.t, set.h, { repo: 'acme/tok' })).status, 201);
  assert.deepEqual(auth(), ['Bearer ghp_setting', 'Bearer ghp_setting', 'Bearer ghp_setting']);
  const env = setup({ SCP_GITHUB_TOKEN: 'ghp_env' });
  env.t.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('github.token', 'ghp_setting');
  assert.equal((await github(env.t, env.h, { repo: 'acme/tok' })).status, 201);
  assert.deepEqual(auth(), ['Bearer ghp_env', 'Bearer ghp_env', 'Bearer ghp_env']);
  for (const r of gh.requests.slice(-3)) assert.equal(r.headers['user-agent'], 'scp-import');
});

test('github errors: unknown repo or ref is bad_source, no request ever leaves for a non-GitHub host, oversize archive is 413', async () => {
  gh.repos['acme/err'] = { default_branch: 'main', refs: { main: SHA_A, huge: SHA_HUGE }, trees: { [SHA_A]: { 'SKILL.md': skill('err') } } };
  const { t, h } = setup();
  const before = gh.requests.length;
  for (const body of [{ url: 'https://gitlab.com/acme/err' }, { url: 'https://github.com/acme' }, { repo: 'acme/err', ref: '../main' }, { repo: 'acme/err', path: '../x' }]) {
    const r = await github(t, h, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.code, 'bad_source');
  }
  assert.equal(gh.requests.length, before, 'nothing contacted the API');
  const noRepo = await github(t, h, { repo: 'acme/nope' });
  assert.equal(noRepo.status, 400);
  assert.equal(noRepo.json.error.code, 'bad_source');
  const noRef = await github(t, h, { repo: 'acme/err', ref: 'ghost' });
  assert.equal(noRef.status, 400);
  assert.match(noRef.json.error.message, /acme\/err\/commits\/ghost/);
  assert.equal((await github(t, h, { json: 1 })).status, 400, 'zod');
  const huge = await github(t, h, { repo: 'acme/err', ref: 'huge' });
  assert.equal(huge.status, 413, huge.text);
  assert.equal(huge.json.error.code, 'too_large');
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 0);
  // An unreachable API origin is a 502, not a hang or a 500.
  const dead = makeTestCtx({ SCP_GITHUB_API: 'http://127.0.0.1:1' });
  const du = dead.createUser();
  const d = await github(dead, dead.key(du).headers, { repo: 'acme/err' });
  assert.equal(d.status, 502);
  assert.equal(d.json.error.code, 'github_error');
});

test('zip pack re-import: same file name and path adds a version; the zip hash is the commit', async () => {
  const { t, h } = setup();
  // Built once and uploaded as is: zipSync stamps the current time, so a rebuilt zip can differ by a second.
  const zipA = zipSync({ 'tools/SKILL.md': strToU8(skill('tools', 'v1')) });
  const a = await pack(t, h, 'tools.zip', zipA);
  assert.equal(a.status, 201, a.text);
  assert.equal(a.json.items[0].op, 'create');
  assert.equal(a.json.source.commit, sha256Hex(zipA));
  // Each item says what the import did to it, so the identical pack again does not read as "1 item imported".
  const same = await pack(t, h, 'tools.zip', zipA);
  assert.equal(same.status, 201, same.text);
  assert.equal(same.json.items[0].op, 'unchanged');
  assert.equal(same.json.items[0].latestSeq, 1);
  const b = await pack(t, h, 'tools.zip', { 'tools/SKILL.md': skill('tools', 'v2') });
  assert.equal(b.status, 201, b.text);
  assert.equal(b.json.items[0].id, a.json.items[0].id);
  assert.equal(b.json.items[0].op, 'version');
  assert.equal(b.json.items[0].latestSeq, 2);
  assert.equal(b.json.items[0].description, 'v2');
  assert.notEqual(b.json.items[0].source.commit, a.json.source.commit);
  // A different zip holding the same skill name is a clash, not an update, and the reason says which upload would be one.
  const c = await pack(t, h, 'other.zip', { 'tools/SKILL.md': skill('tools', 'v3') });
  assert.equal(c.status, 422, c.text);
  assert.equal(c.json.error.code, 'nothing_imported');
  assert.match(c.json.error.details[0].reason, /already have a skill named 'tools', imported from tools\.zip; upload the file under that name to update it/);
  // The same file name in another case is the same file on the disks it came from: an update.
  const d = await pack(t, h, 'Tools.zip', { 'tools/SKILL.md': skill('tools', 'v3') });
  assert.equal(d.status, 201, d.text);
  assert.equal(d.json.items[0].id, a.json.items[0].id);
  assert.equal(d.json.items[0].latestSeq, 3);
});

test('detectUnits reports what it passes over, takes skill.md in any case as a skill entry, and skips a README inside a layout folder', async () => {
  const mixed: Files = {
    'skills/alpha/SKILL.md': skill('alpha'),
    'skills/beta/skill.md': skill('beta'),
    'skills/beta/ref.md': 'ref',
    'skills/gamma/notes.md': 'no entry here',
    'agents/sub/deep.md': AGENT,
    'docs/guide.md': '# Guide',
    'commands/review.md': 'Review it.',
    'commands/README.md': '# Commands',
    'prompts/readme.md': '# Prompts',
    'README.md': '# Pack',
    'src/index.ts': '',
  };
  const d = detectUnits(tree(mixed), 'kit');
  assert.deepEqual(d.units.map((u) => [u.kind, u.path]), [['skill', 'skills/alpha'], ['skill', 'skills/beta'], ['command', 'commands/review.md']]);
  assert.deepEqual(d.units[1].tree.map((f) => f.path).sort(), ['SKILL.md', 'ref.md'], 'skill.md is re-homed to the entry path');
  assert.deepEqual(d.skipped, [
    { path: 'commands/README.md', reason: 'repository documentation, not an item' },
    { path: 'prompts/readme.md', reason: 'repository documentation, not an item' },
    { path: 'agents/sub/deep.md', reason: 'nested under agents/: only agents/*.md is imported' },
    { path: 'docs/guide.md', reason: 'not inside a recognised layout folder' },
    { path: 'skills/gamma', reason: 'no SKILL.md in this folder' },
  ]);
  const { t, h } = setup();
  const r = await pack(t, h, 'mixed.zip', mixed);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['command:review', 'skill:alpha', 'skill:beta']);
  assert.equal(r.json.items.find((i: { name: string }) => i.name === 'beta').version.entryPath, 'SKILL.md');
  assert.deepEqual(r.json.skipped.map((s: { path: string }) => s.path).sort(), ['agents/sub/deep.md', 'commands/README.md', 'docs/guide.md', 'prompts/readme.md', 'skills/gamma']);
  // Alone, the same folder imported already (through the md-only fallback); the two paths now agree.
  assert.deepEqual(names((await pack(t, h, 'lone.zip', { 'skills/beta/skill.md': skill('beta2') })).json.items), ['skill:beta2']);
});

test("a pack of 150 skills x 7 files is held to the pack caps, not a version's, and imports 150 items", async () => {
  const files: Files = {};
  for (let i = 0; i < 150; i++) {
    files[`skills/s${i}/SKILL.md`] = skill(`s${i}`);
    for (let j = 0; j < 6; j++) files[`skills/s${i}/ref${j}.md`] = `ref ${j}`;
  }
  const { t, h } = setup();
  const r = await pack(t, h, 'many.zip', files);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.items.length, 150);
  assert.deepEqual(r.json.skipped, []);
});

test('source/update at the same commit is up to date and keeps a local edit; the same zip re-uploaded after a local edit changes nothing', async () => {
  gh.repos['acme/same'] = { default_branch: 'main', refs: { main: sha2('d0') }, trees: { [sha2('d0')]: { 'SKILL.md': skill('same') } } };
  const { t, h } = setup();
  const imp = await github(t, h, { repo: 'acme/same' });
  assert.equal(imp.status, 201, imp.text);
  const id = imp.json.items[0].id;
  assert.equal((await t.req('POST', `${API}/items/${id}/versions`, { headers: h, json: { content: skill('same', 'Edited locally.') } })).status, 201);
  const up = await t.req('POST', `${API}/items/${id}/source/update`, { headers: h });
  assert.equal(up.status, 409, up.text);
  assert.equal(up.json.error.code, 'up_to_date');
  const again = await github(t, h, { repo: 'acme/same' });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.json.items[0].latestSeq, 2, 'the same commit re-imported adds nothing over the local edit');
  assert.equal(again.json.items[0].description, 'Edited locally.');
  // Zip: same bytes, same sha256, same answer.
  const bytes = zipSync({ 'tools/SKILL.md': strToU8(skill('tools')) });
  const a = await pack(t, h, 'tools.zip', bytes);
  assert.equal(a.status, 201, a.text);
  assert.equal((await t.req('POST', `${API}/items/${a.json.items[0].id}/versions`, { headers: h, json: { content: skill('tools', 'Local.') } })).status, 201);
  const b = await pack(t, h, 'tools.zip', bytes);
  assert.equal(b.status, 201, b.text);
  assert.equal(b.json.items[0].id, a.json.items[0].id);
  assert.equal(b.json.items[0].latestSeq, 2);
  assert.equal(b.json.items[0].description, 'Local.');
});

test('GitHub-contacting routes are limited per user: a burst of 10, then 429; a sha-pinned item costs nothing; another account is unaffected', async () => {
  gh.repos['acme/quota-user'] = { default_branch: 'main', refs: { main: sha2('c0') }, trees: { [sha2('c0')]: { 'SKILL.md': skill('quota-user') } } };
  gh.repos['acme/quota-pin'] = { default_branch: 'main', refs: { main: sha2('c1') }, trees: { [sha2('c1')]: { 'SKILL.md': skill('quota-pin') } } };
  const { t, h } = setup();
  const imp = await github(t, h, { repo: 'acme/quota-user' }); // 1
  assert.equal(imp.status, 201, imp.text);
  const pinned = await github(t, h, { repo: 'acme/quota-pin', ref: sha2('c1').slice(0, 7) }); // 2
  assert.equal(pinned.status, 201, pinned.text);
  const check = (id: string, hh: H = h) => t.req('POST', `${API}/items/${id}/source/check`, { headers: hh });
  const statuses: number[] = [];
  for (let i = 0; i < 9; i++) statuses.push((await check(imp.json.items[0].id)).status);
  assert.deepEqual(statuses, [...Array(8).fill(200), 429]);
  const r = await check(imp.json.items[0].id);
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, 'rate_limited');
  assert.match(r.json.error.message, /GitHub requests/);
  assert.equal((await github(t, h, { repo: 'acme/quota-user' })).status, 429, 'imports share the bucket');
  assert.equal((await t.req('POST', `${API}/items/${imp.json.items[0].id}/source/update`, { headers: h })).status, 429);
  // A sha-pinned item never asks GitHub, so its check and update are not counted and still answer.
  assert.deepEqual((await check(pinned.json.items[0].id)).json.upToDate, true);
  assert.equal((await t.req('POST', `${API}/items/${pinned.json.items[0].id}/source/update`, { headers: h })).status, 409);
  const other = t.key(t.createUser()).headers;
  assert.equal((await github(t, other, { repo: 'acme/quota-user' })).status, 201);
});

test('zipball downloads hold one of ZIPBALL_SLOTS; one more is 503 with a retry hint until a slot frees', async () => {
  const gates: (() => void)[] = [];
  const held = Array.from({ length: ZIPBALL_SLOTS }, () => withZipballSlot(() => new Promise<void>((r) => gates.push(r))));
  assert.equal(gates.length, ZIPBALL_SLOTS);
  await assert.rejects(
    withZipballSlot(async () => 'x'),
    (e: unknown) => e instanceof HttpError && e.status === 503 && e.code === 'busy' && (e.details as { retryAfter: number }).retryAfter === 5,
  );
  gates[0]();
  await held[0];
  assert.equal(await withZipballSlot(async () => 'x'), 'x');
  for (const g of gates.slice(1)) g();
  await Promise.all(held);
});

test('source/update at a commit that moved for an unrelated reason keeps a local edit: the tree is compared to what the source wrote, not to the latest version', async () => {
  const mono = (readme: string, desc = 'Upstream.'): Files => ({ 'skills/mono/SKILL.md': skill('mono', desc), 'README.md': readme });
  gh.repos['acme/monorepo'] = {
    default_branch: 'main',
    refs: { main: sha2('f0') },
    trees: { [sha2('f0')]: mono('a'), [sha2('f1')]: mono('b'), [sha2('f3')]: mono('c'), [sha2('f2')]: mono('d', 'Upstream v2.') },
  };
  const { t, h } = setup();
  const url = 'https://github.com/acme/monorepo/tree/main/skills/mono';
  const imp = await github(t, h, { url });
  assert.equal(imp.status, 201, imp.text);
  const id = imp.json.items[0].id;
  assert.equal((await t.req('POST', `${API}/items/${id}/versions`, { headers: h, json: { content: skill('mono', 'Edited locally.') } })).status, 201);
  // A README commit moved HEAD while skills/mono is byte-identical: check reports it, update writes nothing.
  gh.repos['acme/monorepo'].refs.main = sha2('f1');
  assert.equal((await t.req('POST', `${API}/items/${id}/source/check`, { headers: h })).json.upToDate, false);
  const up = await t.req('POST', `${API}/items/${id}/source/update`, { headers: h });
  assert.equal(up.status, 409, up.text);
  assert.equal(up.json.error.code, 'up_to_date');
  const item = (await t.req('GET', `${API}/items/${id}`, { headers: h })).json.item;
  assert.equal(item.latestSeq, 2, 'the local edit stays the latest version');
  assert.equal(item.description, 'Edited locally.');
  assert.equal(item.source.commit, sha2('f1'), 'the commit it was checked against is recorded');
  assert.equal((await t.req('POST', `${API}/items/${id}/source/check`, { headers: h })).json.upToDate, true);
  // A re-import at yet another unrelated commit is 'unchanged' the same way.
  gh.repos['acme/monorepo'].refs.main = sha2('f3');
  const again = await github(t, h, { url });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.json.items[0].latestSeq, 2);
  assert.equal(again.json.items[0].source.commit, sha2('f3'));
  // The skill itself changing upstream is an update again, over the edit (which stays in the history).
  gh.repos['acme/monorepo'].refs.main = sha2('f2');
  const real = await t.req('POST', `${API}/items/${id}/source/update`, { headers: h });
  assert.equal(real.status, 200, real.text);
  assert.equal(real.json.item.latestSeq, 3);
  assert.equal(real.json.item.description, 'Upstream v2.');
});

test('source/update of a whole-folder (kind override) import keeps the folder when upstream renames every carvable file; a root SKILL.md import still carves', async () => {
  const whole = (name: string, agent: string): Files => ({ 'SKILL.md': skill(name), [`agents/${agent}.md`]: AGENT });
  gh.repos['acme/whole'] = { default_branch: 'main', refs: { main: sha2('a1') }, trees: { [sha2('a1')]: whole('whole', 'x'), [sha2('a2')]: whole('whole', 'y') } };
  const { t, h } = setup();
  const paths = (item: { version: { files: { path: string }[] } }) => item.version.files.map((f) => f.path);
  const imp = await github(t, h, { repo: 'acme/whole', kind: 'skill' });
  assert.equal(imp.status, 201, imp.text);
  assert.deepEqual(paths(imp.json.items[0]), ['SKILL.md', 'agents/x.md']);
  gh.repos['acme/whole'].refs.main = sha2('a2');
  const up = await t.req('POST', `${API}/items/${imp.json.items[0].id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual(paths(up.json.item), ['SKILL.md', 'agents/y.md'], 'the folder the import deliberately kept stays');
  // Detection at the root carves the agent into its own item, and keeps carving on update.
  gh.repos['acme/carved'] = { default_branch: 'main', refs: { main: sha2('a3') }, trees: { [sha2('a3')]: whole('carved', 'x'), [sha2('a4')]: whole('carved', 'y') } };
  const det = await github(t, h, { repo: 'acme/carved' });
  assert.equal(det.status, 201, det.text);
  assert.deepEqual(names(det.json.items), ['agent:reviewer', 'skill:carved']);
  const carvedSkill = det.json.items.find((i: { kind: string }) => i.kind === 'skill');
  assert.deepEqual(paths(carvedSkill), ['SKILL.md']);
  gh.repos['acme/carved'].refs.main = sha2('a4');
  assert.equal((await t.req('POST', `${API}/items/${carvedSkill.id}/source/update`, { headers: h })).status, 409, 'SKILL.md alone, unchanged');
});

test("github import: the repository name follows GitHub's spelling (names are case-insensitive), and a re-import at the same commit follows the ref named", async () => {
  gh.repos['Acme/Mixed'] = { default_branch: 'main', refs: { main: sha2('b1'), 'v1.0': sha2('b1') }, trees: { [sha2('b1')]: { 'SKILL.md': skill('mixed', 'v1') }, [sha2('b2')]: { 'SKILL.md': skill('mixed', 'v2') } } };
  const { t, h } = setup();
  const a = await github(t, h, { repo: 'acme/mixed', ref: 'v1.0' });
  assert.equal(a.status, 201, a.text);
  assert.equal(a.json.source.repo, 'Acme/Mixed', "GitHub's spelling, not the user's");
  assert.equal(a.json.items[0].source.repo, 'Acme/Mixed');
  assert.equal(a.json.items[0].source.ref, 'v1.0');
  // The branch at the same commit, in yet another case: nothing to write, but the item follows the branch now.
  const b = await github(t, h, { url: 'https://github.com/ACME/MIXED' });
  assert.equal(b.status, 201, b.text);
  assert.equal(b.json.items[0].id, a.json.items[0].id);
  assert.equal(b.json.items[0].latestSeq, 1);
  assert.equal(b.json.items[0].source.ref, 'main');
  gh.repos['Acme/Mixed'].refs.main = sha2('b2');
  assert.equal((await t.req('POST', `${API}/items/${a.json.items[0].id}/source/check`, { headers: h })).json.upToDate, false, 'check resolves the branch');
  // A row imported before the canonical spelling was recorded still updates in place.
  t.db.prepare('UPDATE items SET source_repo = ? WHERE id = ?').run('acme/mixed', a.json.items[0].id);
  const c = await github(t, h, { repo: 'acme/mixed' });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.json.items[0].id, a.json.items[0].id);
  assert.equal(c.json.items[0].latestSeq, 2);
});

test('detectUnits is linear in the tree: 10,000 skill folders detect well under a second', () => {
  const files: Files = {};
  for (let i = 0; i < 10_000; i++) {
    files[`skills/s${i}/SKILL.md`] = skill(`s${i}`);
    files[`skills/s${i}/ref.md`] = 'ref';
  }
  const t = tree(files);
  const started = Date.now();
  const d = detectUnits(t, 'big');
  const took = Date.now() - started;
  assert.equal(d.units.length, 10_000);
  assert.deepEqual(d.units[9999].tree.map((f) => f.path).sort(), ['SKILL.md', 'ref.md']);
  // Filtering the whole tree once per folder was O(folders x files): tens of seconds here, before MAX_ITEMS was checked.
  assert.ok(took < 2000, `took ${took} ms`);
});

test("an exhausted GitHub quota is a clear 429 naming the reset, not a 502", async () => {
  const { t, h } = setup();
  const r = await github(t, h, { repo: 'acme/quota' });
  assert.equal(r.status, 429, r.text);
  assert.equal(r.json.error.code, 'rate_limited');
  assert.match(r.json.error.message, /rate limit for this server is exhausted until 20\d\d-.*set a github\.token/);
});

// ---------- v2 review 4 ----------

test('repository-doc skipping matches README/LICENSE-style names only: security-review, readme-writer and contributing-guide are items', () => {
  const d = detectUnits(
    tree({
      'commands/security-review.md': 'Review the diff for security issues.',
      'commands/contributing-guide.md': 'Write a contributing guide.',
      'commands/README.md': '# Commands',
      'commands/changelog.md': 'x',
      'agents/readme-writer.md': AGENT.replace('reviewer', 'readme-writer'),
      'docs/README.de.md': 'Deutsch',
    }),
    'kit',
  );
  assert.deepEqual(d.units.map((u) => [u.kind, u.name ?? u.path]), [['agent', 'agents/readme-writer.md'], ['command', 'security-review'], ['command', 'contributing-guide']]);
  assert.deepEqual(d.skipped, [
    { path: 'commands/README.md', reason: 'repository documentation, not an item' },
    { path: 'commands/changelog.md', reason: 'repository documentation, not an item' },
  ]);
  // The md-only fallback applies the same rule: a tree of such names imports, a tree of docs does not.
  assert.deepEqual(detectUnits(tree({ 'security-checklist.md': 'Check.', 'license-chooser.md': 'Choose.' }), 'x').units.map((u) => u.kind), ['prompt', 'prompt']);
  assert.deepEqual(detectUnits(tree({ 'README.md': 'r', 'LICENCE.md': 'l', 'README.de.md': 'd' }), 'x').units, []);
});

test('a folder import (GitHub tree or blob URL, zipped folder) with a root SKILL.md is one skill holding CLAUDE.md and agents/ too, like the folder under skills/ in a whole-repository import', async () => {
  const folder: Files = { 'skills/x/SKILL.md': skill('x'), 'skills/x/CLAUDE.md': '# Rules\n', 'skills/x/agents/helper.md': AGENT, 'skills/x/scripts/x.sh': 'echo', 'README.md': '# r\n' };
  gh.repos['acme/carve'] = { default_branch: 'main', refs: { main: sha2('d1') }, trees: { [sha2('d1')]: folder, [sha2('d2')]: { ...folder, 'skills/x/agents/helper.md': AGENT.replace('You review code.', 'Harder.') } } };
  const { t, h } = setup();
  const paths = (it: { version: { files: { path: string }[] } }) => it.version.files.map((f) => f.path);
  const all = ['CLAUDE.md', 'SKILL.md', 'agents/helper.md', 'scripts/x.sh'];
  const byTree = await github(t, h, { url: 'https://github.com/acme/carve/tree/main/skills/x' });
  assert.equal(byTree.status, 201, byTree.text);
  assert.deepEqual(names(byTree.json.items), ['skill:x']);
  assert.deepEqual(paths(byTree.json.items[0]), all);
  assert.deepEqual(byTree.json.skipped, []);
  // The whole repository carves the same folder the same way: one skill, the same four files.
  const t2 = setup();
  const whole = await github(t2.t, t2.h, { repo: 'acme/carve' });
  assert.deepEqual(names(whole.json.items), ['skill:x'], whole.text);
  assert.deepEqual(paths(whole.json.items[0]), all);
  // So does the blob URL (its folder), and the update keeps the whole folder.
  const t3 = setup();
  const byBlob = await github(t3.t, t3.h, { url: 'https://github.com/acme/carve/blob/main/skills/x/SKILL.md' });
  assert.deepEqual(names(byBlob.json.items), ['skill:x'], byBlob.text);
  gh.repos['acme/carve'].refs.main = sha2('d2');
  const up = await t3.t.req('POST', `${API}/items/${byBlob.json.items[0].id}/source/update`, { headers: t3.h });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual(paths(up.json.item), all);
  // A zipped folder (its wrapper stripped) is one folder too.
  const zipped = await pack(t, h, 'x.zip', { 'x/SKILL.md': skill('x2'), 'x/CLAUDE.md': '# Rules\n', 'x/agents/helper.md': AGENT, 'x/scripts/x.sh': 'echo' });
  assert.equal(zipped.status, 201, zipped.text);
  assert.deepEqual(names(zipped.json.items), ['skill:x2']);
  assert.deepEqual(paths(zipped.json.items[0]), all);
  // A true repository root still carves (the existing root rule).
  assert.deepEqual(detectUnits(tree({ 'SKILL.md': skill('r'), 'CLAUDE.md': '# Rules\n', 'agents/helper.md': AGENT }), 'r').units.map((u) => u.kind), ['agent', 'instructions', 'skill']);
});

test('one file over 10 MB fails its unit alone: the rest of the pack imports and that unit lands in skipped', async () => {
  const MB = 1024 * 1024;
  const big = new Uint8Array(11 * MB); // stored, not deflated: zeros would otherwise trip the 100:1 ratio guard, which is about inflation
  const zip = zipSync({ 'skills/good/SKILL.md': strToU8(skill('good')), 'skills/big/SKILL.md': strToU8(skill('big')), 'skills/big/assets/model.bin': [big, { level: 0 }] });
  const { t, h } = setup();
  const r = await pack(t, h, 'two.zip', zip);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:good']);
  assert.deepEqual(r.json.skipped, [{ path: 'skills/big', reason: "'assets/model.bin' is over 10 MB" }]);
});

test('400 nothing_to_import carries the detection skip reasons, and a .md nested below a layout folder says so', async () => {
  const { t, h } = setup();
  const nested = await pack(t, h, 'nested.zip', { 'src/a.ts': 'x', 'commands/frontend/component.md': 'Make a component.' });
  assert.equal(nested.status, 400, nested.text);
  assert.equal(nested.json.error.code, 'nothing_to_import');
  assert.deepEqual(nested.json.error.details, [{ path: 'commands/frontend/component.md', reason: 'nested under commands/: only commands/*.md is imported' }]);
  const docs = await pack(t, h, 'docs.zip', { 'README.md': '# r', 'LICENSE.md': 'MIT' });
  assert.equal(docs.status, 400, docs.text);
  assert.deepEqual(docs.json.error.details, [
    { path: 'README.md', reason: 'repository documentation, not an item' },
    { path: 'LICENSE.md', reason: 'repository documentation, not an item' },
  ]);
  // Nothing passed over worth naming: no details, as before.
  const code = await pack(t, h, 'code.zip', { 'src/a.ts': 'x' });
  assert.equal(code.status, 400);
  assert.equal(code.json.error.details, undefined);
});

// ---------- v3 import fixes ----------

const filePaths = (it: { version: { files: { path: string }[] } }) => it.version.files.map((f) => f.path);
const importOne = (t: TestCtx, h: H, filename: string, bytes: Uint8Array) => {
  const fd = new FormData();
  fd.set('file', new File([bytes as Uint8Array<ArrayBuffer>], filename));
  return t.req('POST', `${API}/items/import`, { headers: h, body: fd });
};

test('31bp: a zip from Windows Compress-Archive (backslash separators, no directory entries) imports through the pack and single-file routes', async () => {
  const win = zipSync({ 'stax\\SKILL.md': strToU8(skill('stax-tool')), 'stax\\scripts\\run.sh': strToU8('echo') });
  const { t, h } = setup();
  const r = await pack(t, h, 'stax-skill.zip', win);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:stax-tool'], 'named from its frontmatter');
  assert.deepEqual(filePaths(r.json.items[0]), ['SKILL.md', 'scripts/run.sh'], 'the stax folder is the wrapper');
  assert.equal(r.json.items[0].source.path, null);
  const t2 = setup();
  const one = await importOne(t2.t, t2.h, 'stax-skill.zip', win);
  assert.equal(one.status, 201, one.text);
  assert.deepEqual([one.json.item.kind, one.json.item.name, filePaths(one.json.item)], ['skill', 'stax-tool', ['SKILL.md', 'scripts/run.sh']]);
  for (const bad of ['..\\evil.md', 'C:\\evil.md', '\\abs.md']) {
    const z = zipSync({ 'stax\\SKILL.md': strToU8(skill('stax')), [bad]: strToU8('x') });
    assert.equal((await pack(t, h, 'bad.zip', z)).status, 400, bad);
    assert.equal((await importOne(t, h, 'bad.zip', z)).status, 400, bad);
  }
  const dup = await pack(t, h, 'dup.zip', zipSync({ 'a\\b.md': strToU8('1'), 'a/b.md': strToU8('2') }));
  assert.equal(dup.status, 400);
  assert.match(dup.json.error.message, /duplicate zip entry 'a\/b\.md'/);
});

test('a51r: a pack with symlinks imports everything else; each link is listed in skipped with its target, never followed', async () => {
  const { t, h } = setup();
  const reason = (target: string) => `symlink to '${target}', not imported`;
  const kata = await pack(t, h, 'kata.zip', { 'CLAUDE.md': link('AGENTS.md'), 'AGENTS.md': '# Rules\n', 'skills/pdf/SKILL.md': skill('pdf') });
  assert.equal(kata.status, 201, kata.text);
  assert.deepEqual(names(kata.json.items), ['instructions:rules', 'skill:pdf']);
  assert.deepEqual(kata.json.skipped, [{ path: 'CLAUDE.md', reason: reason('AGENTS.md') }]);
  // A directory symlink: the real folder imports once, no duplicate unit.
  const dir = await pack(t, h, 'wt.zip', { '.claude/skills/wt/SKILL.md': skill('wt'), '.claude/skills/wt/ref.md': 'ref', '.agents/skills': link('../.claude/skills') });
  assert.equal(dir.status, 201, dir.text);
  assert.deepEqual(names(dir.json.items), ['skill:wt']);
  assert.deepEqual(filePaths(dir.json.items[0]), ['SKILL.md', 'ref.md']);
  assert.deepEqual(dir.json.skipped, [{ path: '.agents/skills', reason: reason('../.claude/skills') }]);
  // Targets that escape the tree are only reported: the link's stored bytes, nothing read from disk.
  const esc = await pack(t, h, 'esc.zip', { 'skills/esc/SKILL.md': skill('esc'), 'skills/esc/passwd': link('/etc/passwd'), up: link('../../etc/passwd') });
  assert.equal(esc.status, 201, esc.text);
  assert.deepEqual(filePaths(esc.json.items[0]), ['SKILL.md']);
  assert.deepEqual(esc.json.skipped, [{ path: 'skills/esc/passwd', reason: reason('/etc/passwd') }, { path: 'up', reason: reason('../../etc/passwd') }]);
  // A wrapper folder is stripped from the links too.
  const wrapped = await pack(t, h, 'kit.zip', { 'kit/SKILL.md': skill('kit'), 'kit/CLAUDE.md': link('SKILL.md') });
  assert.equal(wrapped.status, 201, wrapped.text);
  assert.deepEqual(wrapped.json.skipped, [{ path: 'CLAUDE.md', reason: reason('SKILL.md') }]);
  // Only links (and code): the existing 400, with the links as its details.
  const only = await pack(t, h, 'only.zip', { 'CLAUDE.md': link('AGENTS.md'), 'src/a.ts': 'x' });
  assert.equal(only.status, 400, only.text);
  assert.equal(only.json.error.code, 'nothing_to_import');
  assert.deepEqual(only.json.error.details, [{ path: 'CLAUDE.md', reason: reason('AGENTS.md') }]);
  // The single-item zip import still refuses them.
  const single = await importOne(t, h, 'x.zip', zipSync({ 'x/SKILL.md': strToU8(skill('x')), 'x/link': zipEntry(link('SKILL.md')) }));
  assert.equal(single.status, 400, single.text);
  assert.equal(single.json.error.message, "symlinks are not allowed: 'x/link'");
});

test('a51r: GitHub repositories of the 2026-10-22 survey shapes import with their links skipped; a link inside a folder import too; source/update reports them', async () => {
  const survey: [string, Files, string][] = [
    ['kenn-io/kata', { 'AGENTS.md': '# Rules\n', 'CLAUDE.md': link('AGENTS.md'), 'skills/kata/SKILL.md': skill('kata') }, 'CLAUDE.md'],
    ['max-sixty/worktrunk', { '.claude/skills/wt/SKILL.md': skill('wt'), '.agents/skills': link('../.claude/skills') }, '.agents/skills'],
    ['kunchenguid/firstmate', { '.claude/skills/firstmate-calm/SKILL.md': skill('firstmate-calm'), '.agents/skills/firstmate-calm': link('../../.claude/skills/firstmate-calm') }, '.agents/skills/firstmate-calm'],
    ['EricTechPro/super-board', { 'skills/board/SKILL.md': skill('board'), 'evals/_stubs/bin/git': link('../../../stub.sh') }, 'evals/_stubs/bin/git'],
  ];
  const { t, h } = setup();
  survey.forEach(([repo, files], i) => (gh.repos[repo] = { default_branch: 'main', refs: { main: sha2(`4${'abcde'[i]}`) }, trees: { [sha2(`4${'abcde'[i]}`)]: files } }));
  for (const [repo, , first] of survey) {
    const r = await github(t, h, { repo });
    assert.equal(r.status, 201, `${repo}: ${r.text}`);
    assert.ok(r.json.items.length >= 1, repo);
    assert.deepEqual(r.json.skipped.map((s: { path: string }) => s.path), [first], repo);
  }
  // neuledge/context at 1d829a4 (a sample of its real tree): INSTRUCTIONS.md is the only real
  // instructions file; .clinerules, .cursorrules, CLAUDE.md and README.md all link to it.
  const toInstr = link('INSTRUCTIONS.md');
  gh.repos['neuledge/context'] = { default_branch: 'main', refs: { main: sha2('4f') }, trees: { [sha2('4f')]: {
    '.agents/registry/AGENT.md': '# Registry agent\n', '.changeset/config.json': '{}', '.clinerules': toInstr, '.cursorrules': toInstr,
    'CLAUDE.md': toInstr, 'INSTRUCTIONS.md': '# Context\n', LICENSE: 'MIT', 'README.md': toInstr, 'SERVER_SPEC.md': '# Spec\n', 'package.json': '{}',
    'packages/context/CHANGELOG.md': '# Changelog\n', 'packages/context/README.md': '# context\n', 'packages/context/src/index.ts': 'x',
    'packages/context/src/fixtures/retrieval/csharp-signals.md': '# Signals\n', 'registry/README.md': '# Registry\n', 'registry/npm/ai.yaml': 'name: ai',
  } } };
  const ctx = await github(t, h, { repo: 'neuledge/context' });
  assert.equal(ctx.status, 201, ctx.text);
  assert.deepEqual(names(ctx.json.items), ['instructions:context']);
  assert.deepEqual(filePaths(ctx.json.items[0]), ['AGENTS.md'], 'stored at the instructions entry path');
  assert.deepEqual(ctx.json.skipped.slice(0, 4), ['.clinerules', '.cursorrules', 'CLAUDE.md', 'README.md'].map((path) => ({ path, reason: "symlink to 'INSTRUCTIONS.md', not imported" })));
  assert.deepEqual(ctx.json.skipped.slice(4).map((s: { path: string }) => s.path), ['.agents/registry/AGENT.md', 'SERVER_SPEC.md', 'packages/context/src/fixtures/retrieval/csharp-signals.md']);
  // Arize-ai/phoenix: the link sits inside the plugin folder the import names. Reported relative to that folder.
  const plugin = (desc: string): Files => ({
    'plugins/claude/arize-phoenix/skills/phoenix/SKILL.md': skill('phoenix', desc),
    'plugins/claude/arize-phoenix/skills/phoenix/bin': link('../../../../../bin'),
    'plugins/claude/arize-phoenix/skills/phoenix-cli': link('../../../../cli/skill'),
    'cli/skill/SKILL.md': skill('phoenix-cli'),
  });
  gh.repos['Arize-ai/phoenix'] = { default_branch: 'main', refs: { main: sha2('5a') }, trees: { [sha2('5a')]: plugin('v1'), [sha2('5b')]: plugin('v2') } };
  const ph = await github(t, h, { repo: 'Arize-ai/phoenix', path: 'plugins/claude/arize-phoenix' });
  assert.equal(ph.status, 201, ph.text);
  assert.deepEqual(names(ph.json.items), ['skill:phoenix']);
  assert.deepEqual(ph.json.skipped, [
    { path: 'skills/phoenix/bin', reason: "symlink to '../../../../../bin', not imported" },
    { path: 'skills/phoenix-cli', reason: "symlink to '../../../../cli/skill', not imported" },
  ]);
  gh.repos['Arize-ai/phoenix'].refs.main = sha2('5b');
  const up = await t.req('POST', `${API}/items/${ph.json.items[0].id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.description, 'v2');
  // The item's own folder (skills/phoenix): its link, not the sibling's.
  assert.deepEqual(up.json.skipped, [{ path: 'bin', reason: "symlink to '../../../../../bin', not imported" }]);
});

test('xksr: GitHub import with kind artifact is refused before GitHub is contacted and costs no rate-limit take', async () => {
  gh.repos['acme/art2'] = { default_branch: 'main', refs: { main: sha2('5c') }, trees: { [sha2('5c')]: { 'SKILL.md': skill('art2') } } };
  const { t, h } = setup();
  const before = gh.requests.length;
  for (let i = 0; i < 11; i++) {
    const r = await github(t, h, { repo: 'acme/art2', kind: 'artifact' });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error.message, ARTIFACT_FROM_TREE);
  }
  assert.equal(gh.requests.length, before, 'no GitHub request left');
  assert.equal((await github(t, h, { repo: 'acme/art2' })).status, 201, 'eleven refusals, and the bucket (a burst of 10) still has room');
});

test('kgtx: a GitHub import of one file stores that file as source_path, so source/update works; a doubled path stored before the fix is repaired', async () => {
  const v = (n: string): Files => ({ 'skills.md': `# Stax\n\nversion ${n}\n`, 'docs/x.md': `# Do x\n\nversion ${n}\n`, 'README.md': '# r\n' });
  gh.repos['acme/onefile'] = { default_branch: 'main', refs: { main: sha2('6a'), old: sha2('6a') }, trees: { [sha2('6a')]: v('1'), [sha2('6b')]: v('2'), [sha2('6c')]: { 'README.md': '# r\n' } } };
  const { t, h } = setup();
  const root = await github(t, h, { repo: 'acme/onefile', path: 'skills.md' });
  assert.equal(root.status, 201, root.text);
  assert.equal(root.json.items[0].source.path, 'skills.md');
  assert.equal(root.json.source.path, 'skills.md');
  const nested = await github(t, h, { repo: 'acme/onefile', path: 'docs/x.md' });
  assert.equal(nested.status, 201, nested.text);
  assert.equal(nested.json.items[0].source.path, 'docs/x.md');
  const body = (it: { version: { files: { content?: string }[] } }) => JSON.stringify(it.version.files);
  const update = (id: string) => t.req('POST', `${API}/items/${id}/source/update`, { headers: h });
  // Upstream moves: check says so, update writes a version holding the upstream file.
  gh.repos['acme/onefile'].refs.main = sha2('6b');
  for (const it of [root.json.items[0], nested.json.items[0]]) {
    assert.equal((await t.req('POST', `${API}/items/${it.id}/source/check`, { headers: h })).json.upToDate, false);
    const up = await update(it.id);
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.item.latestSeq, 2);
    const raw = await t.req('GET', `${API}/items/${it.id}/files/${up.json.item.version.entryPath}`, { headers: h });
    assert.match(raw.text, /version 2/, body(up.json.item));
  }
  // Re-import at another ref versions the same item, no duplicate.
  const again = await github(t, h, { repo: 'acme/onefile', ref: 'old', path: 'docs/x.md' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual([again.json.items[0].id, again.json.items[0].op, again.json.items[0].latestSeq], [nested.json.items[0].id, 'version', 3]);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 2);
  // The file deleted upstream: the existing 400.
  gh.repos['acme/onefile'].refs.main = sha2('6c');
  const gone = await update(root.json.items[0].id);
  assert.equal(gone.status, 400, gone.text);
  assert.equal(gone.json.error.message, `'skills.md' no longer exists in acme/onefile@${sha2('6c').slice(0, 7)}`);

  // A row stored with the doubled path (the bug) cannot update; the v3 migration repairs it.
  gh.repos['acme/onefile2'] = { default_branch: 'main', refs: { main: sha2('6d') }, trees: { [sha2('6d')]: v('1'), [sha2('6e')]: v('2') } };
  const t2 = setup();
  const old = await github(t2.t, t2.h, { repo: 'acme/onefile2', path: 'docs/x.md' });
  assert.equal(old.status, 201, old.text);
  const id = old.json.items[0].id;
  t2.t.db.prepare('UPDATE items SET source_path = ? WHERE id = ?').run('docs/x.md/x.md', id);
  gh.repos['acme/onefile2'].refs.main = sha2('6e');
  const broken = await t2.t.req('POST', `${API}/items/${id}/source/update`, { headers: t2.h });
  assert.equal(broken.status, 400, 'the bug');
  assert.match(broken.json.error.message, /'docs\/x\.md\/x\.md' no longer exists/);
  t2.t.db.exec(UNDOUBLE_SOURCE_PATHS);
  const fixed = await t2.t.req('POST', `${API}/items/${id}/source/update`, { headers: t2.h });
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(fixed.json.item.source.path, 'docs/x.md');
  assert.equal(fixed.json.item.latestSeq, 2);
});

test('kgtx: the source-path repair touches only GitHub single-file rows whose last two segments repeat', async () => {
  const { t, h } = setup();
  const rows: [string, string, string | null, string | null][] = [
    // kind, source_kind, stored path, expected after
    ['prompt', 'github', 'skills.md/skills.md', 'skills.md'],
    ['agent', 'github', 'docs/x.md/x.md', 'docs/x.md'],
    ['instructions', 'github', 'CLAUDE.md/CLAUDE.md', 'CLAUDE.md'],
    ['design', 'github', 'brand/design.md/design.md', 'brand/design.md'],
    ['prompt', 'github', 'a/bx.md/x.md', 'a/bx.md/x.md'],
    ['prompt', 'github', 'commands/ship.md', 'commands/ship.md'],
    ['prompt', 'zip', 'x.md/x.md', 'x.md/x.md'],
    ['skill', 'github', 'x.md/x.md', 'x.md/x.md'],
    ['prompt', 'github', null, null],
  ];
  const ids: string[] = [];
  for (const [kind] of rows) {
    const content = kind === 'skill' ? skill(`s${ids.length}`) : kind === 'agent' ? AGENT.replace('reviewer', `a${ids.length}`) : `# P${ids.length}\n`;
    const r = await t.req('POST', `${API}/items`, { headers: h, json: { kind, name: kind === 'skill' || kind === 'agent' ? undefined : `p${ids.length}`, content } });
    assert.equal(r.status, 201, r.text);
    ids.push(r.json.item.id);
  }
  rows.forEach(([, sk, path], i) => t.db.prepare('UPDATE items SET source_kind = ?, source_path = ? WHERE id = ?').run(sk, path, ids[i]));
  t.db.exec(UNDOUBLE_SOURCE_PATHS);
  const after = ids.map((id) => (t.db.prepare('SELECT source_path FROM items WHERE id = ?').get(id) as { source_path: string | null }).source_path);
  assert.deepEqual(after, rows.map((r) => r[3]));
});

test('qarz: the name clash reads with the right article for every kind', async () => {
  const { t, h } = setup();
  const want: Record<string, string> = { agent: 'an agent', instructions: 'an instructions item', artifact: 'an artifact', skill: 'a skill', command: 'a command', prompt: 'a prompt' };
  for (const [kind, phrase] of Object.entries(want)) {
    const json =
      kind === 'skill' ? { kind, content: skill('dup') } : kind === 'agent' ? { kind, content: AGENT.replace('reviewer', 'dup') } : kind === 'artifact' ? { kind, name: 'dup', format: 'html', content: '<p>x</p>' } : { kind, name: 'dup', content: 'x' };
    assert.equal((await t.req('POST', `${API}/items`, { headers: h, json })).status, 201, kind);
    const clash = await t.req('POST', `${API}/items`, { headers: h, json });
    assert.equal(clash.status, 409, kind);
    assert.equal(clash.json.error.message, `you already have ${phrase} named 'dup'`);
  }
});

/** Set import limits the way an admin does (PUT /admin/settings), so these tests cover the route too. */
async function setLimits(t: TestCtx, imports: Record<string, number | ''>) {
  const admin = t.createUser({ isAdmin: true });
  const r = await t.req('PUT', `${API}/admin/settings`, { headers: t.session(admin), json: { imports } });
  assert.equal(r.status, 200, r.text);
}
const prompts = (prefix: string, n: number): Files => Object.fromEntries(Array.from({ length: n }, (_, i) => [`prompts/${prefix}${i}.md`, `Prompt ${i}.\n`]));
const itemCount = (t: TestCtx) => (t.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;

test('dhje: the items-per-import cap is the import.max_items setting: 200 by default, 5 refuses 6 units naming 5, 500 lets 300 through', async () => {
  const { t, h } = setup();
  const at200 = await pack(t, h, 'a.zip', prompts('a', 200));
  assert.equal(at200.status, 201, at200.text);
  assert.equal(at200.json.items.length, 200);
  const at201 = await pack(t, h, 'b.zip', prompts('b', 201));
  assert.equal(at201.status, 400);
  assert.equal(at201.json.error.code, 'too_many_items');
  assert.equal(at201.json.error.message, 'at most 200 items per import (found 201)');

  await setLimits(t, { maxItems: 5 });
  const six = await pack(t, h, 'c.zip', prompts('c', 6));
  assert.equal(six.status, 400);
  assert.equal(six.json.error.code, 'too_many_items');
  assert.equal(six.json.error.message, 'at most 5 items per import (found 6)');
  assert.equal((await pack(t, h, 'd.zip', prompts('d', 5))).status, 201);
  await setLimits(t, { maxItems: 1 });
  assert.equal((await pack(t, h, 'g.zip', prompts('g', 2))).json.error.message, 'at most 1 item per import (found 2)');

  await setLimits(t, { maxItems: 500 });
  const at300 = await pack(t, h, 'e.zip', prompts('e', 300));
  assert.equal(at300.status, 201, at300.text);
  assert.equal(at300.json.items.length, 300);
  // Cleared, the default applies again.
  await setLimits(t, { maxItems: '' });
  assert.equal((await pack(t, h, 'f.zip', prompts('f', 201))).json.error.code, 'too_many_items');
});

test('00tr: import.max_archive_mb caps the GitHub download and the pack upload, import.max_pack_mb the unpacked pack; each 413 names the current limit', async () => {
  gh.repos['acme/sized'] = { default_branch: 'main', refs: { main: sha2('7a'), huge: SHA_HUGE }, trees: { [sha2('7a')]: { 'SKILL.md': skill('sized'), 'assets/noise.txt': noise(2) } } };
  const { t, h } = setup();
  const noisyPack: Files = { 'SKILL.md': skill('noisy'), 'noise.txt': noise(1.5) };
  // Defaults: a 2 MB zipball and a 1.5 MB pack import as before; 40 MB is over the 35 MB cap.
  assert.equal((await github(t, h, { repo: 'acme/sized' })).status, 201);
  assert.equal((await pack(t, h, 'noisy.zip', noisyPack)).status, 201);
  const huge = await github(t, h, { repo: 'acme/sized', ref: 'huge' });
  assert.equal(huge.status, 413);
  assert.equal(huge.json.error.message, 'the repository archive is over 35 MB');

  await setLimits(t, { maxArchiveMb: 1 });
  const small = await github(t, h, { repo: 'acme/sized' });
  assert.equal(small.status, 413, small.text);
  assert.equal(small.json.error.code, 'too_large');
  assert.equal(small.json.error.message, 'the repository archive is over 1 MB');
  const upload = await pack(t, h, 'noise.zip', { 'SKILL.md': skill('n'), 'noise.txt': noise(2) });
  assert.equal(upload.status, 413);
  assert.equal(upload.json.error.message, 'request body is over 1 MB');

  // Raised to 40 MB, the 40 MB download is let through (the fake's bytes are not a zip: the unzip refuses them, not the cap).
  await setLimits(t, { maxArchiveMb: 40 });
  const through = await github(t, h, { repo: 'acme/sized', ref: 'huge' });
  assert.equal(through.status, 400, through.text);
  assert.match(through.json.error.message, /not a valid zip file/);

  await setLimits(t, { maxArchiveMb: '', maxPackMb: 1 });
  const unpacked = await pack(t, h, 'noisy2.zip', noisyPack);
  assert.equal(unpacked.status, 413, unpacked.text);
  assert.equal(unpacked.json.error.message, "'noise.txt' is over 1 MB");
});

test('00tr: the single-file import is capped by import.max_archive_mb too, never above 35 MB; GET /imports/limits tells any signed-in user the caps', async () => {
  const { t, h } = setup();
  const bigSkill = zipSync({ 'SKILL.md': zipEntry(skill('big')), 'noise.txt': zipEntry(noise(2)) }, { level: 0 });
  assert.equal((await importOne(t, h, 'big.zip', bigSkill)).status, 201);
  const limits = async () => (await t.req('GET', `${API}/imports/limits`, { headers: h })).json;
  assert.equal((await t.req('GET', `${API}/imports/limits`)).status, 401);
  assert.deepEqual(await limits(), { maxItems: 200, maxArchiveMb: 35, maxPackMb: 64, maxFileMb: 35 });

  await setLimits(t, { maxArchiveMb: 1, maxItems: 7 });
  const refused = await importOne(t, h, 'big2.zip', bigSkill);
  assert.equal(refused.status, 413, refused.text);
  assert.equal(refused.json.error.message, 'request body is over 1 MB');
  assert.deepEqual(await limits(), { maxItems: 7, maxArchiveMb: 1, maxPackMb: 64, maxFileMb: 1 });
  // Raised over 35 MB, the pack upload follows; the single-file upload stays at 35 (a version is 30 MB).
  await setLimits(t, { maxArchiveMb: 100 });
  assert.equal((await limits()).maxFileMb, 35);
});

const BIG_REPO = (desc: string): Files => ({
  'skills/alpha/SKILL.md': skill('alpha', desc),
  'skills/alpha/scripts/run.sh': '#!/bin/sh\necho alpha\n',
  'skills/beta/SKILL.md': skill('beta'),
  'skills/beta/ref': link('../alpha'),
  'skills/vendor': SUBMODULE,
  'skills/.DS_Store': 'junk',
  'assets/noise.txt': noise(2),
});
const gitCalls = (from: number, kind: 'trees' | 'blobs') => gh.requests.slice(from).filter((r) => r.url.includes(`/git/${kind}/`)).length;

test('a4q8: a folder of a repository whose archive is over the cap imports file by file, with the trees a zipball import gives; source/update falls back too; the calls are spent on the user', async () => {
  gh.repos['acme/huge-mono'] = { default_branch: 'main', refs: { main: sha2('7b') }, trees: { [sha2('7b')]: BIG_REPO('v1'), [sha2('7c')]: BIG_REPO('v2') } };
  // The reference: the same commit and folder through the zipball, under the default cap.
  const ref = setup();
  const viaZip = await github(ref.t, ref.h, { repo: 'acme/huge-mono', path: 'skills' });
  assert.equal(viaZip.status, 201, viaZip.text);
  assert.equal(gitCalls(0, 'trees'), 0, 'under the cap nothing is listed');

  const { t, h } = setup();
  await setLimits(t, { maxArchiveMb: 1 });
  let from = gh.requests.length;
  const r = await github(t, h, { repo: 'acme/huge-mono', path: 'skills' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:alpha', 'skill:beta']);
  assert.ok(gh.requests.slice(from).some((q) => q.url.includes('/zipball/')), 'the zipball is tried first');
  assert.equal(gitCalls(from, 'trees'), 2, 'one listing per path segment, then the folder');
  assert.equal(gitCalls(from, 'blobs'), 4, 'one per file and link; none for junk or the submodule');
  const trees = (items: { name: string; version: { treeSha256: string } }[]) => Object.fromEntries(items.map((i) => [i.name, i.version.treeSha256]));
  assert.deepEqual(trees(r.json.items), trees(viaZip.json.items));
  assert.deepEqual(r.json.items.map((i: { source: { path: string; commit: string } }) => [i.source.path, i.source.commit]).sort(), [['skills/alpha', sha2('7b')], ['skills/beta', sha2('7b')]]);
  // The link is reported as the zipball reports it; the submodule (which a zipball leaves out) too.
  assert.deepEqual(r.json.skipped[0], viaZip.json.skipped[0]);
  assert.deepEqual(r.json.skipped[0], { path: 'beta/ref', reason: "symlink to '../alpha', not imported" });
  assert.equal(r.json.skipped[1].path, 'vendor');
  assert.match(r.json.skipped[1].reason, /^submodule at [0-9a-f]{7}, not imported$/);

  // A whole-repository import keeps the 413: there is no folder to fetch file by file.
  from = gh.requests.length;
  const whole = await github(t, h, { repo: 'acme/huge-mono' });
  assert.equal(whole.status, 413);
  assert.equal(whole.json.error.message, 'the repository archive is over 1 MB');
  assert.equal(gitCalls(from, 'trees'), 0);

  // source/update takes the same path: the folder is listed and fetched at the new commit.
  gh.repos['acme/huge-mono'].refs.main = sha2('7c');
  const alpha = r.json.items.find((i: { name: string }) => i.name === 'alpha');
  from = gh.requests.length;
  const up = await t.req('POST', `${API}/items/${alpha.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.description, 'v2');
  assert.deepEqual(up.json.skipped, []);
  assert.equal(gitCalls(from, 'trees'), 3, 'skills, skills/alpha, then the folder');
  assert.equal(gitCalls(from, 'blobs'), 2);

  // Every call was spent on this user's bucket (burst 10): 1 + 6 for the import, 1 for the 413, 1 + 5 for the update.
  const next = await github(t, h, { repo: 'acme/huge-mono', path: 'skills' });
  assert.equal(next.status, 429);
  assert.equal(next.json.error.code, 'rate_limited');
});

test('a4q8: a folder over the version limits is refused from the listing, and one that needs more calls than the anonymous quota has left is a 400 naming github.token; no blob is fetched', async () => {
  const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`docs/f${i}.md`, `# ${i}\n`]));
  gh.repos['acme/huge-docs'] = {
    default_branch: 'main',
    refs: { main: sha2('7d') },
    trees: { [sha2('7d')]: { ...many, 'big/SKILL.md': skill('big'), 'big/huge.txt': 'x'.repeat(11 * 1024 * 1024), 'assets/noise.txt': noise(2) } },
  };
  gh.repos['acme/huge-quota'] = { default_branch: 'main', refs: { main: sha2('7e') }, trees: { [sha2('7e')]: BIG_REPO('v1') } };
  const { t, h } = setup();
  await setLimits(t, { maxArchiveMb: 1 });
  let from = gh.requests.length;
  const files = await github(t, h, { repo: 'acme/huge-docs', path: 'docs' });
  assert.equal(files.status, 413, files.text);
  assert.match(files.json.error.message, /'docs' is too large to fetch file by file: at most 1000 files/);
  const size = await github(t, h, { repo: 'acme/huge-docs', path: 'big' });
  assert.equal(size.status, 413, size.text);
  assert.match(size.json.error.message, /'big\/huge.txt' is over 10 MB/);
  assert.equal(gitCalls(from, 'trees'), 4, 'listed');
  assert.equal(gitCalls(from, 'blobs'), 0, 'refused before any blob');

  from = gh.requests.length;
  gh.quota.remaining = 3;
  try {
    const q = await github(t, h, { repo: 'acme/huge-quota', path: 'skills' });
    assert.equal(q.status, 400, q.text);
    assert.match(q.json.error.message, /needs 4 GitHub requests, more than the 3 anonymous ones left this hour; set a github\.token/);
  } finally {
    gh.quota.remaining = null;
  }
  assert.equal(gitCalls(from, 'blobs'), 0);
  assert.equal(itemCount(t), 0, 'no partial import');
});

test('a4q8: an import admitted with its last token still completes and pays every listing and blob call in debt', async () => {
  gh.repos['acme/huge-last'] = { default_branch: 'main', refs: { main: sha2('7f') }, trees: { [sha2('7f')]: BIG_REPO('v1') } };
  const { t, h } = setup();
  await setLimits(t, { maxArchiveMb: 1 });
  // Nine calls that stop at GitHub's 400 leave the burst of 10 with about one token.
  for (let i = 0; i < 9; i++) assert.equal((await github(t, h, { repo: 'acme/no-such-repo' })).status, 400);
  const from = gh.requests.length;
  const r = await github(t, h, { repo: 'acme/huge-last', path: 'skills' });
  assert.equal(r.status, 201, r.text);
  assert.equal(gitCalls(from, 'trees'), 2);
  assert.equal(gitCalls(from, 'blobs'), 4);
  // 2 listings and 4 blobs are owed: about 30 s before the next GitHub call.
  assert.equal((await github(t, h, { repo: 'acme/no-such-repo' })).status, 429);
});

test('a4q8: a folder refused from its listing still pays for the listings it made', async () => {
  gh.repos['acme/huge-refused'] = {
    default_branch: 'main',
    refs: { main: sha2('80') },
    trees: { [sha2('80')]: { ...Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`docs/f${i}.md`, `# ${i}\n`])), 'assets/noise.txt': noise(2) } },
  };
  const { t, h } = setup();
  await setLimits(t, { maxArchiveMb: 1 });
  // Each refusal spends 1 token to start and 2 for its listings: the burst of 10 admits four.
  for (let i = 0; i < 4; i++) assert.equal((await github(t, h, { repo: 'acme/huge-refused', path: 'docs' })).status, 413);
  assert.equal((await github(t, h, { repo: 'acme/huge-refused', path: 'docs' })).status, 429);
});
