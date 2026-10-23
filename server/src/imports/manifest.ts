import { MAX_GROUP_DESCRIPTION, MAX_GROUP_NAME } from '../groups/service.ts';
import type { TreeFile } from '../lib/tree.ts';
import type { Skipped } from './pack.ts';

export const PLUGIN_JSON = '.claude-plugin/plugin.json';
export const MARKETPLACE_JSON = '.claude-plugin/marketplace.json';
const CODEX_PLUGIN_JSON = '.codex-plugin/plugin.json';
/** A plugin manifest is a few KB; a marketplace listing hundreds of plugins stays well under this. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Fatal: a lenient decode turns invalid bytes into U+FFFD, which would name a group rather than report the manifest. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** An untrusted manifest value for a skip reason. Never String() a list or object: a 10 KB nest of `[[[...]]]` overflows the stack there. */
export const shownValue = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : Array.isArray(v) ? '[...]' : isObject(v) ? '{...}' : String(v));

/**
 * An untrusted plugin manifest (plugin.json, marketplace.json, from any repository or zip): its
 * top-level object, or why it was ignored. Callers read fields with `stringField`, never trusting a type.
 */
export function parseManifest(bytes: Uint8Array): { ok: true; data: Record<string, unknown> } | { ok: false; reason: string } {
  if (bytes.length > MAX_MANIFEST_BYTES) return { ok: false, reason: `larger than ${MAX_MANIFEST_BYTES / 1024} KB` };
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { ok: false, reason: 'not valid UTF-8' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  return isObject(data) ? { ok: true, data } : { ok: false, reason: 'not a JSON object' };
}

/** A string field, trimmed; undefined when absent or blank. A non-string or one over `max` characters is undefined too, with the problem in `problems`. */
export function stringField(obj: Record<string, unknown>, key: string, max: number, problems: string[]): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    problems.push(`'${key}' is not a string`);
    return undefined;
  }
  const s = v.trim();
  if (s.length > max) {
    problems.push(`'${key}' is longer than ${max} characters`);
    return undefined;
  }
  return s || undefined;
}

export interface PluginMeta {
  name?: string;
  description?: string;
  skipped: Skipped[];
}

/** A marketplace.json that parseManifest refused, in the one wording detection (pluginRoots) and pluginMeta share, so importTree lists it once. */
export const marketplaceIgnored = (reason: string): Skipped => ({ path: MARKETPLACE_JSON, reason: `marketplace manifest ignored: ${reason}` });

/**
 * The group a plugin import creates takes its name and description from the plugin's own manifest
 * (5w3w): `.claude-plugin/plugin.json`, else a `.claude-plugin/marketplace.json` listing exactly one
 * plugin, else Codex's `.codex-plugin/plugin.json`. The name is `displayName`, else `name`. A bad
 * manifest or field is ignored and reported, never a failed import; a bad marketplace.json is skipped
 * over to the Codex manifest.
 */
export function pluginMeta(tree: TreeFile[]): PluginMeta {
  const skipped: Skipped[] = [];
  for (const path of [PLUGIN_JSON, MARKETPLACE_JSON, CODEX_PLUGIN_JSON]) {
    const f = tree.find((x) => x.path === path);
    if (!f) continue;
    const m = parseManifest(f.bytes);
    if (!m.ok) {
      if (path === MARKETPLACE_JSON) {
        skipped.push(marketplaceIgnored(m.reason));
        continue;
      }
      return { skipped: [...skipped, { path, reason: `plugin manifest ignored: ${m.reason}` }] };
    }
    let entry = m.data;
    if (path === MARKETPLACE_JSON) {
      const plugins = m.data.plugins;
      if (!Array.isArray(plugins) || plugins.length !== 1 || !isObject(plugins[0])) continue;
      entry = plugins[0];
    }
    const problems: string[] = [];
    const name = stringField(entry, 'displayName', MAX_GROUP_NAME, problems) ?? stringField(entry, 'name', MAX_GROUP_NAME, problems);
    const description = stringField(entry, 'description', MAX_GROUP_DESCRIPTION, problems);
    return { name, description, skipped: [...skipped, ...problems.map((p) => ({ path, reason: `plugin manifest field ignored: ${p}` }))] };
  }
  return { skipped };
}
