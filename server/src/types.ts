import type { Db } from './db.ts';
import type { Config } from './config.ts';

export type Scope = 'read' | 'write';

export interface Principal {
  userId: string;
  username: string;
  isAdmin: boolean;
  /** 'oauth' = an OAuth access token (oauth/tokens.ts); accepted on /mcp only, never on /api/v1. */
  via: 'session' | 'key' | 'oauth';
  keyId?: string;
  oauthClientId?: string;
  scopes: Scope[];
  /** null = every group the user can read; otherwise the key is restricted to these group ids. */
  groupIds: string[] | null;
}

export interface Ctx {
  db: Db;
  config: Config;
  /** HMAC secret for signed preview URLs; persisted in settings. */
  secret: string;
  /** Test seam, unset in production: POST /auth/password awaits it between its scrypts and its write. */
  beforePasswordWrite?: () => Promise<void>;
}

export type AppEnv = {
  Variables: {
    ctx: Ctx;
    principal: Principal | null;
  };
};

export const KINDS = ['skill', 'agent', 'command', 'instructions', 'prompt', 'design', 'package', 'artifact', 'hook', 'mcp-server', 'output-style'] as const;
export type Kind = (typeof KINDS)[number];
/** A kind with its article, for messages: 'an agent', 'an instructions item', 'a skill', 'an mcp-server'. */
export const aKind = (kind: Kind): string => (kind === 'instructions' ? 'an instructions item' : `${/^([aeiou]|mcp)/.test(kind) ? 'an' : 'a'} ${kind}`);
export const MD_KINDS = ['agent', 'command', 'instructions', 'prompt', 'design', 'package', 'hook', 'mcp-server', 'output-style'] as const;
/**
 * mc52 (docs/PLAN-v4.md): kinds that run commands on the installing machine as part of a Claude Code plugin,
 * and lay their files out at the plugin root. Another owner's include withholds these kinds alone
 * (groups/service.ts withheldExec); the flag and its warnings read the per-version `executable`
 * (items/lint.ts versionExecutable), which these kinds always set.
 */
export const EXECUTABLE_KINDS = ['hook', 'mcp-server'] as const;
export type ExecutableKind = (typeof EXECUTABLE_KINDS)[number];
export const isExecutable = (kind: Kind): kind is ExecutableKind => (EXECUTABLE_KINDS as readonly string[]).includes(kind);
/** mc52: kinds read from a plugin's components only; an import's kind override (jwz6, folderKinds) does not offer them. */
export const PLUGIN_KINDS = ['hook', 'mcp-server', 'output-style'] as const;
export const isPluginKind = (kind: Kind) => (PLUGIN_KINDS as readonly string[]).includes(kind);
export type Plane = 'skill' | 'md' | 'artifact';
export const planeOf = (kind: Kind): Plane => (kind === 'skill' ? 'skill' : kind === 'artifact' ? 'artifact' : 'md');
export const FORMATS = ['html', 'markdown', 'svg', 'mermaid', 'react', 'code'] as const;
export type Format = (typeof FORMATS)[number];

export interface UserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  is_admin: number;
  disabled: number;
  created_at: string;
  oidc_issuer: string | null;
  oidc_sub: string | null;
}

/** Where an imported item came from (docs/PLAN-v2.md D1). */
export interface ItemSource {
  kind: 'github' | 'zip';
  /** `owner/repo` for github; the uploaded file name for zip. */
  repo: string | null;
  ref: string | null;
  path: string | null;
  /** Full commit sha for github; sha256 of the zip bytes for zip. */
  commit: string | null;
}

/** jcfm: frontmatter SCP supplies to an imported file that has none: a skill's or agent's `name` (its item name) and `description`. */
export type SuppliedFrontmatter = {
  name?: string;
  description: string;
};

export interface ItemRow {
  id: string;
  owner_id: string;
  kind: Kind;
  name: string;
  title: string;
  description: string;
  category: string;
  tags: string;
  visibility: 'private' | 'public';
  format: Format | null;
  latest_seq: number;
  source_repo: string | null;
  source_ref: string | null;
  source_path: string | null;
  source_kind: 'github' | 'zip' | null;
  source_commit: string | null;
  /** tree_sha256 of the version the source last wrote: a later upstream tree equal to it is no update, whatever was edited locally since. */
  source_tree_sha256: string | null;
  /** How the import carved a skill (imports/pack.ts updateTree): the whole folder, or a root SKILL.md with sibling units carved out. */
  source_scope: 'tree' | 'root' | null;
  /** JSON list of the paths (relative to source_path) other units of the import took out of this skill folder; updateTree leaves them out. */
  source_carve: string | null;
  /** 1 when an import accepted the item's frontmatter errors (0rdh): its source updates accept them too. */
  lint_waived: number;
  /** 5ef6: what an import put in front of the unit's bare name (in-import, cross-source or both: 'fork-discord'); null when unprefixed or imported before it was recorded. */
  source_prefix: string | null;
  /** jcfm: JSON of the SuppliedFrontmatter an import added to an upstream file with none; re-applied on every source write. */
  supplied_frontmatter: string | null;
  /** jcfm: 1 when the last source write found upstream's own frontmatter, so the supplied fields wait as a fallback. */
  upstream_frontmatter: number;
  /** nenk: 1 when the import kept the repository's own tooling (includeRepoTooling, 4ky8); source updates carve the tree the same way. */
  source_tooling: number;
  /** mc52: JSON list of [kind, plugin-relative path] of the hook and MCP server entries its import made in its plugin root up to this item's own, last (imports/pack.ts execTree). */
  source_entries: string | null;
  forked_from: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  item_id: string;
  seq: number;
  entry_path: string;
  tree_sha256: string;
  frontmatter: string;
  lint: string;
  total_bytes: number;
  note: string;
  created_by_user: string | null;
  created_by_key: string | null;
  /** The OAuth client the version was written through (MCP create/update_artifact); null for sessions and keys. */
  created_by_client: string | null;
  created_at: string;
  /** 1 when the version acts on the installing machine as a plugin member (items/lint.ts versionExecutable). */
  executable: number;
}

export interface GroupRow {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  tags: string;
  visibility: 'private' | 'shared' | 'public';
  created_at: string;
  updated_at: string;
}
