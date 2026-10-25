import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { MAX_INCLUDE_DEPTH, canEditGroup, canReadItem, groupReadSql, includeVouchSql, itemReadSql, publishedSql } from '../access.ts';
import { requireScope } from '../auth/middleware.ts';
import { isUniqueViolation, newId, now, tx, type Db } from '../db.ts';
import { HttpError, badRequest, forbidden, notFound } from '../lib/http.ts';
import { normalizePath, segmentProblem } from '../lib/paths.ts';
import { ftsQuery, getItemRow, itemSummary, listFiles, resolveVersion, type ItemSummary } from '../items/service.ts';
import { INSTALL_AS_KINDS, INSTALL_SCOPES, TARGETS, executableOf, fileCount, findConflicts, footprint, installPath, pathConflict, type ExecutableFlag, type PluginMember } from './bundle.ts';
import { touchGroup, touchIncluders } from './touch.ts';
import { requiresOf, type RequiredCli } from '../tools/service.ts';
import { EXECUTABLE_KINDS, MD_KINDS, isExecutable, planeOf, type Ctx, type GroupRow, type ItemRow, type Kind, type Principal, type VersionRow } from '../types.ts';

export { buildBundle, buildManifest, catalogMarkdown, installPath } from './bundle.ts';
// The effective-membership CTE lives in access.ts (this module evaluates publishedSql() at load, so
// access.ts cannot import from here); re-exported so callers find the nested-group rules in one place.
export { MAX_INCLUDE_DEPTH, servedBySql } from '../access.ts';

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
  /** mc52: the kinds of the members that run code as a plugin (bundle.ts executableOf; with `items` on GET /groups/:slug), null when none. */
  executable: ExecutableFlag | null;
  updatedAt: string;
}

export interface GroupMember {
  item: ItemSummary;
  pinnedSeq: number | null;
  installAs: string | null;
  resolvedSeq: number;
  /** mc52: the served version's (resolvedSeq: the pin, else latest) executable; item.executable is the latest's. */
  executable: boolean;
  /** claude-code, project scope. */
  installPath: string;
  /** Slug of the included group whose member row this is; null for the group's own members. */
  via: string | null;
}

export interface GroupInclude {
  slug: string;
  /** '' when the editor can no longer read the child (it went private): the row stays removable, its details do not leak. */
  name: string;
  owner: { username: string };
  /** Members the included group publishes itself (not its own includes); 0 when unreadable. */
  memberCount: number;
  /** Whether the include currently flows (includeVouchSql). Always true for readers, who see only those, whether or not they can read the child itself. */
  flowing: boolean;
}

