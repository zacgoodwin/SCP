import type { Frontmatter } from '../lib/frontmatter.ts';
import { isTextPath, pathKey, relPath } from '../lib/paths.ts';
import { LIMITS, type TreeFile } from '../lib/tree.ts';
import { aKind, isExecutable, type Kind } from '../types.ts';

export interface Lint {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  path?: string;
  /** A frontmatter error an import accepted (0rdh): kept as a warning, shown as the item's "frontmatter errors" badge. */
  waived?: true;
}

/**
 * The errors an import may accept (0rdh): bad or missing frontmatter that Claude Code works around
 * (the folder name for a missing name, the first paragraph for a missing description). Any other
 * error still rejects the unit.
 */
export const FRONTMATTER_ERRORS = new Set(['frontmatter.invalid', 'skill.name.empty', 'skill.description.missing', 'skill.description.len', 'agent.name.missing', 'agent.description.missing']);

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PORTABLE_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);
/**
 * The frontmatter keys SCP knows for skills, agents, commands and output styles (docs/research/formats.md),
 * plus SCP's own. t1ge: past a blank line, an unclosed fence's YAML continues only on one of these (items/service.ts bodyOf).
 */
export const FRONTMATTER_KEYS = new Set([
  ...PORTABLE_KEYS,
  ...['when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable', 'disallowed-tools'],
  ...['model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell'],
  ...['tools', 'disallowedTools', 'color', 'skills', 'mcpServers', 'permissionMode', 'maxTurns', 'autoCompactWindow'],
  ...['memory', 'omitClaudeMd', 'isolation', 'initialPrompt', 'experimental', 'keep-coding-instructions', 'force-for-plugin'],
  ...['version', 'triggers', 'preamble-tier', 'requires', 'title', 'tags', 'globs', 'alwaysApply'],
]);
const MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit']);
const COLORS = new Set(['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']);
// DESIGN.md body sections, fixed order; aliases share a slot.
const DESIGN_SECTIONS = [
  ['overview', 'brand & style'],
  ['colors'],
  ['typography'],
  ['layout', 'layout & spacing'],
  ['elevation & depth', 'elevation'],
  ['shapes'],
  ['components'],
  ['dos and donts'],
];

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** A CLI name in `requires` (f9j0): the item-name rule, so it is also a safe shell word. */
export const CLI_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** CLIs stored per version; more is a lint warning and the rest are dropped. */
export const MAX_REQUIRES = 50;

/**
 * The CLIs a version needs, from frontmatter `metadata.requires` (portable) and top-level `requires`
 * (context-builder's spelling): a list of names or one name. Sorted, deduplicated, capped at
 * MAX_REQUIRES. db.ts migration 16 backfills older versions with the same rule in SQL.
 */
export function parseRequires(d: Record<string, unknown>): { names: string[]; invalid: string[]; topLevel: boolean; dropped: number } {
  const meta = d.metadata && typeof d.metadata === 'object' && !Array.isArray(d.metadata) ? (d.metadata as Record<string, unknown>).requires : undefined;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);
  const raw = [...list(meta), ...list(d.requires)];
  const valid = [...new Set(raw.filter((n): n is string => typeof n === 'string' && CLI_NAME.test(n)))].sort();
  return {
    names: valid.slice(0, MAX_REQUIRES),
    invalid: raw.filter((n) => !(typeof n === 'string' && CLI_NAME.test(n))).map((n) => String(n).slice(0, 80)),
    topLevel: d.requires !== undefined,
    dropped: Math.max(0, valid.length - MAX_REQUIRES),
  };
}

/**
 * mc52: `${CLAUDE_PLUGIN_ROOT}/<p>` or `$CLAUDE_PLUGIN_ROOT/<p>`, a quote allowed between the variable and
 * the slash (the plugin docs write `"${CLAUDE_PLUGIN_ROOT}"/scripts/format.sh`); `<p>` ends at whitespace,
 * a quote or `}`.
 */
const ROOT_REF = /\$(?:\{CLAUDE_PLUGIN_ROOT\}|CLAUDE_PLUGIN_ROOT\b)["']?\/([^\s"'}]+)/g;

/** A skill's or command's body runs shell as it renders (!`cmd` or ```!), before the model sees it; pre-approved by allowed-tools, without a prompt. */
const injectsShell = (body: string) => /!`[^`\n]+`/.test(body) || /^```!/m.test(body);

/**
 * Review (exec-flag, output-style-force): whether a version acts on the installing machine once its plugin is
 * enabled, with no step of the user's: a hook or MCP server always; a skill or command whose entry frontmatter
 * registers `hooks` (kept by plugin skills, run once invoked) or whose body runs shell as it renders; an output
 * style with `force-for-plugin` set, which replaces the user's own style in every session (truthy, so any value
 * Claude Code might read as set counts). Agents are not: plugin agents ignore `hooks`. Stored per version
 * (item_versions.executable, written by items/service.ts insertVersion, backfilled by db.ts migration 20) and read
 * by the group flag and its warnings. The include withholding reads the kind instead (groups/service.ts withheldExec).
 */
