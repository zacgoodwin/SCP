# SCP implementation stack: verified versions and working patterns

Verified 2026-10-20 on Windows, Node **v24.18.0**, by installing the packages
into a scratch project and running probe scripts. Every snippet below either
ran as written or is a direct excerpt of code that ran. Probe output is quoted
where it settles a question.

Version rule: each pin is the newest release published **on or before
2026-10-06** (at least 2 weeks before 2026-10-20), taken from `npm view <pkg> time`.

## 1. Pinned versions

| Package | Pin | Published | Latest today | Why not latest |
|---|---|---|---|---|
| node (runtime) | 24.18.0 | - | - | Docker tags `node:24.18.0-bookworm-slim` and `node:24.18.0-alpine` both exist (`docker manifest inspect`) |
| @modelcontextprotocol/sdk | **1.32.1** | 2026-10-05 | 1.32.1 | - |
| hono | **4.13.13** | 2026-10-04 | 4.13.13 | - |
| @hono/node-server | **2.1.3** | 2026-09-29 | 2.1.5 (10-13) | 2.1.4/2.1.5 too new |
| zod | **4.6.5** | 2026-09-13 | 4.6.7 (10-12) | too new |
| react / react-dom | **19.3.0** | 2026-09-09 | 19.3.1 | 19.3.1 too new |
| @types/react / @types/react-dom | **19.3.0** | 2026-09-09 | 19.3.0 | - |
| react-router | **8.4.0** | 2026-09-15 | 8.5.0 (10-19) | too new |
| vite | **8.3.2** | 2026-10-01 | 8.3.4 (10-08) | too new |
| @vitejs/plugin-react | **6.1.2** | 2026-10-05 | 6.1.2 | - |
| typescript | **7.0.2** | 2026-07-08 | 7.0.2 | - (native Go compiler; `tsc --version` -> `Version 7.0.2`) |
| @types/node | **24.19.1** | (24.x line) | 26.6.5 | match the Node 24 runtime, not latest; 24.19.2 is 10-09, too new |
| fflate | **0.8.3** | 2026-05-16 | 0.8.3 | - |
| yaml | **2.9.1** | 2026-09-11 | 2.9.1 | - |
| vitest (optional) | 5.0.3 | 2026-09-30 | 5.0.5 | prefer `node:test` (built in), see section 9 |
| @modelcontextprotocol/ext-apps | 2.0.3 | 2026-09-25 | 2.0.3 | only if the server needs its helpers; see section 2.8 |
| gray-matter | **not used** | 2021-04-24 | 4.0.3 | executes JS frontmatter, see section 6 |
| tsx | **not used** | - | 4.23.15 | Node 24 strips types natively, see section 8 |

Server `package.json` deps (exact pins, `"type": "module"` is required):

```json
{
  "type": "module",
  "engines": { "node": ">=24.18.0" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.32.1",
    "hono": "4.13.13",
    "@hono/node-server": "2.1.3",
    "zod": "4.6.5",
    "fflate": "0.8.3",
    "yaml": "2.9.1"
  },
  "devDependencies": {
    "typescript": "7.0.2",
    "@types/node": "24.19.1"
  }
}
```

Web `package.json`:

```json
{
  "type": "module",
  "dependencies": { "react": "19.3.0", "react-dom": "19.3.0", "react-router": "8.4.0" },
  "devDependencies": {
    "vite": "8.3.2", "@vitejs/plugin-react": "6.1.2", "typescript": "7.0.2",
    "@types/react": "19.3.0", "@types/react-dom": "19.3.0"
  }
}
```

Note: `@modelcontextprotocol/sdk@1.32.1` itself depends on `hono ^4.11.4` and
`@hono/node-server ^1.19.9 || ^2.0.5` (plus express 5, ajv, jose, cors). Pinning
hono 4.13.13 and node-server 2.1.3 at top level dedupes with the SDK's copy.
It also pulls `express`; that is unused weight, not a conflict.

Sources: `npm view <pkg> version time --json`; https://www.npmjs.com/package/@modelcontextprotocol/sdk

## 2. MCP server: @modelcontextprotocol/sdk 1.32.1

### 2.1 Which transport

`dist/esm/server/` ships two Streamable HTTP server transports:

