import { isScalar, parseDocument, visit } from 'yaml';

/** Larger fenced blocks are a lint error, not parsed: a parse is ~1 ms per KB and runs on reads too. */
export const MAX_FRONTMATTER = 64 * 1024;

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
  /** YAML or fence problem, for lint. Parsing never throws. */
  error?: string;
}

/**
 * Frontmatter exists only when line 1 (after an optional BOM, CRLF ok) is exactly `---`; it closes
 * at the next line that is `---` or `...`. YAML only, never gray-matter (its `---js` engine evals).
 */
export function parseFrontmatter(src: string): Frontmatter {
  const text = src.startsWith('﻿') ? src.slice(1) : src;
  const open = /^---\r?\n/.exec(text);
  if (!open) return { data: {}, body: text, hasFrontmatter: false };
  let pos = open[0].length;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const line = text.slice(pos, nl === -1 ? undefined : nl).replace(/\r$/, '');
    if (line === '---' || line === '...') {
      const body = nl === -1 ? '' : text.slice(nl + 1);
      if (pos - open[0].length > MAX_FRONTMATTER) return { data: {}, body, hasFrontmatter: true, error: 'frontmatter is over 64 KB' };
      return parseYaml(text.slice(open[0].length, pos), body);
    }
    if (nl === -1) return { data: {}, body: text, hasFrontmatter: true, error: 'frontmatter is not closed' };
    pos = nl + 1;
  }
}

function parseYaml(src: string, body: string): Frontmatter {
  const fail = (error: string): Frontmatter => ({ data: {}, body, hasFrontmatter: true, error });
  try {
    // yaml's own uniqueKeys compares every key with every other (10k keys: 0.7 s); a Set per map is
    // the same rule (equal scalar values, or the same node) in linear time.
    const doc = parseDocument(src, { schema: 'core', uniqueKeys: false });
    // Warnings include unresolved custom tags (!!js/function); treat them as errors.
    const problem = doc.errors[0] ?? doc.warnings[0];
    if (problem) return fail(problem.message.split('\n')[0]);
    let duplicate = false;
    visit(doc, {
      Map(_, map) {
        const seen = new Set<unknown>();
        for (const { key } of map.items) {
          const k = isScalar(key) ? key.value : key;
          if (seen.has(k)) {
            duplicate = true;
            return visit.BREAK;
          }
          seen.add(k);
        }
      },
    });
    if (duplicate) return fail('Map keys must be unique');
    // No aliases at all: the 64 KB cap is on the YAML source, and `b: [*x, *x, ...]` over one 60 KB
    // anchor expands ~100x into the stored JSON, re-parsed on every /mcp request. Frontmatter needs none.
    const data: unknown = doc.toJS({ maxAliasCount: 0 }) ?? {};
    if (typeof data !== 'object' || Array.isArray(data)) return fail('frontmatter must be a YAML mapping');
    return { data: data as Record<string, unknown>, body, hasFrontmatter: true };
  } catch (e) {
    return fail((e as Error).message.split('\n')[0]);
  }
}