export interface GroupDetail extends GroupSummary {
  instructions: string;
  sharedWith: string[];
  members: GroupMember[];
  includes: GroupInclude[];
  /** Groups that include this one, only those the reader can read. */
  includedBy: { slug: string; name: string }[];
  endpoints: { mcp: string; manifest: string; bundle: string };
  canEdit: boolean;
  /** CLIs the effective members require, with install commands from the registry only (tools/service.ts). */
  requires: RequiredCli[];
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
  /** Slug of the group whose member row (and pin / installAs) this is, when not the root's own. */
  via: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** Members per group, and files across their versions: every manifest, bundle and add walks them all. */
export const MAX_MEMBERS = 500;
export const MAX_GROUP_FILES = 20_000;
/** Display name and description lengths: the routes.ts body schema, and an import's plugin manifest (imports/manifest.ts). */
export const MAX_GROUP_NAME = 100;
export const MAX_GROUP_DESCRIPTION = 2000;
/**
 * Direct includes per group, and groups in one effective set: every listing walks each listed group's
 * whole include DAG (a member-count query per effective group), so a public hub over thousands of
 * leaves would turn one GET /groups page into millions of statements for every user.
 */
export const MAX_INCLUDES = 50;
export const MAX_EFFECTIVE_GROUPS = 100;
/**
 * Groups that may include one group (fan-in). itemReadSql walks upward from each item row on every
 * other user's listing (access.ts upCte), so without this one private group under thousands of
 * private hubs made every stranger's GET /items cost items x edges, with nothing readable to stop at.
 * Holds other users' includes of a public group; the owner's own includes are not refused by it
 * (strangers must not be able to lock an owner out of their own group), with MAX_UP_ROWS as the backstop.
 */
export const MAX_INCLUDED_BY = 50;
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

/** A group p can edit, else 404 whether or not p can read it: an import's target (p2wf) says nothing about groups p cannot use. */
export function loadEditableGroupOr404(db: Db, p: Principal, slug: string): GroupRow {
  const row = loadReadableGroup(db, p, slug);
  if (!canEditGroup(p, row)) throw notFound('group');
  return row;
}

export const isMember = (db: Db, groupId: string, itemId: string) => !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND item_id = ?').get(groupId, itemId);

/**
 * One page of the groups p can read, the caller's own first. Paged in SQL and summarized per page:
 * any account can create public groups, so "every readable group" is attacker-sized.
 */
export function listReadableGroups(
  db: Db,
  p: Principal,
  opts: { q?: string; ownerId?: string; notOwnerId?: string; limit?: number; offset?: number } = {},
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
  // Other users' readable groups: the own-first page would bury them under a user's own 200.
  if (opts.notOwnerId) {
    where.push('g.owner_id != ?');
    params.push(opts.notOwnerId);
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

/**
 * The groups that are p's own business, owned first: owned, shared with them by name, or picked for
 * a restricted key. Strangers' public groups stay reachable by slug (list_groups, /mcp/<slug>,
 * plugin.zip) but are never enumerated per request: any account can create them, so they are
 * attacker-sized, and their text would land in every reader's agent (mcp/server.ts instructions).
 */
export function listOwnGroups(db: Db, p: Principal, limit: number): (GroupRow & { owner_username: string })[] {
  const f = groupReadSql(p);
  // A share row counts only while the group is 'shared' (groupReadableByUserSql): the rows survive a
  // visibility change, so a group flipped to public is a stranger's public group for its old recipients.
  const chosen = p.groupIds ? '1' : "(g.owner_id = ? OR (g.visibility = 'shared' AND EXISTS (SELECT 1 FROM group_shares gs_o WHERE gs_o.group_id = g.id AND gs_o.user_id = ?)))";
  const params = p.groupIds ? [] : [p.userId, p.userId];
  return db
    .prepare(
      `SELECT g.*, u.username AS owner_username FROM scp_groups g JOIN users u ON u.id = g.owner_id
       WHERE ${f.sql} AND ${chosen} ORDER BY (g.owner_id = ?) DESC, g.updated_at DESC, g.id DESC LIMIT ?`,
    )
    .all(...f.params, ...params, p.userId, limit) as unknown as (GroupRow & { owner_username: string })[];
}

export interface EffectiveGroup {
  group: GroupRow;
  /** 0 for the root; the include it came through is at depth 1. */
  depth: number;
  /**
   * mc52 (review): reached from the root through groups its owner owns alone, the root included. Only these
   * serve hooks and MCP servers (withheldExec): an include of another owner's public group never consented to
   * code that owner adds to it later, which every installed plugin would otherwise run on its next update.
   */
  own: boolean;
}

/** mc52 (review): a hook or MCP server member another owner's included group brings, which `group` does not serve. */
export interface WithheldMember {
  id: string;
  kind: Kind;
  name: string;
  /** Slug of the group whose member it is. */
  via: string;
}

/**
 * mc52 (review): a hook or MCP server reached through another owner's include is withheld. By kind, not by
 * the version's `executable` (human, 2026-10-24): another owner's included skill, command or output style
 * that runs code or forces a style is served as before v4, and sets the group's flag and warnings since it
 * is served. Only the kinds whose whole purpose is to run code wait for the owner's consent (a member row).
 */
const withheldExec = (kind: Kind, own: boolean) => !own && isExecutable(kind);
/** The served version's `executable` of a member row `gm` of item `i`, for the flag the SQL walks feed. */
const SERVED_EXEC = '(SELECT v_e.executable FROM item_versions v_e WHERE v_e.item_id = i.id AND v_e.seq = COALESCE(gm.pinned_seq, i.latest_seq))';

// Prepared once per database (tests open many): the walk runs this per visited group on every listing.
const kidsStmts = new WeakMap<Db, StatementSync>();
const kidsStmt = (db: Db) => {
  let s = kidsStmts.get(db);
  if (!s) {
    s = db.prepare(
      `SELECT c.* FROM group_includes gi JOIN scp_groups c ON c.id = gi.included_id JOIN scp_groups par ON par.id = gi.group_id
       WHERE gi.group_id = ? AND ${includeVouchSql('par', 'c')} ORDER BY gi.position, gi.added_at`,
    );
    kidsStmts.set(db, s);
  }
  return s;
};

/**
 * The groups whose members `root` serves: root first, then each include's subtree in position order
 * (pre-order), at most MAX_INCLUDE_DEPTH deep. A child flows only while the including group's owner
 * vouches for it (includeVouchSql): the same walk as access.ts servedBySql, downward. A group reached
 * again at a shallower depth is re-walked (more of its subtree fits under the cap) but not re-listed.
 * The walk stops at `limit` groups (MAX_EFFECTIVE_GROUPS; include and member writes refuse to grow a
 * group, or any of its owner's groups that include it, past it: assertAncestorsFit).
 * ponytail: a set forced past the cap anyway (raw SQL, or another owner's public group that grew)
 * serves its first `limit` groups in walk order and silently drops the rest; the SQL side
 * (servedBySql) has no such cap and may still read them. Likewise another owner's hub that nests
 * this group beyond MAX_INCLUDE_DEPTH (assertIncludeDepth counts the owner's own chain only, so a
 * stranger cannot block a public group's owner) truncates at depth 4 on read, here and in SQL.
 */
export function effectiveGroups(db: Db, root: GroupRow, limit = MAX_EFFECTIVE_GROUPS): EffectiveGroup[] {
  const kids = kidsStmt(db);
  const out: EffectiveGroup[] = [{ group: root, depth: 0, own: true }];
  const best = new Map([[root.id, 0]]);
  const listed = new Map([[root.id, out[0]]]);
  const walk = (g: GroupRow, depth: number, own: boolean) => {
    if (depth >= MAX_INCLUDE_DEPTH) return;
    for (const c of kids.all(g.id) as unknown as GroupRow[]) {
      if (out.length >= limit) return;
      const mine = own && c.owner_id === root.owner_id;
      const seen = best.get(c.id);
      const e = listed.get(c.id);
      // Also re-walked when first reached through the owner's own groups alone, so its subtree is marked own too.
      if (seen !== undefined && seen <= depth + 1 && !(mine && !e!.own)) continue;
      if (seen === undefined || depth + 1 < seen) best.set(c.id, depth + 1);
      if (e) e.own ||= mine;
      else {
        const n = { group: c, depth: depth + 1, own: mine };
        out.push(n);
        listed.set(c.id, n);
      }
      walk(c, depth + 1, mine);
    }
  };
  walk(root, 0, true);
  return out;
}

/** Item ids the group serves (own and included, published; withheld ones not), for conflict focus sets. */
function servedItemIds(db: Db, group: GroupRow): Set<string> {
  const stmt = db.prepare(`SELECT i.id, i.kind FROM group_members gm JOIN items i ON i.id = gm.item_id JOIN scp_groups g ON g.id = gm.group_id WHERE gm.group_id = ? AND ${PUBLISHED}`);
  const ids = new Set<string>();
  for (const { group: g, own } of effectiveGroups(db, group)) for (const r of stmt.all(g.id) as { id: string; kind: Kind }[]) if (!withheldExec(r.kind, own)) ids.add(r.id);
  return ids;
}

/** Counts only members the group actually publishes (included groups too), so they match what its audience sees. */
export function groupSummary(db: Db, row: GroupRow): GroupSummary {
  const counts = { skill: 0, md: 0, artifact: 0 };
  const stmt = db.prepare(
    `SELECT i.id, i.kind, i.name, ${SERVED_EXEC} AS executable FROM group_members gm JOIN items i ON i.id = gm.item_id JOIN scp_groups g ON g.id = gm.group_id
     WHERE gm.group_id = ? AND ${PUBLISHED}`,
  );
  const seen = new Set<string>();
  const served: { item: { id: string; kind: Kind; name: string }; version: { executable: number } }[] = [];
  for (const { group: g, own } of effectiveGroups(db, row)) {
    for (const { executable, ...k } of stmt.all(g.id) as { id: string; kind: Kind; name: string; executable: number }[]) {
      if (seen.has(k.id) || withheldExec(k.kind, own)) continue;
      seen.add(k.id);
      counts[planeOf(k.kind)]++;
      served.push({ item: k, version: { executable } });
    }
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    visibility: row.visibility,
    owner: { id: row.owner_id, username: usernameOf(db, row.owner_id) },
    counts,
    executable: executableOf(served, false),
    updatedAt: row.updated_at,
  };
}

/**
 * Effective members p can read: the group's own published members in position order, then each
 * included group's (effectiveGroups order), at their pinned or latest version. The first occurrence
 * of an item wins, with the pin and installAs of the member row it came through. A hook or MCP server
 * of a group not reached through the owner's own groups alone is withheld (EffectiveGroup.own, withheldExec), listed
 * in `withheld` when given, unless an own group serves the same item.
 */
export function resolvedMembers(db: Db, p: Principal, group: GroupRow, withheld?: WithheldMember[]): ResolvedMember[] {
  const read = itemReadSql(p);
  const stmt = db.prepare(
    `SELECT i.*, gm.pinned_seq AS gm_pinned_seq, gm.install_as AS gm_install_as
     FROM group_members gm JOIN items i ON i.id = gm.item_id JOIN scp_groups g ON g.id = gm.group_id
     WHERE gm.group_id = ? AND ${PUBLISHED} AND ${read.sql} ORDER BY gm.position, gm.added_at`,
  );
  const out: ResolvedMember[] = [];
  const seen = new Set<string>();
  const held = new Map<string, WithheldMember>();
  for (const { group: g, depth, own } of effectiveGroups(db, group)) {
    const rows = stmt.all(g.id, ...read.params) as unknown as (ItemRow & { gm_pinned_seq: number | null; gm_install_as: string | null })[];
    for (const { gm_pinned_seq, gm_install_as, ...item } of rows) {
      if (seen.has(item.id)) continue;
      if (withheldExec(item.kind, own)) {
        if (!held.has(item.id)) held.set(item.id, { id: item.id, kind: item.kind, name: item.name, via: g.slug });
        continue;
      }
      seen.add(item.id);
      out.push({
        item,
        version: resolveVersion(db, item, gm_pinned_seq ?? undefined),
        pinnedSeq: gm_pinned_seq,
        installAs: gm_install_as,
        via: depth ? g.slug : null,
      });
    }
  }
  if (withheld) for (const [id, m] of held) if (!seen.has(id)) withheld.push(m);
  return out;
}

/**
 * mc52: the server names an MCP server version declares, its entry's top-level `mcpServers` keys, as a
 * JSON array for the version row `v` ('[]' when the entry is not that JSON). Claude Code keeps the last of
 * two servers one plugin declares under one name, so bundle.ts pluginConflicts compares them; read in
 * SQL, so pluginMembers stays one statement per group.
 */
const ENTRY_TEXT = 'CAST(b.data AS TEXT)';
const SERVER_NAMES = `(SELECT json_group_array(j.key) FROM version_files vf JOIN blobs b ON b.sha256 = vf.sha256,
  json_each(CASE WHEN json_valid(${ENTRY_TEXT}) THEN CASE json_type(${ENTRY_TEXT}, '$.mcpServers') WHEN 'object' THEN ${ENTRY_TEXT} END END, '$.mcpServers') j
  WHERE vf.version_id = v.id AND vf.path = v.entry_path)`;

/**
 * What listing a group as a plugin needs of its effective members (bundle.ts pluginProblem,
 * pluginVersion), the same set and order as resolvedMembers but one statement per effective group:
 * resolving a version row per member made marketplace.json cost members x groups statements
 * (100,000 for an account at the caps), seconds of blocked event loop per request. `files` is the
 * count across their versions (the same number place() checks against MAX_GROUP_FILES), from the
 * same statement.
 */
export function pluginMembers(db: Db, p: Principal, group: GroupRow): { members: PluginMember[]; files: number } {
  const read = itemReadSql(p);
  // mc52: an executable member's stored paths too, which land at those paths in plugin.zip (bundle.ts pluginFootprint), an MCP server's server names
  // and an output style's frontmatter (its name, bundle.ts styleName).
  const stmt = db.prepare(
    `SELECT i.id, i.kind, i.name, v.entry_path, v.total_bytes, v.created_at, v.executable, (SELECT COUNT(*) FROM version_files vf WHERE vf.version_id = v.id) AS files,
       CASE WHEN i.kind IN (SELECT value FROM json_each(?)) THEN (SELECT json_group_array(vf.path) FROM version_files vf WHERE vf.version_id = v.id) END AS paths,
       CASE WHEN i.kind = 'mcp-server' THEN ${SERVER_NAMES} END AS servers, CASE WHEN i.kind = 'output-style' THEN v.frontmatter END AS frontmatter FROM group_members gm
     JOIN items i ON i.id = gm.item_id JOIN scp_groups g ON g.id = gm.group_id
     JOIN item_versions v ON v.item_id = i.id AND v.seq = COALESCE(gm.pinned_seq, i.latest_seq)
     WHERE gm.group_id = ? AND ${PUBLISHED} AND ${read.sql} ORDER BY gm.position, gm.added_at`,
  );
  const members: PluginMember[] = [];
  let files = 0;
  const seen = new Set<string>();
  type Row = { id: string; kind: Kind; name: string; entry_path: string; total_bytes: number; created_at: string; executable: number; files: number; paths: string | null; servers: string | null; frontmatter: string | null };
  for (const { group: g, own } of effectiveGroups(db, group)) {
    for (const r of stmt.all(JSON.stringify(EXECUTABLE_KINDS), g.id, ...read.params) as unknown as Row[]) {
      if (seen.has(r.id) || withheldExec(r.kind, own)) continue;
      seen.add(r.id);
      files += r.files;
      members.push({
        item: { id: r.id, kind: r.kind, name: r.name },
        version: { entry_path: r.entry_path, total_bytes: r.total_bytes, created_at: r.created_at, executable: r.executable, ...(r.frontmatter !== null && { frontmatter: r.frontmatter }) },
        ...(r.paths !== null && { paths: JSON.parse(r.paths) as string[] }),
        ...(r.servers !== null && { servers: JSON.parse(r.servers) as string[] }),
      });
    }
  }
  return { members, files };
}

/** SERVER_NAMES of these MCP server versions, by version id, in one statement (bundle.ts buildManifest, buildPlugin). */
export function serverNames(db: Db, versionIds: string[]): Map<string, string[]> {
  const rows = db.prepare(`SELECT v.id, ${SERVER_NAMES} AS s FROM item_versions v WHERE v.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(versionIds)) as { id: string; s: string }[];
  return new Map(rows.map((r) => [r.id, JSON.parse(r.s) as string[]]));
}

/**
 * Direct includes in position order. Readers see the ones that flow (the owner vouches for them);
 * editors see every row, a stale one included, so they can remove it, but a child they can no longer
 * read (it went private) shows its slug alone: its live name and member count are not theirs to see.
 */
function includesOf(db: Db, p: Principal, row: GroupRow, canEdit: boolean): GroupInclude[] {
  const readable = groupReadSql(p, 'c');
  const rows = db
    .prepare(
      `SELECT c.slug, c.name, c.owner_id,
         (SELECT COUNT(*) FROM group_members gm JOIN items i ON i.id = gm.item_id WHERE gm.group_id = c.id AND ${publishedSql('i', 'c')}) AS member_count,
         (${includeVouchSql('par', 'c')}) AS flowing, (${readable.sql}) AS readable
       FROM group_includes gi JOIN scp_groups c ON c.id = gi.included_id JOIN scp_groups par ON par.id = gi.group_id
       WHERE gi.group_id = ? ${canEdit ? '' : `AND ${includeVouchSql('par', 'c')}`} ORDER BY gi.position, gi.added_at`,
    )
    .all(...readable.params, row.id) as { slug: string; name: string; owner_id: string; member_count: number; flowing: number; readable: number }[];
  // Whether the edge flows is the parent's business and shows in members[] (via) anyway; a child the
  // reader cannot open (the owner's private group under their public one) keeps its name and count to itself.
  return rows.map((r) =>
    r.readable
      ? { slug: r.slug, name: r.name, owner: { username: usernameOf(db, r.owner_id) }, memberCount: r.member_count, flowing: !!r.flowing }
      : { slug: r.slug, name: '', owner: { username: '' }, memberCount: 0, flowing: !!r.flowing },
  );
}

export function groupDetail(db: Db, p: Principal, row: GroupRow, publicUrl: string): GroupDetail {
  const canEdit = canEditGroup(p, row);
  const shared = canEdit
    ? (db
        .prepare('SELECT u.username FROM group_shares s JOIN users u ON u.id = s.user_id WHERE s.group_id = ? ORDER BY u.username')
        .all(row.id) as { username: string }[])
    : [];
  const readable = groupReadSql(p);
  // Only the edges that flow (includeVouchSql), so both ends agree: a child made private is no longer
  // republished by the parent, and its owner is not told it still is. LIMIT: a backstop over MAX_INCLUDED_BY.
  const includedBy = db
    .prepare(
      `SELECT g.slug, g.name FROM group_includes gi JOIN scp_groups g ON g.id = gi.group_id JOIN scp_groups c ON c.id = gi.included_id
       WHERE gi.included_id = ? AND ${includeVouchSql('g', 'c')} AND ${readable.sql} ORDER BY g.name LIMIT ${MAX_INCLUDED_BY}`,
    )
    .all(row.id, ...readable.params) as { slug: string; name: string }[];
  const api = `${publicUrl}/api/v1/groups/${row.slug}`;
  const members = resolvedMembers(db, p, row);
  return {
    ...groupSummary(db, row),
    executable: executableOf(members),
    instructions: row.instructions,
    sharedWith: shared.map((s) => s.username),
    members: members.map((m) => ({
      item: itemSummary(db, m.item),
      pinnedSeq: m.pinnedSeq,
      installAs: m.installAs,
      resolvedSeq: m.version.seq,
      executable: !!m.version.executable,
      installPath: installPath(m.item.kind, m.item.name, m.version.entry_path, { target: 'claude-code', scope: 'project', installAs: m.installAs }),
      via: m.via,
    })),
    includes: includesOf(db, p, row, canEdit),
    includedBy: includedBy.map((g) => ({ slug: g.slug, name: g.name })),
    endpoints: { mcp: `${publicUrl}/mcp/${row.slug}`, manifest: `${api}/manifest`, bundle: `${api}/bundle.zip` },
    canEdit,
    requires: requiresOf(db, members),
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

export const getGroupRow = (db: Db, id: string) => db.prepare('SELECT * FROM scp_groups WHERE id = ?').get(id) as unknown as GroupRow;

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
    // Visibility decides whether the include flows (includeVouchSql), so what every includer serves changed.
    if (patch.visibility !== undefined && patch.visibility !== group.visibility) touchIncluders(db, group.id);
    refreshFts(db, group.id);
    return getGroupRow(db, group.id);
  });
}

export function deleteGroup(ctx: Ctx, p: Principal, group: GroupRow): void {
  const { db } = ctx;
  assertEditable(p, group);
  tx(db, () => {
    touchIncluders(db, group.id); // before the cascade takes the edges with it
    db.prepare('DELETE FROM groups_fts WHERE group_id = ?').run(group.id);
    db.prepare('DELETE FROM scp_groups WHERE id = ?').run(group.id); // members, shares and includes cascade
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
  /** Owner of the group whose member row this is: the owner's own rows are the ones MAX_MEMBERS holds them to. */
  group_owner_id: string;
}

/** The members the group serves (own, then included; first occurrence wins), with what decides their install paths. */
function memberRows(db: Db, group: GroupRow): PlacedRow[] {
  const stmt = db.prepare(
    `SELECT i.id, i.kind, i.name, v.entry_path, v.id AS version_id, gm.install_as, g.owner_id AS group_owner_id FROM group_members gm
     JOIN items i ON i.id = gm.item_id JOIN scp_groups g ON g.id = gm.group_id
     JOIN item_versions v ON v.item_id = i.id AND v.seq = COALESCE(gm.pinned_seq, i.latest_seq)
     WHERE gm.group_id = ? AND ${PUBLISHED} ORDER BY gm.position, gm.added_at`,
  );
  const out: PlacedRow[] = [];
  const seen = new Set<string>();
  for (const { group: g, own } of effectiveGroups(db, group)) {
    for (const r of stmt.all(g.id) as unknown as PlacedRow[]) {
      // A withheld hook or MCP server installs nowhere, so it neither conflicts nor counts (resolvedMembers).
      if (seen.has(r.id) || withheldExec(r.kind, own)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

/**
 * The rows the owner is answerable for: their own groups' in the effective set. A stranger's public
 * subtree that grew past MAX_MEMBERS is theirs to trim (reads still serve it, place() caps files only),
 * never a reason to refuse the owner's unrelated write.
 */
const ownRows = (rows: PlacedRow[], group: GroupRow) => rows.filter((r) => r.group_owner_id === group.owner_id).length;

/**
 * Checked in every bundle the group can be downloaded as (codex maps both commands and prompts to
 * .codex/prompts/, so claude-code alone misses clashes). Built per call: bundle.ts imports this
 * module, so its consts are not initialized yet when this one loads. Covers the effective set; a
 * change inside an included group is caught there, and shows up here as a manifest lint.
 */
function assertGroupFits(db: Db, group: GroupRow, focus: ReadonlySet<string>): void {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(group.id) as { n: number };
  if (n > MAX_MEMBERS) throw new HttpError(400, 'group_full', `a group holds at most ${MAX_MEMBERS} members`);
  const rows = memberRows(db, group);
  if (ownRows(rows, group) > MAX_MEMBERS) throw new HttpError(400, 'group_full', `a group serves at most ${MAX_MEMBERS} members, its owner's included groups counted`);
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
    assertAncestorsFit(db, group);
    touchGroup(db, group.id);
  });
}

/** Groups that include `group`, directly or transitively, and share its owner. */
function ownAncestors(db: Db, group: GroupRow): GroupRow[] {
  return db
    .prepare(
      `WITH RECURSIVE up(id, depth) AS (SELECT ?, 0 UNION SELECT gi.group_id, up.depth + 1 FROM up JOIN group_includes gi ON gi.included_id = up.id WHERE up.depth < 64)
       SELECT g.* FROM scp_groups g JOIN up ON up.id = g.id WHERE g.id != ? AND g.owner_id = ?`,
    )
    .all(group.id, group.id, group.owner_id) as unknown as GroupRow[];
}

/**
 * A change inside `group` grows every group that includes it, so the owner's own ancestors must stay
 * within MAX_EFFECTIVE_GROUPS, MAX_MEMBERS and MAX_GROUP_FILES too, or effectiveGroups would silently
 * truncate what they serve while itemReadSql still grants it (and place() would answer group_full for
 * the hub's every manifest and bundle). Another owner's hub that includes this public group is not
 * checked: refusing bob's edit over alice's near-full hub would let anyone block a public group's owner.
 * ponytail: such a hub still truncates on read (see effectiveGroups); its owner trims an include.
 */
function assertAncestorsFit(db: Db, group: GroupRow): void {
  for (const a of ownAncestors(db, group)) {
    const via = `'${a.slug}', which includes '${group.slug}',`;
    if (effectiveGroups(db, a, MAX_EFFECTIVE_GROUPS + 1).length > MAX_EFFECTIVE_GROUPS) {
      throw new HttpError(400, 'include_too_many', `${via} would serve more than ${MAX_EFFECTIVE_GROUPS} groups through its includes`);
    }
    const rows = memberRows(db, a);
    if (ownRows(rows, a) > MAX_MEMBERS) throw new HttpError(400, 'group_full', `${via} would serve more than ${MAX_MEMBERS} members`);
    if (fileCount(db, rows.map((r) => r.version_id)) > MAX_GROUP_FILES) throw new HttpError(400, 'group_full', `${via} would serve more than ${MAX_GROUP_FILES} files`);
  }
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
    // Own rows only: a member that flows in through an include has no row here to replace.
    const visible = resolvedMembers(db, p, group)
      .filter((m) => !m.via)
      .map((m) => m.item.id);
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND item_id IN (SELECT value FROM json_each(?))').run(group.id, JSON.stringify(visible));
    insertMembers(db, group, checked);
    assertGroupFits(db, group, new Set(checked.map((m) => m.item.id)));
    assertAncestorsFit(db, group);
    touchGroup(db, group.id);
  });
}

