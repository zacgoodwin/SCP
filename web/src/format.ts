const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

export function timeAgo(iso: string): string {
  const secs = (new Date(iso).getTime() - Date.now()) / 1000;
  if (Number.isNaN(secs)) return iso;
  for (const [unit, size] of STEPS) if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
  return 'just now';
}

export const dateTime = (iso: string) => new Date(iso).toLocaleString();

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Group picker label: the slug only when it adds something. */
export const groupLabel = (g: { name: string; slug: string }) => (g.name === g.slug ? g.slug : `${g.name} (${g.slug})`);

export const parseTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];

/**
 * UTF-8 text, or null when the bytes are not valid UTF-8 (treated as binary).
 * ignoreBOM keeps a leading BOM as U+FEFF, so decode -> TextEncoder round-trips the bytes exactly.
 */
export function decodeText(buf: ArrayBuffer): string | null {
  try {
    const s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    return s.includes('\u0000') ? null : s;
  } catch {
    return null;
  }
}

export function toBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
