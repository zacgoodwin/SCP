import { randomBytes } from 'node:crypto';
import { hashPassword } from '../lib/crypto.ts';
import { newId, now } from '../db.ts';
import type { Ctx } from '../types.ts';

/** Create the first admin when the users table is empty. Returns the generated password, if any. */
export async function bootstrapAdmin(ctx: Ctx): Promise<{ username: string; generatedPassword: string | null } | null> {
  const { db, config } = ctx;
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (n > 0) return null;
  const generated = config.adminPassword ? null : randomBytes(12).toString('base64url');
  const hash = await hashPassword(config.adminPassword ?? generated!);
  db.prepare(
    'INSERT INTO users (id, email, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  ).run(newId(), config.adminEmail, config.adminUsername, hash, now());
  return { username: config.adminUsername, generatedPassword: generated };
}
