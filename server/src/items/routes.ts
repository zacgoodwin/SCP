import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { reauthenticate, requireScope, requireUser } from '../auth/middleware.ts';
import { canReadGroup } from '../access.ts';
import { MB, badRequest, limitBody as limit, notFound, parseJson, parseQuery } from '../lib/http.ts';
import { LIMITS, tooLarge } from '../lib/tree.ts';
import { buildZip } from '../lib/zip.ts';
import { importUpload } from './import.ts';
import {
  addVersion,
  createItem,
  deleteItem,
  forkItem,
  isTextPath,
  itemDetail,
  loadEditableItem,
  loadReadableItem,
  readFile,
  readTree,
  resolveVersion,
  searchItems,
  updateItemMeta,
  versionDetail,
  versionSummary,
} from './service.ts';
import { FORMATS, KINDS, type AppEnv, type ItemRow, type Principal, type VersionRow } from '../types.ts';

/** These routes carry uploads and set their own limits; app.ts caps every other /api/v1 body at 1 MB. */
export const UPLOAD_ROUTES = /^\/api\/v1\/items(?:\/import(?:\/pack)?|\/[^/]+\/versions)?$/;

const fileIn = z.object({
  path: z.string().max(255),
  content: z.string().optional(),
  contentBase64: z.string().optional(),
  mode: z.union([z.literal(420), z.literal(493)]).optional(),
});
// Counted before any element is validated or decoded: a 45 MB body of a million tiny entries cost
// ~1 GB of heap and seconds before checkLimits. zod's .max() runs after the elements, so throw (413).
const filesIn = z.preprocess((v) => {
  if (Array.isArray(v) && v.length > LIMITS.files) throw tooLarge(`at most ${LIMITS.files} files per version`);
  return v;
}, z.array(fileIn));
const meta = {
  title: z.string().max(255).optional(),
  description: z.string().max(4096).optional(),
  category: z.string().max(64).optional(),
  tags: z.array(z.string()).optional(),
  visibility: z.enum(['private', 'public']).optional(),
};
// PATCH: null (or '') clears a text field.
const metaPatch = z.object({
  ...meta,
  title: z.string().max(255).nullish(),
  description: z.string().max(4096).nullish(),
  category: z.string().max(64).nullish(),
});
const createBody = z.object({
  ...meta,
  kind: z.enum(KINDS),
  name: z.string().optional(),
  format: z.enum(FORMATS).optional(),
  files: filesIn.optional(),
  content: z.string().optional(),
  note: z.string().max(1000).optional(),
});
const versionBody = z.object({ files: filesIn.optional(), content: z.string().optional(), note: z.string().max(1000).optional() });
const importFields = z.object({
  kind: z.enum(KINDS).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  name: z.string().optional(),
});
const listQuery = z.object({
  q: z.string().max(500).optional(),
  plane: z.enum(['skill', 'md', 'artifact']).optional(),
  kind: z.enum(KINDS).optional(),
  owner: z.literal('me').optional(),
  group: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

const ctxOf = (c: Context<AppEnv>) => c.var.ctx;
const itemAudit = (c: Context<AppEnv>, action: string, item: ItemRow, detail: Record<string, unknown> = {}) =>
  audit(c, c.var.principal, { action, targetType: 'item', targetId: item.id, detail: { kind: item.kind, name: item.name, ...detail } });

export const itemRoutes = new Hono<AppEnv>();

/** ?group=<slug> filter shared by /items and /search; an unreadable group is a 404. */
function groupFilter(c: Context<AppEnv>, p: Principal, slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  const { db } = ctxOf(c);
  const g = db.prepare('SELECT id FROM scp_groups WHERE slug = ?').get(slug) as { id: string } | undefined;
  if (!g || !canReadGroup(db, p, g.id)) throw notFound('group');
  return g.id;
}

itemRoutes.get('/items', (c) => {
  const p = requireUser(c);
  const q = parseQuery(c, listQuery);
  const groupId = groupFilter(c, p, q.group);
  return c.json(searchItems(ctxOf(c).db, p, { ...q, groupId, ownerId: q.owner === 'me' ? p.userId : undefined }));
});

itemRoutes.get('/search', (c) => {
  const p = requireUser(c);
  const q = parseQuery(c, listQuery);
  const groupId = groupFilter(c, p, q.group);
  const { items } = searchItems(ctxOf(c).db, p, { ...q, groupId, ownerId: q.owner === 'me' ? p.userId : undefined });
  return c.json({ results: items });
});

itemRoutes.post('/items', limit(45 * MB), async (c) => {
  requireScope(requireUser(c), 'write');
  const body = await parseJson(c, createBody);
  const p = reauthenticate(c);
  const item = createItem(ctxOf(c), p, body);
  itemAudit(c, 'item.create', item);
  return c.json({ item: itemDetail(ctxOf(c).db, p, item) }, 201);
});

itemRoutes.post('/items/import', limit(35 * MB), async (c) => {
  requireScope(requireUser(c), 'write');
  const form = await c.req.parseBody();
  const p = reauthenticate(c);
  const file = form.file;
  if (!(file instanceof File)) throw badRequest("multipart field 'file' is required");
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const fields = importFields.safeParse({ kind: str(form.kind), visibility: str(form.visibility), name: str(form.name) });
  if (!fields.success) throw badRequest('invalid fields', fields.error.issues);
  const item = importUpload(ctxOf(c), p, { ...fields.data, filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  itemAudit(c, 'item.create', item, { via: 'import' });
  return c.json({ item: itemDetail(ctxOf(c).db, p, item) }, 201);
});

itemRoutes.get('/items/:id', (c) => {
  const p = requireUser(c);
  const { db } = ctxOf(c);
  const item = loadReadableItem(db, p, c.req.param('id'));
  return c.json({ item: itemDetail(db, p, item, parseQuery(c, versionQuery).version) });
});

itemRoutes.patch('/items/:id', async (c) => {
  const p = requireUser(c);
  const { db } = ctxOf(c);
  const item = loadEditableItem(db, p, c.req.param('id'));
  const patch = await parseJson(c, metaPatch);
  const next = updateItemMeta(ctxOf(c), p, item, patch);
  itemAudit(c, 'item.update', next, { fields: Object.keys(patch) });
  return c.json({ item: itemDetail(db, p, next) });
});

itemRoutes.delete('/items/:id', (c) => {
  const p = requireUser(c);
  const item = loadEditableItem(ctxOf(c).db, p, c.req.param('id'));
  deleteItem(ctxOf(c), p, item);
  itemAudit(c, 'item.delete', item);
  return c.body(null, 204);
});

itemRoutes.post('/items/:id/versions', limit(45 * MB), async (c) => {
  const { db } = ctxOf(c);
  const item = loadEditableItem(db, requireUser(c), c.req.param('id'));
  const body = await parseJson(c, versionBody);
  const p = reauthenticate(c);
  const v = addVersion(ctxOf(c), p, item, body);
  const next = loadReadableItem(db, p, item.id);
  itemAudit(c, 'item.version', next, { seq: v.seq });
  return c.json({ item: itemDetail(db, p, next) }, 201);
});

itemRoutes.get('/items/:id/versions', (c) => {
  const p = requireUser(c);
  const { db } = ctxOf(c);
  const item = loadReadableItem(db, p, c.req.param('id'));
  const rows = db.prepare('SELECT * FROM item_versions WHERE item_id = ? ORDER BY seq DESC').all(item.id) as unknown as VersionRow[];
  return c.json({ versions: rows.map(versionSummary) });
});

itemRoutes.get('/items/:id/versions/:seq', (c) => {
  const p = requireUser(c);
  const { db } = ctxOf(c);
  const item = loadReadableItem(db, p, c.req.param('id'));
  const seq = Number(c.req.param('seq'));
  if (!Number.isInteger(seq) || seq < 1) throw notFound('version');
  return c.json({ version: versionDetail(db, resolveVersion(db, item, seq)) });
});

// App origin: raw bytes are never served as active content (text/plain or octet-stream + sandbox CSP).
itemRoutes.get('/items/:id/files/*', (c) => {
  const p = requireUser(c);
  const { db } = ctxOf(c);
  const item = loadReadableItem(db, p, c.req.param('id'));
  const v = resolveVersion(db, item, parseQuery(c, versionQuery).version);
  const m = /\/items\/[^/]+\/files\/(.+)$/.exec(new URL(c.req.url).pathname);
  let path: string;
  try {
    path = decodeURIComponent(m?.[1] ?? '');
  } catch {
    throw badRequest('malformed path');
  }
  const f = readFile(db, v.id, path);
  if (!f) throw notFound('file');
  const etag = `"${f.sha256}"`;
  const headers: Record<string, string> = {
    'Content-Type': isTextPath(path) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-cache',
    ETag: etag,
  };
  if (c.req.query('download') === '1') {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.slice(path.lastIndexOf('/') + 1))}`;
  }
  const inm = c.req.header('if-none-match');
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) return c.body(null, 304, headers);
  return c.body(f.bytes as Uint8Array<ArrayBuffer>, 200, headers);
});

itemRoutes.get('/items/:id/download.zip', (c) => {
  const p = requireUser(c);
  const { db } = ctxOf(c);
  const item = loadReadableItem(db, p, c.req.param('id'));
  const v = resolveVersion(db, item, parseQuery(c, versionQuery).version);
  const zip = buildZip(readTree(db, v.id).map((f) => ({ ...f, path: `${item.name}/${f.path}` })));
  return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${item.name}.zip"`,
    'X-Content-Type-Options': 'nosniff',
  });
});

itemRoutes.post('/items/:id/fork', (c) => {
  const p = requireUser(c);
  const { db } = ctxOf(c);
  const src = loadReadableItem(db, p, c.req.param('id'));
  const { version } = parseQuery(c, versionQuery);
  const item = forkItem(ctxOf(c), p, src, version);
  itemAudit(c, 'item.fork', item, { from: src.id, seq: version ?? src.latest_seq });
  return c.json({ item: itemDetail(db, p, item) }, 201);
});
