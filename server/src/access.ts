import type { SQLInputValue } from 'node:sqlite';
import type { Db } from './db.ts';
import { EXECUTABLE_KINDS, type GroupRow, type ItemRow, type Principal } from './types.ts';

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

/**
 * WHERE fragment: group alias `g` is readable by the plain (non-admin) user whose id is the SQL
 * expression `user` (a column, or `?` bound twice): their own, public, or shared with them, and the
 * group's owner enabled.
 */
export const groupReadableByUserSql = (user: string, g = 'g') =>
  `(${g}.owner_id = ${user} OR ${g}.visibility = 'public' OR (${g}.visibility = 'shared' AND EXISTS (SELECT 1 FROM group_shares gs WHERE gs.group_id = ${g}.id AND gs.user_id = ${user}))) AND ${ownerEnabled(`${g}.owner_id`)}`;

/** WHERE fragment: group alias `g` is readable by p. */
export function groupReadSql(p: Principal, g = 'g'): SqlFrag {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  if (!p.isAdmin) {
    parts.push(groupReadableByUserSql('?', g));
    params.push(p.userId, p.userId);
  }
  if (p.groupIds) {
    parts.push(`${g}.id IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(p.groupIds));
  }
  return { sql: parts.length ? parts.join(' AND ') : '1', params };
}

/** Nested groups (docs/PLAN-v2.md D5): the longest include chain, root at depth 0. */
export const MAX_INCLUDE_DEPTH = 4;

/**
 * Include edge `parent` -> `child` flows while the child is something the parent's owner could
 * publish themselves: their own group, or a public one (its owner enabled). The same rule as
 * item_not_shareable (publishedSql): a group shared with the parent's owner by name is not theirs
 * to republish, or a share recipient could make a public group out of another user's private items.
 * No admin override either.
 */
export const includeVouchSql = (parent: string, child: string) =>
  `(${child}.owner_id = ${parent}.owner_id OR ${child}.visibility = 'public') AND ${ownerEnabled(`${child}.owner_id`)}`;

/**
 * Rows one upward walk may dequeue and expand (SQLite's LIMIT on the recursive select stops the
 * recursion at that many rows). Each expansion joins the row's parents, and fan-in is capped at
 * MAX_INCLUDED_BY (groups/service.ts insertInclude), so one item row costs at most MAX_UP_ROWS x
 * MAX_INCLUDED_BY edge visits on every other user's listing, however large the DAG above it. The
 * cap is the bound; this is the backstop for a DAG grown past it (an older build). ponytail: a group
 * reachable only past MAX_UP_ROWS serves nothing through SQL; its owner trims an include.
 */
export const MAX_UP_ROWS = 1000;

const EXEC_KINDS_SQL = EXECUTABLE_KINDS.map((k) => `'${k}'`).join(', ');

/**
 * Recursive CTE up_r(group_id, depth, exec_r): the groups serving one item. Anchored on the item's own
 * group_members rows (gm_r, with the group as g_c; `anchor` picks the rows, `join` may bring the
 * item row in as `i`), each anchor group publishing the item (publishedSql), then walked upward
 * through group_includes while each parent's owner vouches for the child (includeVouchSql), at most
 * MAX_INCLUDE_DEPTH hops and MAX_UP_ROWS rows: the same walk as groups/service.ts effectiveGroups,
 * upward. A hook or MCP server (exec_r, by kind: groups/service.ts withheldExec) climbs only to a
 * parent of the child's owner: another owner's include withholds it, so an include never serves it
 * here either. Never anchored on "every readable group": public groups are attacker-sized.
 */
const upCte = (i: string, anchor: string, join = '') =>
  `WITH RECURSIVE up_r(group_id, depth, exec_r) AS (` +
  `SELECT gm_r.group_id, 0, ${i}.kind IN (${EXEC_KINDS_SQL}) FROM group_members gm_r JOIN scp_groups g_c ON g_c.id = gm_r.group_id${join} WHERE ${anchor} AND ${publishedSql(i, 'g_c')}` +
  ` UNION SELECT gi_r.group_id, up_r.depth + 1, up_r.exec_r FROM up_r JOIN group_includes gi_r ON gi_r.included_id = up_r.group_id` +
  ` JOIN scp_groups par_r ON par_r.id = gi_r.group_id JOIN scp_groups chi_r ON chi_r.id = up_r.group_id` +
  ` WHERE up_r.depth < ${MAX_INCLUDE_DEPTH} AND ${includeVouchSql('par_r', 'chi_r')} AND (up_r.exec_r = 0 OR par_r.owner_id = chi_r.owner_id) LIMIT ${MAX_UP_ROWS})`;

/** WHERE fragment: item alias `i` is served by a group p can read, as a direct member or through includes. */
export function servedBySql(p: Principal, i = 'i'): SqlFrag {
  const g = groupReadSql(p, 'g_r');
  return { sql: `EXISTS (${upCte(i, `gm_r.item_id = ${i}.id`)} SELECT 1 FROM up_r JOIN scp_groups g_r ON g_r.id = up_r.group_id WHERE ${g.sql})`, params: g.params };
}

/** WHERE fragment: item alias `i` is served by the one group `groupId`, directly or through its includes (group-scoped search). */
export function servedByGroupSql(groupId: string, i = 'i'): SqlFrag {
  return { sql: `EXISTS (${upCte(i, `gm_r.item_id = ${i}.id`)} SELECT 1 FROM up_r WHERE up_r.group_id = ?)`, params: [groupId] };
}

/** Query: slug and name of every group p can read that serves the item whose id is bound first (item detail). */
export function servingGroupsSql(p: Principal): SqlFrag {
  const g = groupReadSql(p, 'g_r');
  return {
    sql: `${upCte('i', 'gm_r.item_id = ?', ' JOIN items i ON i.id = gm_r.item_id')} SELECT DISTINCT g_r.slug, g_r.name FROM up_r JOIN scp_groups g_r ON g_r.id = up_r.group_id WHERE ${g.sql} ORDER BY g_r.name`,
    params: g.params,
  };
}

/**
 * Query: rows of the groups p can read, by name, that some member row requiring the CLI bound first
 * reaches at that row's version (its pin, else latest) (fx78 usedBy). The same upward walk as
 * servingGroupsSql, anchored on version_requires by name. Candidates only: when one item reaches a
 * group twice the group serves the first occurrence (resolvedMembers), which this walk cannot tell,
 * so usedBy confirms each with groups/service.ts servesRequiringCheck (5x0a).
 * ponytail: MAX_UP_ROWS caps the walk, so a CLI required across more than that many member rows
 * lists only the groups the first rows reach.
 */
export function requiringGroupsSql(p: Principal): SqlFrag {
  const g = groupReadSql(p, 'g_r');
  const join =
    ' JOIN items i ON i.id = gm_r.item_id JOIN item_versions v_r ON v_r.item_id = i.id AND v_r.seq = COALESCE(gm_r.pinned_seq, i.latest_seq)' +
    ' JOIN version_requires vr_r ON vr_r.version_id = v_r.id';
  // A disabled owner's item is not served to non-admins (itemReadSql), so it requires nothing for them.
  const anchor = `vr_r.name = ?${p.isAdmin ? '' : ` AND ${ownerEnabled('i.owner_id')}`}`;
  return {
    sql: `${upCte('i', anchor, join)} SELECT DISTINCT g_r.* FROM up_r JOIN scp_groups g_r ON g_r.id = up_r.group_id WHERE ${g.sql} ORDER BY g_r.name, g_r.slug`,
    params: g.params,
  };
}

/**
 * WHERE fragment: item alias `i` is readable by p. A restricted key (groupIds set) sees only what
 * its groups serve, even items the user owns: full containment. Reading a group grants read of
 * everything it serves, included groups too (servedBySql).
 */
export function itemReadSql(p: Principal, i = 'i'): SqlFrag {
  const viaGroup = servedBySql(p, i);
  if (p.isAdmin) return p.groupIds ? viaGroup : { sql: '1', params: [] };
  const read = p.groupIds ? viaGroup.sql : `(${i}.owner_id = ? OR ${i}.visibility = 'public' OR ${viaGroup.sql})`;
  return { sql: `(${read} AND ${ownerEnabled(`${i}.owner_id`)})`, params: p.groupIds ? viaGroup.params : [p.userId, ...viaGroup.params] };
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
