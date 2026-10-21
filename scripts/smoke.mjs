#!/usr/bin/env node
// End-to-end smoke test against a running SCP (default: the docker compose stack).
// Usage: node scripts/smoke.mjs [--base http://localhost:8080] [--art http://localhost:8081]
// Exercises the whole agent path: register, create a skill + agent MD + instructions + artifact,
// group them, mint a group-scoped key, pull over MCP and bundle.zip, write an artifact back over
// MCP, share it publicly, revoke it. Exits non-zero on the first failure.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const BASE = arg('--base', process.env.SCP_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const ART = arg('--art', process.env.SCP_ARTIFACT_URL ?? 'http://localhost:8081').replace(/\/$/, '');

// Reuse the server's installed deps (MCP SDK client, fflate) so the smoke test needs no install.
const req = createRequire(new URL('../server/package.json', import.meta.url));
const load = (spec) => import(pathToFileURL(req.resolve(spec)).href);
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await load('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { unzipSync, zipSync, strFromU8, strToU8 } = await load('fflate');
import { createHash } from 'node:crypto';

let step = 0;
const ok = (msg) => console.log(`ok ${++step} - ${msg}`);
function check(cond, msg, extra) {
  if (!cond) {
    console.error(`not ok ${++step} - ${msg}`);
    if (extra !== undefined) console.error(typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2));
    process.exit(1);
  }
  ok(msg);
}

let cookie = '';
async function api(method, path, body, headers = {}) {
  const h = { Origin: BASE, ...headers };
  if (cookie && !h.Authorization) h.Cookie = cookie;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const buf = new Uint8Array(await res.arrayBuffer());
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(buf));
  } catch {}
  return { status: res.status, json, bytes: buf, headers: res.headers };
}

const id = randomBytes(3).toString('hex');
const username = `smoke${id}`;

// 1. health + register
check((await api('GET', '/api/health')).json?.ok === true, 'health');
const reg = await api('POST', '/api/v1/auth/register', { email: `${username}@example.com`, username, password: 'smoke-password-1' });
check(reg.status === 201, 'register', reg.json);
if (!cookie) await api('POST', '/api/v1/auth/login', { login: username, password: 'smoke-password-1' });
check((await api('GET', '/api/v1/auth/me')).json?.user?.username === username, 'session works');

// 2. content in all three planes
const skillMd = `---\nname: smoke-skill-${id}\ndescription: Formats release notes. Use when asked to write a changelog.\n---\n\n# Release notes\n\nRun scripts/fmt.sh.\n`;
const skill = await api('POST', '/api/v1/items', {
  kind: 'skill',
  files: [
    { path: 'SKILL.md', content: skillMd },
    { path: 'scripts/fmt.sh', content: '#!/bin/sh\necho fmt\n', mode: 493 },
  ],
});
check(skill.status === 201, 'create skill', skill.json);
const agentMd = `---\nname: reviewer-${id}\ndescription: Reviews TypeScript diffs for correctness.\ntools: Read, Grep\nmodel: sonnet\n---\n\nYou are a careful reviewer.\n`;
const agentItem = await api('POST', '/api/v1/items', { kind: 'agent', content: agentMd });
check(agentItem.status === 201, 'create agent MD', agentItem.json);
const instr = await api('POST', '/api/v1/items', { kind: 'instructions', name: `rules-${id}`, content: '# AGENTS.md\n\n- Run tests before committing.\n' });
check(instr.status === 201, 'create instructions MD', instr.json);
const art = await api('POST', '/api/v1/items', {
  kind: 'artifact',
  format: 'html',
  title: `Smoke dashboard ${id}`,
  category: 'dashboard',
  content: '<!doctype html><html><body><h1>Smoke</h1></body></html>',
});
check(art.status === 201, 'create artifact', art.json);

// 3. group them
const slug = `smoke-${id}`;
const grp = await api('POST', '/api/v1/groups', { slug, name: `Smoke ${id}`, instructions: 'Use the reviewer agent for every diff.', visibility: 'private' });
check(grp.status === 201, 'create group', grp.json);
const members = [skill, agentItem, instr, art].map((r) => ({ itemId: r.json.item.id }));
const put = await api('PUT', `/api/v1/groups/${slug}/members`, { members });
check(put.status === 200 && put.json.group.members.length === 4, 'set group members', put.json);

