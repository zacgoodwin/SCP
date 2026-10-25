import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { listenLocal, makeTestCtx, type TestCtx } from './helpers.ts';
import { buildZip } from '../src/lib/zip.ts';
import { sha256Hex } from '../src/lib/crypto.ts';
import { HttpError } from '../src/lib/http.ts';
import { ZIPBALL_SLOTS, parseGithubSource, withZipballSlot } from '../src/imports/github.ts';
import { ARTIFACT_FROM_TREE, detectUnits, importTree, subtree, unpack } from '../src/imports/pack.ts';
import type { GroupRow, Principal } from '../src/types.ts';
import { UNDOUBLE_SOURCE_PATHS } from '../src/db.ts';
import { createItemTx } from '../src/items/service.ts';

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
/** A commit sha; the fake resolves it within the repo asked for, as GitHub does, so two repos may reuse one. */
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
  // Repo names resolve case-insensitively, like GitHub's.
  const repoOf = (name: string) => {
    const key = Object.keys(repos).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? { key, repo: repos[key] } : undefined;
  };
  const listing = (repo: string, files: Files, commit: string, dir: string, recursive: boolean) => {
    const prefix = dir ? dir + '/' : '';
    const out = new Map<string, object>();
    for (const [p, text] of Object.entries(files)) {
      if (!p.startsWith(prefix)) continue;
      const segs = p.slice(prefix.length).split('/');
      for (let i = 1; i <= (recursive ? segs.length : 1); i++) {
        const rel = segs.slice(0, i).join('/');
        if (i === segs.length) out.set(rel, entry(rel, text));
        else if (!out.has(rel)) {
          const id = sha1(`${repo}:${commit}:${prefix}${rel}`);
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
    const git = /^\/repos\/([^/]+\/[^/]+)\/git\/(trees|blobs)\/([0-9a-f]{40})(\?recursive=1)?$/.exec(req.url!);
    if (git) {
      if (git[2] === 'blobs') {
        const bytes = blobs.get(git[3]);
        return bytes ? res.writeHead(200, { 'content-type': 'application/vnd.github.raw' }).end(bytes) : json(404, { message: 'Not Found' });
      }
      const owner = repoOf(git[1]);
      if (!owner) return json(404, { message: 'Not Found' });
      // A commit sha lists its root tree, as on GitHub.
      const root = owner.repo.trees[git[3]];
      const at = root ? { files: root, dir: '' } : treeIds.get(git[3]);
      if (!at) return json(404, { message: 'Not Found' });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (quota.remaining !== null) headers['x-ratelimit-remaining'] = String(quota.remaining);
      return res.writeHead(200, headers).end(JSON.stringify({ sha: git[3], tree: listing(owner.key, at.files, git[3], at.dir, !!git[4]), truncated: false }));
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(?:\/(commits|zipball)\/(.+))?$/.exec(req.url!);
    // The zipball redirect names the repo, as GitHub's codeload URL does.
    const zip = /^\/zip\/([^/]+\/[^/]+)\/([0-9a-f]{40})$/.exec(req.url!);
    if (zip) {
      if (zip[2] === SHA_HUGE) {
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
      const files = repoOf(zip[1])?.repo.trees[zip[2]];
      if (!files) return json(404, { message: 'Not Found' });
      // Like `git archive`: a symlink is a mode 120000 entry holding its target; a submodule is left out.
      const bytes = buildZip(
        Object.entries(files).filter(([, text]) => text !== SUBMODULE).map(([path, text]) => ({
          path: `owner-repo-${zip[2].slice(0, 7)}/${path}`,
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
    const found = m ? repoOf(m[1]) : undefined;
    if (!m || !found) return json(404, { message: 'Not Found' });
    const { key, repo } = found;
    if (!m[2]) return json(200, { full_name: key, default_branch: repo.default_branch, private: !!repo.private });
    if (m[2] === 'commits') {
      const sha = repo.refs[m[3]] ?? Object.keys(repo.trees).find((s) => s.startsWith(m[3]));
      return sha ? json(200, { sha }) : json(422, { message: 'No commit found' });
    }
    return res.writeHead(302, { location: `/zip/${key}/${m[3]}` }).end();
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
  const r = await pack(t, h, 'My Kit.zip', PLUGIN, { group: 'kit', visibility: 'public', frontmatterErrors: 'skip' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['agent:reviewer', 'command:ship', 'skill:pdf']);
  assert.deepEqual(r.json.skipped, [{ path: 'skills/broken', reason: 'frontmatter description is required' }]);
  assert.equal(r.json.group.slug, 'kit');
  assert.equal(r.json.group.name, 'kit', "the plugin manifest's name, over the zip name");
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
  const r = await pack(t, h, 'kit.zip', PLUGIN, { group: 'kit', frontmatterErrors: 'skip' });
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

test('github import: url -> pinned commit, provenance, note, group named after the plugin, path subtree', async () => {
  gh.repos['acme/kit'] = { default_branch: 'main', refs: { main: SHA_A, 'v1.0': SHA_A }, trees: { [SHA_A]: PLUGIN } };
  const { t, h } = setup();
  const r = await github(t, h, { url: 'https://github.com/acme/kit', group: 'acme-kit', frontmatterErrors: 'skip' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['agent:reviewer', 'command:ship', 'skill:pdf']);
  assert.deepEqual(r.json.source, { kind: 'github', repo: 'acme/kit', ref: 'main', path: null, commit: SHA_A });
  assert.equal(r.json.group.name, 'kit', "the plugin manifest's name, over the repo");
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
  const first = await github(t, h, { repo: 'acme/again', frontmatterErrors: 'skip' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(names(first.json.items), ['command:ship', 'skill:pdf']);
  assert.deepEqual(first.json.skipped.map((s: { path: string; reason: string }) => [s.path, /name_taken|already have/.test(s.reason)]), [['skills/broken', false], ['agents/reviewer.md', true]]);
  const pdfId = first.json.items.find((i: { name: string }) => i.name === 'pdf').id;

  const same = await github(t, h, { repo: 'acme/again', frontmatterErrors: 'skip' });
  assert.equal(same.status, 201, same.text);
  const samePdf = same.json.items.find((i: { name: string }) => i.name === 'pdf');
  assert.equal(samePdf.id, pdfId);
  assert.equal(samePdf.latestSeq, 1, 'identical content adds no version');

  gh.repos['acme/again'].refs.main = SHA_B;
  const next = await github(t, h, { repo: 'acme/again', frontmatterErrors: 'skip' });
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

test('re-import of a unit renamed upstream is a new unit: never versions the item that kept the old name, prefixed or not; source/update keeps an unprefixed name only when upstream does', async () => {
  // A skill renamed upstream (old -> new, its name its install folder) is created beside the item that kept the old name.
  gh.repos['acme/renamed'] = { default_branch: 'main', refs: { main: sha2('e1') }, trees: { [sha2('e1')]: { 'skills/s/SKILL.md': skill('old') }, [sha2('e2')]: { 'skills/s/SKILL.md': skill('new') } } };
  const { t, h } = setup();
  const r1 = await github(t, h, { repo: 'acme/renamed' });
  assert.deepEqual(names(r1.json.items), ['skill:old']);
  gh.repos['acme/renamed'].refs.main = sha2('e2');
  const r2 = await github(t, h, { repo: 'acme/renamed' });
  assert.equal(r2.status, 201, r2.text);
  assert.deepEqual(r2.json.items.map((i: { name: string; op: string }) => [i.name, i.op]), [['new', 'create']]);
  assert.deepEqual(r2.json.skipped, []);
  const rows = t.db.prepare("SELECT name, latest_seq FROM items WHERE kind = 'skill' ORDER BY name").all() as { name: string; latest_seq: number }[];
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ name: 'new', latest_seq: 1 }, { name: 'old', latest_seq: 1 }]);

  // An unprefixed name that merely ends in -<new name> is not a prefix: pdf-tools renamed to tools is not
  // rewritten back to pdf-tools, on source/update (its skill.name.dir lint refuses it) or on re-import.
  const tools = (name: string): Files => ({ 'skills/pdf-tools/SKILL.md': skill(name) });
  gh.repos['acme/kit'] = { default_branch: 'main', refs: { main: sha2('e3') }, trees: { [sha2('e3')]: tools('pdf-tools'), [sha2('e4')]: tools('tools') } };
  const t2 = setup();
  const k1 = await github(t2.t, t2.h, { repo: 'acme/kit' });
  assert.deepEqual(names(k1.json.items), ['skill:pdf-tools']);
  gh.repos['acme/kit'].refs.main = sha2('e4');
  const up = await t2.t.req('POST', `${API}/items/${k1.json.items[0].id}/source/update`, { headers: t2.h });
  assert.equal(up.status, 422, up.text);
  assert.match(up.text, /frontmatter name 'tools' must equal the item name 'pdf-tools'/);
  const k2 = await github(t2.t, t2.h, { repo: 'acme/kit' });
  assert.equal(k2.status, 201, k2.text);
  assert.deepEqual(k2.json.items.map((i: { name: string; op: string }) => [i.name, i.op]), [['tools', 'create']]);
  assert.equal(await fileText(t2.t, t2.h, k1.json.items[0].id, 'SKILL.md'), skill('pdf-tools'));

  // A prefixed item renamed upstream is a new unit too: a-access is not versioned with 'entry'.
  const t3 = setup();
  const plug = (b: string, name: string): Files => ({ [`plugins/${b}/.claude-plugin/plugin.json`]: '{}', [`plugins/${b}/skills/access/SKILL.md`]: skill(name) });
  const p1 = await pack(t3.t, t3.h, 'official.zip', { ...plug('a', 'access'), ...plug('b', 'access') });
  assert.deepEqual(names(p1.json.items), ['skill:a-access', 'skill:b-access']);
  const p2 = await pack(t3.t, t3.h, 'official.zip', { ...plug('a', 'entry'), ...plug('b', 'access') });
  assert.equal(p2.status, 201, p2.text);
  assert.deepEqual(p2.json.items.map((i: { name: string; op: string }) => [i.name, i.op]), [['entry', 'create'], ['b-access', 'unchanged']]);
  assert.equal(count(t3.t, "SELECT COUNT(*) AS n FROM items WHERE name = 'a-access' AND latest_seq = 1"), 1);

  // A plugin-folder prefix (inside one import) is kept by source/update, as a repository-name one is.
  const twin = (desc: string): Files => ({ ...plug('a', 'access'), 'plugins/a/skills/access/SKILL.md': skill('access', desc), ...plug('b', 'access') });
  gh.repos['acme/twin'] = { default_branch: 'main', refs: { main: sha2('e5') }, trees: { [sha2('e5')]: twin('v1'), [sha2('e6')]: twin('v2') } };
  const t4 = setup();
  const g1 = await github(t4.t, t4.h, { repo: 'acme/twin' });
  assert.deepEqual(names(g1.json.items), ['skill:a-access', 'skill:b-access']);
  gh.repos['acme/twin'].refs.main = sha2('e6');
  const a = byName(g1.json.items, 'a-access');
  const up2 = await t4.t.req('POST', `${API}/items/${a.id}/source/update`, { headers: t4.h });
  assert.equal(up2.status, 200, up2.text);
  assert.equal(await fileText(t4.t, t4.h, a.id, 'SKILL.md'), skill('access', 'v2').replace('name: access', 'name: a-access'));
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
  const r = await pack(t, h, 'broken.zip', { 'skills/broken/SKILL.md': PLUGIN['skills/broken/SKILL.md'] }, { group: 'empty-kit', frontmatterErrors: 'skip' });
  assert.equal(r.status, 422, r.text);
  assert.equal(r.json.error.code, 'nothing_imported');
  assert.match(r.json.error.details[0].reason, /description is required/);
  assert.equal(r.json.error.details[0].path, 'skills/broken');
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM scp_groups').get() as { n: number }).n, 0);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM deleted_group_slugs').get() as { n: number }).n, 0, 'the slug is not burnt');
  assert.equal((await t.req('POST', `${API}/groups`, { headers: h, json: { slug: 'empty-kit', name: 'G' } })).status, 201);
  // Without a group too: a 201 with items: [] reads as success to any client branching on 2xx.
  const loose = await pack(t, h, 'broken2.zip', { 'skills/broken/SKILL.md': PLUGIN['skills/broken/SKILL.md'] }, { frontmatterErrors: 'skip' });
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
  gh.repos['acme/tok'] = { default_branch: 'main', refs: { main: sha2('e7') }, trees: { [sha2('e7')]: { 'SKILL.md': skill('tok') } } };
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

const TASTE_DESC = 'Design taste for agents: rules that keep UI work from looking generated.';
/** The shape of Leonxlnx/taste-skill (probe 2026-10-22): a plugin manifest with more than SCP reads. */
const TASTE: Files = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'taste-skill', version: '2.1.4', description: TASTE_DESC, author: { name: 'Leon' }, license: 'MIT', homepage: 'https://example.com/taste' }),
  'skills/taste/SKILL.md': skill('taste'),
  'README.md': '# taste-skill\n',
};
const withManifest = (files: Files, manifest: unknown, path = '.claude-plugin/plugin.json'): Files => ({ ...files, [path]: typeof manifest === 'string' ? manifest : JSON.stringify(manifest) });
const marketplace = (plugins: unknown[]) => JSON.stringify({ name: 'market', owner: { name: 'o' }, plugins });
async function servedPluginJson(t: TestCtx, h: H, slug: string) {
  const r = await t.req('GET', `${API}/groups/${slug}/plugin.zip`, { headers: h });
  assert.equal(r.status, 200, r.text);
  const files = unzipSync(r.bytes);
  return { files: Object.keys(files).sort(), plugin: JSON.parse(strFromU8(files['.claude-plugin/plugin.json'])), mcp: JSON.parse(strFromU8(files['.mcp.json'])) };
}

test('5w3w: a plugin import with a group takes the description from the manifest, and plugin.zip serves it (pack and GitHub)', async () => {
  const { t, h } = setup();
  const r = await pack(t, h, 'taste-skill-main.zip', TASTE, { group: 'taste' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.group.description, TASTE_DESC);
  assert.equal(r.json.group.name, 'taste-skill', "the manifest's name when it has no displayName, not the zip name");
  assert.deepEqual(r.json.skipped, []);
  const served = await servedPluginJson(t, h, 'taste');
  assert.equal(served.plugin.name, 'taste');
  assert.equal(served.plugin.description, TASTE_DESC);

  gh.repos['leon/taste-skill'] = { default_branch: 'main', refs: { main: sha2('3a') }, trees: { [sha2('3a')]: withManifest(TASTE, { name: 'taste-skill', displayName: '  Taste Skill  ', description: TASTE_DESC }) } };
  const t2 = setup();
  const g = await github(t2.t, t2.h, { repo: 'leon/taste-skill', group: 'taste' });
  assert.equal(g.status, 201, g.text);
  assert.deepEqual([g.json.group.name, g.json.group.description], ['Taste Skill', TASTE_DESC], 'displayName, trimmed, names the group');
  assert.equal((await servedPluginJson(t2.t, t2.h, 'taste')).plugin.description, TASTE_DESC);
});

test('5w3w: a request groupName overrides the manifest displayName; the description still comes from the manifest', async () => {
  const named = withManifest(TASTE, { name: 'taste-skill', displayName: 'Taste Skill', description: TASTE_DESC });
  const { t, h } = setup();
  const r = await pack(t, h, 'taste.zip', named, { group: 'taste', groupName: 'My Taste' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.group.name, r.json.group.description], ['My Taste', TASTE_DESC]);
  gh.repos['leon/taste-named'] = { default_branch: 'main', refs: { main: sha2('3b') }, trees: { [sha2('3b')]: named } };
  const t2 = setup();
  const g = await github(t2.t, t2.h, { repo: 'leon/taste-named', group: 'taste', groupName: 'Ours' });
  assert.equal(g.status, 201, g.text);
  assert.deepEqual([g.json.group.name, g.json.group.description], ['Ours', TASTE_DESC]);
});

test('5w3w: a single-plugin marketplace.json with no plugin.json names the group; a multi-plugin one does not; Codex plugin.json is read too', async () => {
  const base: Files = { 'skills/s/SKILL.md': skill('s') };
  const { t, h } = setup();
  const single = await pack(t, h, 'one.zip', withManifest(base, marketplace([{ name: 'solo', displayName: 'Solo', source: './', description: 'From the marketplace.' }]), '.claude-plugin/marketplace.json'), { group: 'one' });
  assert.equal(single.status, 201, single.text);
  assert.deepEqual([single.json.group.name, single.json.group.description], ['Solo', 'From the marketplace.']);
  const t2 = setup();
  const multi = await pack(t2.t, t2.h, 'two.zip', withManifest(base, marketplace([{ name: 'a', source: './', description: 'A' }, { name: 'b', source: './', description: 'B' }]), '.claude-plugin/marketplace.json'), { group: 'two' });
  assert.equal(multi.status, 201, multi.text);
  assert.deepEqual([multi.json.group.name, multi.json.group.description], ['two', '']);
  const t3 = setup();
  const codex = await pack(t3.t, t3.h, 'cx.zip', withManifest(base, { name: 'cx', description: 'Codex plugin.' }, '.codex-plugin/plugin.json'), { group: 'cx' });
  assert.equal(codex.json.group.description, 'Codex plugin.');
  // plugin.json comes first.
  const t4 = setup();
  const both = await pack(t4.t, t4.h, 'both.zip', withManifest(withManifest(base, { description: 'Plugin.' }), marketplace([{ name: 'm', source: './', description: 'Market.' }]), '.claude-plugin/marketplace.json'), { group: 'both' });
  assert.equal(both.json.group.description, 'Plugin.');
});

test('5w3w: a malformed, non-object, oversize or wrongly typed manifest falls back to today, with a skipped entry, never a 4xx/5xx', async () => {
  const P = '.claude-plugin/plugin.json';
  const cases: [unknown, string[]][] = [
    ['{"name": "taste", ', ['plugin manifest ignored: not valid JSON']],
    ['["taste"]', ['plugin manifest ignored: not a JSON object']],
    ['"taste"', ['plugin manifest ignored: not a JSON object']],
    ['null', ['plugin manifest ignored: not a JSON object']],
    [`{"description":"${noise(1.01)}"}`, ['plugin manifest ignored: larger than 1024 KB']],
    [{ description: 'x'.repeat(2001) }, ["plugin manifest field ignored: 'description' is longer than 2000 characters"]],
    [{ displayName: 'x'.repeat(101), description: 'Fine.' }, ["plugin manifest field ignored: 'displayName' is longer than 100 characters"]],
    [{ displayName: ['Taste'], description: 42 }, ["plugin manifest field ignored: 'displayName' is not a string", "plugin manifest field ignored: 'description' is not a string"]],
  ];
  for (const [manifest, reasons] of cases) {
    const { t, h } = setup();
    const r = await pack(t, h, 'taste.zip', withManifest(TASTE, manifest), { group: 'taste' });
    const label = String(typeof manifest === 'string' ? manifest : JSON.stringify(manifest)).slice(0, 60);
    assert.equal(r.status, 201, `${label}: ${r.text.slice(0, 300)}`);
    assert.deepEqual(r.json.skipped, reasons.map((reason) => ({ path: P, reason })), label);
    assert.equal(r.json.group.name, 'taste', label);
    assert.equal(r.json.group.description, (manifest as { description?: unknown }).description === 'Fine.' ? 'Fine.' : '', label);
    assert.deepEqual(names(r.json.items), ['skill:taste'], label);
  }
  // A broken marketplace.json is reported by detection, once, group or not.
  const { t, h } = setup();
  const m = await pack(t, h, 'm.zip', withManifest({ 'skills/s/SKILL.md': skill('s') }, '{oops', '.claude-plugin/marketplace.json'), { group: 'mk' });
  assert.equal(m.status, 201, m.text);
  assert.deepEqual(m.json.skipped, [{ path: '.claude-plugin/marketplace.json', reason: 'marketplace manifest ignored: not valid JSON' }]);
  assert.equal(m.json.group.description, '');
});

test('5w3w: imports without a group are unchanged: no manifest is read and none is reported', async () => {
  const { t, h } = setup();
  const r = await pack(t, h, 'taste.zip', TASTE);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.group, r.json.skipped], [null, []]);
  const bad = await pack(t, h, 'bad.zip', withManifest({ 'skills/b/SKILL.md': skill('b') }, '{nope'));
  assert.equal(bad.status, 201, bad.text);
  assert.deepEqual([bad.json.group, bad.json.skipped], [null, []]);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM scp_groups').get() as { n: number }).n, 0);
});

const agentMd = (name: string) => `---\nname: ${name}\ndescription: The ${name} agent.\n---\nYou are ${name}.\n`;
/** A marketplace repository: plugin a has its own plugin.json, plugin b is only a marketplace source. */
const MARKET: Files = {
  '.claude-plugin/marketplace.json': marketplace([
    { name: 'b', source: './plugins/b' },
    { name: 'ext', source: { source: 'github', repo: 'other/repo' } },
    { name: 'url', source: 'https://example.com/p.git' },
    { name: 'bare', source: 'plugins/b' },
    { name: 'up', source: './../outside' },
    { name: 'deep', source: './plugins/../../x' },
  ]),
  'plugins/a/.claude-plugin/plugin.json': '{"name":"a"}',
  'plugins/a/agents/x.md': agentMd('x-agent'),
  'plugins/a/agents/sub/deep.md': agentMd('deep'),
  'plugins/a/commands/y.md': 'Do y.\n',
  'plugins/a/skills/z/SKILL.md': skill('z'),
  'plugins/a/README.md': '# a\n',
  'plugins/b/agents/w.md': agentMd('w-agent'),
  'plugins/b/commands/v.md': 'Do v.\n',
  'tools/agents/stray.md': agentMd('stray'),
  'tools/commands/loose.md': 'Loose.\n',
  'README.md': '# Market\n',
};
const MARKET_SKIPPED = [
  { path: '.claude-plugin/marketplace.json', reason: "plugin 'ext': source github other/repo is not a path in this repository; not followed" },
  { path: '.claude-plugin/marketplace.json', reason: "plugin 'url': source 'https://example.com/p.git' is not a path in this repository; not followed" },
  { path: '.claude-plugin/marketplace.json', reason: "plugin 'bare': source 'plugins/b' is not a path in this repository; not followed" },
  { path: '.claude-plugin/marketplace.json', reason: "plugin 'up': source './../outside' escapes the repository; not followed" },
  { path: '.claude-plugin/marketplace.json', reason: "plugin 'deep': source './plugins/../../x' escapes the repository; not followed" },
  { path: 'plugins/a/agents/sub/deep.md', reason: 'nested under plugins/a/agents/: only plugins/a/agents/*.md is imported' },
  { path: 'tools/agents/stray.md', reason: 'agents/ below the repository root is imported only inside a plugin (.claude-plugin/plugin.json)' },
  { path: 'tools/commands/loose.md', reason: 'commands/ below the repository root is imported only inside a plugin (.claude-plugin/plugin.json)' },
];
const MARKET_ITEMS = ['agent:w-agent', 'agent:x-agent', 'command:v', 'command:y', 'skill:z'];

test('bppq: nested plugins (their own plugin.json, or a marketplace source) import their agents, commands and skills; foreign and escaping sources are skipped', () => {
  const d = detectUnits(tree(MARKET), 'market');
  assert.deepEqual(d.units.map((u) => [u.kind, u.path]), [
    ['skill', 'plugins/a/skills/z'],
    ['agent', 'plugins/a/agents/x.md'],
    ['command', 'plugins/a/commands/y.md'],
    ['agent', 'plugins/b/agents/w.md'],
    ['command', 'plugins/b/commands/v.md'],
  ]);
  assert.equal(d.units[2].name, 'y', 'a command is named by its file, as at the root');
  assert.deepEqual(d.skipped, MARKET_SKIPPED);
  // A nested plugin claims its own files before the plugin around it.
  const nested = detectUnits(tree({ '.claude-plugin/plugin.json': '{}', 'agents/top.md': agentMd('top'), 'agents/inner/.claude-plugin/plugin.json': '{}', 'agents/inner/agents/i.md': agentMd('i') }), 'x');
  assert.deepEqual(nested.units.map((u) => [u.kind, u.path]), [['agent', 'agents/inner/agents/i.md'], ['agent', 'agents/top.md']]);
  // A marketplace source at the root ('./') is the root: nothing changes.
  assert.deepEqual(detectUnits(tree({ '.claude-plugin/marketplace.json': marketplace([{ name: 'r', source: './' }]), 'agents/r.md': agentMd('r') }), 'x').units.map((u) => u.path), ['agents/r.md']);
  // Linear in plugin roots too: each root's layout folders come from the folder index, not a scan of the tree.
  const many: Files = {};
  for (let i = 0; i < 5000; i++) Object.assign(many, { [`p/${i}/.claude-plugin/plugin.json`]: '{}', [`p/${i}/agents/a${i}.md`]: agentMd(`a${i}`), [`p/${i}/docs/n.md`]: 'n' });
  const start = performance.now();
  const big = detectUnits(tree(many), 'many');
  assert.equal(big.units.length, 5000);
  assert.equal(big.skipped.length, 5000);
  assert.ok(performance.now() - start < 1000, `took ${Math.round(performance.now() - start)} ms`);
});

test('bppq: a marketplace repository imports every nested plugin through the pack and GitHub routes; two plugins shipping one agent name both import, prefixed (7k2p)', async () => {
  const { t, h } = setup();
  const r = await pack(t, h, 'market.zip', MARKET);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), MARKET_ITEMS);
  assert.deepEqual(r.json.skipped, MARKET_SKIPPED);
  assert.equal(r.json.items.find((i: { name: string }) => i.name === 'x-agent').source.path, 'plugins/a/agents/x.md');

  gh.repos['acme/market'] = { default_branch: 'main', refs: { main: sha2('3c') }, trees: { [sha2('3c')]: MARKET } };
  const t2 = setup();
  const g = await github(t2.t, t2.h, { repo: 'acme/market' });
  assert.equal(g.status, 201, g.text);
  assert.deepEqual(names(g.json.items), MARKET_ITEMS);
  assert.deepEqual(g.json.skipped, MARKET_SKIPPED);

  // claude-plugins-official ships the same agent name in two plugins: each takes its plugin folder as prefix, as skills do.
  const t3 = setup();
  const clash = await pack(t3.t, t3.h, 'clash.zip', {
    'plugins/a/.claude-plugin/plugin.json': '{}',
    'plugins/a/agents/reviewer.md': AGENT,
    'plugins/b/.claude-plugin/plugin.json': '{}',
    'plugins/b/agents/reviewer.md': AGENT,
    'plugins/b/commands/go.md': 'Go.\n',
    'README.md': '# Clash\n',
  });
  assert.equal(clash.status, 201, clash.text);
  assert.deepEqual(names(clash.json.items), ['agent:a-reviewer', 'agent:b-reviewer', 'command:go']);
  assert.equal(clash.json.items[0].source.path, 'plugins/a/agents/reviewer.md');
  assert.deepEqual(clash.json.skipped, []);
  // GitHub alike.
  gh.repos['acme/clash'] = { default_branch: 'main', refs: { main: sha2('3f') }, trees: { [sha2('3f')]: { 'plugins/a/.claude-plugin/plugin.json': '{}', 'plugins/a/agents/rev.md': agentMd('rev'), 'plugins/b/.claude-plugin/plugin.json': '{}', 'plugins/b/agents/rev.md': agentMd('rev'), 'README.md': '#\n' } } };
  const gc = await github(t3.t, t3.h, { repo: 'acme/clash' });
  assert.equal(gc.status, 201, gc.text);
  assert.deepEqual(names(gc.json.items), ['agent:a-rev', 'agent:b-rev']);
  assert.deepEqual(gc.json.skipped, []);
});

test('bppq: source/update of a nested-plugin agent and command re-carves them the same way', async () => {
  const next = { ...MARKET, 'plugins/a/agents/x.md': agentMd('x-agent') + 'Now better.\n', 'plugins/b/commands/v.md': 'Do v twice.\n' };
  gh.repos['acme/market-live'] = { default_branch: 'main', refs: { main: sha2('3d') }, trees: { [sha2('3d')]: MARKET, [sha2('3e')]: next } };
  const { t, h } = setup();
  const imp = await github(t, h, { repo: 'acme/market-live' });
  assert.equal(imp.status, 201, imp.text);
  gh.repos['acme/market-live'].refs.main = sha2('3e');
  for (const [name, text] of [['x-agent', next['plugins/a/agents/x.md']], ['v', next['plugins/b/commands/v.md']]]) {
    const item = imp.json.items.find((i: { name: string }) => i.name === name);
    const up = await t.req('POST', `${API}/items/${item.id}/source/update`, { headers: h });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.item.version.seq, 2, name);
    const files = up.json.item.version.files as { path: string }[];
    assert.equal(files.length, 1, name);
    const body = await t.req('GET', `${API}/items/${item.id}/files/${files[0].path}`, { headers: h });
    assert.equal(body.text, text, name);
  }
});

test('bppq: source/update of a skill at a plugin root keeps out the agents the import carved; a folder import of it keeps them', async () => {
  const P: Files = { 'plugins/a/.claude-plugin/plugin.json': '{"name":"a"}', 'plugins/a/SKILL.md': skill('a'), 'plugins/a/agents/x.md': agentMd('x'), 'plugins/a/scripts/run.sh': 'echo' };
  gh.repos['acme/plugin-skill'] = { default_branch: 'main', refs: { main: sha2('b5') }, trees: { [sha2('b5')]: P, [sha2('b6')]: { ...P, 'plugins/a/SKILL.md': skill('a', 'Better.') } } };
  const files = (it: { version: { files: { path: string }[] } }) => it.version.files.map((f) => f.path);
  const update = async (path?: string) => {
    gh.repos['acme/plugin-skill'].refs.main = sha2('b5');
    const { t, h } = setup();
    const imp = await github(t, h, { repo: 'acme/plugin-skill', path });
    assert.equal(imp.status, 201, imp.text);
    const sk = imp.json.items.find((i: { kind: string }) => i.kind === 'skill');
    gh.repos['acme/plugin-skill'].refs.main = sha2('b6');
    const up = await t.req('POST', `${API}/items/${sk.id}/source/update`, { headers: h });
    assert.equal(up.status, 200, up.text);
    return [names(imp.json.items), files(sk), files(up.json.item)];
  };
  const carved = ['.claude-plugin/plugin.json', 'SKILL.md', 'scripts/run.sh'];
  assert.deepEqual(await update(), [['agent:x', 'skill:a'], carved, carved]);
  const whole = ['.claude-plugin/plugin.json', 'SKILL.md', 'agents/x.md', 'scripts/run.sh'];
  assert.deepEqual(await update('plugins/a'), [['skill:a'], whole, whole]);
});

test('5w3w: a bad marketplace.json is reported once when no detection pass reads it (a folder zip, a kind override)', async () => {
  const bad: Files = { 'SKILL.md': skill('mine'), '.claude-plugin/marketplace.json': '{oops' };
  const expected = [{ path: '.claude-plugin/marketplace.json', reason: 'marketplace manifest ignored: not valid JSON' }];
  const { t, h } = setup();
  const z = await pack(t, h, 'my-plugin.zip', Object.fromEntries(Object.entries(bad).map(([k, v]) => [`my-plugin/${k}`, v])), { group: 'mp' });
  assert.equal(z.status, 201, z.text);
  assert.deepEqual(z.json.skipped, expected);
  gh.repos['acme/bad-market'] = { default_branch: 'main', refs: { main: sha2('b7') }, trees: { [sha2('b7')]: bad } };
  const t2 = setup();
  const g = await github(t2.t, t2.h, { repo: 'acme/bad-market', kind: 'skill', group: 'kk' });
  assert.equal(g.status, 201, g.text);
  assert.deepEqual(g.json.skipped, expected);
  // Without a group the manifest is not read for metadata, so these imports stay as they were.
  const t3 = setup();
  assert.deepEqual((await github(t3.t, t3.h, { repo: 'acme/bad-market', kind: 'skill' })).json.skipped, []);
});

test('dnxq: a plugin\'s hooks, MCP servers, output styles, settings, LSP and monitors are reported in skipped, once each; nothing else changes', async () => {
  const HOOKED: Files = {
    '.claude-plugin/plugin.json': '{"name":"hooked"}',
    'skills/h/SKILL.md': skill('h'),
    'hooks/hooks.json': '{"hooks":{}}',
    'hooks/run.sh': '#!/bin/sh\necho pwned\n',
    '.mcp.json': '{"mcpServers":{"evil":{"command":"sh"}}}',
    'output-styles/terse.md': '# Terse\n',
    'output-styles/loud.md': '# Loud\n',
    'plugins/n/.claude-plugin/plugin.json': '{"name":"n"}',
    'plugins/n/commands/go.md': 'Go.\n',
    'plugins/n/settings.json': '{}',
    'plugins/n/.lsp.json': '{}',
    'plugins/n/monitors/m.json': '{}',
  };
  const reason = (c: string) => `plugin ${c} is not supported by SCP; it was not imported`;
  const expected = [
    { path: '.mcp.json', reason: reason('.mcp.json') },
    { path: 'hooks', reason: reason('hooks/') },
    { path: 'output-styles', reason: reason('output-styles/') },
    { path: 'plugins/n/.lsp.json', reason: reason('.lsp.json') },
    { path: 'plugins/n/monitors', reason: reason('monitors/') },
    { path: 'plugins/n/settings.json', reason: reason('settings.json') },
  ];
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  assert.deepEqual(detectUnits(tree(HOOKED), 'hooked').skipped.sort(byPath), expected);
  const { t, h } = setup();
  const r = await pack(t, h, 'hooked.zip', HOOKED, { group: 'hooked' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['command:go', 'skill:h']);
  assert.deepEqual(r.json.items.find((i: { name: string }) => i.name === 'h').version.files.map((f: { path: string }) => f.path), ['SKILL.md']);
  assert.deepEqual([...r.json.skipped].sort(byPath), expected);
  // Served: SCP's own .mcp.json only, no hooks or output styles.
  const served = await servedPluginJson(t, h, 'hooked');
  assert.deepEqual(served.files, ['.claude-plugin/plugin.json', '.mcp.json', 'commands/go.md', 'skills/h/SKILL.md']);
  assert.deepEqual(Object.keys(served.mcp.mcpServers), ['scp-hooked']);
  // Outside a plugin these are ordinary files: an .mcp.json or settings.json is not reported, an .md is told as before.
  const plain = detectUnits(tree({ 'skills/p/SKILL.md': skill('p'), '.mcp.json': '{}', 'settings.json': '{}', 'output-styles/x.md': '# x' }), 'plain');
  assert.deepEqual(plain.skipped, [{ path: 'output-styles/x.md', reason: 'not inside a recognised layout folder' }]);
});

const unitsOf = (d: { units: { kind: string; path: string }[] }) => d.units.map((u) => [u.kind, u.path]);
/** A plugin whose manifest names its components outside SCP's folder conventions. */
const ODD: Files = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'odd', skills: ['./src/my-skill', './plugin-skills/', './skills/c'], commands: './cmds', agents: ['./bots/helper.md'] }),
  'src/my-skill/SKILL.md': skill('my-skill'),
  'src/my-skill/lib/run.py': 'print(1)\n',
  'plugin-skills/a/SKILL.md': skill('a'),
  'plugin-skills/b/SKILL.md': skill('b'),
  'cmds/deploy.md': 'Deploy it.\n',
  'cmds/README.md': '# Commands\n',
  'bots/helper.md': agentMd('helper'),
  'bots/other.md': agentMd('other'),
  'skills/c/SKILL.md': skill('c'),
  'agents/x.md': agentMd('x-agent'),
  'README.md': '# Odd\n',
};

test('4ky8: skills, commands and agents at non-standard manifest paths import as their kinds; conventions pick up the rest once', async () => {
  const d = detectUnits(tree(ODD), 'odd');
  assert.deepEqual(unitsOf(d), [
    ['skill', 'src/my-skill'],
    ['skill', 'plugin-skills/a'],
    ['skill', 'plugin-skills/b'],
    ['skill', 'skills/c'],
    ['agent', 'bots/helper.md'],
    ['command', 'cmds/deploy.md'],
    ['agent', 'agents/x.md'],
  ]);
  assert.deepEqual(d.units[0].tree.map((f) => f.path).sort(), ['SKILL.md', 'lib/run.py']);
  assert.equal(d.units[5].name, 'deploy', 'a declared command is named by its file');
  // An undeclared file in a declared agent's folder is not an item; a README in a declared command folder is docs.
  assert.deepEqual(d.skipped, [
    { path: 'cmds/README.md', reason: 'repository documentation, not an item' },
    { path: 'bots/other.md', reason: 'not inside a recognised layout folder' },
  ]);
  const { t, h } = setup();
  const r = await pack(t, h, 'odd.zip', ODD);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['agent:helper', 'agent:x-agent', 'command:deploy', 'skill:a', 'skill:b', 'skill:c', 'skill:my-skill']);
  // A marketplace entry's own paths are relative to its source.
  const market = detectUnits(tree({ '.claude-plugin/marketplace.json': marketplace([{ name: 'm', source: './p/m', commands: ['./ops/go.md'] }]), 'p/m/ops/go.md': 'Go.\n' }), 'x');
  assert.deepEqual(unitsOf(market), [['command', 'p/m/ops/go.md']]);
});

test('4ky8: escaping, absolute and missing manifest paths are skipped with a reason; the rest imports', async () => {
  const P = '.claude-plugin/plugin.json';
  const files = withManifest({ 'skills/ok/SKILL.md': skill('ok'), 'cmds/go.md': 'Go.\n', 'escape/SKILL.md': skill('escape') }, {
    skills: ['../escape', '/etc', 'C:/x', 'a\\b', './nowhere', 7],
    commands: ['./cmds', './cmds/../../up'],
    agents: { path: './bots' },
  });
  const d = detectUnits(tree(files), 'p');
  // escape/ is still a skill: the generic SKILL.md pass finds it, as without a manifest.
  assert.deepEqual(unitsOf(d), [['command', 'cmds/go.md'], ['skill', 'skills/ok'], ['skill', 'escape']]);
  const expected = [
    { path: P, reason: "skills path '../escape' escapes the plugin; not followed" },
    { path: P, reason: "skills path '/etc' is not relative to the plugin; not followed" },
    { path: P, reason: "skills path 'C:/x' is not relative to the plugin; not followed" },
    { path: P, reason: "skills path 'a\\b' is not relative to the plugin; not followed" },
    { path: P, reason: "skills path './nowhere' holds no SKILL.md; not imported" },
    { path: P, reason: "skills path '7' is not a path" },
    { path: P, reason: "'agents' is not a path or a list of paths" },
    { path: P, reason: "commands path './cmds/../../up' escapes the plugin; not followed" },
  ];
  assert.deepEqual(d.skipped, expected);
  // A nested plugin cannot reach its parent's files either.
  const nested = detectUnits(tree({ 'plugins/n/.claude-plugin/plugin.json': JSON.stringify({ agents: '../../agents/top.md' }), 'agents/top.md': agentMd('top') }), 'x');
  assert.deepEqual(nested.skipped, [{ path: 'plugins/n/.claude-plugin/plugin.json', reason: "agents path '../../agents/top.md' escapes the plugin; not followed" }]);
  const { t, h } = setup();
  const r = await pack(t, h, 'bad-paths.zip', files);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['command:go', 'skill:escape', 'skill:ok']);
  assert.deepEqual(r.json.skipped, expected);
});

test('4ky8: a remote marketplace source is skipped with a reason and never fetched', async () => {
  const files: Files = {
    '.claude-plugin/marketplace.json': marketplace([
      { name: 'local', source: './plugins/local' },
      { name: 'gh', source: { source: 'github', repo: 'far/away' }, skills: ['./skills/x'] },
      { name: 'sub', source: { source: 'git-subdir', url: 'https://example.com/far.git', path: 'p' } },
    ]),
    'plugins/local/commands/go.md': 'Go.\n',
  };
  gh.repos['acme/remote-src'] = { default_branch: 'main', refs: { main: sha2('8a') }, trees: { [sha2('8a')]: files } };
  const { t, h } = setup();
  const from = gh.requests.length;
  const r = await github(t, h, { repo: 'acme/remote-src' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['command:go']);
  assert.deepEqual(r.json.skipped.map((s: { reason: string }) => s.reason), [
    "plugin 'gh': source github far/away is not a path in this repository; not followed",
    "plugin 'sub': source git-subdir https://example.com/far.git is not a path in this repository; not followed",
  ]);
  const urls = gh.requests.slice(from).map((q) => q.url);
  assert.ok(urls.every((u) => u.startsWith('/repos/acme/remote-src') || u.startsWith('/zip/')), urls.join(' '));
  assert.equal(urls.length, 4, 'metadata, commit, zipball redirect, zip: nothing for the remote sources');
});

test("4ky8: taste-skill's real manifest (a skills path naming its conventional folder) imports exactly as without it", async () => {
  const real: Files = { ...TASTE, 'skills/taste-skill/SKILL.md': skill('taste') };
  delete real['skills/taste/SKILL.md'];
  const withPaths = withManifest(real, { name: 'taste-skill', description: TASTE_DESC, skills: ['./skills/taste-skill'] });
  assert.deepEqual(detectUnits(tree(withPaths), 'taste'), detectUnits(tree(real), 'taste'));
  const { t, h } = setup();
  const r = await pack(t, h, 'taste.zip', withPaths, { group: 'taste' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([names(r.json.items), r.json.skipped, r.json.group.description], [['skill:taste'], [], TASTE_DESC]);
});

test('4ky8: source/update of a manifest-path skill, command and agent re-carves them the way the import did', async () => {
  const next: Files = { ...ODD, 'src/my-skill/SKILL.md': skill('my-skill', 'Better.'), 'src/my-skill/lib/new.py': 'print(2)\n', 'cmds/deploy.md': 'Deploy twice.\n', 'bots/helper.md': agentMd('helper') + 'More.\n' };
  gh.repos['acme/odd'] = { default_branch: 'main', refs: { main: sha2('8b') }, trees: { [sha2('8b')]: ODD, [sha2('8c')]: next } };
  const { t, h } = setup();
  const imp = await github(t, h, { repo: 'acme/odd' });
  assert.equal(imp.status, 201, imp.text);
  gh.repos['acme/odd'].refs.main = sha2('8c');
  const byName = (n: string) => imp.json.items.find((i: { name: string }) => i.name === n);
  const up = async (n: string) => {
    const r = await t.req('POST', `${API}/items/${byName(n).id}/source/update`, { headers: h });
    assert.equal(r.status, 200, r.text);
    return r.json.item;
  };
  const sk = await up('my-skill');
  assert.deepEqual([sk.description, filePaths(sk).sort()], ['Better.', ['SKILL.md', 'lib/new.py', 'lib/run.py']]);
  for (const n of ['deploy', 'helper']) {
    const it = await up(n);
    assert.equal(filePaths(it).length, 1, n);
    const body = await t.req('GET', `${API}/items/${it.id}/files/${filePaths(it)[0]}`, { headers: h });
    assert.equal(body.text, next[n === 'deploy' ? 'cmds/deploy.md' : 'bots/helper.md'], n);
  }
});

/** The shape of rtk-ai/rtk (survey 2026-10-22): the product, plus the maintainers' own agent tooling. */
const RTK: Files = {
  'skills/rtk/SKILL.md': skill('rtk'),
  '.claude/skills/ship/SKILL.md': skill('ship'),
  '.claude/skills/tdd-rust/SKILL.md': skill('tdd-rust'),
  '.claude/agents/code-simplifier.md': agentMd('code-simplifier'),
  '.claude/commands/release.md': 'Release.\n',
  '.agents/skills/rust-rtk/SKILL.md': skill('rust-rtk'),
  '.gemini/skills/gem/SKILL.md': skill('gem'),
  '.opencode/skills/oc/SKILL.md': skill('oc'),
  'CLAUDE.md': '# Working on rtk\n',
  'AGENTS.md': '# Contributing agents\n',
  'GEMINI.md': '# Gemini rules\n',
  'README.md': '# rtk\n',
};
const RTK_ALL = [
  ['skill', '.claude/skills/ship'],
  ['skill', '.claude/skills/tdd-rust'],
  ['skill', 'skills/rtk'],
  ['agent', '.claude/agents/code-simplifier.md'],
  ['command', '.claude/commands/release.md'],
  ['skill', '.agents/skills/rust-rtk'],
  ['instructions', 'AGENTS.md'],
  ['instructions', 'CLAUDE.md'],
  // Another tool's ports come after every other unit (ypmn, eg9k).
  ['skill', '.gemini/skills/gem'],
  ['skill', '.opencode/skills/oc'],
];

test('4ky8 part 2: a repository that ships a plugin or a skills/ folder skips its maintainer tooling, listed in skipped; includeRepoTooling imports it all', async () => {
  const plugin = withManifest(RTK, { name: 'rtk' });
  const why = (signal: string) => `maintainer tooling (repo ships ${signal})`;
  const dirs = ['.claude/skills', '.claude/agents', '.claude/commands', '.agents/skills', '.gemini/skills', '.opencode/skills'];
  const p = detectUnits(tree(plugin), 'rtk');
  assert.deepEqual(unitsOf(p), [['skill', 'skills/rtk']]);
  const pluginSkips = [...dirs, 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].map((path) => ({ path, reason: why('a plugin') }));
  assert.deepEqual(p.skipped, pluginSkips);
  // A skills/ folder alone: the tool folders go, the root instructions stay (they may be the product).
  const s = detectUnits(tree(RTK), 'rtk');
  assert.deepEqual(unitsOf(s), [['skill', 'skills/rtk'], ['instructions', 'AGENTS.md'], ['instructions', 'CLAUDE.md']]);
  assert.deepEqual(s.skipped.slice(0, dirs.length), dirs.map((path) => ({ path, reason: why('a skills/ folder') })));
  assert.deepEqual(s.skipped.slice(dirs.length), [{ path: 'GEMINI.md', reason: 'not inside a recognised layout folder' }], 'GEMINI.md is reported as before');
  // includeRepoTooling: today's units.
  assert.deepEqual(unitsOf(detectUnits(tree(plugin), 'rtk', { includeRepoTooling: true })), RTK_ALL);
  assert.deepEqual(unitsOf(detectUnits(tree(RTK), 'rtk', { includeRepoTooling: true })), RTK_ALL);

  const { t, h } = setup();
  const r = await pack(t, h, 'rtk.zip', plugin);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([names(r.json.items), r.json.skipped], [['skill:rtk'], pluginSkips]);
  const t2 = setup();
  const every = await pack(t2.t, t2.h, 'rtk.zip', plugin, { includeRepoTooling: 'true' });
  assert.equal(every.status, 201, every.text);
  assert.equal(every.json.items.length, RTK_ALL.length);
  assert.deepEqual(every.json.skipped, [{ path: 'GEMINI.md', reason: 'not inside a recognised layout folder' }], 'as today');
  assert.equal((await pack(t2.t, t2.h, 'x.zip', plugin, { includeRepoTooling: 'yes' })).status, 400);

  gh.repos['rtk-ai/rtk'] = { default_branch: 'main', refs: { main: sha2('8d') }, trees: { [sha2('8d')]: plugin } };
  const t3 = setup();
  const g = await github(t3.t, t3.h, { repo: 'rtk-ai/rtk' });
  assert.equal(g.status, 201, g.text);
  assert.deepEqual([names(g.json.items), g.json.skipped], [['skill:rtk'], pluginSkips]);
  const t4 = setup();
  const ga = await github(t4.t, t4.h, { repo: 'rtk-ai/rtk', includeRepoTooling: true });
  assert.equal(ga.status, 201, ga.text);
  assert.equal(ga.json.items.length, RTK_ALL.length);
});

test('4ky8 part 2: a repository with no product signal imports its .claude/ folder and CLAUDE.md exactly as before', () => {
  for (const files of [
    { '.claude/skills/a/SKILL.md': skill('a'), '.claude/agents/x.md': AGENT, '.claude/commands/go.md': 'go', 'CLAUDE.md': '# Rules\n' },
    { 'CLAUDE.md': '# Rules\n', 'src/main.rs': '' },
    { '.agents/skills/b/SKILL.md': skill('b'), 'AGENTS.md': '# Rules\n' },
  ] as Files[]) {
    assert.deepEqual(detectUnits(tree(files), 'r'), detectUnits(tree(files), 'r', { includeRepoTooling: true }), Object.keys(files).join(' '));
    assert.ok(detectUnits(tree(files), 'r').units.length >= 1);
  }
});

test('4ky8 part 2: source/update of a root skill in a plugin repository does not take in the tooling the import skipped', async () => {
  const v1: Files = { '.claude-plugin/plugin.json': '{"name":"solo"}', 'SKILL.md': skill('solo'), 'scripts/a.sh': 'a', 'CLAUDE.md': '# dev\n', '.claude/agents/dev.md': agentMd('dev') };
  const v2: Files = { ...v1, 'SKILL.md': skill('solo', 'v2'), '.claude/skills/new/SKILL.md': skill('new') };
  gh.repos['acme/solo-plugin'] = { default_branch: 'main', refs: { main: sha2('8e') }, trees: { [sha2('8e')]: v1, [sha2('8f')]: v2 } };
  const { t, h } = setup();
  const imp = await github(t, h, { repo: 'acme/solo-plugin' });
  assert.equal(imp.status, 201, imp.text);
  assert.deepEqual(names(imp.json.items), ['skill:solo']);
  const before = filePaths(imp.json.items[0]).sort();
  assert.deepEqual(before, ['.claude-plugin/plugin.json', 'SKILL.md', 'scripts/a.sh']);
  gh.repos['acme/solo-plugin'].refs.main = sha2('8f');
  const up = await t.req('POST', `${API}/items/${imp.json.items[0].id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual([up.json.item.description, filePaths(up.json.item).sort()], ['v2', before]);
});

const portSkill = (name: string, claude: boolean) =>
  `---\nname: ${name}\ndescription: Does ${name} things.\n${claude ? 'allowed-tools: Read, Grep\nargument-hint: <spec>\n' : ''}---\n# ${name}\n${claude ? '!`cat spec.md`\n' : ''}Body.\n`;
/** The shape of Code-My-Spec/plugins (import test 2026-10-22): one skill set, ported to three tools. */
const CMS = (extra = ''): Files => ({
  '.claude-plugin/marketplace.json': marketplace([{ name: 'codemyspec', source: './plugins/codemyspec' }]),
  'antigravity/codemyspec/skills/spec/SKILL.md': portSkill('spec', false),
  'antigravity/codemyspec/skills/plan/SKILL.md': portSkill('plan', false),
  'codex/codemyspec/skills/spec/SKILL.md': portSkill('spec', false),
  'plugins/codemyspec/.claude-plugin/plugin.json': '{"name":"codemyspec"}',
  'plugins/codemyspec/skills/spec/SKILL.md': portSkill('spec', true) + extra,
  'plugins/codemyspec/skills/plan/SKILL.md': portSkill('plan', true),
});
const portReason = (path: string, tool: string) => `another copy of this skill (${path}) was imported; this one is the ${tool} port`;
const CMS_SKIPPED = [
  { path: 'antigravity/codemyspec/skills/plan', reason: portReason('plugins/codemyspec/skills/plan', 'antigravity') },
  { path: 'antigravity/codemyspec/skills/spec', reason: portReason('plugins/codemyspec/skills/spec', 'antigravity') },
  { path: 'codex/codemyspec/skills/spec', reason: portReason('plugins/codemyspec/skills/spec', 'codex') },
];

test('ypmn: a multi-tool repository keeps the Claude Code copy of each skill and skips the ports, saying so', async () => {
  const { t, h } = setup();
  const r = await pack(t, h, 'cms.zip', CMS());
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:plan', 'skill:spec']);
  assert.deepEqual(r.json.items.map((i: { source: { path: string } }) => i.source.path).sort(), ['plugins/codemyspec/skills/plan', 'plugins/codemyspec/skills/spec']);
  assert.deepEqual(r.json.skipped, CMS_SKIPPED);
  // Without a plugin root the ranking alone decides: skills/ folder, then neutral, then ports.
  const loose = detectUnits(tree({ 'antigravity/x/a/SKILL.md': skill('a'), '.openclaw/skills/b/SKILL.md': skill('b'), 'cursor/a/SKILL.md': skill('a'), 'tools/a/SKILL.md': skill('a'), 'pkg/skills/a/SKILL.md': skill('a'), 'sub/.claude/x/b/SKILL.md': skill('b') }), 'x');
  assert.deepEqual(unitsOf(loose).map((u) => u[1]), ['sub/.claude/x/b', 'pkg/skills/a', 'tools/a', 'cursor/a', '.openclaw/skills/b', 'antigravity/x/a']);
  // A skill named for a tool is not a port, and a skill still keeps a better-ranked nested skill as its own files.
  const own = detectUnits(tree({ 'tools/gemini/SKILL.md': skill('gemini'), 'tools/a/SKILL.md': skill('a'), 'tools/a/skills/b/SKILL.md': skill('b') }), 'x');
  assert.deepEqual(unitsOf(own).map((u) => u[1]), ['tools/a', 'tools/gemini']);
  assert.deepEqual(own.units[0].tree.map((f) => f.path).sort(), ['SKILL.md', 'skills/b/SKILL.md']);
  // One copy of each skill: every one imports, ports included.
  const t2 = setup();
  const one = await pack(t2.t, t2.h, 'one.zip', { 'skills/a/SKILL.md': skill('a'), '.openclaw/skills/b/SKILL.md': skill('b'), 'antigravity/c/SKILL.md': skill('c') });
  assert.equal(one.status, 201, one.text);
  assert.deepEqual([names(one.json.items), one.json.skipped], [['skill:a', 'skill:b', 'skill:c'], []]);
});

test('ypmn: re-importing a multi-tool repository updates the same Claude Code copies; their allowed-tools survive', async () => {
  gh.repos['Code-My-Spec/plugins'] = { default_branch: 'main', refs: { main: sha2('9a') }, trees: { [sha2('9a')]: CMS(), [sha2('9b')]: CMS('More.\n') } };
  const { t, h } = setup();
  const first = await github(t, h, { repo: 'Code-My-Spec/plugins' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(first.json.skipped, CMS_SKIPPED);
  gh.repos['Code-My-Spec/plugins'].refs.main = sha2('9b');
  const again = await github(t, h, { repo: 'Code-My-Spec/plugins' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: { name: string; op: string; source: { path: string } }) => [i.name, i.op, i.source.path]).sort(), [
    ['plan', 'unchanged', 'plugins/codemyspec/skills/plan'],
    ['spec', 'version', 'plugins/codemyspec/skills/spec'],
  ]);
  assert.deepEqual(again.json.skipped, CMS_SKIPPED);
  const spec = again.json.items.find((i: { name: string }) => i.name === 'spec');
  const body = await t.req('GET', `${API}/items/${spec.id}/files/SKILL.md`, { headers: h });
  assert.equal(body.text, portSkill('spec', true) + 'More.\n');
  assert.match(body.text, /allowed-tools: Read, Grep/);
});

test('bppq, 4ky8: a hostile manifest (deeply nested values, half a million bad paths) is reported, never a 500 or an unbounded skipped list', async () => {
  const nest = '['.repeat(5000) + ']'.repeat(5000);
  const base: Files = { 'skills/s/SKILL.md': skill('s') };
  const { t, h } = setup();
  const deep = await pack(t, h, 'deep.zip', withManifest(base, `{"skills":[${nest}],"agents":${nest}}`));
  assert.equal(deep.status, 201, deep.text.slice(0, 300));
  assert.deepEqual(deep.json.skipped.map((s: { reason: string }) => s.reason), ["skills path '[...]' is not a path", "agents path '[...]' is not a path"]);
  const t2 = setup();
  const market = await pack(t2.t, t2.h, 'deep-market.zip', withManifest(base, `{"plugins":[{"name":"n","source":{"source":${nest},"repo":${nest}}}]}`, '.claude-plugin/marketplace.json'));
  assert.equal(market.status, 201, market.text.slice(0, 300));
  assert.deepEqual(market.json.skipped.map((s: { reason: string }) => s.reason), ["plugin 'n': source [...] [...] is not a path in this repository; not followed"]);
  // Nearly 1 MB of bad paths: the first 500 are listed, the rest counted.
  const t3 = setup();
  const many = await pack(t3.t, t3.h, 'many.zip', withManifest(base, { skills: Array(300_000).fill(0), commands: Array(50_000).fill('/abs') }));
  assert.equal(many.status, 201);
  assert.equal(many.json.skipped.length, 501);
  assert.deepEqual(many.json.skipped.at(-1), { path: '.claude-plugin', reason: '349500 more plugin manifest problems, not listed' });
});

test('bppq: an agents/ or commands/ folder nested inside a plugin is told only the plugin root one is read', () => {
  const d = detectUnits(tree({ 'plugins/a/.claude-plugin/plugin.json': '{}', 'plugins/a/agents/ok.md': agentMd('ok'), 'plugins/a/extra/agents/x.md': agentMd('x'), 'tools/commands/y.md': 'Y.\n' }), 'r');
  assert.deepEqual(unitsOf(d), [['agent', 'plugins/a/agents/ok.md']]);
  assert.deepEqual(d.skipped, [
    { path: 'plugins/a/extra/agents/x.md', reason: 'agents/ is imported only at the plugin root: plugins/a/agents/*.md' },
    { path: 'tools/commands/y.md', reason: 'commands/ below the repository root is imported only inside a plugin (.claude-plugin/plugin.json)' },
  ]);
  const rootPlugin = detectUnits(tree({ '.claude-plugin/plugin.json': '{}', 'skills/s/SKILL.md': skill('s'), 'tools/agents/z.md': agentMd('z') }), 'r');
  assert.deepEqual(rootPlugin.skipped, [{ path: 'tools/agents/z.md', reason: 'agents/ is imported only at the plugin root: agents/*.md' }]);
  // Any depth below an agents/ or commands/ folder (Code-My-Spec's antigravity/codemyspec/agents/<x>/agent.md).
  const deep = detectUnits(tree({ 'skills/s/SKILL.md': skill('s'), 'antigravity/codemyspec/agents/bdd-spec-writer/agent.md': agentMd('bdd'), 'tools/commands/a/b/c.md': 'C.\n', 'plugins/a/.claude-plugin/plugin.json': '{}', 'plugins/a/x/agents/y/z.md': agentMd('z') }), 'r');
  assert.deepEqual(deep.skipped, [
    { path: 'antigravity/codemyspec/agents/bdd-spec-writer/agent.md', reason: 'agents/ below the repository root is imported only inside a plugin (.claude-plugin/plugin.json)' },
    { path: 'tools/commands/a/b/c.md', reason: 'commands/ below the repository root is imported only inside a plugin (.claude-plugin/plugin.json)' },
    { path: 'plugins/a/x/agents/y/z.md', reason: 'agents/ is imported only at the plugin root: plugins/a/agents/*.md' },
  ]);
});

/** Import `v1` from GitHub, move main to `v2`, source/update the skill `name`: its files at import and after the update. */
async function updatedSkill(repo: string, shas: [string, string], v1: Files, v2: Files, name: string) {
  gh.repos[repo] = { default_branch: 'main', refs: { main: shas[0] }, trees: { [shas[0]]: v1, [shas[1]]: v2 } };
  const { t, h } = setup();
  const imp = await github(t, h, { repo });
  assert.equal(imp.status, 201, imp.text);
  const sk = imp.json.items.find((i: { kind: string; name: string }) => i.kind === 'skill' && i.name === name);
  gh.repos[repo].refs.main = shas[1];
  const up = await t.req('POST', `${API}/items/${sk.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  return { items: names(imp.json.items), imported: filePaths(sk).sort(), updated: filePaths(up.json.item).sort() };
}

test('4ky8: source/update of a declared skill another declared path carved keeps that path out; new files elsewhere in it arrive', async () => {
  const v1 = withManifest({ 'tools/review/SKILL.md': skill('review'), 'tools/review/notes.md': 'n', 'tools/review/deep/SKILL.md': skill('deep'), 'tools/review/deep/x.py': 'x' }, { name: 'rv', skills: ['./tools/review/deep', './tools/review'] });
  const v2 = { ...v1, 'tools/review/SKILL.md': skill('review', 'v2'), 'tools/review/more.md': 'm', 'tools/review/deep/x.py': 'x2', 'tools/review/deep/new.py': 'y' };
  assert.deepEqual(await updatedSkill('acme/declared-nest', [sha2('c2'), sha2('c3')], v1, v2, 'review'), {
    items: ['skill:deep', 'skill:review'],
    imported: ['SKILL.md', 'notes.md'],
    updated: ['SKILL.md', 'more.md', 'notes.md'],
  });
  // The same for a plain folder skill holding a nested plugin, whose agents that plugin's pass took first.
  const n1: Files = { 'tools/x/SKILL.md': skill('x'), 'tools/x/sub/.claude-plugin/plugin.json': '{}', 'tools/x/sub/agents/a.md': agentMd('a') };
  const n2 = { ...n1, 'tools/x/SKILL.md': skill('x', 'v2'), 'tools/x/sub/agents/a.md': agentMd('a') + 'More.\n', 'tools/x/run.sh': 'r' };
  assert.deepEqual(await updatedSkill('acme/nested-plugin-skill', [sha2('e5'), sha2('e6')], n1, n2, 'x'), {
    items: ['agent:a', 'skill:x'],
    imported: ['SKILL.md', 'sub/.claude-plugin/plugin.json'],
    updated: ['SKILL.md', 'run.sh', 'sub/.claude-plugin/plugin.json'],
  });
});

test('bppq: source/update of a plugin skill keeps out the paths its marketplace entry declared', async () => {
  const v1: Files = { '.claude-plugin/marketplace.json': marketplace([{ name: 'a', source: './plugins/a', agents: ['./x/helper.md'], commands: ['./c/go.md'] }]), 'plugins/a/SKILL.md': skill('a'), 'plugins/a/x/helper.md': agentMd('helper'), 'plugins/a/c/go.md': 'Go.\n', 'plugins/a/lib/run.py': 'r' };
  const v2 = { ...v1, 'plugins/a/SKILL.md': skill('a', 'v2'), 'plugins/a/x/helper.md': agentMd('helper') + 'More.\n', 'plugins/a/lib/new.py': 'n' };
  assert.deepEqual(await updatedSkill('acme/market-declared', [sha2('c4'), sha2('d6')], v1, v2, 'a'), {
    items: ['agent:helper', 'command:go', 'skill:a'],
    imported: ['SKILL.md', 'lib/run.py'],
    updated: ['SKILL.md', 'lib/new.py', 'lib/run.py'],
  });
});

test('4ky8: a folder skill no manifest carved keeps its nested example skill and new files on source/update, as before', async () => {
  const v1: Files = { 'tools/plain/SKILL.md': skill('plain'), 'tools/plain/notes.md': 'n', 'tools/plain/ex/SKILL.md': skill('ex') };
  const v2 = { ...v1, 'tools/plain/SKILL.md': skill('plain', 'v2'), 'tools/plain/ex/more.md': 'm', 'tools/plain/new.md': 'w' };
  assert.deepEqual(await updatedSkill('acme/plain-folder', [sha2('d7'), sha2('e4')], v1, v2, 'plain'), {
    items: ['skill:plain'],
    imported: ['SKILL.md', 'ex/SKILL.md', 'notes.md'],
    updated: ['SKILL.md', 'ex/SKILL.md', 'ex/more.md', 'new.md', 'notes.md'],
  });
});

test('4ky8: a re-import records the carve the new manifest makes, so the next source/update keeps it', async () => {
  const files: Files = { 'tools/review/SKILL.md': skill('review'), 'tools/review/notes.md': 'n', 'tools/review/deep/SKILL.md': skill('deep') };
  const v1 = withManifest(files, { name: 'rv', skills: ['./tools/review'] });
  const v2 = withManifest(files, { name: 'rv', skills: ['./tools/review/deep', './tools/review'] });
  const v3 = { ...v2, 'tools/review/SKILL.md': skill('review', 'v3') };
  gh.repos['acme/recarve'] = { default_branch: 'main', refs: { main: sha2('d3') }, trees: { [sha2('d3')]: v1, [sha2('d4')]: v2, [sha2('d5')]: v3 } };
  const { t, h } = setup();
  const first = await github(t, h, { repo: 'acme/recarve' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(filePaths(first.json.items[0]).sort(), ['SKILL.md', 'deep/SKILL.md', 'notes.md']);
  gh.repos['acme/recarve'].refs.main = sha2('d4');
  const again = await github(t, h, { repo: 'acme/recarve' });
  assert.equal(again.status, 201, again.text);
  const review = again.json.items.find((i: { name: string }) => i.name === 'review');
  assert.deepEqual([review.op, filePaths(review).sort()], ['version', ['SKILL.md', 'notes.md']]);
  gh.repos['acme/recarve'].refs.main = sha2('d5');
  const up = await t.req('POST', `${API}/items/${review.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual([up.json.item.description, filePaths(up.json.item).sort()], ['v3', ['SKILL.md', 'notes.md']]);
});

test('5w3w: a manifest that is not valid UTF-8 is malformed: the group falls back to its default name, with a skipped entry', async () => {
  const bad = new Uint8Array([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  const zip = (path: string) => zipSync({ [path]: bad, 'skills/s/SKILL.md': strToU8(skill('s')) });
  const { t, h } = setup();
  const r = await pack(t, h, 'kit.zip', zip('.claude-plugin/plugin.json'), { group: 'kit' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.group.name, r.json.skipped], ['kit', [{ path: '.claude-plugin/plugin.json', reason: 'plugin manifest ignored: not valid UTF-8' }]]);
  const t2 = setup();
  const m = await pack(t2.t, t2.h, 'mk.zip', zip('.claude-plugin/marketplace.json'), { group: 'mk' });
  assert.equal(m.status, 201, m.text);
  assert.deepEqual([m.json.group.name, m.json.skipped], ['mk', [{ path: '.claude-plugin/marketplace.json', reason: 'marketplace manifest ignored: not valid UTF-8' }]]);
});

const count = (t: TestCtx, sql: string, ...params: string[]) => (t.db.prepare(sql).get(...params) as { n: number }).n;
const memberNames = (g: { members: { item: { kind: string; name: string } }[] }) => names(g.members.map((m) => m.item));
const newGroup = async (t: TestCtx, h: H, slug: string, visibility = 'private') => {
  const r = await t.req('POST', `${API}/groups`, { headers: h, json: { slug, name: slug, visibility } });
  assert.equal(r.status, 201, r.text);
};

test('p2wf: intoGroup adds every imported item to an existing own group (pack and GitHub); the result is that group', async () => {
  const { t, h } = setup();
  await newGroup(t, h, 'mine');
  const r = await pack(t, h, 'kit.zip', PLUGIN, { intoGroup: 'mine', frontmatterErrors: 'skip' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.group.slug, 'mine');
  assert.deepEqual(memberNames(r.json.group), ['agent:reviewer', 'command:ship', 'skill:pdf']);
  const audit = (t.db.prepare("SELECT action, detail FROM audit WHERE action LIKE 'group.%'").all() as { action: string; detail: string }[]);
  assert.deepEqual(audit.map((a) => [a.action, JSON.parse(a.detail).op, JSON.parse(a.detail).count]), [['group.create', undefined, undefined], ['group.members', 'import', 3]], 'members added, no second group.create');
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM scp_groups'), 1);

  gh.repos['acme/into'] = { default_branch: 'main', refs: { main: sha2('1a') }, trees: { [sha2('1a')]: PLUGIN } };
  const t2 = setup();
  await newGroup(t2.t, t2.h, 'team');
  const g = await github(t2.t, t2.h, { repo: 'acme/into', intoGroup: 'team', frontmatterErrors: 'skip' });
  assert.equal(g.status, 201, g.text);
  assert.equal(g.json.group.slug, 'team');
  assert.deepEqual(memberNames(g.json.group), ['agent:reviewer', 'command:ship', 'skill:pdf']);
});

test('p2wf: intoGroup of a group the user cannot edit is 404 and imports nothing; group + intoGroup is 400; a restricted key is still refused', async () => {
  const { t, u, h } = setup();
  const other = t.createUser();
  const oh = t.key(other).headers;
  await newGroup(t, oh, 'theirs-private');
  await newGroup(t, oh, 'theirs-public', 'public');
  assert.equal((await t.req('GET', `${API}/groups/theirs-public`, { headers: h })).status, 200, 'readable');
  gh.repos['acme/nope'] = { default_branch: 'main', refs: { main: sha2('1b') }, trees: { [sha2('1b')]: PLUGIN } };
  for (const slug of ['theirs-private', 'theirs-public', 'missing']) {
    const r = await pack(t, h, 'kit.zip', PLUGIN, { intoGroup: slug });
    assert.equal(r.status, 404, `${slug}: ${r.text}`);
    assert.equal(r.json.error.code, 'not_found');
    const before = gh.requests.length;
    const g = await github(t, h, { repo: 'acme/nope', intoGroup: slug });
    assert.equal(g.status, 404, `${slug}: ${g.text}`);
    assert.equal(gh.requests.length, before, 'refused before GitHub is contacted');
  }
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 0);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM group_members'), 0);

  await newGroup(t, h, 'mine');
  const both = await pack(t, h, 'kit.zip', PLUGIN, { group: 'new-one', intoGroup: 'mine' });
  assert.equal(both.status, 400, both.text);
  const bothGh = await github(t, h, { repo: 'acme/nope', group: 'new-one', intoGroup: 'mine' });
  assert.equal(bothGh.status, 400, bothGh.text);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 0);
  // An empty slug in JSON is a 400, not "absent": {group, intoGroup: ''} would otherwise create the group.
  gh.repos['acme/empty-into'] = { default_branch: 'main', refs: { main: sha2('4a') }, trees: { [sha2('4a')]: PLUGIN } };
  const before = gh.requests.length;
  for (const body of [{ group: 'new-one', intoGroup: '' }, { group: '', intoGroup: 'mine' }, { group: '' }]) {
    const r = await github(t, h, { repo: 'acme/empty-into', ...body });
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
  }
  assert.equal(gh.requests.length, before, 'refused before GitHub is contacted');
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 0);
  assert.equal(count(t, "SELECT COUNT(*) AS n FROM scp_groups WHERE slug = 'new-one'"), 0);

  const g = t.db.prepare('SELECT id FROM scp_groups WHERE slug = ?').get('mine') as { id: string };
  const rk = t.key(u, { groupIds: [g.id] }).headers;
  const rp = await pack(t, rk, 'kit.zip', PLUGIN, { intoGroup: 'mine' });
  assert.deepEqual([rp.status, rp.json.error.code], [403, 'restricted_key']);
  const rg = await github(t, rk, { repo: 'acme/nope', intoGroup: 'mine' });
  assert.deepEqual([rg.status, rg.json.error.code], [403, 'restricted_key']);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 0);

  // The pack form is different on purpose: a browser sends an empty input as '', which reads as absent.
  const blank = await pack(t, h, 'kit.zip', PLUGIN, { group: 'new-one', intoGroup: '', frontmatterErrors: 'skip' });
  assert.equal(blank.status, 201, blank.text);
  assert.equal(blank.json.group.slug, 'new-one');
});

test('p2wf: re-importing the same repository into the same group versions the items and adds no duplicate members', async () => {
  gh.repos['acme/regroup'] = { default_branch: 'main', refs: { main: sha2('1c') }, trees: { [sha2('1c')]: PLUGIN, [sha2('1d')]: { ...PLUGIN, 'skills/pdf/SKILL.md': skill('pdf', 'Better.') } } };
  const { t, h } = setup();
  await newGroup(t, h, 'mine');
  const first = await github(t, h, { repo: 'acme/regroup', intoGroup: 'mine', frontmatterErrors: 'skip' });
  assert.equal(first.status, 201, first.text);
  gh.repos['acme/regroup'].refs.main = sha2('1d');
  const again = await github(t, h, { repo: 'acme/regroup', intoGroup: 'mine', frontmatterErrors: 'skip' });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.json.items.find((i: { name: string }) => i.name === 'pdf').op, 'version');
  assert.deepEqual(memberNames(again.json.group), ['agent:reviewer', 'command:ship', 'skill:pdf']);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM group_members'), 3);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 3);
  assert.equal(count(t, "SELECT COUNT(*) AS n FROM audit WHERE action = 'group.members'"), 1, 'nothing added, nothing audited');
  // A pack re-uploaded into the group it already fills: unchanged, members included.
  const t2 = setup();
  await newGroup(t2.t, t2.h, 'mine');
  const p1 = await pack(t2.t, t2.h, 'kit.zip', PLUGIN, { intoGroup: 'mine', frontmatterErrors: 'skip' });
  const p2 = await pack(t2.t, t2.h, 'kit.zip', PLUGIN, { intoGroup: 'mine', frontmatterErrors: 'skip' });
  assert.deepEqual([p1.status, p2.status], [201, 201], p2.text);
  assert.ok(p2.json.items.every((i: { op: string }) => i.op === 'unchanged'));
  assert.equal(count(t2.t, 'SELECT COUNT(*) AS n FROM group_members'), 3);
});

test('p2wf: a group deleted after the route resolved intoGroup (during a GitHub download) is a 404, not a foreign-key 500', async () => {
  const { t, u, h } = setup();
  await newGroup(t, h, 'gone');
  const stale = t.db.prepare('SELECT * FROM scp_groups WHERE slug = ?').get('gone') as unknown as GroupRow;
  assert.equal((await t.req('DELETE', `${API}/groups/gone`, { headers: h })).status, 204);
  const p: Principal = { userId: u.id, username: u.username, isAdmin: false, via: 'key', scopes: ['read', 'write'], groupIds: null };
  const source = { kind: 'zip' as const, repo: 'kit.zip', ref: null, path: null, commit: 'c' };
  assert.throws(() => importTree(t.ctx, p, tree(PLUGIN), { source, rootName: 'kit', note: 'n', intoGroup: stale, frontmatterErrors: 'skip' }), { status: 404, code: 'not_found' });
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 0);
});

const PROMPTS: Files = { 'my-prompts/a.md': 'A {{x}}\n', 'my-prompts/b.md': AGENT, 'my-prompts/c.md': '# C\nSee.\n', 'my-prompts/README.md': '# About\n' };

test('jwz6: kind prompt on a folder of md files imports each file as its own prompt (pack and GitHub); README stays out; re-import versions', async () => {
  const { t, h } = setup();
  const r = await pack(t, h, 'my-prompts.zip', PROMPTS, { kind: 'prompt' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['prompt:a', 'prompt:b', 'prompt:c']);
  assert.deepEqual(r.json.skipped, [{ path: 'README.md', reason: 'repository documentation, not an item' }]);
  assert.deepEqual(r.json.items.map((i: { source: { path: string } }) => i.source.path).sort(), ['a.md', 'b.md', 'c.md']);
  const changed = await pack(t, h, 'my-prompts.zip', { ...PROMPTS, 'my-prompts/a.md': 'A2 {{x}}\n' }, { kind: 'prompt' });
  assert.equal(changed.status, 201, changed.text);
  assert.deepEqual(changed.json.items.map((i: { name: string; op: string }) => `${i.name}:${i.op}`).sort(), ['a:version', 'b:unchanged', 'c:unchanged']);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 3);

  const files = Object.fromEntries(Object.entries(PROMPTS).map(([k, v]) => [k.replace('my-prompts/', 'docs/prompts/'), v]));
  gh.repos['acme/prompts'] = { default_branch: 'main', refs: { main: sha2('1e') }, trees: { [sha2('1e')]: { ...files, 'src/x.ts': 'x' }, [sha2('1f')]: { ...files, 'docs/prompts/a.md': 'A2\n', 'src/x.ts': 'x' } } };
  const t2 = setup();
  const g = await github(t2.t, t2.h, { repo: 'acme/prompts', path: 'docs/prompts', kind: 'prompt' });
  assert.equal(g.status, 201, g.text);
  assert.deepEqual(names(g.json.items), ['prompt:a', 'prompt:b', 'prompt:c']);
  assert.deepEqual(g.json.items.map((i: { source: { path: string } }) => i.source.path).sort(), ['docs/prompts/a.md', 'docs/prompts/b.md', 'docs/prompts/c.md']);
  assert.deepEqual(g.json.skipped.map((s: { path: string }) => s.path), ['README.md']);
  gh.repos['acme/prompts'].refs.main = sha2('1f');
  const again = await github(t2.t, t2.h, { repo: 'acme/prompts', path: 'docs/prompts', kind: 'prompt' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: { name: string; op: string }) => `${i.name}:${i.op}`).sort(), ['a:version', 'b:unchanged', 'c:unchanged']);
  assert.equal(count(t2.t, 'SELECT COUNT(*) AS n FROM items'), 3, 'no duplicates');
  // Each one updates from its own file.
  const a = again.json.items.find((i: { name: string }) => i.name === 'a');
  assert.equal((await t2.t.req('POST', `${API}/items/${a.id}/source/check`, { headers: t2.h })).json.upToDate, true);
});

test('jwz6: a folder holding one .md stays one item named after the folder, so an item imported so before jwz6 versions on re-import', async () => {
  const before = { 'docs/one/x.md': 'X {{x}}\n', 'team/agent/reviewer.md': AGENT };
  const now = { 'docs/one/x.md': 'X2 {{x}}\n', 'docs/one/README.md': '# About\n', 'team/agent/reviewer.md': `${AGENT}More.\n` };
  gh.repos['acme/one'] = { default_branch: 'main', refs: { main: sha2('c8') }, trees: { [sha2('c7')]: before, [sha2('c8')]: now } };
  const { t, u, h } = setup();
  const p: Principal = { userId: u.id, username: u.username, isAdmin: false, via: 'key', scopes: ['read', 'write'], groupIds: null };
  // The rows the pre-jwz6 import made: the folder one item, source path the folder.
  const old = (kind: 'prompt' | 'agent', path: string, file: string) =>
    createItemTx(t.ctx, p, {
      kind,
      tree: tree({ [file]: before[`${path}/${file}` as keyof typeof before] }),
      source: { kind: 'github', repo: 'acme/one', ref: 'main', path, commit: sha2('c7') },
      sourceScope: 'tree',
      note: 'n',
      fallbackName: path.split('/').pop(),
      folderName: path.split('/').pop(),
    });
  const rows = [old('prompt', 'docs/one', 'x.md'), old('agent', 'team/agent', 'reviewer.md')];
  for (const [row, kind, path] of [[rows[0], 'prompt', 'docs/one'], [rows[1], 'agent', 'team/agent']] as const) {
    const r = await github(t, h, { repo: 'acme/one', path, kind });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json.items.map((i: { id: string; name: string; op: string; source: { path: string } }) => [i.id, i.name, i.op, i.source.path]), [[row.id, row.name, 'version', path]]);
  }
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 2, 'no duplicates');
});

test('jwz6: a single-file kind splits only the folder\'s own .md files; nested ones are skipped, never collide', async () => {
  const { t, h } = setup();
  const r = await pack(t, h, 'nested.zip', { 'nested/a.md': 'A\n', 'nested/b.md': 'B\n', 'nested/one/x.md': 'X1\n', 'nested/two/x.md': 'X2\n' }, { kind: 'prompt' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['prompt:a', 'prompt:b']);
  assert.deepEqual(r.json.skipped, [
    { path: 'one/x.md', reason: 'in a subfolder: only the folder\'s own .md files are each a prompt' },
    { path: 'two/x.md', reason: 'in a subfolder: only the folder\'s own .md files are each a prompt' },
  ]);
});

test('jwz6: kind skill, design and package on a folder still make one item holding every file', async () => {
  gh.repos['acme/whole'] = {
    default_branch: 'main',
    refs: { main: sha2('2a') },
    trees: { [sha2('2a')]: { 'tools/s/SKILL.md': skill('s'), 'tools/s/ref.md': 'r', 'brand/DESIGN.md': '# Brand\n', 'brand/tokens.md': 't', 'docs/a.md': 'a', 'docs/b.md': 'b' } },
  };
  const { t, h } = setup();
  for (const [path, kind, files] of [
    ['tools/s', 'skill', ['SKILL.md', 'ref.md']],
    ['brand', 'design', ['DESIGN.md', 'tokens.md']],
    ['docs', 'package', ['a.md', 'b.md']],
  ] as const) {
    const r = await github(t, h, { repo: 'acme/whole', path, kind });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.items.length, 1, kind);
    assert.equal(r.json.items[0].kind, kind);
    assert.deepEqual(r.json.items[0].version.files.map((f: { path: string }) => f.path), files);
  }
  const p = await pack(t, h, 'manual.zip', { 'manual/a.md': 'a', 'manual/b.md': 'b' }, { kind: 'package' });
  assert.equal(p.status, 201, p.text);
  assert.deepEqual(names(p.json.items), ['package:manual']);
  assert.deepEqual(p.json.items[0].version.files.map((f: { path: string }) => f.path), ['a.md', 'b.md']);
});

const NOTES: Files = { 'skills/x/SKILL.md': skill('x'), 'notes/a.md': 'A note.\n', 'notes/b.md': 'B note.\n', 'notes/README.md': '# Notes\n', 'src/x.ts': 'x' };

test('mvfp: an unrecognised folder of md files is offered; folderKinds imports it as prompts or one package, the skill unchanged, README never', async () => {
  const { t, h } = setup();
  const zip = zipSync(Object.fromEntries(Object.entries(NOTES).map(([k, v]) => [k, strToU8(v)])));
  const first = await pack(t, h, 'kit.zip', zip);
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(names(first.json.items), ['skill:x']);
  assert.deepEqual(first.json.skippedFolders, [{ path: 'notes', count: 2 }], 'README-style docs are never offered');
  const skillId = first.json.items[0].id;

  const prompts = await pack(t, h, 'kit.zip', zip, { folderKinds: JSON.stringify({ notes: 'prompt' }) });
  assert.equal(prompts.status, 201, prompts.text);
  assert.deepEqual(names(prompts.json.items), ['prompt:a', 'prompt:b', 'skill:x']);
  assert.deepEqual(prompts.json.skippedFolders, []);
  assert.deepEqual(prompts.json.skipped, []);
  const x = prompts.json.items.find((i: { kind: string }) => i.kind === 'skill');
  assert.deepEqual([x.id, x.op], [skillId, 'unchanged'], 'the skill is the same item, not a duplicate');
  assert.deepEqual(prompts.json.items.filter((i: { kind: string }) => i.kind === 'prompt').map((i: { source: { path: string } }) => i.source.path).sort(), ['notes/a.md', 'notes/b.md']);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 3);

  const t2 = setup();
  const pkg = await pack(t2.t, t2.h, 'kit.zip', zip, { folderKinds: JSON.stringify({ notes: 'package', ghost: 'prompt' }) });
  assert.equal(pkg.status, 201, pkg.text);
  assert.deepEqual(names(pkg.json.items), ['package:notes', 'skill:x']);
  const notes = pkg.json.items.find((i: { kind: string }) => i.kind === 'package');
  assert.deepEqual(notes.version.files.map((f: { path: string }) => f.path), ['README.md', 'a.md', 'b.md']);
  assert.deepEqual(pkg.json.skipped, [{ path: 'ghost', reason: 'folderKinds: no unrecognised files in this folder; ignored' }], 'a folder not in the tree is reported');
});

test('mvfp: folderKinds through GitHub, a design folder updating from source, and a code repository offered its prompts in the 400', async () => {
  const files: Files = { ...NOTES, 'brand/look.md': '# Look\n' };
  gh.repos['acme/notes'] = { default_branch: 'main', refs: { main: sha2('2b') }, trees: { [sha2('2b')]: files, [sha2('2c')]: { ...files, 'brand/look.md': '# Look\nNewer.\n' } } };
  const { t, h } = setup();
  const first = await github(t, h, { repo: 'acme/notes' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(first.json.skippedFolders, [{ path: 'notes', count: 2 }, { path: 'brand', count: 1 }]);
  const mapped = await github(t, h, { repo: 'acme/notes', folderKinds: { notes: 'command', brand: 'design' } });
  assert.equal(mapped.status, 201, mapped.text);
  assert.deepEqual(names(mapped.json.items), ['command:a', 'command:b', 'design:look', 'skill:x']);
  const look = mapped.json.items.find((i: { kind: string }) => i.kind === 'design');
  assert.deepEqual([look.version.entryPath, look.source.path], ['DESIGN.md', 'brand/look.md']);
  gh.repos['acme/notes'].refs.main = sha2('2c');
  const up = await t.req('POST', `${API}/items/${look.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual([up.json.item.latestSeq, up.json.item.version.entryPath], [2, 'DESIGN.md']);

  gh.repos['acme/code'] = { default_branch: 'main', refs: { main: sha2('2d') }, trees: { [sha2('2d')]: { 'src/x.ts': 'x', 'docs/prompts/p.md': 'P.\n', 'docs/prompts/q.md': 'Q.\n' } } };
  const none = await github(t, h, { repo: 'acme/code' });
  assert.equal(none.status, 400, none.text);
  assert.equal(none.json.error.code, 'nothing_to_import');
  assert.deepEqual(none.json.error.skippedFolders, [{ path: 'docs/prompts', count: 2 }]);
  assert.equal(none.json.error.details.length, 2);
  const now = await github(t, h, { repo: 'acme/code', folderKinds: { 'docs/prompts': 'prompt' } });
  assert.equal(now.status, 201, now.text);
  assert.deepEqual(names(now.json.items), ['prompt:p', 'prompt:q']);
});

test('mvfp: folderKinds with ../, an absolute path, an unknown kind or bad JSON is a 400 before anything is imported or fetched', async () => {
  gh.repos['acme/esc'] = { default_branch: 'main', refs: { main: sha2('2e') }, trees: { [sha2('2e')]: NOTES } };
  const { t, h } = setup();
  for (const bad of [{ '../x': 'prompt' }, { '/etc': 'prompt' }, { 'notes/../..': 'prompt' }, { 'C:/x': 'prompt' }, { notes: 'skill' }, { notes: 'artifact' }]) {
    const p = await pack(t, h, 'kit.zip', NOTES, { folderKinds: JSON.stringify(bad) });
    assert.equal(p.status, 400, `${JSON.stringify(bad)}: ${p.text}`);
    const before = gh.requests.length;
    const g = await github(t, h, { repo: 'acme/esc', folderKinds: bad });
    assert.equal(g.status, 400, `${JSON.stringify(bad)}: ${g.text}`);
    assert.equal(gh.requests.length, before);
  }
  assert.equal((await pack(t, h, 'kit.zip', NOTES, { folderKinds: '{not json' })).status, 400);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 0);
});

// ---------- 5ef6 name clashes, 0rdh frontmatter errors ----------

const fileText = async (t: TestCtx, h: H, id: string, path: string) => (await t.req('GET', `${API}/items/${id}/files/${path}`, { headers: h })).text;
const bundleFiles = async (t: TestCtx, h: H, slug: string) => {
  const r = await t.req('GET', `${API}/groups/${slug}/bundle.zip`, { headers: h });
  assert.equal(r.status, 200, r.text);
  return new Map(Object.entries(unzipSync(r.bytes)).map(([p, b]) => [p, strFromU8(b)]));
};
type Out = { id: string; kind: string; name: string; op: string; source: { path: string }; version: { lint: unknown[] } };
const byName = (items: Out[], name: string) => items.find((i) => i.name === name)!;

test('5ef6: skills sharing a name inside one import each take their plugin (or skills/ parent) folder as prefix, frontmatter name included; the group holds them; a re-import is unchanged', async () => {
  const { t, h } = setup();
  const files: Files = {
    'plugins/a/.claude-plugin/plugin.json': '{}',
    'plugins/a/skills/access/SKILL.md': skill('access', 'Discord access.'),
    'plugins/b/.claude-plugin/plugin.json': '{}',
    'plugins/b/skills/access/SKILL.md': skill('access', 'iMessage access.'),
    'plugins/b/skills/solo/SKILL.md': skill('solo'),
    'x/skills/dup/SKILL.md': skill('dup'),
    'y/skills/dup/SKILL.md': skill('dup'),
  };
  const r = await pack(t, h, 'official.zip', files, { group: 'official' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:a-access', 'skill:b-access', 'skill:solo', 'skill:x-dup', 'skill:y-dup']);
  assert.deepEqual(r.json.skipped, []);
  assert.deepEqual(r.json.group.members.map((m: { item: { name: string } }) => m.item.name).sort(), ['a-access', 'b-access', 'solo', 'x-dup', 'y-dup']);
  const a = byName(r.json.items, 'a-access');
  assert.equal(a.source.path, 'plugins/a/skills/access');
  assert.equal(await fileText(t, h, a.id, 'SKILL.md'), skill('access', 'Discord access.').replace('name: access', 'name: a-access'));
  // Installed under the prefixed name, its frontmatter name matching the folder.
  const bundle = await bundleFiles(t, h, 'official');
  assert.match(bundle.get('.claude/skills/b-access/SKILL.md')!, /^---\nname: b-access\ndescription: iMessage access\.\n/);
  assert.ok(!bundle.has('.claude/skills/access/SKILL.md'));
  // The same pack again: every unit is the item it created, nothing new.
  const again = await pack(t, h, 'official.zip', files, { intoGroup: 'official' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: Out) => i.op), ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 5);

  // A port of a name every other copy was prefixed away from is still skipped as a port (ypmn), not imported bare.
  const t2 = setup();
  const ports = await pack(t2.t, t2.h, 'ports.zip', { ...files, '.codex/skills/access/SKILL.md': skill('access') });
  assert.equal(ports.status, 201, ports.text);
  assert.ok(!ports.json.items.some((i: Out) => i.name === 'access'));
  assert.deepEqual(ports.json.skipped, [{ path: '.codex/skills/access', reason: portReason('plugins/a/skills/access', '.codex') }]);
  // One non-port copy keeps the bare name: the ports give way to it as before.
  assert.deepEqual(detectUnits(tree(files), 'x').units.filter((u) => u.path.endsWith('/access')).map((u) => u.prefixes), [['a', 'plugins-a'], ['b', 'plugins-b']]);

  // A copy an earlier import of this source holds under the bare name keeps it (re-import = update), so a
  // plugin added upstream with the same skill name neither duplicates nor strands the existing item.
  const t3 = setup();
  const solo = { 'plugins/a/.claude-plugin/plugin.json': '{}', 'plugins/a/skills/access/SKILL.md': skill('access', 'Discord access.') };
  const first = await pack(t3.t, t3.h, 'grow.zip', solo, { group: 'grow' });
  assert.deepEqual(names(first.json.items), ['skill:access']);
  const grown = await pack(t3.t, t3.h, 'grow.zip', { ...solo, 'plugins/b/.claude-plugin/plugin.json': '{}', 'plugins/b/skills/access/SKILL.md': skill('access', 'iMessage access.') }, { intoGroup: 'grow' });
  assert.equal(grown.status, 201, grown.text);
  assert.deepEqual(grown.json.items.map((i: Out) => [i.name, i.op]).sort(), [['access', 'unchanged'], ['b-access', 'create']]);
  assert.deepEqual(grown.json.skipped, []);
  assert.equal(count(t3.t, 'SELECT COUNT(*) AS n FROM items'), 2);
});

test("5ef6, 5vz2: a prefixed name another skill of the import already carries is never taken: that copy lengthens its prefix, else is skipped; the repository's own skill imports", async () => {
  const { t, h } = setup();
  const files: Files = {
    'plugins/a/.claude-plugin/plugin.json': '{}',
    'plugins/a/skills/access/SKILL.md': skill('access', 'Discord access.'),
    'plugins/b/.claude-plugin/plugin.json': '{}',
    'plugins/b/skills/access/SKILL.md': skill('access', 'iMessage access.'),
    'skills/a-access/SKILL.md': skill('a-access', 'The repository\'s own.'),
  };
  const r = await pack(t, h, 'taken.zip', files);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:a-access', 'skill:b-access', 'skill:plugins-a-access']);
  assert.equal(byName(r.json.items, 'a-access').source.path, 'skills/a-access');
  assert.equal(byName(r.json.items, 'plugins-a-access').source.path, 'plugins/a/skills/access');
  assert.deepEqual(r.json.skipped, []);
  // naming-1: the repository's own skill added upstream after a first import named the copies a-access and
  // b-access. The re-import names them as the fresh import above does: the copy's item takes the longer
  // prefix (in the same group, one new version), so the repository's own skill is not refused on its name.
  const t3 = setup();
  const { 'skills/a-access/SKILL.md': own, ...rest } = files;
  const copies = { ...rest, LICENSE: 'MIT' }; // a root file, so the first zip's one top folder is not unwrapped
  const first = await pack(t3.t, t3.h, 'taken.zip', copies, { group: 'taken' });
  assert.deepEqual(names(first.json.items), ['skill:a-access', 'skill:b-access']);
  const grown = await pack(t3.t, t3.h, 'taken.zip', { ...copies, 'skills/a-access/SKILL.md': own }, { intoGroup: 'taken' });
  assert.equal(grown.status, 201, grown.text);
  assert.deepEqual(grown.json.skipped, []);
  assert.deepEqual(grown.json.items.map((i: Out) => [i.name, i.op, i.source.path]).sort(), [
    ['a-access', 'create', 'skills/a-access'],
    ['b-access', 'unchanged', 'plugins/b/skills/access'],
    ['plugins-a-access', 'version', 'plugins/a/skills/access'],
  ]);
  const moved = byName(grown.json.items, 'plugins-a-access');
  assert.equal(moved.id, byName(first.json.items, 'a-access').id, 'the same item, renamed');
  assert.match(await fileText(t3.t, t3.h, moved.id, 'SKILL.md'), /^---\nname: plugins-a-access\n/);
  assert.ok((await bundleFiles(t3.t, t3.h, 'taken')).has('.claude/skills/plugins-a-access/SKILL.md'));
  const again = await pack(t3.t, t3.h, 'taken.zip', { ...copies, 'skills/a-access/SKILL.md': own }, { intoGroup: 'taken' });
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]).sort(), [['a-access', 'unchanged'], ['b-access', 'unchanged'], ['plugins-a-access', 'unchanged']]);
  // The same when the new skill's unit comes first in the import (a/ sorts before z/).
  const t5 = setup();
  const zs: Files = { LICENSE: 'MIT', 'z/a/skills/access/SKILL.md': skill('access'), 'z/b/skills/access/SKILL.md': skill('access') };
  assert.deepEqual(names((await pack(t5.t, t5.h, 'z.zip', zs)).json.items), ['skill:a-access', 'skill:b-access']);
  const zGrown = await pack(t5.t, t5.h, 'z.zip', { ...zs, 'a/skills/a-access/SKILL.md': skill('a-access') });
  assert.equal(zGrown.status, 201, zGrown.text);
  assert.deepEqual(zGrown.json.skipped, []);
  assert.deepEqual(zGrown.json.items.map((i: Out) => [i.name, i.op]).sort(), [['a-access', 'create'], ['b-access', 'unchanged'], ['z-a-access', 'version']]);
  // No folder above a/ to lengthen with: that copy is skipped.
  const t2 = setup();
  const top = await pack(t2.t, t2.h, 'top.zip', { 'a/skills/access/SKILL.md': skill('access'), 'b/skills/access/SKILL.md': skill('access'), 'skills/a-access/SKILL.md': skill('a-access') });
  assert.equal(top.status, 201, top.text);
  assert.deepEqual(names(top.json.items), ['skill:a-access', 'skill:b-access']);
  assert.deepEqual(top.json.skipped, [{ path: 'a/skills/access', reason: "another skill of this import is named 'access', and 'a-access' is the name of another skill of this import" }]);
  // Twins that both run out of folders on one name (a dot folder above, or a case twin): the first keeps
  // it and the other is skipped, never both, so a tree of only those twins still imports.
  for (const [twin, other] of [['.x/a/skills/access', 'a/skills/access'], ['A/skills/access', 'a/skills/access']]) {
    const t4 = setup();
    const r4 = await pack(t4.t, t4.h, 'twins.zip', { [`${other}/SKILL.md`]: skill('access'), [`${twin}/SKILL.md`]: skill('access') });
    assert.equal(r4.status, 201, r4.text);
    assert.deepEqual(names(r4.json.items), ['skill:a-access']);
    assert.equal(r4.json.skipped.length, 1, r4.text);
    assert.match(r4.json.skipped[0].reason, /'a-access' is the name of another skill of this import/);
  }
});

test("naming-6: the naming-1 rename at the same commit (the same zip with includeRepoTooling toggled on) writes a version whose SKILL.md names the new name", async () => {
  const { t, h } = setup();
  const zip = zipSync(
    Object.fromEntries(
      Object.entries({
        LICENSE: 'MIT',
        'plugins/a/.claude-plugin/plugin.json': '{}',
        'plugins/a/skills/access/SKILL.md': skill('access', 'Discord access.'),
        'plugins/b/.claude-plugin/plugin.json': '{}',
        'plugins/b/skills/access/SKILL.md': skill('access', 'iMessage access.'),
        '.claude/skills/a-access/SKILL.md': skill('a-access', "The repository's own."),
      }).map(([k, v]) => [k, strToU8(v)]),
    ),
  );
  const first = await pack(t, h, 'tool.zip', zip, { group: 'tool' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(names(first.json.items), ['skill:a-access', 'skill:b-access']);
  assert.deepEqual(first.json.skipped.map((s: { path: string }) => s.path), ['.claude/skills']);
  const again = await pack(t, h, 'tool.zip', zip, { intoGroup: 'tool', includeRepoTooling: 'true' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op, i.source.path]).sort(), [
    ['a-access', 'create', '.claude/skills/a-access'],
    ['b-access', 'unchanged', 'plugins/b/skills/access'],
    ['plugins-a-access', 'version', 'plugins/a/skills/access'],
  ]);
  const moved = byName(again.json.items, 'plugins-a-access');
  assert.equal(moved.id, byName(first.json.items, 'a-access').id, 'the same item, renamed');
  assert.match(await fileText(t, h, moved.id, 'SKILL.md'), /^---\nname: plugins-a-access\n/);
  // One SKILL.md per install folder, each naming its own folder.
  const bundle = await bundleFiles(t, h, 'tool');
  const skillMds = [...bundle].filter(([p]) => p.endsWith('/SKILL.md')).map(([p, text]) => [p, /^---\nname: (\S+)\n/.exec(text)![1]]);
  assert.deepEqual(skillMds.sort(), [
    ['.claude/skills/a-access/SKILL.md', 'a-access'],
    ['.claude/skills/b-access/SKILL.md', 'b-access'],
    ['.claude/skills/plugins-a-access/SKILL.md', 'plugins-a-access'],
  ]);
  // The same bytes once more: nothing left to write.
  const third = await pack(t, h, 'tool.zip', zip, { intoGroup: 'tool', includeRepoTooling: 'true' });
  assert.deepEqual(third.json.items.map((i: Out) => i.op), ['unchanged', 'unchanged', 'unchanged']);
});

/** 5vz2: two plugin folders named a (plugins/a, other/a) and a third plugin b, all shipping skill access and agent reviewer. */
const SAME_FOLDER = (desc: string): Files => {
  const files: Files = {};
  for (const p of ['plugins/a', 'other/a', 'plugins/b']) {
    Object.assign(files, { [`${p}/.claude-plugin/plugin.json`]: '{}', [`${p}/skills/access/SKILL.md`]: skill('access', `${p} ${desc}`), [`${p}/agents/reviewer.md`]: AGENT });
  }
  return files;
};

test('5vz2: copies whose plugin folders share a name lengthen the prefix with the folder above; re-import and source/update keep each name', async () => {
  gh.repos['acme/twins'] = { default_branch: 'main', refs: { main: sha2('a1') }, trees: { [sha2('a1')]: SAME_FOLDER('v1.'), [sha2('a2')]: SAME_FOLDER('v2.') } };
  const { t, h } = setup();
  const r = await github(t, h, { repo: 'acme/twins' });
  assert.equal(r.status, 201, r.text);
  const expected = ['agent:b-reviewer', 'agent:other-a-reviewer', 'agent:plugins-a-reviewer', 'skill:b-access', 'skill:other-a-access', 'skill:plugins-a-access'];
  assert.deepEqual(names(r.json.items), expected);
  assert.deepEqual(r.json.skipped, []);
  const other = byName(r.json.items, 'other-a-access');
  assert.equal(other.source.path, 'other/a/skills/access');
  assert.equal(await fileText(t, h, other.id, 'SKILL.md'), skill('access', 'other/a v1.').replace('name: access', 'name: other-a-access'));
  const prefixes = t.db.prepare("SELECT name, source_prefix AS p FROM items WHERE kind = 'skill' ORDER BY name").all() as { name: string; p: string }[];
  assert.deepEqual(prefixes.map((x) => [x.name, x.p]), [['b-access', 'b'], ['other-a-access', 'other-a'], ['plugins-a-access', 'plugins-a']]);
  // The same commit again: every unit is the item it created.
  const again = await github(t, h, { repo: 'acme/twins' });
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]).sort(), expected.map((n) => [n.split(':')[1], 'unchanged']).sort());
  // A new commit: source/update keeps the longer prefix, and a re-import versions the same items.
  gh.repos['acme/twins'].refs.main = sha2('a2');
  const up = await t.req('POST', `${API}/items/${other.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.name, 'other-a-access');
  assert.equal(await fileText(t, h, other.id, 'SKILL.md'), skill('access', 'other/a v2.').replace('name: access', 'name: other-a-access'));
  const re = await github(t, h, { repo: 'acme/twins' });
  assert.equal(re.status, 201, re.text);
  assert.deepEqual(re.json.items.map((i: Out) => [i.name, i.op]).sort(), [
    ['b-access', 'version'], ['b-reviewer', 'unchanged'], ['other-a-access', 'unchanged'], ['other-a-reviewer', 'unchanged'], ['plugins-a-access', 'version'], ['plugins-a-reviewer', 'unchanged'],
  ]);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 6);
  // One of the twins leaves upstream: the other a/ copy still finds its item under the longer prefix.
  gh.repos['acme/twins'].trees[sha2('a3')] = Object.fromEntries(Object.entries(SAME_FOLDER('v3.')).filter(([p]) => !p.startsWith('plugins/a/')));
  gh.repos['acme/twins'].refs.main = sha2('a3');
  const gone = await github(t, h, { repo: 'acme/twins' });
  assert.equal(gone.status, 201, gone.text);
  assert.deepEqual(gone.json.items.map((i: Out) => [i.name, i.op]).sort(), [['b-access', 'version'], ['b-reviewer', 'unchanged'], ['other-a-access', 'version'], ['other-a-reviewer', 'unchanged']]);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 6);
});

test('7k2p: commands of two plugins sharing a file name import prefixed and install so; source/update and a re-import once the clash is gone keep the prefix', async () => {
  const cmds = (v: string, both = true): Files => ({
    'plugins/a/.claude-plugin/plugin.json': '{}',
    'plugins/a/commands/go.md': `Go a ${v}.\n`,
    ...(both && { 'plugins/b/.claude-plugin/plugin.json': '{}', 'plugins/b/commands/go.md': `Go b ${v}.\n` }),
  });
  gh.repos['acme/cmds'] = { default_branch: 'main', refs: { main: sha2('c1') }, trees: { [sha2('c1')]: cmds('v1'), [sha2('c2')]: cmds('v2'), [sha2('c3')]: cmds('v3', false) } };
  const { t, h } = setup();
  const r = await github(t, h, { repo: 'acme/cmds', group: 'cmds' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['command:a-go', 'command:b-go']);
  assert.deepEqual(r.json.skipped, []);
  const bundle = await bundleFiles(t, h, 'cmds');
  assert.equal(bundle.get('.claude/commands/a-go.md'), 'Go a v1.\n');
  assert.equal(bundle.get('.claude/commands/b-go.md'), 'Go b v1.\n');
  const a = byName(r.json.items, 'a-go');
  gh.repos['acme/cmds'].refs.main = sha2('c2');
  const up = await t.req('POST', `${API}/items/${a.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.name, 'a-go');
  assert.equal(up.json.item.latestSeq, 2);
  gh.repos['acme/cmds'].refs.main = sha2('c3');
  const gone = await github(t, h, { repo: 'acme/cmds', intoGroup: 'cmds' });
  assert.equal(gone.status, 201, gone.text);
  assert.deepEqual(gone.json.items.map((i: Out) => [i.name, i.op, i.id]), [['a-go', 'version', a.id]]);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 2);
  assert.equal((await bundleFiles(t, h, 'cmds')).get('.claude/commands/a-go.md'), 'Go a v3.\n');
});

test("eg9k: a port folder holding its own plugin.json loses to any other copy: that copy imports and the port is skipped as one, by convention or by manifest path", async () => {
  const s = (dir: string): Files => ({ [`${dir}/SKILL.md`]: skill('s', `${dir} copy.`) });
  const plugin = (root: string, declared = false): Files => ({ [`${root}/.claude-plugin/plugin.json`]: declared ? '{"skills":"./src"}' : '{}', ...s(`${root}/${declared ? 'src' : 'skills'}/s`) });
  const cases: [Files, string, string][] = [
    [{ ...plugin('antigravity/x'), ...plugin('plugins/x') }, 'plugins/x/skills/s', 'antigravity/x/skills/s'],
    [{ ...plugin('antigravity/x', true), ...plugin('plugins/x', true) }, 'plugins/x/src/s', 'antigravity/x/src/s'],
    // Manifest paths are read before convention folders, yet the port still comes last.
    [{ ...plugin('antigravity/x', true), ...plugin('plugins/x') }, 'plugins/x/skills/s', 'antigravity/x/src/s'],
    [{ ...plugin('antigravity/x'), ...plugin('plugins/x', true) }, 'plugins/x/src/s', 'antigravity/x/skills/s'],
    // The port folder as the plugin root itself; a port plugin against a root skills/ copy and a neutral folder's.
    [{ ...plugin('antigravity'), ...plugin('x') }, 'x/skills/s', 'antigravity/skills/s'],
    [{ ...plugin('antigravity/x'), ...s('skills/s') }, 'skills/s', 'antigravity/x/skills/s'],
    [{ ...plugin('antigravity/x'), ...s('tools/s') }, 'tools/s', 'antigravity/x/skills/s'],
    // naming-8: plugin roots that are skills themselves, the port folder one of the roots: its skill's path is the root itself, still a port.
    [{ 'antigravity/.claude-plugin/plugin.json': '{}', ...s('antigravity'), 'plugins/x/.claude-plugin/plugin.json': '{}', ...s('plugins/x') }, 'plugins/x', 'antigravity'],
  ];
  for (const [files, at, port] of cases) {
    const { t, h } = setup();
    const r = await pack(t, h, 'multi.zip', files);
    assert.equal(r.status, 201, r.text);
    const kept = byName(r.json.items, 's');
    assert.equal(kept.source.path, at);
    assert.equal(await fileText(t, h, kept.id, 'SKILL.md'), skill('s', `${at} copy.`));
    assert.deepEqual(r.json.skipped.find((k: { path: string }) => k.path === port), { path: port, reason: portReason(at, 'antigravity') });
  }
  // Agents too: the plugins/ copy holds the name, also against a port whose manifest declares its agents.
  const { t, h } = setup();
  const r = await pack(t, h, 'multi.zip', {
    'antigravity/x/.claude-plugin/plugin.json': '{"agents":"./src"}',
    'antigravity/x/src/r.md': agentMd('r'),
    'plugins/x/.claude-plugin/plugin.json': '{}',
    'plugins/x/agents/r.md': agentMd('r'),
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(byName(r.json.items, 'r').source.path, 'plugins/x/agents/r.md');
});

test("7k2p: prompts keep the bppq rule: of two plugins' prompts/x.md the first imports, the second is name_taken", async () => {
  const { t, h } = setup();
  const r = await pack(t, h, 'prompts.zip', {
    'plugins/a/.claude-plugin/plugin.json': '{}',
    'plugins/a/prompts/x.md': 'Prompt a.\n',
    'plugins/b/.claude-plugin/plugin.json': '{}',
    'plugins/b/prompts/x.md': 'Prompt b.\n',
  });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['prompt:x']);
  // The zip's one top folder (plugins/) is stripped.
  assert.deepEqual(r.json.skipped, [{ path: 'b/prompts/x.md', reason: "you already have a prompt named 'x', imported from a/prompts/x.md of prompts.zip" }]);
});

test('5ef6: a twin its lint refuses forces no prefix: the clean copy keeps its bare name; when both import, both take their prefix', async () => {
  const clean = { 'plugins/a/.claude-plugin/plugin.json': '{}', 'plugins/a/skills/access/SKILL.md': skill('access', 'Discord access.'), 'plugins/b/.claude-plugin/plugin.json': '{}' };
  // A twin with a frontmatter error, skipped.
  let s = setup();
  let r = await pack(s.t, s.h, 'fm.zip', { ...clean, 'plugins/b/skills/access/SKILL.md': '---\nname: access\n---\nNo description.\n' }, { frontmatterErrors: 'skip' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:access']);
  // The lone top folder (plugins/) is the zip's wrapper, stripped.
  assert.deepEqual(r.json.skipped.map((k: { path: string }) => k.path), ['b/skills/access']);
  // A twin with an error no mode waives (compatibility over 500 characters), in the default mode.
  s = setup();
  r = await pack(s.t, s.h, 'lint.zip', { ...clean, 'plugins/b/skills/access/SKILL.md': `---\nname: access\ndescription: iMessage access.\ncompatibility: ${'x'.repeat(501)}\n---\nBody.\n` });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:access']);
  // Both import (the frontmatter error accepted): both prefixed, as before.
  s = setup();
  r = await pack(s.t, s.h, 'both.zip', { ...clean, 'plugins/b/skills/access/SKILL.md': '---\nname: access\n---\nNo description.\n' }, { frontmatterErrors: 'import' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:a-access', 'skill:b-access']);
});

test("5ef6: a second pack's clash with an existing name is skipped (offering the prefixed name) by default; onNameClash 'prefix' imports it as <repo>-<name>, also for an agent; re-imports find it; source update keeps the prefix", async () => {
  const BRAIN = '---\nname: brainstorming\ndescription: MPM brainstorming.\n---\n# Brainstorming\nUpstream body.\n';
  gh.repos['obra/superpowers'] = { default_branch: 'main', refs: { main: sha2('5d') }, trees: { [sha2('5d')]: { 'skills/brainstorming/SKILL.md': skill('brainstorming') } } };
  const mpm = (body: string): Files => ({ 'skills/brainstorming/SKILL.md': BRAIN + body, 'skills/other/SKILL.md': skill('other'), 'agents/reviewer.md': AGENT });
  gh.repos['bobmatnyc/claude-mpm-skills'] = { default_branch: 'main', refs: { main: sha2('c2') }, trees: { [sha2('c2')]: mpm(''), [sha2('c3')]: mpm('More.\n') } };
  const { t, h } = setup();
  assert.equal((await github(t, h, { repo: 'obra/superpowers' })).status, 201);
  assert.equal((await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'agent', content: AGENT } })).status, 201);

  const skip = await github(t, h, { repo: 'bobmatnyc/claude-mpm-skills' });
  assert.equal(skip.status, 201, skip.text);
  assert.deepEqual(names(skip.json.items), ['skill:other']);
  assert.deepEqual(skip.json.skipped, [
    { path: 'skills/brainstorming', reason: "you already have a skill named 'brainstorming'", prefixed: 'claude-mpm-skills-brainstorming' },
    { path: 'agents/reviewer.md', reason: "you already have an agent named 'reviewer'", prefixed: 'claude-mpm-skills-reviewer' },
  ]);

  const pre = await github(t, h, { repo: 'bobmatnyc/claude-mpm-skills', onNameClash: 'prefix', group: 'mpm' });
  assert.equal(pre.status, 201, pre.text);
  assert.deepEqual(pre.json.items.map((i: Out) => [i.name, i.op]).sort(), [['claude-mpm-skills-brainstorming', 'create'], ['claude-mpm-skills-reviewer', 'create'], ['other', 'unchanged']]);
  assert.deepEqual(pre.json.skipped, []);
  assert.deepEqual(pre.json.group.members.map((m: { item: { name: string } }) => m.item.name).sort(), ['claude-mpm-skills-brainstorming', 'claude-mpm-skills-reviewer', 'other']);
  const brain = byName(pre.json.items, 'claude-mpm-skills-brainstorming');
  assert.equal(await fileText(t, h, brain.id, 'SKILL.md'), BRAIN.replace('name: brainstorming', 'name: claude-mpm-skills-brainstorming'));
  const rev = byName(pre.json.items, 'claude-mpm-skills-reviewer');
  assert.match(await fileText(t, h, rev.id, 'claude-mpm-skills-reviewer.md'), /^---\nname: claude-mpm-skills-reviewer\n/);
  const bundle = await bundleFiles(t, h, 'mpm');
  assert.match(bundle.get('.claude/skills/claude-mpm-skills-brainstorming/SKILL.md')!, /^---\nname: claude-mpm-skills-brainstorming\n/);
  assert.ok(bundle.has('.claude/agents/claude-mpm-skills-reviewer.md'));

  // A later re-import without the option still finds the prefixed items (no skip, no duplicate).
  const again = await github(t, h, { repo: 'bobmatnyc/claude-mpm-skills' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]).sort(), [['claude-mpm-skills-brainstorming', 'unchanged'], ['claude-mpm-skills-reviewer', 'unchanged'], ['other', 'unchanged']]);
  assert.deepEqual(again.json.skipped, []);

  // Source update at a new commit: upstream still says 'brainstorming', the item keeps its prefixed name.
  gh.repos['bobmatnyc/claude-mpm-skills'].refs.main = sha2('c3');
  const up = await t.req('POST', `${API}/items/${brain.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.name, 'claude-mpm-skills-brainstorming');
  assert.equal(up.json.item.latestSeq, 2);
  assert.equal(await fileText(t, h, brain.id, 'SKILL.md'), (BRAIN + 'More.\n').replace('name: brainstorming', 'name: claude-mpm-skills-brainstorming'));
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 5);

  // A zip's prefix is its file name.
  const z = await pack(t, h, 'mytools.zip', { 'skills/brainstorming/SKILL.md': skill('brainstorming') }, { onNameClash: 'prefix' });
  assert.equal(z.status, 201, z.text);
  assert.deepEqual(names(z.json.items), ['skill:mytools-brainstorming']);
  assert.equal((await pack(t, h, 'mytools.zip', {}, { onNameClash: 'sometimes' })).status, 400);
});

test('5ef6: a prefixed item stays the item of its source path once the clash is gone: a re-import versions it under its name, never creates a bare twin or a second member', async () => {
  // Plugin b leaves upstream, so a's copy is the only 'access' left.
  const { t, h } = setup();
  const access = (desc: string): Files => ({ 'plugins/a/.claude-plugin/plugin.json': '{}', 'plugins/a/skills/access/SKILL.md': skill('access', desc) });
  const both = { ...access('Discord access.'), 'plugins/b/.claude-plugin/plugin.json': '{}', 'plugins/b/skills/access/SKILL.md': skill('access', 'iMessage access.') };
  const r1 = await pack(t, h, 'official.zip', both, { group: 'official' });
  assert.deepEqual(names(r1.json.items), ['skill:a-access', 'skill:b-access']);
  const a = byName(r1.json.items, 'a-access');
  const r2 = await pack(t, h, 'official.zip', access('Discord access, v2.'), { intoGroup: 'official' });
  assert.equal(r2.status, 201, r2.text);
  assert.deepEqual(r2.json.items.map((i: Out) => [i.name, i.op]), [['a-access', 'version']]);
  assert.equal(r2.json.items[0].id, a.id);
  assert.equal(await fileText(t, h, a.id, 'SKILL.md'), skill('access', 'Discord access, v2.').replace('name: access', 'name: a-access'));
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 2);
  assert.deepEqual(memberNames(r2.json.group), ['skill:a-access', 'skill:b-access']);
  // A different source path is its own item, even under a name another path's item once had.
  const r3 = await pack(t, h, 'official.zip', { ...access('Discord access, v2.'), 'plugins/c/.claude-plugin/plugin.json': '{}', 'plugins/c/skills/access/SKILL.md': skill('access', 'Telegram access.') }, { intoGroup: 'official' });
  assert.equal(r3.status, 201, r3.text);
  assert.deepEqual(r3.json.items.map((i: Out) => [i.name, i.op]).sort(), [['a-access', 'unchanged'], ['c-access', 'create']]);
  assert.equal(byName(r3.json.items, 'c-access').source.path, 'c/skills/access');
  assert.deepEqual(memberNames(r3.json.group), ['skill:a-access', 'skill:b-access', 'skill:c-access']);
});

test("5ef6: a cross-source prefixed item stays its source's item once the other source's is deleted", async () => {
  gh.repos['o/one'] = { default_branch: 'main', refs: { main: sha2('b8') }, trees: { [sha2('b8')]: { 'skills/brain/SKILL.md': skill('brain') } } };
  gh.repos['o/two'] = { default_branch: 'main', refs: { main: sha2('b9') }, trees: { [sha2('b9')]: { 'skills/brain/SKILL.md': skill('brain', 'Two.') }, [sha2('ba')]: { 'skills/brain/SKILL.md': skill('brain', 'Two, v2.') } } };
  const t2 = setup();
  const one = await github(t2.t, t2.h, { repo: 'o/one' });
  const two = await github(t2.t, t2.h, { repo: 'o/two', onNameClash: 'prefix', group: 'two' });
  assert.deepEqual(names(two.json.items), ['skill:two-brain']);
  assert.equal((await t2.t.req('DELETE', `${API}/items/${one.json.items[0].id}`, { headers: t2.h })).status, 204);
  gh.repos['o/two'].refs.main = sha2('ba');
  const again = await github(t2.t, t2.h, { repo: 'o/two', intoGroup: 'two' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]), [['two-brain', 'version']]);
  assert.equal(await fileText(t2.t, t2.h, two.json.items[0].id, 'SKILL.md'), skill('brain', 'Two, v2.').replace('name: brain', 'name: two-brain'));
  assert.equal(count(t2.t, "SELECT COUNT(*) AS n FROM items WHERE source_repo = 'o/two'"), 1);
  assert.deepEqual(memberNames(again.json.group), ['skill:two-brain']);
});

/** Valid fences, invalid YAML (a colon inside a plain value): the frontmatter cannot be parsed, so no name can be set in it. */
const BAD_YAML = '---\nname: access\ndescription: Use when: x\n---\n';
const badYamlReason = (name: string) => `its frontmatter is not valid YAML, so it cannot take the prefixed name '${name}'`;

test('5ef6: in-import twins whose frontmatter is not valid YAML are skipped (frontmatterErrors import), never imported under the bare name', async () => {
  const { t, h } = setup();
  const files: Files = {
    'plugins/a/.claude-plugin/plugin.json': '{}',
    'plugins/a/skills/access/SKILL.md': BAD_YAML,
    'plugins/b/.claude-plugin/plugin.json': '{}',
    'plugins/b/skills/access/SKILL.md': BAD_YAML,
    'plugins/b/skills/solo/SKILL.md': skill('solo'),
  };
  const r = await pack(t, h, 'official.zip', files, { frontmatterErrors: 'import' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:solo']);
  // The zip's one top folder (plugins/) is stripped.
  assert.deepEqual(r.json.skipped, [
    { path: 'a/skills/access', reason: `another skill of this import is named 'access', and ${badYamlReason('a-access')}` },
    { path: 'b/skills/access', reason: `another skill of this import is named 'access', and ${badYamlReason('b-access')}` },
  ]);
  assert.equal(count(t, "SELECT COUNT(*) AS n FROM items WHERE name LIKE '%access'"), 0);
  // A twin whose frontmatter parses but names nothing takes the prefixed name, inserted into its block.
  const t2 = setup();
  const r2 = await pack(t2.t, t2.h, 'official.zip', { ...files, 'plugins/a/skills/access/SKILL.md': '---\ndescription: Discord access.\n---\nBody.\n', 'plugins/b/skills/access/SKILL.md': skill('access') });
  assert.equal(r2.status, 201, r2.text);
  assert.deepEqual(names(r2.json.items), ['skill:a-access', 'skill:b-access', 'skill:solo']);
  assert.equal(await fileText(t2.t, t2.h, byName(r2.json.items, 'a-access').id, 'SKILL.md'), '---\nname: a-access\ndescription: Discord access.\n---\nBody.\n');
});

test('5ef6: source update of a prefixed item whose upstream drops name: inserts the prefixed name; invalid YAML is refused, item unchanged; valid frontmatter again updates', async () => {
  const brain = (fm: string) => ({ 'skills/brain/SKILL.md': fm });
  gh.repos['o/one-p'] = { default_branch: 'main', refs: { main: sha2('f1') }, trees: { [sha2('f1')]: brain(skill('brain')) } };
  gh.repos['o/two-p'] = {
    default_branch: 'main',
    refs: { main: sha2('f2') },
    trees: { [sha2('f2')]: brain(skill('brain', 'Two.')), [sha2('f3')]: brain('---\ndescription: Two v2.\n---\n'), [sha2('f4')]: brain(BAD_YAML.replace('access', 'brain')), [sha2('f5')]: brain(skill('brain', 'Two v4.')) },
  };
  const { t, h } = setup();
  assert.equal((await github(t, h, { repo: 'o/one-p' })).status, 201);
  const two = await github(t, h, { repo: 'o/two-p', onNameClash: 'prefix' });
  assert.deepEqual(names(two.json.items), ['skill:two-p-brain']);
  const id = two.json.items[0].id;
  const update = () => t.req('POST', `${API}/items/${id}/source/update`, { headers: h });

  gh.repos['o/two-p'].refs.main = sha2('f3');
  const up = await update();
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.latestSeq, 2);
  assert.equal(await fileText(t, h, id, 'SKILL.md'), '---\nname: two-p-brain\ndescription: Two v2.\n---\n');

  // Invalid YAML: no name can be set, so neither source/update nor a re-import accepting frontmatter errors writes it.
  gh.repos['o/two-p'].refs.main = sha2('f4');
  const bad = await update();
  assert.equal(bad.status, 422, bad.text);
  assert.equal(bad.json.error.message, badYamlReason('two-p-brain'));
  const re = await github(t, h, { repo: 'o/two-p', frontmatterErrors: 'import' });
  assert.equal(re.status, 422, re.text);
  assert.deepEqual(re.json.error.details, [{ path: 'skills/brain', reason: badYamlReason('two-p-brain') }]);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items WHERE id = ? AND latest_seq = 2', id), 1);
  assert.equal(await fileText(t, h, id, 'SKILL.md'), '---\nname: two-p-brain\ndescription: Two v2.\n---\n');

  gh.repos['o/two-p'].refs.main = sha2('f5');
  const ok = await update();
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.item.latestSeq, 3);
  assert.equal(await fileText(t, h, id, 'SKILL.md'), skill('brain', 'Two v4.').replace('name: brain', 'name: two-p-brain'));
});

test("5ef6: onNameClash 'prefix' across sources: invalid YAML is skipped, never imported bare; a prefixed agent whose upstream drops name: takes the prefixed name on source update", async () => {
  const rev = (fm: string) => `---\n${fm}---\nYou review code.\n`;
  gh.repos['o/x'] = {
    default_branch: 'main',
    refs: { main: sha2('f7') },
    trees: { [sha2('f7')]: { 'skills/access/SKILL.md': BAD_YAML, 'agents/reviewer.md': AGENT }, [sha2('f8')]: { 'skills/access/SKILL.md': BAD_YAML, 'agents/reviewer.md': rev('description: Reviews, v2.\n') } },
  };
  const { t, h } = setup();
  assert.equal((await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'skill', content: skill('access') } })).status, 201);
  assert.equal((await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'agent', content: AGENT } })).status, 201);
  const r = await github(t, h, { repo: 'o/x', onNameClash: 'prefix', frontmatterErrors: 'import' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['agent:x-reviewer']);
  assert.deepEqual(r.json.skipped, [{ path: 'skills/access', reason: badYamlReason('x-access') }]);
  const id = r.json.items[0].id;
  gh.repos['o/x'].refs.main = sha2('f8');
  const up = await t.req('POST', `${API}/items/${id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(await fileText(t, h, id, 'x-reviewer.md'), rev('name: x-reviewer\ndescription: Reviews, v2.\n'));
});

test("5ef6: onNameClash 'prefix' whose <repo>-<name> another zip's item holds says the prefixed name is taken too", async () => {
  const { t, h } = setup();
  assert.equal((await pack(t, h, 'a.zip', { 'skills/tools/SKILL.md': skill('tools') })).status, 201);
  assert.equal((await pack(t, h, 'b.zip', { 'skills/mytools-tools/SKILL.md': skill('mytools-tools') })).status, 201);
  const r = await pack(t, h, 'mytools.zip', { 'skills/tools/SKILL.md': skill('tools') }, { onNameClash: 'prefix' });
  assert.equal(r.status, 422, r.text);
  assert.deepEqual(r.json.error.details, [{ path: 'skills/tools', reason: "you already have a skill named 'tools', and its prefixed name 'mytools-tools' is taken too (imported from b.zip)" }]);
});

test('5ef6: a supplied name is the skill or agent frontmatter name', async () => {
  gh.repos['acme/named'] = { default_branch: 'main', refs: { main: sha2('f6') }, trees: { [sha2('f6')]: { 'skills/foo/SKILL.md': skill('foo'), 'skills/bare/SKILL.md': '---\ndescription: No name.\n---\n', 'agents/reviewer.md': AGENT, 'skills/bad/SKILL.md': BAD_YAML } } };
  const { t, h } = setup();
  const s = await github(t, h, { repo: 'acme/named', path: 'skills/foo', name: 'mine' });
  assert.equal(s.status, 201, s.text);
  assert.equal(await fileText(t, h, s.json.items[0].id, 'SKILL.md'), skill('foo').replace('name: foo', 'name: mine'));
  // With a kind override as well.
  const k = await github(t, h, { repo: 'acme/named', path: 'skills/foo', kind: 'skill', name: 'mine-kind' });
  assert.equal(k.status, 201, k.text);
  assert.equal(await fileText(t, h, k.json.items[0].id, 'SKILL.md'), skill('foo').replace('name: foo', 'name: mine-kind'));
  const b = await github(t, h, { repo: 'acme/named', path: 'skills/bare', name: 'mine-too' });
  assert.equal(b.status, 201, b.text);
  assert.equal(await fileText(t, h, b.json.items[0].id, 'SKILL.md'), '---\nname: mine-too\ndescription: No name.\n---\n');
  const a = await github(t, h, { repo: 'acme/named', path: 'agents/reviewer.md', name: 'rev' });
  assert.equal(a.status, 201, a.text);
  assert.equal(await fileText(t, h, a.json.items[0].id, 'rev.md'), AGENT.replace('name: reviewer', 'name: rev'));
  const bad = await github(t, h, { repo: 'acme/named', path: 'skills/bad', name: 'mine-bad', frontmatterErrors: 'import' });
  assert.equal(bad.status, 422, bad.text);
  assert.equal(bad.json.error.message, "its frontmatter is not valid YAML, so it cannot take the name 'mine-bad'");
});

/**
 * anthropics/mkt imports discord-access and imessage-access (in-import prefix); someone/fork, the same tree,
 * then takes fork-discord-access with onNameClash 'prefix' (both prefixes). No single candidate prefix
 * (the repository name or one folder) turns the bare 'access' into that name, so it is recorded.
 */
const doublePrefixed = async (t: TestCtx, h: H) => {
  const mkt = (desc: string, both = true): Files => ({
    'plugins/discord/.claude-plugin/plugin.json': '{}',
    'plugins/discord/skills/access/SKILL.md': skill('access', desc),
    ...(both && { 'plugins/imessage/.claude-plugin/plugin.json': '{}', 'plugins/imessage/skills/access/SKILL.md': skill('access', 'iMessage access.') }),
  });
  gh.repos['anthropics/mkt'] = { default_branch: 'main', refs: { main: sha2('e1') }, trees: { [sha2('e1')]: mkt('Discord access.') } };
  gh.repos['someone/fork'] = {
    default_branch: 'main',
    refs: { main: sha2('e2') },
    trees: { [sha2('e2')]: mkt('Discord access.'), [sha2('e3')]: mkt('Discord access, v2.'), [sha2('e4')]: mkt('Discord access, v3.', false) },
  };
  assert.deepEqual(names((await github(t, h, { repo: 'anthropics/mkt' })).json.items), ['skill:discord-access', 'skill:imessage-access']);
  const fork = await github(t, h, { repo: 'someone/fork', onNameClash: 'prefix' });
  assert.equal(fork.status, 201, fork.text);
  assert.deepEqual(names(fork.json.items), ['skill:fork-discord-access', 'skill:fork-imessage-access']);
  return byName(fork.json.items, 'fork-discord-access');
};
const forkAccess = (desc: string) => skill('access', desc).replace('name: access', 'name: fork-discord-access');

test('5ef6: an item prefixed inside its import and across sources (fork-discord-access) keeps its name on source update', async () => {
  const { t, h } = setup();
  const item = await doublePrefixed(t, h);
  gh.repos['someone/fork'].refs.main = sha2('e3');
  const up = await t.req('POST', `${API}/items/${item.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.name, 'fork-discord-access');
  assert.equal(up.json.item.latestSeq, 2);
  assert.equal(await fileText(t, h, item.id, 'SKILL.md'), forkAccess('Discord access, v2.'));
  assert.equal((t.db.prepare('SELECT source_prefix FROM items WHERE id = ?').get(item.id) as { source_prefix: string }).source_prefix, 'fork-discord');
});

