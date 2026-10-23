import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

export const MB = 1024 * 1024;

/** 413 once a request body passes maxSize bytes, before the handler buffers it. */
export const limitBody = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: { code: 'too_large', message: `request body is over ${maxSize / MB} MB` } }, 413),
  });

export class HttpError extends Error {
  status: ContentfulStatusCode;
  code: string;
  details?: unknown;
  /** More fields for the error body, beside details (an import's skippedFolders). */
  extra?: Record<string, unknown>;
  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const forbidden = (message = 'forbidden') => new HttpError(403, 'forbidden', message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);

export function errorHandler(err: Error, c: Context) {
  if (err instanceof HttpError) {
    const body: { error: { code: string; message: string; details?: unknown } } = { error: { ...err.extra, code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    // A 503 that names when to retry (imports/github.ts withZipballSlot) says so in the header too.
    const retryAfter = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
    if (err.status === 503 && typeof retryAfter === 'number') c.header('Retry-After', String(retryAfter));
    return c.json(body, err.status);
  }
  // Hono's own HTTPException (e.g. bodyLimit 413) carries a status.
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // hono/csrf throws with an empty message, which the UI then shows as a blank error box.
    const message = err.message || (status === 403 ? 'request refused: it must come from this site (Origin header missing or foreign)' : 'request failed');
    return c.json({ error: { code: 'http_error', message } }, status as ContentfulStatusCode);
  }
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
}

/** Parse and validate a JSON body; 400 with zod issues on failure. */
export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw badRequest('invalid body', r.error.issues);
  return r.data;
}

/** Validate query params (strings) against a zod schema. */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw badRequest('invalid query', r.error.issues);
  return r.data;
}

/**
 * The client IP (audit, login rate limit). Proxy headers are client-controlled, so they count only
 * when the operator says a reverse proxy sets them (SCP_TRUST_PROXY=true); otherwise the socket peer.
 * The rightmost X-Forwarded-For entry is the one our proxy added: nginx and Cloudflare append to
 * whatever the client sent, so the leftmost is the client's own claim. null outside the Node server
 * (tests without an incoming socket).
 */
export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || c.req.header('x-real-ip');
    if (fwd) return fwd;
  }
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  return socket?.remoteAddress ?? null;
}
