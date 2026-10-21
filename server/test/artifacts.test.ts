import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestCtx, type TestCtx } from './helpers.ts';
import { previewUrl } from '../src/artifacts/shares.ts';
import { getItemRow } from '../src/items/service.ts';

const API = '/api/v1';
type H = Record<string, string>;

function setup() {
  const t = makeTestCtx();
  const u = t.createUser();
  return { t, u, h: t.session(u) };
}

async function create(t: TestCtx, h: H, json: Record<string, unknown>) {
  const r = await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'artifact', format: 'html', ...json } });
  assert.equal(r.status, 201, r.text);
  return r.json.item as { id: string; latestSeq: number };
}

async function share(t: TestCtx, h: H, id: string, json?: unknown) {
  const r = await t.req('POST', `${API}/items/${id}/shares`, { headers: h, json });
  assert.equal(r.status, 201, r.text);
  return r.json.share as { id: string; url: string; rawUrl: string; pinnedSeq: number | null };
}

const tokenOf = (s: { url: string }) => s.url.slice(s.url.lastIndexOf('/') + 1);
const artPath = (url: string) => new URL(url).pathname;

test('preview-url signs a 10 minute link that /p/ renders; tampered, expired, foreign 404', async () => {
  const { t, h } = setup();
  const item = await create(t, h, { title: 'Prev', content: '<h1>preview me</h1>' });
  const r = await t.req('GET', `${API}/items/${item.id}/preview-url`, { headers: h });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.url.startsWith('http://art.test/p/'));
  const ttl = Date.parse(r.json.expiresAt) - Date.now();
  assert.ok(ttl > 590_000 && ttl <= 600_000, String(ttl));

  const page = await t.artReq('GET', artPath(r.json.url));
  assert.equal(page.status, 200);
  assert.match(page.text, /preview me/);
  assert.match(page.headers.get('content-security-policy')!, /^sandbox allow-scripts .*frame-ancestors http:\/\/app\.test$/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('set-cookie'), null);

  const sig = artPath(r.json.url).slice(3);
  const flipped = sig.slice(0, 5) + (sig[5] === 'A' ? 'B' : 'A') + sig.slice(6);
  assert.equal((await t.artReq('GET', `/p/${flipped}`)).status, 404);
  assert.equal((await t.artReq('GET', `/p/${sig}x`)).status, 404);
  assert.equal((await t.artReq('GET', '/p/garbage')).status, 404);
  const row = getItemRow(t.db, item.id)!;
  assert.equal((await t.artReq('GET', artPath(previewUrl(t.ctx, row, 1, Date.now() - 601_000)))).status, 404, 'expired');
  assert.equal((await t.artReq('GET', artPath(previewUrl(t.ctx, row, 7)))).status, 404, 'missing version');
  // a preview signed with another secret does not verify
  assert.equal((await t.artReq('GET', artPath(previewUrl({ ...t.ctx, secret: 'nope' }, row, 1)))).status, 404);

  assert.equal((await t.req('GET', `${API}/items/${item.id}/preview-url?version=9`, { headers: h })).status, 404);
  const stranger = t.createUser();
  assert.equal((await t.req('GET', `${API}/items/${item.id}/preview-url`, { headers: t.session(stranger) })).status, 404);
  assert.equal((await t.req('GET', `${API}/items/${item.id}/preview-url`)).status, 401);
  const md = await t.req('POST', `${API}/items`, { headers: h, json: { kind: 'prompt', name: 'p', content: 'hi' } });
  const notArt = await t.req('GET', `${API}/items/${md.json.item.id}/preview-url`, { headers: h });
  assert.equal(notArt.status, 400);
  assert.equal(notArt.json.error.code, 'not_artifact');
  assert.equal((await t.req('POST', `${API}/items/${md.json.item.id}/shares`, { headers: h })).json.error.code, 'not_artifact');
});

