import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { versionExecutable } from './items/lint.ts';
import { parseFrontmatter } from './lib/frontmatter.ts';
import type { Kind } from './types.ts';

export type Db = DatabaseSync;

/**
 * v3 (kgtx): a GitHub import whose `path` named a file stored `<file>/<name of file>` as source_path
 * ('docs/x.md/x.md'), which no source/update finds. Such a path is cut back to the file. Only the
 * single-file kinds of a `.md` could be stored that way (a folder import or kind override joins '');
 * the last two segments must repeat, read with rtrim (the head up to the last '/').
 */
export const UNDOUBLE_SOURCE_PATHS = `UPDATE items SET source_path = d.file FROM (
    SELECT id, substr(head, 1, length(head) - 1) AS file, substr(source_path, length(head) + 1) AS base FROM (
      SELECT id, source_path, rtrim(source_path, replace(source_path, '/', '')) AS head FROM items
      WHERE source_kind = 'github' AND kind IN ('agent', 'command', 'instructions', 'prompt', 'design') AND source_path LIKE '%.md/%.md'
    )
  ) AS d
  WHERE items.id = d.id AND (d.file = d.base OR substr(d.file, -length(d.base) - 1) = '/' || d.base);`;

/** items' columns as of migration 17, in table order: what the mc52 rebuild copies. Frozen, like the migration that reads it. */
const ITEM_COLUMNS =
  'id, owner_id, kind, name, title, description, category, tags, visibility, format, latest_seq, source_repo, source_ref, source_path, forked_from, created_at, updated_at, ' +
  'source_kind, source_commit, source_tree_sha256, source_scope, source_carve, lint_waived, source_prefix, supplied_frontmatter, upstream_frontmatter, source_tooling';

/**
 * A table rebuild (fkOff): the foreign_keys pragma is a no-op inside a transaction, so migrate() turns it
 * off around this one, and PRAGMA foreign_key_check must find nothing before it commits. `then`: a backfill
 * that needs a rule only the application holds, run after `sql` in the same transaction.
 */
type Migration = string | { fkOff?: true; sql: string; then?: (db: Db) => void };

/**
 * Review (exec-flag): item_versions.executable for every version written before it was stored, by the rule
 * new versions are written with (items/lint.ts versionExecutable), read from each entry file once at upgrade.
 */
function backfillExecutable(db: Db): void {
  const rows = db.prepare(
    `SELECT v.id, i.kind, CAST(b.data AS TEXT) AS text FROM item_versions v JOIN items i ON i.id = v.item_id
     LEFT JOIN version_files vf ON vf.version_id = v.id AND vf.path = v.entry_path LEFT JOIN blobs b ON b.sha256 = vf.sha256
     WHERE i.kind IN ('hook', 'mcp-server', 'skill', 'command', 'output-style')`,
  );
  const ids: string[] = [];
  for (const r of rows.iterate() as Iterable<{ id: string; kind: Kind; text: string | null }>) {
    if (versionExecutable(r.kind, parseFrontmatter(r.text ?? ''), r.text ?? '')) ids.push(r.id);
  }
  const set = db.prepare('UPDATE item_versions SET executable = 1 WHERE id = ?');
  for (const id of ids) set.run(id);
}