- `webStandardStreamableHttp.js` -> `WebStandardStreamableHTTPServerTransport`.
  Takes a Web `Request`, returns a Web `Response`. **This is the one for Hono**:
  `transport.handleRequest(c.req.raw, { authInfo })`.
- `streamableHttp.js` -> `StreamableHTTPServerTransport`. Node `IncomingMessage`
  / `ServerResponse` wrapper around the web one, for Express.

Use the web-standard one. No Node req/res adapters needed.

Constructor options (from `webStandardStreamableHttp.d.ts`):

| Option | Meaning |
|---|---|
| `sessionIdGenerator?: () => string` | **Omit / `undefined` = stateless mode** (no `Mcp-Session-Id`, no session validation) |
| `enableJsonResponse?: boolean` | `true` -> plain JSON responses instead of SSE. Use `true` for stateless request/response |
| `eventStore?` | resumability; skip |
| `allowedHosts` / `allowedOrigins` / `enableDnsRebindingProtection` | **deprecated**, do host/origin checks in middleware |
| `keepAliveMs` | SSE keep-alive, default 15000 |
| `maxRequestBodySize` | default 4 MiB, answers 413 above it |

`handleRequest(req: Request, options?: { parsedBody?: unknown; authInfo?: AuthInfo }): Promise<Response>`

### 2.2 Stateless means one server + one transport PER REQUEST

Verified: reusing a single stateless transport fails on the second request.

```
shared stateless req 0 200 {"result":{"protocolVersion":"2025-06-18",...
Error: Stateless transport cannot be reused across requests. Create a new transport per request.
shared stateless req 1 500 Internal Server Error
```

So build `McpServer` + transport inside the route handler. This is also what
makes per-group / per-token tool sets trivial: the tool list is computed from
the group the request targets, with no `sendToolListChanged` bookkeeping.

### 2.3 Working Hono mount with bearer auth (ran end to end)

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';

const app = new Hono();

app.all('/mcp/:group', async (c) => {
  const h = c.req.header('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const principal = await lookupToken(token);          // SCP: hash + DB lookup
  if (!principal) return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });

  const authInfo: AuthInfo = {
    token, clientId: principal.tokenId, scopes: principal.scopes,
    extra: { userId: principal.userId, group: c.req.param('group') },
  };
  const server = buildServer(authInfo);                 // new per request
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw, { authInfo });
});

serve({ fetch: app.fetch, port: 8080 });
```

Probe result: no token -> `401`; with `Bearer good`, client `listTools`,
`callTool`, `listResourceTemplates`, `listResources`, `readResource`,
`complete`, `getPrompt` all succeeded.

`app.all` is needed: Streamable HTTP uses POST (messages), GET (optional SSE
stream) and DELETE (session end). In stateless JSON mode only POST matters;
the transport answers GET/DELETE itself.

### 2.4 Reading auth inside handlers

Every callback gets `extra: RequestHandlerExtra` (`shared/protocol.d.ts`) with:

- `extra.authInfo?: AuthInfo` (whatever was passed to `handleRequest`)
- `extra.requestInfo?.headers` (raw request headers) and URL
- `extra.signal: AbortSignal`, `extra.sessionId?` (undefined in stateless)

`AuthInfo` (`server/auth/types.d.ts`):

```ts
interface AuthInfo {
  token: string; clientId: string; scopes: string[];
  expiresAt?: number;          // seconds since epoch
  resource?: URL;              // RFC 8707
  extra?: Record<string, unknown>;
}
```

Since the server is built per request, the closure already holds the
principal; `extra.authInfo` is the SDK-native path and works too (verified:
tool returned `{"user":"u1","scopes":["read","write"]}` from `extra.authInfo`).

Pattern for SCP: the HTTP layer authenticates (401 before MCP sees anything),
the MCP layer authorizes per tool (e.g. `write_artifact` requires scope
`artifacts:write`).

### 2.5 registerTool (zod raw shape)

Signature (`server/mcp.d.ts`):

```ts
registerTool(name: string, config: {
  title?: string; description?: string;
  inputSchema?: ZodRawShape | AnySchema;
  outputSchema?: ZodRawShape | AnySchema;
  annotations?: ToolAnnotations;   // readOnlyHint, destructiveHint, idempotentHint, openWorldHint
  _meta?: Record<string, unknown>; // MCP Apps puts { ui: { resourceUri } } here
}, cb: (args, extra) => CallToolResult | Promise<CallToolResult>): RegisteredTool
```

`RegisteredTool` has `enable() / disable() / update({...}) / remove()`.
Deprecated: `server.tool(...)`, `server.resource(...)`, `server.prompt(...)`.

Verified example:

```ts
s.registerTool('whoami', {
  title: 'Who am I', description: 'Echo auth',
  inputSchema: { greeting: z.string().optional() },
  outputSchema: { user: z.string(), scopes: z.array(z.string()) },
}, async ({ greeting }, extra) => {
  const out = { user: String(extra.authInfo?.extra?.userId), scopes: extra.authInfo?.scopes ?? [] };
  return { content: [{ type: 'text', text: `${greeting ?? 'hi'} ${out.user}` }], structuredContent: out };
});
```

Wire result:
`{"content":[{"type":"text","text":"yo u1"}],"structuredContent":{"user":"u1","scopes":["read","write"]}}`

When `outputSchema` is set, `structuredContent` must be returned and match it.
Errors: return `{ content: [...], isError: true }` for tool-level failures the
agent should see; throw only for protocol errors.

zod: SDK peer is `zod ^3.25 || ^4.0`; zod 4.6.5 worked with plain `import { z } from 'zod'`.

### 2.6 registerResource: static URI and ResourceTemplate

```ts
registerResource(name, uri: string,          config: ResourceMetadata, (uri: URL, extra) => ReadResourceResult)
registerResource(name, tpl: ResourceTemplate, config: ResourceMetadata, (uri: URL, vars: Variables, extra) => ReadResourceResult)

