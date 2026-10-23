import { parseFrontmatter } from '../lib/frontmatter.ts';
import { HttpError } from '../lib/http.ts';
import { isJunkPath } from '../lib/paths.ts';
import { stripTopFolder } from '../lib/tree.ts';
import { safeUnzip } from '../lib/zip.ts';
import { createItem } from './service.ts';
import type { Ctx, Format, ItemRow, Kind, Principal } from '../types.ts';

export interface ImportInput {
  filename: string;
  bytes: Uint8Array;
  kind?: Kind;
  visibility?: 'private' | 'public';
  name?: string;
}

const ARTIFACT_EXT: Record<string, Format> = { html: 'html', htm: 'html', svg: 'svg', mmd: 'mermaid', jsx: 'react', tsx: 'react' };
const INSTRUCTION_FILES = new Set(['agents.md', 'claude.md', 'gemini.md', 'instructions.md']);

/** Detect the kind of one uploaded file (.md, .zip/.skill, or an artifact source) and create it. */
export function importUpload(ctx: Ctx, p: Principal, u: ImportInput): ItemRow {
  const file = u.filename.slice(Math.max(u.filename.lastIndexOf('/'), u.filename.lastIndexOf('\\')) + 1);
  const dot = file.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.slice(dot + 1).toLowerCase();
  const base = dot === -1 ? file : file.slice(0, dot);
  const common = { name: u.name, visibility: u.visibility, fallbackName: base };

  if (ext === 'zip' || ext === 'skill') {
    if (u.kind === 'artifact') throw new HttpError(400, 'unsupported_file', 'an artifact is one file: upload the .html, .md, .svg, .mmd, .jsx or .tsx itself');
    const tree = safeUnzip(u.bytes);
    const { files, top } = stripTopFolder(tree.filter((f) => !isJunkPath(f.path)));
    const has = (path: string) => files.some((f) => f.path === path);
    const kind = u.kind ?? (has('SKILL.md') ? 'skill' : has('DESIGN.md') ? 'design' : 'package');
    // A zip's single wrapper folder is packaging, not content. Junk stays in so the write lints it.
    const unwrapped = top ? tree.map((f) => (f.path.startsWith(top + '/') ? { ...f, path: f.path.slice(top.length + 1) } : f)) : tree;
    return createItem(ctx, p, { ...common, kind, tree: unwrapped, fallbackName: top ?? base, folderName: top ?? undefined });
  }

  if (ext === 'md' || ext === 'markdown') {
    const text = new TextDecoder().decode(u.bytes);
    let kind = u.kind;
    if (!kind) {
      const fm = parseFrontmatter(text);
      const lower = file.toLowerCase();
      if (INSTRUCTION_FILES.has(lower) && !fm.hasFrontmatter) kind = 'instructions';
      else if (lower === 'design.md') kind = 'design';
      else if (lower === 'skill.md') kind = 'skill';
      else if (fm.data.name && fm.data.description) kind = 'agent';
      else kind = 'prompt';
    }
    // Single-file kinds re-home the file to their entry path; tree kinds need their entry at the root.
    const path = kind === 'skill' ? 'SKILL.md' : kind === 'design' ? 'DESIGN.md' : file;
    const format = kind === 'artifact' ? 'markdown' : undefined;
    return createItem(ctx, p, { ...common, kind, format, tree: [{ path, bytes: u.bytes, mode: 420 }] });
  }

  const format = ARTIFACT_EXT[ext];
  if (format) return createItem(ctx, p, { ...common, kind: 'artifact', format, tree: [{ path: file, bytes: u.bytes, mode: 420 }] });
  throw new HttpError(400, 'unsupported_file', 'upload a .md, .zip, .skill, .html, .svg, .mmd, .jsx or .tsx file');
}
