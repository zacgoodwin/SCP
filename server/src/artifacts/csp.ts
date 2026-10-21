// Same rule as the MCP Apps basic-host: an entry that could smuggle a directive separator, a quoted
// keyword ('unsafe-eval') or a second source is dropped, never repaired.
const ORIGIN = /^https?:\/\/[a-z0-9.*-]+(:\d+)?$/i;

export function sanitizeCspDomains(list: string[]): string[] {
  return list.filter((d) => typeof d === 'string' && !/[;,'"\s]/.test(d) && ORIGIN.test(d));
}

const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals';

/**
 * CSP for rendered artifacts (research 8.3). The `sandbox` directive gives the document an opaque
 * origin even when opened top-level. Never add allow-same-origin: with allow-scripts on a shared
 * origin an artifact could lift its own sandbox and read other artifacts' storage.
 */
export function artifactCsp(cdns: string[], frameAncestors: string): string {
  const c = sanitizeCspDomains(cdns).join(' ');
  const src = (...s: string[]) => s.filter(Boolean).join(' ');
  return [
    SANDBOX,
    "default-src 'none'",
    `script-src ${src("'unsafe-inline'", c)}`,
    `style-src ${src("'unsafe-inline'", c, 'https://fonts.googleapis.com')}`,
    `font-src ${src('https://fonts.gstatic.com', c, 'data:')}`,
    'img-src data: blob: https:',
    'media-src data: blob: https:',
    `connect-src ${c || "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}
