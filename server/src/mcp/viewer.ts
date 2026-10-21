/** MCP Apps viewer shell URI. Bump the version whenever VIEWER_HTML changes: hosts cache by URI. */
export const VIEWER_URI = 'ui://scp/viewer/v1';

/**
 * The MCP App view (research artifacts-mcp-apps.md 6.4). A hand-rolled JSON-RPC bridge to the host
 * over postMessage, no SDK and no external loads. It loads the artifact named by the tool result
 * (resources/read when the host proxies server resources, else the app-only scp_artifact_content
 * tool) into a nested srcdoc iframe sandboxed WITHOUT allow-same-origin, so the artifact runs in an
 * opaque origin and cannot reach this bridge. The rendered artifact already carries the size/open/
 * theme helper (artifacts/render.ts), which posts {scp:'size'|'open'} to this page.
 *
 * String.raw: the script holds regex escapes that a plain template literal would eat.
 */
export const VIEWER_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SCP artifact viewer</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#59636e;--err:#cf222e;--line:#d1d9e0}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--err:#ff7b72;--line:#3d444d}}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark;--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--err:#ff7b72;--line:#3d444d}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#status{padding:16px;color:var(--muted)}
#status.err{color:var(--err);white-space:pre-wrap;border-left:3px solid var(--err);margin:12px;padding:8px 12px}
iframe{display:block;width:100%;height:150px;border:0;background:#fff}
[hidden]{display:none!important}
</style></head>
<body>
<div id="status" role="status" aria-live="polite">Waiting for the artifact&hellip;</div>
<iframe id="frame" title="Artifact" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" hidden></iframe>
<script>
(function () {
  'use strict';
  var frame = document.getElementById('frame');
  var statusEl = document.getElementById('status');
  var seq = 0;
  var pending = new Map();
  var hostCaps = {};
  var theme = null;
  var loadedKey = null;
  var lastHeight = 0;
  var MAX_HEIGHT = 10000;
  var maxHeight = MAX_HEIGHT;
  // Runaway guard: content sized by the viewport (min-height:100vh plus a margin) reports a little
  // more every time the frame grows. The same growth step three times in a row is that loop.
  var growStep = 0;
  var growRepeats = 0;
  var GROW_REPEATS_MAX = 3;

  function send(m) { m.jsonrpc = '2.0'; window.parent.postMessage(m, '*'); }
  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      send({ id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) { send({ method: method, params: params || {} }); }
  function errText(e) { return (e && (e.message || e.code)) ? String(e.message || e.code) : String(e); }
  function resultText(r) {
    var c = r && r.content;
    if (!Array.isArray(c)) return '';
    return c.map(function (x) { return x && x.type === 'text' ? x.text : ''; }).join('\n');
  }

  function reportSize(h) {
    h = Math.min(Math.max(Math.ceil(h), 1), MAX_HEIGHT);
    if (Math.abs(h - lastHeight) < 2) return;
    lastHeight = h;
    notify('ui/notifications/size-changed', { height: h });
  }
  function pageHeight() { return Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 60); }

  function showStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'err' : '';
    statusEl.hidden = false;
    if (isError) { frame.hidden = true; frame.removeAttribute('srcdoc'); }
    if (frame.hidden) reportSize(pageHeight());
  }
  function fail(text) { loadedKey = null; showStatus(text, true); }

  function applyTheme(t) {
    if (t !== 'light' && t !== 'dark') return;
    theme = t;
    document.documentElement.dataset.theme = t;
    postTheme();
  }
  function postTheme() {
    if (theme && frame.contentWindow) frame.contentWindow.postMessage({ scp: 'theme', theme: theme }, '*');
  }
  function onContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    applyTheme(ctx.theme);
    var dims = ctx.containerDimensions;
    if (dims && typeof dims.maxHeight === 'number' && isFinite(dims.maxHeight) && dims.maxHeight > 0) {
      maxHeight = Math.min(Math.ceil(dims.maxHeight), MAX_HEIGHT);
    }
  }

  function decodeBlob(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function viaResource(uri) {
    return rpc('resources/read', { uri: uri }).then(function (r) {
      var c = r && Array.isArray(r.contents) ? r.contents[0] : null;
      if (!c) throw new Error('the resource came back empty');
      if (typeof c.text === 'string') return c.text;
      if (typeof c.blob === 'string') return decodeBlob(c.blob);
      throw new Error('the resource has no text');
    });
  }

  function viaTool(id, version) {
    var parts = [];
    var offset = 0;
    function step() {
      return rpc('tools/call', { name: 'scp_artifact_content', arguments: { id: id, version: version, offset: offset } }).then(function (r) {
        if (!r || r.isError) throw new Error(resultText(r) || 'scp_artifact_content failed');
        var s = r.structuredContent || {};
        if (typeof s.html !== 'string') throw new Error('scp_artifact_content returned no html');
        parts.push(s.html);
        offset += s.html.length;
        if (s.done || !s.html.length || parts.length > 500) return parts.join('');
        return step();
      });
    }
    return step();
  }

  function show(html) {
    frame.hidden = false;
    statusEl.hidden = true;
    frame.style.height = '150px';
    lastHeight = 0;
    growStep = 0;
    growRepeats = 0;
    frame.srcdoc = html;
    reportSize(150);
  }

  function load(sc) {
    var key = sc.id + '@' + sc.version;
    if (key === loadedKey) return;
    loadedKey = key;
    showStatus('Loading ' + (sc.title || sc.id) + '…', false);
    var p = hostCaps.serverResources && typeof sc.uri === 'string'
      ? viaResource(sc.uri).catch(function () { return viaTool(sc.id, sc.version); })
      : viaTool(sc.id, sc.version);
    p.then(function (html) { if (loadedKey === key) show(html); },
      function (e) { if (loadedKey === key) fail('Could not load the artifact: ' + errText(e)); });
  }

  function onToolResult(r) {
    if (!r || typeof r !== 'object') return fail('The host sent an empty tool result.');
    if (r.isError) return fail(resultText(r) || 'The tool call failed.');
    var sc = r.structuredContent;
    if (!sc || typeof sc.id !== 'string' || typeof sc.version !== 'number') return fail('The tool result does not name an artifact.');
    load(sc);
  }

  function onArtifactMessage(d) {
    if (!d || typeof d !== 'object') return;
    if (d.scp === 'size' && typeof d.height === 'number' && isFinite(d.height)) {
      var h = Math.min(Math.max(Math.ceil(d.height), 40), maxHeight);
      var step = h - (parseInt(frame.style.height, 10) || 0);
      if (step > 0 && step === growStep) {
        if (++growRepeats >= GROW_REPEATS_MAX) return; // stop following the loop; the frame scrolls
      } else growRepeats = 0;
      growStep = step > 0 ? step : 0;
      frame.style.height = h + 'px';
      reportSize(h);
    } else if (d.scp === 'open' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) {
      rpc('ui/open-link', { url: d.url }).catch(function () {});
    }
  }

  window.addEventListener('message', function (e) {
    if (e.source === frame.contentWindow) return onArtifactMessage(e.data);
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;
    if (m.method === undefined) {
      var p = m.id != null ? pending.get(m.id) : null;
      if (p) { pending.delete(m.id); if (m.error) p.reject(m.error); else p.resolve(m.result); }
      return;
    }
    switch (m.method) {
      case 'ui/resource-teardown':
      case 'ping':
        if (m.id != null) send({ id: m.id, result: {} });
        return;
      case 'ui/notifications/tool-input':
        var a = (m.params && m.params.arguments) || {};
        if (!loadedKey) showStatus('Loading ' + (a.id || a.name || 'artifact') + '…', false);
        return;
      case 'ui/notifications/tool-result':
        return onToolResult(m.params);
      case 'ui/notifications/tool-cancelled':
        if (!loadedKey) fail('The tool call was cancelled.');
        return;
      case 'ui/notifications/host-context-changed':
        return onContext(m.params);
      default:
        if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } });
    }
  });

  frame.addEventListener('load', postTheme);

  rpc('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'scp-viewer', version: '1' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }
  }).then(function (r) {
    hostCaps = (r && r.hostCapabilities) || {};
    onContext(r && r.hostContext);
    notify('ui/notifications/initialized', {});
    reportSize(pageHeight());
  }, function (e) {
    fail('The host rejected ui/initialize: ' + errText(e));
  });
})();
</script>
</body></html>
`;
