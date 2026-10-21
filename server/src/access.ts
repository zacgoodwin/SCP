import type { SQLInputValue } from 'node:sqlite';
import type { Db } from './db.ts';
import type { GroupRow, ItemRow, Principal } from './types.ts';

export interface SqlFrag {
  sql: string;
  params: SQLInputValue[];
}

/**
 * Group `g` publishes item `i`: a group only republishes what its owner could publish, their own
 * items or public ones, so an item made private stops flowing through other people's groups.
 * Every query that lists a group's members must apply it.
 */
export const publishedSql = (i = 'i', g = 'g') => `(${i}.owner_id = ${g}.owner_id OR ${i}.visibility = 'public')`;

/**
 * Disabling an account takes down everything it owns, reversibly: its groups and items stop flowing
 * to other users and agents (admins still see them), like its share links and previews (shares.ts).
 */
const ownerEnabled = (ownerCol: string) => `NOT EXISTS (SELECT 1 FROM users du WHERE du.id = ${ownerCol} AND du.disabled = 1)`;

/** WHERE fragment: group alias `g` is readable by p. */
export function groupReadSql(p: Principal, g = 'g'): SqlFrag {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  if (!p.isAdmin) {
    parts.push(
      `(${g}.owner_id = ? OR ${g}.visibility = 'public' OR (${g}.visibility = 'shared' AND EXISTS (SELECT 1 FROM group_shares gs WHERE gs.group_id = ${g}.id AND gs.user_id = ?)))`,
      ownerEnabled(`${g}.owner_id`),
    );
    params.push(p.userId, p.userId);
  }
  if (p.groupIds) {
    parts.push(`${g}.id IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(p.groupIds));
  }
  return { sql: parts.length ? parts.join(' AND ') : '1', params };
}

/**
 * WHERE fragment: item alias `i` is readable by p. A restricted key (groupIds set) sees only
 * members of its groups, even items the user owns: full containment.
 */
export function itemReadSql(p: Principal, i = 'i'): SqlFrag {
  const g = groupReadSql(p, 'g_r');
  const viaGroup = `EXISTS (SELECT 1 FROM group_members gm_r JOIN scp_groups g_r ON g_r.id = gm_r.group_id WHERE gm_r.item_id = ${i}.id AND ${publishedSql(i, 'g_r')} AND ${g.sql})`;
  if (p.isAdmin) return p.groupIds ? { sql: viaGroup, params: g.params } : { sql: '1', params: [] };
  const read = p.groupIds ? viaGroup : `(${i}.owner_id = ? OR ${i}.visibility = 'public' OR ${viaGroup})`;
  return { sql: `(${read} AND ${ownerEnabled(`${i}.owner_id`)})`, params: p.groupIds ? g.params : [p.userId, ...g.params] };
}

export function canReadGroup(db: Db, p: Principal, groupId: string): boolean {
  const f = groupReadSql(p);
  return !!db.prepare(`SELECT 1 FROM scp_groups g WHERE g.id = ? AND ${f.sql}`).get(groupId, ...f.params);
}

export function canEditGroup(p: Principal, group: Pick<GroupRow, 'id' | 'owner_id'>): boolean {
  return (
    (p.isAdmin || group.owner_id === p.userId) &&
    p.scopes.includes('write') &&
    (!p.groupIds || p.groupIds.includes(group.id))
  );
}

export function canReadItem(db: Db, p: Principal, itemId: string): boolean {
  const f = itemReadSql(p);
  return !!db.prepare(`SELECT 1 FROM items i WHERE i.id = ? AND ${f.sql}`).get(itemId, ...f.params);
}

export function canEditItem(db: Db, p: Principal, item: Pick<ItemRow, 'id' | 'owner_id'>): boolean {
  if (!(p.isAdmin || item.owner_id === p.userId) || !p.scopes.includes('write')) return false;
  // A restricted key may edit only what it can read: the same containment and republication rule
  // as itemReadSql, so it cannot act on an item that 404s for it (e.g. made private since).
  return !p.groupIds || canReadItem(db, p, item.id);
}

/** Can p create new items at all? Restricted keys may only create into a group they can edit. */
export const canCreate = (p: Principal) => p.scopes.includes('write');