export function removeMember(ctx: Ctx, p: Principal, group: GroupRow, itemId: string): void {
  const { db } = ctx;
  assertEditable(p, group);
  tx(db, () => {
    const r = db.prepare('DELETE FROM group_members WHERE group_id = ? AND item_id = ?').run(group.id, itemId);
    if (!r.changes) throw notFound('member');
    touchGroup(db, group.id);
  });
}

// ---------- includes (nested groups) ----------

/** Does `from` include `to`, directly or transitively? Structural: a stale edge counts too, so re-vouching later cannot close a cycle. */
function includesTransitively(db: Db, from: string, to: string): boolean {
  return !!db
    .prepare(
      `WITH RECURSIVE sub(id, depth) AS (SELECT ?, 0 UNION SELECT gi.included_id, sub.depth + 1 FROM sub JOIN group_includes gi ON gi.group_id = sub.id WHERE sub.depth < 64)
       SELECT 1 FROM sub WHERE id = ?`,
    )
    .get(from, to);
}

/**
 * The group `slug` as a new include of `group`: readable by p (404 otherwise, so a restricted key
 * cannot probe other groups), the owner's own or public (400 include_not_shareable: the same rule as
 * item_not_shareable, mirrored by includeVouchSql at read time), and not already above `group`
 * (409 include_cycle). Inside the caller's transaction.
 */
