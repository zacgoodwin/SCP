import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERMAID_URL, injectHelper, renderArtifact } from '../src/artifacts/render.ts';
import { artifactCsp, sanitizeCspDomains } from '../src/artifacts/csp.ts';

const opts = { title: 'T <x>', cdns: ['https://cdn.jsdelivr.net'] };
const helpers = (html: string) => html.split('data-scp-helper').length - 1;

test('html: full documents pass through, fragments get a skeleton; helper once before </body>', () => {
  const full = '<!DOCTYPE html><html><body><p>hi</p></body></html>';
  const out = renderArtifact('html', full, opts);
  assert.ok(out.startsWith('<!DOCTYPE html><html><body><p>hi</p>'));
  assert.equal(helpers(out), 1);
  assert.ok(out.indexOf('data-scp-helper') < out.indexOf('</body>'));
  const frag = renderArtifact('html', '<h1>hello</h1>', opts);
  assert.match(frag, /^<!doctype html>/);
  assert.match(frag, /<meta charset="utf-8">/);
  assert.match(frag, /<meta name="viewport"/);
  assert.match(frag, /<title>T &lt;x&gt;<\/title>/);
  assert.match(frag, /<body><h1>hello<\/h1>/);
  assert.equal(helpers(frag), 1);
  // no </body>: appended
  assert.ok(injectHelper('<p>x</p>').startsWith('<p>x</p><script data-scp-helper>'));
  assert.equal(renderArtifact('html', full, opts), out, 'deterministic');
});

test('helper: size, open and theme messages; never touches storage', () => {
  const out = renderArtifact('code', 'x', opts);
  assert.match(out, /scp:'size'/);
  assert.match(out, /ResizeObserver/);
  assert.match(out, /scp:'open'/);
  assert.match(out, /a\[href\^="http"\]/);
  assert.match(out, /d\.scp==='theme'/);
  assert.match(out, /dataset\.theme/);
  assert.doesNotMatch(out, /localStorage/);
});

test('markdown: headings, tables, code, raw HTML kept, frontmatter stripped, light/dark', () => {
  const md = '---\ntitle: Doc\n---\n# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1 < 2;\n```\n\n<div class="raw">r</div>\n';
  const out = renderArtifact('markdown', md, opts);
  assert.match(out, /<h1>Heading<\/h1>/);
  assert.match(out, /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/);
  assert.match(out, /<code class="language-js">const x = 1 &lt; 2;/);
  assert.match(out, /<div class="raw">r<\/div>/);
  assert.doesNotMatch(out, /title: Doc/);
  assert.match(out, /max-width:760px/);
  assert.match(out, /prefers-color-scheme:dark/);
  assert.equal(helpers(out), 1);
});

test('svg: wrapped in a centered body', () => {
  const out = renderArtifact('svg', '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>', opts);
  assert.match(out, /^<!doctype html>/);
  assert.match(out, /<body style="margin:0;display:grid;place-items:center[^"]*"><svg xmlns/);
  assert.equal(helpers(out), 1);
});

test('mermaid: pinned ESM url and escaped source', () => {
  assert.match(MERMAID_URL, /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\.\d+\.\d+\/dist\/mermaid\.esm\.min\.mjs$/);
  const out = renderArtifact('mermaid', 'graph TD\n  A["</pre><script>x</script>"] --> B', opts);
  assert.ok(out.includes(`import mermaid from '${MERMAID_URL}'`));
  assert.match(out, /<pre class="mermaid">graph TD\n {2}A\[&quot;&lt;\/pre&gt;&lt;script&gt;x&lt;\/script&gt;&quot;\] --&gt; B<\/pre>/);
  assert.doesNotMatch(out, /<script>x/);
  // without jsdelivr allowed, an explanatory page instead of a broken one
  assert.match(renderArtifact('mermaid', 'graph TD', { ...opts, cdns: [] }), /not in SCP_ARTIFACT_CDNS/);
});

