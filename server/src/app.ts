import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import { csrf } from 'hono/csrf';
import { serveStatic } from '@hono/node-server/serve-static';
import { MB, errorHandler, limitBody, notFound } from './lib/http.ts';
import { bearerToken, principalMiddleware } from './auth/middleware.ts';
import { auditRoutes } from './audit.ts';
import { authRoutes } from './auth/routes.ts';
import { UPLOAD_ROUTES, itemRoutes } from './items/routes.ts';
import { artifactApiRoutes, artifactOriginRoutes, sharePageRoutes } from './artifacts/routes.ts';
import { groupRoutes } from './groups/routes.ts';
import { mcpRoutes } from './mcp/routes.ts';
import type { AppEnv, Ctx } from './types.ts';

export function buildApp(ctx: Ctx) {
  const withCtx: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set('ctx', ctx);
    await next();
  };

  // Cookie-authenticated form/multipart posts must come from our own origin. JSON bodies cannot be
  // sent cross-site without a CORS preflight we never grant, and Bearer callers carry no cookie.
  const appOrigin = new URL(ctx.config.publicUrl).origin;
  const csrfCheck = csrf({ origin: (origin, c) => origin === appOrigin || origin === new URL(c.req.url).origin });
  const csrfForCookies: MiddlewareHandler<AppEnv> = (c, next) => (bearerToken(c) !== null ? next() : csrfCheck(c, next));

  // Before auth: login and register read a body anonymously, and c.req.json() buffers all of it.
  const apiLimit = limitBody(MB);
  const bodyCap: MiddlewareHandler<AppEnv> = (c, next) => (c.req.method === 'POST' && UPLOAD_ROUTES.test(c.req.path) ? next() : apiLimit(c, next));

  const api = new Hono<AppEnv>();
  api.use('*', bodyCap, principalMiddleware, csrfForCookies);
  api.route('/', authRoutes);
  api.route('/', itemRoutes);
  api.route('/', artifactApiRoutes);
  api.route('/', groupRoutes);
  api.route('/', auditRoutes);
  api.all('*', () => {
    throw notFound('route');
  });

  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', withCtx);
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/v1', api);
  app.all('/api/*', () => {
    throw notFound('route');
  });
  app.route('/', mcpRoutes);
  app.route('/', sharePageRoutes);
  // No OAuth here. MCP clients probe these after a 401; the SPA fallback answered them with
  // index.html and a 200, which they failed to parse as JSON instead of showing the 401.
  app.all('/.well-known/*', () => {
    throw notFound('route');
  });

  // The SPA frames only the artifact origin (previews) and is never framed itself.
  const spaCsp = `frame-ancestors 'none'; frame-src ${new URL(ctx.config.artifactUrl).origin}; object-src 'none'; base-uri 'none'`;

  if (existsSync(ctx.config.webDist)) {
    const root = relative(process.cwd(), ctx.config.webDist).replaceAll('\\', '/') || '.';
    // Vite fingerprints /assets/*; everything else (index.html) must revalidate, or a browser keeps
    // a heuristically cached index.html that points at the previous build's assets.
    // (serveStatic's onFound runs after the Response is built, so its headers are lost; set them here.)
    app.use('/*', async (c, next) => {
      await next();
      const asset = c.req.path.startsWith('/assets/') && !c.res.headers.get('content-type')?.startsWith('text/html');
      c.res.headers.set('Cache-Control', asset ? 'public, max-age=31536000, immutable' : 'no-cache');
      c.res.headers.set('Content-Security-Policy', spaCsp);
      c.res.headers.set('X-Content-Type-Options', 'nosniff');
    });
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  }

  // The artifact origin serves user content only: no API, no SPA, and it never reads or sets cookies.
  // Isolation comes from the separate origin plus the sandbox CSP; cookies ignore ports, so on one
  // host (localhost:8080 / :8081) the browser still sends scp_sid here. A separate host avoids that.
  const artifactApp = new Hono<AppEnv>();
  artifactApp.onError(errorHandler);
  artifactApp.use('*', withCtx);
  artifactApp.route('/', artifactOriginRoutes);
  artifactApp.all('*', (c) => c.text('not found', 404));

  return { app, artifactApp };
}