test('5ef6: a re-import of a doubly prefixed item at a new commit versions the same item, also once the in-import clash is gone', async () => {
  const { t, h } = setup();
  const item = await doublePrefixed(t, h);
  // A new commit, both plugins still there: the unit takes discord-access inside the import again.
  gh.repos['someone/fork'].refs.main = sha2('e3');
  const again = await github(t, h, { repo: 'someone/fork' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]).sort(), [['fork-discord-access', 'version'], ['fork-imessage-access', 'unchanged']]);
  assert.equal(byName(again.json.items, 'fork-discord-access').id, item.id);
  assert.equal(await fileText(t, h, item.id, 'SKILL.md'), forkAccess('Discord access, v2.'));
  // imessage leaves upstream: the unit now takes the bare 'access', and is still the same item.
  gh.repos['someone/fork'].refs.main = sha2('e4');
  const gone = await github(t, h, { repo: 'someone/fork' });
  assert.equal(gone.status, 201, gone.text);
  assert.deepEqual(gone.json.items.map((i: Out) => [i.name, i.op, i.id]), [['fork-discord-access', 'version', item.id]]);
  assert.equal(await fileText(t, h, item.id, 'SKILL.md'), forkAccess('Discord access, v3.'));
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 4);
});

test('5ef6: a unit whose <prefix>-<name> would pass the 64-character name limit is skipped, never prefixed to a cut name', async () => {
  // 'claude-mpm-skills-' + 50 characters is 68: cut to 64, the name no longer ends in -<name> (source update
  // would 422 on skill.name.dir), and these two would cut to the same name.
  const long = 'x'.repeat(46);
  const [one, two] = [`${long}-one`, `${long}-two`];
  const reason = (name: string) => `you already have a skill named '${name}'; 'claude-mpm-skills-${name}' would exceed the 64-character name limit, so it cannot take the prefix`;
  const { t, h } = setup();
  for (const n of [one, two]) assert.equal((await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'skill', content: skill(n) } })).status, 201);
  const mpm: Files = { [`skills/${one}/SKILL.md`]: skill(one), [`skills/${two}/SKILL.md`]: skill(two), 'skills/other/SKILL.md': skill('other') };
  for (const onNameClash of ['skip', 'prefix']) {
    const r = await pack(t, h, 'claude-mpm-skills.zip', mpm, { onNameClash });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(names(r.json.items), ['skill:other']);
    // No prefixed offer: the dialog must not propose a name the import cannot create.
    assert.deepEqual(r.json.skipped, [{ path: `skills/${one}`, reason: reason(one) }, { path: `skills/${two}`, reason: reason(two) }]);
  }
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 3);

  // Inside one import: the copy whose plugin prefix would pass the limit is skipped, the other is prefixed.
  const t2 = setup();
  const plugin = 'p'.repeat(20);
  const r = await pack(t2.t, t2.h, 'official.zip', {
    'plugins/a/.claude-plugin/plugin.json': '{}',
    [`plugins/a/skills/${one}/SKILL.md`]: skill(one),
    [`plugins/${plugin}/.claude-plugin/plugin.json`]: '{}',
    [`plugins/${plugin}/skills/${one}/SKILL.md`]: skill(one),
  });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), [`skill:a-${one}`]);
  // The zip's one top folder (plugins/) is stripped.
  assert.deepEqual(r.json.skipped, [{ path: `${plugin}/skills/${one}`, reason: `another skill of this import is named '${one}', and '${plugin}-${one}' would exceed the 64-character name limit` }]);

  // A plugin folder whose name alone passes the limit (5vz2): skipped the same way, never imported bare.
  const t3 = setup();
  const huge = 'l'.repeat(70);
  const r3 = await pack(t3.t, t3.h, 'official.zip', {
    'plugins/b/.claude-plugin/plugin.json': '{}',
    'plugins/b/skills/access/SKILL.md': skill('access'),
    [`plugins/${huge}/.claude-plugin/plugin.json`]: '{}',
    [`plugins/${huge}/skills/access/SKILL.md`]: skill('access'),
  });
  assert.equal(r3.status, 201, r3.text);
  assert.deepEqual(names(r3.json.items), ['skill:b-access']);
  assert.deepEqual(r3.json.skipped, [{ path: `${huge}/skills/access`, reason: `another skill of this import is named 'access', and '${huge}-access' would exceed the 64-character name limit` }]);
});

