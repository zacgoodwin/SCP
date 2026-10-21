# Artifacts and MCP Apps: research for SCP

Researched 2026-10-20. Scope: how Claude Artifacts behave (types, sharing, sandboxing), the
MCP Apps extension (`@modelcontextprotocol/ext-apps`), and how SCP should (a) expose stored
HTML artifacts as MCP Apps and (b) render and publicly share them from its own web app.

Verified locally: npm registry versions, package `.d.ts` signatures (tarball of 2.0.3),
the repo spec files, the reference host's sandbox code, and one headless-Chrome CSP test
(section 8.4). Everything else is cited.

## 0. Sources

| Source | URL |
|---|---|
| Claude: what are artifacts | https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them |
| Claude: publish and share artifacts | https://support.claude.com/en/articles/9547008-publish-and-share-artifacts |
| ext-apps repo (README, examples, docs) | https://github.com/modelcontextprotocol/ext-apps |
| MCP Apps spec, stable 2026-01-26 | https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx |
| MCP Apps spec, draft | https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx |
| SEP-1865 discussion | https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1865 |
| API docs | https://apps.extensions.modelcontextprotocol.io/api/ |
| CSP and CORS guide | https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/csp-cors.md |
| Migrate 1.x to 2.x | https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/migrate-to-2.md |
| Patterns guide | https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/patterns.md |
| Reference host sandbox | https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host (`src/sandbox.ts`, `serve.ts`) |
| Claude: get started with MCP Apps | https://claude.com/docs/connectors/building/mcp-apps/getting-started |
| Claude: MCP Apps quickstart (no build step) | https://claude.com/docs/connectors/building/mcp-apps/quickstart |
| Claude: troubleshoot MCP Apps | https://claude.com/docs/connectors/building/mcp-apps/troubleshooting |
| MCP-UI (community host/client SDK) | https://github.com/idosal/mcp-ui |

---

## 1. Claude Artifacts: what SCP should copy

### 1.1 Types

From the help center article:

- Content: documents, code snippets, single-page websites, images, diagrams and flowcharts,
  dashboards, small interactive tools.
- Templates: Docs, Slides, Design (all plans), Dashboards (beta), Motion (beta, Team/Enterprise).
- Heuristic for when to make one: content that is "significant and self-contained, typically
  over 15 lines" and likely to be edited or reused.
- Exports: Docs to Word/PDF/Markdown/Google Docs; Slides to PowerPoint/PDF/Google Slides;
  Designs to .zip/PDF/PowerPoint/standalone HTML; Motion to MP4.

The legacy Claude artifact renderer distinguished these render kinds: code, Markdown document,
single-file HTML, SVG, Mermaid diagram, React component. SCP's `kind` enum should cover the same
set plus the user's list (UI component, design, deck, document, dashboard, tool). Proposed enum in
section 7.

### 1.2 Sharing and publishing

From https://support.claude.com/en/articles/9547008-publish-and-share-artifacts:

- Artifacts **start private**. Publishing is explicit.
- Free/Pro/Max publish: "Anyone with the link can view and use it without a Claude account."
  Sign-up only needed for AI-powered features.
- Team/Enterprise: shared within the org; "anyone with the link" only when an owner enables
  external sharing.
- Newer artifacts: a Share menu with access by person or by link (org, invitees, anyone with link),
  roles Viewer / Commenter / Can edit.
- **Unpublish revokes access**. Legacy quirk: cannot republish after unpublishing, and unpublishing
  deletes the artifact's stored data. SCP should NOT copy the "can't republish" quirk: revoke a
  token, mint a new one.
- **Embedding**: "Get embed code" with an "Allowed domains" list (comma separated) of sites allowed
  to iframe the artifact. Maps directly to a per-share `frame-ancestors` CSP list.
- Remix: signed-in viewers can "copy and save" a published artifact (a fork, separate from the
  original). Warned: "Only open shared artifacts from people you trust."
- The help pages don't say whether a link pins a version or follows the latest. SCP should support
  both (section 7.2).

### 1.3 Sandbox and limits

- Artifact storage: 20 MB per artifact, text only; personal vs shared storage are separate.
- Artifacts that use connectors use the **viewer's** connections, not the author's.
- Artifacts can call Claude using the viewer's account and quota (no API keys).
- The help pages don't describe network restrictions. In practice (observed in Claude Code's
  Artifact publishing contract, not a public doc): scripts only from `cdnjs.cloudflare.com`,
  `cdn.jsdelivr.net/npm/`, `unpkg.com`, `cdn.tailwindcss.com`, `code.jquery.com`, with pinned
  versions; stylesheets only from Google Fonts; everything else inline; 16 MB page cap; browser
  storage per artifact origin, which can throw, so pages wrap it in try/catch. This is a good
  default CDN allowlist for SCP.

**SCP takeaways:** private by default; explicit publish producing an unguessable link; revocable;
optional embed-domain allowlist; fork/copy; CDN allowlist; size cap; each artifact runs in an
isolated origin.

---

## 2. MCP Apps: identity and versions

