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
}

export type AppEnv = {
  Variables: {
    ctx: Ctx;
    principal: Principal | null;
  };
};

export const KINDS = ['skill', 'agent', 'command', 'instructions', 'prompt', 'design', 'package', 'artifact'] as const;
export type Kind = (typeof KINDS)[number];
export const MD_KINDS = ['agent', 'command', 'instructions', 'prompt', 'design', 'package'] as const;
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
