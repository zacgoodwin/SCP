import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import * as api from '../api.ts';
import { useAuth } from '../auth.tsx';
import { bulkSummary, deletePrompt, runBulk } from '../bulk.ts';
import { groupLabel } from '../format.ts';
import { VisibilitySelect } from './ImportDialog.tsx';

type Mode = 'group' | 'visibility' | 'delete';

/**
 * Selection bar for the item lists (y79w): add the selected items to a group, change their
 * visibility, or delete them, one existing request per item (bulk.ts). Confirmation is inline,
 * never confirm(). onDone gets the ids that failed; the list keeps those it reloads (page 1) selected
 * for a retry and drops the rest, which the summary still names.
 */
export function BulkBar({ items, onDone, onClear }: { items: api.ItemSummary[]; onDone: (failedIds: string[]) => void; onClear: () => void }) {
  const { me } = useAuth();
  const [mode, setMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const [groups, setGroups] = useState<api.GroupSummary[] | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [slug, setSlug] = useState('');
  const [visibility, setVisibility] = useState<api.Visibility>('public');
  const groupButton = useRef<HTMLButtonElement>(null);
  const n = items.length;
  // This bar stays mounted, so an emptied selection (Clear, Esc, a finished action, a reload) must close the
  // panel here: left open, the next tick remounted it and its autoFocus took the checkbox's focus, so Space,
  // Space deleted an item. A panel opens only from open(), the user's click on its button.
  if (n === 0 && mode !== null) setMode(null);

  // Editable groups: an admin edits every group, anyone else their own.
  useEffect(() => {
    if (mode !== 'group' || groups) return;
    setGroupError(null);
    api.listGroups(me?.user.isAdmin ? { limit: 200 } : { owner: 'me', limit: 200 }).then(
      (r) => {
        setGroups(r.groups);
        setSlug((s) => s || r.groups[0]?.slug || '');
      },
      (e) => setGroupError(api.errorMessage(e)),
    );
  }, [mode, groups, me?.user.isAdmin]);

  const run = async (verb: string, fn: (it: api.ItemSummary) => Promise<unknown>) => {
    setBusy(true);
    setResult(null);
    const failed = await runBulk(items, fn);
    setBusy(false);
    setMode(null);
    setResult({ text: bulkSummary(items.length, verb, failed.map((f) => ({ name: f.item.name, reason: f.reason }))), ok: failed.length === 0 });
    onDone(failed.map((f) => f.item.id));
  };

  const open = (m: Mode) => {
    setResult(null);
    setMode(mode === m ? null : m);
  };
  const noun = n === 1 ? 'item' : 'items';
  const groupName = groups?.find((g) => g.slug === slug)?.name ?? slug;

  return (
    <>
      {result && (
        <p className={result.ok ? 'bulk-result' : 'notice'} role="status">
          {result.text}
        </p>
      )}
      {n > 0 && (
        <section className="bulk-bar card" aria-label="Bulk actions">
          <div className="row wrap">
            <strong>
              {n} {noun} selected
            </strong>
            <button type="button" ref={groupButton} className="btn btn-small" aria-expanded={mode === 'group'} disabled={busy} onClick={() => open('group')}>
              Add to group…
            </button>
            <button type="button" className="btn btn-small" aria-expanded={mode === 'visibility'} disabled={busy} onClick={() => open('visibility')}>
              Visibility…
            </button>
            <button type="button" className="btn btn-small btn-danger" aria-expanded={mode === 'delete'} disabled={busy} onClick={() => open('delete')}>
              Delete…
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={onClear}>
              Clear (Esc)
            </button>
            {busy && <span className="muted" role="status">Working…</span>}
          </div>

          {mode === 'group' &&
            (groupError ? (
              <p className="notice">{groupError}</p>
            ) : groups === null ? (
              <p className="muted" role="status">Loading groups…</p>
            ) : groups.length === 0 ? (
              <p className="muted">
                You have no groups to add to. <Link to="/groups">Create a group</Link> first.
              </p>
            ) : (
              <form className="row wrap" onSubmit={(e) => (e.preventDefault(), void run(`added to ${groupName}`, (it) => api.addMember(slug, { itemId: it.id })))}>
                <label className="field">
                  <span>Group</span>
                  {/* The groups load after the click: focus only if it has not moved on from the button since. */}
                  <select value={slug} autoFocus={document.activeElement === groupButton.current} onChange={(e) => setSlug(e.target.value)}>
                    {groups.map((g) => (
                      <option key={g.slug} value={g.slug}>
                        {groupLabel(g)}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="btn btn-primary btn-small" disabled={busy || !slug}>
                  Add {n} {noun}
                </button>
              </form>
            ))}

          {mode === 'visibility' && (
            <form className="row wrap" onSubmit={(e) => (e.preventDefault(), void run('updated', (it) => api.updateItem(it.id, { visibility })))}>
              <VisibilitySelect value={visibility} onChange={setVisibility} autoFocus />
              <button type="submit" className="btn btn-primary btn-small" disabled={busy}>
                Make {n} {noun} {visibility}
              </button>
            </form>
          )}

          {mode === 'delete' && (
            <div className="stack" role="group" aria-label="Confirm delete">
              <p>
                <strong>{deletePrompt(n)}</strong>{' '}
                This cannot be undone.
              </p>
              <ul className="bulk-names">
                {items.map((it) => (
                  <li key={it.id}>
                    <code>{it.name}</code>
                  </li>
                ))}
              </ul>
              <div className="row wrap">
                <button type="button" className="btn btn-small btn-danger" autoFocus disabled={busy} onClick={() => void run('deleted', (it) => api.deleteItem(it.id))}>
                  Delete {n} {noun}
                </button>
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => setMode(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}