| Item | Value |
|---|---|
| Extension id | `io.modelcontextprotocol/ui` (SDK const `EXTENSION_ID`) |
| Spec | SEP-1865, **Stable 2026-01-26**; `draft` adds more methods (section 4.4) |
| Protocol version string sent in `ui/initialize` | `"2026-01-26"` (SDK `LATEST_PROTOCOL_VERSION`) |
| Resource URI scheme | `ui://` (reserved for MCP Apps) |
| Resource MIME type | `text/html;profile=mcp-app` (SDK `RESOURCE_MIME_TYPE`) |
| Tool linkage | `_meta.ui.resourceUri` (legacy flat key `_meta["ui/resourceUri"]`, SDK `RESOURCE_URI_META_KEY`, deprecated, "removed before GA") |
| npm package | `@modelcontextprotocol/ext-apps` **2.0.3** (latest, published 2026-09-28; dist-tags `latest` and `release-2.0` both 2.0.3) |
| Last 1.x | 1.7.5 |
| License | Apache-2.0 |

### 2.1 Package exports (2.0.3)

| Subpath | Purpose |
|---|---|
| `@modelcontextprotocol/ext-apps` | View side: `App` class, `PostMessageTransport` |
| `@modelcontextprotocol/ext-apps/react` | `useApp`, `useHostStyles`, `useHostFonts`, etc. |
| `@modelcontextprotocol/ext-apps/app-bridge` | Host side: `AppBridge` (embed Views in a chat client) |
| `@modelcontextprotocol/ext-apps/server` | `registerAppTool`, `registerAppResource`, `getUiCapability`, `EXTENSION_ID`, `RESOURCE_MIME_TYPE`, `RESOURCE_URI_META_KEY` |
| `@modelcontextprotocol/ext-apps/app-with-deps` | Prebundled View client (client+core+zod), about 409 KB, for CDN/no-bundler use |
| `@modelcontextprotocol/ext-apps/react-with-deps` | Same for React |
| `@modelcontextprotocol/ext-apps/schema.json` | JSON Schema of all wire types |

### 2.2 Peer dependencies: pick the SDK line once

2.x peers (from `npm view`): `@modelcontextprotocol/server ^2.0.0`, `@modelcontextprotocol/client ^2.0.0`,
`@modelcontextprotocol/core ^2.0.0`, `zod ^4.2.0`, React 17/18/19 (optional). Current versions:
`@modelcontextprotocol/server` 2.3.1, `core` 2.3.1, `node` 2.1.1, `express` 2.0.2.

- **ext-apps 2.x pairs with the split SDK 2.x** (`@modelcontextprotocol/server` + `node` + `express`).
- **ext-apps 1.x pairs with the monolithic `@modelcontextprotocol/sdk` 1.x** (latest 1.32.1). Claude's
  own quickstart is verified with `ext-apps@1.7.5` + `sdk@1.30.1`.
- The two SDK lines "share no classes or types". Do not mix them in one process.
- **The wire protocol is byte-identical between 1.x and 2.x**, so a host on either line renders Views
  from either line.
- 2.x drops zod 3 and requires zod >= 4.2 (Standard JSON Schema `~standard.jsonSchema`). Raw zod shapes
  in `inputSchema` are deprecated; wrap in `z.object({...})`.
- 2.x handler context: `extra.signal` becomes `extra.mcpReq.signal`, `extra.requestId` becomes
  `extra.mcpReq.id`, `extra.authInfo` becomes `extra.http?.authInfo`.
- Node 20+ required.

**Recommendation for SCP:** ext-apps 2.0.3 + `@modelcontextprotocol/server@^2` + `node@^2` +
`express@^2` + `zod@^4.2`. Pin exact versions in package.json. The rest of SCP's MCP endpoint
(skills/prompts tools) must use the same SDK line.

Install line (from README):

```bash
npm install -S @modelcontextprotocol/ext-apps @modelcontextprotocol/client@^2.0.0 \
  @modelcontextprotocol/server@^2.0.0 @modelcontextprotocol/node@^2.0.0 \
  @modelcontextprotocol/express@^2.0.0 zod@^4.2.0
```

---

## 3. Supported clients (hosts that render MCP Apps)

From the README "Supported Clients" badges: **ChatGPT**, **Claude** (web and Desktop, iOS via
WKWebView), **VS Code** (since 2026-01-26), **Goose**, **Postman**, **MCPJam**, **mcp-use inspector**,
**Alpic playground**. The README notes host support varies and points at the MCP clients page.
MCP-UI (`idosal/mcp-ui`) provides a full client SDK some hosts use.

**Claude Code does not render MCP Apps.** It calls the tool as text. When the tool returns
`structuredContent`, Claude Code's `tool_result` is that JSON as a string rather than the
`content` text (Claude quickstart). So every SCP app tool must return useful text **and** keep
`structuredContent` small and self-explanatory, because coding agents read it as the result.

### 3.1 Claude-specific host facts

- First render asks the user for permission: **Allow** or **Always allow** per server.
- Rendering on claude.ai/Desktop with a URL connector means Claude connects from Anthropic's
  infrastructure, so `localhost` is unreachable. Testing needs a public HTTPS URL or tunnel
  (cloudflared, see `docs/testing-mcp-apps.md`), or stdio in Claude Desktop config.
- Claude nests the View: **an iframe inside an iframe** (the sandbox-proxy pattern).
- **Invisible app** is the top failure: the View never called `app.connect()` (no handshake), or
  its height is zero. So raw user HTML with no handshake shows nothing. SCP must wrap stored HTML
  (section 6).
