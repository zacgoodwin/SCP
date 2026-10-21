import { resolve } from 'node:path';
import { sanitizeCspDomains } from './artifacts/csp.ts';

export interface Config {
  port: number;
  artifactPort: number;
  /** App origin as browsers and agents reach it, no trailing slash. */
  publicUrl: string;
  /** Artifact (user content) origin, no trailing slash. Must differ from publicUrl. */
  artifactUrl: string;
  dbPath: string;
  adminEmail: string;
  adminUsername: string;
  adminPassword: string | null;
  allowRegistration: boolean;
  /** Script/style origins artifacts may load from (CSP allowlist). */
  cdns: string[];
  webDist: string;
  secureCookies: boolean;
  /** Trust X-Forwarded-For / X-Real-IP for the audit IP (only behind a proxy that sets them). */
  trustProxy: boolean;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * true/1/yes or false/0/no, any case; unset or '' (compose passes unset as '') is the default.
 * Anything else stops the boot: SCP_ALLOW_REGISTRATION=FALSE used to leave registration open.
 */
export function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  throw new Error(`${name} must be true or false (also 1/0, yes/no), not '${env[name]}'`);
}

/** Script origins; an entry the CSP sanitizer would drop is named at boot instead of vanishing. */
function loadCdns(raw: string): string[] {
  const list = raw.split(/\s+/).filter(Boolean).map(trimSlash);
  const kept = sanitizeCspDomains(list);
  for (const d of list) if (!kept.includes(d)) console.warn(`SCP_ARTIFACT_CDNS: ignoring '${d}' (must be an origin like https://cdn.example.com)`);
  return kept;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  const artifactPort = Number(env.SCP_ARTIFACT_PORT ?? 8081);
  const publicUrl = trimSlash(env.SCP_PUBLIC_URL ?? `http://localhost:${port}`);
  const artifactUrl = trimSlash(env.SCP_ARTIFACT_URL ?? `http://localhost:${artifactPort}`);
  if (new URL(publicUrl).origin === new URL(artifactUrl).origin) {
    throw new Error('SCP_ARTIFACT_URL must be a different origin from SCP_PUBLIC_URL');
  }
  return {
    port,
    artifactPort,
    publicUrl,
    artifactUrl,
    dbPath: env.SCP_DB_PATH ?? resolve('data/scp.db'),
    adminEmail: env.SCP_ADMIN_EMAIL ?? 'admin@localhost',
    adminUsername: env.SCP_ADMIN_USERNAME ?? 'admin',
    adminPassword: env.SCP_ADMIN_PASSWORD || null,
    allowRegistration: envBool(env, 'SCP_ALLOW_REGISTRATION', true),
    // || not ??: compose passes an unset variable through as '' and that must mean the default list.
    cdns: loadCdns(env.SCP_ARTIFACT_CDNS ||
      'https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com'),
    webDist: env.SCP_WEB_DIST ?? resolve(import.meta.dirname, '../../web/dist'),
    secureCookies: publicUrl.startsWith('https://'),
    trustProxy: envBool(env, 'SCP_TRUST_PROXY', false),
  };
}
