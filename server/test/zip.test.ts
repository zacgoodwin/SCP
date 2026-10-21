import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { buildZip, safeUnzip } from '../src/lib/zip.ts';
import { assertNoCollisions, isJunkPath, isTextPath, normalizePath } from '../src/lib/paths.ts';
import { stripTopFolder, treeSha256 } from '../src/lib/tree.ts';
import { HttpError } from '../src/lib/http.ts';

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, `expected HttpError, got ${e}`);
    return e.status;
  }
  assert.fail('expected a throw');
};

test('buildZip -> safeUnzip round-trips bytes and exec bits', () => {
  const files = [
    { path: 'pdf/SKILL.md', bytes: strToU8('---\r\nname: pdf\r\n---\r\n'), mode: 420 },
    { path: 'pdf/scripts/run.sh', bytes: strToU8('#!/bin/sh\necho hi\n'), mode: 493 },
  ];
  const out = safeUnzip(buildZip(files));
  assert.deepEqual(
    out.map((f) => [f.path, f.mode, Buffer.from(f.bytes).toString()]).sort(),
    files.map((f) => [f.path, f.mode, Buffer.from(f.bytes).toString()]).sort(),
  );
});

test('safeUnzip skips directory entries and defaults non-unix modes to 420', () => {
  const zip = zipSync({ dir: { 'a.txt': strToU8('a') }, 'b.sh': strToU8('b') });
  const out = safeUnzip(zip);
  assert.deepEqual(out.map((f) => [f.path, f.mode]).sort(), [['b.sh', 420], ['dir/a.txt', 420]]);
});

test('zip-slip names are rejected with 400', () => {
  for (const name of ['../x', 'a/../../x', '/abs', 'C:/x', 'a\\b', 'a/./b', 'nul\u0000x']) {
    assert.equal(status(() => safeUnzip(zipSync({ [name]: strToU8('x') }))), 400, name);
  }
});