- **Tool result size**: above about **150,000 characters** (claude.ai/Desktop with code execution on),
  Claude writes the result to a sandbox file and the View gets a pointer, so it never hydrates.
  Claude Code's limit is 25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS`). **Never put artifact
  HTML in the tool result.** Put an id/URI there and load the bytes with `resources/read`.
- `_meta.ui.domain` for Claude: exactly `{sha256(connectorUrl).hex[0:32]}.claudemcpcontent.com`,
  hashing the exact connector URL (scheme, path, trailing slash all count). Errors:
  `Invalid ui.domain format`, `ui.domain mismatch`. Not available for stdio connectors. Only needed
  for OAuth callbacks or origin-allowlisted CORS. **SCP should omit it.**
- iOS WebKit omits `Referer` on cross-origin subresource requests. If SCP ever serves View assets
  from its own origin, allowlist by `Origin` (`*.claudemcpcontent.com`), never `Referer`.
- MCP tool calls are proxied through Claude's backend (egress from Anthropic IP ranges), not the
  user's device. So the SCP MCP endpoint must be internet-reachable for claude.ai.

---

## 4. MCP Apps protocol, precisely

### 4.1 UI resource

`resources/list` entry (UI resources MAY be omitted from listing, since discovery is via tool meta):

```json
{ "uri": "ui://weather-server/dashboard-template", "name": "weather_dashboard",
  "description": "Interactive weather dashboard view", "mimeType": "text/html;profile=mcp-app",
  "_meta": { "ui": { /* UIResourceMeta, optional static default */ } } }
```

`resources/read` result:

```json
{ "contents": [{
    "uri": "ui://weather-server/dashboard-template",
    "mimeType": "text/html;profile=mcp-app",
    "text": "<!DOCTYPE html><html>...</html>",
    "_meta": { "ui": {
      "csp": { "connectDomains": [], "resourceDomains": [], "frameDomains": [], "baseUriDomains": [] },
      "permissions": { "camera": {}, "microphone": {}, "geolocation": {}, "clipboardWrite": {} },
      "domain": "optional, host-specific",
      "prefersBorder": true } } }] }
```

Rules:
- URI MUST start `ui://`. `mimeType` MUST be `text/html;profile=mcp-app`. Content is `text` or base64
  `blob`. MUST be a valid HTML5 document.
- Draft: `_meta.ui` may sit on the listing entry and/or the content item. **Content item wins.**
  Hosts MUST check both. `registerAppResource`'s config `_meta.ui` goes to the listing; the read
  callback's `contents[]._meta.ui` is the per-read override. Put CSP on the content item.
- `UIResourceMeta` fields: `csp` (`connectDomains` maps to `connect-src`; `resourceDomains` maps to
  script/style/img/font/media-src, wildcard subdomains allowed like `https://*.example.com`;
  `frameDomains` maps to `frame-src`; `baseUriDomains` maps to `base-uri`), `permissions` (maps to the
  iframe `allow` attribute; Views must feature-detect), `domain`, `prefersBorder`
  (`true`/`false`/omitted means the host decides; set it explicitly).

**Host default CSP when `ui.csp` is omitted** (MUST):

```
default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; media-src 'self' data:; connect-src 'none';
```
(draft adds `object-src 'none'`). Hosts MAY restrict further but MUST NOT allow undeclared domains.
Note there is **no `unsafe-eval`** in the spec CSP, so Babel-in-browser, `new Function`, and some
chart libraries break. Precompile.

### 4.2 Tool metadata

```json
{ "name": "get_weather", "description": "...", "inputSchema": { "type": "object" },
  "_meta": { "ui": { "resourceUri": "ui://weather-server/dashboard-template",
                     "visibility": ["model", "app"] } } }
```

- `visibility` default `["model","app"]`. `["app"]` means hidden from the agent's tool list
  (host MUST filter it out) but callable by the View from the **same server connection only**.
  `["model"]` means the host MUST reject `tools/call` from the View.
- Host MUST fetch the UI with `resources/read`, MAY prefetch/cache it (cache key is the URI, so
  **version the URI** when content changes).
- One tool maps to **one static `resourceUri`**. Multiple UI resources per tool response is listed as
  future work. This drives SCP's viewer-shell design (section 6).
- Non-supporting hosts treat the tool as a plain tool. Tools MUST return meaningful `content` anyway.

### 4.3 Capability negotiation

Host advertises in MCP `initialize`:

```json
{ "capabilities": { "extensions": { "io.modelcontextprotocol/ui": {
    "mimeTypes": ["text/html;profile=mcp-app"] } } } }
```

Server checks via `getUiCapability(server.server.getClientCapabilities())?.mimeTypes?.includes(RESOURCE_MIME_TYPE)`
inside `server.server.oninitialized`. **For a stateless per-request HTTP server, skip conditional
registration**: always register app tools with text fallbacks. Non-supporting clients ignore `_meta`.

### 4.4 View and host messages (JSON-RPC 2.0 over `postMessage`)

View to Host requests:

| Method | Params | Result |
|---|---|---|
| `ui/initialize` | `{ protocolVersion, appInfo:{name,version}, appCapabilities:{ tools?, availableDisplayModes?: ("inline"\|"fullscreen"\|"pip")[], experimental? } }` | `{ protocolVersion, hostInfo, hostCapabilities, hostContext }` |
| `tools/call` | standard MCP | `CallToolResult` (host proxies to the server) |
| `resources/read` | `{ uri }` | `ReadResourceResult` (needs `hostCapabilities.serverResources`) |
| `resources/list` | standard | standard |
| `ui/open-link` | `{ url }` | `{}` or error `-32000` |
| `ui/message` | `{ role:"user", content:{type:"text",text} }` | `{}` (host adds to chat, may trigger a turn) |
| `ui/update-model-context` | `{ content?: ContentBlock[], structuredContent? }` | `{}` (overwrites the previous one, used next turn) |
| `ui/request-display-mode` | `{ mode }` | `{ mode }` (actual mode) |
| `ui/download-file` (draft) | `{ contents: (EmbeddedResource\|ResourceLink)[] }` | `{}`. Exists because the sandbox lacks `allow-downloads` |
| `ping` | | `{}` |

View to Host notifications: `ui/notifications/initialized` (after the init response),
`ui/notifications/size-changed` `{width,height}`, `notifications/message` (log),
`ui/notifications/request-teardown` (draft).

Host to View notifications: `ui/notifications/tool-input` `{arguments}` (exactly once, after
`initialized`), `ui/notifications/tool-input-partial` (0..n while streaming),
`ui/notifications/tool-result` (`CallToolResult`), `ui/notifications/tool-cancelled` `{reason}`,
`ui/notifications/host-context-changed` (partial `HostContext`, merge it). Host to View request:
`ui/resource-teardown` `{reason}`; reply `{}` before the host destroys the frame.

Ordering rule: **Host MUST NOT send anything to the View before `ui/notifications/initialized`.**

`HostCapabilities`: `openLinks`, `serverTools{listChanged}`, `serverResources{listChanged}`, `logging`,
`sandbox{permissions, csp}` (what the host actually granted), `experimental`.

`HostContext`: `toolInfo{id,tool}`, `theme` (`light`/`dark`), `styles{variables, css{fonts}}`
(about 36 standard CSS vars like `--color-background-primary`, `--color-text-primary`, `--font-sans`),
`displayMode`, `availableDisplayModes`, `containerDimensions` (`height` or `maxHeight`, and `width` or
`maxWidth`), `locale`, `timeZone`, `userAgent`, `platform` (`web`/`desktop`/`mobile`),
`deviceCapabilities{touch,hover}`, `safeAreaInsets`.

Sizing: with flexible dimensions, the host MUST resize the iframe on `size-changed`. The SDK sends these
automatically through a ResizeObserver (`autoResize` default true). A hand-rolled View must send them itself.

Data passing guidance: `content` is text for the model and text-only hosts; `structuredContent` is for
the UI ("not added to model context" per spec, although Claude Code reads it as the result); `_meta` is
for metadata. The patterns guide puts a `viewUUID` in `CallToolResult._meta` as a key for persisting view state.

Draft also adds **App-provided tools**: the View registers tools (`app.registerTool`) that the host/agent
can call via `tools/call` into the iframe. Not needed for SCP v1.

### 4.5 Sandbox-proxy architecture (web hosts)

From spec section "Sandbox proxy" and `examples/basic-host`:

1. Host and Sandbox MUST be different origins.
2. Outer sandbox iframe has `allow-scripts allow-same-origin`.
3. Sandbox posts `ui/notifications/sandbox-proxy-ready`. Host replies with
   `ui/notifications/sandbox-resource-ready` `{ html, sandbox?, csp?, permissions? }`.
4. Sandbox loads the HTML into an inner iframe (reference uses `sandbox="allow-scripts allow-same-origin allow-forms"`
   and `document.write`, falling back to `srcdoc`), relays all non-`ui/notifications/sandbox-*` messages
   both ways, and checks `event.origin` and `event.source` on every message.
5. CSP is delivered as an **HTTP header** on the sandbox page (reference passes `?csp=<json>`).
   The header is tamper-proof, unlike a `<meta>` tag.
6. Reference `sanitizeCspDomains` rejects entries containing `;`, CR/LF, quotes, or spaces. **SCP must
   apply the same check to any user-supplied CSP domain.**

Reference host CSP builder (`examples/basic-host/serve.ts`, more permissive than the spec default; it adds
`'unsafe-eval' blob: data:` to scripts and `worker-src 'self' blob:`):

```
default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: <res>;
style-src 'self' 'unsafe-inline' blob: data: <res>; img-src 'self' data: blob: <res>;
font-src 'self' data: blob: <res>; media-src 'self' data: blob: <res>; connect-src 'self' <conn>;
worker-src 'self' blob: <res>; frame-src <frame>|'none'; object-src 'none'; base-uri <base>|'none'
```

Spec security section: hosts SHOULD hash/sign resources, log View-initiated RPCs, warn on external
domains, and limit CPU/memory.

---

## 5. SDK API signatures (2.0.3, from the shipped `.d.ts`)

### 5.1 Server helpers (`@modelcontextprotocol/ext-apps/server`)

