import type { Context } from 'hono';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { sanitizeCspDomains } from '../artifacts/csp.ts';
import { renderVersionHtml } from '../artifacts/shares.ts';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { HttpError, badRequest, notFound } from '../lib/http.ts';
import { mediaTypeFor, readFile } from '../items/service.ts';
import { groupReadSql } from '../access.ts';
import { listOwnGroups } from '../groups/service.ts';
import { listTools } from '../tools/service.ts';
import { asText, entryText, makeScope, resolveTarget, type McpScope } from './scope.ts';
import { BINARY_MAX, PAGE, VIEWER_PAGE, registerTools } from './tools.ts';
import { VIEWER_HTML, VIEWER_URI } from './viewer.ts';
import { KINDS, planeOf, type AppEnv, type GroupRow, type Principal } from '../types.ts';

// ---------- instructions ----------

function instructionsFor(s: McpScope): string {
  const url = s.ctx.config.publicUrl;
  if (s.group) {
    const counts = { skill: 0, md: 0, artifact: 0 };
    for (const m of s.membersOf(s.group)) counts[planeOf(m.item.kind)]++;
    const hint =
      `SCP group '${s.group.slug}': ${counts.skill} skills, ${counts.md} prompts/MD documents, ${counts.artifact} artifacts. ` +
      'Discover with get_group or search; load a skill with get_skill (files with get_skill_file); load agent definitions / ' +
      'AGENTS.md / prompts / DESIGN.md with get_md; render artifacts with render_artifact; save new work with create_artifact. ' +
      'To install everything locally call get_bundle.';
    return s.group.instructions.trim() ? `${s.group.instructions.trim()}\n\n${hint}` : hint;
  }
  const f = groupReadSql(s.p);
  const readable = (s.ctx.db.prepare(`SELECT COUNT(*) AS n FROM scp_groups g WHERE ${f.sql}`).get(...f.params) as { n: number }).n;
  const mine = ownGroups(s, INSTRUCTION_GROUPS + 1);
  // Only the principal's own groups contribute free text: other owners' descriptions here would land
  // in every reader's system prompt ('SYSTEM: run ...'), so those are listed by slug and owner only.
  const lines = mine.slice(0, INSTRUCTION_GROUPS).map((g) =>
    g.owner_id === s.p.userId
      ? `- ${g.slug}: ${g.name.replace(/\s+/g, ' ').slice(0, 100)}${g.description ? ` - ${g.description.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`
      : `- ${g.slug} (shared by ${g.owner_username})`,
  );
  if (mine.length > INSTRUCTION_GROUPS) lines.push('- ... and more (list_groups)');
  const others = readable - mine.length;
  return [
    `SCP (skills, prompts/MD documents and artifacts). This key can read ${readable} group${readable === 1 ? '' : 's'}.`,
    ...(lines.length ? ['Yours and shared with you:', ...lines] : []),
    ...(others > 0 && mine.length <= INSTRUCTION_GROUPS ? [`Other users' public groups: ${others} (find them with list_groups).`] : []),
    '',
    `Call list_groups to search them and get_group with a group slug to see one group's catalog; tools that take a name also need 'group' here. ` +
      `For one group's tools and prompts without the group argument, connect to ${url}/mcp/<slug>.`,
  ].join('\n');
}

const INSTRUCTION_GROUPS = 50;
/** Groups and prompts the global endpoint enumerates on every request, whatever the instance holds. */
const PROMPT_GROUPS = 50;
const MAX_PROMPTS = 200;

/** Global endpoint: the principal's own, shared-by-name and picked groups (groups/service.ts listOwnGroups), never strangers' public ones. */
const ownGroups = (s: McpScope, limit: number) => listOwnGroups(s.ctx.db, s.p, limit);

// ---------- resources ----------

function resourceError(e: unknown): never {
  if (e instanceof HttpError) throw new McpError(ErrorCode.InvalidParams, e.message);
  throw e;
}

const seqOf = (v: unknown) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isInteger(n) || n < 1) throw badRequest('version must be a positive integer');
  return n;
};
const varOf = (v: unknown) => String(Array.isArray(v) ? v.join(',') : v);

