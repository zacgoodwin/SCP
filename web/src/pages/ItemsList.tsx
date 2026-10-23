import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import * as api from '../api.ts';
import { useAuth } from '../auth.tsx';
import { idRange, keepLoaded } from '../bulk.ts';
import { BulkBar } from '../components/BulkBar.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { ImportDialog } from '../components/ImportDialog.tsx';
import { ItemCard } from '../components/ItemCard.tsx';

export const PLANE_LABEL: Record<api.Plane, string> = { skill: 'Skills', md: 'Prompts & MDs', artifact: 'Artifacts' };
export const PLANE_PATH: Record<api.Plane, string> = { skill: '/skills', md: '/mds', artifact: '/artifacts' };
const PLANE_BLURB: Record<api.Plane, string> = {
  skill: 'Reusable skill folders agents load on demand. Add them to a group to serve them over MCP or install them as a bundle.',
  md: 'Prompts, agents, commands, instructions and other markdown that installs into a project.',
  artifact: 'Self-contained HTML, markdown and other documents, previewable here and shareable by link.',
};
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
  // Bumped when an import or a bulk action finished, so the first page reloads (and the selection shrinks to it).
  const [reloads, setReloads] = useState(0);
  const { me } = useAuth();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // Mirrors canEditItem (server/src/access.ts): the owner or an admin, holding the write scope.
  const canEdit = (it: api.ItemSummary) => !!me && me.principal.scopes.includes('write') && (me.user.isAdmin || it.owner.id === me.user.id);

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
        setSelected((s) => keepLoaded(s, r.items.map((it) => it.id)));
      },
      (e) => live && (setError(e), setItems([])),
    );
    return () => {
      live = false;
    };
  }, [plane, q, kind, mine, reloads]);

  // A new filter is a new list: drop the selection.
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [plane, q, kind, mine]);

  // Escape clears the selection, unless a dialog (the import dialog) has it.
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof Element && e.target.closest('dialog'))) setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size]);

  const editable = (items ?? []).filter(canEdit);
  const selectedItems = editable.filter((it) => selected.has(it.id));
  const allSelected = editable.length > 0 && selectedItems.length === editable.length;

  // Shift extends from the last ticked item over the editable items between, to the clicked box's new state.
  const toggle = (id: string, shift: boolean) => {
    const on = !selected.has(id);
    const ids = shift ? idRange(editable.map((it) => it.id), anchor, id) : [id];
    const next = new Set(selected);
    for (const x of ids) {
      if (on) next.add(x);
      else next.delete(x);
    }
    setSelected(next);
    setAnchor(id);
  };

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
        <div className="page-title">
          <h1>{PLANE_LABEL[plane]}</h1>
          <p className="muted">{PLANE_BLURB[plane]}</p>
        </div>
        <div className="page-actions">
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
      {/* Outside the list branches, so the result summary survives deleting every item. */}
      <BulkBar
        items={selectedItems}
        onClear={() => setSelected(new Set())}
        onDone={(failedIds) => {
          setSelected(new Set(failedIds));
          setReloads((n) => n + 1);
        }}
      />
      {items === null ? (
        <p className="muted" role="status">Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty">
          {filtered ? (
            <>
              <p>Nothing matches these filters.</p>
              <p className="muted">Clear the search, the kind chip or "Mine only" to see everything.</p>
            </>
          ) : (
            <>
              <p>No {PLANE_LABEL[plane].toLowerCase()} yet.</p>
              <p>
                <Link className="btn btn-primary" to={`/items/new?plane=${plane}`}>
                  Create one
                </Link>{' '}
                or{' '}
                <button type="button" className="btn" onClick={() => setImportOpen(true)}>
                  Import
                </button>
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="row wrap">
            <p className="muted">
              {items.length} of {total}
            </p>
            {editable.length > 0 && (
              <label className="toggle">
                <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(editable.map((it) => it.id)))} />
                Select all on this page
              </label>
            )}
          </div>
          <ul className="item-grid">
            {items.map((it) => (
              <ItemCard key={it.id} item={it} select={{ checked: selected.has(it.id), disabled: !canEdit(it), onToggle: (shift) => toggle(it.id, shift) }} />
            ))}
          </ul>
          {items.length < total && (
            <button type="button" className="btn btn-block" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={() => setReloads((n) => n + 1)} plane={plane} />
    </div>
  );
}
