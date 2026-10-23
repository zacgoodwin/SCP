// Bulk actions on the item lists (y79w): the existing single-item endpoints, run per selected item.
// ponytail: client-side fan-out, no bulk endpoint. Add `POST /items/bulk` (one transaction) when a
// 200-item selection measurably drags or partial failure becomes a problem.

export interface BulkFailure<T> {
  item: T;
  reason: string;
}

/** Runs fn over items, at most `concurrency` at a time. Failures come back in input order; one never stops the rest. */
export async function runBulk<T>(items: readonly T[], fn: (item: T) => Promise<unknown>, concurrency = 4): Promise<BulkFailure<T>[]> {
  const failed: (BulkFailure<T> | undefined)[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        await fn(items[i]);
      } catch (e) {
        failed[i] = { item: items[i], reason: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return failed.filter((f) => f !== undefined);
}

/** "12 updated, 2 failed: a: reason; b: reason". */
export function bulkSummary(total: number, verb: string, failures: { name: string; reason: string }[]): string {
  const head = `${total - failures.length} ${verb}`;
  return failures.length ? `${head}, ${failures.length} failed: ${failures.map((f) => `${f.name}: ${f.reason}`).join('; ')}` : head;
}

export const deletePrompt = (n: number) => (n === 1 ? 'Delete 1 item and all of its versions?' : `Delete ${n} items and all of their versions?`);

/** The selected ids still among the loaded rows: a reload shows page 1 only, so a selection must not keep rows the bar cannot count. */
export const keepLoaded = (selected: ReadonlySet<string>, loaded: readonly string[]) => new Set(loaded.filter((id) => selected.has(id)));

/** Ids from `from` to `to` inclusive, in list order (shift-click range); just `to` when `from` is not in the list. */
export function idRange(ids: readonly string[], from: string | null, to: string): string[] {
  const a = from === null ? -1 : ids.indexOf(from);
  const b = ids.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}
