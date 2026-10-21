import { Lexer, Marked, Tokenizer } from 'marked';
import { transform } from 'sucrase';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import type { Format } from '../types.ts';

export interface RenderOpts {
  title: string;
  /** Sanitized CSP script origins; mermaid/react need https://cdn.jsdelivr.net among them. */
  cdns: string[];
}

const MAX_SOURCE = 5 * 1024 * 1024;
/** Larger Markdown is shown as source: marked is ~1 s per 3 MB of ordinary text, and renders block the event loop. */
export const MAX_MARKDOWN = 512 * 1024;
/**
 * Each blockquote or list level re-lexes everything inside it ('> ' x 3000 over 400 KB: 14 s, deeper
 * overflows the stack), so a line opening over 64 levels is shown as source. Linear: the groups start
 * with distinct characters, so a failed line backtracks at most its own prefix.
 * ponytail: indentation-nested lists are not counted (deep code indentation would trip it) and cost
 * ~0.5 s at the cap; render in a worker thread if that matters.
 */
const DEEP_NESTING = /^(?:[ \t]*(?:>|[*+-][ \t]|\d{1,9}[.)][ \t])){65}/m;
/**
 * marked's GFM email lookaheads (`[a-zA-Z0-9.!#...]+@` in the text and url rules) re-scan the rest of
 * a run at every inline token, so '*a' x 100k is O(n^2) (200 KB: 8 s). Bound the local part at 64
 * chars, the RFC 5321 limit; longer ones only lose autolinking.
 */
const GFM = Lexer.rules.inline.gfm;
const boundEmail = (r: RegExp) => new RegExp(r.source.replace(/\]\+(\(?@)/g, ']{1,64}$1'), r.flags);
export const BOUNDED_INLINE = { ...GFM, text: boundEmail(GFM.text), url: boundEmail(GFM.url) };
// Every Lexer gets a fresh rules object pointing at the shared gfm set; swap in ours, then return
// false so marked's own tokenizer runs with it.
function useBounded(this: unknown): false {
  const rules = (this as { rules: { inline: unknown } }).rules;
  if (rules.inline !== BOUNDED_INLINE) rules.inline = BOUNDED_INLINE;
  return false;
}
/**
 * Each unclosed '*', '_' or '~' opener makes marked scan to the end of its paragraph for a closer, so
 * '*a ' x 170k (510 KB) is O(n^2) (60 KB: 24 s). The scans of one parse share a budget of characters:
 * a match costs its length, a miss the length it searched. Once spent, openers stay literal text.
 * Real documents spend a small fraction of it (a miss only scans the rest of one paragraph).
 */
const SCAN_BUDGET = 2_000_000;
let scanLeft = SCAN_BUDGET;
const WORD = /[\p{L}\p{N}]/u;
type Scan<T> = (this: Tokenizer, src: string, masked: string, prev?: string) => T | undefined;
/** opens: whether marked scans for a closer from this position (else a miss costs nothing). */
function boundedScan<T extends { raw: string }>(base: Scan<T>, opens: (src: string, prev: string) => boolean): Scan<T> {
  return function (src, masked, prev = '') {
    if (scanLeft <= 0) return undefined; // undefined, not false: false would run the unbounded original
    const w = Math.min(src.length, scanLeft);
    const at = masked.length - src.length; // masked is the whole run; src its unread tail
    const tok = base.call(this, src.slice(0, w), masked.slice(at, at + w), prev);
    scanLeft -= tok ? tok.raw.length : opens(src, prev) ? w : 0;
    return tok;
  };
}
const md = new Marked({
  gfm: true,
  async: false,
  tokenizer: {
    url: useBounded,
    inlineText: useBounded,
    // An intraword '_' cannot open, so marked returns before scanning.
    emStrong: boundedScan(Tokenizer.prototype.emStrong, (s, prev) => s[0] === '*' || (s[0] === '_' && !WORD.test(prev))),
    del: boundedScan(Tokenizer.prototype.del, (s) => s[0] === '~'),
  },
});
const CDN = 'https://cdn.jsdelivr.net';
// Pinned on purpose: the rendered page of an immutable version must not change under it.
export const MERMAID_URL = `${CDN}/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs`;
const REACT_VERSION = '19.3.0';
const IMPORT_MAP = {
  imports: {
    react: `${CDN}/npm/react@${REACT_VERSION}/+esm`,
    'react/jsx-runtime': `${CDN}/npm/react@${REACT_VERSION}/jsx-runtime/+esm`,
    'react-dom': `${CDN}/npm/react-dom@${REACT_VERSION}/+esm`,
    'react-dom/client': `${CDN}/npm/react-dom@${REACT_VERSION}/client/+esm`,
    // jsdelivr's react-dom/client bundle imports react by range; pin it to the same copy, or hooks
    // break on two Reacts once a newer 19.x ships.
    [`${CDN}/npm/react@%5E${REACT_VERSION}/+esm`]: `${CDN}/npm/react@${REACT_VERSION}/+esm`,
  },
};

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Text placed inside <script>: stop `</script` and `<!--` from changing the HTML parser state. */
const scriptSafe = (js: string) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const DARK = '--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--code:#161b22;--link:#4493f8';
/** Light/dark tokens; dataset.theme (set by the helper on {scp:'theme'}) overrides the OS preference. */
export const THEME_CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa;--link:#0969da}
:root[data-theme=light]{color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{color-scheme:dark;${DARK}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--link)}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875em}
pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:12px 16px;overflow:auto}`;

const MD_CSS = `main{max-width:760px;margin:0 auto;padding:32px 16px}
h1,h2{border-bottom:1px solid var(--line);padding-bottom:.3em}
:not(pre)>code{background:var(--code);padding:.2em .4em;border-radius:4px}
pre code{font-size:1em}
table{border-collapse:collapse;display:block;overflow:auto;margin:1em 0}
th,td{border:1px solid var(--line);padding:6px 12px}
blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:4px solid var(--line)}
img{max-width:100%}
hr{border:0;border-top:1px solid var(--line)}`;

const ERROR_CSS = '.scp-error{margin:16px;white-space:pre-wrap;color:#cf222e;border-color:#cf222e}';

function doc(title: string, head: string, body: string, bodyAttrs = ''): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${head}</head>
<body${bodyAttrs}>${body}</body></html>`;
}

