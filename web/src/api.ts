// Typed client for /api/v1. Shapes mirror docs/PLAN.md "HTTP API"; keep them in sync with it.

export const API = '/api/v1';

// ---------- shared types ----------

export type Plane = 'skill' | 'md' | 'artifact';
export type Kind = 'skill' | 'agent' | 'command' | 'instructions' | 'prompt' | 'design' | 'package' | 'artifact';
export type Format = 'html' | 'markdown' | 'svg' | 'mermaid' | 'react' | 'code';
export type Visibility = 'private' | 'public';
export type GroupVisibility = 'private' | 'shared' | 'public';
export type Scope = 'read' | 'write';

export const KINDS_BY_PLANE: Record<Plane, Kind[]> = {
  skill: ['skill'],
  md: ['agent', 'command', 'instructions', 'prompt', 'design', 'package'],
  artifact: ['artifact'],
};
export const FORMATS: Format[] = ['html', 'markdown', 'svg', 'mermaid', 'react', 'code'];
export const ARTIFACT_CATEGORIES = ['component', 'design', 'deck', 'document', 'dashboard', 'tool', 'other'];
export const planeOf = (kind: Kind): Plane => (kind === 'skill' ? 'skill' : kind === 'artifact' ? 'artifact' : 'md');

export interface User {
  id: string;
  email: string;
  username: string;
  isAdmin: boolean;
  disabled: boolean;
  /** Linked to a single sign-on identity; the user (account menu) or an admin can drop the link. */
  oidcLinked: boolean;
  createdAt: string;
}
export interface Me {
  user: User;
  principal: { via: 'session' | 'key' | 'oauth'; scopes: Scope[]; groupIds: string[] | null };
}
export interface AuthConfig {
  registration: boolean;
  artifactOrigin: string;
  artifactUrl?: string;
  publicUrl: string;
  /** OIDC login (D3): shown as a button on the login page when enabled. */
  oidc?: { enabled: boolean; label: string };
}
/** Import provenance (D1). */
export interface ItemSource {
  kind: 'github' | 'zip';
  repo: string | null;
  ref: string | null;
  path: string | null;
  commit: string | null;
}

export interface Lint {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  path?: string;
}
export interface FileIn {
  path: string;
  content?: string;
  contentBase64?: string;
  mode?: 420 | 493;
}
export interface VersionFile {
  path: string;
  mode: number;
  size: number;
  sha256: string;
}
export interface VersionDetail {
  seq: number;
  entryPath: string;
  treeSha256: string;
  frontmatter: Record<string, unknown> | null;
  lint: Lint[];
  totalBytes: number;
  note: string | null;
  createdAt: string;
  /** clientId: the connected OAuth app that wrote it over MCP, when one did. */
  createdBy: { userId: string | null; keyId: string | null; clientId?: string | null };
  files: VersionFile[];
}
// PLAN.md names VersionSummary without spelling it out; assume VersionDetail minus the heavy fields.
export type VersionSummary = Pick<VersionDetail, 'seq' | 'note' | 'createdAt' | 'createdBy'> &
  Partial<Pick<VersionDetail, 'entryPath' | 'treeSha256' | 'totalBytes'>>;

export interface ItemSummary {
  id: string;
  kind: Kind;
  plane: Plane;
  name: string;
  title: string | null;
  description: string | null;
  category: string | null;
  tags: string[];
  visibility: Visibility;
  format: Format | null;
  latestSeq: number;
  owner: { id: string; username: string };
  updatedAt: string;
}
export interface ItemDetail extends ItemSummary {
  createdAt: string;
  source: ItemSource | null;
  forkedFrom: string | null;
  version: VersionDetail;
  groups: { slug: string; name: string }[];
  canEdit: boolean;
}
export interface ItemCreate {
  kind: Kind;
  name?: string;
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  visibility?: Visibility;
  format?: Format;
  files: FileIn[];
  note?: string;
}
export type ItemPatch = Partial<Pick<ItemSummary, 'title' | 'description' | 'category' | 'tags' | 'visibility'>>;
export interface ItemQuery {
  plane?: Plane;
  kind?: Kind;
  q?: string;
  owner?: 'me';
  limit?: number;
  offset?: number;
}

