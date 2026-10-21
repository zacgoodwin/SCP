import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import * as api from '../api.ts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { ImportDialog } from '../components/ImportDialog.tsx';
import { ItemCard } from '../components/ItemCard.tsx';

export const PLANE_LABEL: Record<api.Plane, string> = { skill: 'Skills', md: 'Prompts & MDs', artifact: 'Artifacts' };
export const PLANE_PATH: Record<api.Plane, string> = { skill: '/skills', md: '/mds', artifact: '/artifacts' };
const PAGE = 50;

export function ItemsListPage({ plane }: { plane: api.Plane }) {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const kind = (params.get('kind') ?? '') as api.Kind | '';
  const mine = params.get('mine') === '1';
  const [text, setText] = useState(q);
  const [items, setItems] = useState<api.ItemSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // setParams closes over the params of its render, so the debounced search must call the latest
  // one or it would revert a chip/toggle clicked during the debounce window.
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const setParam = (k: string, v: string) =>
    setParamsRef.current(
      (p) => {
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: true },
    );

  // ?q= changed by navigation (sidebar link, Back): show it. Text that already searches for q is kept
  // as typed, so a trailing space survives the debounce round trip.
  useEffect(() => setText((t) => (t.trim() === q ? t : q)), [q]);

  // Debounce the search box into ?q=.
  useEffect(() => {
    const t = setTimeout(() => text.trim() !== q && setParam('q', text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const query = (offset: number): api.ItemQuery => ({ plane, q: q || undefined, kind: kind || undefined, owner: mine ? 'me' : undefined, limit: PAGE, offset });

  useEffect(() => {
    let live = true;
    setError(null);
    api.listItems(query(0)).then(
      (r) => {
        if (!live) return;
        setItems(r.items);
        setTotal(r.total);
      },
      (e) => live && (setError(e), setItems([])),
    );
    return () => {
      live = false;
    };
  }, [plane, q, kind, mine]);

  const loadMore = async () => {
    if (!items) return;
    setLoadingMore(true);
    try {
      const r = await api.listItems(query(items.length));
      setItems([...items, ...r.items]);
      setTotal(r.total);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = Boolean(q || kind || mine);

  return (
    <div className="page">
      <header className="page-head">
        <h1>{PLANE_LABEL[plane]}</h1>
        <div className="row">
          <button type="button" className="btn" onClick={() => setImportOpen(true)}>
            Import
          </button>
          <Link className="btn btn-primary" to={`/items/new?plane=${plane}${kind ? `&kind=${kind}` : ''}`}>
            New
          </Link>
        </div>
      </header>

      <div className="toolbar">
        <label className="field grow">
          <span className="sr-only">Search {PLANE_LABEL[plane]}</span>
          <input type="search" placeholder={`Search ${PLANE_LABEL[plane].toLowerCase()}…`} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={mine} onChange={(e) => setParam('mine', e.target.checked ? '1' : '')} />
          Mine only
        </label>
      </div>
      {plane === 'md' && (
        <div className="chips" role="group" aria-label="Filter by kind">
          <button type="button" className="chip" aria-pressed={!kind} onClick={() => setParam('kind', '')}>
            all
          </button>
          {api.KINDS_BY_PLANE.md.map((k) => (
            <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setParam('kind', kind === k ? '' : k)}>
              {k}
            </button>
          ))}
        </div>
      )}

      <ErrorBox error={error} />
      {items === null ? (
        <p className="muted" role="status">Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty">
          {filtered ? (
            <p>Nothing matches these filters.</p>
          ) : (
            <>
              <p>No {PLANE_LABEL[plane].toLowerCase()} yet.</p>
              <p>
                <Link className="btn btn-primary" to={`/items/new?plane=${plane}`}>
                  Create one
                </Link>{' '}
                or{' '}
                <button type="button" className="btn" onClick={() => setImportOpen(true)}>
                  import a file
                </button>
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <p className="muted">
            {items.length} of {total}
          </p>
          <ul className="item-grid">
            {items.map((it) => (
              <ItemCard key={it.id} item={it} />
            ))}
          </ul>
          {items.length < total && (
            <button type="button" className="btn btn-block" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} plane={plane} />
    </div>
  );
}