// Append-only. Each entry runs once, in order, tracked by PRAGMA user_version.
const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '["read"]',
    group_ids TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX api_keys_user ON api_keys(user_id);
  CREATE TABLE blobs (
    sha256 TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    data BLOB NOT NULL
  );
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('skill','agent','command','instructions','prompt','design','package','artifact')),
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
    format TEXT CHECK (format IS NULL OR format IN ('html','markdown','svg','mermaid','react','code')),
    latest_seq INTEGER NOT NULL DEFAULT 0,
    source_repo TEXT,
    source_ref TEXT,
    source_path TEXT,
    forked_from TEXT REFERENCES items(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (owner_id, kind, name)
  );
  CREATE INDEX items_owner ON items(owner_id);
  CREATE TABLE item_versions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    entry_path TEXT NOT NULL,
    tree_sha256 TEXT NOT NULL,
    frontmatter TEXT NOT NULL DEFAULT '{}',
    lint TEXT NOT NULL DEFAULT '[]',
    total_bytes INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by_user TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_by_key TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (item_id, seq)
  );
  CREATE TABLE version_files (
    version_id TEXT NOT NULL REFERENCES item_versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    mode INTEGER NOT NULL DEFAULT 420,
    sha256 TEXT NOT NULL REFERENCES blobs(sha256),
    size INTEGER NOT NULL,
    PRIMARY KEY (version_id, path)
  );
  CREATE TABLE scp_groups (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared','public')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE group_shares (
    group_id TEXT NOT NULL REFERENCES scp_groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES scp_groups(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    pinned_seq INTEGER,
    install_as TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    PRIMARY KEY (group_id, item_id)
  );
  CREATE INDEX group_members_item ON group_members(item_id);
  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    pinned_seq INTEGER,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX shares_item ON shares(item_id);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    user_id TEXT,
    key_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    ip TEXT
  );
  CREATE INDEX audit_user_ts ON audit(user_id, ts);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE items_fts USING fts5(
    item_id UNINDEXED, name, title, description, tags, body,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE VIRTUAL TABLE groups_fts USING fts5(
    group_id UNINDEXED, slug, name, description, tags, instructions,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
  // Share links are bearer capabilities for public read of one artifact; keep the token so the
  // owner can copy the link again. token_hash stays the lookup key.
  `ALTER TABLE shares ADD COLUMN token TEXT;`,
  // FTS5 tables have no foreign keys: drop their rows whenever an item or group row goes, including
  // by cascade from a user delete. Then clear rows such deletes already orphaned.
  `CREATE TRIGGER items_fts_after_delete AFTER DELETE ON items BEGIN DELETE FROM items_fts WHERE item_id = old.id; END;
   CREATE TRIGGER groups_fts_after_delete AFTER DELETE ON scp_groups BEGIN DELETE FROM groups_fts WHERE group_id = old.id; END;
   DELETE FROM items_fts WHERE item_id NOT IN (SELECT id FROM items);
   DELETE FROM groups_fts WHERE group_id NOT IN (SELECT id FROM scp_groups);`,
  // Agents save /mcp/<slug> and bundle URLs, so a deleted group's slug stays reserved for its owner
  // (and admins): otherwise anyone could recreate it and serve their content at those URLs. A
  // trigger, so cascades from a user delete leave tombstones too. No FK: it outlives the owner.
  `CREATE TABLE deleted_group_slugs (
    slug TEXT PRIMARY KEY COLLATE NOCASE,
    owner_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL
  );
   CREATE TRIGGER scp_groups_tombstone AFTER DELETE ON scp_groups BEGIN
     INSERT OR REPLACE INTO deleted_group_slugs (slug, owner_id, deleted_at) VALUES (old.slug, old.owner_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
   END;`,
  // v2 (docs/PLAN-v2.md): nested groups, import provenance, blob GC index, OIDC identities, OAuth server.
  `CREATE TABLE group_includes (
    group_id TEXT NOT NULL REFERENCES scp_groups(id) ON DELETE CASCADE,
    included_id TEXT NOT NULL REFERENCES scp_groups(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    PRIMARY KEY (group_id, included_id),
    CHECK (group_id <> included_id)
  );
  CREATE INDEX group_includes_included ON group_includes(included_id);
  ALTER TABLE items ADD COLUMN source_kind TEXT CHECK (source_kind IS NULL OR source_kind IN ('github','zip'));
  ALTER TABLE items ADD COLUMN source_commit TEXT;
  CREATE INDEX version_files_sha ON version_files(sha256);
  ALTER TABLE users ADD COLUMN oidc_issuer TEXT;
  ALTER TABLE users ADD COLUMN oidc_sub TEXT;
  CREATE UNIQUE INDEX users_oidc ON users(oidc_issuer, oidc_sub) WHERE oidc_sub IS NOT NULL;
  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    secret_hash TEXT,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
    token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
    client_uri TEXT,
    logo_uri TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    scopes TEXT NOT NULL,
    group_ids TEXT,
    resource TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE oauth_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grant_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    group_ids TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT
  );
  CREATE INDEX oauth_tokens_user ON oauth_tokens(user_id);
  CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);`,
  // v2 review: a version written through an OAuth client names it (items/service.ts insertVersion), and
  // the client sweep and admin listing look tokens up by client (oauth/service.ts sweepClients, listClientsAdmin).
  `ALTER TABLE item_versions ADD COLUMN created_by_client TEXT REFERENCES oauth_clients(id) ON DELETE SET NULL;
   CREATE INDEX oauth_tokens_client ON oauth_tokens(client_id);`,
  // v2 review 3: what an import's source last wrote and how it carved the tree (imports/pack.ts
  // versionFromSource, updateTree); a consented DCR client outlives the token sweep (oauth/service.ts
  // sweepClients); the token sweep's two range deletes stop scanning the table (sweepTokens).
  `ALTER TABLE items ADD COLUMN source_tree_sha256 TEXT;
   ALTER TABLE items ADD COLUMN source_scope TEXT CHECK (source_scope IS NULL OR source_scope IN ('tree','root'));
   ALTER TABLE oauth_clients ADD COLUMN consented_at TEXT;
   CREATE INDEX oauth_tokens_expires ON oauth_tokens(expires_at);
   CREATE INDEX oauth_tokens_revoked ON oauth_tokens(revoked_at);`,
  // v2 review 4: the client sweep (oauth/service.ts sweepClients, on every token request) finds its
  // candidates on a partial index instead of scanning a table anonymous registration makes attacker-sized,
  // and its codes subquery (and issueCode's expiry sweep) run on indexes too.
  `CREATE INDEX oauth_clients_sweep ON oauth_clients(created_at) WHERE created_by IS NULL AND consented_at IS NULL;
   CREATE INDEX oauth_codes_client ON oauth_codes(client_id);
   CREATE INDEX oauth_codes_expires ON oauth_codes(expires_at);`,
  UNDOUBLE_SOURCE_PATHS,
  // v3 4ky8/bppq: what another unit of the import carved out of a skill folder (imports/pack.ts updateTree).
  `ALTER TABLE items ADD COLUMN source_carve TEXT;`,
  // v3 0rdh: an item imported with its frontmatter errors accepted; its source updates accept them too
  // without asking again (imports/pack.ts versionFromSource).
  `ALTER TABLE items ADD COLUMN lint_waived INTEGER NOT NULL DEFAULT 0;`,
  // v3 5ef6: the prefix an import put in front of the unit's bare name (imports/pack.ts keepPrefix, importUnit).
  `ALTER TABLE items ADD COLUMN source_prefix TEXT;`,
  // v3 jcfm: the frontmatter fields (JSON) an import supplied to an upstream file that had none, re-applied
  // on every source write; upstream_frontmatter is 1 while upstream ships its own instead (imports/pack.ts versionFromSource).
  `ALTER TABLE items ADD COLUMN supplied_frontmatter TEXT;
   ALTER TABLE items ADD COLUMN upstream_frontmatter INTEGER NOT NULL DEFAULT 0;`,
  // v3 0nhr: how a session signed in ('oidc' from the SSO callback; NULL for a password login and
  // older rows), so an SSO-only account can set a break-glass password from a fresh SSO session only.
  `ALTER TABLE sessions ADD COLUMN auth_method TEXT;`,
  // v3 59b0: a first SSO sign-in whose verified email matches a password account parks the identity
  // here until that account's password is proven (auth/oidc.ts POST /auth/oidc/link/confirm).
  // Single use, 5 minutes, 5 password attempts; only the token's sha256 is stored.
  `CREATE TABLE oidc_pending_links (
    token_hash TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    sub TEXT NOT NULL,
    email TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    next TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
   CREATE INDEX oidc_pending_links_expires ON oidc_pending_links(expires_at);`,
  // v3 f9j0/fx78 (docs/PLAN-v3.md "CLI tools"): the CLIs each version's frontmatter requires (items/lint.ts
  // parseRequires, written by items/service.ts insertVersion; backfilled here with the same rule, the
  // MAX_REQUIRES = 50 cap by name included),
  // and the admin-curated registry that alone supplies install commands.
  `CREATE TABLE version_requires (
    version_id TEXT NOT NULL REFERENCES item_versions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    PRIMARY KEY (version_id, name)
  );
  CREATE INDEX version_requires_name ON version_requires(name);
  INSERT INTO version_requires (version_id, name)
    SELECT version_id, name FROM (
      SELECT version_id, name, ROW_NUMBER() OVER (PARTITION BY version_id ORDER BY name) AS n FROM (
        SELECT DISTINCT v.id AS version_id, j.value AS name FROM item_versions v, json_each(v.frontmatter, p.path) j, (SELECT '$.metadata.requires' AS path UNION ALL SELECT '$.requires') p
        WHERE json_type(v.frontmatter, p.path) IN ('array', 'text') AND j.type = 'text' AND length(j.value) <= 64
          AND j.value GLOB '[a-z0-9]*' AND j.value NOT GLOB '*[^a-z0-9._-]*'))
    WHERE n <= 50;
  CREATE TABLE cli_tools (
    name TEXT PRIMARY KEY,
    homepage TEXT NOT NULL DEFAULT '',
    check_bin TEXT NOT NULL,
    install TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  // v4 nenk: an item imported with includeRepoTooling (4ky8); its source updates re-detect with it (imports/pack.ts updateTree).
  `ALTER TABLE items ADD COLUMN source_tooling INTEGER NOT NULL DEFAULT 0;`,
  // v4 mc52: the kind CHECK gains hook, mcp-server and output-style. SQLite cannot alter a CHECK, so items is
  // rebuilt (sqlite.org/lang_altertable.html, "other kinds of table schema changes"): created anew, copied,
  // the old one dropped and the new one renamed into place, so every REFERENCES items(id) elsewhere names it
  // again. Its index and trigger go with the old table and are made again (FTS rows live in items_fts,
  // untouched). migrate() runs this with foreign_keys off and checks them before commit (fkOff).
  {
    fkOff: true,
    sql: `CREATE TABLE items_new (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('skill','agent','command','instructions','prompt','design','package','artifact','hook','mcp-server','output-style')),
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
    format TEXT CHECK (format IS NULL OR format IN ('html','markdown','svg','mermaid','react','code')),
    latest_seq INTEGER NOT NULL DEFAULT 0,
    source_repo TEXT,
    source_ref TEXT,
    source_path TEXT,
    forked_from TEXT REFERENCES items(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source_kind TEXT CHECK (source_kind IS NULL OR source_kind IN ('github','zip')),
    source_commit TEXT,
    source_tree_sha256 TEXT,
    source_scope TEXT CHECK (source_scope IS NULL OR source_scope IN ('tree','root')),
    source_carve TEXT,
    lint_waived INTEGER NOT NULL DEFAULT 0,
    source_prefix TEXT,
    supplied_frontmatter TEXT,
    upstream_frontmatter INTEGER NOT NULL DEFAULT 0,
    source_tooling INTEGER NOT NULL DEFAULT 0,
    UNIQUE (owner_id, kind, name)
  );
  INSERT INTO items_new (${ITEM_COLUMNS}) SELECT ${ITEM_COLUMNS} FROM items;
  DROP TABLE items;
  ALTER TABLE items_new RENAME TO items;
  CREATE INDEX items_owner ON items(owner_id);
  CREATE TRIGGER items_fts_after_delete AFTER DELETE ON items BEGIN DELETE FROM items_fts WHERE item_id = old.id; END;`,
  },
  // v4 mc52: a hook's or MCP server's upstream entry and those its plugin root made before it, which a source
  // update re-makes (imports/pack.ts execTree): a marketplace entry's hooks file is in no manifest of the plugin folder.
  `ALTER TABLE items ADD COLUMN source_entries TEXT;`,
  // Review (exec-flag): whether a version acts on the installing machine as a plugin member: a hook or MCP server,
  // a skill or command with frontmatter hooks or shell injection, a forced output style (items/lint.ts versionExecutable).
  { sql: `ALTER TABLE item_versions ADD COLUMN executable INTEGER NOT NULL DEFAULT 0;`, then: backfillExecutable },
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** Run the migrations past the database's user_version, up to `to` (all of them by default; tests stop early to hold an older schema). */
export function migrate(db: Db, to = MIGRATIONS.length): void {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < to; v++) {
    const m = MIGRATIONS[v];
    const fkOff = typeof m !== 'string' && !!m.fkOff;
    const { foreign_keys } = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        db.exec(typeof m === 'string' ? m : m.sql);
        if (typeof m !== 'string') m.then?.(db);
        if (fkOff && db.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`migration ${v + 1} left foreign key violations`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } finally {
      if (fkOff) db.exec(`PRAGMA foreign_keys = ${foreign_keys ? 'ON' : 'OFF'}`);
    }
  }
}

/** Synchronous transaction. fn must not await: DatabaseSync shares one connection. */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn(); // nested call joins the outer transaction
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => new Date().toISOString();

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

let lastMs = -1;
let lastRand: number[] = [];

/**
 * 26-char time-sortable id: 10 chars of ms timestamp + 16 random chars (Crockford base32). Monotonic
 * like ULID: within one ms (or if the clock steps back) the previous random part is incremented, so
 * listings that break created_at ties by id stay in creation order.
 */
export function newId(): string {
  const ms = Date.now();
  if (ms > lastMs) {
    lastMs = ms;
    lastRand = [...randomBytes(16)].map((b) => b % 32);
  } else {
    for (let i = 15; i >= 0 && ++lastRand[i] === 32; i--) lastRand[i] = 0;
  }
  let t = lastMs;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + lastRand.map((d) => B32[d]).join('');
}

/** Read-or-create a persistent setting (e.g. hmac_secret survives restarts on the volume). */
export function setting(db: Db, key: string, init: () => string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (row) return row.value;
  const value = init();
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }).value;
}

/** Map a SQLite UNIQUE violation (errcode 2067 / 1555 primary key) to a boolean. */
export const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && [2067, 1555].includes((e as { errcode?: number }).errcode ?? -1);
