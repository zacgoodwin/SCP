import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { requireScope, requireUser } from '../auth/middleware.ts';
import { verifyPayload } from '../lib/crypto.ts';
import { badRequest, parseQuery } from '../lib/http.ts';
import { getItemRow, loadEditableItem, loadReadableItem, readFile, resolveVersion } from '../items/service.ts';
import { artifactCsp, sanitizeCspDomains } from './csp.ts';
import { THEME_CSS, escapeHtml } from './render.ts';
import {
  PREVIEW_TTL_S,
  assertArtifact,
  createShare,
  getVersion,
  listShares,
  ownerDisabled,
  previewUrl,
  renderVersionHtml,
  resolveShare,
  revokeShare,
} from './shares.ts';
import type { AppEnv, ItemRow, VersionRow } from '../types.ts';

const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const shareBody = z.object({ pinVersion: z.boolean().optional(), pinnedSeq: z.number().int().min(1).optional() }).strict();

// ---------- /api/v1 ----------

/** Mounted under /api/v1 (previews, shares). */
export const artifactApiRoutes = new Hono<AppEnv>();

artifactApiRoutes.get('/items/:id/preview-url', (c) => {
  const p = requireUser(c);
  const { db } = c.var.ctx;
  const item = loadReadableItem(db, p, c.req.param('id'));
  assertArtifact(item);
  const v = resolveVersion(db, item, parseQuery(c, versionQuery).version);
  const t = Date.now();
  return c.json({ url: previewUrl(c.var.ctx, item, v.seq, t), expiresAt: new Date((Math.floor(t / 1000) + PREVIEW_TTL_S) * 1000).toISOString() });
});

artifactApiRoutes.get('/items/:id/shares', (c) => {
  const p = requireUser(c);
  const item = loadEditableItem(c.var.ctx.db, p, c.req.param('id'));
  return c.json({ shares: listShares(c.var.ctx, item.id) });
});

artifactApiRoutes.post('/items/:id/shares', async (c) => {
  const p = requireUser(c);
  requireScope(p, 'write');
  const item = loadEditableItem(c.var.ctx.db, p, c.req.param('id'));
  assertArtifact(item);
  // The body is optional: a bare POST mints a share that follows the latest version.
  const text = await c.req.text();
  let raw: unknown = {};
  try {
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    throw badRequest('body must be JSON');
  }
  const body = shareBody.safeParse(raw);
  if (!body.success) throw badRequest('invalid body', body.error.issues);
  const share = createShare(c.var.ctx, p, item, body.data);
  audit(c, p, { action: 'share.create', targetType: 'share', targetId: share.id, detail: { itemId: item.id, pinnedSeq: share.pinnedSeq } });
  return c.json({ share, url: share.url }, 201);
});

artifactApiRoutes.delete('/shares/:id', (c) => {
  const p = requireUser(c);
  const share = revokeShare(c.var.ctx, p, c.req.param('id'));
  audit(c, p, { action: 'share.revoke', targetType: 'share', targetId: share.id, detail: { itemId: share.itemId } });
  return c.body(null, 204);
});

// ---------- app origin: /s/:token ----------

const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals';

