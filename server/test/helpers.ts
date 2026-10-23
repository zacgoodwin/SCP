import { loadConfig, type Config } from '../src/config.ts';
import { newId, now, openDb } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { hashPassword, randomToken, sha256Hex } from '../src/lib/crypto.ts';
import type { Ctx, Scope } from '../src/types.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestUser {
  id: string;
  username: string;
  email: string;
  password: string;
  isAdmin: boolean;
}

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  bytes: Uint8Array;
}

/**
 * The WHATWG fetch "bad ports" at or above 1024 (listen(0) never hands out a lower one). fetch refuses
 * them before connecting (undici: TypeError, cause "bad port"). An ephemeral range that starts at 1024
 * (this Windows box: 1024-65535, handed out sequentially machine-wide) gives them to listen(0) whenever
 * the counter sweeps past, and a fake server there looks like an upstream that "did not respond".
 * ponytail: copied from undici's list (Node 24); the oidc test checks fetch still refuses each one.
 */
export const FETCH_BLOCKED_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/** Listen on a free 127.0.0.1 port that fetch will connect to; returns the port. Every fake upstream a test fetches from starts here. */
export async function listenLocal(server: Server): Promise<number> {
  for (;;) {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// scrypt is slow on purpose; hash the shared test password once.
const TEST_PASSWORD = 'password123';
const TEST_HASH = await hashPassword(TEST_PASSWORD);

export function makeTestCtx(env: Record<string, string> = {}) {
  const config: Config = loadConfig({
    SCP_PUBLIC_URL: 'http://app.test',
    SCP_ARTIFACT_URL: 'http://art.test',
    SCP_DB_PATH: ':memory:',
    SCP_WEB_DIST: '/nonexistent-web-dist',
    ...env,
  });
  const db = openDb(':memory:');
  const ctx: Ctx = { db, config, secret: 'test-secret' };
  const { app, artifactApp } = buildApp(ctx);

  let n = 0;
  function createUser(opts: { username?: string; isAdmin?: boolean; disabled?: boolean } = {}): TestUser {
    const username = opts.username ?? `user${++n}`;
    const id = newId();
    const email = `${username}@example.com`;
    db.prepare(
      'INSERT INTO users (id, email, username, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, email, username, TEST_HASH, opts.isAdmin ? 1 : 0, opts.disabled ? 1 : 0, now());
    return { id, username, email, password: TEST_PASSWORD, isAdmin: !!opts.isAdmin };
  }

  /** Cookie header for a fresh session of user. */
  function session(user: TestUser): Record<string, string> {
    const sid = randomToken();
    db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256Hex(sid),
      user.id,
      now(),
      new Date(Date.now() + 86400_000).toISOString(),
    );
    // Origin mirrors what browsers send on non-GET requests, so the CSRF check passes.
    return { Cookie: `scp_sid=${sid}`, Origin: config.publicUrl };
  }

  /** Authorization header for a fresh API key of user. */
  function key(user: TestUser, opts: { scopes?: Scope[]; groupIds?: string[] | null; expiresAt?: string } = {}) {
    const token = randomToken('scp_');
    const id = newId();
    db.prepare(
      'INSERT INTO api_keys (id, user_id, name, token_hash, prefix, scopes, group_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      user.id,
      'test',
      sha256Hex(token),
      token.slice(0, 8),
      JSON.stringify(opts.scopes ?? ['read', 'write']),
      opts.groupIds ? JSON.stringify(opts.groupIds) : null,
      now(),
      opts.expiresAt ?? null,
    );
    return { id, token, headers: { Authorization: `Bearer ${token}` } as Record<string, string> };
  }

  async function call(
    target: { fetch: (r: Request) => Response | Promise<Response> },
    base: string,
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; json?: unknown; body?: BodyInit } = {},
  ): Promise<Res> {
    const headers = new Headers(opts.headers);
    let body = opts.body;
    if (opts.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(opts.json);
    }
    const res = await target.fetch(new Request(base + path, { method, headers, body }));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let json: unknown = undefined;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, text, json, bytes };
  }

  return {
    ctx,
    db,
    config,
    app,
    artifactApp,
    createUser,
    session,
    key,
    req: (method: string, path: string, opts?: Parameters<typeof call>[4]) => call(app, config.publicUrl, method, path, opts),
    artReq: (method: string, path: string, opts?: Parameters<typeof call>[4]) =>
      call(artifactApp, config.artifactUrl, method, path, opts),
  };
}

export type TestCtx = ReturnType<typeof makeTestCtx>;

/** Insert a raw item row (no versions) for access tests. */
export function insertItem(t: TestCtx, owner: TestUser, opts: { kind?: string; name?: string; visibility?: string } = {}) {
  const id = newId();
  t.db
    .prepare(
      'INSERT INTO items (id, owner_id, kind, name, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, owner.id, opts.kind ?? 'skill', opts.name ?? `item-${id.slice(-6)}`, opts.visibility ?? 'private', now(), now());
  return id;
}

/** Insert a raw group row for access tests. */
export function insertGroup(
  t: TestCtx,
  owner: TestUser,
  opts: { slug?: string; visibility?: string; members?: string[]; sharedWith?: TestUser[] } = {},
) {
  const id = newId();
  t.db
    .prepare('INSERT INTO scp_groups (id, owner_id, slug, name, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, owner.id, opts.slug ?? `g-${id.slice(-6)}`, 'Group', opts.visibility ?? 'private', now(), now());
  for (const [i, itemId] of (opts.members ?? []).entries()) {
    t.db.prepare('INSERT INTO group_members (group_id, item_id, position, added_at) VALUES (?, ?, ?, ?)').run(id, itemId, i, now());
  }
  for (const u of opts.sharedWith ?? []) t.db.prepare('INSERT INTO group_shares (group_id, user_id) VALUES (?, ?)').run(id, u.id);
  return id;
}