// 4. group-scoped key
const key = await api('POST', '/api/v1/keys', { name: 'smoke', scopes: ['read', 'write'], groups: [slug] });
check(key.status === 201 && key.json.token?.startsWith('scp_'), 'mint group key', key.json);
const auth = { Authorization: `Bearer ${key.json.token}` };

// 5. HTTP pull
const manifest = await api('GET', `/api/v1/groups/${slug}/manifest`, undefined, auth);
check(manifest.status === 200 && manifest.json.items.length === 4, 'manifest via key', manifest.json);
const bundle = await api('GET', `/api/v1/groups/${slug}/bundle.zip?target=claude-code`, undefined, auth);
check(bundle.status === 200, 'bundle.zip');
const files = unzipSync(bundle.bytes);
const paths = Object.keys(files).sort();
for (const p of [`.claude/skills/smoke-skill-${id}/SKILL.md`, `.claude/skills/smoke-skill-${id}/scripts/fmt.sh`, `.claude/agents/reviewer-${id}.md`, 'AGENTS.md', 'scp.lock.json']) {
  check(paths.includes(p), `bundle contains ${p}`, paths);
}
check(strFromU8(files[`.claude/agents/reviewer-${id}.md`]) === agentMd, 'agent MD bytes are verbatim');
const other = await api('GET', '/api/v1/items?plane=skill', undefined, auth);
check(other.status === 200, 'restricted key can list items');

