// Rule tests for rules.yml (`opengrep test .opengrep`). Never imported or compiled; the `sast` scan
// excludes this directory.
// ruleid: scp.command-injection.shell
import { exec, execFile, spawn, execSync as run, execFile as runFile } from 'node:child_process';
// Used only through promisify() and an assignment alias: taking exec is the finding, not calling it.
// ruleid: scp.command-injection.shell
import { exec as shellExec, execSync as shellSync } from 'node:child_process';
// The whole module, bound: every later use of it (`cp.exec`, `let { exec } = cp`, `cp['exec']`) starts here.
// ruleid: scp.command-injection.shell
import * as childProcess from 'node:child_process';
// ruleid: scp.command-injection.shell
import cpDefault from 'child_process';
// ok: scp.command-injection.shell
import { execFile as namedFile, spawnSync } from 'child_process';
// A barrel that re-exports it: `import { exec } from './proc.ts'` elsewhere would take exec unseen.
// ruleid: scp.command-injection.shell
export * from 'node:child_process';
// ruleid: scp.command-injection.shell
export { exec as barrelExec } from 'node:child_process';
// ok: scp.command-injection.shell
export { execFile as barrelFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { setCookie } from 'hono/cookie';

export function sql(c: any, db: any, f: { sql: string; params: string[] }) {
  const slug = c.req.param('slug');
  // `c` is a parameter too, so scp.sql-injection.parameter-in-sql also reports these two.
  // ruleid: scp.sql-injection.request-input-in-sql, scp.sql-injection.parameter-in-sql
  db.prepare(`SELECT * FROM scp_groups WHERE slug = '${slug}'`).get();
  // ruleid: scp.sql-injection.request-input-in-sql, scp.sql-injection.parameter-in-sql
  c.var.ctx.db.exec('DELETE FROM items WHERE id = ' + c.req.query('id'));
  // ok: scp.sql-injection.request-input-in-sql
  db.prepare('SELECT * FROM scp_groups WHERE slug = ?').get(slug);
  // ok: scp.sql-injection.request-input-in-sql
  db.prepare(`SELECT * FROM scp_groups g WHERE g.slug = ? AND ${f.sql}`).get(slug, ...f.params);
  // ok: scp.sql-injection.request-input-in-sql
  db.prepare(`SELECT * FROM items LIMIT ${Number(c.req.query('limit'))}`).all();
  // ok: scp.sql-injection.request-input-in-sql
  return /\/items\/([^/]+)$/.exec(new URL(c.req.url).pathname);
}

// The helper is called with request input from a route in another file; the rule never sees the call.
export function load(db: any, s: string, limit: number) {
  // ruleid: scp.sql-injection.parameter-in-sql
  db.prepare(`SELECT * FROM items WHERE name = '${s}'`).get();
  const where = "kind = '" + s.trim() + "'";
  // ruleid: scp.sql-injection.parameter-in-sql
  db.prepare('SELECT * FROM items WHERE ' + where).all();
  // ok: scp.sql-injection.parameter-in-sql
  db.prepare('SELECT * FROM items WHERE name = ?').get(s);
  // ok: scp.sql-injection.parameter-in-sql
  db.prepare(`SELECT * FROM items LIMIT ${Number(limit)}`).all();
}

export const loadArrow = (db: any, kind: string) =>
  // ruleid: scp.sql-injection.parameter-in-sql
  db.prepare(`SELECT * FROM items WHERE kind = '${kind}'`).all();

export class Repo {
  db: any;
  find(name: string) {
    // ruleid: scp.sql-injection.parameter-in-sql
    return this.db.prepare(`SELECT * FROM items WHERE name = '${name}'`).get();
  }
}

export function fragments(db: any, f: { sql: string; params: string[] }, stepSql: string) {
  // ok: scp.sql-injection.parameter-in-sql
  db.prepare(`SELECT * FROM items i WHERE ${f.sql}`).all(...f.params);
  // ok: scp.sql-injection.parameter-in-sql
  const n = (sql: string) => db.prepare(sql).get();
  // ok: scp.sql-injection.parameter-in-sql
  return [n('SELECT 1'), db.prepare(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT ${stepSql}) SELECT 1`).get()];
}

// A fragment builder a route calls with request input: the prepare() that runs it sees only `.sql`.
export function kindSql(kind: string) {
  // ruleid: scp.sql-injection.parameter-in-sql-fragment
  return { sql: `i.kind = '${kind}'`, params: [] };
}

export function fragmentUse(db: any, name: string, f: { sql: string; params: string[] }) {
  // ruleid: scp.sql-injection.parameter-in-sql-fragment
  const q = { sql: `SELECT * FROM items WHERE name = '${name}'` };
  // ok: scp.sql-injection.parameter-in-sql-fragment
  const both = { sql: `${f.sql} AND i.kind = ?`, params: [...f.params, name] };
  // ok: scp.sql-injection.parameter-in-sql
  return [db.prepare(q.sql).get(), db.prepare(`SELECT * FROM items i WHERE ${both.sql}`).all(...both.params)];
}

// The SQL-text helpers (settings.ts count, touch.ts touchFrom, service.ts n and longest) prepare a `sql`
// parameter, which is no source: the text their caller hands them is the sink.
declare function count(db: any, sql: string): number;
declare function touchFrom(db: any, anchorSql: string, params: unknown[]): void;
export function helpers(db: any, kind: string, slug: string) {
  const n = (sql: string, ...params: string[]) => db.prepare(sql).get(...params);
  const longest = (stepSql: string) => db.prepare(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT ${stepSql}) SELECT 1`).get(slug);
  // ruleid: scp.sql-injection.parameter-in-sql
  count(db, `SELECT count(*) AS n FROM items WHERE kind = '${kind}'`);
  // ruleid: scp.sql-injection.parameter-in-sql
  touchFrom(db, `SELECT id FROM scp_groups WHERE slug = '${slug}'`, []);
  // ruleid: scp.sql-injection.parameter-in-sql
  n(`SELECT count(*) AS n FROM items WHERE kind = '${kind}'`);
  // ruleid: scp.sql-injection.parameter-in-sql
  longest(`gi.group_id FROM chain JOIN scp_groups g ON g.slug = '${slug}'`);
  // ok: scp.sql-injection.parameter-in-sql
  count(db, 'SELECT COUNT(*) AS n FROM items');
  // ok: scp.sql-injection.parameter-in-sql
  touchFrom(db, 'SELECT id FROM scp_groups WHERE slug = ?', [slug]);
  // ok: scp.sql-injection.parameter-in-sql
  return n('SELECT count(*) AS n FROM items WHERE kind = ?', kind);
}

export function fragmentAssign(f: { sql: string; params: string[] }, kind: string) {
  // ruleid: scp.sql-injection.parameter-in-sql-fragment
  f.sql = `i.kind = '${kind}'`;
  // ok: scp.sql-injection.parameter-in-sql-fragment
  f.sql = 'i.kind = ?';
  f.params.push(kind);
  // ruleid: scp.sql-injection.parameter-in-sql-fragment
  f['sql'] = `i.kind = '${kind}'`;
}

// The services' WHERE-building idiom (items searchItems, audit.ts): a value pushed into the clause list
// reaches the text through join().
export function clauses(db: any, opts: { kind?: string }, kind: string) {
  const where = ['1'];
  if (opts.kind) where.push(`i.kind = '${opts.kind}'`);
  const w = where.join(' AND ');
  // ruleid: scp.sql-injection.parameter-in-sql
  db.prepare(`SELECT * FROM items i WHERE ${w}`).all();
  const safe = ['1'];
  const params: string[] = [];
  safe.push('i.kind = ?');
  params.push(kind);
  // ok: scp.sql-injection.parameter-in-sql
  return db.prepare(`SELECT * FROM items i WHERE ${safe.join(' AND ')}`).all(...params);
}

export function clauseRoute(c: any, db: any) {
  const where: string[] = [];
  where.unshift(`i.kind = '${c.req.query('kind')}'`);
  // ruleid: scp.sql-injection.request-input-in-sql, scp.sql-injection.parameter-in-sql
  return db.prepare(`SELECT * FROM items i WHERE ${where.join(' AND ')}`).all();
}

export function clauseFragment(kind: string) {
  const parts: string[] = [];
  parts.push(`i.kind = '${kind}'`);
  // ruleid: scp.sql-injection.parameter-in-sql-fragment
  return { sql: parts.join(' AND '), params: [] };
}

// prepare() on any handle: only exec() needs the receiver's name, to keep RegExp#exec out.
export function handles(conn: any, order: string, c: any) {
  // ruleid: scp.sql-injection.parameter-in-sql
  conn.prepare(`SELECT * FROM items ORDER BY ${order}`).all();
  // ruleid: scp.sql-injection.request-input-in-sql, scp.sql-injection.parameter-in-sql
  conn.prepare(`SELECT * FROM items WHERE id = '${c.req.param('id')}'`).get();
  // ok: scp.sql-injection.parameter-in-sql
  return /x/.exec(order);
}
// ruleid: scp.sql-injection.parameter-in-sql
export const pick = (d: any, o: string) => d.prepare(`SELECT ${o}`).all();

export function insertRow(db: any, table: 'items', cols: string[]) {
  // ok: scp.sql-injection.parameter-in-sql
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run();
}

export async function redirect(c: any) {
  const { config } = c.var.ctx;
  const next = c.req.query('next');
  // ruleid: scp.open-redirect.request-input-in-redirect
  if (next) return c.redirect(next, 302);
  const body = await c.req.json();
  // ruleid: scp.open-redirect.request-input-in-redirect
  if (body.to) return c.redirect(`https://${body.to}/`, 302);
  const back = new URL(c.req.url).searchParams.get('back');
  // ruleid: scp.open-redirect.request-input-in-redirect
  if (back) return c.redirect(back, 302);
  // ok: scp.open-redirect.request-input-in-redirect
  if (c.req.query('consent')) return c.redirect(`${config.publicUrl}/consent${new URL(c.req.url).search}`, 302);
  // ok: scp.open-redirect.request-input-in-redirect
  return c.redirect(`${config.publicUrl}/consent`, 302);
}

// The standard input path reads the request inside lib/http.ts, another function: the helpers are sources themselves.
declare function parseQuery(c: any, schema: unknown): any;
declare function parseJson(c: any, schema: unknown): Promise<any>;
declare const z: any;
export async function parsed(c: any) {
  const { to } = parseQuery(c, z.object({ to: z.string() }));
  // ruleid: scp.open-redirect.request-input-in-redirect
  if (to) return c.redirect(to, 302);
  const body = await parseJson(c, z.object({ back: z.string() }));
  // ruleid: scp.open-redirect.request-input-in-redirect
  if (body.back) return c.redirect(`https://${body.back}/`, 302);
  // ruleid: scp.open-redirect.request-input-in-redirect
  if (c.req.query('raw')) return c.redirect(new URL(c.req.raw.url).searchParams.get('to'), 302);
  // ok: scp.open-redirect.request-input-in-redirect
  return c.redirect(`/consent${new URL(c.req.raw.url).search}`, 302);
}

// The helper is called with c.req.query('next') from a route in another file; the rule never sees the call.
export function goTo(c: any, to: string) {
  // ruleid: scp.open-redirect.parameter-in-redirect
  if (to.startsWith('/')) return c.redirect(to, 302);
  // ruleid: scp.open-redirect.parameter-in-redirect
  if (to) return c.redirect(`https://${to}/`, 302);
  // ok: scp.open-redirect.parameter-in-redirect
  return c.redirect('/login', 302);
}

export const goToArrow = (c: any, to: string) =>
  // ruleid: scp.open-redirect.parameter-in-redirect
  c.redirect(to, 302);

export function toConsent(c: any, url: string) {
  // ok: scp.open-redirect.parameter-in-redirect
  return c.redirect(`/consent${new URL(url).search}`, 302);
}

// oidc.ts /auth/oidc/start: everything here comes off `c`, which is exempt.
declare function beginSignIn(c: any, cfg: unknown): Promise<string>;
export const signIn = async (c: any) => {
  const cfg = c.var.ctx.config;
  // ok: scp.open-redirect.parameter-in-redirect
  return c.redirect(await beginSignIn(c, cfg), 302);
};

// exec and execSync are reported where they are taken (the imports above, a require, the whole module's
// binding), so a call through any later rename is covered without being reported again.
export function shell(name: string) {
  // ok: scp.command-injection.shell
  exec(`git clone ${name}`);
  // ruleid: scp.command-injection.shell
  spawn('git', ['clone', name], { shell: true });
  // ok: scp.command-injection.shell
  run(`git clone ${name}`);
  // ok: scp.command-injection.shell
  execFile('git', ['clone', name]);
  // ok: scp.command-injection.shell
  runFile('git', ['clone', name]);
}

export async function shellAliases(name: string) {
  // ok: scp.command-injection.shell
  await promisify(shellExec)(`git clone ${name}`);
  const again = shellSync;
  // ok: scp.command-injection.shell
  again(`git clone ${name}`);
  // The namespace import is the finding; these uses of it are not reported again.
  // ok: scp.command-injection.shell
  const { execSync: x } = childProcess;
  // ok: scp.command-injection.shell
  const viaNamespace = promisify(childProcess.exec);
  // ok: scp.command-injection.shell
  let { exec: letRun } = childProcess;
  // ok: scp.command-injection.shell
  var { execSync: varRun } = cpDefault;
  // ok: scp.command-injection.shell
  const computed = promisify(childProcess['exec']);
  // ok: scp.command-injection.shell
  const { execFileSync } = childProcess;
  return [x, viaNamespace, letRun, varRun, computed, execFileSync, namedFile, spawnSync];
}

export function shellRequire(name: string) {
  // ruleid: scp.command-injection.shell
  const { exec: sh } = require('child_process');
  // ruleid: scp.command-injection.shell
  const cp = require('node:child_process');
  // ruleid: scp.command-injection.shell
  let cp2 = require('child_process');
  // ok: scp.command-injection.shell
  sh(`git clone ${name}`);
  // ok: scp.command-injection.shell
  cp.execSync(`git clone ${name}`);
  // ok: scp.command-injection.shell
  cp.execFileSync('git', ['clone', name]);
  // ok: scp.command-injection.shell
  cp2['exec'](`git clone ${name}`);
  // ruleid: scp.command-injection.shell
  return require('node:child_process').exec;
}

declare function createRequire(url: string): (id: string) => any;
// Lazy loads: a dynamic import() or getBuiltinModule() of child_process is reported whole; any other call
// taking the module name (a createRequire result) is tracked like require.
export async function shellLazy(name: string) {
  // ruleid: scp.command-injection.shell
  const { exec: lazy } = await import('node:child_process');
  // ruleid: scp.command-injection.shell
  const mod = await import('child_process');
  // ruleid: scp.command-injection.shell
  process.getBuiltinModule('node:child_process').execSync(`git clone ${name}`);
  // ruleid: scp.command-injection.shell
  createRequire(import.meta.url)('node:child_process').execSync(`git clone ${name}`);
  const req = createRequire(import.meta.url);
  // ruleid: scp.command-injection.shell
  const { execSync: viaReq } = req('node:child_process');
  // ruleid: scp.command-injection.shell
  const ns = req('node:child_process');
  // ok: scp.command-injection.shell
  ns.execFileSync('git', ['clone', name]);
  // ok: scp.command-injection.shell
  const fs = await import('node:fs');
  // ok: scp.command-injection.shell
  const { readFileSync } = req('node:fs');
  return [lazy, mod, viaReq, fs, readFileSync];
}

export function code(src: string) {
  // ruleid: scp.code-injection.eval
  eval(src);
  // ruleid: scp.code-injection.eval
  new Function('x', src);
  // ruleid: scp.code-injection.eval
  vm.runInNewContext(src);
  // ok: scp.code-injection.eval
  JSON.parse(src);
}

// ruleid: scp.frontmatter.gray-matter
import matter from 'gray-matter';
// ok: scp.frontmatter.gray-matter
import { parseFrontmatter } from '../server/src/lib/frontmatter.ts';

// ruleid: scp.llm.hosted-api
import Anthropic from '@anthropic-ai/sdk';
// ruleid: scp.llm.hosted-api
export const llm = 'https://api.openai.com/v1/chat/completions';
// ok: scp.llm.hosted-api
export const gh = 'https://api.github.com/repos';

// ruleid: scp.tls.verification-disabled
export const agent = { rejectUnauthorized: false };
// ruleid: scp.tls.verification-disabled
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// ok: scp.tls.verification-disabled
export const strict = { rejectUnauthorized: true };

export function hashes(data: string) {
  // ruleid: scp.crypto.weak-hash
  createHash('md5').update(data);
  // ruleid: scp.crypto.weak-hash
  createHash('sha1').update(data);
  // ok: scp.crypto.weak-hash
  return createHash('sha256').update(data).digest('hex');
}

export function ids() {
  // ruleid: scp.crypto.insecure-random
  const weak = Math.random().toString(36);
  // ok: scp.crypto.insecure-random
  return [weak, crypto.randomUUID()];
}

export function cookies(c: any, sid: string) {
  // ruleid: scp.cookie.missing-httponly
  setCookie(c, 'scp_session', sid);
  // ruleid: scp.cookie.missing-httponly
  setCookie(c, 'scp_session', sid, { path: '/', sameSite: 'Lax' });
  // ok: scp.cookie.missing-httponly
  setCookie(c, 'scp_session', sid, { path: '/', httpOnly: true, sameSite: 'Lax' });
}

export function dom(el: HTMLElement, html: string) {
  // ruleid: scp.xss.raw-html-sink
  el.innerHTML = html;
  // ruleid: scp.xss.raw-html-sink
  el.insertAdjacentHTML('beforeend', html);
  // ok: scp.xss.raw-html-sink
  el.textContent = html;
}

export { matter, parseFrontmatter, Anthropic };
