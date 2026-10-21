import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import * as api from '../api.ts';
import { useUser } from '../auth.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { dateTime, timeAgo } from '../format.ts';

const LIMIT = 200;

function Target({ e }: { e: api.AuditEvent }) {
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

export function ActivityPage() {
  const user = useUser();
  const [all, setAll] = useState(false);
  const [events, setEvents] = useState<api.AuditEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    setEvents(null);
    api.listAudit({ limit: LIMIT, all }).then(
      (r) => live && setEvents(r.events),
      (e) => live && (setError(e), setEvents([])),
    );
    return () => {
      live = false;
    };
  }, [all]);

  return (
    <div className="page">
      <header className="page-head">
        <div className="stack-tight">
          <h1>Activity</h1>
          <p className="muted">The last {LIMIT} audit events{all ? ' across all users' : ' for your account'}.</p>
        </div>
        {user.isAdmin && (
          <label className="toggle">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            All users
          </label>
        )}
      </header>
      <ErrorBox error={error} />
      {events === null ? (
        <p className="muted" role="status">Loading…</p>
      ) : events.length === 0 ? (
        <div className="empty">
          <p>No activity yet. Create an item or a group and it shows up here.</p>
        </div>
      ) : (
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
                    <code title={Object.keys(e.detail).length ? JSON.stringify(e.detail) : undefined}>{e.action}</code>
                  </td>
                  <td>
                    <Target e={e} />
                  </td>
                  <td>{e.username ?? <span className="muted">-</span>}</td>
                  <td>{e.keyId ? <code>…{e.keyId.slice(-6)}</code> : <span className="muted">web</span>}</td>
                  <td>{e.ip ?? <span className="muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
