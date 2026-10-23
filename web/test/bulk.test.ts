import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bulkSummary, deletePrompt, idRange, keepLoaded, runBulk } from '../src/bulk.ts';

test('runBulk caps concurrency at 4 and finishes every item', async () => {
  let running = 0;
  let peak = 0;
  const done: number[] = [];
  const failed = await runBulk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    done.push(n);
  });
  assert.deepEqual(failed, []);
  assert.equal(peak, 4);
  assert.deepEqual(done.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('runBulk reports a refused item by reason while the others still land', async () => {
  const landed: string[] = [];
  const failed = await runBulk(['a', 'b', 'c'], async (name) => {
    if (name === 'b') throw new Error("'b' is another user's private item");
    landed.push(name);
  });
  assert.deepEqual(landed.sort(), ['a', 'c']);
  assert.deepEqual(failed, [{ item: 'b', reason: "'b' is another user's private item" }]);
});

test('runBulk keeps failures in input order and handles an empty selection', async () => {
  const failed = await runBulk([30, 1, 20], async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    throw new Error(`x${ms}`);
  });
  assert.deepEqual(failed.map((f) => f.item), [30, 1, 20]);
  assert.deepEqual(await runBulk([], async () => {}), []);
});

test('bulkSummary names each failure', () => {
  assert.equal(bulkSummary(3, 'updated', []), '3 updated');
  assert.equal(bulkSummary(14, 'updated', [{ name: 'x', reason: 'r1' }, { name: 'y', reason: 'r2' }]), '12 updated, 2 failed: x: r1; y: r2');
});

test('deletePrompt is singular for one item', () => {
  assert.equal(deletePrompt(1), 'Delete 1 item and all of its versions?');
  assert.equal(deletePrompt(3), 'Delete 3 items and all of their versions?');
});

test('idRange selects inclusive ranges either direction', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(idRange(ids, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(idRange(ids, 'd', 'a'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(idRange(ids, null, 'c'), ['c']);
  assert.deepEqual(idRange(ids, 'gone', 'c'), ['c']);
});

test('keepLoaded drops selected ids the reloaded list no longer shows', () => {
  // 'p2' failed on a Load-more page; the reload brings back page 1 only, so it cannot stay selected unseen.
  assert.deepEqual([...keepLoaded(new Set(['a', 'p2']), ['a', 'b'])], ['a']);
  assert.deepEqual([...keepLoaded(new Set(['a']), [])], []);
});
