import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { type AuditEvent } from '../api.ts';
import * as admin from '../api-admin.ts';
import { useUser } from '../auth.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { dateTime, timeAgo } from '../format.ts';

const LIMIT = 100;

type Filter = Pick<admin.AuditFilter, 'user' | 'action' | 'q'>;

function Target({ e }: { e: AuditEvent }) {
  if (!e.targetType) return <span className="muted">-</span>;
  const name = typeof e.detail.name === 'string' ? e.detail.name : typeof e.detail.slug === 'string' ? e.detail.slug : null;
  const label = name ?? e.targetId?.slice(-8) ?? '';
  return (
    <span>
      <span className="muted">{e.targetType}</span>{' '}
      {e.targetType === 'item' && e.targetId ? <Link to={`/items/${e.targetId}`}>{label}</Link> : <code>{label}</code>}
    </span>
  );
}

/**
 * The event's detail (passwordReset, grantsRevoked, the full client id, settings keys...) in the DOM:
 * a hover tooltip alone is unreachable by keyboard, touch and screen readers, while the Text filter
 * matches against these very values.
 */
export function Detail({ detail }: { detail: Record<string, unknown> }) {
  const entries = Object.entries(detail).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return null;
  return (
    <details className="audit-detail">
      <summary className="muted">detail</summary>
      <dl className="kv">
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>
              <code>{typeof v === 'string' ? v : JSON.stringify(v)}</code>
            </dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

/** What acted for the user: an API key, a connected OAuth app (its client id, as the Keys page shows it), or the browser. */
export function Actor({ e }: { e: AuditEvent }) {
  if (e.keyId) return <code>…{e.keyId.slice(-6)}</code>;
  const app = e.detail.oauthClientId;
  if (typeof app === 'string') {
    return (
      <span>
        app <code>…{app.slice(-6)}</code>
      </span>
    );
  }
  return <span className="muted">web</span>;
}

/** D4: every user's audit log with filters and cursor paging (GET /audit?all=1&before=). */
export function AdminLogsPage() {
  const me = useUser();
  if (!me.isAdmin) {
    return (
      <div className="page">
        <h1>Logs</h1>
        <div className="empty">
          <p>Only admins can read the full log. Your own activity is under Activity.</p>
          <Link className="btn" to="/activity">
            Go to Activity
          </Link>
        </div>
      </div>
    );
  }
  return <Logs />;
}

function Logs() {
  const [draft, setDraft] = useState<Filter>({});
  const [filter, setFilter] = useState<Filter>({});
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = async (before?: number) => {
    setBusy(true);
    setError(null);
    try {
      const r = await admin.listAllAudit({ ...filter, limit: LIMIT, before });
      setEvents((prev) => (before && prev ? [...prev, ...r.events] : r.events));
      setDone(r.events.length < LIMIT);
    } catch (e) {
      setError(e); // the list stays unknown (null), never the "No activity yet" empty state
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setEvents(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setFilter({ user: draft.user?.trim() || undefined, action: draft.action?.trim() || undefined, q: draft.q?.trim() || undefined });
  };
  const clear = () => {
    setDraft({});
    setFilter({});
  };
  const filtered = Object.values(filter).some(Boolean);

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <p className="eyebrow">Admin</p>
          <h1>Logs</h1>
          <p className="muted">Audit events across all users, newest first. Filter by user, action prefix or free text.</p>
        </div>
      </header>
      <form className="card filters" onSubmit={apply}>
        <label className="field">
          <span>User</span>
          <input value={draft.user ?? ''} onChange={(e) => setDraft({ ...draft, user: e.target.value })} placeholder="username" autoComplete="off" />
        </label>
        <label className="field">
          <span>Action prefix</span>
          <input value={draft.action ?? ''} onChange={(e) => setDraft({ ...draft, action: e.target.value })} placeholder="item. / user.update" autoComplete="off" />
        </label>
        <label className="field">
          <span>Text</span>
          <input value={draft.q ?? ''} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="target id or detail" autoComplete="off" />
        </label>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Filter
          </button>
          {filtered && (
            <button type="button" className="btn" onClick={clear} disabled={busy}>
              Clear
            </button>
          )}
        </div>
      </form>
      <ErrorBox error={error} onRetry={() => void load()} />
      {events === null ? (
        error ? null : <p className="muted" role="status">Loading…</p>
      ) : events.length === 0 ? (
        <div className="empty">
          <p>{filtered ? 'No events match these filters.' : 'No activity yet.'}</p>
          {filtered ? (
            <button type="button" className="btn" onClick={clear}>
              Clear filters
            </button>
          ) : (
            <p className="muted">Every login, item, group, key and admin action lands here.</p>
          )}
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Action</th>
                  <th scope="col">Target</th>
                  <th scope="col">User</th>
                  <th scope="col">Key</th>
                  <th scope="col">IP</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <time dateTime={e.ts} title={dateTime(e.ts)}>
                        {timeAgo(e.ts)}
                      </time>
                    </td>
                    <td>
                      <code>{e.action}</code>
                      <Detail detail={e.detail} />
                    </td>
                    <td>
                      <Target e={e} />
                    </td>
                    <td>{e.username ?? <span className="muted">-</span>}</td>
                    <td>
                      <Actor e={e} />
                    </td>
                    <td>{e.ip ?? <span className="muted">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!done && (
            <div className="row">
              <button type="button" className="btn" disabled={busy} onClick={() => void load(events.at(-1)!.id)}>
                {busy ? 'Loading…' : 'Load more'}
              </button>
              <span className="muted">{events.length} shown</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
