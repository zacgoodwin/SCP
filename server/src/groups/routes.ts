import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireAccountUser, requireUser } from '../auth/middleware.ts';
import { HttpError, parseJson, parseQuery } from '../lib/http.ts';
import { INSTALL_SCOPES, TARGETS, buildBundle, buildManifest, catalogMarkdown } from './bundle.ts';
import {
  addMemberTx,
  createGroup,
  deleteGroup,
  groupDetail,
  listReadableGroups,
  loadEditableGroup,
  loadReadableGroup,
  ownStats,
  removeMember,
  replaceMembers,
  updateGroup,
} from './service.ts';
import type { AppEnv, GroupRow } from '../types.ts';

const fields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(20000).optional(),
  tags: z.array(z.string()).optional(),
  visibility: z.enum(['private', 'shared', 'public']).optional(),
  sharedWith: z.array(z.string()).max(500).optional(),
};
const createBody = z.object({ slug: z.string().max(100), ...fields });
const patchBody = z.object({ ...fields, name: fields.name.optional(), slug: z.string().optional() });
const memberIn = z.object({
  itemId: z.string().min(1),
  pinnedSeq: z.number().int().nullable().optional(),
  installAs: z.string().nullable().optional(),
});
const membersBody = z.object({ members: z.array(memberIn).max(1000) });
const listQuery = z.object({
  q: z.string().max(500).optional(),
  owner: z.literal('me').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const installQuery =z.object({ target: z.enum(TARGETS).default('claude-code'), scope: z.enum(INSTALL_SCOPES).default('project') });

const groupAudit = (c: Context<AppEnv>, action: string, g: GroupRow, detail: Record<string, unknown> = {}) =>
  audit(c, c.var.principal, { action, targetType: 'group', targetId: g.id, detail: { slug: g.slug, ...detail } });

const detail = (c: Context<AppEnv>, slug: string) => {
  const p = requireUser(c);
  const { db, config } = c.var.ctx;
  return { group: groupDetail(db, p, loadReadableGroup(db, p, slug), config.publicUrl) };
};

export const groupRoutes = new Hono<AppEnv>();

groupRoutes.get('/groups', (c) => {
  const p = requireUser(c);
  const q = parseQuery(c, listQuery);
  return c.json(listReadableGroups(c.var.ctx.db, p, { ...q, ownerId: q.owner === 'me' ? p.userId : undefined }));
});

groupRoutes.post('/groups', async (c) => {
  const p = requireUser(c);
  const body = await parseJson(c, createBody);
  const g = createGroup(c.var.ctx, p, body);
  groupAudit(c, 'group.create', g);
  return c.json(detail(c, g.slug), 201);
});

groupRoutes.get('/groups/:slug', (c) => c.json(detail(c, c.req.param('slug'))));

groupRoutes.patch('/groups/:slug', async (c) => {
  const p = requireUser(c);
  const g = loadEditableGroup(c.var.ctx.db, p, c.req.param('slug'));
  const { slug, ...patch } = await parseJson(c, patchBody);
  if (slug !== undefined && slug.trim().toLowerCase() !== g.slug.toLowerCase()) {
    throw new HttpError(400, 'slug_immutable', 'a group slug cannot be changed; create a new group instead');
  }
  updateGroup(c.var.ctx, p, g, patch);
  groupAudit(c, 'group.update', g, { fields: Object.keys(patch) });
  return c.json(detail(c, g.slug));
});

groupRoutes.delete('/groups/:slug', (c) => {
  const p = requireUser(c);
  const g = loadEditableGroup(c.var.ctx.db, p, c.req.param('slug'));
  deleteGroup(c.var.ctx, p, g);
  groupAudit(c, 'group.delete', g);
  return c.body(null, 204);
});

groupRoutes.put('/groups/:slug/members', async (c) => {
  const p = requireUser(c);
  const g = loadEditableGroup(c.var.ctx.db, p, c.req.param('slug'));
  const { members } = await parseJson(c, membersBody);
  replaceMembers(c.var.ctx, p, g, members);
  groupAudit(c, 'group.members', g, { op: 'replace', count: members.length });
  return c.json(detail(c, g.slug));
});

groupRoutes.post('/groups/:slug/members', async (c) => {
  const p = requireUser(c);
  const g = loadEditableGroup(c.var.ctx.db, p, c.req.param('slug'));
  const m = await parseJson(c, memberIn);
  addMemberTx(c.var.ctx, p, g, m);
  groupAudit(c, 'group.members', g, { op: 'add', itemId: m.itemId });
  return c.json(detail(c, g.slug), 201);
});

groupRoutes.delete('/groups/:slug/members/:itemId', (c) => {
  const p = requireUser(c);
  const g = loadEditableGroup(c.var.ctx.db, p, c.req.param('slug'));
  removeMember(c.var.ctx, p, g, c.req.param('itemId'));
  groupAudit(c, 'group.members', g, { op: 'remove', itemId: c.req.param('itemId') });
  return c.json(detail(c, g.slug));
});

groupRoutes.get('/groups/:slug/manifest', (c) => {
  const p = requireUser(c);
  const { db } = c.var.ctx;
  const g = loadReadableGroup(db, p, c.req.param('slug'));
  return c.json(buildManifest(db, p, g, parseQuery(c, installQuery)));
});

groupRoutes.get('/groups/:slug/bundle.zip', (c) => {
  const p = requireUser(c);
  const { db, config } = c.var.ctx;
  const g = loadReadableGroup(db, p, c.req.param('slug'));
  const q = parseQuery(c, installQuery);
  const { zip, lock } = buildBundle(db, p, g, { ...q, publicUrl: config.publicUrl });
  groupAudit(c, 'bundle.download', g, { target: q.target, scope: q.scope, items: lock.items.length });
  return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${g.slug}-${q.target}.zip"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-cache',
  });
});

groupRoutes.get('/groups/:slug/catalog.md', (c) => {
  const p = requireUser(c);
  const { db } = c.var.ctx;
  const g = loadReadableGroup(db, p, c.req.param('slug'));
  return c.body(catalogMarkdown(db, p, g), 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
});

groupRoutes.get('/stats', (c) => c.json(ownStats(c.var.ctx.db, requireAccountUser(c))));
