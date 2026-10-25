import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { fileImportMb, importLimit } from '../admin/settings.ts';
import { audit } from '../audit.ts';
import { reauthenticate, requireScope, requireUser } from '../auth/middleware.ts';
import { groupDetail, loadEditableGroupOr404 } from '../groups/service.ts';
import { itemDetail, itemSource, loadEditableItem } from '../items/service.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { HttpError, MB, badRequest, limitBody as limit, notFound, parseJson } from '../lib/http.ts';
import { normalizePath } from '../lib/paths.ts';
import { AUTH_LIMITS, rateLimited, spend, take } from '../lib/ratelimit.ts';
import type { TreeFile } from '../lib/tree.ts';
import { KINDS, type AppEnv, type GroupRow, type ItemRow, type ItemSource, type Principal } from '../types.ts';
import { SHA_REF, archiveTooLarge, badSource, fetchFolder, fetchZipball, parseGithubSource, resolveCommit, withZipballSlot } from './github.ts';
import {
  ARTIFACT_FROM_TREE,
  FOLDER_KINDS,
  editSupplied,
  fileRootName,
  importTree,
  linkSkips,
  packLimits,
  subtree,
  underPath,
  unpack,
  updateTree,
  versionFromSource,
  type ImportOutcome,
  type Skipped,
} from './pack.ts';

const isTreePath = (k: string) => {
  try {
    return !k || !!normalizePath(k);
  } catch {
    return false;
  }
};
/** mvfp: folder -> kind, '' the root; a path escaping the tree (../x, /abs) is a 400. The pack form sends it as JSON text. */
const folderKinds = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  },
  z
    .record(z.string().refine(isTreePath, 'a folder path inside the tree (no ../, no leading /)'), z.enum(FOLDER_KINDS))
    .refine((m) => Object.keys(m).length <= 100, 'at most 100 folders'),
);
const description = z
  .string()
  .trim()
  .max(1024)
  .transform((s) => s || undefined);
// An empty slug is a 400, never "absent" (intoGroupOf tests truthiness); the pack form maps '' to absent before parsing.
const groupFields = {
  visibility: z.enum(['private', 'public']).optional(),
  group: z.string().min(1).max(100).optional(),
  groupName: z.string().trim().min(1).max(100).optional(),
  intoGroup: z.string().min(1).max(100).optional(),
  kind: z.enum(KINDS).optional(),
  folderKinds: folderKinds.optional(),
  onNameClash: z.enum(['skip', 'prefix']).optional(),
  frontmatterErrors: z.enum(['ask', 'import', 'skip']).optional(),
  // jcfm: capped at lint's description limit; blank is none.
  description: description.optional(),
};
const packFields = z.object({ ...groupFields, includeRepoTooling: z.enum(['true', 'false']).optional() });
const githubBody = z.object({
  ...groupFields,
  includeRepoTooling: z.boolean().optional(),
  url: z.string().max(2000).optional(),
  repo: z.string().max(201).optional(),
  ref: z.string().max(200).optional(),
  path: z.string().max(255).optional(),
  name: z.string().max(64).optional(),
});
const updateBody = z.object({ note: z.string().max(1000).optional() });
const suppliedBody = z.object({ description: z.string().trim().min(1).max(1024) });

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
 * A folder fetched file by file (a4q8) then spends one token per call it makes, into debt if need be.
 */
function limitGithub(c: Context<AppEnv>, p: Principal): void {
  if (!take(c, `github:${p.userId}`, AUTH_LIMITS.github)) throw rateLimited('GitHub requests');
}

/**
 * repo@sha at or under `path`: repository-relative files, and what was passed over (links, submodules)
 * re-rooted at `path`. The zipball, inflating only the folder; over the archive cap, a whole repository
 * is a 413 and a folder is fetched file by file instead (a4q8, github.ts fetchFolder).
 */
async function download(c: Context<AppEnv>, p: Principal, repo: string, sha: string, path: string | null): Promise<{ files: TreeFile[]; skipped: Skipped[] }> {
  const ctx = c.var.ctx;
  const zip = await fetchZipball(ctx, repo, sha);
  if (zip) {
    const { files, links } = unpack(zip, underPath(path), packLimits(ctx));
    return { files, skipped: linkSkips(subtree(links, path)) };
  }
  if (path === null) throw archiveTooLarge(ctx);
  const { files, links, submodules } = await fetchFolder(ctx, repo, sha, path, (calls) => spend(c, `github:${p.userId}`, AUTH_LIMITS.github, calls));
  const subs = subtree(submodules, path).map((s) => ({ path: s.path, reason: `submodule at ${short(s.sha)}, not imported` }));
  return { files, skipped: [...linkSkips(subtree(links, path)), ...subs] };
}

