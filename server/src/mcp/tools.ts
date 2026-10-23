import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { canEditGroup } from '../access.ts';
import { audit } from '../audit.ts';
import { tx } from '../db.ts';
import { HttpError, badRequest } from '../lib/http.ts';
import { createShare, listShares, previewUrl, renderVersionHtml } from '../artifacts/shares.ts';
import {
  addVersion,
  createItemTx,
  getItemRow,
  listFiles,
  loadEditableItem,
  readFile,
  resolveVersion,
  searchItems,
  slugify,
} from '../items/service.ts';
import { addMemberTx, listReadableGroups } from '../groups/service.ts';
import { INSTALL_SCOPES, TARGETS, buildManifest } from '../groups/bundle.ts';
import { asText, catalogEntry, catalogText, clip, entryText, memberEntry, memberInstallPath, resolveTarget, type McpScope } from './scope.ts';
import { VIEWER_URI } from './viewer.ts';
import { PLATFORMS, requiresOf, type RequiredCli } from '../tools/service.ts';
import { FORMATS, KINDS, MD_KINDS, aKind, type GroupRow, type ItemRow, type Kind } from '../types.ts';

/**
 * Max characters of a body per call; longer bodies page with `offset`. Claude Code refuses tool
 * results over MAX_MCP_OUTPUT_TOKENS (25k by default) and code or HTML runs ~3 characters a token,
 * so a page stays well under that even with JSON escaping.
 */
export const PAGE = 20_000;
/** Binary files over this come back as their HTTP URL instead: base64 is a third larger and unpageable. */
export const BINARY_MAX = 16 * 1024;
/** The viewer app pages rendered HTML for itself; the model never sees these chunks. */
export const VIEWER_PAGE = 100_000;
/** Catalog-style lists (groups, members, artifacts) per call. */
const LIST_PAGE = 50;
/** File index lines in get_skill / get_md; the rest are named by count. */
const FILE_INDEX_MAX = 100;

/**
 * Claude Code hands the model structuredContent instead of content when both are present (verified
 * 2026-10-20 against Claude Code 2.1.247 with a probe tool whose two channels carried different
 * markers: only the structured one reached the model; Kata sfxv), so
 * structuredContent carries everything the text does: data fields (the body chunk as `text`, lists,
 * `next` for paging) plus `message`. message is the whole text by default; tools whose structured
 * fields already carry the bulk pass a short message (summary, links, paging note) so nothing is sent twice.
 */
const ok = (text: string, structuredContent?: Record<string, unknown>): CallToolResult =>
  structuredContent ? { content: [{ type: 'text', text }], structuredContent: { message: text, ...structuredContent } } : { content: [{ type: 'text', text }] };
const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

function page(text: string, offset = 0, size = PAGE) {
  const chunk = text.slice(offset, offset + size);
  const next = offset + chunk.length;
  const done = next >= text.length;
  const note = done ? '' : `\n\n[truncated: characters ${offset}-${next} of ${text.length}. Call again with offset: ${next} for the rest.]`;
  return { chunk, offset, total: text.length, done, next: done ? null : next, note };
}

/** One page of a list, with the line that says how to get the next one. */
const listPage = <T,>(all: T[], from: number, what: string) => pageOf(all.slice(from, from + LIST_PAGE), all.length, from, what);

/** One page already cut (rows from offset `from`) out of total. */
function pageOf<T>(rows: T[], total: number, from: number, what: string) {
  const next = from + rows.length < total ? from + rows.length : null;
  const note = next !== null ? `\n\nShowing ${from + 1}-${next} of ${total} ${what}; call again with offset: ${next} for the rest.` : '';
  return { rows, total, next, note };
}

const fileIndex = (files: { path: string; size: number; mode: number }[], exec = true) => [
  ...files.slice(0, FILE_INDEX_MAX).map((f) => `- ${f.path} (${fmtBytes(f.size)})${exec && f.mode === 493 ? ' executable' : ''}`),
  ...(files.length > FILE_INDEX_MAX ? [`- ... and ${files.length - FILE_INDEX_MAX} more (download the bundle or item zip for all of them)`] : []),
];
const fileList = (files: { path: string; size: number }[]) => files.slice(0, FILE_INDEX_MAX).map((f) => ({ path: f.path, size: f.size }));

const errorText = (e: HttpError) => {
  const lints = Array.isArray(e.details) ? (e.details as { level?: string; code?: string; message?: string }[]) : [];
  const lines = lints.filter((l) => l && l.message).map((l) => `- ${l.level ?? 'error'} ${l.code ?? ''}: ${l.message}`);
  return lines.length ? `${e.message}\n${lines.join('\n')}` : e.message;
};

/**
 * The group's required CLIs as text (f9j0). Commands come from the admin registry only; the agent
 * shows them to the user and runs nothing on its own.
 */
