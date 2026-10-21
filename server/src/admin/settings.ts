import { z } from 'zod';
import { OIDC_DEFAULT_LABEL } from '../config.ts';
import { tx, type Db } from '../db.ts';
import { HttpError, badRequest } from '../lib/http.ts';
import type { Ctx } from '../types.ts';

/** Settings table keys (docs/PLAN-v2.md "Settings keys"). D1 reads github.token, D3 reads oidc.*. */
export const SETTING_KEYS = {
  oidcIssuer: 'oidc.issuer',
  oidcClientId: 'oidc.client_id',
  oidcClientSecret: 'oidc.client_secret',
  oidcAutoRegister: 'oidc.auto_register',
  oidcLabel: 'oidc.label',
  githubToken: 'github.token',
} as const;

type Source = 'env' | 'settings' | 'none';
export type OidcField = 'issuer' | 'clientId' | 'clientSecret' | 'autoRegister' | 'label';

export interface SettingsView {
  /** `envFields`: the fields the environment sets (read-only, 400 env_managed); `source` 'env' when one of the IdP values comes from it. */
  oidc: { issuer: string | null; clientId: string | null; clientSecretSet: boolean; autoRegister: boolean; label: string; source: Source; envFields: OidcField[] };
  github: { tokenSet: boolean; source: Source };
  registration: { enabled: boolean; source: 'env' };
  storage: { blobs: number; blobBytes: number; orphanBlobs: number; orphanBytes: number; items: number; versions: number; users: number; groups: number };
}

const url = (what: string) =>
  z
    .string()
    .trim()
    .max(500)
    .refine((s) => s === '' || /^https?:\/\/[^\s/]+/.test(s), `${what} must be an http(s) URL`)
    .transform((s) => s.replace(/\/+$/, ''));

/** '' clears a value, omitted keeps it; autoRegister clears with ''. */
export const settingsPatchSchema = z.object({
  oidc: z
    .object({
      issuer: url('issuer').optional(),
      clientId: z.string().trim().max(500).optional(),
      clientSecret: z.string().max(2000).optional(),
      autoRegister: z.boolean().or(z.literal('')).optional(),
      label: z.string().trim().max(100).optional(),
    })
    .optional(),
  github: z.object({ token: z.string().trim().max(500).optional() }).optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const readSetting = (db: Db, key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

function writeSetting(db: Db, key: string, value: string): void {
  if (value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;

export function settingsView(ctx: Ctx): SettingsView {
  const { db, config } = ctx;
  const env = config.oidc;
  const envFields = (Object.keys(env) as OidcField[]).filter((k) => env[k] !== null);
  // Only the values that connect an IdP count as a configuration: a label or auto-register flag (set
  // in the environment, or a row left behind after clearing the issuer) does not make it "env" or
  // "configured" in the admin UI, and does not lock the other fields.
  const envOidc = envFields.some((k) => k === 'issuer' || k === 'clientId' || k === 'clientSecret');
  const row = (k: string) => readSetting(db, k);
  const oidcRows = [SETTING_KEYS.oidcIssuer, SETTING_KEYS.oidcClientId, SETTING_KEYS.oidcClientSecret];
  const autoRow = row(SETTING_KEYS.oidcAutoRegister);
  const orphan = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE NOT EXISTS (SELECT 1 FROM version_files f WHERE f.sha256 = blobs.sha256)')
    .get() as { n: number; bytes: number };
  const all = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs').get() as { n: number; bytes: number };
  return {
    oidc: {
      issuer: env.issuer ?? row(SETTING_KEYS.oidcIssuer),
      clientId: env.clientId ?? row(SETTING_KEYS.oidcClientId),
      clientSecretSet: !!(env.clientSecret ?? row(SETTING_KEYS.oidcClientSecret)),
      autoRegister: env.autoRegister ?? (autoRow === null ? true : autoRow === 'true'),
      label: env.label ?? row(SETTING_KEYS.oidcLabel) ?? OIDC_DEFAULT_LABEL,
      source: envOidc ? 'env' : oidcRows.some((k) => row(k) !== null) ? 'settings' : 'none',
      envFields,
    },
    github: {
      tokenSet: !!(config.githubToken ?? row(SETTING_KEYS.githubToken)),
      source: config.githubToken ? 'env' : row(SETTING_KEYS.githubToken) !== null ? 'settings' : 'none',
    },
    registration: { enabled: config.allowRegistration, source: 'env' },
    storage: {
      blobs: all.n,
      blobBytes: all.bytes,
      orphanBlobs: orphan.n,
      orphanBytes: orphan.bytes,
      items: count(db, 'SELECT COUNT(*) AS n FROM items'),
      versions: count(db, 'SELECT COUNT(*) AS n FROM item_versions'),
      users: count(db, 'SELECT COUNT(*) AS n FROM users'),
      groups: count(db, 'SELECT COUNT(*) AS n FROM scp_groups'),
    },
  };
}

const envManaged = (field: string) => new HttpError(400, 'env_managed', `${field} is set by the environment; unset the variable to manage it here`);

/** Apply a patch. A field whose env variable is set is read-only (400 env_managed). Returns the keys written. */
export function applySettings(ctx: Ctx, patch: SettingsPatch): string[] {
  const { db, config } = ctx;
  const writes: [string, string][] = [];
  const o = patch.oidc ?? {};
  const envFields: [keyof typeof config.oidc, string | undefined | boolean, string, string][] = [
    ['issuer', o.issuer, SETTING_KEYS.oidcIssuer, 'SCP_OIDC_ISSUER'],
    ['clientId', o.clientId, SETTING_KEYS.oidcClientId, 'SCP_OIDC_CLIENT_ID'],
    ['clientSecret', o.clientSecret, SETTING_KEYS.oidcClientSecret, 'SCP_OIDC_CLIENT_SECRET'],
    ['autoRegister', o.autoRegister, SETTING_KEYS.oidcAutoRegister, 'SCP_OIDC_AUTO_REGISTER'],
    ['label', o.label, SETTING_KEYS.oidcLabel, 'SCP_OIDC_LABEL'],
  ];
  for (const [field, value, key, envName] of envFields) {
    if (value === undefined) continue;
    if (config.oidc[field] !== null) throw envManaged(envName);
    writes.push([key, typeof value === 'boolean' ? String(value) : value]);
  }
  if (patch.github?.token !== undefined) {
    if (config.githubToken) throw envManaged('SCP_GITHUB_TOKEN');
    writes.push([SETTING_KEYS.githubToken, patch.github.token]);
  }
  if (!writes.length) throw badRequest('nothing to change');
  tx(db, () => {
    for (const [k, v] of writes) writeSetting(db, k, v);
  });
  return writes.map(([k]) => k);
}
