import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import * as api from '../api.ts';
import * as oauth from '../api-oauth.ts';
import { CopyBlock } from '../components/CopyBlock.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { Modal } from '../components/Modal.tsx';
import { useToast } from '../components/Toast.tsx';
import { dateTime, timeAgo } from '../format.ts';

const When = ({ iso, empty = 'never' }: { iso: string | null; empty?: string }) =>
  iso ? (
    <time dateTime={iso} title={dateTime(iso)}>
      {timeAgo(iso)}
    </time>
  ) : (
    <span className="muted">{empty}</span>
  );

export function KeysPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const preselect = params.get('group');
  const [keys, setKeys] = useState<api.ApiKey[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(Boolean(preselect));

  // A failed load keeps the list unknown (null), never the "No API keys yet" empty state.
  const load = () => (setError(null), api.listKeys().then((r) => setKeys(r.keys), setError));
  useEffect(() => void load(), []);

  const close = () => {
    setOpen(false);
    if (preselect) setParams({}, { replace: true });
  };
  const revoke = async (k: api.ApiKey) => {
    if (!confirm(`Revoke key "${k.name}" (${k.prefix}…)? Agents using it stop working immediately.`)) return;
    try {
      await api.revokeKey(k.id);
      toast('Key revoked.', 'ok');
      void load();
    } catch (e) {
      toast(api.errorMessage(e), 'error');
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>API keys</h1>
          <p className="muted">Keys let agents reach MCP endpoints and bundles as you. Restrict a key to the groups it needs.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            New key
          </button>
        </div>
      </header>
      <ErrorBox error={error} onRetry={() => void load()} />
      {keys === null ? (
        error ? null : <p className="muted" role="status">Loading…</p>
      ) : keys.length === 0 ? (
        <div className="empty">
          <p>No API keys yet. Mint one to connect an agent.</p>
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            Create a key
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Key</th>
                <th scope="col">Scopes</th>
                <th scope="col">Groups</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                <th scope="col" className="cell-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td>
                    <code>{k.prefix}…</code>
                  </td>
                  <td>
                    <span className="badges">
                      {k.scopes.map((s) => (
                        <span key={s} className="badge">
                          {s}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>
                    {k.groupIds === null ? (
                      <span className="muted">all readable groups</span>
                    ) : k.groups.length === 0 ? (
                      <span className="muted">none (groups deleted)</span>
                    ) : (
                      <span className="row wrap">
                        {k.groups.map((g) => (
                          <Link key={g.id} to={`/groups/${encodeURIComponent(g.slug)}`}>
                            {g.slug}
                          </Link>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>
                    <When iso={k.createdAt} />
                  </td>
                  <td>
                    <When iso={k.lastUsedAt} />
                  </td>
                  <td>
                    <When iso={k.expiresAt} />
                    {/* Listed until revoked, but every request with it is a 401. */}
                    {k.expiresAt && Date.parse(k.expiresAt) <= Date.now() && <span className="badge"> expired</span>}
                  </td>
                  <td className="cell-actions">
                    <button type="button" className="btn btn-small btn-danger" onClick={() => void revoke(k)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={open} title="New API key" onClose={close}>
        <CreateKeyForm preselect={preselect} onCreated={() => void load()} onDone={close} />
      </Modal>
      <ConnectedApps />
    </div>
  );
}

/** OAuth grants (D2): hosted MCP clients that went through /consent. Revoking kills their tokens. */
function ConnectedApps() {
  const toast = useToast();
  const [grants, setGrants] = useState<oauth.Grant[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = () => (setError(null), oauth.listGrants().then((r) => setGrants(r.grants), setError));
  useEffect(() => void load(), []);

  const revoke = async (g: oauth.Grant) => {
    if (!confirm(`Disconnect "${g.client.name}"? It loses access immediately and must ask for consent again.`)) return;
    try {
      await oauth.revokeGrant(g.grantId);
      toast('App disconnected.', 'ok');
      void load();
    } catch (e) {
      toast(api.errorMessage(e), 'error');
    }
  };

  return (
    <section className="stack">
      <div className="stack-tight">
        <h2>Connected apps</h2>
        <p className="muted">
          Hosted MCP clients you authorized with OAuth. They reach the MCP endpoints only, never your account, and never with admin rights. The id next
          to each app is what its actions carry in the activity log.
        </p>
      </div>
      <ErrorBox error={error} onRetry={() => void load()} />
      {grants === null ? (
        error ? null : <p className="muted" role="status">Loading…</p>
      ) : grants.length === 0 ? (
        <div className="empty">
          <p>No connected apps.</p>
          <p className="muted">An MCP host that supports OAuth connects by pointing at a group's MCP URL and asking for consent; it shows up here.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Scopes</th>
                <th scope="col">Groups</th>
                <th scope="col">Connected</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                <th scope="col" className="cell-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.grantId}>
                  <td>
                    {g.client.name} <code className="muted">…{g.client.id.slice(-6)}</code>
                    {g.clientDisabled && <span className="badge badge-disabled"> disabled by admin</span>}
                  </td>
                  <td>
                    <span className="badges">
                      {g.scopes.map((s) => (
                        <span key={s} className="badge">
                          {s}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>
                    {g.groups === null ? (
                      <span className="muted">all readable groups</span>
                    ) : g.groups.length === 0 ? (
                      <span className="muted">none (groups deleted)</span>
                    ) : (
                      <span className="row wrap">
                        {g.groups.map((x) => (
                          <Link key={x.id} to={`/groups/${encodeURIComponent(x.slug)}`}>
                            {x.slug}
                          </Link>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>
                    <When iso={g.createdAt} />
                  </td>
                  <td>
                    <When iso={g.lastUsedAt} />
                  </td>
                  <td>
                    <When iso={g.expiresAt} />
                  </td>
                  <td className="cell-actions">
                    <button type="button" className="btn btn-small btn-danger" onClick={() => void revoke(g)}>
                      Disconnect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CreateKeyForm({ preselect, onCreated, onDone }: { preselect: string | null; onCreated: () => void; onDone: () => void }) {
  const [name, setName] = useState(preselect ? `${preselect} agent` : '');
  const [scopes, setScopes] = useState<api.Scope[]>(['read']);
  const [restrict, setRestrict] = useState(Boolean(preselect));
  const [picked, setPicked] = useState<string[]>(preselect ? [preselect] : []);
  const [days, setDays] = useState('');
  const [groups, setGroups] = useState<api.GroupSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    api.listGroups({ limit: 200 }).then((r) => setGroups(r.groups), () => setGroups([]));
  }, []);

  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createKey({
        name: name.trim(),
        scopes,
        groups: restrict ? picked : undefined,
        expiresInDays: days ? Number(days) : undefined,
      });
      setToken(r.token);
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (token) {
    return (
      <div className="stack">
        <p className="notice" role="alert">
          Copy this key now. It is shown only once and cannot be recovered; if you lose it, revoke it and mint a new one.
        </p>
        <CopyBlock label="API key" text={token} />
        <p className="muted">
          Use it as <code>Authorization: Bearer {'<key>'}</code>, or export it as <code>SCP_KEY</code> for the bundle commands.
        </p>
        <div className="row end">
          <button type="button" className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="laptop claude code" autoFocus />
      </label>
      <fieldset className="radio-list">
        <legend>Scopes</legend>
        {(['read', 'write'] as api.Scope[]).map((s) => (
          <label key={s} className="toggle">
            <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(toggle(scopes, s, e.target.checked))} />
            {s}
            <span className="muted">{s === 'read' ? '(read groups and items)' : '(create and update artifacts)'}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="radio-list">
        <legend>Groups</legend>
        <label className="toggle">
          <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
          Restrict to specific groups
        </label>
        {!restrict ? (
          <p className="muted">The key can read every group you can read.</p>
        ) : groups === null ? (
          <p className="muted" role="status">Loading groups…</p>
        ) : groups.length === 0 ? (
          <p className="muted">
            No groups yet. <Link to="/groups">Create one</Link> first.
          </p>
        ) : (
          <div className="check-list">
            {groups.map((g) => (
              <label key={g.id} className="toggle">
                <input type="checkbox" checked={picked.includes(g.slug)} onChange={(e) => setPicked(toggle(picked, g.slug, e.target.checked))} />
                {g.name} <code className="muted">{g.slug}</code>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <label className="field narrow">
        <span>Expires in days</span>
        <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} placeholder="never" />
      </label>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || scopes.length === 0 || (restrict && picked.length === 0)}>
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </div>
    </form>
  );
}
