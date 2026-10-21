import type { SQLInputValue } from 'node:sqlite';
import { canEditGroup, canReadItem, groupReadSql, itemReadSql, publishedSql } from '../access.ts';
import { requireScope } from '../auth/middleware.ts';
import { isUniqueViolation, newId, now, tx, type Db } from '../db.ts';
import { HttpError, badRequest, forbidden, notFound } from '../lib/http.ts';
import { normalizePath, segmentProblem } from '../lib/paths.ts';
import { ftsQuery, getItemRow, itemSummary, listFiles, resolveVersion, type ItemSummary } from '../items/service.ts';
import { INSTALL_AS_KINDS, INSTALL_SCOPES, TARGETS, findConflicts, footprint, installPath, pathConflict } from './bundle.ts';
import { MD_KINDS, planeOf, type Ctx, type GroupRow, type ItemRow, type Kind, type Principal, type VersionRow } from '../types.ts';

export { buildBundle, buildManifest, catalogMarkdown, installPath } from './bundle.ts';

export type GroupVisibility = GroupRow['visibility'];

export interface GroupSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  visibility: GroupVisibility;
  owner: { id: string; username: string };
  counts: { skill: number; md: number; artifact: number };
  updatedAt: string;
}

export interface GroupMember {
  item: ItemSummary;
  pinnedSeq: number | null;
  installAs: string | null;
  resolvedSeq: number;
  /** claude-code, project scope. */
  installPath: string;
}

export interface GroupDetail extends GroupSummary {
  instructions: string;
  sharedWith: string[];
  members: GroupMember[];
  endpoints: { mcp: string; manifest: string; bundle: string };
  canEdit: boolean;
}

export interface GroupInput {
  slug: string;
  name: string;
  description?: string;
  instructions?: string;
  tags?: string[];
  visibility?: GroupVisibility;
  sharedWith?: string[];
}

export type GroupPatch = Partial<Omit<GroupInput, 'slug'>>;

export interface MemberInput {
  itemId: string;
  pinnedSeq?: number | null;
  installAs?: string | null;
}

