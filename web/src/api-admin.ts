// D4 admin API (docs/PLAN-v2.md): settings, blob GC, filtered audit, user account edits, OAuth clients (D2's endpoints).
import { json, qs, type AuditEvent, type User } from './api.ts';

export type SettingSource = 'env' | 'settings' | 'none';
export type OidcField = 'issuer' | 'clientId' | 'clientSecret' | 'autoRegister' | 'label';
export type ImportField = 'maxItems' | 'maxArchiveMb' | 'maxPackMb';

export interface AdminSettings {
  /** `envFields`: set by the environment, read-only; `source` 'env' only when an IdP value (issuer, client id, secret) is. */
  oidc: { issuer: string | null; clientId: string | null; clientSecretSet: boolean; autoRegister: boolean; label: string; source: SettingSource; envFields: OidcField[] };
  github: { tokenSet: boolean; source: SettingSource };
  /** Effective import limits; `envFields` are set by the environment (SCP_IMPORT_*), read-only. */
  imports: Record<ImportField, number> & { envFields: ImportField[] };
  registration: { enabled: boolean; source: 'env' };
  storage: { blobs: number; blobBytes: number; orphanBlobs: number; orphanBytes: number; items: number; versions: number; users: number; groups: number };
}

/** '' clears a value, omitted keeps it. */
export interface SettingsPatch {
  oidc?: { issuer?: string; clientId?: string; clientSecret?: string; autoRegister?: boolean | ''; label?: string };
  github?: { token?: string };
  imports?: Partial<Record<ImportField, number | ''>>;
}

export interface SweepResult {
  deletedBlobs: number;
  freedBytes: number;
}

export interface AuditFilter {
  limit?: number;
  /** Events with an id below this one (the list is newest first). */
  before?: number;
  user?: string;
  /** Action prefix, e.g. `item.` */
  action?: string;
  /** Substring of the target id or detail. */
  q?: string;
}

/** D2's shape for GET /oauth/clients. */
export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  authMethod: string;
  createdAt: string;
  disabled: boolean;
  grants: number;
}

export const getSettings = () => json<AdminSettings>('GET', '/admin/settings');
export const putSettings = (patch: SettingsPatch) => json<AdminSettings>('PUT', '/admin/settings', patch);
export const runGc = () => json<SweepResult>('POST', '/admin/gc');
export const listAllAudit = (f: AuditFilter) => json<{ events: AuditEvent[] }>('GET', `/audit${qs({ all: 1, ...f })}`);
export const updateUserAccount = (id: string, patch: { username?: string; email?: string }) => json<{ user: User }>('PATCH', `/users/${id}`, patch);
/** Drop a user's single sign-on link (409 when the account has no password: it would become unreachable). */
export const unlinkUserOidc = (id: string) => json<{ user: User }>('PATCH', `/users/${id}`, { oidcUnlink: true });
/** One page of clients, newest first (default 50, max 200), with the total: anonymous registration makes the list attacker-sized. */
export const listOAuthClients = (opts: { limit?: number; offset?: number } = {}) => json<{ clients: OAuthClient[]; total: number }>('GET', `/oauth/clients${qs(opts)}`);
export const patchOAuthClient = (id: string, disabled: boolean) => json<{ client: OAuthClient }>('PATCH', `/oauth/clients/${id}`, { disabled });
