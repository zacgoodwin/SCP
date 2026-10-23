import { crc32, inflateRawSync } from 'node:zlib';
import { zipSync, type Zippable } from 'fflate';
import { badRequest } from './http.ts';
import { normalizePath } from './paths.ts';
import { LIMITS, modeOf, tooLarge, type TreeFile } from './tree.ts';

const MB = 1024 * 1024;

interface CdEntry {
  name: string;
  mode: number;
  isDir: boolean;
  link: boolean;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const corrupt = (why = '') => badRequest(`not a valid zip file${why ? `: ${why}` : ''}`);

/** Caps one archive is held to; `what` names the unit in the 413 ('a version', 'a pack'). */
export interface ZipLimits {
  files: number;
  fileBytes: number;
  totalBytes: number;
  what: string;
}
/** A symlink entry safeUnzip left out: its path and the target it names. */
export interface ZipLink {
  path: string;
  target: string;
}
/** One item version (lib/tree.ts LIMITS): the single-file import. */
export const VERSION_LIMITS: ZipLimits = { ...LIMITS, what: 'a version' };
/**
 * A pack or repository (imports/pack.ts unpack) holds many units, each checked against LIMITS as it
 * becomes an item (items/service.ts checkLimits), so the archive itself is bounded only by what the
 * process can hold inflated. One file is bounded by the archive total, not a version's 10 MB: that cap
 * is the unit's to fail (it lands in `skipped`), never a reason to refuse the whole import.
 */
export const PACK_LIMITS: ZipLimits = { files: 20_000, fileBytes: 64 * MB, totalBytes: 64 * MB, what: 'a pack' };

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/**
 * An entry name. Bit 11 means UTF-8. Without it the spec says CP437, but macOS Archive Utility and
 * most current tools write UTF-8 without setting the bit, so UTF-8 is tried first; CP437 only for
 * bytes that are not valid UTF-8 (old DOS/Windows zips).
 */
function entryName(raw: Uint8Array, flags: number): string {
  if (flags & 0x800) return new TextDecoder().decode(raw);
  try {
    return utf8Strict.decode(raw);
  } catch {
    return Array.from(raw, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80])).join('');
  }
}

/**
 * Read the central directory ourselves for modes, entry types, sizes, CRCs and path validation.
 * Runs before anything is inflated. With `keep`, entries it declines are skipped here, before they
 * are validated, counted or sized: a GitHub zipball of a whole repository imports one folder.
 * With `skipLinks`, a symlink entry is kept as a link (safeUnzip reports it) instead of refusing the archive.
 */
function centralDirectory(u8: Uint8Array, keep: ((name: string) => boolean) | undefined, limits: ZipLimits, skipLinks: boolean): CdEntry[] {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  for (; e >= 0 && dv.getUint32(e, true) !== 0x06054b50; e--) if (u8.length - e > 22 + 0xffff) throw corrupt();
  if (e < 0) throw corrupt();
  const count = dv.getUint16(e + 10, true);
  let o = dv.getUint32(e + 16, true);
  if (count === 0xffff || o === 0xffffffff) throw badRequest('zip64 archives are not supported');
  if (!keep && count > limits.files * 2) throw tooLarge(`${limits.what} is limited to ${limits.files} files`);
  const out: CdEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (o + 46 > u8.length || dv.getUint32(o, true) !== 0x02014b50) throw corrupt();
    const os = dv.getUint8(o + 5); // high byte of "version made by"
    const flags = dv.getUint16(o + 8, true);
    const nameLen = dv.getUint16(o + 28, true);
    if (o + 46 + nameLen > u8.length) throw corrupt();
    const next = o + 46 + nameLen + dv.getUint16(o + 30, true) + dv.getUint16(o + 32, true);
    const raw = u8.subarray(o + 46, o + 46 + nameLen);
    // Windows PowerShell 5.1 Compress-Archive writes '\' separators (APPNOTE 4.4.17 says '/'). Converted
    // before every check, so '..\x' and 'C:\x' are still refused and 'a\b' beside 'a/b' is a duplicate;
    // a literal '\' in a Unix name was refused before, so no zip that imported changes meaning.
    const name = entryName(raw, flags).replaceAll('\\', '/');
    if (keep && !keep(name)) {
      o = next;
      continue;
    }
    const attr = dv.getUint32(o + 38, true);
    const mode = os === 3 ? attr >>> 16 : 0;
    const type = mode & 0o170000;
    const link = type === 0o120000;
    const isDir = !link && (name.endsWith('/') || type === 0o040000 || (attr & 0x10) !== 0);
    if (link && !skipLinks) throw badRequest(`symlinks are not allowed: '${name}'`);
    if (type && !link && type !== 0o100000 && type !== 0o040000) throw badRequest(`only regular files are allowed: '${name}'`);
    if (!isDir) normalizePath(name);
    if (seen.has(name)) throw badRequest(`duplicate zip entry '${name}'`);
    seen.add(name);
    out.push({
      name,
      mode: modeOf(mode),
      isDir,
      link,
      flags,
      method: dv.getUint16(o + 10, true),
      crc: dv.getUint32(o + 16, true),
      compressedSize: dv.getUint32(o + 20, true),
      size: dv.getUint32(o + 24, true),
      localOffset: dv.getUint32(o + 42, true),
    });
    o = next;
  }
  return out;
}