new ResourceTemplate(uriTemplate: string, {
  list: ListResourcesCallback | undefined,   // REQUIRED key, may be undefined
  complete?: { [variable]: (value, ctx?) => string[] | Promise<string[]> },
})
```

Verified:

```ts
s.registerResource('skill',
  new ResourceTemplate('skill://{slug}/SKILL.md', {
    list: async () => ({ resources: [{ uri: 'skill://pdf/SKILL.md', name: 'pdf', mimeType: 'text/markdown' }] }),
    complete: { slug: (v) => ['pdf', 'xlsx'].filter((x) => x.startsWith(v)) },
  }),
  { title: 'Skill', mimeType: 'text/markdown' },
  async (uri, { slug }) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `# ${slug}` }] }));

s.registerResource('readme', 'scp://readme', { mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.href, text: 'readme' }] }));
```

Results:
- `resources/templates/list` -> `[{"name":"skill","title":"Skill","uriTemplate":"skill://{slug}/SKILL.md","mimeType":"text/markdown"}]`
- `resources/list` -> `['scp://readme', 'skill://pdf/SKILL.md']` (static + template `list` merged)
- `resources/read skill://xlsx/SKILL.md` -> template matched, `slug = 'xlsx'`
- `completion/complete` with `ref: { type: 'ref/resource', uri: 'skill://{slug}/SKILL.md' }`, `argument: { name: 'slug', value: 'p' }` -> `{"values":["pdf"],"total":1,"hasMore":false}`

Binary content (zips, images): `contents: [{ uri, mimeType, blob: <base64> }]`.

Suggested SCP URI scheme (multi-file skills need a file path variable):
`skill://{slug}/SKILL.md`, `skill://{slug}/files/{+path}` (RFC 6570 reserved
expansion keeps slashes; confirm `{+path}` matching in a test before relying
on it), `md://{slug}`, `artifact://{id}`.

### 2.7 registerPrompt

```ts
registerPrompt(name, { title?, description?, argsSchema?: { [k]: ZodType<string> } },
  (args, extra) => GetPromptResult)
```

Verified:

```ts
s.registerPrompt('use-agent', { description: 'Load agent', argsSchema: { task: z.string() } },
  ({ task }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `task=${task}` } }] }));
```

-> `{"messages":[{"role":"user","content":{"type":"text","text":"task=build"}}]}`

Prompt args are strings on the wire; keep `argsSchema` to `z.string()` /
`z.string().optional()`. SCP's MD files (AGENTS.md, agent definitions,
snippets) map naturally to MCP prompts; expose them as resources too, since
many clients surface tools/resources better than prompts.

### 2.8 MCP Apps note

