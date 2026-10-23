import type { Context } from 'hono';
import { HttpError, badRequest, notFound } from '../lib/http.ts';
import { loadReadableItem, readFile, resolveVersion } from '../items/service.ts';
import { installPath, loadReadableGroup, resolvedMembers, type ResolvedMember } from '../groups/service.ts';
import { KINDS, aKind, planeOf, type AppEnv, type Ctx, type GroupRow, type ItemRow, type Kind, type Principal, type VersionRow } from '../types.ts';

/** Who is asking and what they asked for: one group (/mcp/:group) or every readable group (/mcp). */
export interface McpScope {
  c: Context<AppEnv>;
  ctx: Ctx;
  p: Principal;
  /** null on the global endpoint. */
  group: GroupRow | null;
  membersOf(g: GroupRow): ResolvedMember[];
  /** The group a tool call targets: the endpoint's group (an explicit arg must match it) or, globally, the named one. */
  groupArg(slug?: string): GroupRow | null;
}

export function makeScope(c: Context<AppEnv>, p: Principal, group: GroupRow | null): McpScope {
  const ctx = c.var.ctx;
  const cache = new Map<string, ResolvedMember[]>();
  const membersOf = (g: GroupRow) => {
    let m = cache.get(g.id);
    if (!m) cache.set(g.id, (m = resolvedMembers(ctx.db, p, g)));
    return m;
  };
  return {
    c,
    ctx,
    p,
    group,
    membersOf,
    groupArg(slug) {
      if (group) {
        if (slug !== undefined && slug.trim().toLowerCase() !== group.slug.toLowerCase()) {
          throw new HttpError(400, 'wrong_group', `this endpoint serves group '${group.slug}' only; connect to /mcp/${slug} or /mcp for other groups`);
        }
        return group;
      }
      return slug ? loadReadableGroup(ctx.db, p, slug.trim()) : null;
    },
  };
}

export interface Resolved {
  item: ItemRow;
  version: VersionRow;
  member: ResolvedMember | null;
  group: GroupRow | null;
}

export interface Target {
  id?: string;
  name?: string;
  group?: string;
  version?: number;
  kind?: Kind;
}

const toolFor = (k: Kind) => (k === 'skill' ? 'get_skill' : k === 'artifact' ? 'get_artifact or render_artifact' : 'get_md');

/**
 * Find one item by id or name within scope. By id: readable, and in a group scope a member the group
 * publishes. By name: among the group's members of the wanted kinds. Version: explicit, else the
 * member's pinned/latest one, else latest.
 */
export function resolveTarget(s: McpScope, a: Target, kinds: readonly Kind[], what: string): Resolved {
  const g = s.groupArg(a.group);
  let member: ResolvedMember | null = null;
  let item: ItemRow;
  if (a.id) {
    if (g) {
      member = s.membersOf(g).find((m) => m.item.id === a.id) ?? null;
      if (!member) throw notFound(`item ${a.id} in group '${g.slug}'`);
      item = member.item;
    } else item = loadReadableItem(s.ctx.db, s.p, a.id);
  } else if (a.name) {
    if (!g) throw badRequest(`on the global /mcp endpoint, give 'group' together with 'name' (or look the item up by 'id')`);
    const name = a.name.trim().toLowerCase();
    const cands = s.membersOf(g).filter((m) => m.item.name === name && kinds.includes(m.item.kind) && (!a.kind || m.item.kind === a.kind));
    if (!cands.length) throw notFound(`${what} '${a.name}' in group '${g.slug}'`);
    if (cands.length > 1) {
      throw new HttpError(
        409,
        'ambiguous',
        `'${a.name}' matches ${cands.length} items in group '${g.slug}'. Call again with one id (or a kind):\n` +
          cands.map((m) => `- ${m.item.kind} ${m.item.name}, id ${m.item.id}`).join('\n'),
      );
    }
    member = cands[0];
    item = member.item;
  } else throw badRequest(`give 'name' or 'id'`);
  if (!kinds.includes(item.kind)) {
    throw new HttpError(400, 'wrong_kind', `'${item.name}' is ${aKind(item.kind)}, not ${(KINDS as readonly string[]).includes(what) ? aKind(what as Kind) : `an ${what}` /* item, MD document */}; use ${toolFor(item.kind)}`);
  }
  const version = a.version !== undefined ? resolveVersion(s.ctx.db, item, a.version) : (member?.version ?? resolveVersion(s.ctx.db, item));
  return { item, version, member, group: g };
}

export interface CatalogEntry {
  id: string;
  kind: Kind;
  plane: string;
  name: string;
  title: string;
  description: string;
  version: number;
  installPath: string;
}

export const memberInstallPath = (item: ItemRow, version: VersionRow, installAs: string | null = null) =>
  installPath(item.kind, item.name, version.entry_path, { target: 'claude-code', scope: 'project', installAs });

/** Descriptions in MCP catalogs are clipped: lists of 4 KB descriptions overflow host output limits. */
export const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const catalogEntry = (item: ItemRow, version: VersionRow, installAs: string | null = null): CatalogEntry => ({
  id: item.id,
  kind: item.kind,
  plane: planeOf(item.kind),
  name: item.name,
  title: clip(item.title, 200),
  description: clip(item.description),
  version: version.seq,
  installPath: memberInstallPath(item, version, installAs),
});

export const memberEntry = (m: ResolvedMember) => catalogEntry(m.item, m.version, m.installAs);

/** One readable markdown line per entry, for the model. */
export const catalogText = (entries: CatalogEntry[]) =>
  entries.length
    ? entries
        .map(
          (e) =>
            `- ${e.name} [${e.kind} v${e.version}]${e.title && e.title !== e.name ? ` "${e.title}"` : ''}: ${e.description || '(no description)'}\n  id ${e.id}, installs to ${e.installPath}`,
        )
        .join('\n')
    : '(nothing here yet)';

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Known binary formats, never shown as text even when the bytes happen to decode. */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|woff2?|ttf|otf|wasm)$/i;

/**
 * Text when the bytes are valid UTF-8 with no NUL in the first 8 KB; null for binary. Decided by
 * content, not by an extension allowlist: .xsd, .mdx, .ipynb or .j2 files are text too.
 */
export function asText(path: string, bytes: Uint8Array): string | null {
  if (BINARY_EXT.test(path) || bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

export function entryText(s: McpScope, version: VersionRow): string {
  const f = readFile(s.ctx.db, version.id, version.entry_path);
  return f ? utf8.decode(f.bytes) : '';
}