/**
 * Unzip an untrusted archive: validated paths, no symlinks, size/count/ratio caps before inflating.
 * The declared size is enforced while inflating (maxOutputLength) and the output must match it and
 * the CRC, so a lying header can neither burn CPU on a huge stream nor store a truncated file.
 * `keep(name)` picks the entries; the caps (`limits`, one version's by default) then apply to those alone (centralDirectory).
 * Symlinks refuse the archive unless `links` is given (pack and repository imports): then each one is
 * left out and pushed there with its target, the entry's stored bytes (capped at 255 characters),
 * which are only reported, never resolved or followed. Links count against the caps like files.
 */
export function safeUnzip(bytes: Uint8Array, keep?: (name: string) => boolean, limits: ZipLimits = VERSION_LIMITS, links?: ZipLink[]): TreeFile[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let files = 0;
  let total = 0;
  const spans: { e: CdEntry; start: number; end: number; o: number }[] = [];
  for (const e of centralDirectory(bytes, keep, limits, !!links)) {
    if (e.isDir) continue;
    if (++files > limits.files) throw tooLarge(`${limits.what} is limited to ${limits.files} files`);
    if (e.size > limits.fileBytes) throw tooLarge(`'${e.name}' is over ${limits.fileBytes / MB} MB`);
    if ((total += e.size) > limits.totalBytes) throw tooLarge(`${limits.what} is limited to ${limits.totalBytes / MB} MB uncompressed`);
    if (e.size > MB && e.size > 100 * e.compressedSize) throw tooLarge(`'${e.name}' compresses over 100:1`);
    if (e.flags & 0x1) throw badRequest(`'${e.name}' is encrypted`);
    const o = e.localOffset;
    if (o + 30 > bytes.length || dv.getUint32(o, true) !== 0x04034b50) throw corrupt(`bad local header for '${e.name}'`);
    const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
    if (start + e.compressedSize > bytes.length) throw corrupt(`'${e.name}' is truncated`);
    spans.push({ e, o, start, end: start + e.compressedSize });
  }
  // Entries must not share or overlap their bytes: every central record pointing at one 30 MB stream
  // would inflate it once per record, N times the CPU for one upload. Checked before inflating anything.
  const byOffset = [...spans].sort((a, b) => a.o - b.o);
  for (let i = 1; i < byOffset.length; i++) {
    if (byOffset[i].o < byOffset[i - 1].end) throw corrupt(`'${byOffset[i].e.name}' overlaps another entry`);
  }
  const out: TreeFile[] = [];
  for (const { e, start } of spans) {
    const raw = bytes.subarray(start, start + e.compressedSize);
    let data: Uint8Array;
    if (e.method === 0) data = raw;
    else if (e.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
      } catch {
        throw corrupt(`'${e.name}' does not inflate to its declared ${e.size} bytes`);
      }
    } else throw badRequest(`'${e.name}' uses unsupported compression method ${e.method}`);
    if (data.length !== e.size || crc32(data) !== e.crc) throw corrupt(`'${e.name}' fails its size or CRC check`);
    if (e.link) {
      links!.push({ path: e.name, target: new TextDecoder().decode(data).slice(0, 255) });
      continue;
    }
    // A stored entry is a view into the whole upload, which it would keep alive, so it is copied out; an
    // inflated one is already its own memory and only needs the plain Uint8Array prototype.
    out.push({ path: e.name, bytes: e.method === 0 ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mode: e.mode });
  }
  return out;
}

/**
 * Deflated zip with unix modes in the external attributes, so `unzip` restores exec bits. Entries
 * are stamped "now" unless `mtime` fixes them (deterministic bytes for a content hash).
 */
export function buildZip(files: TreeFile[], opts: { mtime?: Date } = {}): Uint8Array {
  const tree: Zippable = Object.create(null);
  for (const f of files) tree[f.path] = [f.bytes, { os: 3, attrs: ((0o100000 | f.mode) << 16) >>> 0, ...(opts.mtime ? { mtime: opts.mtime } : {}) }];
  return zipSync(tree, { level: 6 });
}