`registerTool` config accepts `_meta`, which is where MCP Apps
(`@modelcontextprotocol/ext-apps` 2.0.3) links a tool to a `ui://` HTML
resource. The UI resource is a plain `registerResource` with an HTML body, so
the core SDK is enough; the ext-apps package is optional. The exact `_meta`
key and MIME profile belong to the ext-apps research file; not re-verified here.

### 2.9 Test client (used by the probe, good for integration tests)

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'probe', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp/coding'),
  { requestInit: { headers: { Authorization: 'Bearer good' } } }));
await client.listTools(); await client.callTool({ name: 'whoami', arguments: { greeting: 'yo' } });
await client.close();
```

Raw curl equivalent (Accept must list both types):

```
curl -X POST http://localhost:8080/mcp/coding \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}'
```

## 3. node:sqlite (DatabaseSync) in Node 24.18

### 3.1 Status

- Stability **1.2, Release candidate** in Node 24 docs; history: "v24.15.0:
  SQLite is now a release candidate."
- **No flag.** "v23.4.0, v22.13.0: SQLite is no longer behind `--experimental-sqlite`".
- Verified: `node -e "require('node:sqlite')"` prints **no ExperimentalWarning** on 24.18.0.
- Bundled SQLite: `select sqlite_version()` -> **3.53.1**.
- **FTS5 is compiled in** (verified `CREATE VIRTUAL TABLE f USING fts5(...)` + `bm25()`).
- **JSON1 works** (verified `json_each`).
- Only importable with the `node:` prefix.
- No native addon, so `node:24-*-slim` / alpine images need no build toolchain.

Source: https://nodejs.org/docs/latest-v24.x/api/sqlite.html

### 3.2 API surface (from the prototype on 24.18)

`DatabaseSync.prototype`: `open, close, prepare, exec, function, aggregate,
createTagStore, location, createSession, applyChangeset, enableLoadExtension,
enableDefensive, loadExtension, serialize, deserialize, setAuthorizer`;
properties `isOpen`, `isTransaction`. Module also exports `backup()`.

`StatementSync.prototype`: `run, get, all, iterate, columns,
setAllowBareNamedParameters, setAllowUnknownNamedParameters, setReadBigInts,
setReturnArrays`.

Constructor `new DatabaseSync(path, options)` options (defaults): `open`
(true), `readOnly` (false), `enableForeignKeyConstraints` (**true**),
`enableDoubleQuotedStringLiterals` (false), `allowExtension` (false), `timeout`
(0, busy timeout ms), `readBigInts` (false), `returnArrays` (false),
`allowBareNamedParameters` (true), `allowUnknownNamedParameters` (false),
`defensive` (true), `limits`.

There is **no transaction helper**; use `exec('BEGIN')` / `COMMIT` / `ROLLBACK`.

### 3.3 Verified snippet and output

```ts
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/data/scp.db', { timeout: 5000 });
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');

db.exec('CREATE TABLE skill (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, body TEXT, tags TEXT)');
const ins = db.prepare('INSERT INTO skill (slug, body, tags) VALUES (?, ?, ?)');
ins.run('pdf', 'hello', JSON.stringify(['docs']));          // { changes: 1, lastInsertRowid: 1 }

