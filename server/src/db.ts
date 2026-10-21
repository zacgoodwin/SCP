import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export type Db = DatabaseSync;

// Append-only. Each entry runs once, in order, tracked by PRAGMA user_version.
const MIGRATIONS: string[] = [
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
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
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