// Groups (C4), keys (C1), shares (C3), audit (C0): types for part B.
export interface GroupSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tags: string[];
  visibility: GroupVisibility;
  owner: { id: string; username: string };
  counts: { skill: number; md: number; artifact: number };
  updatedAt: string;
}
export interface GroupMember {
  item: ItemSummary;
  pinnedSeq: number | null;
  installAs: string | null;
  resolvedSeq: number;
  installPath: string;
}
export interface GroupDetail extends GroupSummary {
  instructions: string | null;
  sharedWith: string[];
  members: GroupMember[];
  endpoints: { mcp: string; manifest: string; bundle: string };
  canEdit: boolean;
}
export interface GroupCreate {
  slug: string;
  name: string;
  description?: string;
  instructions?: string;
  tags?: string[];
  visibility?: GroupVisibility;
  sharedWith?: string[];
}
export type GroupPatch = Partial<Omit<GroupCreate, 'slug'>>;
export interface MemberIn {
  itemId: string;
  pinnedSeq?: number;
  installAs?: string;
}
/** Mirrors server/src/groups/bundle.ts Conflict: the members (by name) that install to one path. */
export interface ManifestConflict {
  path: string;
  items: string[];
}
/** Why a download cannot be built (`code`: group_full, bundle_too_large or path_conflict), or ok. */
export interface BuildProblem {
  ok: boolean;
  problem: string | null;
  code?: string | null;
}
export interface Manifest {
  group: { slug: string; name: string; description: string | null; instructions: string | null };
  items: { id: string; kind: Kind; plane: Plane; name: string; title: string | null; description: string | null; version: number; installPath: string }[];
  conflicts?: ManifestConflict[];
  /** Whether plugin.zip builds (and the marketplace lists the group); `problem` says why not. */
  plugin?: BuildProblem;
  /** Whether bundle.zip builds for the requested target and scope; `problem` says why not. */
  bundle?: BuildProblem;
}
export type BundleTarget = 'claude-code' | 'codex' | 'generic';
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  groupIds: string[] | null;
  groups: { id: string; slug: string }[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}
export interface KeyCreate {
  name: string;
  scopes: Scope[];
  groups?: string[];
  expiresInDays?: number;
}
export interface Share {
  id: string;
  itemId: string;
  pinnedSeq: number | null;
  createdAt: string;
  revokedAt: string | null;
  url: string;
  rawUrl: string;
}
export interface AuditEvent {
  id: number;
  ts: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  keyId: string | null;
  username: string | null;
}
export interface UserCreate {
  email: string;
  username: string;
  password: string;
  isAdmin?: boolean;
}
export interface Stats {
  skills: number;
  mds: number;
  artifacts: number;
  groups: number;
  keys: number;
}

// ---------- transport ----------

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  /** The response's whole error object, for fields beside details (an import's skippedFolders). */
  raw?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error) return Object.assign(new ApiError(res.status, body.error.code ?? 'error', body.error.message ?? res.statusText, body.error.details), { raw: body.error });
  } catch {
    // non-JSON error body (proxy, server down): fall through
  }
  return new ApiError(res.status, 'http_error', `${res.status} ${res.statusText || 'request failed'}`);
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(API + path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Network error: the server is unreachable.');
  }
  if (!res.ok) {
    const err = await toError(res);
    // The session ended (expired, password changed elsewhere, disabled): AuthProvider signs the shell
    // out. A wrong password on login is 'invalid_credentials' and stays a form error.
    if (res.status === 401 && err.code === 'unauthorized') window.dispatchEvent(new Event(SESSION_ENDED));
    throw err;
  }
  return res;
}