function plainPage(c: Context<AppEnv>, status: 200 | 404, html: string, nonce?: string) {
  const art = c.var.ctx.config.artifactUrl;
  return c.html(html, status, {
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; frame-src ${art}; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
}

const PAGE_CSS = `${THEME_CSS}
header{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline;justify-content:space-between;padding:16px;border-bottom:1px solid var(--line)}
h1{font-size:1.25rem;margin:0}
.meta{color:var(--muted);font-size:.875rem}
nav{display:flex;flex-wrap:wrap;gap:16px;font-size:.875rem}
iframe{display:block;width:100%;height:600px;border:0;background:#fff}
main.nf{max-width:560px;margin:15vh auto;padding:0 16px;text-align:center}`;

function notFoundPage(c: Context<AppEnv>) {
  return plainPage(
    c,
    404,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><style>${PAGE_CSS}</style></head>
<body><main class="nf"><h1>Link not found</h1><p class="meta">This share link does not exist or was revoked.</p></main></body></html>`,
  );
}

/** Mounted at the app origin root (/s/:token share page). Artifact HTML itself only ever comes from the artifact origin. */
export const sharePageRoutes = new Hono<AppEnv>();

sharePageRoutes.get('/s/:token', (c) => {
  const { db, config } = c.var.ctx;
  const token = c.req.param('token');
  const r = resolveShare(db, token);
  if (!r) return notFoundPage(c);
  const { item, version } = r;
  const owner = (db.prepare('SELECT username FROM users WHERE id = ?').get(item.owner_id) as { username: string } | undefined)?.username ?? '';
  const raw = `${config.artifactUrl}/r/${token}`;
  const title = item.title || item.name;
  const nonce = randomBytes(16).toString('base64');
  const e = escapeHtml;
  return plainPage(
    c,
    200,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><style>${PAGE_CSS}</style></head>
<body>
<header>
<div><h1>${e(title)}</h1><div class="meta">by ${e(owner)} &middot; version ${version.seq} &middot; updated ${e(version.created_at.slice(0, 10))}</div></div>
<nav><a href="${e(raw)}" target="_blank" rel="noopener noreferrer">Open full page</a><a href="${e(raw)}/source" target="_blank" rel="noopener noreferrer">View source</a><a href="/items/${e(item.id)}">Open in SCP</a></nav>
</header>
<iframe id="art" src="${e(raw)}" title="${e(title)}" sandbox="${IFRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe>
<script nonce="${nonce}">
(function(){
var f=document.getElementById('art');
addEventListener('message',function(e){
if(e.source!==f.contentWindow)return;
var d=e.data;if(!d||typeof d!=='object')return;
if(d.scp==='size'&&typeof d.height==='number'&&isFinite(d.height))f.style.height=Math.min(Math.max(Math.ceil(d.height),150),50000)+'px';
else if(d.scp==='open'&&typeof d.url==='string'&&/^https?:\\/\\//i.test(d.url))window.open(d.url,'_blank','noopener');
});
})();
</script>
</body></html>`,
    nonce,
  );
});

// ---------- artifact origin ----------
// No cookies are read or set here, and nothing but GET/HEAD /r and /p routes (app.ts 404s the rest).

const notFoundText = (c: Context<AppEnv>) =>
  c.text('not found', 404, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });

function artifactHtml(c: Context<AppEnv>, item: ItemRow, version: VersionRow, frameAncestors: string, cache: string) {
  const { db, config } = c.var.ctx;
  return c.body(renderVersionHtml(db, config, item, version), 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': artifactCsp(sanitizeCspDomains(config.cdns), frameAncestors),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=()',
    'Cache-Control': cache,
  });
}

/** The whole artifact origin (/r/:token, /p/:sig). */
export const artifactOriginRoutes = new Hono<AppEnv>();

artifactOriginRoutes.get('/r/:token', (c) => {
  const r = resolveShare(c.var.ctx.db, c.req.param('token'));
  return r ? artifactHtml(c, r.item, r.version, '*', 'no-cache') : notFoundText(c);
});

artifactOriginRoutes.get('/r/:token/v/:n', (c) => {
  const r = resolveShare(c.var.ctx.db, c.req.param('token'));
  const n = c.req.param('n');
  if (!r || !/^[1-9]\d{0,8}$/.test(n)) return notFoundText(c);
  const seq = Number(n);
  // Only the version the link resolves to now: an unpinned link must not expose replaced versions.
  if (seq !== r.version.seq) return notFoundText(c);
  // no-cache, not immutable: the token is revocable, so shared caches must not keep serving it.
  return artifactHtml(c, r.item, r.version, '*', 'no-cache');
});

artifactOriginRoutes.get('/r/:token/source', (c) => {
  const { db } = c.var.ctx;
  const r = resolveShare(db, c.req.param('token'));
  const f = r && readFile(db, r.version.id, r.version.entry_path);
  if (!f) return notFoundText(c);
  return c.body(f.bytes as Uint8Array<ArrayBuffer>, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
  });
});

artifactOriginRoutes.get('/p/:sig', (c) => {
  const { db, config, secret } = c.var.ctx;
  const p = verifyPayload<{ i: unknown; s: unknown; exp: number }>(secret, c.req.param('sig'));
  if (!p || typeof p.i !== 'string' || !Number.isInteger(p.s)) return notFoundText(c);
  const item = getItemRow(db, p.i);
  const v = item?.kind === 'artifact' && !ownerDisabled(db, item.owner_id) ? getVersion(db, item.id, p.s as number) : undefined;
  return item && v ? artifactHtml(c, item, v, config.publicUrl, 'no-store') : notFoundText(c);
});
