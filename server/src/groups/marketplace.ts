import { Hono, type Context } from 'hono';
import { audit } from '../audit.ts';
import { principalFromKey } from '../auth/middleware.ts';
import type { Db } from '../db.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { notFound } from '../lib/http.ts';
import { AUTH_LIMITS, rateLimited, take } from '../lib/ratelimit.ts';
import { buildPlugin, executableOf, flaggedDescription, pluginProblem, pluginVersion, type PluginBuild } from './bundle.ts';
import { listOwnGroups, loadReadableGroup, pluginMembers, resolvedMembers } from './service.ts';
import type { AppEnv, GroupRow, Principal } from '../types.ts';

// ponytail: per-process LRU of built plugins keyed by everything the bytes depend on; a second
// process rebuilds its own. Shared across tokens is impossible: .mcp.json carries the token.
// Bounded by entries and by total zip bytes: one entry can be a 100 MB plugin.
const CACHE_MAX = 200;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const cache = new Map<string, PluginBuild>();
let cacheBytes = 0;

/** The group's plugin.zip, built once per effective tree (and token / publicUrl / group row). */
export function pluginZip(db: Db, p: Principal, group: GroupRow, opts: { publicUrl: string; token: string }): PluginBuild {
  const members = resolvedMembers(db, p, group);
  const key = sha256Hex(
    JSON.stringify([
      opts.publicUrl,
      opts.token,
      group.slug,
      group.description,
      group.updated_at,
      members.map((m) => [m.item.id, m.item.kind, m.item.name, m.version.id, m.version.tree_sha256, m.version.entry_path]),
    ]),
  );
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // re-insert: Map iteration order is insertion order, so the oldest is first
    cache.set(key, hit);
    return hit;
  }
  const built = buildPlugin(db, group, members, opts);
  cache.set(key, built);
  cacheBytes += built.zip.length;
  while (cache.size > CACHE_MAX || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value!;
    cacheBytes -= cache.get(oldest)!.zip.length;
    cache.delete(oldest);
  }
  return built;
}

/** The token in the path is an API key (read scope); anything else is a plain 404. */
function principalFor(c: Context<AppEnv>, token: string): Principal {
  const p = principalFromKey(c, token);
  if (!p) throw notFound('route');
  return p;
}

export const pluginZipHeaders = (slug: string) => ({
  'Content-Type': 'application/zip',
  'Content-Disposition': `attachment; filename="${slug}-plugin.zip"`,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-cache',
});

/** D5 (docs/PLAN-v2.md): a Claude Code plugin marketplace on the app root, the API key in the path, no cookies. */
export const marketplaceRoutes = new Hono<AppEnv>();

// The key is in the URL, so a leaked link replays at wire speed, and the listing walks every member of
// every group: one bucket per key (`claude plugin update` is one listing plus one zip per plugin).
marketplaceRoutes.use('/m/:token/*', async (c, next) => {
  if (!take(c, `marketplace:${sha256Hex(c.req.param('token') ?? '')}`, AUTH_LIMITS.marketplace)) throw rateLimited('marketplace requests');
  await next();
});

marketplaceRoutes.get('/m/:token/marketplace.json', (c) => {
  const token = c.req.param('token');
  const p = principalFor(c, token);
  const { db, config } = c.var.ctx;
  // The principal's own, shared-by-name and picked groups (never strangers' public ones, which are
  // attacker-sized and still installable by slug), and nothing is zipped to list them: the version
  // comes from the effective members, and the archive sha256 pin is optional in the plugin format.
  const plugins = [];
  for (const g of listOwnGroups(db, p, 200)) {
    const { members, files } = pluginMembers(db, p, g);
    // A group whose plugin.zip would be refused (too many files, too large, two members at one path) is left out.
    if (pluginProblem(members, files)) continue;
    // mc52: Claude Code ignores an entry key it does not know, so `executable` rides along for any other reader; the description says it to everyone.
    const executable = executableOf(members);
    plugins.push({
      name: g.slug,
      description: flaggedDescription(executable, g.description),
      version: pluginVersion(g, members),
      source: { source: 'archive', url: `${config.publicUrl}/m/${token}/${g.slug}/plugin.zip` },
      executable,
    });
  }
  return c.json(
    { name: `scp-${p.username}`, owner: { name: p.username }, metadata: { description: `SCP groups of ${p.username}` }, plugins },
    200,
    { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  );
});

marketplaceRoutes.get('/m/:token/:slug/plugin.zip', (c) => {
  const token = c.req.param('token');
  const p = principalFor(c, token);
  const { db, config } = c.var.ctx;
  const g = loadReadableGroup(db, p, c.req.param('slug'));
  const build = pluginZip(db, p, g, { publicUrl: config.publicUrl, token });
  audit(c, p, { action: 'bundle.download', targetType: 'group', targetId: g.id, detail: { slug: g.slug, target: 'plugin', items: build.items } });
  return c.body(build.zip as Uint8Array<ArrayBuffer>, 200, pluginZipHeaders(g.slug));
});