function requiresText(reqs: RequiredCli[]): string {
  if (!reqs.length) return '';
  const lines = reqs.map((r) => {
    const by = `needed by ${r.items.map((i) => i.name).join(', ')}`;
    if (!r.tool) return `- ${r.name} (${by}): no install command recorded on this SCP instance.${r.sources ? ` Source: ${r.sources.join(', ')}` : ''}`;
    const cmds = PLATFORMS.filter((k) => r.tool!.install[k]).map((k) => `${k}: \`${r.tool!.install[k]}\``);
    return `- ${r.name} (${by}): ${cmds.length ? cmds.join('; ') : 'no install command recorded'}.${r.tool.homepage ? ` Homepage: ${r.tool.homepage}.` : ''} Check: \`command -v ${r.tool.check}\``;
  });
  return `## Required CLIs (${reqs.length})\n\nThese skills need command-line tools on the user's machine. Show the user these commands to run themselves; do not run them on your own.\n\n${lines.join('\n')}`;
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// Shared input fields.
const id = z.string().min(1).max(64);
const name = z.string().min(1).max(64);
const version = z.number().int().min(1);
const offset = z.number().int().min(0);
const group = z.string().min(1).max(64);

const READ = { readOnlyHint: true } as const;

export function registerTools(server: McpServer, s: McpScope): void {
  const { ctx, p, c } = s;
  const { db, config } = ctx;
  const groupDesc = s.group
    ? `Optional; this endpoint already serves group '${s.group.slug}'.`
    : 'Group slug. Required with name on the global endpoint.';
  const itemUrl = (itemId: string) => `${config.publicUrl}/items/${itemId}`;
  // OAuth tokens work on /mcp only (oauth/tokens.ts): a hosted client must not be told to reuse this
  // connection's credential on an /api/v1 download URL, where it is refused as an invalid API key.
  const viaOauth = p.via === 'oauth';
  const withKey = viaOauth
    ? `with an SCP API key minted on ${config.publicUrl}/keys (Authorization: Bearer <key>; this connection's OAuth token is not accepted there)`
    : 'with the API key (Authorization: Bearer)';

  /** Audit, run, and turn HttpErrors into tool errors the agent can read. */
  function add<S extends z.ZodRawShape>(
    toolName: string,
    cfg: { title: string; description: string; inputSchema: S; annotations?: Record<string, boolean>; _meta?: Record<string, unknown> },
    fn: (a: z.infer<z.ZodObject<S>>) => CallToolResult | Promise<CallToolResult>,
  ): void {
    const handler = async (a: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
      audit(c, p, { action: 'mcp.call', detail: { tool: toolName, group: s.group?.slug ?? null } });
      try {
        return await fn(a);
      } catch (e) {
        if (e instanceof HttpError) return fail(errorText(e));
        console.error(e);
        return fail(`${toolName} failed with an internal error`);
      }
    };
    server.registerTool(toolName, cfg, handler as never);
  }

  const needWrite = (toolName: string) =>
    p.scopes.includes('write')
      ? null
      : fail(`This API key is read-only: ${toolName} needs the 'write' scope. Create a key with read and write scopes in SCP (Keys page) and reconnect.`);

  /** The group a group-level tool works on; the global endpoint needs it named. */
  const needGroup = (slug: string | undefined, toolName: string): GroupRow => {
    const g = s.groupArg(slug);
    if (!g) throw badRequest(`${toolName} on the global /mcp endpoint needs 'group' (a slug from list_groups)`);
    return g;
  };

  // ---------- discovery ----------

  if (!s.group) {
    add(
      'list_groups',
      {
        title: 'List groups',
        description: `Groups this API key can read: slug, name, owner, description and item counts, ${LIST_PAGE} per page. Filter with q (full-text).`,
        inputSchema: { q: z.string().max(500).optional(), offset: offset.optional().describe(`Skip this many groups (pages are ${LIST_PAGE} long)`) },
        annotations: READ,
      },
      ({ q, offset: from = 0 }) => {
        const found = listReadableGroups(db, p, { q, limit: LIST_PAGE, offset: from });
        const pg = pageOf(found.groups, found.total, from, 'groups');
        const groups = pg.rows.map((g) => ({
          slug: g.slug,
          name: clip(g.name, 100),
          owner: g.owner.username,
          description: clip(g.description),
          counts: g.counts,
          mcp: `${config.publicUrl}/mcp/${g.slug}`,
        }));
        const how = `Open one with get_group {"group": "<slug>"}, or connect to ${config.publicUrl}/mcp/<slug>.`;
        const text = groups.length
          ? groups
              .map(
                (g) =>
                  `- ${g.slug}: ${g.name} (by ${g.owner})${g.description ? ` - ${g.description.replace(/\s+/g, ' ')}` : ''} (${g.counts.skill} skills, ${g.counts.md} MDs, ${g.counts.artifact} artifacts)`,
              )
              .join('\n') + `${pg.note}\n\n${how}`
          : pg.total ? `No groups past offset ${from} (${pg.total} readable).` : 'No readable groups.';
        return ok(text, { groups, total: pg.total, next: pg.next, message: `${pg.total} readable group(s), ${groups.length} in \`groups\`.${pg.note} ${how}` });
      },
    );
  }

  add(
    'get_group',
    {
      title: 'Get group catalog',
      description:
        `Group info, its instructions, and the catalog of every skill, MD document (agents, commands, AGENTS.md, prompts, DESIGN.md, packages) and artifact in it, ${LIST_PAGE} per page. No bodies: load one with get_skill, get_md or get_artifact.`,
      inputSchema: { group: group.optional().describe(groupDesc), offset: offset.optional().describe(`Skip this many catalog entries (pages are ${LIST_PAGE} long)`) },
      annotations: READ,
    },
    ({ group: slug, offset: from = 0 }) => {
      const g = needGroup(slug, 'get_group');
      const pg = listPage(s.membersOf(g), from, 'entries');
      const entries = pg.rows.map(memberEntry);
      const how = 'Load a skill with get_skill, an MD with get_md, an artifact with get_artifact or render_artifact. Install everything with get_bundle.';
      // Description, instructions and required CLIs on the first page only; later pages are catalog.
      const first = from === 0;
      const requires = first ? requiresOf(db, s.membersOf(g)) : [];
      const text = [
        `# ${g.name} (group '${g.slug}')`,
        first ? g.description.trim() : '',
        first && g.instructions.trim() ? `## Instructions\n\n${g.instructions.trim()}` : '',
        requiresText(requires),
        `## Catalog (${pg.total})\n\n${catalogText(entries)}${pg.note}`,
        how,
      ]
        .filter(Boolean)
        .join('\n\n');
      return ok(text, {
        group: {
          slug: g.slug,
          name: g.name,
          ...(first ? { description: g.description, instructions: g.instructions, requires } : {}),
          mcp: `${config.publicUrl}/mcp/${g.slug}`,
        },
        items: entries,
        total: pg.total,
        next: pg.next,
        message: `Group '${g.slug}': ${pg.total} catalog entries, ${entries.length} in \`items\`${first ? '; description, instructions and required CLIs in `group`' : ''}.${pg.note} ${how}${requires.length ? ` These skills need ${requires.length} CLI(s) installed (\`group.requires\`): show the user the install commands to run themselves; do not run them on your own.` : ''}`,
      });
    },
  );

  add(
    'search',
    {
      title: 'Search',
      description:
        'Full-text search over names, titles, descriptions, tags and bodies of the items in scope. Pass a few keywords (word prefixes match). ' +
        'Items matching every word come first; when none do, items matching any word are returned, best first. Returns ranked catalog entries (no bodies).',
      inputSchema: {
        query: z.string().min(1).max(500),
        plane: z.enum(['skill', 'md', 'artifact']).optional(),
        kind: z.enum(KINDS).optional(),
        group: group.optional().describe(s.group ? groupDesc : 'Optional group slug to search within.'),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: READ,
    },
    ({ query, plane, kind, group: slug, limit }) => {
      const g = s.groupArg(slug);
      const n = limit ?? 20;
      const find = (anyTerm: boolean) => {
        if (g) {
          const members = new Map(s.membersOf(g).map((m) => [m.item.id, m]));
          // Over-fetch: search sees readable items, the group publishes a subset of them.
          const found = searchItems(db, p, { q: query, anyTerm, plane, kind, groupId: g.id, limit: 200 }).items;
          return found.flatMap((it) => (members.has(it.id) ? [memberEntry(members.get(it.id)!)] : [])).slice(0, n);
        }
        return searchItems(db, p, { q: query, anyTerm, plane, kind, limit: n }).items.map((it) => {
          const row = getItemRow(db, it.id)!;
          return catalogEntry(row, resolveVersion(db, row));
        });
      };
      // Agents write task sentences; an all-words match rarely survives one, so fall back to any word.
      let entries = find(false);
      const loose = !entries.length && /\s/.test(query.trim());
      if (loose) entries = find(true);
      const where = g ? ` in group '${g.slug}'` : '';
      const head = loose
        ? `No item matches every word of "${query}"${where}; ${entries.length} match some of them, best first:`
        : `${entries.length} result(s) for "${query}"${where}:`;
      const browse = g ? ' Browse the whole catalog with get_group.' : ' Browse a group with get_group.';
      const text = entries.length ? `${head}\n\n${catalogText(entries)}` : `No results for "${query}"${where}.${browse}`;
      return ok(text, { results: entries, ...(entries.length ? { message: `${head} (in \`results\`)` } : {}) });
    },
  );

  // ---------- skills ----------

  add(
    'get_skill',
    {
      title: 'Get skill',
      description: 'Load a skill: its SKILL.md verbatim, the list of its other files, and where it installs. Fetch other files with get_skill_file.',
      inputSchema: {
        name: name.optional().describe('Skill name (from the catalog)'),
        id: id.optional().describe('Item id, instead of name'),
        group: group.optional().describe(groupDesc),
        version: version.optional().describe('Version number; default is the version the group pins (or latest)'),
        offset: offset.optional().describe('Character offset into SKILL.md for long files'),
      },
      annotations: READ,
    },
    (a) => {
      const { item, version: v, member } = resolveTarget(s, a, ['skill'], 'skill');
      const pg = page(entryText(s, v), a.offset ?? 0);
      const files = listFiles(db, v.id);
      const install = memberInstallPath(item, v, member?.installAs);
      const head = [`# ${item.title || item.name}`, `skill ${item.name} v${v.seq} (latest v${item.latest_seq}), id ${item.id}`, `Install path (Claude Code, project): ${install}`];
      const fetch = `Fetch a file with get_skill_file {"id": "${item.id}", "path": "<path>", "version": ${v.seq}}. Install the whole group with get_bundle.`;
      const text = [
        ...head,
        '',
        `--- SKILL.md${pg.offset ? ` from offset ${pg.offset}` : ''} ---`,
        pg.chunk + pg.note,
        '--- end SKILL.md ---',
        '',
        `## Files (${files.length})`,
        ...fileIndex(files),
        '',
        fetch,
      ].join('\n');
      return ok(text, {
        id: item.id,
        name: item.name,
        version: v.seq,
        installPath: install,
        offset: pg.offset,
        total: pg.total,
        done: pg.done,
        next: pg.next,
        text: pg.chunk,
        files: fileList(files),
        fileCount: files.length,
        message: [...head, `SKILL.md${pg.offset ? ` from offset ${pg.offset}` : ''} is in \`text\`, ${files.length} file(s) in \`files\`.${pg.note}`, fetch].join('\n'),
      });
    },
  );

  add(
    'get_skill_file',
    {
      title: 'Get item file',
      description: 'One file of a skill (or package/design) by path, e.g. scripts/run.py. Text comes back as text (paged by offset), binary as base64 up to 16 KB (larger binaries: a download URL).',
      inputSchema: {
        path: z.string().min(1).max(255),
        name: name.optional(),
        id: id.optional(),
        kind: z.enum(KINDS).optional().describe('Only needed when two items share the name'),
        group: group.optional().describe(groupDesc),
        version: version.optional(),
        offset: offset.optional(),
      },
      annotations: READ,
    },
    (a) => {
      // By name, prefer the skill when a skill and another item share the name.
      let kinds: readonly Kind[] = KINDS;
      if (!a.id && !a.kind) {
        const g = s.groupArg(a.group);
        const nm = a.name?.trim().toLowerCase();
        if (g && s.membersOf(g).some((m) => m.item.name === nm && m.item.kind === 'skill')) kinds = ['skill'];
      }
      const { item, version: v } = resolveTarget(s, a, kinds, 'item');
      const f = readFile(db, v.id, a.path);
      if (!f) {
        const paths = listFiles(db, v.id).map((x) => x.path);
        throw new HttpError(404, 'not_found', `no file '${a.path}' in ${item.name} v${v.seq}. Files: ${paths.slice(0, 50).join(', ')}${paths.length > 50 ? ', ...' : ''}`);
      }
      // Segments percent-encoded: the item-file resource decodes them ('100%.md' would not parse).
      const encodedPath = a.path.split('/').map(encodeURIComponent).join('/');
      const base = { id: item.id, name: item.name, version: v.seq, path: a.path, size: f.bytes.length, uri: `scp://items/${item.id}/v/${v.seq}/${encodedPath}` };
      const text = asText(a.path, f.bytes);
      if (text !== null) {
        const pg = page(text, a.offset ?? 0);
        const head = `--- ${item.name}/${a.path} (v${v.seq}, ${fmtBytes(f.bytes.length)})${pg.offset ? ` from offset ${pg.offset}` : ''} ---`;
        return ok(`${head}\n${pg.chunk}${pg.note}`, {
          ...base,
          encoding: 'utf8',
          offset: pg.offset,
          total: pg.total,
          done: pg.done,
          next: pg.next,
          text: pg.chunk,
          message: `${head}\nThe file text is in \`text\`.${pg.note}`,
        });
      }
      const http = `${config.publicUrl}/api/v1/items/${item.id}/files/${encodedPath}?version=${v.seq}`;
      if (f.bytes.length > BINARY_MAX) {
        return fail(`${a.path} is a ${fmtBytes(f.bytes.length)} binary file; over MCP binary files are capped at ${fmtBytes(BINARY_MAX)}. Download it ${withKey}: ${http}`);
      }
      const b64 = Buffer.from(f.bytes).toString('base64');
      const head = `${item.name}/${a.path} is binary (${fmtBytes(f.bytes.length)}). Base64 below; decode it before writing to disk, or download it ${withKey} from ${http}`;
      return ok(`${head}\n\n${b64}`, { ...base, encoding: 'base64', base64: b64, url: http, message: head.replace('below', 'in `base64`') });
    },
  );

  // ---------- MD documents ----------

  add(
    'get_md',
    {
      title: 'Get MD document',
      description:
        'Load an MD document verbatim: agent definition, slash command, instructions (AGENTS.md), prompt, DESIGN.md, or a package (entry file plus file list). Includes frontmatter and install path.',
      inputSchema: {
        name: name.optional(),
        id: id.optional(),
        kind: z.enum(MD_KINDS).optional().describe('agent, command, instructions, prompt, design or package; only needed when names collide'),
        group: group.optional().describe(groupDesc),
        version: version.optional(),
        offset: offset.optional(),
      },
      annotations: READ,
    },
    (a) => {
      const { item, version: v, member } = resolveTarget(s, a, MD_KINDS, 'MD document');
      const pg = page(entryText(s, v), a.offset ?? 0);
      const install = memberInstallPath(item, v, member?.installAs);
      // Up to 64 KB of YAML; the entry text (which holds it verbatim) is enough when it is that large.
      const frontmatter = v.frontmatter.length <= PAGE ? (JSON.parse(v.frontmatter) as Record<string, unknown>) : null;
      const files = item.kind === 'package' || item.kind === 'design' ? listFiles(db, v.id) : [];
      const head = [`# ${item.title || item.name}`, `${item.kind} ${item.name} v${v.seq} (latest v${item.latest_seq}), id ${item.id}`, `Install path (Claude Code, project): ${install}`];
      const fetch = files.length > 1 ? `Fetch a file with get_skill_file {"id": "${item.id}", "path": "<path>", "version": ${v.seq}}.` : '';
      const lines = [...head, '', `--- ${v.entry_path}${pg.offset ? ` from offset ${pg.offset}` : ''} ---`, pg.chunk + pg.note, `--- end ${v.entry_path} ---`];
      if (files.length > 1) lines.push('', `## Files (${files.length})`, ...fileIndex(files, false), '', fetch);
      return ok(lines.join('\n'), {
        id: item.id,
        kind: item.kind,
        name: item.name,
        version: v.seq,
        entryPath: v.entry_path,
        installPath: install,
        frontmatter,
        offset: pg.offset,
        total: pg.total,
        done: pg.done,
        next: pg.next,
        text: pg.chunk,
        ...(files.length > 1 ? { files: fileList(files), fileCount: files.length } : {}),
        message: [...head, `${v.entry_path}${pg.offset ? ` from offset ${pg.offset}` : ''} is in \`text\`, its frontmatter in \`frontmatter\`.${pg.note}`, fetch]
          .filter(Boolean)
          .join('\n'),
      });
    },
  );

  // ---------- artifacts ----------

  add(
    'list_artifacts',
    {
      title: 'List artifacts',
      description: 'Artifacts (HTML tools, dashboards, documents, decks, diagrams, components) in scope.',
      inputSchema: {
        group: group.optional().describe(s.group ? groupDesc : 'Group slug; without it, every artifact this key can read'),
        offset: offset.optional().describe(`Skip this many artifacts (lists are ${LIST_PAGE} long)`),
      },
      annotations: READ,
    },
    ({ group: slug, offset: from = 0 }) => {
      const g = s.groupArg(slug);
      let rows: { item: ItemRow; entry: ReturnType<typeof catalogEntry> }[];
      let total: number;
      if (g) {
        const all = s.membersOf(g).filter((m) => m.item.kind === 'artifact');
        total = all.length;
        rows = all.slice(from, from + LIST_PAGE).map((m) => ({ item: m.item, entry: memberEntry(m) }));
      } else {
        const found = searchItems(db, p, { plane: 'artifact', limit: LIST_PAGE, offset: from });
        total = found.total;
        rows = found.items.map((it) => {
          const row = getItemRow(db, it.id)!;
          return { item: row, entry: catalogEntry(row, resolveVersion(db, row)) };
        });
      }
      const list = rows.map(({ item, entry }) => ({ ...entry, format: item.format, category: item.category, tags: JSON.parse(item.tags) as string[] }));
      const next = from + list.length < total ? from + list.length : null;
      const more = next !== null ? `\n\nShowing ${from + 1}-${next} of ${total}; call again with offset: ${next} for the rest.` : '';
      const how = 'Show one with render_artifact, read its source with get_artifact.';
      const text = list.length
        ? list
            .map((a) => `- ${a.name} [${a.format} v${a.version}${a.category ? `, ${a.category}` : ''}] "${a.title || a.name}": ${a.description || '(no description)'}\n  id ${a.id}`)
            .join('\n') + more + `\n\n${how}`
        : total ? `No artifacts past offset ${from} (${total} in scope).` : 'No artifacts in scope.';
      return ok(text, {
        artifacts: list,
        total,
        offset: from,
        next,
        ...(list.length ? { message: `${total} artifact(s) in scope, ${list.length} in \`artifacts\`.${more} ${how}` } : {}),
      });
    },
  );

  add(
    'get_artifact',
    {
      title: 'Get artifact source',
      description: `The source text of an artifact (HTML, Markdown, SVG, Mermaid, JSX or code), for editing or reuse. Paged at ${PAGE.toLocaleString('en-US')} characters by offset.`,
      inputSchema: { name: name.optional(), id: id.optional(), group: group.optional().describe(groupDesc), version: version.optional(), offset: offset.optional() },
      annotations: READ,
    },
    (a) => {
      const { item, version: v } = resolveTarget(s, a, ['artifact'], 'artifact');
      const pg = page(entryText(s, v), a.offset ?? 0);
      const head = [`# ${item.title || item.name}`, `artifact ${item.name} v${v.seq} (latest v${item.latest_seq}), format ${item.format}, id ${item.id}`];
      const text = [...head, '', `--- ${v.entry_path}${pg.offset ? ` from offset ${pg.offset}` : ''} ---`, pg.chunk + pg.note, `--- end ${v.entry_path} ---`].join('\n');
      return ok(text, {
        id: item.id,
        name: item.name,
        title: item.title,
        format: item.format,
        version: v.seq,
        entryPath: v.entry_path,
        offset: pg.offset,
        total: pg.total,
        done: pg.done,
        next: pg.next,
        text: pg.chunk,
        message: [...head, `${v.entry_path}${pg.offset ? ` from offset ${pg.offset}` : ''} is in \`text\`.${pg.note}`].join('\n'),
      });
    },
  );

  add(
    'render_artifact',
    {
      title: 'Render artifact',
      description: 'Show an artifact rendered (MCP App in hosts that support it). Always returns a short-lived preview link, and the public share link when one exists.',
      inputSchema: { name: name.optional(), id: id.optional(), group: group.optional().describe(groupDesc), version: version.optional() },
      annotations: READ,
      _meta: { ui: { resourceUri: VIEWER_URI }, 'ui/resourceUri': VIEWER_URI },
    },
    (a) => {
      const { item, version: v } = resolveTarget(s, a, ['artifact'], 'artifact');
      const title = item.title || item.name;
      // Share links are the owner's to hand out: other readers of the group get the preview only.
      const share = item.owner_id === p.userId || p.isAdmin ? listShares(ctx, item.id).find((x) => !x.revokedAt && x.url) : undefined;
      const lines = [`Rendered '${title}' (v${v.seq}, ${item.format}). Preview (expires in 10 min): ${previewUrl(ctx, item, v.seq)}`];
      if (share) lines.push(`Public link: ${share.url}`);
      return ok(lines.join('\n'), { id: item.id, version: v.seq, title, format: item.format, uri: `scp://artifacts/${item.id}/v/${v.seq}` });
    },
  );

  add(
    'scp_artifact_content',
    {
      title: 'Artifact HTML (viewer)',
      description: 'Used by the SCP viewer app to load rendered artifact HTML in chunks. Not for the model.',
      inputSchema: { id, version, offset: offset.optional() },
      annotations: READ,
      _meta: { ui: { resourceUri: VIEWER_URI, visibility: ['app'] } },
    },
    (a) => {
      const { item, version: v } = resolveTarget(s, { id: a.id, version: a.version }, ['artifact'], 'artifact');
      const pg = page(renderVersionHtml(db, config, item, v), a.offset ?? 0, VIEWER_PAGE);
      return ok(`HTML of '${item.title || item.name}' v${v.seq}: characters ${pg.offset}-${pg.offset + pg.chunk.length} of ${pg.total}.`, {
        html: pg.chunk,
        offset: pg.offset,
        total: pg.total,
        done: pg.done,
      });
    },
  );

  // ---------- install ----------

  add(
    'get_bundle',
    {
      title: 'Get install bundle',
      description:
        'URL and ready-to-run commands to download the group as a zip laid out for Claude Code (default), Codex or a generic tree, and unzip it in place. Also summarizes what it installs.',
      inputSchema: {
        group: group.optional().describe(s.group ? groupDesc : 'Group slug (required here)'),
        target: z.enum(TARGETS).optional().describe('claude-code (default), codex or generic'),
        scope: z.enum(INSTALL_SCOPES).optional().describe('project (default: unzip at the repo root) or user (unzip in your home directory)'),
      },
      annotations: READ,
    },
    ({ group: slug, target = 'claude-code', scope = 'project' }) => {
      const g = needGroup(slug, 'get_bundle');
      const m = buildManifest(db, p, g, { target, scope });
      const url = `${config.publicUrl}/api/v1/groups/${g.slug}/bundle.zip?target=${target}&scope=${scope}`;
      const file = `scp-${g.slug}.zip`;
      const bash = `curl -fsSL -H "Authorization: Bearer $SCP_KEY" "${url}" -o ${file} && unzip -o ${file}`;
      const powershell = `Invoke-WebRequest -Headers @{ Authorization = "Bearer $env:SCP_KEY" } -Uri "${url}" -OutFile ${file}; Expand-Archive -Force ${file} -DestinationPath .`;
      const where = scope === 'user' ? 'your home directory' : 'the project root';
      const conflicts = m.conflicts.slice(0, 20).map((x) => ({ path: x.path, items: x.items.slice(0, 10) }));
      const summary = `Bundle for group '${g.slug}' (${target}, ${scope} scope): ${m.items.length} item(s).`;
      // The $SCP_KEY commands presume an API key; an OAuth connection may be the user's only credential, so name what the URL needs instead.
      const commands = viaOauth
        ? [
            `${summary} Download URL: ${url}`,
            `This connection is an OAuth token, which that URL does not accept: fetch it ${withKey}, then unzip the file in ${where}; or install the group as a Claude Code plugin from its Plugin tab.`,
          ]
        : [`${summary} Run from ${where}, with SCP_KEY set to your SCP API key:`, '', 'bash:', bash, '', 'PowerShell:', powershell];
      const requires = requiresOf(db, s.membersOf(g));
      const text = [
        ...commands,
        ...(requires.length ? ['', requiresText(requires)] : []),
        '',
        'Installs:',
        ...m.items.slice(0, LIST_PAGE).map((i) => `- ${i.installPath} (${i.kind} ${i.name} v${i.version})`),
        ...(m.items.length > LIST_PAGE ? [`- ... and ${m.items.length - LIST_PAGE} more (get_group lists them all)`] : []),
        'plus scp.lock.json (what was installed, with versions and hashes).',
        ...(conflicts.length
          ? ['', `Warning: install path conflicts (the download will fail until fixed): ${conflicts.map((x) => `${x.path} <- ${x.items.join(', ')}`).join('; ')}${m.conflicts.length > conflicts.length ? `; and ${m.conflicts.length - conflicts.length} more` : ''}`]
          : []),
      ].join('\n');
      return ok(text, { group: g.slug, url, target, scope, items: m.items.length, ...(viaOauth ? {} : { bash, powershell }), conflicts, conflictCount: m.conflicts.length, requires });
    },
  );

  // ---------- writes ----------

  add(
    'create_artifact',
    {
      title: 'Create artifact',
      description:
        'Save new work as a private SCP artifact (html, markdown, svg, mermaid, react JSX or code). On a group endpoint it is also added to the group when your key can edit it. Needs the write scope.',
      inputSchema: {
        title: z.string().min(1).max(200),
        format: z.enum(FORMATS),
        content: z.string().min(1).describe('The whole source: a full HTML document, Markdown, SVG, Mermaid, a JSX module with a default export, or code'),
        category: z.string().max(40).optional().describe('component, design, deck, document, dashboard, tool or other'),
        description: z.string().max(2000).optional(),
        tags: z.array(z.string()).max(20).optional(),
        name: z.string().max(64).optional().describe('Slug; derived from the title when omitted'),
      },
    },
    (a) => {
      const denied = needWrite('create_artifact');
      if (denied) return denied;
      const g = s.group;
      // A group publishes only its owner's items, so the new (private) artifact can join only a group p owns.
      const addTo = g && canEditGroup(p, g) && g.owner_id === p.userId ? g : null;
      if (!addTo && p.groupIds) {
        return fail(
          g
            ? `this key is restricted to groups it cannot write to: it cannot edit group '${g.slug}', so nothing was created`
            : 'this key is restricted to groups it cannot write to: on the global endpoint nothing can be added to a group, so nothing was created. Connect to /mcp/<group> for a group you own.',
        );
      }
      const item = tx(db, () => {
        const it = createItemTx(
          ctx,
          p,
          {
            kind: 'artifact',
            title: a.title,
            format: a.format,
            content: a.content,
            category: a.category,
            description: a.description,
            tags: a.tags,
            name: p.groupIds ? opaqueName(a.name || a.title) : a.name || freeName(a.title),
            note: 'created over MCP',
          },
          { skipRestrictedCheck: !!addTo },
        );
        if (addTo) addMemberTx(ctx, p, addTo, { itemId: it.id }, { skipReadCheck: true });
        return it;
      });
      audit(c, p, { action: 'item.create', targetType: 'item', targetId: item.id, detail: { kind: item.kind, name: item.name, via: 'mcp' } });
      if (addTo) audit(c, p, { action: 'group.members', targetType: 'group', targetId: addTo.id, detail: { slug: addTo.slug, op: 'add', itemId: item.id } });
      const url = itemUrl(item.id);
      // The item stays private, but a group republishes its owner's items to every reader.
      const audience = addTo && addTo.visibility !== 'private' ? addTo.visibility : null;
      const text = [
        `Created artifact '${item.title}' (${item.name}, v1, ${item.format}), private. id ${item.id}`,
        `Web: ${url}`,
        `Preview (expires in 10 min): ${previewUrl(ctx, item, 1)}`,
        addTo
          ? `Added to group '${addTo.slug}'.${audience ? ` That group is ${audience}: everyone who can read it can now see this artifact.` : ''}`
          : g
            ? `Not added to group '${g.slug}' (you do not own it), so this endpoint cannot read or render it; use ${config.publicUrl}/mcp for that.`
            : '',
        `Update it with update_artifact {"id": "${item.id}"}; publish a public link with share_artifact.`,
      ]
        .filter(Boolean)
        .join('\n');
      return ok(text, { id: item.id, name: item.name, version: 1, url, addedToGroup: addTo?.slug ?? null });
    },
  );

  /**
   * Writes by id check edit rights, not group membership: an artifact create_artifact could not add
   * to this endpoint's group is still the caller's to update and share. Edit rights keep restricted
   * keys contained (canEditItem requires the item to be in one of their groups).
   */
  function editableArtifact(itemId: string): ItemRow {
    const item = loadEditableItem(db, p, itemId);
    if (item.kind !== 'artifact') throw new HttpError(400, 'wrong_kind', `'${item.name}' is ${aKind(item.kind)}, not an artifact`);
    return item;
  }

  const baseName = (s: string) => (slugify(s) || 'artifact').slice(0, 56).replace(/[-._]+$/, '') || 'artifact';

  /**
   * Restricted keys must not learn which names the account already uses outside their groups
   * (name_taken or a '-2' suffix would be an existence oracle), so they always get a random suffix.
   */
  function opaqueName(s: string): string {
    return `${baseName(s)}-${randomBytes(4).toString('hex').slice(0, 7)}`;
  }

  /** First free artifact name for p derived from the title: name, name-2, name-3, ... */
  function freeName(title: string): string {
    const base = baseName(title);
    const taken = db.prepare("SELECT 1 FROM items WHERE owner_id = ? AND kind = 'artifact' AND name = ?");
    let n = base;
    for (let i = 2; taken.get(p.userId, n); i++) n = `${base}-${i}`;
    return n;
  }

  add(
    'update_artifact',
    {
      title: 'Update artifact',
      description: 'Save a new version of an artifact you own (full replacement source). Earlier versions stay. Needs the write scope.',
      inputSchema: { id, content: z.string().min(1), note: z.string().max(500).optional() },
    },
    (a) => {
      const denied = needWrite('update_artifact');
      if (denied) return denied;
      const item = editableArtifact(a.id);
      const v = addVersion(ctx, p, item, { content: a.content, note: a.note ?? 'updated over MCP' });
      audit(c, p, { action: 'item.version', targetType: 'item', targetId: item.id, detail: { kind: item.kind, name: item.name, seq: v.seq, via: 'mcp' } });
      const url = itemUrl(item.id);
      return ok(`Saved '${item.title || item.name}' v${v.seq}. Web: ${url}\nPreview (expires in 10 min): ${previewUrl(ctx, item, v.seq)}`, {
        id: item.id,
        name: item.name,
        version: v.seq,
        url,
      });
    },
  );

  add(
    'share_artifact',
    {
      title: 'Share artifact',
      description:
        'Create a public, revocable link to an artifact you own. version: N freezes the link at that version (the one you rendered); pinVersion: true freezes it at the latest; otherwise it follows the latest. Needs the write scope.',
      inputSchema: { id, pinVersion: z.boolean().optional(), version: version.optional().describe('Pin the link to this version') },
    },
    (a) => {
      const denied = needWrite('share_artifact');
      if (denied) return denied;
      const item = editableArtifact(a.id);
      const share = createShare(ctx, p, item, { pinVersion: a.pinVersion, pinnedSeq: a.version });
      audit(c, p, { action: 'share.create', targetType: 'share', targetId: share.id, detail: { itemId: item.id, pinnedSeq: share.pinnedSeq, via: 'mcp' } });
      return ok(
        `Public link for '${item.title || item.name}'${share.pinnedSeq ? ` (pinned to v${share.pinnedSeq})` : ' (follows the latest version)'}: ${share.url}\nRaw page: ${share.rawUrl}\nAnyone with the link can view it; revoke it in SCP on the item page.`,
        { url: share.url, rawUrl: share.rawUrl, shareId: share.id },
      );
    },
  );
}
