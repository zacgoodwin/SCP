import { sha256Hex } from './crypto.ts';
import { HttpError } from './http.ts';

/** One file of a version snapshot. mode is 420 (0644) or 493 (0755). */
export interface TreeFile {
  path: string;
  bytes: Uint8Array;
  mode: number;
}

export interface TreeEntry {
  path: string;
  mode: number;
  sha256: string;
}

const MB = 1024 * 1024;
export const LIMITS = { files: 1000, fileBytes: 10 * MB, totalBytes: 30 * MB, artifactEntryBytes: 5 * MB };

export const tooLarge = (message: string) => new HttpError(413, 'too_large', message);

/** Only the exec bit survives: 493 when any x bit is set, else 420. */
export const modeOf = (unixMode: number) => (unixMode & 0o111 ? 493 : 420);

/**
 * sha256 over the lines "<mode octal> <sha256> <path>\n" (e.g. "644 ab12... SKILL.md"), sorted as
 * UTF-8 bytes: the contract sync clients reimplement (PLAN.md), so no JS-only UTF-16 ordering.
 */
export function treeSha256(entries: TreeEntry[]): string {
  const lines = entries.map((e) => Buffer.from(`${e.mode.toString(8)} ${e.sha256} ${e.path}\n`, 'utf8')).sort(Buffer.compare);
  return sha256Hex(Buffer.concat(lines).toString('utf8'));
}

/** If every path sits under one shared top folder, strip it (`pdf/SKILL.md` -> `SKILL.md`). */
export function stripTopFolder<T extends { path: string }>(files: T[]): { files: T[]; top: string | null } {
  if (!files.length || !files[0].path.includes('/')) return { files, top: null };
  const top = files[0].path.slice(0, files[0].path.indexOf('/'));
  if (!files.every((f) => f.path.startsWith(top + '/'))) return { files, top: null };
  return { files: files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) })), top };
}

export function checkLimits(files: TreeFile[]): void {
  if (files.length > LIMITS.files) throw tooLarge(`at most ${LIMITS.files} files per version`);
  let total = 0;
  for (const f of files) {
    if (f.bytes.length > LIMITS.fileBytes) throw tooLarge(`'${f.path}' is over 10 MB`);
    total += f.bytes.length;
  }
  if (total > LIMITS.totalBytes) throw tooLarge('a version is limited to 30 MB uncompressed');
}