function checkInclude(db: Db, p: Principal, group: GroupRow, slug: string): GroupRow {
  const child = loadReadableGroup(db, p, slug.trim());
  if (child.owner_id !== group.owner_id && child.visibility !== 'public') {
    throw new HttpError(
      400,
      'include_not_shareable',
      `'${child.slug}' is another user's ${child.visibility} group; a group can only include its owner's groups or public ones`,
    );
  }
  if (child.id === group.id || includesTransitively(db, child.id, group.id)) {
    throw new HttpError(409, 'include_cycle', `including '${child.slug}' would make '${group.slug}' include itself`);
  }
  return child;
}

/**
 * Append one include row after the current last position; at most MAX_INCLUDES per group and, for
 * another user's include of a public group, MAX_INCLUDED_BY per child. The child's owner is never
 * refused by the fan-in cap: 50 strangers' hubs over their public group must not lock them out of
 * including their own group (they see one includer and nothing to remove).
 */
function insertInclude(db: Db, group: GroupRow, child: GroupRow, opts: { kept?: boolean } = {}): void {
  if (db.prepare('SELECT 1 FROM group_includes WHERE group_id = ? AND included_id = ?').get(group.id, child.id)) {
    throw new HttpError(409, 'include_exists', `'${child.slug}' is already included in this group`);
  }
  const { n, pos } = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position) + 1, 0) AS pos FROM group_includes WHERE group_id = ?').get(group.id) as { n: number; pos: number };
  if (n >= MAX_INCLUDES) throw new HttpError(400, 'include_too_many', `a group includes at most ${MAX_INCLUDES} groups`);
  // Fan-in counts other users' includers only (the owner's own hubs never crowd a stranger out, nor
  // the owner), and an edge that already existed (a reorder or a trim, replaceIncludes) is never re-judged.
  if (group.owner_id !== child.owner_id && !opts.kept) {
    const { by } = db
      .prepare('SELECT COUNT(*) AS by FROM group_includes gi JOIN scp_groups g ON g.id = gi.group_id WHERE gi.included_id = ? AND g.owner_id <> ?')
      .get(child.id, child.owner_id) as { by: number };
    if (by >= MAX_INCLUDED_BY) {
      throw new HttpError(400, 'include_too_many', `'${child.slug}' is already included by ${MAX_INCLUDED_BY} other users' groups, the most a group can be`);
    }
  }
  db.prepare('INSERT INTO group_includes (group_id, included_id, position, added_at) VALUES (?, ?, ?, ?)').run(group.id, child.id, pos, now());
}