export interface ResolvedMember {
  item: ItemRow;
  version: VersionRow;
  pinnedSeq: number | null;
  installAs: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** Members per group, and files across their versions: every manifest, bundle and add walks them all. */
export const MAX_MEMBERS = 500;
export const MAX_GROUP_FILES = 20_000;
const VISIBILITIES = ['private', 'shared', 'public'];
// A group republishes only what its owner may publish: their own items or public ones (access.ts).
const PUBLISHED = publishedSql();

// ---------- reads ----------

export function loadReadableGroup(db: Db, p: Principal, slug: string): GroupRow {
  const f = groupReadSql(p);
  const row = db.prepare(`SELECT g.* FROM scp_groups g WHERE g.slug = ? AND ${f.sql}`).get(slug, ...f.params) as GroupRow | undefined;
  if (!row) throw notFound('group');
  return row;
}

export function loadEditableGroup(db: Db, p: Principal, slug: string): GroupRow {
  const row = loadReadableGroup(db, p, slug);
  if (!canEditGroup(p, row)) throw forbidden('you cannot edit this group');
  return row;
}

/**
 * One page of the groups p can read, the caller's own first. Paged in SQL and summarized per page:
 * any account can create public groups, so "every readable group" is attacker-sized.
 */
export function listReadableGroups(
  db: Db,
  p: Principal,
  opts: { q?: string; ownerId?: string; limit?: number; offset?: number } = {},
): { groups: GroupSummary[]; total: number } {
  const read = groupReadSql(p);
  const match = ftsQuery(opts.q);
  const where = [read.sql];
  const params: SQLInputValue[] = [...read.params];
  if (match) {
    where.unshift('groups_fts MATCH ?');
    params.unshift(match);
  }
  if (opts.ownerId) {
    where.push('g.owner_id = ?');
    params.push(opts.ownerId);
  }
  const from = match ? 'groups_fts JOIN scp_groups g ON g.id = groups_fts.group_id' : 'scp_groups g';
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${w}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT g.* FROM ${from} WHERE ${w} ORDER BY ${match ? 'bm25(groups_fts),' : ''} (g.owner_id = ?) DESC, g.updated_at DESC, g.id DESC LIMIT ? OFFSET ?`)
    .all(...params, p.userId, opts.limit ?? 50, opts.offset ?? 0) as unknown as GroupRow[];
  return { groups: rows.map((r) => groupSummary(db, r)), total };
}

const usernameOf = (db: Db, id: string) =>
  (db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined)?.username ?? '';

/** Counts only members the group actually publishes, so they match what its audience sees. */
export function groupSummary(db: Db, row: GroupRow): GroupSummary {
  const counts = { skill: 0, md: 0, artifact: 0 };
  const kinds = db
    .prepare(
      `SELECT i.kind FROM group_members gm JOIN items i ON i.id = gm.item_id JOIN scp_groups g ON g.id = gm.group_id
       WHERE gm.group_id = ? AND ${PUBLISHED}`,
    )
    .all(row.id) as { kind: Kind }[];
  for (const k of kinds) counts[planeOf(k.kind)]++;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    visibility: row.visibility,
    owner: { id: row.owner_id, username: usernameOf(db, row.owner_id) },
    counts,
    updatedAt: row.updated_at,
  };
}

/** Members p can read and the group publishes, in position order, at their pinned or latest version. */
export function resolvedMembers(db: Db, p: Principal, group: GroupRow): ResolvedMember[] {
  const read = itemReadSql(p);
  const rows = db
    .prepare(
      `SELECT i.*, gm.pinned_seq AS gm_pinned_seq, gm.install_as AS gm_install_as
       FROM group_members gm JOIN items i ON i.id = gm.item_id JOIN scp_groups g ON g.id = gm.group_id
       WHERE gm.group_id = ? AND ${PUBLISHED} AND ${read.sql} ORDER BY gm.position, gm.added_at`,
    )
    .all(group.id, ...read.params) as unknown as (ItemRow & { gm_pinned_seq: number | null; gm_install_as: string | null })[];
  return rows.map(({ gm_pinned_seq, gm_install_as, ...item }) => ({
    item,
    version: resolveVersion(db, item, gm_pinned_seq ?? undefined),
    pinnedSeq: gm_pinned_seq,
    installAs: gm_install_as,
  }));
}

export function groupDetail(db: Db, p: Principal, row: GroupRow, publicUrl: string): GroupDetail {
  const canEdit = canEditGroup(p, row);
  const shared = canEdit
    ? (db
        .prepare('SELECT u.username FROM group_shares s JOIN users u ON u.id = s.user_id WHERE s.group_id = ? ORDER BY u.username')
        .all(row.id) as { username: string }[])
    : [];
  const api = `${publicUrl}/api/v1/groups/${row.slug}`;
  return {
    ...groupSummary(db, row),
    instructions: row.instructions,
    sharedWith: shared.map((s) => s.username),
    members: resolvedMembers(db, p, row).map((m) => ({
      item: itemSummary(db, m.item),
      pinnedSeq: m.pinnedSeq,
      installAs: m.installAs,
      resolvedSeq: m.version.seq,
      installPath: installPath(m.item.kind, m.item.name, m.version.entry_path, { target: 'claude-code', scope: 'project', installAs: m.installAs }),
    })),
    endpoints: { mcp: `${publicUrl}/mcp/${row.slug}`, manifest: `${api}/manifest`, bundle: `${api}/bundle.zip` },
    canEdit,
  };
}

/** Dashboard counts of p's own things. */
export function ownStats(db: Db, p: Principal): { skills: number; mds: number; artifacts: number; groups: number; keys: number } {
  const n = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  const mdIn = MD_KINDS.map(() => '?').join(', ');
  return {
    skills: n("SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND kind = 'skill'", p.userId),
    mds: n(`SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND kind IN (${mdIn})`, p.userId, ...MD_KINDS),
    artifacts: n("SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND kind = 'artifact'", p.userId),
    groups: n('SELECT COUNT(*) AS n FROM scp_groups WHERE owner_id = ?', p.userId),
    // Live keys only: principalFromKey rejects expired ones.
    keys: n('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', p.userId, now()),
  };
}

// ---------- writes ----------

function normalizeTags(tags: string[] = []): string[] {
  const out = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  if (out.length > 20) throw badRequest('at most 20 tags');
  if (out.some((t) => t.length > 40)) throw badRequest('tags are at most 40 chars');
  return out;
}

function checkVisibility(v: unknown): void {
  if (v !== undefined && !VISIBILITIES.includes(v as string)) throw badRequest(`visibility must be one of ${VISIBILITIES.join(', ')}`);
}

/** Usernames -> user ids, the owner dropped. Unknown names are a 400, not silently skipped. */
function resolveUsers(db: Db, names: string[], ownerId: string): string[] {
  const ids = new Set<string>();
  for (const name of new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))) {
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: string } | undefined;
    if (!u) throw new HttpError(400, 'unknown_user', `unknown user '${name}'`);
    if (u.id !== ownerId) ids.add(u.id);
  }
  return [...ids];
}

function setShares(db: Db, groupId: string, userIds: string[]): void {
  db.prepare('DELETE FROM group_shares WHERE group_id = ?').run(groupId);
  const ins = db.prepare('INSERT INTO group_shares (group_id, user_id) VALUES (?, ?)');
  for (const id of userIds) ins.run(groupId, id);
}

// ponytail: FTS rows are found by an UNINDEXED column (full scan per write), same as items_fts.
function refreshFts(db: Db, groupId: string): void {
  db.prepare('DELETE FROM groups_fts WHERE group_id = ?').run(groupId);
  const g = db.prepare('SELECT * FROM scp_groups WHERE id = ?').get(groupId) as GroupRow | undefined;
  if (!g) return;
  db.prepare('INSERT INTO groups_fts (group_id, slug, name, description, tags, instructions) VALUES (?, ?, ?, ?, ?, ?)').run(
    g.id,
    g.slug,
    g.name,
    g.description,
    (JSON.parse(g.tags) as string[]).join(' '),
    g.instructions,
  );
}

const getGroupRow = (db: Db, id: string) => db.prepare('SELECT * FROM scp_groups WHERE id = ?').get(id) as unknown as GroupRow;
const touch = (db: Db, groupId: string) => db.prepare('UPDATE scp_groups SET updated_at = ? WHERE id = ?').run(now(), groupId);

function assertEditable(p: Principal, group: GroupRow): void {
  if (!canEditGroup(p, group)) throw forbidden('you cannot edit this group');
}

export function createGroup(ctx: Ctx, p: Principal, input: GroupInput): GroupRow {
  const { db } = ctx;
  requireScope(p, 'write');
  // The new group's id could never be in the key's list, so it would vanish from the key on creation.
  if (p.groupIds) throw new HttpError(403, 'restricted_key', 'a group-restricted API key cannot create groups');
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG.test(slug)) throw new HttpError(400, 'invalid_slug', `slug '${slug.slice(0, 80)}' must match ^[a-z0-9][a-z0-9-]{1,63}$`);
  // The slug is a bundle path segment (.scp/groups/<slug>/) and the zip's file name.
  const why = segmentProblem(slug);
  if (why) throw new HttpError(400, 'invalid_slug', `slug '${slug}' cannot be used as a file name: ${why}`);
  checkVisibility(input.visibility);
  const tags = JSON.stringify(normalizeTags(input.tags));
  const shares = resolveUsers(db, input.sharedWith ?? [], p.userId);
  const ts = now();
  const row: GroupRow = {
    id: newId(),
    owner_id: p.userId,
    slug,
    name: input.name,
    description: input.description ?? '',
    instructions: input.instructions ?? '',
    tags,
    visibility: input.visibility ?? 'private',
    created_at: ts,
    updated_at: ts,
  };
  const taken = () => new HttpError(409, 'slug_taken', `the group slug '${slug}' is taken`);
  return tx(db, () => {
    // A deleted group's slug answers the same 409 to everyone but its old owner and admins (db.ts).
    const tomb = db.prepare('SELECT owner_id FROM deleted_group_slugs WHERE slug = ?').get(slug) as { owner_id: string } | undefined;
    if (tomb && tomb.owner_id !== p.userId && !p.isAdmin) throw taken();
    try {
      db.prepare(
        'INSERT INTO scp_groups (id, owner_id, slug, name, description, instructions, tags, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.owner_id, row.slug, row.name, row.description, row.instructions, row.tags, row.visibility, ts, ts);
    } catch (e) {
      if (isUniqueViolation(e)) throw taken();
      throw e;
    }
    db.prepare('DELETE FROM deleted_group_slugs WHERE slug = ?').run(slug);
    setShares(db, row.id, shares);
    refreshFts(db, row.id);
    return getGroupRow(db, row.id);
  });
}

/** Slug is not patchable: it is in every endpoint URL agents have saved. */
export function updateGroup(ctx: Ctx, p: Principal, group: GroupRow, patch: GroupPatch): GroupRow {
  const { db } = ctx;
  assertEditable(p, group);
  // Choosing an audience is an account-level act, and resolveUsers answers unknown_user for a missing
  // name: a key contained to its groups must not probe the account list (it gets 403 on /users/search too).
  if (p.groupIds && patch.sharedWith !== undefined) {
    throw new HttpError(403, 'restricted_key', 'a group-restricted API key cannot change who a group is shared with');
  }
  // Visibility picks the audience too: 'public' would publish the owner's private members to everyone.
  if (p.groupIds && patch.visibility !== undefined && patch.visibility !== group.visibility) {
    throw new HttpError(403, 'restricted_key', "a group-restricted API key cannot change a group's visibility");
  }
  checkVisibility(patch.visibility);
  const tags = patch.tags ? JSON.stringify(normalizeTags(patch.tags)) : group.tags;
  const shares = patch.sharedWith ? resolveUsers(db, patch.sharedWith, group.owner_id) : null;
  return tx(db, () => {
    db.prepare('UPDATE scp_groups SET name = ?, description = ?, instructions = ?, tags = ?, visibility = ?, updated_at = ? WHERE id = ?').run(
      patch.name ?? group.name,
      patch.description ?? group.description,
      patch.instructions ?? group.instructions,
      tags,
      patch.visibility ?? group.visibility,
      now(),
      group.id,
    );
    if (shares) setShares(db, group.id, shares);
    refreshFts(db, group.id);
    return getGroupRow(db, group.id);
  });
}

export function deleteGroup(ctx: Ctx, p: Principal, group: GroupRow): void {
  const { db } = ctx;
  assertEditable(p, group);
  tx(db, () => {
    db.prepare('DELETE FROM groups_fts WHERE group_id = ?').run(group.id);
    db.prepare('DELETE FROM scp_groups WHERE id = ?').run(group.id); // members and shares cascade
  });
}

/**
 * installAs is a project-relative .md path. It may not reach into .git (core.fsmonitor in .git/config
 * runs commands) or SCP's own bundle files.
 */
function checkInstallAs(kind: Kind, v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (!INSTALL_AS_KINDS.has(kind)) throw badRequest(`installAs is only for ${[...INSTALL_AS_KINDS].join(', ')} items`);
  normalizePath(v);
  const lower = v.toLowerCase();
  if (!lower.endsWith('.md')) throw badRequest(`installAs '${v}' must be a .md file path`);
  if (lower.split('/').includes('.git')) throw badRequest(`installAs '${v}' may not write into .git`);
  if (lower.startsWith('.scp/groups/') || lower === 'scp.lock.json' || lower.startsWith('scp.lock.json/')) {
    throw badRequest(`installAs '${v}' is reserved for SCP bundle files`);
  }
  return v;
}

interface PlacedRow {
  id: string;
  kind: Kind;
  name: string;
  entry_path: string;
  version_id: string;
  install_as: string | null;
}

/** The members the group publishes, with what decides their install paths. */
function memberRows(db: Db, groupId: string): PlacedRow[] {
  return db
    .prepare(
      `SELECT i.id, i.kind, i.name, v.entry_path, v.id AS version_id, gm.install_as FROM group_members gm
       JOIN items i ON i.id = gm.item_id JOIN scp_groups g ON g.id = gm.group_id
       JOIN item_versions v ON v.item_id = i.id AND v.seq = COALESCE(gm.pinned_seq, i.latest_seq)
       WHERE gm.group_id = ? AND ${PUBLISHED}`,
    )
    .all(groupId) as unknown as PlacedRow[];
}

/**
 * Checked in every bundle the group can be downloaded as (codex maps both commands and prompts to
 * .codex/prompts/, so claude-code alone misses clashes). Built per call: bundle.ts imports this
 * module, so its consts are not initialized yet when this one loads.
 */
function assertGroupFits(db: Db, group: GroupRow, focus: ReadonlySet<string>): void {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(group.id) as { n: number };
  if (n > MAX_MEMBERS) throw new HttpError(400, 'group_full', `a group holds at most ${MAX_MEMBERS} members`);
  const rows = memberRows(db, group.id);
  // One listFiles per version and one findConflicts pass per layout, however many members changed:
  // per-member passes made a 500-member PUT cost members x files (seconds of blocked event loop).
  const files = new Map(rows.map((r) => [r.version_id, listFiles(db, r.version_id).map((f) => f.path)]));
  if ([...files.values()].reduce((n, f) => n + f.length, 0) > MAX_GROUP_FILES) {
    throw new HttpError(400, 'group_full', `a group's members may hold at most ${MAX_GROUP_FILES} files in all`);
  }
  for (const layout of TARGETS.flatMap((target) => INSTALL_SCOPES.map((scope) => ({ target, scope })))) {
    const at = (r: PlacedRow) =>
      footprint(r.kind, r.name, r.entry_path, files.get(r.version_id)!, { ...layout, installAs: r.install_as }).map((path) => ({
        path,
        name: r.name,
        id: r.id,
      }));
    // Clashes that involve a member just written, with itself or with any other; ones already between
    // other members are the manifest's to report, not a reason to refuse an unrelated add.
    const [c] = findConflicts(rows.flatMap(at), focus);
    if (c) throw pathConflict(c);
  }
}

