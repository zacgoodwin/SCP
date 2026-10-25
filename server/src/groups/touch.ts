import type { SQLInputValue } from 'node:sqlite';
import { now, type Db } from '../db.ts';

/**
 * Rows one touch walk may visit: a DAG forced past the include caps (raw SQL) costs a constant per
 * write. ponytail: the groups past the cap keep a stale updated_at; their owner trims an include.
 */
const MAX_TOUCH_ROWS = 1000;

/**
 * Bump updated_at on the anchored groups and every group that includes them (structural walk, stale
 * edges too): what those groups serve changed, so their updated_at, and with it the marketplace plugin
 * version (bundle.ts pluginVersion) and the plugin.zip cache key, must move. `anchorSql` selects the
 * starting ids as a column named id. Its own module: items/service.ts calls it too and cannot import
 * groups/service.ts (cycle).
 */
function touchFrom(db: Db, anchorSql: string, params: SQLInputValue[]): void {
  db.prepare(
    `WITH RECURSIVE up(id, depth) AS (SELECT id, 0 FROM (${anchorSql}) UNION SELECT gi.group_id, up.depth + 1 FROM up JOIN group_includes gi ON gi.included_id = up.id WHERE up.depth < 64 LIMIT ${MAX_TOUCH_ROWS})
     UPDATE scp_groups SET updated_at = ? WHERE id IN (SELECT id FROM up)`,
  ).run(...params, now());
}

/** A membership, pin or include change inside `groupId`. */
export const touchGroup = (db: Db, groupId: string) => touchFrom(db, 'SELECT ? AS id', [groupId]);

/** The groups that include `groupId`: it is being deleted, or its visibility changed what they serve. */
export const touchIncluders = (db: Db, groupId: string) => touchFrom(db, 'SELECT group_id AS id FROM group_includes WHERE included_id = ?', [groupId]);

/** The groups holding `itemId` as a member: it is being deleted, or its visibility changed what they publish. */
export const touchGroupsOfItem = (db: Db, itemId: string) => touchFrom(db, 'SELECT group_id AS id FROM group_members WHERE item_id = ?', [itemId]);

/**
 * Every group holding one of `userId`'s items or including one of their groups: the account is being
 * disabled, enabled or deleted, which takes their content out of (or back into) what those serve
 * (access.ts ownerEnabled) without touching a single member or include row.
 */
export const touchGroupsOfUser = (db: Db, userId: string) =>
  touchFrom(
    db,
    `SELECT gm.group_id AS id FROM group_members gm JOIN items i ON i.id = gm.item_id WHERE i.owner_id = ?
     UNION SELECT gi.group_id FROM group_includes gi JOIN scp_groups c ON c.id = gi.included_id WHERE c.owner_id = ?`,
    [userId, userId],
  );
