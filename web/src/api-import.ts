// D6 client for the D1 import endpoints (docs/PLAN-v2.md "D1 imports"). Shapes mirror that section.
import { ApiError, json, type GroupDetail, type ItemDetail, type ItemSource, type Kind, type Visibility } from './api.ts';

/** What the import did to the item: created it, added a version, or found it already at this content. */
export type ImportOp = 'create' | 'version' | 'unchanged';

/** A folder of loose .md files detection passed over; '' is the root. */
export interface SkippedFolder {
  path: string;
  count: number;
}

/** What `folderKinds` maps a folder to: each .md one item of that kind, or the folder one package. */
export type FolderKind = 'agent' | 'command' | 'prompt' | 'instructions' | 'design' | 'package';
export const FOLDER_KINDS: FolderKind[] = ['prompt', 'agent', 'command', 'instructions', 'design', 'package'];

export interface ImportResult {
  items: (ItemDetail & { op?: ImportOp })[];
  group: GroupDetail | null;
  /** prefixed: a name another source's item holds; the unit imports as this name with onNameClash 'prefix' (5ef6). */
  skipped: { path: string; reason: string; prefixed?: string }[];
  /** Folders to offer a kind for (re-import with folderKinds). */
  skippedFolders?: SkippedFolder[];
  source: ItemSource | null;
}

export interface ImportGroupOpts {
  visibility?: Visibility;
  /** Slug of a group to create with every imported item as a member. */
  group?: string;
  groupName?: string;
  /** Slug of an existing group the user can edit; every imported item joins it. Not with `group`. */
  intoGroup?: string;
  /** No detection: the tree is one item, or one item per .md for agent, command, prompt and instructions. */
  kind?: Kind;
  folderKinds?: Record<string, FolderKind>;
  /** A name another source's item holds: skip the unit (default) or import it as `<repo>-<name>`. */
  onNameClash?: 'skip' | 'prefix';
  /** Units whose only problem is their frontmatter: 'ask' (default, a 409 listing them), 'import' them anyway, or 'skip' them. */
  frontmatterErrors?: 'ask' | 'import' | 'skip';
}

/** The instance's caps (GET /imports/limits): admin settings, read by any signed-in user. */
export interface ImportLimits {
  maxItems: number;
  maxArchiveMb: number;
  maxPackMb: number;
  /** The File tab's body cap: the archive cap, at most 35 MB. */
  maxFileMb: number;
}

export const getImportLimits = () => json<ImportLimits>('GET', '/imports/limits');

/**
 * The server's own 413, raised before the upload starts: a browser whose body is cut off by that 413
 * sees a connection reset instead. A few KB are left for the multipart framing and form fields.
 */
export function refuseOversize(file: File, mb: number): void {
  if (file.size + 4096 > mb * 1024 * 1024) throw new ApiError(413, 'too_large', `request body is over ${mb} MB`);
}
/** A unit of a 409 `frontmatter_errors`: nothing was imported, the user picks import anyway, skip, or cancel. */
export interface FrontmatterUnit {
  path: string;
  kind: Kind;
  errors: string[];
}

export const frontmatterErrorsOf = (e: unknown): FrontmatterUnit[] | null =>
  e instanceof ApiError && e.code === 'frontmatter_errors' && Array.isArray(e.details) ? (e.details as FrontmatterUnit[]) : null;

export function importPack(file: File, opts: ImportGroupOpts = {}) {
  const fd = new FormData();
  fd.set('file', file);
  for (const [k, v] of Object.entries(opts)) if (v) fd.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return json<ImportResult>('POST', '/items/import/pack', fd);
}

export interface GithubImport extends ImportGroupOpts {
  url?: string;
  repo?: string;
  ref?: string;
  path?: string;
  name?: string;
}

export const importGithub = (body: GithubImport) => json<ImportResult>('POST', '/items/import/github', body);

/**
 * When every unit was skipped the server answers 422 `nothing_imported` (no empty group is made either)
 * and carries the skip reasons as details, as does a 400 `nothing_to_import` when detection passed
 * something over: shown like a result, not as an error.
 */
export async function importOrSkipped(p: Promise<ImportResult>): Promise<ImportResult> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'nothing_imported' || e.code === 'nothing_to_import') && Array.isArray(e.details) && e.details.length) {
      return { items: [], group: null, skipped: e.details as ImportResult['skipped'], skippedFolders: e.raw?.skippedFolders as SkippedFolder[] | undefined, source: null };
    }
    throw e;
  }
}

export interface SourceCheck {
  source: ItemSource;
  upToDate: boolean;
  latestCommit: string;
}

export const checkSource = (id: string) => json<SourceCheck>('POST', `/items/${id}/source/check`);
export const updateSource = (id: string, note?: string) =>
  json<{ item: ItemDetail }>('POST', `/items/${id}/source/update`, note ? { note } : {});

/** Browse link for a GitHub source; null for zip sources (repo is the file name there). */
export function sourceUrl(s: ItemSource): string | null {
  if (s.kind !== 'github' || !s.repo) return null;
  const at = s.commit ?? s.ref;
  if (!at) return `https://github.com/${s.repo}`;
  return `https://github.com/${s.repo}/tree/${at}${s.path ? `/${s.path}` : ''}`;
}

/** Error text for the import flows: the server message, with the statuses that read badly spelled out. */
export function importErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404 && e.code === 'not_found' && /route/.test(e.message)) return 'This server does not have the import API yet (404).';
    if (e.status === 413) return `Too large: ${e.message}. A pack upload's limit counts the form fields too, so keep the zip a little under it.`;
    if (e.code === 'bad_source') return `Bad source: ${e.message}`;
    if (e.code === 'up_to_date') return 'Already up to date.';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