db.prepare('SELECT id, slug FROM skill').all();             // [{ id: 1, slug: 'pdf' }]
db.prepare('SELECT * FROM skill WHERE slug = :slug').get({ slug: 'pdf' }); // named params, bare key ok
db.prepare('SELECT * FROM skill WHERE slug = ?').get('nope');               // undefined
```

Observed:

- `run()` returns `{ changes, lastInsertRowid }` (numbers unless `readBigInts`).
- Rows are `[Object: null prototype] {...}`. Fine for JSON, but `toEqual` /
  `deepStrictEqual` against `{}` literals can fail on prototype. Spread
  (`{...row}`) in the repo layer if tests compare objects.
- `get()` miss returns `undefined`.
- File DB: `PRAGMA journal_mode=WAL` returns `{ journal_mode: 'wal' }` (in-memory reports `memory`).
- Constraint error shape: `e.code === 'ERR_SQLITE_ERROR'`, `e.errcode === 2067`
  (SQLITE_CONSTRAINT_UNIQUE), `e.message === 'UNIQUE constraint failed: skill.slug'`.
  Map `errcode 2067` -> HTTP 409.

### 3.4 Transaction helper (write it once in the DB module)

Verified rollback path:

```ts
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');      // IMMEDIATE: take the write lock up front, avoids upgrade deadlocks
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
}
```

`fn` must be synchronous (DatabaseSync is sync; awaiting inside a transaction
would interleave other requests' statements on the same connection).

### 3.5 Recommended pragmas and setup

```sql
PRAGMA journal_mode = WAL;      -- persistent per DB file
PRAGMA synchronous = NORMAL;    -- safe with WAL
PRAGMA foreign_keys = ON;       -- already on by default via enableForeignKeyConstraints
PRAGMA busy_timeout = 5000;     -- or constructor { timeout: 5000 }
```

One `DatabaseSync` per process is enough (single Node process, sync API).
Migrations: a `schema_version` via `PRAGMA user_version`, ordered SQL strings
applied in `tx()` at boot. No migration library needed.

Docker: the DB file and its `-wal` / `-shm` siblings must sit on the same
volume (`/data`). Do not bind-mount a Windows host folder for `/data` on
Docker Desktop; WAL relies on shared-memory locking that host bind mounts can
break. Use a named volume.

Backup: `backup(db, '/data/backup.db')` from `node:sqlite`, or
`VACUUM INTO '/data/backup.db'`.

## 4. Hono 4.13.13 + @hono/node-server 2.1.3

### 4.1 Server and static SPA (verified)

`@hono/node-server` 2.x exports: `.` (`serve`), `./serve-static`,
`./conninfo`, `./early-hints`, `./utils/*`. Peer `hono ^4`, engines `node >=20`.

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

const app = new Hono();
app.route('/api', api);                          // JSON API first
app.all('/mcp/:group', mcpHandler);
app.use('/*', serveStatic({ root: './web/dist' }));          // real files
app.get('*', serveStatic({ path: './web/dist/index.html' })); // SPA fallback
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
```

Probe results:

```
/              200 text/html          <!doctype html><div id=root>SPA</div>
/assets/app.js 200 text/javascript    console.log(1)
/groups/abc    200 text/html          <!doctype html><div id=root>SPA</div>   (fallback)
/api/health    200 application/json   {"ok":true}
```

`ServeStaticOptions`: `root`, `path`, `index`, `precompressed`,
`allowPercentInPath`, `rewriteRequestPath`, `onFound`, `onNotFound`.
`root` is relative to process cwd; set `WORKDIR` in the Dockerfile accordingly.

Order matters: register `/api/*`, `/mcp/*`, `/s/*` (public share) before the
static catch-all, or the SPA fallback swallows unknown API paths. Add
`app.all('/api/*', c => c.json({error:'not_found'},404))` after the API routes.

`serve()` returns the Node `http.Server` (`.close()` used in the probe);
`port: 0` gives an ephemeral port for tests via the callback's `info.port`.

### 4.2 Cookies (verified)

`hono/cookie` exports: `getCookie, setCookie, deleteCookie, getSignedCookie,
setSignedCookie, generateCookie, generateSignedCookie`.

```ts
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
setCookie(c, 'sid', sessionId, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60*60*24*30, secure: isHttps });
getCookie(c, 'sid');            // string | undefined
deleteCookie(c, 'sid', { path: '/' });
```

Wire: `sid=abc; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax`.

Use an opaque random session id stored in a `session` table (revocable),
not a signed payload. `secure` must be conditional: compose usually runs on
plain http://localhost first, where a `Secure` cookie is dropped by browsers.

### 4.3 Multipart (verified)

```ts
app.post('/api/artifacts/upload', bodyLimit({ maxSize: 20 * 1024 * 1024 }), async (c) => {
  const body = await c.req.parseBody();          // Record<string, string | File>
  const f = body['file'];
  if (!(f instanceof File)) return c.json({ error: 'file required' }, 400);
  const bytes = new Uint8Array(await f.arrayBuffer());
  // f.name, f.size, f.type
});
```

Probe: `{ name: 'a.html', size: 10, type: 'text/html', title: 't' }`.
Repeated fields: `parseBody({ all: true })` returns arrays. File field names
with nested paths: `parseBody({ dot: true })`.

### 4.4 Built-in middleware worth using (present in `hono/dist/middleware`)

`body-limit` (`bodyLimit({ maxSize, onError })`), `cors`, `csrf` (Origin
check for cookie-auth mutating routes), `secure-headers`, `bearer-auth`,
`logger`, `request-id`, `etag`, `compress`, `timeout`. Import paths:
`hono/body-limit`, `hono/cors`, `hono/csrf`, `hono/secure-headers`, etc.

Do not use `bearer-auth` for SCP tokens: it compares against a static list.
SCP tokens are hashed in the DB, so a 10-line custom middleware is correct.

### 4.5 Artifact sandboxing (public share links)

Serve user/agent HTML artifacts from a path that the SPA's cookies cannot
reach in a useful way, and with a restrictive CSP:

```ts
c.header('Content-Security-Policy', "default-src 'self' data: blob: https:; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; sandbox allow-scripts allow-popups allow-forms");
```

`sandbox` without `allow-same-origin` gives the document an opaque origin, so
artifact scripts cannot read the SCP session cookie or call `/api` as the
user. A separate artifact origin (second hostname/port) is the stronger
option if deployed behind a real domain.

## 5. Web SPA: React 19.3.0 + Vite 8.3.2 + react-router 8.4.0

Verified with a real `vite build` (built in 125 ms, 313 kB JS / 99 kB gzip).

- react-router 8.4.0 peers: `react >=19.2.7`, `react-dom >=19.2.7`; engines `node >=22.22.0`.
- vite 8.3.2 engines: `node ^20.19.0 || >=22.12.0`.
- @vitejs/plugin-react 6.1.2 peer `vite ^8.0.0`; its other peers
  (`oxc-transform-react`, `@rolldown/plugin-babel`, `babel-plugin-react-compiler`)
  are all **optional** (`peerDependenciesMeta`), so no extra installs.
- Import everything from `react-router` (v7+ merged `react-router-dom` into it).

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8080', '/mcp': 'http://localhost:8080', '/s': 'http://localhost:8080' } },
});
```

`src/main.tsx` (data-router, library mode, no framework mode):

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Link, useParams } from 'react-router';

function Group() { const { id } = useParams(); return <p>group {id}</p>; }
const router = createBrowserRouter([
  { path: '/', element: <Link to='/groups/1'>g</Link> },
  { path: '/groups/:id', element: <Group /> },
]);
createRoot(document.getElementById('root')!).render(<StrictMode><RouterProvider router={router} /></StrictMode>);
```

Use library/data mode, not React Router "framework mode" (that brings its own
Vite plugin, SSR server and build pipeline; SCP's server is Hono).

No UI kit is required for a small CRUD SPA; plain CSS (or one classless CSS
file) keeps the bundle and the build simple. Markdown preview in the browser
can wait until it is asked for.

## 6. Frontmatter: use `yaml`, not `gray-matter`

Decision: **`yaml@2.9.1` + a 4-line splitter.**

Reasons, verified:

1. **gray-matter executes code.** Its `javascript` engine does
   `eval(str)` (`lib/engines.js:43`) and is selected by the opening fence
   `---js`. Probe: `matter('---js\n({x: (globalThis.PWNED=1, 2)})\n---\nbody')`
   returned `{ x: 2 }` and set `globalThis.PWNED = 1`. SCP ingests MD files
   written by agents and users, so this is remote code execution on upload.
2. gray-matter's last release is 4.0.3 from **2021-04-24**, and it pins
   `js-yaml@3.15.2` (old major).
3. `yaml` is maintained (2.9.1, 2026-09-11), zero deps, YAML 1.2, and also
   gives `stringify` for writing frontmatter back.

```ts
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export function parseFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = parseYaml(m[1]) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter must be a mapping');
  return { data, body: m[2] };
}
export const toFrontmatter = (data: object, body: string) => `---\n${stringifyYaml(data)}---\n${body}`;
```

Verified: `{ data: { name: 'pdf', description: 'd' }, body: 'body' }`;
`stringifyYaml({ name: 'x', tags: ['a'] })` -> `"name: x\ntags:\n  - a\n"`.
The `\r?\n` handles CRLF files (common on this Windows machine).

Validate the parsed `data` with zod at the boundary (Agent Skills require
`name` + `description`; SCP-specific keys like `tags` optional). Consider
`parseYaml(text, { maxAliasCount: 100 })` (default already caps alias
expansion, which blocks billion-laughs).

## 7. Zip: fflate 0.8.3

Pure JS, no deps, sync and async APIs, works in Node and browser.
Version note: 0.8.3 was published 2026-05-16 after a two-year gap (0.8.2 was
2024-02-07); API unchanged from 0.8.x.

Verified:

```ts
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

const zip = zipSync({
  'pdf/SKILL.md': strToU8('---\nname: pdf\ndescription: d\n---\nbody'),
  'pdf/scripts/a.py': strToU8('print(1)'),
}, { level: 6 });                                  // Uint8Array, 277 bytes here
const files = unzipSync(zip);                      // { 'pdf/SKILL.md': Uint8Array, ... }
strFromU8(files['pdf/SKILL.md']);
```

API summary:

| Need | Call |
|---|---|
| build zip in memory | `zipSync(tree, { level })`, tree is `{ path: Uint8Array \| [Uint8Array, opts] }` or nested objects |
| extract | `unzipSync(u8, { filter?: (file) => boolean })`, `file` has `name`, `size`, `originalSize`, `compression` |
| non-blocking | `zip(tree, opts, cb)` / `unzip(u8, opts, cb)` (worker-based) |
| streaming | `new Zip(cb)` + `ZipDeflate` / `ZipPassThrough`; `new Unzip()` + `UnzipInflate` |
| strings | `strToU8`, `strFromU8` |

Serving a group/skill as a download from Hono:

```ts
return new Response(zipSync(tree), { headers: {
  'Content-Type': 'application/zip',
  'Content-Disposition': `attachment; filename="${slug}.zip"`,
}});
```

Upload safety (must implement, trust boundary):

- Use `unzipSync(u8, { filter })` to reject before inflating: total
  `originalSize` cap (zip bomb), entry count cap, per-file cap.
- Normalize every name and reject `..` segments, absolute paths, backslashes,
  and drive letters (zip-slip). SCP stores files in SQLite rows, not on disk,
  but the paths get re-served and re-zipped to agents who write them to disk.
- Strip a single common top-level folder so `pdf.zip` with `pdf/SKILL.md` and
  one with `SKILL.md` at root both import.

## 8. TypeScript execution: native type stripping, no tsx

Verified on 24.18.0: `node main.ts` runs TypeScript directly.

```
$ node main.ts         # imports './lib.ts' and a type from the MCP SDK
3 t strip              # process.features.typescript === 'strip'
```

Rules this imposes:

- Package needs `"type": "module"` (without it: `SyntaxError: Cannot use import statement outside a module`).
- Relative imports use the `.ts` extension: `import { add } from './lib.ts'`.
- Only erasable syntax: **no `enum`, no `namespace`, no parameter properties**
  (verified: `enum E { A }` fails). Use `as const` objects / union types.
- Use `import type` for type-only imports.

tsconfig for the server (typecheck only, Node runs the sources):

```json
{
  "compilerOptions": {
    "target": "es2024", "module": "nodenext", "moduleResolution": "nodenext",
    "noEmit": true, "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true, "verbatimModuleSyntax": true,
    "strict": true, "skipLibCheck": true, "types": ["node"]
  }
}
```

Verified with TypeScript 7.0.2 (native Go compiler) + @types/node 24.19.1:
this config typechecks `main.ts` / `lib.ts` (`.ts` imports, SDK type import)
cleanly and rejects the enum file with
`TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.`
Fallback pin if a later TS 7 option gap appears: `typescript@6.0.3`
(2026-04-16). The runtime does not care, since Node never invokes tsc.

Result: the Docker runtime image needs no build step for the server, only
`npm ci --omit=dev` and the built SPA `dist/`.

## 9. Tests: node:test

`node:test` + `node:assert/strict` are built in and run `.ts` files directly
under type stripping: `node --test "server/**/*.test.ts"`. That keeps the
gate dependency-free and fast. The MCP integration test pattern is the probe
in section 2.9: `serve({ port: 0 })`, real `Client`, assert, `server.close()`.
vitest 5.0.3 is the alternative only if the SPA needs component tests.