```ts
function registerAppTool<Out extends StandardSchemaWithJSON, In extends StandardSchemaWithJSON | undefined = undefined>(
  server: Pick<McpServer, "registerTool">,
  name: string,
  config: McpUiAppToolConfig & { inputSchema?: In; outputSchema?: Out },
  cb: ToolCallback<In>,
): RegisteredTool;
// McpUiAppToolConfig = { title?, description?, inputSchema?, outputSchema?, annotations?,
//   _meta: { ui: McpUiToolMeta } | { "ui/resourceUri"?: string } }  (also writes the legacy key)

function registerAppResource(
  server: Pick<McpServer, "registerResource">,
  name: string,
  uri: string,
  config: McpUiAppResourceConfig,          // ResourceMetadata & { _meta?: { ui?: McpUiResourceMeta } }
  readCallback: (uri: URL, extra) => McpUiReadResourceResult | Promise<McpUiReadResourceResult>,
): RegisteredResource;                      // mimeType defaults to RESOURCE_MIME_TYPE

const EXTENSION_ID = "io.modelcontextprotocol/ui";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const RESOURCE_URI_META_KEY = "ui/resourceUri";
function getUiCapability(caps?: ClientCapabilities): McpUiClientCapabilities | undefined;
```

### 5.2 View client (`App`)

```ts
new App(appInfo: { name: string; version: string }, appCapabilities?: McpUiAppCapabilities,
        options?: { autoResize?: boolean /*true*/; strict?: boolean /*false*/; allowUnsafeEval?: boolean /*false*/ });
// Set handlers BEFORE connect():
app.ontoolinput / ontoolinputpartial / ontoolresult / ontoolcancelled / onhostcontextchanged
app.onteardown = async (params, extra) => ({});
await app.connect(transport?);              // default PostMessageTransport(window.parent)
app.callServerTool({ name, arguments })     // -> CallToolResult
app.readServerResource({ uri })             // -> ReadResourceResult
app.listServerResources()
app.sendMessage({ role: "user", content: [...] })
app.updateModelContext({ content?, structuredContent? })
app.openLink({ url }); app.downloadFile({ contents }); app.requestDisplayMode({ mode })
app.requestTeardown(); app.sendSizeChanged({ width, height }); app.sendLog(params)
app.getHostContext(); app.getHostCapabilities(); app.getHostVersion()
app.registerTool(name, config, cb)          // draft app-provided tools
```
`allowUnsafeEval:false` makes the constructor set `z.config({ jitless: true })` so zod works under a
no-eval CSP.

No-bundler View (Claude quickstart, 1.x): `import { App } from "https://unpkg.com/@modelcontextprotocol/ext-apps@1.7.5/dist/src/app-with-deps.js"`
plus `_meta.ui.csp.resourceDomains: ["https://unpkg.com"]` on the resource. The same path exists in 2.0.3
(`dist/src/app-with-deps.js`). The docs advise production to bundle or self-host instead.

### 5.3 Minimal 2.x server (from `examples/quickstart`, trimmed)

```ts
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod";

function createServer() {
  const server = new McpServer({ name: "Quickstart", version: "1.0.0" });
  const resourceUri = "ui://get-time/mcp-app.html";
  registerAppTool(server, "get-time",
    { title: "Get Time", description: "Returns the current server time.",
      inputSchema: z.object({}), _meta: { ui: { resourceUri } } },
    async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }));
  registerAppResource(server, resourceUri, resourceUri, { mimeType: RESOURCE_MIME_TYPE },
    async () => ({ contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: HTML }] }));
  return server;
}

const app = createMcpExpressApp({ host: "0.0.0.0" });
app.all("/mcp", async (req, res) => {                 // stateless: new server per request
  const server = createServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(3001);
```

Non-UI resource template (from `examples/video-resource-server`):

```ts
import { ResourceTemplate } from "@modelcontextprotocol/server";
server.registerResource("video",
  new ResourceTemplate("videos://{id}", { list: async () => ({ resources: [/* {uri,name,mimeType} */] }) }),
  { description: "...", mimeType: "video/mp4" },
  async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: "video/mp4", blob: base64 }] }));
```

Quick verification with curl (Claude quickstart): POST `/mcp` with `Accept: application/json, text/event-stream`
for `tools/list` (expect `_meta.ui.resourceUri` and the legacy `ui/resourceUri`), `resources/read`
(expect `mimeType: text/html;profile=mcp-app`), and `tools/call`.

---

## 6. Design: serving stored SCP artifacts as MCP Apps

### 6.1 Constraint that forces the design

`resourceUri` is static per tool and fixed at `tools/list` time, and hosts may cache by URI. Artifacts
are dynamic and user-written, and agents write new ones mid-session. So one tool per artifact means
`tools/list` churn plus `list_changed`, which stateless HTTP cannot push. **Use one generic viewer shell
resource plus one `render_artifact` tool.** The shell loads the requested artifact at runtime and runs it
in a nested sandboxed `srcdoc` iframe.

### 6.2 Per-group MCP endpoint surface (artifact part)

Endpoint `POST /mcp/{groupSlug}` (MCPHub-style group routing), built per request from SQLite, stateless.