test('shares: owner creates and lists; others get 404 (private) or 403 (public, read-only)', async () => {
  const { t, u, h } = setup();
  const priv = await create(t, h, { title: 'Private', content: '<p>x</p>' });
  const s = await share(t, h, priv.id);
  assert.match(s.url, /^http:\/\/app\.test\/s\/[A-Za-z0-9_-]{43}$/);
  assert.equal(s.rawUrl, `http://art.test/r/${tokenOf(s)}`);
  assert.equal(s.pinnedSeq, null);
  // bare POST without a body works too
  const bare = await t.req('POST', `${API}/items/${priv.id}/shares`, { headers: h });
  assert.equal(bare.status, 201, bare.text);
  assert.equal(bare.json.url, bare.json.share.url);
  assert.equal((await t.req('POST', `${API}/items/${priv.id}/shares`, { headers: h, json: { pinVersion: 'yes' } })).status, 400);

  const list = await t.req('GET', `${API}/items/${priv.id}/shares`, { headers: h });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.shares.map((x: { id: string }) => x.id), [bare.json.share.id, s.id], 'newest first');

  const other = t.createUser();
  const oh = t.session(other);
  assert.equal((await t.req('POST', `${API}/items/${priv.id}/shares`, { headers: oh })).status, 404);
  assert.equal((await t.req('GET', `${API}/items/${priv.id}/shares`, { headers: oh })).status, 404);
  assert.equal((await t.req('DELETE', `${API}/shares/${s.id}`, { headers: oh })).status, 404);

  const pub = await create(t, h, { title: 'Public', content: '<p>y</p>', visibility: 'public' });
  assert.equal((await t.req('POST', `${API}/items/${pub.id}/shares`, { headers: oh })).status, 403);
  assert.equal((await t.req('GET', `${API}/items/${pub.id}/shares`, { headers: oh })).status, 403);
  const readKey = t.key(u, { scopes: ['read'] });
  assert.equal((await t.req('POST', `${API}/items/${pub.id}/shares`, { headers: readKey.headers })).status, 403);

  const actions = t.db.prepare("SELECT action FROM audit WHERE action LIKE 'share.%'").all() as { action: string }[];
  assert.deepEqual(actions.map((a) => a.action), ['share.create', 'share.create']);
  const detail = t.db.prepare("SELECT detail FROM audit WHERE action = 'share.create'").get() as { detail: string };
  assert.doesNotMatch(detail.detail, new RegExp(tokenOf(s)), 'token never audited');
});