## 10. Password hashing: node:crypto scrypt (verified)

```ts
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384, r = 8, p = 1, KEYLEN = 64;   // ~16 MiB, under the 32 MiB default maxmem

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw.normalize('NFKC'), salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, r_, p_, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64url');
  const got = scryptSync(pw.normalize('NFKC'), Buffer.from(s, 'base64url'), expected.length,
    { N: +n, r: +r_, p: +p_ });
  return timingSafeEqual(got, expected);   // lengths equal by construction; unequal lengths would throw
}
```

Probe: correct password -> true, wrong -> false, stored form
`scrypt$16384$8$1$<salt>$<hash>`. Params live in the string so they can be
raised later without breaking old hashes (rehash on next login).

`scryptSync` blocks the event loop for ~50 ms at N=16384. Fine for login on a
small app; switch to the promisified async `scrypt` if login volume grows.
If N goes to 2^17 or higher, pass `maxmem` (needed bytes are about 128 * N * r).

Agent API tokens are different: random 32 bytes, shown once, stored as
`sha256(token)` hex. They are high-entropy, so a fast hash is correct and lets
the lookup be an indexed `WHERE token_hash = ?` instead of scanning.

```ts
import { createHash, randomBytes } from 'node:crypto';
const token = 'scp_' + randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');
```