interface CheckedMember {
  item: ItemRow;
  pinned: number | null;
  installAs: string | null;
}

/** Everything about one new member that does not depend on the rest of the group. */
function checkMember(db: Db, p: Principal, group: GroupRow, input: MemberInput, opts: { skipReadCheck?: boolean; readChecked?: boolean }): CheckedMember {
  const item = getItemRow(db, input.itemId);
  const readable = item && (opts.readChecked || (opts.skipReadCheck ? item.owner_id === p.userId : canReadItem(db, p, item.id)));
  if (!item || !readable) throw notFound('item');
  if (item.owner_id !== group.owner_id && item.visibility !== 'public') {
    throw new HttpError(
      400,
      'item_not_shareable',
      `'${item.name}' is another user's private item; a group can only publish its owner's items or public ones`,
    );
  }
  const pinned = input.pinnedSeq ?? null;
  if (pinned !== null && (!Number.isInteger(pinned) || pinned < 1 || pinned > item.latest_seq)) {
    throw badRequest(`pinnedSeq must be between 1 and ${item.latest_seq}`);
  }
  return { item, pinned, installAs: checkInstallAs(item.kind, input.installAs) };
}

/** Append rows after the current last position, in order. Inside a transaction; group checks follow. */
function insertMembers(db: Db, group: GroupRow, members: CheckedMember[]): void {
  let { pos } = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS pos FROM group_members WHERE group_id = ?').get(group.id) as { pos: number };
  const exists = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND item_id = ?');
  const ins = db.prepare('INSERT INTO group_members (group_id, item_id, pinned_seq, install_as, position, added_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const { item, pinned, installAs } of members) {
    if (exists.get(group.id, item.id)) throw new HttpError(409, 'member_exists', `'${item.name}' is already in this group`);
    ins.run(group.id, item.id, pinned, installAs, pos++, now());
  }
}

