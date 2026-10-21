// OAuth consent, connected apps and admin client management (docs/PLAN-v2.md D2).
import { json, qs, type GroupSummary, type Scope } from './api.ts';

export interface ConsentInfo {
  client: { id: string; name: string; clientUri: string | null; logoUri: string | null };
  /** The scopes the client asked for (write implies read). */
  scopes: Scope[];
  /** Groups the user can read; the consent may be restricted to a subset of them. */
  groups: GroupSummary[];
  redirectHost: string;
}

export interface ConsentDecision {
  approve: boolean;
  scopes?: Scope[];
  /** null = every readable group. */
  groups?: string[] | null;
}

export interface Grant {
  grantId: string;
  client: { id: string; name: string };
  /** An admin disabled the client: suspended until enabled again, not revoked. */
  clientDisabled: boolean;
  scopes: Scope[];
  groups: { id: string; slug: string }[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  clientUri: string | null;
  createdAt: string;
  disabled: boolean;
  grants: number;
}

/** `query` is the /oauth/authorize query the server forwarded to /consent. */
export const getConsent = (query: Record<string, string>) => json<ConsentInfo>('GET', `/oauth/consent${qs(query)}`);
export const decideConsent = (query: Record<string, string>, decision: ConsentDecision) =>
  json<{ redirect: string }>('POST', '/oauth/consent', { ...query, ...decision });
export const listGrants = () => json<{ grants: Grant[] }>('GET', '/oauth/grants');
export const revokeGrant = (grantId: string) => json<void>('DELETE', `/oauth/grants/${encodeURIComponent(grantId)}`);
export const listOAuthClients = () => json<{ clients: OAuthClient[] }>('GET', '/oauth/clients');
export const updateOAuthClient = (id: string, patch: { disabled: boolean }) =>
  json<{ client: OAuthClient }>('PATCH', `/oauth/clients/${encodeURIComponent(id)}`, patch);
