// Rule tests for rules.yml (`opengrep test .opengrep`). Never imported or compiled; the `sast` scan
// excludes this directory.
import { exec, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { setCookie } from 'hono/cookie';

export function sql(c: any, db: any, f: { sql: string; params: string[] }) {
  const slug = c.req.param('slug');
  // ruleid: scp.sql-injection.request-input-in-sql
  db.prepare(`SELECT * FROM scp_groups WHERE slug = '${slug}'`).get();
  // ruleid: scp.sql-injection.request-input-in-sql
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

export async function redirect(c: any, config: { publicUrl: string }) {
  const next = c.req.query('next');
  // ruleid: scp.open-redirect.request-input-in-redirect
  if (next) return c.redirect(next, 302);
  const body = await c.req.json();
  // ruleid: scp.open-redirect.request-input-in-redirect
  if (body.to) return c.redirect(`https://${body.to}/`, 302);
  // ok: scp.open-redirect.request-input-in-redirect
  return c.redirect(`${config.publicUrl}/consent`, 302);
}

export function shell(name: string) {
  // ruleid: scp.command-injection.shell
  exec(`git clone ${name}`);
  // ruleid: scp.command-injection.shell
  spawn('git', ['clone', name], { shell: true });
  // ok: scp.command-injection.shell
  execFile('git', ['clone', name]);
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