test("5ef6: a one-file GitHub import's clash is reported at the file's path, not the root of its one-file tree", async () => {
  gh.repos['acme/stax'] = { default_branch: 'main', refs: { main: sha2('d4') }, trees: { [sha2('d4')]: { 'skill.md': skill('stax'), 'docs/skill.md': skill('stax') } } };
  const { t, h } = setup();
  assert.equal((await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'skill', content: skill('stax') } })).status, 201);
  for (const path of ['skill.md', 'docs/skill.md']) {
    const r = await github(t, h, { repo: 'acme/stax', path });
    assert.equal(r.status, 422, r.text);
    assert.deepEqual(r.json.error.details, [{ path, reason: "you already have a skill named 'stax'", prefixed: 'stax-stax' }]);
  }
});

/** One clean skill and one missing its description, the first paragraph of its body its description of last resort. */
const NODESC = '---\nname: nodesc\n---\n# No description\n\nFirst paragraph\nof the body.\n\nSecond.\n';
const MIXED: Files = { 'skills/good/SKILL.md': skill('good'), 'skills/nodesc/SKILL.md': NODESC };
const NODESC_ERRORS = [{ path: 'skills/nodesc', kind: 'skill', errors: ['frontmatter description is required'] }];

test("0rdh: frontmatter errors are asked about (409, nothing written, no group); 'skip' matches today; 'import' stores them with upstream bytes and waived warnings", async () => {
  const ask = setup();
  const r = await pack(ask.t, ask.h, 'mixed.zip', MIXED, { group: 'mixed' });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error.code, 'frontmatter_errors');
  assert.deepEqual(r.json.error.details, NODESC_ERRORS);
  assert.equal(count(ask.t, 'SELECT COUNT(*) AS n FROM items'), 0);
  assert.equal(count(ask.t, 'SELECT COUNT(*) AS n FROM scp_groups'), 0);
  assert.equal(count(ask.t, 'SELECT COUNT(*) AS n FROM deleted_group_slugs'), 0, 'the slug stays free');
  assert.equal((await pack(ask.t, ask.h, 'mixed.zip', MIXED, { frontmatterErrors: 'maybe' })).status, 400);

  const skip = await pack(ask.t, ask.h, 'mixed.zip', MIXED, { group: 'mixed', frontmatterErrors: 'skip' });
  assert.equal(skip.status, 201, skip.text);
  assert.deepEqual(names(skip.json.items), ['skill:good']);
  assert.deepEqual(skip.json.skipped, [{ path: 'skills/nodesc', reason: 'frontmatter description is required' }]);

  const imp = setup();
  const r2 = await pack(imp.t, imp.h, 'mixed.zip', MIXED, { group: 'mixed', frontmatterErrors: 'import' });
  assert.equal(r2.status, 201, r2.text);
  assert.deepEqual(names(r2.json.items), ['skill:good', 'skill:nodesc']);
  assert.deepEqual(r2.json.group.members.map((m: { item: { name: string } }) => m.item.name).sort(), ['good', 'nodesc']);
  const nodesc = byName(r2.json.items, 'nodesc') as Out & { description: string; version: { lint: unknown[] } };
  assert.equal(nodesc.description, 'First paragraph of the body.');
  assert.deepEqual(nodesc.version.lint.filter((l) => (l as { waived?: boolean }).waived), [
    { level: 'warn', code: 'skill.description.missing', message: 'frontmatter description is required', path: 'SKILL.md', waived: true },
  ]);
  assert.deepEqual(byName(r2.json.items, 'good').version.lint, [], 'a clean unit carries no waiver');
  assert.equal(await fileText(imp.t, imp.h, nodesc.id, 'SKILL.md'), NODESC, 'the upstream bytes, untouched');
  // A bundle serves the upstream file unchanged.
  assert.equal((await bundleFiles(imp.t, imp.h, 'mixed')).get('.claude/skills/nodesc/SKILL.md'), NODESC);
  // A re-upload does not ask again for the unit it took with its errors.
  const again = await pack(imp.t, imp.h, 'mixed.zip', { ...MIXED, 'skills/nodesc/SKILL.md': NODESC + 'Third.\n' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]).sort(), [['good', 'unchanged'], ['nodesc', 'version']]);
  // A local edit is still held to lint: the waiver is the import's, not the editor's.
  const edit = await imp.t.req('POST', `${API}/items/${nodesc.id}/versions`, { headers: imp.h, json: { content: NODESC } });
  assert.equal(edit.status, 422, edit.text);
});

