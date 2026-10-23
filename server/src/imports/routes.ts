import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { reauthenticate, requireScope, requireUser } from '../auth/middleware.ts';
import { groupDetail } from '../groups/service.ts';
import { itemDetail, itemSource, loadEditableItem } from '../items/service.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { HttpError, MB, badRequest, limitBody as limit, notFound, parseJson } from '../lib/http.ts';
import { AUTH_LIMITS, rateLimited, take } from '../lib/ratelimit.ts';
import { KINDS, type AppEnv, type ItemRow, type ItemSource, type Principal } from '../types.ts';
import { SHA_REF, badSource, fetchZipball, parseGithubSource, resolveCommit, withZipballSlot } from './github.ts';
import { ARTIFACT_FROM_TREE, importTree, linkSkips, subtree, underPath, unpack, updateTree, versionFromSource, type ImportOutcome } from './pack.ts';

const groupFields = {
  visibility: z.enum(['private', 'public']).optional(),
  group: z.string().max(100).optional(),
  groupName: z.string().trim().min(1).max(100).optional(),
};
const packFields = z.object(groupFields);
const githubBody = z.object({
  ...groupFields,
  url: z.string().max(2000).optional(),
  repo: z.string().max(201).optional(),
  ref: z.string().max(200).optional(),
  path: z.string().max(255).optional(),
  kind: z.enum(KINDS).optional(),
  name: z.string().max(64).optional(),
});
const updateBody = z.object({ note: z.string().max(1000).optional() });

const baseOf = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
const short = (sha: string) => sha.slice(0, 7);

/** D1 (docs/PLAN-v2.md): pack and GitHub imports, source check/update. Mounted under /api/v1. */
export const importRoutes = new Hono<AppEnv>();

/**
 * Who may import, checked before any body is parsed or anything is fetched: a group-restricted key
 * cannot (importTree repeats the check as the backstop), so it cannot burn the GitHub rate limit or
 * unzip 35 MB only to be refused.
 */
function requireImporter(c: Context<AppEnv>): Principal {
  const p = requireUser(c);
  requireScope(p, 'write');
  if (p.groupIds) throw new HttpError(403, 'restricted_key', 'a group-restricted API key cannot import items');
  return p;
}

/**
 * Every route that contacts GitHub spends 2-3 calls of the instance's one shared quota (its token, or
 * the egress IP for anonymous calls), so each user gets a bucket of their own before anything leaves.
 */
function limitGithub(c: Context<AppEnv>, p: Principal): void {
  if (!take(c, `github:${p.userId}`, AUTH_LIMITS.github)) throw rateLimited('GitHub requests');
}

/** Audit each unit and the group, then the ImportResult. Runs after the import transaction committed. */
function respond(c: Context<AppEnv>, p: Principal, out: ImportOutcome, source: ItemSource) {
  const { db, config } = c.var.ctx;
  const via = source.kind;
  for (const r of out.results) {
    const detail = { kind: r.item.kind, name: r.item.name, via, repo: source.repo };
    if (r.op === 'create') audit(c, p, { action: 'item.create', targetType: 'item', targetId: r.item.id, detail });
    else if (r.op === 'version') audit(c, p, { action: 'item.version', targetType: 'item', targetId: r.item.id, detail: { ...detail, seq: r.item.latest_seq, commit: source.commit } });
  }
  if (out.group) audit(c, p, { action: 'group.create', targetType: 'group', targetId: out.group.id, detail: { slug: out.group.slug, via } });
  return c.json(
    {
      // op: create | version | unchanged, so a re-upload that wrote nothing does not read as N items created.
      items: out.results.map((r) => ({ ...itemDetail(db, p, r.item), op: r.op })),
      group: out.group ? groupDetail(db, p, out.group, config.publicUrl) : null,
      skipped: out.skipped,
      source,
    },
    201,
  );
}

importRoutes.post('/items/import/pack', limit(35 * MB), async (c) => {
  requireImporter(c);
  const form = await c.req.parseBody();
  const p = reauthenticate(c);
  const file = form.file;
  if (!(file instanceof File)) throw badRequest("multipart field 'file' is required");
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const fields = packFields.safeParse({ visibility: str(form.visibility), group: str(form.group), groupName: str(form.groupName) });
  if (!fields.success) throw badRequest('invalid fields', fields.error.issues);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = baseOf(file.name) || 'pack.zip';
  const { files, top, links } = unpack(bytes);
  const rootName = top ?? name.replace(/\.(zip|skill)$/i, '');
  const source: ItemSource = { kind: 'zip', repo: name, ref: null, path: null, commit: sha256Hex(bytes) };
  // A stripped wrapper folder (`zip -r my-skill.zip my-skill/`) is one folder, so its SKILL.md is the whole folder's.
  const out = importTree(c.var.ctx, p, files, { ...fields.data, source, rootName, folderRoot: top !== null, skipped: linkSkips(links), groupName: fields.data.groupName ?? rootName, note: `import zip ${name}` });
  return respond(c, p, out, source);
});