/** The effective set (root included) stays within MAX_EFFECTIVE_GROUPS. After the insert. */
function assertEffectiveSize(db: Db, group: GroupRow): void {
  if (effectiveGroups(db, group, MAX_EFFECTIVE_GROUPS + 1).length > MAX_EFFECTIVE_GROUPS) {
    throw new HttpError(400, 'include_too_many', `a group serves at most ${MAX_EFFECTIVE_GROUPS} groups through its includes`);
  }
}

/** Item ids `after` serves that `before` did not: the focus for conflict checks, so a lint already between other members stays a lint. */
const newlyServed = (before: ReadonlySet<string>, after: ReadonlySet<string>) => new Set([...after].filter((id) => !before.has(id)));

/**
 * Longest include chain through `group` (edges above it plus edges below it) stays within
 * MAX_INCLUDE_DEPTH. After the insert. Both sides count the owner's own groups only (like
 * ownAncestors): a stranger's private chain stacked on a public group must not block its owner's next
 * include, and a stranger's public group deepened after the owner included it must not fail the owner's
 * next reorder or add; reads truncate at depth 4 anyway (effectiveGroups, access.ts upCte).
 */
function assertIncludeDepth(db: Db, group: GroupRow): void {
  const longest = (step: string, ...params: SQLInputValue[]) =>
    (
      db
        .prepare(`WITH RECURSIVE chain(id, depth) AS (SELECT ?, 0 UNION SELECT ${step} WHERE chain.depth < 64) SELECT MAX(depth) AS n FROM chain`)
        .get(group.id, ...params) as { n: number }
    ).n;
  const above = longest('gi.group_id, chain.depth + 1 FROM chain JOIN group_includes gi ON gi.included_id = chain.id JOIN scp_groups g ON g.id = gi.group_id AND g.owner_id = ?', group.owner_id);
  const below = longest('gi.included_id, chain.depth + 1 FROM chain JOIN group_includes gi ON gi.group_id = chain.id JOIN scp_groups c ON c.id = gi.included_id AND c.owner_id = ?', group.owner_id);
  if (above + below > MAX_INCLUDE_DEPTH) {
    throw new HttpError(400, 'include_too_deep', `groups nest at most ${MAX_INCLUDE_DEPTH} deep; this include would make a chain of ${above + below}`);
  }
}