| Name | Kind | Visibility | Purpose |
|---|---|---|---|
| `ui://scp/viewer/v1` | UI resource | n/a | Viewer shell HTML. Bump `v1` whenever the shell changes (cache busting) |
| `scp://artifacts/{id}/v/{version}` | resource template | n/a | Artifact bytes. `mimeType` = the artifact's MIME. Immutable per version |
| `render_artifact` | app tool, `resourceUri: ui://scp/viewer/v1` | model, app | `{ id \| slug, version? }` returns text (title, version, share/web URL, one-line summary) + `structuredContent: { id, version, title, kind, uri }`. **No HTML in the result** (150k cap) |
| `scp_artifact_content` | app tool, same `resourceUri` | `["app"]` | Fallback loader when the host lacks `serverResources`: returns `{ html }` in chunks if large (patterns.md "chunked tool calls") |
| `list_artifacts` | plain tool | model | Group's artifacts: id, slug, title, kind, version, tags |
| `get_artifact` | plain tool | model | Source text for a coding agent (Claude Code cannot render). Size-capped, with paging |
| `create_artifact` / `update_artifact` | plain tools | model | Agent write-back. `update` appends a version. Returns id, version, web URL |
| `share_artifact` | plain tool | model | Creates/returns the public link (if the token's scope permits) |

`render_artifact` text content example: `"Rendered 'Q3 KPI dashboard' (v4, html). View: https://scp.example/s/Xy..."`.
Text-only agents still get the link.

### 6.3 Viewer shell resource registration

```ts
const VIEWER = "ui://scp/viewer/v1";
const VIEWER_CSP = { resourceDomains: cfg.artifactCdns, connectDomains: [] }; // e.g. cdnjs, jsdelivr, unpkg
registerAppResource(server, "SCP artifact viewer", VIEWER,
  { description: "Renders an SCP artifact", _meta: { ui: { csp: VIEWER_CSP, prefersBorder: true } } },
  async () => ({ contents: [{ uri: VIEWER, mimeType: RESOURCE_MIME_TYPE, text: VIEWER_HTML,
                              _meta: { ui: { csp: VIEWER_CSP, prefersBorder: true } } }] }));
```

The viewer's CSP is the **ceiling for every artifact it renders**, because the nested `srcdoc` inherits
the viewer document's CSP (section 8.4). The host may prefetch the viewer before knowing which artifact
loads, so per-artifact CSP is not possible through this path. SCP therefore enforces one global CDN
allowlist for artifacts. Artifacts needing other origins render correctly only on SCP's web share page,
or need the deferred "pinned app" path (6.6).

### 6.4 Viewer shell behaviour (hand-rolled bridge, no SDK)

The spec says no SDK is needed. A hand-rolled bridge is about 60 lines, needs no CDN, and avoids inlining
409 KB. Sequence:

1. `rpc("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "scp-viewer", version: "1" },
   appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } })`, then
   `notify("ui/notifications/initialized", {})`.
2. On `ui/notifications/tool-result`: read `structuredContent.uri`. If `hostCapabilities.serverResources`,
   call `rpc("resources/read", { uri })`, else `rpc("tools/call", { name: "scp_artifact_content", arguments })`.
3. Build `srcdoc` = artifact HTML + an injected helper script. Set it on
   `<iframe sandbox="allow-scripts allow-forms">` (no `allow-same-origin`, which gives an opaque origin, so the
   artifact cannot reach the viewer's bridge or DOM).
4. Injected helper inside the artifact posts `{scp:"size", h}` (ResizeObserver on `documentElement`) and
   `{scp:"open", url}` (intercepts `http(s)` link clicks, since there is no `allow-popups`). The viewer accepts
   only `e.source === frame.contentWindow`, sets the iframe height, and forwards
   `ui/notifications/size-changed` and `ui/open-link`.
5. Answer `ui/resource-teardown` with `{}` and `ping` with `{}`. Forward `theme` from `hostContext` and
   `host-context-changed` to the artifact (`postMessage({scp:"theme", theme})`). The helper sets
   `document.documentElement.dataset.theme`.
6. Send a non-zero initial size immediately (a loading state), because a zero-height app is invisible in Claude.

Bridge core (correct id matching; the spec's inline sample rejects any unrelated message, so don't copy it):

```js
let seq = 0; const pending = new Map();
const send = (m) => parent.postMessage({ jsonrpc: "2.0", ...m }, "*");
const rpc = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); send({ id, method, params }); });
const notify = (method, params = {}) => send({ method, params });
addEventListener("message", (e) => {
  if (e.source === frame?.contentWindow) return onArtifactMsg(e.data);
  if (e.source !== parent) return;
  const m = e.data; if (m?.jsonrpc !== "2.0") return;
  if (m.id != null && !m.method) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(m.error) : p.res(m.result); } return; }
  if (m.method === "ui/resource-teardown" || m.method === "ping") return send({ id: m.id, result: {} });
  if (m.method === "ui/notifications/tool-result") return onToolResult(m.params);
  if (m.method === "ui/notifications/host-context-changed") return onContext(m.params);
});
```

`srcdoc` injection gotcha (hit during the CSP test): when building HTML inside a `<script>`, escape `</` as
`<\/`, or the inner `</script>` ends the outer script. With DOM `iframe.srcdoc = string` no escaping is needed.

### 6.5 Write-back from agents

- MCP: `create_artifact { title, kind, content, description?, tags?, groupSlugs? }` and
  `update_artifact { id, content, note? }`. The server validates size (cap, e.g. 2 MB of text; Claude uses
  16 MB per page), kind, and UTF-8, computes `sha256`, and stores a new `artifact_versions` row. The author
  is the API token's principal (user or agent token). Return `{ id, version, url }`.
- HTTP mirror: `POST /api/v1/artifacts`, `POST /api/v1/artifacts/{id}/versions`, bearer token, same validation.
- Written artifacts default to `visibility=private`. Sharing is a separate explicit call (Claude's
  "start private" rule).

### 6.6 Deferred: pinned "app" artifacts

For an artifact needing its own CSP (API access) or real MCP App behaviour (calling SCP tools), a group could
expose it as a dedicated tool `open_{slug}` with resource `ui://scp/a/{id}/v/{version}` and per-artifact
`_meta.ui.csp`. SCP would inject the same bridge before `</head>`. Add this when a user needs per-artifact
CSP. The viewer shell covers v1.

---

## 7. Data model (SQLite) for artifacts

```sql
CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,          -- ulid
  owner_id        TEXT NOT NULL REFERENCES users(id),
  slug            TEXT NOT NULL,             -- unique per owner
  title           TEXT NOT NULL,
  description     TEXT,
  kind            TEXT NOT NULL CHECK (kind IN
                   ('html','react','svg','mermaid','markdown','code','component','design','deck','document','dashboard','tool')),
  current_version INTEGER NOT NULL DEFAULT 1,
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','group','public')),
  forked_from     TEXT REFERENCES artifacts(id),
  created_at      TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (owner_id, slug)
);
CREATE TABLE artifact_versions (
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  source        TEXT NOT NULL,              -- what the author/agent wrote
  source_mime   TEXT NOT NULL,              -- text/html, text/markdown, text/jsx, image/svg+xml, text/x-mermaid, text/plain
  rendered_html TEXT,                       -- derived at write time (deterministic), NULL for code-only
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  csp_json      TEXT,                       -- optional extra domains (web path only), validated
  created_by    TEXT NOT NULL,              -- user id or agent token id
  note          TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
CREATE TABLE artifact_shares (
  token_hash   TEXT PRIMARY KEY,            -- sha256(token); token itself shown once
  artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  pinned_version INTEGER,                   -- NULL = follow current_version
  embed_origins TEXT,                       -- JSON array; drives frame-ancestors
  created_by   TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at   TEXT, revoked_at TEXT
);
-- Group membership is shared with skills/prompts: group_items(group_id, item_type='artifact', item_id, pinned_version NULL)
```

### 7.1 Kind to render (computed at write, stored in `rendered_html`)

| kind | source_mime | rendered_html |
|---|---|---|
| html, component, design, deck, document, dashboard, tool | text/html | as-is (must be a full HTML document; wrap fragments in a skeleton) |
| react | text/jsx | **precompile server-side** (esbuild/sucrase) to an ES module; template loads React from the CDN allowlist. No in-browser Babel, since the spec CSP has no `unsafe-eval` |
| svg | image/svg+xml | `<!doctype html><body style="margin:0">{svg}</body>` |
| mermaid | text/x-mermaid | template + mermaid ESM from jsdelivr (allowlisted) |
| markdown | text/markdown | server-side `marked` to HTML in a styled template. The sandbox contains any XSS, so sanitizing is defense-in-depth only |
| code | text/plain (+lang) | `<pre>` (optional highlight.js from the CDN) |

The deck/document/dashboard kinds are metadata for discovery and grouping. Their bytes are HTML.

### 7.2 Version semantics

- `scp://artifacts/{id}/v/{n}` and every share URL with `/v/{n}` are immutable. Cache forever
  (`Cache-Control: public, max-age=31536000, immutable` on the artifact origin).
- Unpinned share links resolve `current_version` per request (`Cache-Control: no-cache`).

---

## 8. Rendering in SCP's own web app, and public links

### 8.1 Two origins (non-negotiable)

- `SCP_PUBLIC_URL` (app, cookies, API), e.g. `https://scp.example`.
- `SCP_ARTIFACT_ORIGIN` (user content only, **no cookies, no API, no auth state**), ideally a
  **separate registrable domain** (`scpusercontent.example`), the same pattern as `githubusercontent.com`
  and `claudemcpcontent.com`. A subdomain of the app domain is same-site, so SameSite cookies don't
  protect against it. In docker-compose dev, use a second port (`localhost:8081`). That is a different origin but
  the same site, which is acceptable for dev, and document it.
- Both can be served by one Node process listening on two ports. Route by `Host`/port, and the artifact
  listener serves **only** `/r/...`.

### 8.2 URL shapes

| URL | Origin | Auth | Purpose |
|---|---|---|---|
| `GET /a/{id}` | app | session | owner/editor page: chrome + preview iframe |
| `GET /s/{token}` | app | none | public share page: title, owner, version, "open raw", "copy/fork" (signed-in) |
| `GET {ART}/r/{token}` / `{ART}/r/{token}/v/{n}` | artifact | share token | raw rendered HTML |
| `GET {ART}/p/{previewToken}` | artifact | short-lived HMAC (`id,version,exp`), 5 min | owner preview of private artifacts (the artifact origin has no cookies) |
| `GET /api/v1/artifacts/{id}/versions/{n}/content` | app | bearer | source for agents |
| `POST /api/v1/artifacts/{id}/shares` / `DELETE .../shares/{tokenId}` | app | session/bearer | publish / revoke |

Share token: `crypto.randomBytes(24).toString("base64url")` (192-bit). Store only `sha256`. Revoke by
setting `revoked_at`, effective on the next request. Return 404 (not 403) for revoked or unknown tokens.

### 8.3 Response headers for `{ART}/r/...`

```
Content-Type: text/html; charset=utf-8
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals;
  default-src 'none'; script-src 'unsafe-inline' <cdns>; style-src 'unsafe-inline' <cdns> https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com data:; img-src data: blob: https:; media-src data: blob:;
  connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors <SCP_PUBLIC_URL> <share.embed_origins...>
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=()
```

- The **CSP `sandbox` directive** sandboxes the document even when opened top-level via "open raw", giving
  it an opaque origin. That closes the gap where the iframe `sandbox` attribute only applies when embedded.
- Embedding page: `<iframe src="{ART}/r/{token}" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals" referrerpolicy="no-referrer" loading="lazy">`.
  Never add `allow-same-origin` together with `allow-scripts` on a shared origin, because the artifact could then
  remove its own sandbox and read other artifacts' storage.
- `img-src https:` is a deliberate loosening for images. Tighten to the CDN list if exfiltration via image
  beacons matters (with `connect-src 'none'`, image URLs are the remaining exfil channel).
- Use the same `sanitizeCspDomains` rule as basic-host (reject `; \r \n ' "` and space) for
  `embed_origins` and `csp_json`. Store `csp_json` extras only for the web path, and only after an
  owner opt-in.
- Size: iframe auto-height on the web page via the same injected `{scp:"size"}` helper. Validate
  `e.source` and `e.origin === SCP_ARTIFACT_ORIGIN`, except opaque origins report `"null"`, so check
  `e.source === iframe.contentWindow`.

### 8.4 Verified: nested `srcdoc` behaviour (Chrome 154.0.8037.98, headless)

Test: a page served with header CSP
`default-src 'none'; script-src 'self' 'unsafe-inline'; ... connect-src 'none'; frame-src 'none'; ...`
creates `<iframe sandbox="allow-scripts" srcdoc=...>` whose script posts messages.

| Check | Result |
|---|---|
| `frame-src 'none'` blocks the srcdoc iframe? | **No.** Inner script ran (same result with frame-src removed) |
| Inner origin | `"null"` (opaque) |
| `localStorage` inside | **throws** |
| `fetch("https://example.com/")` inside | failed (consistent with inherited `connect-src 'none'`; CORS alone would also fail, so treat inheritance as spec-backed, not proven by this test) |

Implications: the viewer-shell pattern works under the spec's default CSP in Chromium. Artifacts must not
depend on `localStorage` (wrap it in try/catch, the same rule Claude applies). Re-run this test against
Firefox/WebKit before release. Firefox < 55 had a CVE (2017-7788) where sandboxed srcdoc frames did not
inherit CSP. Test harness: the session scratchpad `csptest/server.mjs` (a throwaway script, not part of
the repo).

### 8.5 Docker compose implications

```yaml
services:
  scp:
    image: scp:latest
    ports: ["8080:8080", "8081:8081"]   # app, artifact origin
    environment:
      SCP_PUBLIC_URL: http://localhost:8080
      SCP_ARTIFACT_ORIGIN: http://localhost:8081
      SCP_ARTIFACT_CDNS: "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com"
      SCP_DB_PATH: /data/scp.db
    volumes: ["scp-data:/data"]
volumes: { scp-data: {} }
```

For claude.ai to render Apps, the `/mcp/{group}` endpoint needs a public HTTPS URL (reverse proxy or tunnel).
Local stdio is not an option for a shared server, so document a cloudflared/Caddy recipe.

---

## 9. Checklist for implementation chunks

1. Two listeners (app :8080, artifact :8081); artifact listener serves `/r/` and `/p/` only, with the 8.3 headers.
2. `artifacts`, `artifact_versions`, `artifact_shares` tables + kind-to-render function (pure, unit-tested per kind).
3. Share token mint/hash/revoke + `/s/{token}` page + `/r/{token}[/v/{n}]`.
4. CSP builder + `sanitizeCspDomains` (unit tests: injection via `;`, quote, space, newline rejected).
5. Viewer shell HTML + bridge (tests: handshake order, id matching, teardown reply, size forwarding, rejects
   messages from unknown sources). Run it against `examples/basic-host` (`npm start`, port 8080/8081) for a
   real-host smoke test.
6. MCP group endpoint: `render_artifact`, `scp_artifact_content` (app-only), resource template, `list/get/create/update/share`.
   curl checks from 5.3.
7. Playwright: share page renders, revoked token 404s, "open raw" top-level is sandboxed (`self.origin === "null"`),
   artifact cannot read app cookies.

## 10. Open questions

- Exact Claude host CSP (does Claude add `unsafe-eval`/`blob:`?) isn't documented. Design to the spec default.
- Whether Claude sets `hostCapabilities.serverResources` (needed for `resources/read` from the View). The fallback
  tool covers either answer. Check in Claude dev tools.
- Firefox/WebKit behaviour of sandboxed srcdoc under `frame-src 'none'` is unverified.