/** Window event fired when any API call finds the session gone. */
export const SESSION_ENDED = 'scp:session-ended';

/** Shared by the per-chunk API files (api-*.ts): JSON call, 204 -> undefined, errors as ApiError. */
export async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export { send };

export function qs(params: object): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

// ---------- auth (C1) ----------

export const getAuthConfig = () => json<AuthConfig>('GET', '/auth/config');
export const getMe = () => json<Me>('GET', '/auth/me');
export const login = (login: string, password: string) => json<{ user: User }>('POST', '/auth/login', { login, password });
export const logout = () => json<void>('POST', '/auth/logout');
export const register = (email: string, username: string, password: string) =>
  json<{ user: User }>('POST', '/auth/register', { email, username, password });
export const changePassword = (current: string, next: string) => json<void>('POST', '/auth/password', { current, next });

// ---------- items (C2) ----------

export const listItems = (q: ItemQuery = {}) => json<{ items: ItemSummary[]; total: number }>('GET', `/items${qs(q)}`);
export const createItem = (body: ItemCreate) => json<{ item: ItemDetail }>('POST', '/items', body);
export function importItem(file: File, opts: { kind?: Kind; visibility?: Visibility } = {}) {
  const fd = new FormData();
  fd.set('file', file);
  if (opts.kind) fd.set('kind', opts.kind);
  if (opts.visibility) fd.set('visibility', opts.visibility);
  return json<{ item: ItemDetail }>('POST', '/items/import', fd);
}
export const getItem = (id: string) => json<{ item: ItemDetail }>('GET', `/items/${id}`);
export const updateItem = (id: string, patch: ItemPatch) => json<{ item: ItemDetail }>('PATCH', `/items/${id}`, patch);
export const deleteItem = (id: string) => json<void>('DELETE', `/items/${id}`);
export const createVersion = (id: string, files: FileIn[], note?: string) =>
  json<{ item: ItemDetail }>('POST', `/items/${id}/versions`, { files, note });
export const listVersions = (id: string) => json<{ versions: VersionSummary[] }>('GET', `/items/${id}/versions`);
export const getVersion = (id: string, seq: number) => json<{ version: VersionDetail }>('GET', `/items/${id}/versions/${seq}`);
export const forkItem = (id: string, version?: number) => json<{ item: ItemDetail }>('POST', `/items/${id}/fork${qs({ version })}`);
export const search = (q: { q: string; plane?: Plane; kind?: Kind; group?: string; limit?: number }) =>
  json<{ results: (ItemSummary & { groups?: { slug: string; name: string }[] })[] }>('GET', `/search${qs(q)}`);

/** URL of one raw file (usable as an <a href>; the session cookie authenticates it). */
export const fileUrl = (id: string, path: string, version?: number) => `${API}/items/${id}/files/${encPath(path)}${qs({ version })}`;
export const downloadZipUrl = (id: string, version?: number) => `${API}/items/${id}/download.zip${qs({ version })}`;
export async function getFileBytes(id: string, path: string, version?: number): Promise<ArrayBuffer> {
  const res = await send('GET', fileUrl(id, path, version).slice(API.length));
  return res.arrayBuffer();
}

// ---------- groups (C4) ----------

const g = (slug: string) => `/groups/${encodeURIComponent(slug)}`;
export const getStats = () => json<Stats>('GET', '/stats');
/** One page of readable groups, the caller's own first (default 50, max 200); owner 'others' = other users' readable groups only. */
export const listGroups = (opts: { q?: string; owner?: 'me' | 'others'; limit?: number; offset?: number } = {}) =>
  json<{ groups: GroupSummary[]; total: number }>('GET', `/groups${qs(opts)}`);