export function addInclude(ctx: Ctx, p: Principal, group: GroupRow, slug: string): GroupRow {
  const { db } = ctx;
  assertEditable(p, group);
  return tx(db, () => {
    const before = servedItemIds(db, group);
    const child = checkInclude(db, p, group, slug);
    insertInclude(db, group, child);
    assertIncludeDepth(db, group);
    assertEffectiveSize(db, group);
    // Clashes involving an item the include newly serves are refused; ones already between other
    // members stay manifest lints, also when the child happens to serve one of those items too.
    assertGroupFits(db, group, newlyServed(before, servedItemIds(db, group)));
    assertAncestorsFit(db, group);
    touchGroup(db, group.id);
    return child;
  });
}

/**
 * Replace the include list in the given order; all-or-nothing. A slug already included is kept as
 * it is, without the read and shareability re-check: a child gone private is still the editor's to
 * reorder or drop (includesOf lists it for them), and an existing edge cannot start a cycle. The
 * depth, size and conflict checks run only when an edge is new: a reorder or a trim can make none of
 * them worse, and judging the existing edges again would fail the owner's no-op over a stranger's
 * public subtree that grew since (their remedy is the very PUT that drops it).
 */
export function replaceIncludes(ctx: Ctx, p: Principal, group: GroupRow, slugs: string[]): void {
  const { db } = ctx;
  assertEditable(p, group);
  tx(db, () => {
    const before = servedItemIds(db, group);
    // Slugs are COLLATE NOCASE and stored lowercase: key and look up the kept edges the same way, or a
    // differently cased slug in the PUT would count as a new edge and take the full re-check path.
    const current = new Map(
      (db.prepare('SELECT c.* FROM group_includes gi JOIN scp_groups c ON c.id = gi.included_id WHERE gi.group_id = ?').all(group.id) as unknown as GroupRow[]).map((c) => [c.slug.toLowerCase(), c]),
    );
    const key = (slug: string) => slug.trim().toLowerCase();
    const grew = slugs.some((slug) => !current.has(key(slug)));
    db.prepare('DELETE FROM group_includes WHERE group_id = ?').run(group.id);
    for (const slug of slugs) {
      const kept = current.get(key(slug));
      insertInclude(db, group, kept ?? checkInclude(db, p, group, slug), { kept: !!kept });
    }
    if (grew) {
      assertIncludeDepth(db, group);
      assertEffectiveSize(db, group);
      assertGroupFits(db, group, newlyServed(before, servedItemIds(db, group)));
      assertAncestorsFit(db, group);
    }
    touchGroup(db, group.id);
  });
}

export function removeInclude(ctx: Ctx, p: Principal, group: GroupRow, slug: string): void {
  const { db } = ctx;
  assertEditable(p, group);
  tx(db, () => {
    const r = db.prepare('DELETE FROM group_includes WHERE group_id = ? AND included_id = (SELECT id FROM scp_groups WHERE slug = ?)').run(group.id, slug.trim());
    if (!r.changes) throw notFound('include');
    touchGroup(db, group.id);
  });
}