/**
 * p2wf: the existing group an import adds every item to. Exclusive with `group` (which creates one);
 * one p cannot edit is a 404 like one it cannot read.
 */
function intoGroupOf(c: Context<AppEnv>, p: Principal, body: { group?: string; intoGroup?: string }): GroupRow | undefined {
  if (!body.intoGroup) return undefined;
  if (body.group) throw badRequest('give group (a new group) or intoGroup (an existing one), not both');
  return loadEditableGroupOr404(c.var.ctx.db, p, body.intoGroup);
}

/** The pack upload's body cap is the archive cap (00tr), read per request. */
const archiveBody: MiddlewareHandler<AppEnv> = (c, next) => limit(importLimit(c.var.ctx, 'maxArchiveMb') * MB)(c, next);

/** Audit each unit and the group, then the ImportResult. Runs after the import transaction committed. */
function respond(c: Context<AppEnv>, p: Principal, out: ImportOutcome, source: ItemSource) {
  const { db, config } = c.var.ctx;
  const via = source.kind;
  for (const r of out.results) {
    const detail = { kind: r.item.kind, name: r.item.name, via, repo: source.repo };
    if (r.op === 'create') audit(c, p, { action: 'item.create', targetType: 'item', targetId: r.item.id, detail });
    else if (r.op === 'version') audit(c, p, { action: 'item.version', targetType: 'item', targetId: r.item.id, detail: { ...detail, seq: r.item.latest_seq, commit: source.commit } });
  }
  if (out.group && out.groupCreated) audit(c, p, { action: 'group.create', targetType: 'group', targetId: out.group.id, detail: { slug: out.group.slug, via } });
  else if (out.group && out.added) audit(c, p, { action: 'group.members', targetType: 'group', targetId: out.group.id, detail: { slug: out.group.slug, op: 'import', count: out.added, via } });
  return c.json(
    {
      // op: create | version | unchanged, so a re-upload that wrote nothing does not read as N items created.
      items: out.results.map((r) => ({ ...itemDetail(db, p, r.item), op: r.op })),
      group: out.group ? groupDetail(db, p, out.group, config.publicUrl) : null,
      skipped: out.skipped,
      skippedFolders: out.skippedFolders,
      source,
    },
    201,
  );
}

/**
 * The effective upload and item caps, for any signed-in user: the Import dialog refuses an oversize
 * file before sending it, because a browser whose upload is cut off by the 413 (the body limit stops
 * reading) sees a connection reset, not the answer. The settings route stays admin-only.
 */
importRoutes.get('/imports/limits', (c) => {
  requireUser(c);
  const ctx = c.var.ctx;
  return c.json({ maxItems: importLimit(ctx, 'maxItems'), maxArchiveMb: importLimit(ctx, 'maxArchiveMb'), maxPackMb: importLimit(ctx, 'maxPackMb'), maxFileMb: fileImportMb(ctx) });
});

importRoutes.post('/items/import/pack', archiveBody, async (c) => {
  requireImporter(c);
  const form = await c.req.parseBody();
  const p = reauthenticate(c);
  const file = form.file;
  if (!(file instanceof File)) throw badRequest("multipart field 'file' is required");
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const fields = packFields.safeParse(Object.fromEntries(Object.keys(packFields.shape).map((k) => [k, str(form[k])])));
  if (!fields.success) throw badRequest('invalid fields', fields.error.issues);
  const { includeRepoTooling, intoGroup: slug, ...opts } = fields.data;
  const intoGroup = intoGroupOf(c, p, { group: opts.group, intoGroup: slug });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = baseOf(file.name) || 'pack.zip';
  const { files, top, links } = unpack(bytes, undefined, packLimits(c.var.ctx));
  const zipName = name.replace(/\.(zip|skill)$/i, '');
  const source: ItemSource = { kind: 'zip', repo: name, ref: null, path: null, commit: sha256Hex(bytes) };
  // A stripped wrapper folder (`zip -r my-skill.zip my-skill/`) is one folder, so its SKILL.md is the whole folder's.
  const out = importTree(c.var.ctx, p, files, {
    ...opts,
    intoGroup,
    includeRepoTooling: includeRepoTooling === 'true',
    source,
    rootName: top ?? zipName,
    clashPrefix: zipName,
    folderRoot: top !== null,
    skipped: linkSkips(links),
    note: `import zip ${name}`,
  });
  return respond(c, p, out, source);
});