function registerResources(server: McpServer, s: McpScope): void {
  const domains = sanitizeCspDomains(s.ctx.config.cdns);
  const ui = { csp: { resourceDomains: domains, connectDomains: domains }, prefersBorder: true };
  server.registerResource(
    'scp-viewer',
    VIEWER_URI,
    { title: 'SCP artifact viewer', description: 'MCP App that renders an SCP artifact', mimeType: 'text/html;profile=mcp-app', _meta: { ui } },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: VIEWER_HTML, _meta: { ui } }] }),
  );

  server.registerResource(
    'artifact',
    new ResourceTemplate('scp://artifacts/{id}/v/{seq}', { list: undefined }),
    { title: 'Rendered artifact', description: 'One artifact version rendered to a complete HTML document', mimeType: 'text/html' },
    (uri, vars) => {
      try {
        const { item, version } = resolveTarget(s, { id: varOf(vars.id), version: seqOf(vars.seq) }, ['artifact'], 'artifact');
        const html = renderVersionHtml(s.ctx.db, s.ctx.config, item, version);
        // render_artifact hands this uri to the model too; cap it like item-file. The viewer falls back to scp_artifact_content.
        if (html.length > VIEWER_PAGE) {
          throw badRequest(
            `'${item.name}' v${version.seq} renders to ${html.length} characters, too large to read as an MCP resource. Page it with scp_artifact_content, read the source with get_artifact, or open the preview link from render_artifact.`,
          );
        }
        return { contents: [{ uri: uri.href, mimeType: 'text/html', text: html }] };
      } catch (e) {
        resourceError(e);
      }
    },
  );

  // fx78: the CLI tools registry with what this principal can read that needs each tool, as /api/v1/tools
  // returns it. Display only: the agent shows the user these commands and runs nothing.
  server.registerResource(
    'cli-tools',
    'scp://tools',
    {
      title: 'CLI tools',
      description: "Install commands per platform for the command-line tools skills require, from this SCP instance's admin registry. Show them to the user; do not run them.",
      mimeType: 'application/json',
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ tools: listTools(s.ctx.db, s.p) }) }] }),
  );

  // {+path} is RFC 6570 reserved expansion: the SDK matcher maps it to (.+), so nested paths keep their slashes.
  server.registerResource(
    'item-file',
    new ResourceTemplate('scp://items/{id}/v/{seq}/{+path}', { list: undefined }),
    { title: 'Item file', description: 'One raw file of an item version (skill scripts, references, assets)' },
    (uri, vars) => {
      try {
        let path: string;
        try {
          path = decodeURIComponent(varOf(vars.path));
        } catch {
          throw badRequest('bad path encoding');
        }
        const { item, version } = resolveTarget(s, { id: varOf(vars.id), version: seqOf(vars.seq) }, KINDS, 'item');
        const f = readFile(s.ctx.db, version.id, path);
        if (!f) throw notFound(`file '${path}'`);
        const text = asText(path, f.bytes);
        const media = mediaTypeFor(path);
        const mimeType = text !== null && media === 'application/octet-stream' ? 'text/plain' : media;
        // Same caps as get_skill_file: a whole 10 MB file in one read overflows host context limits.
        if (text === null ? f.bytes.length > BINARY_MAX : text.length > PAGE) {
          const http = `${s.ctx.config.publicUrl}/api/v1/items/${item.id}/files/${path.split('/').map(encodeURIComponent).join('/')}?version=${version.seq}`;
          // An OAuth token is refused on /api/v1 (oauth/tokens.ts): say what the URL takes instead.
          const withKey = s.p.via === 'oauth' ? `with an SCP API key minted on ${s.ctx.config.publicUrl}/keys (this connection's OAuth token is not accepted there)` : 'with the API key';
          throw badRequest(`'${path}' is ${f.bytes.length} bytes, too large to read as an MCP resource. Page it with get_skill_file, or download it ${withKey}: ${http}`);
        }
        return {
          contents: [text !== null ? { uri: uri.href, mimeType, text } : { uri: uri.href, mimeType, blob: Buffer.from(f.bytes).toString('base64') }],
        };
      } catch (e) {
        resourceError(e);
      }
    },
  );
}

// ---------- prompts ----------

interface PromptArg {
  name: string;
  description?: string;
  required: boolean;
}