test('share page escapes metadata, frames the artifact origin, sets a strict CSP', async () => {
  const { t, h } = setup();
  const evil = '<img src=x onerror=alert(1)>';
  const item = await create(t, h, { title: evil, name: 'evil', content: '<p>x</p>' });
  const s = await share(t, h, item.id);
  const page = await t.req('GET', `/s/${tokenOf(s)}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /^text\/html/);
  assert.ok(!page.text.includes(evil));
  assert.ok(page.text.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(page.text.includes(`<iframe id="art" src="${s.rawUrl}"`));
  assert.ok(page.text.includes('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"'));
  assert.doesNotMatch(page.text, /allow-same-origin/);
  assert.ok(page.text.includes('referrerpolicy="no-referrer"'));
  assert.ok(page.text.includes(`href="${s.rawUrl}/source"`));
  assert.ok(page.text.includes(`href="/items/${item.id}"`));
  assert.match(page.text, /e\.source!==f\.contentWindow/);
  assert.match(page.text, /window\.open\(d\.url,'_blank','noopener'\)/);
  const csp = page.headers.get('content-security-policy')!;
  const nonce = /'nonce-([^']+)'/.exec(csp)![1];
  assert.ok(page.text.includes(`<script nonce="${nonce}">`));
  assert.equal(page.text.split('<script').length - 1, 1, 'only the nonced script');
  assert.match(csp, /default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-[^']+'; frame-src http:\/\/art\.test; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const again = await t.req('GET', `/s/${tokenOf(s)}`);
  assert.notEqual(/'nonce-([^']+)'/.exec(again.headers.get('content-security-policy')!)![1], nonce, 'fresh nonce');

  const unknown = await t.req('GET', `/s/${'A'.repeat(43)}`);
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type')!, /^text\/html/);
  assert.equal((await t.req('GET', '/s/short')).status, 404);
});

test('/r/:token renders with the sandbox CSP and no cookies; source is inert text; revoke kills both', async () => {
  const { t, h } = setup();
  const src = '<!doctype html><html><body><h1>raw</h1></body></html>';
  const item = await create(t, h, { title: 'Raw', content: src });
  const s = await share(t, h, item.id);
  const tok = tokenOf(s);
  const r = await t.artReq('GET', `/r/${tok}`, { headers: { Cookie: 'scp_sid=whatever' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  const csp = r.headers.get('content-security-policy')!;
  assert.ok(csp.startsWith('sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals;'));
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /frame-ancestors \*$/);
  assert.match(csp, /script-src 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net/);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), usb=()');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.match(r.text, /<h1>raw<\/h1><script data-scp-helper>/);
  assert.equal((await t.artReq('HEAD', `/r/${tok}`)).status, 200);
  assert.equal((await t.artReq('POST', `/r/${tok}`)).status, 404);

  const source = await t.artReq('GET', `/r/${tok}/source`);
  assert.equal(source.status, 200);
  assert.equal(source.text, src);
  assert.equal(source.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(source.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(source.headers.get('x-content-type-options'), 'nosniff');

  assert.equal((await t.req('DELETE', `${API}/shares/${s.id}`, { headers: h })).status, 204);
  assert.equal((await t.req('DELETE', `${API}/shares/${s.id}`, { headers: h })).status, 204, 'idempotent');
  assert.equal((await t.artReq('GET', `/r/${tok}`)).status, 404);
  assert.equal((await t.artReq('GET', `/r/${tok}/source`)).status, 404);
  assert.equal((await t.artReq('GET', `/r/${tok}/v/1`)).status, 404);
  assert.equal((await t.req('GET', `/s/${tok}`)).status, 404);
  const listed = (await t.req('GET', `${API}/items/${item.id}/shares`, { headers: h })).json.shares;
  assert.equal(listed.length, 1);
  assert.ok(listed[0].revokedAt);
  assert.equal((await t.req('DELETE', `${API}/shares/nope`, { headers: h })).status, 404);
  const actions = t.db.prepare("SELECT action FROM audit WHERE action LIKE 'share.%' ORDER BY id").all() as { action: string }[];
  assert.deepEqual(actions.map((a) => a.action), ['share.create', 'share.revoke', 'share.revoke']);
});

test('pinned shares serve their version; unpinned follow latest; /v/:n rules', async () => {
  const { t, h } = setup();
  const item = await create(t, h, { title: 'Versions', content: '<p>one</p>' });
  const pinned = await share(t, h, item.id, { pinVersion: true });
  const live = await share(t, h, item.id, { pinVersion: false });
  assert.equal(pinned.pinnedSeq, 1);
  assert.equal(live.pinnedSeq, null);
  const v2 = await t.req('POST', `${API}/items/${item.id}/versions`, { headers: h, json: { content: '<p>two</p>' } });
  assert.equal(v2.status, 201, v2.text);

  const p = tokenOf(pinned);
  assert.match((await t.artReq('GET', `/r/${p}`)).text, /<p>one<\/p>/);
  assert.match((await t.req('GET', `/s/${p}`)).text, /version 1/);
  const pv1 = await t.artReq('GET', `/r/${p}/v/1`);
  assert.equal(pv1.status, 200);
  assert.equal(pv1.headers.get('cache-control'), 'no-cache', 'revocable: never cached by shared caches');
  assert.equal((await t.artReq('GET', `/r/${p}/v/2`)).status, 404);
  assert.match((await t.artReq('GET', `/r/${p}/source`)).text, /one/);

  const l = tokenOf(live);
  assert.match((await t.artReq('GET', `/r/${l}`)).text, /<p>two<\/p>/);
  assert.match((await t.req('GET', `/s/${l}`)).text, /version 2/);
  assert.equal((await t.artReq('GET', `/r/${l}/v/1`)).status, 404, 'an unpinned link does not expose replaced versions');
  assert.match((await t.artReq('GET', `/r/${l}/v/2`)).text, /<p>two<\/p>/);
  for (const n of ['3', '0', 'abc', '01', '1e3']) assert.equal((await t.artReq('GET', `/r/${l}/v/${n}`)).status, 404, n);
});

test('disabling the owner takes their share links down until re-enabled', async () => {
  const { t, u, h } = setup();
  const admin = t.createUser({ isAdmin: true });
  const tok = tokenOf(await share(t, h, (await create(t, h, { title: 'Phish', content: '<p>x</p>' })).id));
  const ah = t.session(admin);
  assert.equal((await t.req('PATCH', `${API}/users/${u.id}`, { headers: ah, json: { disabled: true } })).status, 200);
  for (const path of [`/r/${tok}`, `/r/${tok}/v/1`, `/r/${tok}/source`]) assert.equal((await t.artReq('GET', path)).status, 404, path);
  assert.equal((await t.req('GET', `/s/${tok}`)).status, 404);
  assert.equal((await t.req('PATCH', `${API}/users/${u.id}`, { headers: ah, json: { disabled: false } })).status, 200);
  assert.equal((await t.artReq('GET', `/r/${tok}`)).status, 200);
});

test('deleting the item kills its shares; the artifact origin serves nothing else', async () => {
  const { t, h } = setup();
  const item = await create(t, h, { title: 'Gone', content: '<p>x</p>' });
  const s = await share(t, h, item.id);
  const tok = tokenOf(s);
  assert.equal((await t.artReq('GET', `/r/${tok}`)).status, 200);
  for (const path of [`/api/v1/items/${item.id}`, '/api/v1/auth/me', '/api/health', `/s/${tok}`, '/', '/items']) {
    const r = await t.artReq('GET', path, { headers: h });
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  assert.equal((await t.req('DELETE', `${API}/items/${item.id}`, { headers: h })).status, 204);
  assert.equal((await t.artReq('GET', `/r/${tok}`)).status, 404);
  assert.equal((await t.req('GET', `/s/${tok}`)).status, 404);
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM shares').get() as { n: number }).n, 0);
});

test('react and markdown artifacts render through a share', async () => {
  const { t, h } = setup();
  const react = await create(t, h, { title: 'Counter', format: 'react', content: 'export default function App(){ return <b>hi</b>; }' });
  const r = await t.artReq('GET', `/r/${tokenOf(await share(t, h, react.id))}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<script type="importmap">/);
  assert.doesNotMatch(r.text, /<b>hi<\/b>/);
  const md = await create(t, h, { title: 'Notes', format: 'markdown', content: '# Notes\n\n- a\n' });
  const m = await t.artReq('GET', `/r/${tokenOf(await share(t, h, md.id))}`);
  assert.match(m.text, /<h1>Notes<\/h1>/);
  assert.match(m.text, /<title>Notes<\/title>/);
});

test('a signed preview stops rendering once the owner is disabled', async () => {
  const { t, u, h } = setup();
  const it = await create(t, h, { title: 'Prev', content: '<h1>p</h1>' });
  const url = (await t.req('GET', `${API}/items/${it.id}/preview-url`, { headers: h })).json.url as string;
  assert.equal((await t.artReq('GET', artPath(url))).status, 200);
  t.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(u.id);
  assert.equal((await t.artReq('GET', artPath(url))).status, 404);
  t.db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(u.id);
  assert.equal((await t.artReq('GET', artPath(url))).status, 200, 're-enabling restores it, like share links');
});