importRoutes.post('/items/import/github', async (c) => {
  const importer = requireImporter(c);
  const body = await parseJson(c, githubBody);
  // Refused before GitHub is asked anything: the request can never succeed (importTree keeps the check as the backstop).
  if (body.kind === 'artifact') throw badRequest(ARTIFACT_FROM_TREE);
  const src = parseGithubSource(body);
  const intoGroup = intoGroupOf(c, importer, body);
  limitGithub(c, importer);
  const ctx = c.var.ctx;
  // `repo` as GitHub spells it, whatever case the user typed: it identifies the items on re-import.
  const { repo, ref, sha } = await resolveCommit(ctx, importer, src.repo, src.ref);
  return withZipballSlot(async () => {
    const { files, skipped } = await download(c, importer, repo, sha, src.path);
    const pathIsFile = files.some((f) => f.path === src.path);
    const tree = subtree(files, src.path);
    if (!tree.length) throw badSource(`'${src.path}' holds no files in ${repo}@${short(sha)}`);
    // The archive can take up to a minute to arrive; the key may have been revoked meanwhile.
    const p = reauthenticate(c);
    const source: ItemSource = { kind: 'github', repo, ref, path: src.path, commit: sha };
    const repoName = repo.split('/')[1];
    const rootName = !src.path ? repoName : pathIsFile ? fileRootName(src.path, repoName, body.kind === 'skill') : baseOf(src.path);
    const out = importTree(ctx, p, tree, {
      source,
      rootName,
      layoutDir: src.path ? baseOf(src.path) : undefined,
      // A /tree/<ref>/<path> or /blob/.../SKILL.md import is one folder: its SKILL.md takes the folder, as under skills/ in a whole-repository import.
      folderRoot: !!src.path,
      pathIsFile,
      skipped,
      visibility: body.visibility,
      kind: body.kind,
      name: body.name,
      group: body.group,
      groupName: body.groupName,
      intoGroup,
      folderKinds: body.folderKinds,
      defaultGroupName: repo,
      includeRepoTooling: body.includeRepoTooling,
      onNameClash: body.onNameClash,
      clashPrefix: repoName,
      frontmatterErrors: body.frontmatterErrors,
      description: body.description,
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
    const { files, skipped } = await download(c, editor, repo, sha, item.source_path);
    const tree = subtree(files, item.source_path);
    if (!tree.length) throw badSource(`'${item.source_path}' no longer exists in ${repo}@${short(sha)}`);
    const p = reauthenticate(c);
    const source = { ...itemSource(item)!, commit: sha };
    const r = versionFromSource(ctx, p, item, updateTree(ctx.db, item, tree), source, body.note ?? `import github ${repo}@${short(sha)} ${item.source_path ?? ''}`.trimEnd());
    if (r.op === 'unchanged') throw upToDate();
    audit(c, p, { action: 'item.version', targetType: 'item', targetId: item.id, detail: { kind: item.kind, name: item.name, seq: r.item.latest_seq, via: 'github', commit: sha } });
    return c.json({ item: itemDetail(ctx.db, p, r.item), skipped });
  });
});

/** jcfm: edit the description SCP supplied on import (a new version while the supplied block is in use). */
importRoutes.put('/items/:id/source/frontmatter', async (c) => {
  const { db } = c.var.ctx;
  const item = loadEditableItem(db, requireUser(c), c.req.param('id'));
  const body = await parseJson(c, suppliedBody);
  const p = reauthenticate(c);
  const next = editSupplied(c.var.ctx, p, item, body.description);
  audit(c, p, { action: 'item.update', targetType: 'item', targetId: item.id, detail: { kind: item.kind, name: item.name, fields: ['suppliedFrontmatter'], seq: next.latest_seq } });
  return c.json({ item: itemDetail(db, p, next) });
});