function errorPage(title: string, heading: string, message: string): string {
  return doc(title, `<style>${THEME_CSS}${ERROR_CSS}</style>`, `<pre class="scp-error"><strong>${escapeHtml(heading)}</strong>\n${escapeHtml(message)}</pre>`);
}

function needsCdn(opts: RenderOpts, what: string): string | null {
  return opts.cdns.includes(CDN) ? null : errorPage(opts.title, `${what} cannot load`, `${what} artifacts load from ${CDN}, which is not in SCP_ARTIFACT_CDNS.`);
}

/**
 * Find the default export of compiled ESM so an inline module (which nothing can import) can mount
 * it. ponytail: regex over compiled output, so an `export default` inside a string literal can fool
 * it; parse with sucrase's tokenizer if that ever bites.
 */
function exposeDefault(code: string): { code: string; name: string | null } {
  // Linear on purpose, as is every pattern here: no two adjacent quantifiers can split one run of
  // whitespace (`\s*\*?\s*` was O(n^2) over spaces), and a list may not contain '{', so every scan
  // stops at the next 'export{' instead of running to the end of the source from each one.
  const named = /\bexport\s+default\s+(?=(?:async\s+)?function\b\s*(?:\*\s*)?([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))/.exec(code);
  if (named) return { code: code.slice(0, named.index) + code.slice(named.index + named[0].length), name: named[1] ?? named[2] };
  const anon = /\bexport\s+default\b/.exec(code);
  if (anon) return { code: `${code.slice(0, anon.index)}const __scpDefault =${code.slice(anon.index + anon[0].length)}`, name: '__scpDefault' };
  // `export { A, App as default }`: drop the default specifier, keep the other named exports.
  for (const list of code.matchAll(/\bexport\s*\{([^{}]*)\}(?!\s*from\b)\s*;?/g)) {
    const specs = list[1].split(',').map((x) => x.trim()).filter(Boolean);
    const i = specs.findIndex((x) => /^[A-Za-z_$][\w$]*\s+as\s+default$/.test(x));
    if (i < 0) continue;
    const name = specs.splice(i, 1)[0].split(/\s/)[0];
    const rest = specs.length ? `export { ${specs.join(', ')} };` : '';
    return { code: code.slice(0, list.index) + rest + code.slice(list.index + list[0].length), name };
  }
  return { code, name: null }; // no default export: the source renders itself
}

// Shows module load/run failures instead of a blank page.
const REACT_ERRORS = `addEventListener('error',function(e){var r=document.getElementById('root');if(!r||r.childNodes.length)return;var p=document.createElement('pre');p.className='scp-error';p.textContent=e.message||'a module failed to load';r.appendChild(p)},true);`;

function renderReact(source: string, opts: RenderOpts): string {
  const blocked = needsCdn(opts, 'React');
  if (blocked) return blocked;
  let compiled: string;
  try {
    compiled = transform(source, { transforms: ['jsx', 'typescript'], jsxRuntime: 'automatic', production: true }).code;
  } catch (e) {
    return errorPage(opts.title, 'Compile error', (e as Error).message);
  }
  const { code, name } = exposeDefault(compiled);
  const mount = name
    ? `\nimport { createRoot as __scpCreateRoot } from 'react-dom/client';\nimport { jsx as __scpJsx } from 'react/jsx-runtime';\n__scpCreateRoot(document.getElementById('root')).render(__scpJsx(${name}, {}));\n`
    : '\n';
  return doc(
    opts.title,
    `<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}${ERROR_CSS}</style>
<script type="importmap">${scriptSafe(JSON.stringify(IMPORT_MAP))}</script>
<script>${REACT_ERRORS}</script>`,
    `<div id="root"></div>
<script type="module">
${scriptSafe(code + mount)}</script>`,
  );
}

function renderMermaid(source: string, opts: RenderOpts): string {
  const blocked = needsCdn(opts, 'Mermaid');
  if (blocked) return blocked;
  return doc(
    opts.title,
    `<style>${THEME_CSS}body{display:grid;place-items:center;min-height:100vh}pre.mermaid{background:none;border:0}</style>`,
    `<pre class="mermaid">${escapeHtml(source)}</pre>
<script type="module">
import mermaid from '${MERMAID_URL}';
const t = document.documentElement.dataset.theme;
const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
await mermaid.run({ querySelector: 'pre.mermaid' });
</script>`,
  );
}

function renderMarkdown(source: string, opts: RenderOpts): string {
  const fm = parseFrontmatter(source);
  const body = fm.hasFrontmatter && !fm.error ? fm.body : source;
  const style = `<style>${THEME_CSS}${MD_CSS}</style>`;
  if (Buffer.byteLength(body, 'utf8') > MAX_MARKDOWN || DEEP_NESTING.test(body)) {
    const why = 'This Markdown is over 512 KB or nested over 64 levels deep, so it is shown as source.';
    return doc(opts.title, style, `<main><p>${why}</p><pre><code>${escapeHtml(body)}</code></pre></main>`);
  }
  // Raw HTML passes through: the sandbox CSP (opaque origin) is the containment, not sanitizing.
  scanLeft = SCAN_BUDGET;
  const html = md.parse(body) as string;
  return doc(opts.title, style, `<main>${html}</main>`);
}

function renderFormat(format: Format, source: string, opts: RenderOpts): string {
  switch (format) {
    case 'html':
      return /<html|<!doctype/i.test(source) ? source : doc(opts.title, '', source);
    case 'markdown':
      return renderMarkdown(source, opts);
    case 'svg':
      return doc(opts.title, '', source, ' style="margin:0;display:grid;place-items:center;min-height:100vh"');
    case 'mermaid':
      return renderMermaid(source, opts);
    case 'react':
      return renderReact(source, opts);
    default:
      return doc(opts.title, `<style>${THEME_CSS}body{background:var(--code)}pre{margin:0;border:0;border-radius:0;min-height:100vh;box-sizing:border-box}</style>`, `<pre><code>${escapeHtml(source)}</code></pre>`);
  }
}

/**
 * Helper for every rendered page: reports its height, routes external link clicks to the parent
 * (popups may be blocked in the embedding sandbox) and applies {scp:'theme'}. It never touches
 * localStorage: artifacts run in an opaque origin where storage access throws.
 * Size reports stop after 3 identical growth steps in a row: body{min-height:100vh} plus a margin
 * reports viewport+16 forever as each embedder grows the frame (the SPA preview, the /s page and
 * the MCP viewer all follow these reports), so the guard lives here once for all of them.
 */
const HELPER = `<script data-scp-helper>(function(){
var embedded=window.parent!==window,last=0,step=0,repeats=0;
function post(m){if(embedded)try{window.parent.postMessage(m,'*')}catch(e){}}
function size(){var h=Math.ceil(document.documentElement.scrollHeight),d=h-last;
if(d>0&&d===step){if(++repeats>=3)return}else repeats=0;
step=d>0?d:0;last=h;post({scp:'size',height:h})}
addEventListener('load',size);
try{new ResizeObserver(size).observe(document.documentElement)}catch(e){}
if(embedded)document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href^="http"]'):null;if(!a||e.defaultPrevented)return;e.preventDefault();post({scp:'open',url:a.href})},true);
addEventListener('message',function(e){var d=e.data;if(e.source===window.parent&&d&&d.scp==='theme'&&(d.theme==='light'||d.theme==='dark'))document.documentElement.dataset.theme=d.theme});
})();</script>`;

/** Insert the helper once, before the last </body>, or append it. */
export function injectHelper(html: string): string {
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i === -1 ? html + HELPER : html.slice(0, i) + HELPER + html.slice(i);
}

/** A complete HTML document for one artifact source. Deterministic; never throws on bad source. */
export function renderArtifact(format: Format, source: string, opts: RenderOpts): string {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE) return injectHelper(errorPage(opts.title, 'Too large', 'artifact source is over 5 MB'));
  let html: string;
  try {
    html = renderFormat(format, source, opts);
  } catch (e) {
    // e.g. marked's recursion on '>' x 10000 overflows the stack; a public share must not 500.
    html = errorPage(opts.title, 'Render error', (e as Error).message);
  }
  return injectHelper(html);
}
