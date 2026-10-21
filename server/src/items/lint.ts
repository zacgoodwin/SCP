import type { Frontmatter } from '../lib/frontmatter.ts';
import { isTextPath } from '../lib/paths.ts';
import { LIMITS, type TreeFile } from '../lib/tree.ts';
import type { Kind } from '../types.ts';

export interface Lint {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  path?: string;
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PORTABLE_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);
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
    const fmName = str(d.name);
    const eff = fmName ?? name;
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
    if (/!`[^`\n]+`/.test(body) || /^```!/m.test(body)) add('warn', 'skill.exec.inject', 'body runs shell commands (!`cmd` or ```!) before the model sees it');
    if ('hooks' in d) add('warn', 'skill.hooks', 'frontmatter registers hooks that run on invocation');
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
