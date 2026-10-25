import { PACKAGE_DESCRIPTION, supply } from '../imports/pack.ts';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { HttpError, badRequest } from '../lib/http.ts';
import { isJunkPath } from '../lib/paths.ts';
import { stripTopFolder } from '../lib/tree.ts';
import { safeUnzip } from '../lib/zip.ts';
import { createItem, previewItem, type CreateItemInput } from './service.ts';
import type { Ctx, Format, ItemRow, Kind, Principal } from '../types.ts';

export interface ImportInput {
  filename: string;
  bytes: Uint8Array;
  kind?: Kind;
  visibility?: 'private' | 'public';
  name?: string;
  /** en8v: frontmatter description (a skill's or agent's name too) for an entry that has none, as jcfm does for pack and GitHub imports. */
  description?: string;
}

const ARTIFACT_EXT: Record<string, Format> = { html: 'html', htm: 'html', svg: 'svg', mmd: 'mermaid', jsx: 'react', tsx: 'react' };
const INSTRUCTION_FILES = new Set(['agents.md', 'claude.md', 'gemini.md', 'instructions.md']);

/**
 * en8v: `description` (with a skill's or agent's name) as the entry's frontmatter when it has none; a
 * file with its own keeps it. Nothing is stored to re-supply: the item has no source to update from. An
 * artifact carries no frontmatter, so the description is its item description.
 */
function described(input: CreateItemInput, description: string | undefined): CreateItemInput {
  if (description === undefined) return input;
  if (input.kind === 'artifact') return { ...input, description };
  if (input.kind === 'package') throw badRequest(PACKAGE_DESCRIPTION);
  const name = input.kind === 'skill' || input.kind === 'agent' ? previewItem(input)?.name : undefined;
  return { ...input, tree: supply(input.kind, input.tree!, name ? { name, description } : { description }) ?? input.tree };
}

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
    // F2: a package detected, not asked for, would refuse the description with a kind the user never chose: say why.
    if (!u.kind && kind === 'package' && u.description !== undefined) {
      throw badRequest('the zip has no SKILL.md or DESIGN.md, so it imports as a package, which has no one entry file to take a description: leave the description empty, or pick a kind');
    }
    // A zip's single wrapper folder is packaging, not content. Junk stays in so the write lints it.
    const unwrapped = top ? tree.map((f) => (f.path.startsWith(top + '/') ? { ...f, path: f.path.slice(top.length + 1) } : f)) : tree;
    return createItem(ctx, p, described({ ...common, kind, tree: unwrapped, fallbackName: top ?? base, folderName: top ?? undefined }, u.description));
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
    return createItem(ctx, p, described({ ...common, kind, format, tree: [{ path, bytes: u.bytes, mode: 420 }] }, u.description));
  }

  const format = ARTIFACT_EXT[ext];
  if (format) return createItem(ctx, p, described({ ...common, kind: 'artifact', format, tree: [{ path: file, bytes: u.bytes, mode: 420 }] }, u.description));
  throw new HttpError(400, 'unsupported_file', 'upload a .md, .zip, .skill, .html, .svg, .mmd, .jsx or .tsx file');
}