export function versionExecutable(kind: Kind, fm: Frontmatter | null, entryText: string): boolean {
  if (isExecutable(kind)) return true;
  const d = fm?.data ?? {};
  if (kind === 'skill' || kind === 'command') return 'hooks' in d || injectsShell(fm?.body ?? entryText);
  return kind === 'output-style' && !!d['force-for-plugin'];
}

/** The JSON object an executable kind's entry (hooks.json, .mcp.json) holds, or null. */
export function entryJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** SQLite's JSON nesting limit: json_valid is 0 past it (node:sqlite 3.53). */
const SQL_JSON_DEPTH = 1000;

/**
 * Why SQLite reads this valid JSON text otherwise than JSON.parse (and Claude Code) does, or null: a key
 * repeated in the top-level object or its `mcpServers` object (SQLite keeps the first, JSON.parse the last),
 * or nesting past SQL_JSON_DEPTH (SQLite refuses the whole text, so no names at all). Then a server name
 * SERVER_NAMES compares would not be the one installed. One pass over the text, strings skipped.
 */
export function sqlJsonDivergence(text: string): string | null {
  const stack: { keys: Set<string> | null; obj: boolean; key: boolean }[] = [];
  let last = ''; // the key last read in the top-level object
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.obj && top.key) {
        top.key = false;
        const k = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys?.has(k)) return `repeats the key '${k.slice(0, 100)}', which SCP and Claude Code would read differently`;
        top.keys?.add(k);
        if (stack.length === 1) last = k;
      }
      i = j;
    } else if (c === '{' || c === '[') {
      if (stack.length >= SQL_JSON_DEPTH) return `nests deeper than ${SQL_JSON_DEPTH} levels`;
      const watched = c === '{' && (stack.length === 0 || (stack.length === 1 && last === 'mcpServers'));
      stack.push({ keys: watched ? new Set() : null, obj: c === '{', key: c === '{' });
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack.at(-1)?.obj) stack.at(-1)!.key = true;
  }
  return null;
}

/** The `<p>` of every plugin-root reference in the strings of a JSON value, walked with a stack: an entry can nest deeper than the call stack. */
export function pluginRootRefs(json: unknown): string[] {
  const out = new Set<string>();
  const stack = [json];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') for (const m of v.matchAll(ROOT_REF)) out.add(m[1]);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) stack.push(x);
  }
  return [...out];
}

/**
 * mc52: the first path segments where Claude Code loads a plugin's components by itself (`bin/` goes on
 * the PATH, `.lsp.json` starts servers, `agents/*.md` load as agents, SCP's own manifest and `.mcp.json`;
 * a root `SKILL.md` in a plugin with no skills/ and no `skills` key loads as a skill, which a group
 * without skill members has).
 * A hook's or MCP server's other files land at their stored paths at the plugin root, so none may sit
 * here (lint `exec.path.reserved`), and an import never takes one for them. Folded (pathKey): an install
 * disk may be case-insensitive, where `BIN/` is `bin/`.
 */
const COMPONENT_SEGMENTS = new Set(['skills', 'agents', 'commands', 'output-styles', 'hooks', 'monitors', 'themes', 'workflows', 'bin', '.claude-plugin', 'settings.json', '.lsp.json', '.mcp.json', 'skill.md']);
/** The folded component segment `path` starts with, or undefined. */
export function componentOf(path: string): string | undefined {
  const first = pathKey(path.split('/')[0]);
  return COMPONENT_SEGMENTS.has(first) ? first : undefined;
}

/** Missing references reported per version; the rest are counted. */
const MAX_REF_LINTS = 20;

/**
 * Lint one version (docs/research/formats.md 7.5, claude-code profile). Errors are the cases where
 * the client would silently ignore the file; writes with any error are rejected.
 */
