import { tx, type Db } from '../db.ts';

export interface SweepResult {
  deletedBlobs: number;
  freedBytes: number;
}

/**
 * Delete blobs no version_files row references (index version_files_sha, migration 5). With hashes,
 * only those candidates are examined: deleteItem passes the hashes of the versions it just removed,
 * so a delete never scans the whole blob table. Runs in a transaction (joins the caller's when nested)
 * so the counted rows are the deleted rows.
 */
export function sweepBlobs(db: Db, hashes?: string[]): SweepResult {
  if (hashes && hashes.length === 0) return { deletedBlobs: 0, freedBytes: 0 };
  const orphan = 'NOT EXISTS (SELECT 1 FROM version_files f WHERE f.sha256 = blobs.sha256)';
  const scope = hashes ? ' AND sha256 IN (SELECT value FROM json_each(?))' : '';
  const params = hashes ? [JSON.stringify(hashes)] : [];
  return tx(db, () => {
    const stat = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE ${orphan}${scope}`).get(...params) as {
      n: number;
      bytes: number;
    };
    if (stat.n) db.prepare(`DELETE FROM blobs WHERE ${orphan}${scope}`).run(...params);
    return { deletedBlobs: stat.n, freedBytes: stat.bytes };
  });
}
