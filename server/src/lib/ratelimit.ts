import type { Context } from 'hono';
import { HttpError, clientIp } from './http.ts';
import type { AppEnv } from '../types.ts';

interface Bucket {
  tokens: number;
  at: number;
}

export interface Rate {
  burst: number;
  perSec: number;
}

/**
 * `ip`: per client IP across the anonymous auth routes (login and register, each one scrypt; the OIDC
 * start and callback, each an outbound call carrying the client secret). `login`: per login name from
 * one IP (guessing); `loginAll`: per login name from everywhere, looser, against distributed guessing.
 * The tight login bucket is per IP so a stranger cannot lock an account out of every other client.
 * `github`: per user id on the routes that spend the instance's one shared GitHub quota (imports).
 * `oauthToken`: per client IP and per client id on /oauth/token, which any client_id may call and
 * which sweeps the token table each time. `marketplace`: per API key on /m/<key>/*, whose listing
 * resolves every member of every group and whose key sits in a URL that a leaked link replays.
 */
export const AUTH_LIMITS = {
  ip: { burst: 20, perSec: 0.5 },
  login: { burst: 10, perSec: 1 / 30 },
  loginAll: { burst: 100, perSec: 1 / 6 },
  github: { burst: 10, perSec: 0.2 },
  oauthToken: { burst: 30, perSec: 1 },
  marketplace: { burst: 100, perSec: 1 },
};
// Per app (keyed by its db), so test apps do not share buckets. ponytail: in-memory and per process;
// a restart refills every bucket, and several replicas would each allow the full rate.
const bucketsByDb = new WeakMap<object, Map<string, Bucket>>();
/** A bucket idle this long is full again, so forgetting it changes nothing. */
const FULL_AFTER_MS = Math.max(...Object.values(AUTH_LIMITS).map((l) => l.burst / l.perSec)) * 1000;
const MAX_BUCKETS = 50_000;

/** The key's bucket, refilled to now. */
function bucket(c: Context<AppEnv>, key: string, { burst, perSec }: Rate): Bucket {
  let m = bucketsByDb.get(c.var.ctx.db);
  if (!m) bucketsByDb.set(c.var.ctx.db, (m = new Map()));
  const t = Date.now();
  if (m.size > MAX_BUCKETS) {
    for (const [k, x] of m) if (t - x.at > FULL_AFTER_MS) m.delete(k);
    if (m.size > MAX_BUCKETS) m.clear(); // ponytail: a flood of fresh keys resets the limiter; memory stays bounded
  }
  const b = m.get(key) ?? { tokens: burst, at: t };
  b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSec);
  b.at = t;
  m.set(key, b);
  return b;
}

/** Token bucket: true and one token spent, or false when the bucket is empty. */
export function take(c: Context<AppEnv>, key: string, rate: Rate): boolean {
  const b = bucket(c, key, rate);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/**
 * `cost` tokens spent whatever is left, for calls a request admitted by `take` has made or must make
 * (a GitHub folder fetched file by file): the bucket may go into debt, so the key waits out every
 * call before its next one.
 */
export function spend(c: Context<AppEnv>, key: string, rate: Rate, cost: number): void {
  bucket(c, key, rate).tokens -= cost;
}

export const rateLimited = (what = 'attempts') => new HttpError(429, 'rate_limited', `too many ${what}; wait a minute and try again`);

/** One token from the per-IP anonymous bucket, or 429; returns the IP for finer keys. */
export function limitIp(c: Context<AppEnv>): string {
  const ip = clientIp(c, c.var.ctx.config.trustProxy) ?? 'unknown';
  if (!take(c, `ip:${ip}`, AUTH_LIMITS.ip)) throw rateLimited();
  return ip;
}
