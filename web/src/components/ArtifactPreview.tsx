import { useEffect, useRef, useState } from 'react';
import * as api from '../api.ts';
import { ErrorBox } from './ErrorBox.tsx';

type Theme = 'light' | 'dark';
const MIN_H = 200;
const MAX_H = 4000;
/** Re-sign this long before the URL expires; the server signs for 10 minutes. */
const REFRESH_EARLY_MS = 60_000;

const systemTheme = (): Theme => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/**
 * Rendered artifact in a sandboxed iframe on the artifact origin (never on the app origin). The
 * signed preview URL is re-fetched before it expires; the iframe only reloads on version change or
 * an explicit reload, so artifact state survives a refresh of the signature.
 */
export function ArtifactPreview({ item, version }: { item: api.ItemDetail; version: api.VersionDetail }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [fresh, setFresh] = useState<{ url: string; expiresAt: string } | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [height, setHeight] = useState(480);
  const [theme, setTheme] = useState<Theme>(systemTheme);
  const [full, setFull] = useState(false);
  const [nonce, setNonce] = useState(0); // bump to re-sign and reload now
  const [loadKey, setLoadKey] = useState(0); // bump to reload the frame from the current URL

  // Fetch (and keep re-fetching) a signed URL for this version. The timer re-signs in place; a new
  // version or nonce starts over with a fresh frame.
  useEffect(() => {
    let live = true;
    setSrc(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sign = () =>
      api.getPreviewUrl(item.id, version.seq).then(
        (r) => {
          if (!live) return;
          setError(null);
          setFresh(r);
          setSrc((cur) => cur ?? r.url);
          const ms = new Date(r.expiresAt).getTime() - Date.now() - REFRESH_EARLY_MS;
          timer = setTimeout(sign, Number.isFinite(ms) ? Math.max(ms, 15_000) : 5 * 60_000);
        },
        (e) => {
          if (!live) return;
          setError(e);
          timer = setTimeout(sign, 30_000); // keep trying; the error stays visible meanwhile
        },
      );
    void sign();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [item.id, version.seq, nonce]);

  // Size and link requests from the artifact's injected helper; only trust our own frame.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { scp?: string; h?: number; height?: number; url?: string } | null;
      if (d?.scp === 'size') {
        const h = Number(d.h ?? d.height);
        if (Number.isFinite(h)) setHeight(Math.min(MAX_H, Math.max(MIN_H, Math.ceil(h))));
      } else if (d?.scp === 'open' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) {
        window.open(d.url, '_blank', 'noopener');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  // Opaque-origin frame: '*' is the only target origin that reaches it.
  const postTheme = (t: Theme) => frame.current?.contentWindow?.postMessage({ scp: 'theme', theme: t }, '*');
  const flipTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    setTheme(t);
    postTheme(t);
  };
  const reload = () => {
    // A stale signature would fail inside the frame, so re-sign first when it is about to expire.
    if (fresh && new Date(fresh.expiresAt).getTime() - Date.now() > 5_000) {
      setSrc(fresh.url);
      setLoadKey((k) => k + 1);
    } else setNonce((n) => n + 1);
  };

  return (
    <div className={full ? 'preview preview-full' : 'preview'}>
      <div className="row wrap preview-bar">
        <span className="muted grow">
          {item.title || item.name} · v{version.seq} · {item.format}
        </span>
        <button type="button" className="btn btn-small" onClick={flipTheme} aria-label={`Switch preview to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
          {theme === 'dark' ? 'Light' : 'Dark'} theme
        </button>
        <button type="button" className="btn btn-small" onClick={reload} disabled={!fresh && !error}>
          Reload
        </button>
        {fresh && (
          <a className="btn btn-small" href={fresh.url} target="_blank" rel="noopener noreferrer">
            Open in new tab
          </a>
        )}
        <button type="button" className="btn btn-small" aria-pressed={full} onClick={() => setFull((f) => !f)}>
          {full ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      </div>
      <ErrorBox error={error} />
      {src ? (
        <iframe
          ref={frame}
          key={loadKey}
          src={src}
          title={`Preview of ${item.title || item.name}`}
          className="preview-frame"
          style={full ? undefined : { height }}
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
          referrerPolicy="no-referrer"
          onLoad={() => postTheme(theme)}
        />
      ) : (
        !error && (
          <p className="muted" role="status">
            Loading preview…
          </p>
        )
      )}
    </div>
  );
}