Session ids: `randomBytes(32).toString('base64url')`, stored hashed the same way.

## 11. Dockerfile sketch (fits the verified pieces)

```dockerfile
FROM node:24.18.0-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build                      # vite build -> /app/web/dist

FROM node:24.18.0-bookworm-slim
ENV NODE_ENV=production PORT=8080 SCP_DB=/data/scp.db
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/ ./server/
COPY --from=web /app/web/dist ./web/dist
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/main.ts"]
```

`USER node` needs `/data` writable by uid 1000: `RUN mkdir /data && chown node:node /data`
before `VOLUME`. No `python3`/`make`/`g++` layer is needed because nothing is
native (node:sqlite is built in, fflate and yaml are pure JS).

compose:

```yaml
services:
  scp:
    build: .
    ports: ["8080:8080"]
    environment:
      SCP_PUBLIC_URL: http://localhost:8080
      SCP_ADMIN_EMAIL: admin@example.com
      SCP_ADMIN_PASSWORD: change-me
    volumes: ["scp-data:/data"]
volumes:
  scp-data: {}
```

## 12. Pitfalls found during verification

| Pitfall | Evidence | Fix |
|---|---|---|
| Reusing a stateless MCP transport | `Stateless transport cannot be reused across requests` -> 500 | new `McpServer` + transport per request |
| gray-matter `---js` frontmatter runs `eval` | probe set `globalThis.PWNED = 1` | use `yaml` + splitter |
| Native TS without `"type": "module"` | `SyntaxError: Cannot use import statement outside a module` | set `"type": "module"` |
| `enum` under type stripping | fails to run | `as const` objects; `erasableSyntaxOnly` in tsconfig catches it at typecheck |
| node:sqlite rows have null prototype | `[Object: null prototype] {...}` | spread rows in the repo layer when comparing in tests |
| SPA fallback catches API 404s | `get('*')` serves index.html for any GET | API routes + explicit `/api/*` 404 before static |
| `Secure` cookie on http://localhost | browsers drop it | derive `secure` from `SCP_PUBLIC_URL` scheme |
| Missing `Accept: application/json, text/event-stream` on raw POSTs | Streamable HTTP spec requires both | document it in the agent quick-start curl |
| Windows bind mount for `/data` | WAL needs working shared-memory locks | named volume |

## Sources

- https://www.npmjs.com/package/@modelcontextprotocol/sdk (1.32.1); type defs read from the installed `dist/esm/server/{mcp,webStandardStreamableHttp}.d.ts`, `server/auth/types.d.ts`, `shared/protocol.d.ts`
- https://github.com/modelcontextprotocol/typescript-sdk
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports (Streamable HTTP)
- https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- https://hono.dev/docs/getting-started/nodejs , https://hono.dev/docs/helpers/cookie , https://hono.dev/docs/api/request#parsebody , https://github.com/honojs/node-server
- https://vite.dev/guide/ , https://reactrouter.com/start/data/installation
- https://github.com/101arrowz/fflate
- https://eemeli.org/yaml/ ; https://github.com/jonschlinkert/gray-matter (`lib/engines.js`)
- https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback
- https://nodejs.org/docs/latest-v24.x/api/typescript.html
- Probe scripts: `C:/Users/zacgo/AppData/Local/Temp/claude/c--Users-zacgo-GitHub-SCP/c96c08f0-2166-4325-8b0c-552563b02c54/scratchpad/stk/probe.mjs`, `probe2.mjs`