// 6. MCP
const client = new Client({ name: 'scp-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${slug}`), { requestInit: { headers: auth } }));
check(/reviewer/i.test(client.getInstructions() ?? ''), 'initialize carries group instructions', client.getInstructions());
const tools = (await client.listTools()).tools.map((t) => t.name);
for (const t of ['get_group', 'search', 'get_skill', 'get_md', 'render_artifact', 'create_artifact']) check(tools.includes(t), `tool ${t} listed`, tools);
const text = (r) => r.content?.map((c) => c.text ?? '').join('\n') ?? '';
const g = await client.callTool({ name: 'get_group', arguments: {} });
check(!g.isError && text(g).includes(`smoke-skill-${id}`), 'get_group lists the skill', text(g));
const s = await client.callTool({ name: 'search', arguments: { query: 'changelog' } });
check(!s.isError && text(s).includes(`smoke-skill-${id}`), 'search finds the skill by description', text(s));
const gs = await client.callTool({ name: 'get_skill', arguments: { name: `smoke-skill-${id}` } });
check(!gs.isError && text(gs).includes('Release notes'), 'get_skill returns SKILL.md', text(gs));
const md = await client.callTool({ name: 'get_md', arguments: { name: `reviewer-${id}` } });
check(!md.isError && text(md).includes('careful reviewer'), 'get_md returns the agent body', text(md));
const toolList = (await client.listTools()).tools;
const render = toolList.find((t) => t.name === 'render_artifact');
check(render?._meta?.ui?.resourceUri === 'ui://scp/viewer/v1', 'render_artifact links the MCP App viewer', render?._meta);
// The server lists the app-only loader; MCP App hosts hide it from the model by its visibility.
const loader = toolList.find((t) => t.name === 'scp_artifact_content');
check(JSON.stringify(loader?._meta?.ui?.visibility) === '["app"]', 'viewer loader tool is app-only', loader?._meta);
const viewer = await client.readResource({ uri: 'ui://scp/viewer/v1' });
check(viewer.contents[0]?.mimeType === 'text/html;profile=mcp-app', 'viewer resource is an MCP App', viewer.contents[0]?.mimeType);
const ra = await client.callTool({ name: 'render_artifact', arguments: { id: art.json.item.id } });
check(!ra.isError && !text(ra).includes('<h1>Smoke</h1>'), 'render_artifact result carries no HTML', text(ra));
const created = await client.callTool({
  name: 'create_artifact',
  arguments: { title: `Agent report ${id}`, format: 'markdown', content: '# Report\n\nAll green.', category: 'document' },
});
check(!created.isError, 'agent writes an artifact back', text(created));
const createdId = created.structuredContent?.id;
check(typeof createdId === 'string', 'create_artifact returns an id', created.structuredContent);
const share = await client.callTool({ name: 'share_artifact', arguments: { id: createdId } });
check(!share.isError && typeof share.structuredContent?.url === 'string', 'share_artifact returns a public link', share.structuredContent);
await client.close();

// 7. public share renders on the artifact origin, sandboxed
const shareUrl = share.structuredContent.url;
const page = await fetch(shareUrl);
check(page.status === 200, 'share page loads without auth');
const token = shareUrl.split('/s/')[1];
const raw = await fetch(`${ART}/r/${token}`);
const csp = raw.headers.get('content-security-policy') ?? '';
check(raw.status === 200 && csp.startsWith('sandbox') && !csp.includes('allow-same-origin'), 'raw artifact is sandboxed', csp);
check(!raw.headers.get('set-cookie'), 'artifact origin sets no cookies');
check((await raw.text()).includes('All green'), 'rendered markdown artifact');
const shares = await api('GET', `/api/v1/items/${createdId}/shares`);
const revoke = await api('DELETE', `/api/v1/shares/${shares.json.shares[0].id}`);
check(revoke.status === 204, 'revoke share');
check((await fetch(`${ART}/r/${token}`)).status === 404, 'revoked share 404s');

// 8. v2: OAuth 2.1 for hosted MCP clients (metadata -> DCR -> authorize -> consent -> token -> MCP)
const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource`).then((r) => r.json());
check(prm.resource === `${BASE}/mcp` && prm.authorization_servers?.[0] === BASE, 'protected resource metadata', prm);
const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.json());
check(asm.token_endpoint === `${BASE}/oauth/token` && asm.code_challenge_methods_supported?.includes('S256'), 'authorization server metadata', asm);
const redirectUri = 'http://127.0.0.1:9/callback';
const dcr = await fetch(`${BASE}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: `smoke-host-${id}`, redirect_uris: [redirectUri] }),
});
const clientReg = await dcr.json();
check(dcr.status === 201 && typeof clientReg.client_id === 'string', 'dynamic client registration', clientReg);
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authQuery = new URLSearchParams({
  response_type: 'code',
  client_id: clientReg.client_id,
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: `st-${id}`,
  scope: 'read',
});
const authz = await fetch(`${BASE}/oauth/authorize?${authQuery}`, { redirect: 'manual' });
check(authz.status === 302 && (authz.headers.get('location') ?? '').startsWith(`${BASE}/consent?`), 'authorize hands off to the consent page', authz.headers.get('location'));
const consentQuery = Object.fromEntries(authQuery);
const consentInfo = await api('GET', `/api/v1/oauth/consent?${authQuery}`);
check(consentInfo.status === 200 && consentInfo.json.client?.name === `smoke-host-${id}`, 'consent info names the client', consentInfo.json);
const decision = await api('POST', '/api/v1/oauth/consent', { ...consentQuery, approve: true, scopes: ['read'], groups: [slug] });
check(decision.status === 200 && decision.json.redirect?.startsWith(redirectUri), 'consent approved with a code', decision.json);
const cbUrl = new URL(decision.json.redirect);
check(cbUrl.searchParams.get('state') === `st-${id}`, 'state echoed verbatim');
const tokenRes = await fetch(`${BASE}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: cbUrl.searchParams.get('code'),
    redirect_uri: redirectUri,
    client_id: clientReg.client_id,
    code_verifier: verifier,
  }),
});
const tokens = await tokenRes.json();
check(tokenRes.status === 200 && tokens.access_token?.startsWith('scp_at_') && tokens.refresh_token?.startsWith('scp_rt_'), 'code exchanged for tokens', tokens);
const mcpPost = (bearer) =>
  fetch(`${BASE}/mcp/${slug}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
check((await mcpPost(tokens.access_token)).status === 200, 'OAuth access token works on MCP');
check((await api('GET', '/api/v1/auth/me', undefined, { Authorization: `Bearer ${tokens.access_token}` })).status === 401, 'OAuth token is refused on /api/v1');
const grants = await api('GET', '/api/v1/oauth/grants');
check(grants.status === 200 && grants.json.grants.length === 1, 'grant listed as a connected app', grants.json);
check((await api('DELETE', `/api/v1/oauth/grants/${grants.json.grants[0].grantId}`)).status === 204, 'grant revoked');
check((await mcpPost(tokens.access_token)).status === 401, 'revoked OAuth token is rejected on MCP');
check((await api('GET', '/api/v1/auth/oidc/start')).status === 404, 'OIDC start is 404 while unconfigured');

// 9. v2: nested groups flow through a restricted key; marketplace export
const tip = await api('POST', '/api/v1/items', { kind: 'prompt', name: `tip-${id}`, content: 'Summarize {{text}} in one line.' });
check(tip.status === 201, 'create prompt for the base group', tip.json);
const baseSlug = `${slug}-base`;
const base = await api('POST', '/api/v1/groups', { slug: baseSlug, name: `Base ${id}` });
check(base.status === 201, 'create base group', base.json);
check((await api('POST', `/api/v1/groups/${baseSlug}/members`, { itemId: tip.json.item.id })).status === 201, 'add prompt to base group');
const inc = await api('POST', `/api/v1/groups/${slug}/includes`, { slug: baseSlug });
check(inc.status === 201 && inc.json.group.includes?.some((g) => g.slug === baseSlug), 'include base group', inc.json);
const viaMember = inc.json.group.members.find((m) => m.item.id === tip.json.item.id);
check(viaMember?.via === baseSlug, 'included member shows via', viaMember);
const manifest2 = await api('GET', `/api/v1/groups/${slug}/manifest`, undefined, auth);
check(manifest2.status === 200 && manifest2.json.items.some((i) => i.name === `tip-${id}`), 'restricted key sees the included member in the manifest', manifest2.json);
check((await api('POST', `/api/v1/groups/${baseSlug}/includes`, { slug })).status === 409, 'include cycle is 409');
const market = await api('GET', `/m/${key.json.token}/marketplace.json`);
const plugin = market.json?.plugins?.find((p) => p.name === slug);
// No sha256 pin: the listing builds no zip (groups/marketplace.ts); the version is a UTC clock of the latest change.
check(
  market.status === 200 && plugin?.source?.source === 'archive' && plugin.source.url.endsWith(`/m/${key.json.token}/${slug}/plugin.zip`) && /^\d{8}\.\d{9}$/.test(plugin.version),
  'marketplace.json lists the group as an archive plugin',
  market.json,
);
const pz = await api('GET', `/m/${key.json.token}/${slug}/plugin.zip`);
check(pz.status === 200, 'plugin.zip downloads');
const pzFiles = unzipSync(pz.bytes);
for (const p of ['.claude-plugin/plugin.json', `skills/smoke-skill-${id}/SKILL.md`, `agents/reviewer-${id}.md`, '.mcp.json']) check(p in pzFiles, `plugin.zip contains ${p}`, Object.keys(pzFiles));
check(strFromU8(pzFiles['.mcp.json']).includes(key.json.token), 'plugin .mcp.json carries the key');
check((await api('GET', `/m/scp_not_a_key/marketplace.json`)).status === 404, 'unknown marketplace token is 404');

// 10. v2: pack import creates many items and a group, with provenance
const packZip = zipSync({
  [`pack/skills/alpha-${id}/SKILL.md`]: strToU8(`---\nname: alpha-${id}\ndescription: Alpha skill from a pack.\n---\n# Alpha\n`),
  [`pack/agents/beta-${id}.md`]: strToU8(`---\nname: beta-${id}\ndescription: Beta agent from a pack.\n---\nYou are beta.\n`),
  [`pack/prompts/gamma-${id}.md`]: strToU8('Say gamma.\n'),
});
const packForm = new FormData();
packForm.set('file', new Blob([packZip], { type: 'application/zip' }), `pack-${id}.zip`);
packForm.set('group', `pack-${id}`);
const pack = await api('POST', '/api/v1/items/import/pack', packForm);
check(pack.status === 201 && pack.json.items?.length === 3 && pack.json.group?.slug === `pack-${id}`, 'pack import creates 3 items and a group', pack.json);
check(pack.json.items.every((i) => i.source?.kind === 'zip' && i.source.commit?.length === 64), 'pack items record zip provenance', pack.json.items?.map((i) => i.source));
check((await api('POST', `/api/v1/items/${pack.json.items[0].id}/source/check`)).status === 404, 'source check is 404 for a zip source');

// 11. cleanup checks: key revocation stops MCP
await api('DELETE', `/api/v1/keys/${key.json.key.id}`);
const dead = await fetch(`${BASE}/mcp/${slug}`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
check(dead.status === 401, 'revoked key is rejected on MCP');
console.log(`\nall ${step} checks passed against ${BASE}`);
