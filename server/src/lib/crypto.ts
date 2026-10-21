import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 64;

// Async on purpose: one scrypt is ~20 ms of CPU, and anonymous login/register run it, so the sync
// form let ~40 requests a second stall the whole process. This one runs on the libuv threadpool.
const scryptAsync = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, len, opts, (e, key) => (e ? rej(e) : res(key))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scryptAsync(pw.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64url');
  const got = await scryptAsync(pw.normalize('NFKC'), Buffer.from(s, 'base64url'), expected.length, { N: +n, r: +r, p: +p });
  return timingSafeEqual(got, expected);
}

/** High-entropy random token (32 bytes). Stored only as sha256Hex. */
export const randomToken = (prefix = '') => prefix + randomBytes(32).toString('base64url');

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Signed, expiring payload: base64url(json).base64url(hmac). */
export function signPayload(secret: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Returns the payload when the signature matches and `exp` (unix seconds) is in the future. */
export function verifyPayload<T extends { exp: number }>(secret: string, token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now() ? payload : null;
  } catch {
    return null;
  }
}
