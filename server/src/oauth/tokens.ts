import type { Context } from 'hono';
import { normalizeScopes } from '../auth/service.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { now } from '../db.ts';
import type { AppEnv, Principal, UserRow } from '../types.ts';
import type { TokenRow } from './service.ts';

/**
 * Resolve an OAuth access token to a principal (`via: 'oauth'`), or null when unknown, expired,
 * revoked, or its client or user is disabled. Called by mcp/routes.ts only: the /api/v1 principal
 * middleware never accepts these tokens, so a leaked MCP token cannot manage the account. Same
 * containment rules as API keys (principalFromKey): groupIds null = every readable group. Never
 * admin: the consent page offers "your groups", and an anonymous DCR client reached through a third
 * party's link must not get instance-wide reach; an admin who wants that over MCP mints an API key.
 */
export function principalFromOAuthToken(c: Context<AppEnv>, token: string): Principal | null {
  if (!token.startsWith('scp_at_')) return null;
  const { db } = c.var.ctx;
  const row = db
    .prepare(
      `SELECT t.*, cl.disabled AS client_disabled FROM oauth_tokens t JOIN oauth_clients cl ON cl.id = t.client_id
       WHERE t.token_hash = ? AND t.kind = 'access'`,
    )
    .get(sha256Hex(token)) as (TokenRow & { client_disabled: number }) | undefined;
  if (!row || row.revoked_at || row.client_disabled || row.expires_at <= now()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as UserRow | undefined;
  if (!user || user.disabled) return null;
  const scopes = normalizeScopes(JSON.parse(row.scopes) as string[]);
  if (!scopes.includes('read')) return null;
  db.prepare('UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return {
    userId: user.id,
    username: user.username,
    isAdmin: false,
    via: 'oauth',
    oauthClientId: row.client_id,
    scopes,
    groupIds: row.group_ids ? (JSON.parse(row.group_ids) as string[]) : null,
  };
}