/**
 * Append one member. Joins an outer transaction. skipReadCheck is the MCP create_artifact escape
 * hatch: a restricted key cannot read an item it just created until that item is in its group, so
 * the check is replaced by "p owns it". Never pass it for an item the caller did not just create.
 */
export function addMemberTx(ctx: Ctx, p: Principal, group: GroupRow, input: MemberInput, opts: { skipReadCheck?: boolean; readChecked?: boolean } = {}): void {
  const { db } = ctx;
  assertEditable(p, group);
  const m = checkMember(db, p, group, input, opts);
  tx(db, () => {
    insertMembers(db, group, [m]);
    assertGroupFits(db, group, new Set([m.item.id]));
    touch(db, group.id);
  });
}

/**
 * Replace the visible member list in the given order; all-or-nothing. Only members the caller can
 * see are replaced: one the group stopped publishing (its owner made it private) keeps its row, so
 * it flows again if made public. Remove it explicitly with removeMember.
 */
export function replaceMembers(ctx: Ctx, p: Principal, group: GroupRow, members: MemberInput[]): void {
  const { db } = ctx;
  assertEditable(p, group);
  tx(db, () => {
    // Check read access before deleting: a restricted key reads members only through this very
    // group, so once their rows are gone they would 404 and a plain reorder would fail.
    for (const m of members) if (!canReadItem(db, p, m.itemId)) throw notFound('item');
    const checked = members.map((m) => checkMember(db, p, group, m, { readChecked: true }));
    const visible = resolvedMembers(db, p, group).map((m) => m.item.id);
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND item_id IN (SELECT value FROM json_each(?))').run(group.id, JSON.stringify(visible));
    insertMembers(db, group, checked);
    assertGroupFits(db, group, new Set(checked.map((m) => m.item.id)));
    touch(db, group.id);
  });
}

export function removeMember(ctx: Ctx, p: Principal, group: GroupRow, itemId: string): void {
  const { db } = ctx;
  assertEditable(p, group);
  tx(db, () => {
    const r = db.prepare('DELETE FROM group_members WHERE group_id = ? AND item_id = ?').run(group.id, itemId);
    if (!r.changes) throw notFound('member');
    touch(db, group.id);
  });
}