export function lintVersion(
  kind: Kind,
  name: string,
  files: TreeFile[],
  fm: Frontmatter | null,
  entry?: { path: string; text: string },
): Lint[] {
  const out: Lint[] = [];
  const add = (level: Lint['level'], code: string, message: string, path = entry?.path) =>
    out.push(path ? { level, code, message, path } : { level, code, message });
  const d = fm?.data ?? {};
  const body = fm?.body ?? entry?.text ?? '';

  if (fm?.error) add(kind === 'skill' || kind === 'agent' ? 'error' : 'warn', 'frontmatter.invalid', `frontmatter: ${fm.error}`);
  else if ((kind === 'skill' || kind === 'agent') && entry) {
    // Claude Code needs '---' as the very first bytes; a BOM, blank line or '---js' fence hides the file.
    if (fm?.hasFrontmatter ? entry.text.startsWith('﻿') : /^[﻿\s]*---/.test(entry.text)) {
      add('error', 'frontmatter.invalid', "frontmatter must open with '---' on line 1 (no BOM, no leading blank line, no '---js')");
    }
  }

  if (kind === 'skill') {
    // rv5z: `name: ""` is a missing name (a frontmatter error an import may accept), not a malformed one.
    const blank = str(d.name)?.trim() === '';
    const fmName = blank ? undefined : str(d.name);
    const eff = fmName ?? name;
    if (blank) add('error', 'skill.name.empty', 'frontmatter name is empty');
    if (!SKILL_NAME.test(eff) || eff.length > 64) add('error', 'skill.name.format', `skill name '${eff}' must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be at most 64 chars`);
    if (fmName !== undefined && fmName !== name) add('error', 'skill.name.dir', `frontmatter name '${fmName}' must equal the item name '${name}' (its install folder)`);
    if (/anthropic|claude/.test(eff)) add('warn', 'skill.name.reserved', `skill names containing 'anthropic' or 'claude' are reserved on claude.ai and the Skills API`);
    const desc = str(d.description)?.trim() ?? '';
    if (!desc) add('error', 'skill.description.missing', 'frontmatter description is required');
    else if (desc.length > 1024) add('error', 'skill.description.len', 'description is over 1024 chars');
    if (desc.length + (str(d.when_to_use)?.length ?? 0) > 1536) add('warn', 'skill.listing.truncated', 'description + when_to_use over 1536 chars is truncated in the skill listing');
    if (d.compatibility !== undefined && String(d.compatibility).length > 500) add('error', 'skill.compatibility.len', 'compatibility is over 500 chars');
    const extra = Object.keys(d).filter((k) => !PORTABLE_KEYS.has(k));
    if (extra.length) add('info', 'skill.keys.nonportable', `keys outside the portable set (claude.ai / Skills API reject them): ${extra.join(', ')}`);
    if (body.split('\n').length > 500 || body.length / 4 > 5000) add('warn', 'skill.body.long', 'SKILL.md body is over 500 lines or ~5k tokens; move detail into referenced files');
    if (files.reduce((n, f) => n + f.bytes.length, 0) > LIMITS.totalBytes) add('error', 'skill.size', 'skill is over 30 MB uncompressed');
    for (const f of files) {
      if (isTextPath(f.path) && /~\/\.claude\/skills\/|\$HOME\/\.claude\//.test(utf8.decode(f.bytes))) {
        add('warn', 'skill.path.hardcoded', 'hard-coded install path; use ${CLAUDE_SKILL_DIR}', f.path);
      }
    }
  }

  // Commands take the same frontmatter and body as skills (versionExecutable).
  if (kind === 'skill' || kind === 'command') {
    if (injectsShell(body)) add('warn', `${kind}.exec.inject`, 'body runs shell commands (!`cmd` or ```!) before the model sees it');
    if ('hooks' in d) add('warn', `${kind}.hooks`, 'frontmatter registers hooks that run on invocation');
  }

  if (kind === 'agent') {
    const n = str(d.name)?.trim();
    if (!n) add('error', 'agent.name.missing', 'frontmatter name is required');
    else {
      if (n.includes(':')) add('error', 'agent.name.colon', "agent name must not contain ':' (reserved for plugin scoping)");
      if (n.startsWith('-')) add('error', 'agent.name.dash', "agent name must not start with '-'");
      if (n.length > 256) add('error', 'agent.name.len', 'agent name is over 256 chars');
    }
    if (!str(d.description)?.trim()) add('error', 'agent.description.missing', 'frontmatter description is required');
    const model = d.model;
    if (model !== undefined && !(typeof model === 'string' && (MODELS.has(model) || model.startsWith('claude-')))) {
      add('warn', 'agent.model.unknown', `unknown model '${String(model)}'`);
    }
    if (d.color !== undefined && !COLORS.has(String(d.color))) add('warn', 'agent.color.invalid', `color must be one of ${[...COLORS].join(', ')}`);
    const skills = Array.isArray(d.skills) ? d.skills : typeof d.skills === 'string' ? d.skills.split(/[,\s]+/).filter(Boolean) : [];
    if (skills.length > 32) add('error', 'agent.skills.max32', 'an agent can preload at most 32 skills');
  }

  if (fm && !fm.error) {
    const r = parseRequires(d);
    if (r.names.length) add('info', 'requires.found', `requires CLIs: ${r.names.join(', ')}`);
    if (r.invalid.length) add('warn', 'requires.invalid', `requires names must match ^[a-z0-9][a-z0-9._-]{0,63}$; ignored: ${r.invalid.slice(0, 10).join(', ')}`);
    if (r.dropped) add('warn', 'requires.max', `at most ${MAX_REQUIRES} required CLIs are kept; ${r.dropped} dropped`);
    if (r.topLevel) add('info', 'requires.toplevel', 'top-level requires is outside the portable key set; prefer metadata.requires');
  }

  // mc52: every output-style field is optional (the file name stands in for `name`), so these only warn.
  if (kind === 'output-style' && fm && !fm.error) {
    if (!str(d.description)?.trim()) add('warn', 'output-style.description.missing', 'no frontmatter description: the /output-style picker shows none');
    const keep = d['keep-coding-instructions'];
    if (keep !== undefined && typeof keep !== 'boolean') add('warn', 'output-style.keep-coding-instructions', 'keep-coding-instructions must be true or false; Claude Code ignores anything else');
    if (d['force-for-plugin']) add('warn', 'output-style.force', "force-for-plugin replaces every installer's own output style while the plugin is enabled, without their choosing it");
  }

  if (isExecutable(kind) && entry) {
    const key = kind === 'hook' ? 'hooks' : 'mcpServers';
    const json = entryJson(entry.text);
    const map = json?.[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      add('error', kind === 'hook' ? 'hook.json.invalid' : 'mcp.json.invalid', `${entry.path} must be a JSON object with a top-level '${key}' object`);
    } else {
      // SCP's own plugin entry is scp-<group> (groups/bundle.ts buildPlugin): a member's server of that name would replace it.
      const reserved = kind === 'mcp-server' ? Object.keys(map).filter((n) => /^scp-/i.test(n)) : [];
      if (reserved.length) add('error', 'mcp.name.reserved', `MCP server names starting 'scp-' are SCP's own (its plugin's server is scp-<group>): ${reserved.slice(0, 10).join(', ')}`);
      // groups/service.ts SERVER_NAMES reads the server names in SQLite, which must see the names Claude Code does.
      const odd = kind === 'mcp-server' ? sqlJsonDivergence(entry.text) : null;
      if (odd) add('error', 'mcp.json.invalid', `${entry.path} ${odd}`);
      // A reference resolves against the plugin root, where the item's files land (plugin.zip); one that names none of them fails there.
      const held = new Set<string>();
      for (const f of files) for (let i = f.path.length; i > 0; i = f.path.lastIndexOf('/', i - 1)) held.add(f.path.slice(0, i));
      const missing = pluginRootRefs(json).filter((p) => !held.has(relPath(p) ?? ''));
      for (const p of missing.slice(0, MAX_REF_LINTS)) add('warn', 'exec.ref.missing', `'\${CLAUDE_PLUGIN_ROOT}/${p.slice(0, 200)}' names no file of this item, so it fails where the plugin is installed`);
      if (missing.length > MAX_REF_LINTS) add('warn', 'exec.ref.missing', `${missing.length - MAX_REF_LINTS} more references name no file of this item`);
    }
    // One error per component. A hook's own hooks/ holds its scripts: the one file there Claude Code loads, hooks/hooks.json, is its entry.
    const reserved = new Map<string, string>();
    for (const f of files) {
      const c = f.path === entry.path ? undefined : componentOf(f.path);
      if (c && !(kind === 'hook' && c === 'hooks') && !reserved.has(c)) reserved.set(c, f.path);
    }
    for (const [c, path] of reserved) add('error', 'exec.path.reserved', `'${path.slice(0, 200)}' is where Claude Code loads another plugin component (${c}); ${aKind(kind)} cannot ship it`, path);
    add('info', 'exec.runs_code', kind === 'hook' ? 'runs commands on Claude Code events on the installing machine, as part of a plugin' : 'starts MCP servers on the installing machine, as part of a plugin');
  }

  if (kind === 'instructions' && fm?.hasFrontmatter) {
    add('warn', 'instructions.frontmatter.present', 'most clients render instruction-file frontmatter as plain text');
  }

  if (kind === 'design') {
    let last = -1;
    // Linear on purpose, like firstHeading (items/service.ts): a lazy group before [ \t#]* backtracks
    // quadratically over a run of spaces. `.` stops at \r and \n, so the trim loop drops the rest.
    for (const m of body.matchAll(/^##[ \t]+(.*)$/gm)) {
      let end = m[1].length;
      while (end > 0 && ' \t#'.includes(m[1][end - 1])) end--;
      const title = m[1].slice(0, end);
      if (!title) continue;
      const h = title.toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ');
      const idx = DESIGN_SECTIONS.findIndex((aliases) => aliases.includes(h));
      if (idx === -1) continue;
      if (idx <= last) add('warn', 'design.section.order', `section '${title}' is out of order or repeated (Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts)`);
      last = Math.max(last, idx);
    }
  }
  return out;
}