test('0rdh: a unit with any other lint error (bad skill name characters) is skipped in every mode, never asked about', async () => {
  const BAD = '---\nname: Bad_Name\n---\nno description either\n';
  for (const mode of [undefined, 'ask', 'import', 'skip']) {
    const { t, h } = setup();
    const r = await pack(t, h, 'bad.zip', { 'skills/good/SKILL.md': skill('good'), 'skills/bad/SKILL.md': BAD }, mode ? { frontmatterErrors: mode } : {});
    assert.equal(r.status, 201, `${mode}: ${r.text}`);
    assert.deepEqual(names(r.json.items), ['skill:good']);
    assert.equal(r.json.skipped.length, 1);
    assert.equal(r.json.skipped[0].path, 'skills/bad');
    assert.match(r.json.skipped[0].reason, /must match/);
  }
});

test("0rdh: GitHub, silent-failure-hunter's plugin folder (a YAML error) is asked about, then imported named by its file; source update and re-import accept it without asking", async () => {
  const HUNTER = (body: string) => `---\nname: silent-failure-hunter\ndescription: Use this agent when: reviewing code\nmodel: inherit\n---\n# Hunter\n\n${body}`;
  const official = (body: string): Files => ({
    'plugins/pr-review-toolkit/.claude-plugin/plugin.json': '{"name":"pr-review-toolkit"}',
    'plugins/pr-review-toolkit/agents/silent-failure-hunter.md': HUNTER(body),
    'plugins/pr-review-toolkit/agents/clean.md': agentMd('clean'),
  });
  gh.repos['anthropics/claude-plugins-official'] = {
    default_branch: 'main',
    refs: { main: sha2('5e') },
    trees: { [sha2('5e')]: official('You hunt silent failures.\n'), [sha2('5f')]: official('You hunt them all.\n'), [sha2('d3')]: official('Every one.\n') },
  };
  const url = 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pr-review-toolkit';
  const { t, h } = setup();
  const ask = await github(t, h, { url });
  assert.equal(ask.status, 409, ask.text);
  assert.deepEqual(ask.json.error.details, [
    { path: 'agents/silent-failure-hunter.md', kind: 'agent', errors: ['frontmatter: Nested mappings are not allowed in compact mappings at line 2, column 14:', 'frontmatter name is required', 'frontmatter description is required'] },
  ]);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), 0);

  const r = await github(t, h, { url, frontmatterErrors: 'import' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['agent:clean', 'agent:silent-failure-hunter']);
  const hunter = byName(r.json.items, 'silent-failure-hunter') as Out & { description: string; version: { lint: { waived?: boolean }[] } };
  assert.equal(hunter.description, 'You hunt silent failures.');
  assert.equal(hunter.version.lint.filter((l) => (l as { waived?: boolean }).waived).length, 3);
  assert.equal(await fileText(t, h, hunter.id, 'silent-failure-hunter.md'), HUNTER('You hunt silent failures.\n'));

  gh.repos['anthropics/claude-plugins-official'].refs.main = sha2('5f');
  const up = await t.req('POST', `${API}/items/${hunter.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.latestSeq, 2);
  assert.ok(up.json.item.version.lint.some((l: { waived?: boolean }) => l.waived));

  gh.repos['anthropics/claude-plugins-official'].refs.main = sha2('d3');
  const again = await github(t, h, { url });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]).sort(), [['clean', 'unchanged'], ['silent-failure-hunter', 'version']]);
});

type Supplied = Omit<Out, 'version'> & { suppliedFrontmatter: { name?: string; description: string } | null; upstreamFrontmatter: boolean; latestSeq: number; version: { frontmatter: Record<string, unknown>; lint: { level: string }[] } };
/** The frontmatter block a file opens with ('' when none). */
const blockOf = (text: string) => (text.startsWith('---\n') ? text.slice(0, text.indexOf('\n---\n', 3) + 5) : '');
const HOSTILE = 'Use when: reviewing code # not a comment\nsecond line: "quoted"';

test('jcfm: a description becomes the frontmatter of a file with none and is stored; a file with its own keeps it and stores nothing; one description on many items is a 400', async () => {
  const { t, h } = setup();
  const r = await pack(t, h, 'my-skill.zip', { 'my-skill/SKILL.md': '# My skill\n\nDoes things.\n' }, { description: 'Does things: well.' });
  assert.equal(r.status, 201, r.text);
  const it = r.json.items[0] as Supplied;
  assert.equal(it.name, 'my-skill');
  assert.deepEqual(it.suppliedFrontmatter, { name: 'my-skill', description: 'Does things: well.' });
  assert.equal(it.upstreamFrontmatter, false);
  assert.equal(await fileText(t, h, it.id, 'SKILL.md'), '---\nname: my-skill\ndescription: "Does things: well."\n---\n# My skill\n\nDoes things.\n');
  assert.equal(it.version.lint.filter((l) => l.level === 'error').length, 0);

  const own = await pack(t, h, 'own.zip', { 'own/SKILL.md': skill('own') }, { description: 'ignored' });
  assert.equal(own.status, 201, own.text);
  assert.equal((own.json.items[0] as Supplied).suppliedFrontmatter, null);
  assert.equal(await fileText(t, h, own.json.items[0].id, 'SKILL.md'), skill('own'));
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items WHERE supplied_frontmatter IS NOT NULL'), 1);

  const before = count(t, 'SELECT COUNT(*) AS n FROM items');
  const many = await pack(t, h, 'many.zip', { 'skills/a/SKILL.md': skill('a'), 'skills/b/SKILL.md': skill('b') }, { description: 'one for all' });
  assert.equal(many.status, 400, many.text);
  assert.match(many.json.error.message, /exactly one item \(found 2\)/);
  gh.repos['acme/two'] = { default_branch: 'main', refs: { main: sha2('ce') }, trees: { [sha2('ce')]: { 'skills/a/SKILL.md': skill('a'), 'skills/b/SKILL.md': skill('b') } } };
  const manyGh = await github(t, h, { repo: 'acme/two', description: 'one for all' });
  assert.equal(manyGh.status, 400, manyGh.text);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), before, 'nothing written');
  // Over lint's 1024-char cap is refused; blank is no description at all.
  assert.equal((await pack(t, h, 'long.zip', { 'long/SKILL.md': '# L\n' }, { description: 'x'.repeat(1025) })).status, 400);
  const blank = await github(t, h, { repo: 'acme/two', path: 'skills/a', description: '   ' });
  assert.equal(blank.status, 201, blank.text);
  assert.equal((blank.json.items[0] as Supplied).suppliedFrontmatter, null);
});

test('jcfm: source/update and re-import re-apply the stored frontmatter byte for byte; upstream adding its own wins and the item says so; YAML-special values round-trip', async () => {
  const body = (n: string) => `You help with step ${n}.\n`;
  const own = '---\nname: helper\ndescription: Upstream now describes it.\n---\nYou help, upstream.\n';
  gh.repos['acme/nofm'] = {
    default_branch: 'main',
    refs: { main: sha2('ca') },
    trees: { [sha2('ca')]: { 'agents/helper.md': body('1') }, [sha2('cb')]: { 'agents/helper.md': body('2') }, [sha2('c9')]: { 'agents/helper.md': body('3') }, [sha2('cd')]: { 'agents/helper.md': own } },
  };
  const { t, h } = setup();
  const r = await github(t, h, { repo: 'acme/nofm', path: 'agents/helper.md', kind: 'agent', name: 'helper', description: HOSTILE });
  assert.equal(r.status, 201, r.text);
  const it = r.json.items[0] as Supplied;
  assert.deepEqual(it.suppliedFrontmatter, { name: 'helper', description: HOSTILE });
  assert.deepEqual(it.version.frontmatter, { name: 'helper', description: HOSTILE }, 'the special characters parse back exactly');
  const first = await fileText(t, h, it.id, 'helper.md');
  const block = blockOf(first);
  assert.ok(block && first === block + body('1'), first);

  gh.repos['acme/nofm'].refs.main = sha2('cb');
  const up = await t.req('POST', `${API}/items/${it.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.latestSeq, 2);
  assert.equal(await fileText(t, h, it.id, 'helper.md'), block + body('2'), 'the same block, byte for byte');

  // A re-import without a description takes the stored fields too: nothing to ask about, the same block.
  gh.repos['acme/nofm'].refs.main = sha2('c9');
  const again = await github(t, h, { repo: 'acme/nofm', path: 'agents/helper.md', kind: 'agent', name: 'helper' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual([again.json.items[0].id, again.json.items[0].op], [it.id, 'version']);
  assert.equal(await fileText(t, h, it.id, 'helper.md'), block + body('3'));

  gh.repos['acme/nofm'].refs.main = sha2('cd');
  const ownUp = await t.req('POST', `${API}/items/${it.id}/source/update`, { headers: h });
  assert.equal(ownUp.status, 200, ownUp.text);
  assert.equal(await fileText(t, h, it.id, 'helper.md'), own, "upstream's frontmatter, untouched");
  assert.equal((ownUp.json.item as Supplied).upstreamFrontmatter, true);
  assert.deepEqual((ownUp.json.item as Supplied).suppliedFrontmatter, { name: 'helper', description: HOSTILE }, 'kept as the fallback');
  // Upstream dropping it again brings the fallback back.
  gh.repos['acme/nofm'].refs.main = sha2('cb');
  const back = await t.req('POST', `${API}/items/${it.id}/source/update`, { headers: h });
  assert.equal(back.status, 200, back.text);
  assert.equal((back.json.item as Supplied).upstreamFrontmatter, false);
  assert.equal(await fileText(t, h, it.id, 'helper.md'), block + body('2'));
});

test('jcfm: a re-import at the same commit that brings a description writes the block and stores it; without one it stays unchanged', async () => {
  const guide = '# Stax agent guide\n\nUse `st`.\n';
  gh.repos['acme/samec'] = { default_branch: 'main', refs: { main: sha2('e4') }, trees: { [sha2('e4')]: { 'skills.md': guide } } };
  const { t, h } = setup();
  const body = { repo: 'acme/samec', path: 'skills.md', kind: 'skill', frontmatterErrors: 'import' };
  const r = await github(t, h, body);
  assert.equal(r.status, 201, r.text);
  const it = r.json.items[0] as Supplied;
  assert.deepEqual([it.op, it.suppliedFrontmatter], ['create', null]);

  const again = await github(t, h, { ...body, description: 'Stax.' });
  assert.equal(again.status, 201, again.text);
  const v = again.json.items[0] as Supplied;
  assert.deepEqual([v.id, v.op, v.suppliedFrontmatter, v.latestSeq], [it.id, 'version', { name: it.name, description: 'Stax.' }, 2]);
  assert.equal(await fileText(t, h, it.id, 'SKILL.md'), `---\nname: ${it.name}\ndescription: Stax.\n---\n${guide}`);
  // The same description again, or none (the stored one): nothing new.
  for (const b of [{ ...body, description: 'Stax.' }, body]) {
    const same = await github(t, h, b);
    assert.equal(same.status, 201, same.text);
    assert.deepEqual([same.json.items[0].op, same.json.items[0].latestSeq], ['unchanged', 2]);
  }
});

test('jcfm: the item page edits the supplied description: a new version with the new block; only the fallback while upstream has its own; a hand-edited block is a 409', async () => {
  gh.repos['acme/edit'] = {
    default_branch: 'main',
    refs: { main: sha2('cf') },
    trees: { [sha2('cf')]: { 'p.md': 'Body.\n', 'q.md': '# Q\n' }, [sha2('ea')]: { 'p.md': '---\nname: p\ndescription: Upstream.\n---\nBody.\n' } },
  };
  const { t, u, h } = setup();
  const r = await github(t, h, { repo: 'acme/edit', path: 'p.md', kind: 'agent', name: 'p', description: 'Old.' });
  assert.equal(r.status, 201, r.text);
  const id = r.json.items[0].id;
  const edit = (description: string, headers = h) => t.req('PUT', `${API}/items/${id}/source/frontmatter`, { headers, json: { description } });
  const e1 = await edit('New: with a colon.');
  assert.equal(e1.status, 200, e1.text);
  assert.equal(e1.json.item.latestSeq, 2);
  assert.deepEqual(e1.json.item.suppliedFrontmatter, { name: 'p', description: 'New: with a colon.' });
  assert.equal(await fileText(t, h, id, 'p.md'), '---\nname: p\ndescription: "New: with a colon."\n---\nBody.\n');
  assert.equal((await edit('  ')).status, 400);
  // Another account cannot edit it (404, it cannot read it); a read-only key cannot either.
  const other = t.createUser();
  assert.equal((await edit('x', t.key(other).headers)).status, 404);
  assert.equal((await edit('x', t.key(u, { scopes: ['read'] }).headers)).status, 403);
  // Upstream ships its own: the edit changes only the stored fallback.
  gh.repos['acme/edit'].refs.main = sha2('ea');
  assert.equal((await t.req('POST', `${API}/items/${id}/source/update`, { headers: h })).status, 200);
  const e2 = await edit('Fallback.');
  assert.equal(e2.status, 200, e2.text);
  assert.equal(e2.json.item.latestSeq, 3, 'no new version');
  assert.equal(e2.json.item.suppliedFrontmatter.description, 'Fallback.');
  // A block edited by hand is not overwritten.
  gh.repos['acme/edit'].refs.main = sha2('cf');
  assert.equal((await t.req('POST', `${API}/items/${id}/source/update`, { headers: h })).status, 200);
  assert.equal(await fileText(t, h, id, 'p.md'), '---\nname: p\ndescription: Fallback.\n---\nBody.\n');
  assert.equal((await t.req('POST', `${API}/items/${id}/versions`, { headers: h, json: { content: '---\nname: p\ndescription: Mine.\n---\nBody.\n' } })).status, 201);
  const e3 = await edit('Again.');
  assert.equal(e3.status, 409, e3.text);
  assert.equal(e3.json.error.code, 'frontmatter_edited');
  // An item SCP supplied nothing to has nothing to edit.
  const plain = await github(t, h, { repo: 'acme/edit', path: 'q.md' });
  assert.equal((await t.req('PUT', `${API}/items/${plain.json.items[0].id}/source/frontmatter`, { headers: h, json: { description: 'x' } })).status, 404);
});

test('jcfm: the stored supplied fields always describe the block the latest version carries, across edits and same-commit re-imports', async () => {
  // f6 moves HEAD with p.md byte-identical (a commit elsewhere in the repository).
  gh.repos['acme/rv'] = { default_branch: 'main', refs: { main: sha2('f5') }, trees: { [sha2('f5')]: { 'p.md': 'Body.\n' }, [sha2('f6')]: { 'p.md': 'Body.\n', 'x.md': '# X\n' } } };
  const { t, h } = setup();
  const body = { repo: 'acme/rv', path: 'p.md', kind: 'agent', name: 'p' };
  const r = await github(t, h, { ...body, description: 'Old.' });
  assert.equal(r.status, 201, r.text);
  const id = r.json.items[0].id;
  const holds = async (description: string, text = 'Body.\n') => {
    const item = (await t.req('GET', `${API}/items/${id}`, { headers: h })).json.item as Supplied;
    assert.deepEqual([item.suppliedFrontmatter, item.upstreamFrontmatter], [{ name: 'p', description }, false]);
    assert.equal(await fileText(t, h, id, 'p.md'), `---\nname: p\ndescription: ${description}\n---\n${text}`);
  };
  const edit = (description: string) => t.req('PUT', `${API}/items/${id}/source/frontmatter`, { headers: h, json: { description } });
  await holds('Old.');
  assert.equal((await edit('New.')).status, 200);
  await holds('New.');
  // The same commit again with the pre-edit description: it is what the user asked for now, so it lands.
  const old = await github(t, h, { ...body, description: 'Old.' });
  assert.equal(old.status, 201, old.text);
  assert.equal(old.json.items[0].op, 'version');
  await holds('Old.');
  const e = await edit('Newer.');
  assert.equal(e.status, 200, e.text);
  await holds('Newer.');
  // Without a description it is the stored one: nothing new, at this commit or one that left p.md alone.
  assert.equal((await github(t, h, body)).json.items[0].op, 'unchanged');
  gh.repos['acme/rv'].refs.main = sha2('f6');
  assert.equal((await t.req('POST', `${API}/items/${id}/source/update`, { headers: h })).status, 409);
  await holds('Newer.');

  // A local edit made before an edit of the description survives a commit that left the file alone.
  gh.repos['acme/rv2'] = { default_branch: 'main', refs: { main: sha2('f7') }, trees: { [sha2('f7')]: { 'p.md': 'Body.\n' }, [sha2('f8')]: { 'p.md': 'Body.\n', 'x.md': '# X\n' } } };
  const { t: t2, h: h2 } = setup();
  const r2 = await github(t2, h2, { ...body, repo: 'acme/rv2', description: 'Old.' });
  const id2 = r2.json.items[0].id;
  assert.equal((await t2.req('POST', `${API}/items/${id2}/versions`, { headers: h2, json: { content: '---\nname: p\ndescription: Old.\n---\nMine.\n' } })).status, 201);
  assert.equal((await t2.req('PUT', `${API}/items/${id2}/source/frontmatter`, { headers: h2, json: { description: 'New.' } })).status, 200);
  gh.repos['acme/rv2'].refs.main = sha2('f8');
  const up = await t2.req('POST', `${API}/items/${id2}/source/update`, { headers: h2 });
  assert.equal(up.status, 409, up.text);
  assert.equal(await fileText(t2, h2, id2, 'p.md'), '---\nname: p\ndescription: New.\n---\nMine.\n');
});

test('jcfm: a same-commit re-import whose only news is the description swaps the block on a local edit, never the upstream body over it', async () => {
  // e6 moves HEAD with p.md byte-identical (a commit elsewhere in the repository).
  gh.repos['acme/sc'] = { default_branch: 'main', refs: { main: sha2('e5') }, trees: { [sha2('e5')]: { 'p.md': 'Body.\n' }, [sha2('e6')]: { 'p.md': 'Body.\n', 'x.md': '# X\n' } } };
  const body = { repo: 'acme/sc', path: 'p.md', kind: 'agent', name: 'p' };
  const holds = async (t: TestCtx, h: H, id: string, description: string, text: string) => {
    const item = (await t.req('GET', `${API}/items/${id}`, { headers: h })).json.item as Supplied;
    assert.deepEqual([item.suppliedFrontmatter, item.upstreamFrontmatter], [{ name: 'p', description }, false]);
    assert.equal(await fileText(t, h, id, 'p.md'), `---\nname: p\ndescription: ${description}\n---\n${text}`);
  };
  // With a supplied block: the local body stays, the block becomes the new one.
  const { t, h } = setup();
  const r = await github(t, h, { ...body, description: 'Old.' });
  assert.equal(r.status, 201, r.text);
  const id = r.json.items[0].id;
  assert.equal((await t.req('POST', `${API}/items/${id}/versions`, { headers: h, json: { content: '---\nname: p\ndescription: Old.\n---\nMine.\n' } })).status, 201);
  const again = await github(t, h, { ...body, description: 'New.' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual([again.json.items[0].id, again.json.items[0].op, again.json.items[0].latestSeq], [id, 'version', 3]);
  await holds(t, h, id, 'New.', 'Mine.\n');
  // What the source last wrote took the new block too: a commit that left p.md alone is still no change.
  gh.repos['acme/sc'].refs.main = sha2('e6');
  assert.equal((await github(t, h, body)).json.items[0].op, 'unchanged');
  await holds(t, h, id, 'New.', 'Mine.\n');

  // Imported without one, edited locally, then re-imported with one: the block goes in front of the local body.
  // A command, since a skill or agent without frontmatter cannot be edited locally (lint).
  gh.repos['acme/sc'].refs.main = sha2('e5');
  const { t: t2, h: h2 } = setup();
  const cmd = { ...body, kind: 'command' };
  const r2 = await github(t2, h2, cmd);
  assert.equal(r2.status, 201, r2.text);
  const id2 = r2.json.items[0].id;
  assert.equal((await t2.req('POST', `${API}/items/${id2}/versions`, { headers: h2, json: { content: 'Mine.\n' } })).status, 201);
  const add = await github(t2, h2, { ...cmd, description: 'New.' });
  assert.equal(add.status, 201, add.text);
  assert.deepEqual([add.json.items[0].op, add.json.items[0].latestSeq, add.json.items[0].suppliedFrontmatter], ['version', 3, { description: 'New.' }]);
  assert.equal(await fileText(t2, h2, id2, 'p.md'), '---\ndescription: New.\n---\nMine.\n');
  gh.repos['acme/sc'].refs.main = sha2('e6');
  assert.equal((await github(t2, h2, cmd)).json.items[0].op, 'unchanged');
  assert.equal(await fileText(t2, h2, id2, 'p.md'), '---\ndescription: New.\n---\nMine.\n');
});

test('jcfm: a same-commit re-import with a new description and no local edit writes the upstream body with the new block', async () => {
  gh.repos['acme/sc2'] = { default_branch: 'main', refs: { main: sha2('e8') }, trees: { [sha2('e8')]: { 'p.md': 'Body.\n' } } };
  const { t, h } = setup();
  const body = { repo: 'acme/sc2', path: 'p.md', kind: 'agent', name: 'p' };
  const r = await github(t, h, { ...body, description: 'Old.' });
  assert.equal(r.status, 201, r.text);
  const id = r.json.items[0].id;
  const again = await github(t, h, { ...body, description: 'New.' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual([again.json.items[0].op, again.json.items[0].latestSeq, again.json.items[0].suppliedFrontmatter], ['version', 2, { name: 'p', description: 'New.' }]);
  assert.equal(await fileText(t, h, id, 'p.md'), '---\nname: p\ndescription: New.\n---\nBody.\n');
  // The same again is nothing new.
  assert.equal((await github(t, h, { ...body, description: 'New.' })).json.items[0].op, 'unchanged');
});

test('jcfm: a new commit that left the file alone and a new description swap the block on a local edit, never the upstream body over it', async () => {
  // n2 and n3 move HEAD with p.md byte-identical (commits elsewhere); n4 changes it.
  gh.repos['acme/nc'] = {
    default_branch: 'main',
    refs: { main: sha2('a1') },
    trees: { [sha2('a1')]: { 'p.md': 'Body.\n' }, [sha2('a2')]: { 'p.md': 'Body.\n', 'x.md': '# X\n' }, [sha2('a3')]: { 'p.md': 'Body.\n', 'y.md': '# Y\n' }, [sha2('a4')]: { 'p.md': 'Body 2.\n' } },
  };
  const { t, h } = setup();
  const body = { repo: 'acme/nc', path: 'p.md', kind: 'agent', name: 'p' };
  const r = await github(t, h, { ...body, description: 'Old.' });
  assert.equal(r.status, 201, r.text);
  const id = r.json.items[0].id;
  assert.equal((await t.req('POST', `${API}/items/${id}/versions`, { headers: h, json: { content: '---\nname: p\ndescription: Old.\n---\nMine.\n' } })).status, 201);
  gh.repos['acme/nc'].refs.main = sha2('a2');
  const again = await github(t, h, { ...body, description: 'New.' });
  assert.equal(again.status, 201, again.text);
  const v = again.json.items[0] as Supplied;
  assert.deepEqual([v.op, v.latestSeq, v.suppliedFrontmatter, again.json.items[0].source.commit], ['version', 3, { name: 'p', description: 'New.' }, sha2('a2')]);
  assert.equal(await fileText(t, h, id, 'p.md'), '---\nname: p\ndescription: New.\n---\nMine.\n', 'the local body stays');
  // What the source last wrote took the new block: another commit that leaves p.md alone is still no change.
  gh.repos['acme/nc'].refs.main = sha2('a3');
  const same = await github(t, h, body);
  assert.deepEqual([same.json.items[0].op, same.json.items[0].latestSeq, same.json.items[0].source.commit], ['unchanged', 3, sha2('a3')]);
  // An upstream change is a new version, with the new block.
  gh.repos['acme/nc'].refs.main = sha2('a4');
  const up = await t.req('POST', `${API}/items/${id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(await fileText(t, h, id, 'p.md'), '---\nname: p\ndescription: New.\n---\nBody 2.\n');

  // Without a local edit: the upstream body with the new block.
  gh.repos['acme/nc'].refs.main = sha2('a1');
  const { t: t2, h: h2 } = setup();
  const r2 = await github(t2, h2, { ...body, description: 'Old.' });
  gh.repos['acme/nc'].refs.main = sha2('a2');
  const plain = await github(t2, h2, { ...body, description: 'New.' });
  assert.equal(plain.status, 201, plain.text);
  assert.deepEqual([plain.json.items[0].op, plain.json.items[0].latestSeq], ['version', 2]);
  assert.equal(await fileText(t2, h2, r2.json.items[0].id, 'p.md'), '---\nname: p\ndescription: New.\n---\nBody.\n');
});

test('jcfm: a description for a unit whose local version has frontmatter written by hand skips the unit, at the same commit or one that left the file alone, as the item page edit refuses it', async () => {
  gh.repos['acme/hand'] = { default_branch: 'main', refs: { main: sha2('b1') }, trees: { [sha2('b1')]: { 'p.md': 'Body.\n' }, [sha2('b2')]: { 'p.md': 'Body.\n', 'x.md': '# X\n' } } };
  const { t, h } = setup();
  const cmd = { repo: 'acme/hand', path: 'p.md', kind: 'command', name: 'p' };
  const r = await github(t, h, cmd);
  assert.equal(r.status, 201, r.text);
  const id = r.json.items[0].id;
  const mine = '---\ndescription: Mine.\n---\nMine.\n';
  assert.equal((await t.req('POST', `${API}/items/${id}/versions`, { headers: h, json: { content: mine } })).status, 201);
  for (const ref of ['b1', 'b2']) {
    gh.repos['acme/hand'].refs.main = sha2(ref);
    const add = await github(t, h, { ...cmd, description: 'New.' });
    assert.equal(add.status, 422, add.text);
    assert.equal(add.json.error.code, 'nothing_imported');
    assert.match(add.json.error.details[0].reason, /frontmatter was written by hand/);
    assert.equal(await fileText(t, h, id, 'p.md'), mine, 'the hand edit stays');
    const item = (await t.req('GET', `${API}/items/${id}`, { headers: h })).json.item as Supplied;
    assert.deepEqual([item.latestSeq, item.suppliedFrontmatter, (item as unknown as { source: { commit: string } }).source.commit], [2, null, sha2('b1')]);
  }
  // Without a description it is no update, as before.
  assert.equal((await github(t, h, cmd)).json.items[0].op, 'unchanged');
});

test('mas4: upstream adding frontmatter with a name of its own wins for everything but the name, which stays the item name (its install folder)', async () => {
  const guide = '# Stax agent guide\n\nUse `st`.\n';
  const ownFm = (n: string) => `---\nname: stax-guide\ndescription: Upstream describes stax.\n---\n# Stax agent guide (rev ${n})\n`;
  gh.repos['acme/stax'] = {
    default_branch: 'main',
    refs: { main: sha2('c1') },
    trees: { [sha2('c1')]: { 'skills.md': guide }, [sha2('c2')]: { 'skills.md': ownFm('2') }, [sha2('c3')]: { 'skills.md': ownFm('3') } },
  };
  const { t, h } = setup();
  const body = { repo: 'acme/stax', path: 'skills.md', kind: 'skill' };
  const r = await github(t, h, { ...body, description: 'Stacked branches.' });
  assert.equal(r.status, 201, r.text);
  const it = r.json.items[0] as Supplied;
  assert.equal(it.name, 'stax');
  gh.repos['acme/stax'].refs.main = sha2('c2');
  const up = await t.req('POST', `${API}/items/${it.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  const item = up.json.item as Supplied;
  assert.deepEqual([item.latestSeq, item.upstreamFrontmatter, up.json.item.description], [2, true, 'Upstream describes stax.']);
  assert.equal(await fileText(t, h, it.id, 'SKILL.md'), ownFm('2').replace('name: stax-guide', 'name: stax'));
  // A re-import at the next upstream change does the same.
  gh.repos['acme/stax'].refs.main = sha2('c3');
  const again = await github(t, h, body);
  assert.equal(again.status, 201, again.text);
  assert.deepEqual([again.json.items[0].id, again.json.items[0].op, again.json.items[0].name], [it.id, 'version', 'stax']);
  assert.equal(await fileText(t, h, it.id, 'SKILL.md'), ownFm('3').replace('name: stax-guide', 'name: stax'));

  // An agent the same way: its supplied name is its item name.
  gh.repos['acme/agentfm'] = { default_branch: 'main', refs: { main: sha2('c4') }, trees: { [sha2('c4')]: { 'helper.md': 'You help.\n' }, [sha2('c5')]: { 'helper.md': '---\nname: upstream-helper\ndescription: Upstream.\n---\nYou help.\n' } } };
  const a = await github(t, h, { repo: 'acme/agentfm', path: 'helper.md', kind: 'agent', name: 'helper', description: 'Helps.' });
  assert.equal(a.status, 201, a.text);
  gh.repos['acme/agentfm'].refs.main = sha2('c5');
  const aUp = await github(t, h, { repo: 'acme/agentfm', path: 'helper.md', kind: 'agent', name: 'helper' });
  assert.equal(aUp.status, 201, aUp.text);
  assert.deepEqual([aUp.json.items[0].op, (aUp.json.items[0] as Supplied).upstreamFrontmatter], ['version', true]);
  assert.equal(await fileText(t, h, a.json.items[0].id, 'helper.md'), '---\nname: helper\ndescription: Upstream.\n---\nYou help.\n');
});

test('jcfm: a description on a package import is a 400 before anything is written (a package has no one entry file)', async () => {
  const { t, h } = setup();
  const before = count(t, 'SELECT COUNT(*) AS n FROM items');
  const p = await pack(t, h, 'manual.zip', { 'manual/a.md': 'a', 'manual/b.md': 'b' }, { kind: 'package', description: 'A manual.' });
  assert.equal(p.status, 400, p.text);
  assert.match(p.json.error.message, /skill, agent, command, prompt, instructions or design/);
  const kit = { 'README.md': '# Kit\n', 'docs/a.md': '# A\n' };
  const folder = await pack(t, h, 'kit.zip', kit, { folderKinds: JSON.stringify({ docs: 'package' }), description: 'Docs.' });
  assert.equal(folder.status, 400, folder.text);
  assert.match(folder.json.error.message, /a package has none/);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items'), before, 'nothing written');
  // Without the description both import.
  assert.equal((await pack(t, h, 'kit.zip', kit, { folderKinds: JSON.stringify({ docs: 'package' }) })).status, 201);
});

test('mas4: one GitHub .md file as a skill: named for the repository when the file name is generic, SCP supplies the frontmatter, source/update re-applies it, upstream frontmatter wins', async () => {
  const guide = (n: string) => `# Stax agent guide\n\nUse \`st\` to stack branches (rev ${n}).\n`;
  const ownFm = '---\nname: stax\ndescription: Upstream describes stax itself.\n---\n# Stax agent guide\n';
  gh.repos['cesarferreira/stax'] = {
    default_branch: 'main',
    refs: { main: sha2('da') },
    trees: { [sha2('da')]: { 'skills.md': guide('1'), 'docs/git-flow.md': '# Flow\n', 'src/main.rs': 'fn main() {}' }, [sha2('db')]: { 'skills.md': guide('2') }, [sha2('dc')]: { 'skills.md': ownFm } },
  };
  const { t, h } = setup();
  const desc = 'Stacked branches with stax: create, submit, restack.';
  // Without kind skill the file imports as today: a prompt, named by its heading.
  const asPrompt = await github(t, h, { repo: 'cesarferreira/stax', path: 'skills.md' });
  assert.equal(asPrompt.status, 201, asPrompt.text);
  assert.deepEqual(names(asPrompt.json.items), ['prompt:stax-agent-guide']);
  // Without a description the missing frontmatter is asked about (0rdh), nothing written.
  const ask = await github(t, h, { repo: 'cesarferreira/stax', path: 'skills.md', kind: 'skill' });
  assert.equal(ask.status, 409, ask.text);

  const r = await github(t, h, { repo: 'cesarferreira/stax', path: 'skills.md', kind: 'skill', description: desc });
  assert.equal(r.status, 201, r.text);
  const it = r.json.items[0] as Supplied;
  assert.deepEqual([it.kind, it.name, it.source.path], ['skill', 'stax', 'skills.md']);
  assert.deepEqual(filePaths(r.json.items[0]), ['SKILL.md']);
  assert.deepEqual(it.version.lint.filter((l) => l.level === 'error'), [], 'passes lint');
  const first = await fileText(t, h, it.id, 'SKILL.md');
  assert.equal(first, `---\nname: stax\ndescription: "${desc}"\n---\n${guide('1')}`);
  // A file name that is not generic names the skill.
  const flow = await github(t, h, { repo: 'cesarferreira/stax', path: 'docs/git-flow.md', kind: 'skill', description: 'Flow.' });
  assert.equal(flow.status, 201, flow.text);
  assert.deepEqual(names(flow.json.items), ['skill:git-flow']);

  gh.repos['cesarferreira/stax'].refs.main = sha2('db');
  const up = await t.req('POST', `${API}/items/${it.id}/source/update`, { headers: h });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.item.latestSeq, 2);
  assert.equal(await fileText(t, h, it.id, 'SKILL.md'), blockOf(first) + guide('2'), 'new body, the same supplied frontmatter');

  gh.repos['cesarferreira/stax'].refs.main = sha2('dc');
  const own = await t.req('POST', `${API}/items/${it.id}/source/update`, { headers: h });
  assert.equal(own.status, 200, own.text);
  assert.equal(await fileText(t, h, it.id, 'SKILL.md'), ownFm);
  assert.equal((own.json.item as Supplied).upstreamFrontmatter, true, 'the item shows the notice');
  assert.equal(own.json.item.description, 'Upstream describes stax itself.');
});

test("y15q: a one-file import's name of last resort is the file stem, a SKILL.md's its folder; a /blob/ URL with kind skill imports that file", async () => {
  const FOO = '---\ndescription: Foo things.\n---\nBody.\n';
  gh.repos['acme/y15q'] = {
    default_branch: 'main',
    refs: { main: sha2('f1') },
    trees: { [sha2('f1')]: { 'agents/helper.md': 'You help.\n', 'commands/go.md': 'Go.\n', 'skills/foo/SKILL.md': FOO, 'skills/foo/ref.md': 'Ref.\n', 'skills/foo/run.py': 'print(1)\n', 'docs/guide.md': '# Guide\n\nUse it.\n', 'docs/other.md': 'Other.\n' } },
  };
  // A kind override with no frontmatter name and no heading: the stem, not 'helper-md' / 'go-md'.
  const one = async (json: object) => {
    const { t, h } = setup();
    const r = await github(t, h, { repo: 'acme/y15q', ...json });
    assert.equal(r.status, 201, r.text);
    return r.json.items;
  };
  assert.deepEqual(names(await one({ path: 'agents/helper.md', kind: 'agent', frontmatterErrors: 'import' })), ['agent:helper']);
  assert.deepEqual(names(await one({ path: 'commands/go.md', kind: 'command' })), ['command:go']);
  // A SKILL.md lacking a name takes its folder's, with kind skill (not the repository's) or without (not 'skill-md').
  for (const kind of ['skill', undefined]) assert.deepEqual(names(await one({ path: 'skills/foo/SKILL.md', kind })), ['skill:foo'], String(kind));

  // mas4 through a /blob/ URL: the file is the skill's SKILL.md, not its folder (docs/, two files) as one skill.
  const [guide] = await one({ url: 'https://github.com/acme/y15q/blob/main/docs/guide.md', kind: 'skill', description: 'Guides.' });
  assert.deepEqual([guide.kind, guide.name, guide.source.path], ['skill', 'guide', 'docs/guide.md']);
  assert.deepEqual(filePaths(guide), ['SKILL.md']);
  // A SKILL.md /blob/ URL is still its folder's skill, as is any other file's that is not .md, and other kinds still read the file's folder.
  const blob = (file: string, kind?: string) => parseGithubSource({ url: `https://github.com/o/r/blob/main/${file}`, kind }).path;
  assert.deepEqual(
    [blob('skills/pdf/SKILL.md', 'skill'), blob('skills/pdf/skill.md', 'skill'), blob('docs/guide.md', 'skill'), blob('skills/pdf/scripts/run.py', 'skill'), blob('agents/a.md', 'agent'), blob('docs/guide.md')],
    ['skills/pdf', 'skills/pdf', 'docs/guide.md', 'skills/pdf/scripts', 'agents', 'docs'],
  );
  for (const file of ['SKILL.md', 'run.py']) {
    const [foo] = await one({ url: `https://github.com/acme/y15q/blob/main/skills/foo/${file}`, kind: 'skill' });
    assert.deepEqual([foo.name, foo.source.path, filePaths(foo).sort()], ['foo', 'skills/foo', ['SKILL.md', 'ref.md', 'run.py']], file);
  }
});

test('y15q: an item a one-file import named before v4 (go-md, skill-md, the repository) is that unit on re-import and keeps its name', async () => {
  const at = (body: string) => ({ 'commands/go.md': body, 'skills/foo/SKILL.md': `---\ndescription: Foo things.\n---\n${body}`, 'CLAUDE.md': body });
  const named = { 'skills/foo/SKILL.md': '---\nname: foo\ndescription: Foo things.\n---\nGo.\n' };
  gh.repos['acme/y15q-old'] = {
    default_branch: 'main',
    refs: { main: sha2('a1'), next: sha2('a2'), named: sha2('a3') },
    trees: { [sha2('a1')]: at('Go.\n'), [sha2('a2')]: at('Go now.\n'), [sha2('a3')]: named },
  };
  const cases = [
    ['commands/go.md', 'command', 'command:go', 'go-md'],
    ['skills/foo/SKILL.md', 'skill', 'skill:foo', 'y15q-old'],
    ['skills/foo/SKILL.md', undefined, 'skill:foo', 'skill-md'],
    ['CLAUDE.md', undefined, 'instructions:claude', 'claude-md'],
  ] as const;
  for (const [path, kind, now, old] of cases) {
    const { t, h } = setup();
    const first = await github(t, h, { repo: 'acme/y15q-old', path, kind });
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(names(first.json.items), [now], path);
    const [item] = first.json.items;
    // The row as a pre-v4 import named it.
    t.db.prepare('UPDATE items SET name = ? WHERE id = ?').run(old, item.id);
    const again = await github(t, h, { repo: 'acme/y15q-old', ref: 'next', path, kind });
    assert.equal(again.status, 201, again.text);
    assert.deepEqual(again.json.items.map((i: Out) => [i.id, i.name, i.op]), [[item.id, old, 'version']], `${path} ${kind}`);
  }
  // A unit upstream has named since is renamed, so a new unit as before v4: never written into the old item.
  const { t, h } = setup();
  const first = await github(t, h, { repo: 'acme/y15q-old', path: 'skills/foo/SKILL.md', kind: 'skill' });
  t.db.prepare('UPDATE items SET name = ? WHERE id = ?').run('y15q-old', first.json.items[0].id);
  const again = await github(t, h, { repo: 'acme/y15q-old', ref: 'named', path: 'skills/foo/SKILL.md', kind: 'skill' });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]), [['foo', 'create']]);
});

test('t1ge: an unclosed fence an import named before v4 from its heading is that unit on re-import and keeps its name', async () => {
  // A lone '---' opener, and a closing fence with a trailing space: both unclosed, both named from the heading before v4.
  const at = (more: string) => ({ 'CLAUDE.md': `---\n# Project Guide\nUse pnpm.\n\n${more}`, 'DESIGN.md': `---\ndescription: d\n--- \n# Acme Look\n\n${more}` });
  gh.repos['acme/t1ge-old'] = { default_branch: 'main', refs: { main: sha2('b1'), next: sha2('b2') }, trees: { [sha2('b1')]: at('More.\n'), [sha2('b2')]: at('More now.\n') } };
  // After a near closer the body starts, so DESIGN.md's heading names it as before v4: no alias needed.
  {
    const { t, h } = setup();
    const first = await github(t, h, { repo: 'acme/t1ge-old' });
    assert.equal(first.status, 201, first.text);
    assert.equal(first.json.items.find((i: Out) => i.source.path === 'DESIGN.md')?.name, 'acme-look');
  }
  for (const [path, old] of [['CLAUDE.md', 'project-guide']]) {
    const { t, h } = setup();
    const first = await github(t, h, { repo: 'acme/t1ge-old' });
    assert.equal(first.status, 201, first.text);
    const item = first.json.items.find((i: Out) => i.source.path === path);
    assert.ok(item && item.name !== old, path);
    // The row as a pre-v4 import named it.
    t.db.prepare('UPDATE items SET name = ? WHERE id = ?').run(old, item.id);
    const again = await github(t, h, { repo: 'acme/t1ge-old', ref: 'next' });
    assert.equal(again.status, 201, again.text);
    assert.deepEqual(again.json.items.filter((i: Out) => i.source.path === path).map((i: Out) => [i.id, i.name, i.op]), [[item.id, old, 'version']], path);
  }
});

test("t1ge: an unclosed fence imported with 'import' takes its description from the body after the YAML; the stored bytes stay upstream's", async () => {
  // The YAML comment would leave a blank line once headings are stripped, splitting the YAML in two.
  const OPEN = '---\nname: open\n# a YAML comment\ndescription: never closed\n\n# Open\n\nFirst real paragraph\nof the body.\n\nSecond.\n';
  const files: Files = { 'skills/open/SKILL.md': OPEN, 'skills/yaml-only/SKILL.md': '---\nname: yaml-only\ndescription: d\n' };
  const { t, h } = setup();
  const ask = await pack(t, h, 'open.zip', files);
  assert.equal(ask.status, 409, ask.text);
  assert.deepEqual(ask.json.error.details.map((d: { path: string; errors: string[] }) => [d.path, d.errors]), [
    ['skills/open', ['frontmatter: frontmatter is not closed', 'frontmatter description is required']],
    ['skills/yaml-only', ['frontmatter: frontmatter is not closed', 'frontmatter description is required']],
  ]);
  const r = await pack(t, h, 'open.zip', files, { frontmatterErrors: 'import' });
  assert.equal(r.status, 201, r.text);
  const open = byName(r.json.items, 'open') as Out & { description: string };
  assert.equal(open.description, 'First real paragraph of the body.');
  // The title too: the '# a YAML comment' line is YAML, not the body's heading.
  assert.equal((await t.req('GET', `${API}/items/${open.id}`, { headers: h })).json.item.title, 'Open');
  assert.equal((byName(r.json.items, 'yaml-only') as Out & { description: string }).description, '', 'no body: no description, never the YAML');
  assert.equal(await fileText(t, h, open.id, 'SKILL.md'), OPEN, 'the upstream bytes, untouched');

  // The YAML may hold blank lines: between keys, inside a folded scalar. A '--- ' (trailing space) does not
  // close the fence for lib/frontmatter.ts, so its 'd' is no description; it is one more YAML line.
  const gaps: Files = {
    'skills/a/SKILL.md': '---\nname: a\n\ndescription: never closed\n\nReal body paragraph.\n',
    'skills/b/SKILL.md': '---\nname: b\ndescription: >\n  Folded line one\n\n  folded line two\n\nReal body paragraph.\n',
    'skills/c/SKILL.md': '---\nname: c\ndescription: d\n--- \nOnly real paragraph.\n',
  };
  // After a near closer the body starts at once: its list is the first paragraph, its heading the title.
  const near: Files = {
    'skills/l1/SKILL.md': '---\nname: l1\ndescription: d\n--- \n- First step.\n- Second step.\n\nAfter.\n',
    'skills/l2/SKILL.md': '---\nname: l2\ndescription: d\n--- \n# Real Title\n\nBody para.\n',
  };
  // Every documented key resumes the YAML past a blank line, not only the common ones.
  near['agents/r1.md'] = '---\nname: r1\ndescription: Reviews.\n\ndisallowedTools: Bash\n\nYou review code.\n';
  near['skills/s1/SKILL.md'] = '---\nname: s1\n\npaths: src/**\n\nReal body.\n';
  // A list may hold blank lines too, under its key or between items: whatever parses as the YAML is the YAML.
  near['skills/lst/SKILL.md'] = '---\nname: lst\nallowed-tools:\n\n- Bash\n- Read\n\nReal body.\n';
  near['skills/trg/SKILL.md'] = '---\nname: trg\ntriggers:\n- one\n\n- two\n\nReal body.\n';
  const nr = await pack(t, h, 'near.zip', near, { frontmatterErrors: 'import' });
  for (const n of ['s1', 'lst', 'trg']) assert.equal((byName(nr.json.items, n) as Out & { description: string }).description, 'Real body.', n);
  assert.equal((byName(nr.json.items, 'r1') as Out & { description: string }).description, 'You review code.');
  assert.equal(nr.status, 201, nr.text);
  assert.equal((byName(nr.json.items, 'l1') as Out & { description: string }).description, '- First step. - Second step.');
  const l2 = byName(nr.json.items, 'l2') as Out & { description: string };
  assert.equal(l2.description, 'Body para.');
  assert.equal((await t.req('GET', `${API}/items/${l2.id}`, { headers: h })).json.item.title, 'Real Title');
  const g = await pack(t, h, 'gaps.zip', gaps, { frontmatterErrors: 'import' });
  assert.equal(g.status, 201, g.text);
  assert.deepEqual(['a', 'b', 'c'].map((n) => (byName(g.json.items, n) as Out & { description: string }).description), ['Real body paragraph.', 'Real body paragraph.', 'Only real paragraph.']);
  for (const n of ['a', 'b', 'c']) assert.equal(await fileText(t, h, byName(g.json.items, n).id, 'SKILL.md'), gaps[`skills/${n}/SKILL.md`], n);

  // The first run of lines is YAML whatever it holds (quoted keys); past a blank line, a known key (after a
  // comment run, too) resumes it, and any other line, key-shaped or not, is the body.
  const keys: Files = {
    'skills/p1/SKILL.md': '---\nname: p1\n\n# tools\ndescription: never closed\n\nFirst real paragraph.\n',
    'skills/p2/SKILL.md': '---\n"name": p2\n"description": never closed\n\nFirst real paragraph.\n',
    'skills/p3/SKILL.md': '---\nname: p3\n\nNote: this is the body.\n\nSecond.\n',
  };
  const k = await pack(t, h, 'keys.zip', keys, { frontmatterErrors: 'import' });
  assert.equal(k.status, 201, k.text);
  assert.deepEqual(['p1', 'p2', 'p3'].map((n) => (byName(k.json.items, n) as Out & { description: string }).description), ['First real paragraph.', 'First real paragraph.', 'Note: this is the body.']);
  for (const n of ['p1', 'p2', 'p3']) assert.equal(await fileText(t, h, byName(k.json.items, n).id, 'SKILL.md'), keys[`skills/${n}/SKILL.md`], n);
});

test("rv5z: name: \"\" is a frontmatter error: asked about, imported with 'import' under its folder's name; a malformed name is skipped in every mode", async () => {
  const EMPTY = '---\nname: ""\ndescription: Its name is empty.\n---\nBody.\n';
  const files: Files = { 'skills/good/SKILL.md': skill('good'), 'skills/empty/SKILL.md': EMPTY };
  const { t, h } = setup();
  const ask = await pack(t, h, 'empty.zip', files);
  assert.equal(ask.status, 409, ask.text);
  assert.deepEqual(ask.json.error.details, [{ path: 'skills/empty', kind: 'skill', errors: ['frontmatter name is empty'] }]);
  const r = await pack(t, h, 'empty.zip', files, { frontmatterErrors: 'import' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(names(r.json.items), ['skill:empty', 'skill:good']);
  const empty = byName(r.json.items, 'empty');
  assert.deepEqual((empty.version.lint as { code: string; waived?: boolean }[]).filter((l) => l.waived).map((l) => l.code), ['skill.name.empty']);
  assert.equal(await fileText(t, h, empty.id, 'SKILL.md'), EMPTY, 'the upstream bytes, untouched');

  const BAD = '---\nname: "Bad Name!"\ndescription: d\n---\n';
  for (const mode of [undefined, 'ask', 'import', 'skip']) {
    const s = setup();
    const b = await pack(s.t, s.h, 'bad.zip', { 'skills/good/SKILL.md': skill('good'), 'skills/bad/SKILL.md': BAD }, mode ? { frontmatterErrors: mode } : {});
    assert.equal(b.status, 201, `${mode}: ${b.text}`);
    assert.deepEqual(names(b.json.items), ['skill:good']);
    assert.deepEqual(b.json.skipped.map((x: { path: string }) => x.path), ['skills/bad']);
    assert.match(b.json.skipped[0].reason, /must match/);
  }
});

const REV_NO_NAME = (who: string) => `---\ndescription: ${who} reviews code.\n---\n# Code Reviewer\nYou review.\n`;

test("0rdh, 5ef6: an ask-mode re-import names a unit an earlier import took with its frontmatter errors as that import did, so a new twin is prefixed, not dropped", async () => {
  const { t, h } = setup();
  const a: Files = { LICENSE: 'MIT', 'plugins/a/.claude-plugin/plugin.json': '{}', 'plugins/a/agents/rev.md': REV_NO_NAME('A') };
  const first = await pack(t, h, 'k.zip', a, { frontmatterErrors: 'import' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(names(first.json.items), ['agent:rev'], 'named by its file, not its heading (code-reviewer)');
  const grown = await pack(t, h, 'k.zip', { ...a, 'plugins/b/.claude-plugin/plugin.json': '{}', 'plugins/b/agents/rev.md': agentMd('rev') });
  assert.equal(grown.status, 201, grown.text);
  assert.deepEqual(grown.json.skipped, []);
  assert.deepEqual(grown.json.items.map((i: Out) => [i.name, i.op, i.source.path]).sort(), [['b-rev', 'create', 'plugins/b/agents/rev.md'], ['rev', 'unchanged', 'plugins/a/agents/rev.md']]);
});

test('0rdh, 5ef6: units whose missing name an in-import prefix wrote keep their accepted frontmatter errors: an ask-mode re-import does not ask again', async () => {
  const { t, h } = setup();
  const two: Files = { LICENSE: 'MIT', 'plugins/a/.claude-plugin/plugin.json': '{}', 'plugins/a/agents/rev.md': REV_NO_NAME('A'), 'plugins/b/.claude-plugin/plugin.json': '{}', 'plugins/b/agents/rev.md': REV_NO_NAME('B') };
  const first = await pack(t, h, 'two.zip', two, { frontmatterErrors: 'import' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(names(first.json.items), ['agent:a-rev', 'agent:b-rev']);
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM items WHERE lint_waived = 1'), 2);
  const again = await pack(t, h, 'two.zip', two);
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]).sort(), [['a-rev', 'unchanged'], ['b-rev', 'unchanged']]);
});

test("5ef6, naming-1: a copy with no prefix keeps the bare name on re-import too; the held prefixed copy's item takes its prefixed name, as a fresh import names them", async () => {
  const files = (rootAgent: string): Files => ({
    '.claude-plugin/plugin.json': '{"name":"k"}',
    'agents/rev.md': rootAgent,
    'plugins/a/.claude-plugin/plugin.json': '{}',
    'plugins/a/agents/rev.md': agentMd('rev'),
  });
  const { t, h } = setup();
  const first = await pack(t, h, 'k.zip', files('---\nname: rev\n---\nNo description.\n'), { frontmatterErrors: 'skip', group: 'kit' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(first.json.items.map((i: Out) => [i.name, i.source.path]), [['rev', 'plugins/a/agents/rev.md']]);
  const fixed = await pack(t, h, 'k.zip', files(agentMd('rev')), { intoGroup: 'kit' });
  assert.equal(fixed.status, 201, fixed.text);
  assert.deepEqual(fixed.json.skipped.filter((s: { path: string }) => s.path.includes('rev')), []);
  assert.deepEqual(fixed.json.items.map((i: Out) => [i.name, i.op, i.source.path]).sort(), [
    ['a-rev', 'version', 'plugins/a/agents/rev.md'],
    ['rev', 'create', 'agents/rev.md'],
  ]);
  const moved = byName(fixed.json.items, 'a-rev');
  assert.equal(moved.id, byName(first.json.items, 'rev').id, 'the same item, renamed');
  assert.match(await fileText(t, h, moved.id, filePaths(moved as Out & { version: { files: { path: string }[] } })[0]), /^---\nname: a-rev\n/);
  // A fresh import of the same tree names them the same way.
  const s = setup();
  assert.deepEqual(names((await pack(s.t, s.h, 'k.zip', files(agentMd('rev')))).json.items), ['agent:a-rev', 'agent:rev']);
  // Once more: nothing left to write.
  const again = await pack(t, h, 'k.zip', files(agentMd('rev')), { intoGroup: 'kit' });
  assert.deepEqual(again.json.items.map((i: Out) => [i.name, i.op]).sort(), [['a-rev', 'unchanged'], ['rev', 'unchanged']]);
});

test("5ef6: a held copy with no free prefixed name keeps the bare name on re-import; the repository's own skill added upstream gives way", async () => {
  const long = 'x'.repeat(60);
  // b-access is another skill's name, and the long folder's prefixed name is over the name cap.
  for (const [copy, other] of [['b/skills/access', { 'skills/b-access/SKILL.md': skill('b-access') }], [`${long}/skills/access`, {}]] as const) {
    const { t, h } = setup();
    const v1: Files = { LICENSE: 'MIT', [`${copy}/SKILL.md`]: skill('access'), ...other };
    const first = await pack(t, h, 'held.zip', v1, { group: 'held' });
    assert.equal(first.status, 201, first.text);
    const item = byName(first.json.items, 'access');
    assert.equal(item.source.path, copy);
    const grown = await pack(t, h, 'held.zip', { ...v1, 'skills/access/SKILL.md': skill('access', "The repository's own.") }, { intoGroup: 'held' });
    assert.equal(grown.status, 201, grown.text);
    assert.deepEqual(grown.json.items.filter((i: Out) => i.name === 'access').map((i: Out) => [i.id, i.op, i.source.path]), [[item.id, 'unchanged', copy]], copy);
    assert.deepEqual(grown.json.skipped.map((s: { path: string }) => s.path), ['skills/access'], grown.text);
    assert.match(grown.json.skipped[0].reason, new RegExp(`another skill of this import \\(${copy}\\) is named 'access'`));
  }
});

test('eg9k: an agent of a port plugin root that loses its name is reported as the port, like a skill', async () => {
  const { t, h } = setup();
  const r = await pack(t, h, 'multi.zip', {
    'antigravity/x/.claude-plugin/plugin.json': '{}',
    'antigravity/x/agents/r.md': agentMd('r'),
    'plugins/x/.claude-plugin/plugin.json': '{}',
    'plugins/x/agents/r.md': agentMd('r'),
  });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.skipped, [{ path: 'antigravity/x/agents/r.md', reason: 'another copy of this agent (plugins/x/agents/r.md) was imported; this one is the antigravity port' }]);
});