importRoutes.post('/items/import/github', async (c) => {
  const importer = requireImporter(c);
  const body = await parseJson(c, githubBody);
  // Refused before GitHub is asked anything: the request can never succeed (importTree keeps the check as the backstop).
  if (body.kind === 'artifact') throw badRequest(ARTIFACT_FROM_TREE);
  const src = parseGithubSource(body);
  limitGithub(c, importer);
  const ctx = c.var.ctx;
  // `repo` as GitHub spells it, whatever case the user typed: it identifies the items on re-import.
  const { repo, ref, sha } = await resolveCommit(ctx, importer, src.repo, src.ref);
  return withZipballSlot(async () => {
    const { files, links } = unpack(await fetchZipball(ctx, repo, sha), underPath(src.path));
    const pathIsFile = files.some((f) => f.path === src.path);
    const tree = subtree(files, src.path);
    if (!tree.length) throw badSource(`'${src.path}' holds no files in ${repo}@${short(sha)}`);
    // The archive can take up to a minute to arrive; the key may have been revoked meanwhile.
    const p = reauthenticate(c);
    const source: ItemSource = { kind: 'github', repo, ref, path: src.path, commit: sha };
    const rootName = src.path ? baseOf(src.path) : repo.split('/')[1];
    const out = importTree(ctx, p, tree, {
      source,
      rootName,
      layoutDir: src.path ? rootName : undefined,
      // A /tree/<ref>/<path> or /blob/.../SKILL.md import is one folder: its SKILL.md takes the folder, as under skills/ in a whole-repository import.
      folderRoot: !!src.path,
      pathIsFile,
      skipped: linkSkips(subtree(links, src.path)),
      visibility: body.visibility,
      kind: body.kind,
      name: body.name,
      group: body.group,
      groupName: body.groupName ?? repo,
      note: `import github ${repo}@${short(sha)} ${src.path ?? ''}`.trimEnd(),
    });
    return respond(c, p, out, source);
  });
});

/** The GitHub provenance of an editable item; anything else is a 404 (no source to check). */
function githubItem(c: Context<AppEnv, '/items/:id/source/check' | '/items/:id/source/update'>): { p: Principal; item: ItemRow; repo: string; ref: string | null } {
  const p = requireUser(c);
  const item = loadEditableItem(c.var.ctx.db, p, c.req.param('id'));
  if (item.source_kind !== 'github' || !item.source_repo) throw notFound('source');
  return { p, item, repo: item.source_repo, ref: item.source_ref };
}

importRoutes.post('/items/:id/source/check', async (c) => {
  const { p, item, repo, ref } = githubItem(c);
  let latestCommit = item.source_commit;
  if (!(ref && SHA_REF.test(ref))) {
    limitGithub(c, p);
    latestCommit = (await resolveCommit(c.var.ctx, p, repo, ref)).sha;
  }
  const upToDate = latestCommit === item.source_commit;
  audit(c, p, { action: 'item.source_check', targetType: 'item', targetId: item.id, detail: { kind: item.kind, name: item.name, upToDate, latestCommit } });
  return c.json({ source: itemSource(item), upToDate, latestCommit });
});

importRoutes.post('/items/:id/source/update', async (c) => {
  const { p: editor, item, repo, ref } = githubItem(c);
  // The body is optional: an empty POST means "update, default note".
  const text = await c.req.text();
  const body = text.trim() ? await parseJson(c, updateBody) : {};
  const ctx = c.var.ctx;
  const upToDate = () => new HttpError(409, 'up_to_date', `'${item.name}' already matches ${repo}@${short(item.source_commit ?? '')}`);
  if (ref && SHA_REF.test(ref)) throw upToDate();
  limitGithub(c, editor);
  const { sha } = await resolveCommit(ctx, editor, repo, ref);
  // The same commit check reports as up to date: re-applying its tree would overwrite a local edit made since.
  if (sha === item.source_commit) throw upToDate();
  return withZipballSlot(async () => {
    const { files, links } = unpack(await fetchZipball(ctx, repo, sha), underPath(item.source_path));
    const tree = subtree(files, item.source_path);
    if (!tree.length) throw badSource(`'${item.source_path}' no longer exists in ${repo}@${short(sha)}`);
    const p = reauthenticate(c);
    const source = { ...itemSource(item)!, commit: sha };
    const r = versionFromSource(ctx, p, item, updateTree(ctx.db, item, tree), source, body.note ?? `import github ${repo}@${short(sha)} ${item.source_path ?? ''}`.trimEnd());
    if (r.op === 'unchanged') throw upToDate();
    audit(c, p, { action: 'item.version', targetType: 'item', targetId: item.id, detail: { kind: item.kind, name: item.name, seq: r.item.latest_seq, via: 'github', commit: sha } });
    return c.json({ item: itemDetail(ctx.db, p, r.item), skipped: linkSkips(subtree(links, item.source_path)) });
  });
});
