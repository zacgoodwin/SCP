import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { bearerToken, principalFromKey } from '../auth/middleware.ts';
import { principalFromOAuthToken } from '../oauth/tokens.ts';
import { loadReadableGroup } from '../groups/service.ts';
import { MB, limitBody } from '../lib/http.ts';
import { buildMcpServer } from './server.ts';
import type { AppEnv } from '../types.ts';

/**
 * /mcp (every group the key can read) and /mcp/:group. Bearer API keys only: cookies are never read,
 * so a browser session cannot be ridden cross-site, which is also why CORS can be '*'.
 */
export const mcpRoutes = new Hono<AppEnv>();

// The transport buffers the JSON-RPC body; 12 MB fits a 5 MB create_artifact even when JSON escaping
// doubles it (a quote-heavy source).
const MCP_BODY_MAX = 12 * MB;

mcpRoutes.use(
  '/mcp/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'],
    exposeHeaders: ['mcp-session-id'],
  }),
);

async function handle(c: Context<AppEnv>) {
  const token = bearerToken(c);
  // An API key first; an OAuth access token (oauth/tokens.ts, D2) otherwise. OAuth tokens are accepted
  // here only, so the resource metadata pointer tells hosted clients where to get one (RFC 9728).
  const p = token ? (principalFromKey(c, token) ?? principalFromOAuthToken(c, token)) : null;
  if (!p) {
    const message = token ? 'invalid, revoked or expired API key or access token' : 'an SCP API key or OAuth access token is required: Authorization: Bearer ...';
    // RFC 9728 3.3: the pointer names this path's own document, whose `resource` is this URL.
    const metadata = `${c.var.ctx.config.publicUrl}/.well-known/oauth-protected-resource${c.req.path}`;
    return c.json({ error: { code: 'unauthorized', message } }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${metadata}"` });
  }
  const slug = c.req.param('group');
  const group = slug === undefined ? null : loadReadableGroup(c.var.ctx.db, p, slug); // 404 JSON via the app error handler
  // Stateless JSON mode has no server-to-client stream or session to end.
  if (c.req.method !== 'POST') return c.json({ error: { code: 'method_not_allowed', message: 'MCP here is stateless: POST only' } }, 405, { Allow: 'POST' });

  const authInfo: AuthInfo = { token: token!, clientId: p.keyId ?? p.oauthClientId ?? p.userId, scopes: p.scopes, extra: { userId: p.userId, group: group?.slug ?? null } };
  // One server + transport per request: a stateless transport cannot be reused (research stack.md 2.2).
  const server = buildMcpServer(c, p, group);
  // The SDK caps bodies at 4 MiB by default, under a 5 MB create_artifact; match the route limit.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MCP_BODY_MAX });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw, { authInfo });
  } finally {
    void server.close().catch(() => {});
  }
}

const mcpLimit = limitBody(MCP_BODY_MAX);
mcpRoutes.all('/mcp', mcpLimit, handle);
mcpRoutes.all('/mcp/:group', mcpLimit, handle);
