// D6 client for the D1 import endpoints (docs/PLAN-v2.md "D1 imports"). Shapes mirror that section.
import { ApiError, json, type GroupDetail, type ItemDetail, type ItemSource, type Kind, type Visibility } from './api.ts';

/** What the import did to the item: created it, added a version, or found it already at this content. */
export type ImportOp = 'create' | 'version' | 'unchanged';

export interface ImportResult {
  items: (ItemDetail & { op?: ImportOp })[];
  group: GroupDetail | null;
  skipped: { path: string; reason: string }[];
  source: ItemSource | null;
}

export interface ImportGroupOpts {
  visibility?: Visibility;
  /** Slug of a group to create with every imported item as a member. */
  group?: string;
  groupName?: string;
}

export function importPack(file: File, opts: ImportGroupOpts = {}) {
  const fd = new FormData();
  fd.set('file', file);
  for (const [k, v] of Object.entries(opts)) if (v) fd.set(k, v);
  return json<ImportResult>('POST', '/items/import/pack', fd);
}

export interface GithubImport extends ImportGroupOpts {
  url?: string;
  repo?: string;
  ref?: string;
  path?: string;
  kind?: Kind;
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
      return { items: [], group: null, skipped: e.details as ImportResult['skipped'], source: null };
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
    if (e.status === 413) return `Too large: ${e.message}. A pack upload is limited to 35 MB including the form fields, so keep the zip a little under that.`;
    if (e.code === 'bad_source') return `Bad source: ${e.message}`;
    if (e.code === 'up_to_date') return 'Already up to date.';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