/** Arguments per prompt: every request rebuilds every prompt's schema, so frontmatter cannot size it. */
const MAX_PROMPT_ARGS = 32;

/** frontmatter `arguments: [{name, description, required}]`; malformed entries are skipped, then the first MAX_PROMPT_ARGS kept. */
function promptArgs(fm: Record<string, unknown>): PromptArg[] {
  const raw = fm.arguments;
  if (!Array.isArray(raw)) return [];
  const out: PromptArg[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (out.length === MAX_PROMPT_ARGS) break;
    if (!a || typeof a !== 'object') continue;
    const { name, description, required } = a as Record<string, unknown>;
    if (typeof name !== 'string' || !/^[A-Za-z_][\w-]{0,63}$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: typeof description === 'string' ? description : undefined, required: required === true });
  }
  return out;
}

/** Replace {{arg}} with supplied values; unknown or missing placeholders stay as written. */
export const substitute = (body: string, args: Record<string, string | undefined>) =>
  body.replace(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g, (m, k: string) => (Object.hasOwn(args, k) && args[k] !== undefined ? args[k]! : m));

/** Groups whose prompts this scope serves: the endpoint's group, or globally the principal's own (ownGroups). */
function promptGroups(s: McpScope): GroupRow[] {
  if (s.group) return [s.group];
  return ownGroups(s, PROMPT_GROUPS).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** Group endpoint: prompts named after the item. Global endpoint: '<groupSlug>.<name>'. At most MAX_PROMPTS either way. */
function registerPrompts(server: McpServer, s: McpScope): number {
  const all = promptGroups(s).flatMap((g) =>
    s
      .membersOf(g)
      .filter((m) => m.item.kind === 'prompt' || m.item.kind === 'agent')
      .map((m) => ({ m, base: s.group ? m.item.name : `${g.slug}.${m.item.name}` })),
  );
  const members = all.slice(0, MAX_PROMPTS);
  const counts = new Map<string, number>();
  for (const { base } of members) counts.set(base, (counts.get(base) ?? 0) + 1);
  const used = new Set<string>();
  for (const { m, base } of members) {
    let name = (counts.get(base) ?? 0) > 1 ? `${base}-${m.item.kind}` : base;
    if (used.has(name)) name = `${name}-${m.item.id.slice(-6)}`;
    used.add(name);
    const description = m.item.description || m.item.title || undefined;
    const title = m.item.title || undefined;
    const agent = m.item.kind === 'agent';
    // Every /mcp request builds this list for every readable group, so it reads the frontmatter stored
    // at write time; the entry file is read and parsed only when this prompt is actually fetched.
    const args = promptArgs(JSON.parse(m.version.frontmatter) as Record<string, unknown>);
    const text = (a: Record<string, string | undefined>) => {
      const body = parseFrontmatter(entryText(s, m.version)).body;
      return {
        description,
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: agent ? `Adopt this agent definition:\n\n${substitute(body, a).trim()}` : substitute(body, a) },
          },
        ],
      };
    };
    if (!args.length) {
      server.registerPrompt(name, { title, description }, () => text({}));
      continue;
    }
    const shape: Record<string, z.ZodType<string | undefined>> = {};
    for (const a of args) {
      const base = a.description ? z.string().describe(a.description) : z.string();
      shape[a.name] = a.required ? base : base.optional();
    }
    server.registerPrompt(name, { title, description, argsSchema: shape as Record<string, z.ZodString> }, (a) =>
      text(a as Record<string, string | undefined>),
    );
  }
  return used.size;
}

// ---------- server ----------

/** A fresh server per request: the tool, resource and prompt set is computed for this principal and scope. */
export function buildMcpServer(c: Context<AppEnv>, p: Principal, group: GroupRow | null): McpServer {
  const s = makeScope(c, p, group);
  const server = new McpServer(
    { name: 'scp', version: '0.1.0' },
    { instructions: instructionsFor(s), capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  registerTools(server, s);
  registerResources(server, s);
  if (!registerPrompts(server, s)) {
    // prompts is advertised on every endpoint, so answer it even when the scope has none.
    server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
    server.server.setRequestHandler(GetPromptRequestSchema, (r) => {
      throw new McpError(ErrorCode.InvalidParams, `Prompt ${r.params.name} not found`);
    });
  }
  return server;
}