test('react: compiled server-side, importmap pinned, default export mounted', () => {
  const src = `import { useState } from 'react';
type P = { start?: number };
export default function Counter({ start = 0 }: P) {
  const [n, setN] = useState<number>(start);
  return <button onClick={() => setN(n + 1)}>clicked {n} {'</script>'}</button>;
}`;
  const out = renderArtifact('react', src, opts);
  assert.doesNotMatch(out, /<button/, 'no raw JSX');
  assert.doesNotMatch(out, /useState<number>/, 'types stripped');
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(out)![1]);
  for (const k of ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']) {
    assert.match(map.imports[k], /^https:\/\/cdn\.jsdelivr\.net\/npm\/react(-dom)?@19\.\d+\.\d+\/.*\+esm$/, k);
  }
  assert.match(out, /from "react\/jsx-runtime"|from 'react\/jsx-runtime'/);
  assert.match(out, /<div id="root"><\/div>/);
  assert.match(out, /__scpCreateRoot\(document\.getElementById\('root'\)\)\.render\(__scpJsx\(Counter, \{\}\)\)/);
  assert.match(out, /function Counter\(/);
  assert.doesNotMatch(out, /export default/);
  // the '</script>' string literal cannot close the module script early
  assert.ok(out.includes('<\\/script>'));
  assert.equal(out.split('</script>').length - 1, 4, 'importmap, error hook, module, helper');
  assert.equal(helpers(out), 1);

  const anon = renderArtifact('react', 'export default () => <p>x</p>;', opts);
  assert.match(anon, /const __scpDefault =/);
  assert.match(anon, /__scpJsx\(__scpDefault, \{\}\)/);
});

test('react: export-list default alias mounts, other named exports kept', () => {
  const multi = renderArtifact('react', 'const A = 1;\nfunction App() { return <p>{A}</p>; }\nexport { A, App as default };', opts);
  assert.match(multi, /__scpJsx\(App, \{\}\)/);
  assert.match(multi, /export \{ A \};/);
  assert.doesNotMatch(multi, /as default/);
  const single = renderArtifact('react', 'function App() { return <p>x</p>; }\nexport { App as default };', opts);
  assert.match(single, /__scpJsx\(App, \{\}\)/);
  assert.doesNotMatch(single, /export \{/);
});

test('react: compile error renders an escaped error page, never throws', () => {
  const out = renderArtifact('react', 'export default () => <div><img src=x onerror=alert(1)>', opts);
  assert.match(out, /Compile error/);
  assert.doesNotMatch(out, /<img src=x/);
  assert.doesNotMatch(out, /type="module"/);
  assert.equal(helpers(out), 1);
});

test('code: escaped in pre/code, monospace', () => {
  const out = renderArtifact('code', '<script>alert(1)</script>', opts);
  assert.match(out, /<pre><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
  assert.equal(out.split('<script').length - 1, 1, 'only the helper script');
  assert.match(out, /ui-monospace/);
});

test('sources over 5 MB are refused', () => {
  const out = renderArtifact('html', 'x'.repeat(5 * 1024 * 1024 + 1), opts);
  assert.match(out, /over 5 MB/);
  assert.ok(out.length < 10_000);
});

test('sanitizeCspDomains drops anything that could inject a directive or keyword', () => {
  const bad = ['https://a.com; script-src *', "'unsafe-eval'", 'https://a .com', 'https://a.com\nscript-src *', 'https://a.com,https://b.com', 'javascript:x', 'https://a.com/path', '"https://a.com"', '*'];
  assert.deepEqual(sanitizeCspDomains(bad), []);
  const good = ['https://cdn.jsdelivr.net', 'http://localhost:8081', 'https://*.example.com', 'HTTPS://UNPKG.COM'];
  assert.deepEqual(sanitizeCspDomains([...good, ...bad]), good);
});

test('artifactCsp: sandbox without allow-same-origin, cdns and frame-ancestors applied', () => {
  const csp = artifactCsp(['https://cdn.jsdelivr.net', "https://evil.com; script-src 'unsafe-eval'"], 'http://app.test');
  assert.ok(csp.startsWith('sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals;'));
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.doesNotMatch(csp, /evil|unsafe-eval/);
  assert.match(csp, /script-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net;/);
  assert.match(csp, /connect-src https:\/\/cdn\.jsdelivr\.net;/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /frame-ancestors http:\/\/app\.test$/);
  assert.match(artifactCsp([], '*'), /connect-src 'none'/);
});