export const getGroup = (slug: string) => json<{ group: GroupDetail }>('GET', g(slug));
export const createGroup = (body: GroupCreate) => json<{ group: GroupDetail }>('POST', '/groups', body);
export const updateGroup = (slug: string, patch: GroupPatch) => json<{ group: GroupDetail }>('PATCH', g(slug), patch);
export const deleteGroup = (slug: string) => json<void>('DELETE', g(slug));
export const putMembers = (slug: string, members: MemberIn[]) => json<{ group: GroupDetail }>('PUT', `${g(slug)}/members`, { members });
export const addMember = (slug: string, m: MemberIn) => json<{ group: GroupDetail }>('POST', `${g(slug)}/members`, m);
export const removeMember = (slug: string, itemId: string) => json<{ group: GroupDetail }>('DELETE', `${g(slug)}/members/${itemId}`);
export const getManifest = (slug: string, target?: BundleTarget) => json<Manifest>('GET', `${g(slug)}/manifest${qs({ target })}`);
export const getCatalog = (slug: string) => send('GET', `${g(slug)}/catalog.md`).then((r) => r.text());
/** Same-origin bundle URL (the session cookie authenticates a plain GET download). */
export const bundleUrl = (slug: string, target: BundleTarget) => `${API}${g(slug)}/bundle.zip${qs({ target })}`;

// ---------- keys, users, audit (C1, C0) ----------

/** Start linking single sign-on to the signed-in account: a POST (CSRF-checked), answering the IdP URL to navigate to. */
export const oidcLink = (next: string) => json<{ url: string }>('POST', '/auth/oidc/link', { next });
/** Drop the signed-in account's single sign-on link (409 for an account that has no password). */
export const oidcUnlink = () => json<void>('POST', '/auth/oidc/unlink', {});
export const listKeys = () => json<{ keys: ApiKey[] }>('GET', '/keys');
export const createKey = (body: KeyCreate) => json<{ key: ApiKey; token: string }>('POST', '/keys', body);
export const revokeKey = (id: string) => json<void>('DELETE', `/keys/${id}`);
export const searchUsers = (q: string) => json<{ users: { id: string; username: string }[] }>('GET', `/users/search${qs({ q })}`);
export const listUsers = () => json<{ users: User[] }>('GET', '/users');
export const createUser = (body: UserCreate) => json<{ user: User }>('POST', '/users', body);
export const updateUser = (id: string, patch: { isAdmin?: boolean; disabled?: boolean; password?: string }) =>
  json<{ user: User }>('PATCH', `/users/${id}`, patch);
export const deleteUser = (id: string) => json<void>('DELETE', `/users/${id}`);
export const listAudit = (q: { limit?: number; all?: boolean }) =>
  json<{ events: AuditEvent[] }>('GET', `/audit${qs({ limit: q.limit, all: q.all ? 1 : undefined })}`);

// ---------- artifacts (C3) ----------

export const getPreviewUrl = (id: string, version?: number) =>
  json<{ url: string; expiresAt: string }>('GET', `/items/${id}/preview-url${qs({ version })}`);
export const listShares = (itemId: string) => json<{ shares: Share[] }>('GET', `/items/${itemId}/shares`);
/** pinnedSeq freezes the link at that version; omitted, it follows the latest. */
export const createShare = (itemId: string, pinnedSeq?: number) =>
  json<{ share: Share; url: string }>('POST', `/items/${itemId}/shares`, pinnedSeq === undefined ? {} : { pinnedSeq });
export const revokeShare = (id: string) => json<void>('DELETE', `/shares/${id}`);

// ---------- helpers for error display ----------

/** The lint list from a 422, if the error carries one (details may be the array or {lint}). */
export function lintFromError(e: unknown): Lint[] | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.details as unknown;
  const list = Array.isArray(d) ? d : (d as { lint?: unknown } | null)?.lint;
  if (!Array.isArray(list) || !list.every((l) => l && typeof l === 'object' && 'level' in l && 'code' in l)) return null;
  return list as Lint[];
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