test('symlink entries are rejected', () => {
  const zip = zipSync({ link: [strToU8('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] });
  assert.equal(status(() => safeUnzip(zip)), 400);
});

test('zip bomb guard rejects a highly compressible >1 MB file before inflating', () => {
  const zip = zipSync({ 'bomb.txt': new Uint8Array(2 * 1024 * 1024) }, { level: 9 });
  assert.ok(zip.length < 20_000);
  assert.equal(status(() => safeUnzip(zip)), 413);
});

/** Overwrite one uint32 of the single entry in both its local header and its central directory record. */
function patchEntry(zip: Uint8Array, localOff: number, cdOff: number, value: number): Uint8Array {
  const z = zip.slice();
  const dv = new DataView(z.buffer);
  const cd = dv.getUint32(z.length - 22 + 16, true);
  dv.setUint32(localOff, value, true);
  dv.setUint32(cd + cdOff, value, true);
  return z;
}
const declareSize = (zip: Uint8Array, n: number) => patchEntry(zip, 22, 24, n);
const declareCrc = (zip: Uint8Array, n: number) => patchEntry(zip, 14, 16, n);

test('safeUnzip enforces the declared size and the CRC instead of truncating', () => {
  // Declared under the 1 MB ratio-check floor, actually 20 MB of zeros: rejected, not truncated.
  const lying = declareSize(zipSync({ 'SKILL.md': new Uint8Array(20 * 1024 * 1024) }, { level: 9 }), 1024 * 1024);
  assert.equal(status(() => safeUnzip(lying)), 400);
  const small = zipSync({ 'a.txt': new Uint8Array(100_000) }, { level: 9 });
  assert.equal(status(() => safeUnzip(declareSize(small, 1000))), 400);
  assert.equal(status(() => safeUnzip(declareCrc(small, 12345))), 400);
  const stored = zipSync({ 'b.txt': strToU8('hello') }, { level: 0 });
  assert.equal(status(() => safeUnzip(declareCrc(stored, 1))), 400);
  assert.equal(safeUnzip(stored)[0].bytes.length, 5);
});

test('more than 1000 files is rejected', () => {
  const tree: Record<string, Uint8Array> = {};
  for (let i = 0; i < 1001; i++) tree[`f${i}.txt`] = strToU8('x');
  assert.equal(status(() => safeUnzip(zipSync(tree, { level: 0 }))), 413);
});

test('garbage is not a zip', () => {
  assert.equal(status(() => safeUnzip(strToU8('definitely not a zip file at all'))), 400);
  assert.equal(status(() => safeUnzip(new Uint8Array(3))), 400);
});

test('normalizePath accepts POSIX relative paths and rejects the rest', () => {
  for (const ok of ['SKILL.md', 'scripts/run.sh', '.gitignore', 'a b/c.md', 'x'.repeat(255)]) assert.equal(normalizePath(ok), ok);
  for (const bad of ['', '/a', 'C:x', 'a\\b', 'a//b', 'a/', './a', 'a/..', 'a /b', 'a./b', 'a\tb', 'x'.repeat(256)]) {
    assert.equal(status(() => normalizePath(bad)), 400, JSON.stringify(bad));
  }
});

test('normalizePath rejects NTFS aliases, streams and device names', () => {
  const bad = ['GIT~1/hooks/post-checkout', 'x/.git::$INDEX_ALLOCATION/config', 'SKILL.md:x', 'CON', 'nul.md', 'a/aux.txt', 'COM1', 'PROGRA~1.TXT', 'a?b', 'a*b', 'a"b', 'a|b', 'a<b'];
  for (const p of bad) assert.equal(status(() => normalizePath(p)), 400, p);
  for (const ok of ['console.md', 'nullable.ts', 'a~b.md', 'v~1x.md', 'auxiliary/x', 'com.md']) assert.equal(normalizePath(ok), ok);
});

test('junk paths match case-insensitively', () => {
  for (const j of ['.GIT/config', '.Git/hooks/x', 'a/Node_Modules/b.js', '__macosx/._a', '.ds_store']) assert.ok(isJunkPath(j), j);
});

test('junk paths and collisions', () => {
  for (const j of ['__pycache__/x.pyc', 'a/node_modules/b.js', '.git/config', '.DS_Store', 'x/y.pyc', '__MACOSX/._a']) assert.ok(isJunkPath(j), j);
  for (const k of ['SKILL.md', 'gitignore', '.gitignore', 'nodes/x']) assert.ok(!isJunkPath(k), k);
  assert.equal(status(() => assertNoCollisions(['README.md', 'readme.md'])), 400);
  assert.equal(status(() => assertNoCollisions(['a', 'a/b'])), 400);
  assert.equal(status(() => assertNoCollisions(['A/b', 'a'])), 400);
  assertNoCollisions(['a/b', 'a/c', 'b']);
});

test('treeSha256 is order-independent and mode-sensitive', () => {
  const a = { path: 'a', mode: 420, sha256: '1'.repeat(64) };
  const b = { path: 'b/c', mode: 493, sha256: '2'.repeat(64) };
  assert.equal(treeSha256([a, b]), treeSha256([b, a]));
  assert.notEqual(treeSha256([a, b]), treeSha256([a, { ...b, mode: 420 }]));
  assert.match(treeSha256([a]), /^[0-9a-f]{64}$/);
});

test('treeSha256 fixed vectors: whole lines in UTF-8 byte order, as PLAN.md specifies', () => {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const h1 = '1'.repeat(64);
  const h2 = '2'.repeat(64);
  // Lines sort by mode first: "644 ... b.md" before "755 ... a.sh", although a.sh < b.md by path.
  assert.equal(treeSha256([{ path: 'a.sh', mode: 493, sha256: h1 }, { path: 'b.md', mode: 420, sha256: h2 }]), sha(`644 ${h2} b.md\n755 ${h1} a.sh\n`));
  // U+FFFD (EF BF BD) sorts before U+1F600 (F0 9F 98 80) in UTF-8, after it in UTF-16 code units.
  const x = { path: '\u{1F600}.md', mode: 420, sha256: h1 };
  const y = { path: '�.md', mode: 420, sha256: h1 };
  assert.equal(treeSha256([x, y]), sha(`644 ${h1} �.md\n644 ${h1} \u{1F600}.md\n`));
});

test('stripTopFolder strips only a folder shared by every path', () => {
  assert.deepEqual(stripTopFolder([{ path: 'pdf/SKILL.md' }, { path: 'pdf/x/y' }]), { files: [{ path: 'SKILL.md' }, { path: 'x/y' }], top: 'pdf' });
  assert.equal(stripTopFolder([{ path: 'pdf/SKILL.md' }, { path: 'other.md' }]).top, null);
  assert.equal(stripTopFolder([{ path: 'SKILL.md' }]).top, null);
  assert.ok(isTextPath('setup') && isTextPath('a.HTML') && !isTextPath('logo.png'));
});
