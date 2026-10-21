import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import * as oauth from '../api-oauth.ts';
import { useUser } from '../auth.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';

/**
 * OAuth consent screen (docs/PLAN-v2.md D2). GET /oauth/authorize validates the client and 302s here
 * with its query; unauthenticated users pass through /login?next= first (RequireAuth). The decision
 * goes to POST /api/v1/oauth/consent and the browser follows the returned redirect to the client.
 */
export function ConsentPage() {
  const user = useUser();
  const [params] = useSearchParams();
  const query = Object.fromEntries(params);
  const [info, setInfo] = useState<oauth.ConsentInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [write, setWrite] = useState(false);
  const [restrict, setRestrict] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);

  useEffect(() => {
    oauth.getConsent(query).then(
      (i) => {
        setInfo(i);
        setWrite(i.scopes.includes('write'));
      },
      (e) => setError(e),
    );
    // The query is the page identity; re-validate only when it changes.
  }, [params.toString()]);

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'deny');
    setError(null);
    try {
      const r = await oauth.decideConsent(query, {
        approve,
        scopes: approve ? (write ? ['read', 'write'] : ['read']) : undefined,
        groups: approve && restrict ? picked : null,
      });
      window.location.assign(r.redirect);
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  };

  if (!info) {
    return (
      <main className="auth-page">
        <div className="card auth-card wide stack">
          <p className="auth-brand">SCP</p>
          <h1>Authorize an application</h1>
          {error ? (
            <>
              <ErrorBox error={error} />
              <p className="muted">
                The application that sent you here made an invalid request. Nothing was shared. <Link to="/">Back to the dashboard</Link>.
              </p>
            </>
          ) : (
            <p className="muted" role="status">
              Loading…
            </p>
          )}
        </div>
      </main>
    );
  }

  const toggle = (slug: string, on: boolean) => setPicked((l) => (on ? [...l, slug] : l.filter((x) => x !== slug)));

  return (
    <main className="auth-page">
      <div className="card auth-card wide stack">
        <div className="stack-tight">
          <p className="auth-brand">SCP</p>
          <h1>Authorize {info.client.name}</h1>
          <p className="muted">
            {/* The server registers http(s) only; still never render anything else as a link on an authenticated page. */}
            {info.client.clientUri && /^https?:\/\//i.test(info.client.clientUri) ? (
              <a href={info.client.clientUri} rel="noreferrer noopener" target="_blank">
                {info.client.name}
              </a>
            ) : (
              info.client.name
            )}{' '}
            wants to use SCP as <strong>{user.username}</strong>. After you decide, your browser returns to <code>{info.redirectHost}</code>.
          </p>
        </div>
        <fieldset className="radio-list">
          <legend>Permissions</legend>
          <label className="toggle">
            <input type="checkbox" checked readOnly disabled />
            read
            <span className="muted">(read your groups, skills, prompts and artifacts)</span>
          </label>
          {info.scopes.includes('write') && (
            <label className="toggle">
              <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
              write
              <span className="muted">(create and update artifacts)</span>
            </label>
          )}
        </fieldset>
        <fieldset className="radio-list">
          <legend>Groups</legend>
          <label className="toggle">
            <input type="radio" name="groups" checked={!restrict} onChange={() => setRestrict(false)} />
            Every group you can read
          </label>
          <label className="toggle">
            <input type="radio" name="groups" checked={restrict} onChange={() => setRestrict(true)} />
            Only the groups picked below
          </label>
          {restrict &&
            (info.groups.length === 0 ? (
              <p className="muted">
                No groups yet. <Link to="/groups">Create one</Link> first, or allow every group.
              </p>
            ) : (
              <div className="check-list">
                {info.groups.map((g) => (
                  <label key={g.id} className="toggle">
                    <input type="checkbox" checked={picked.includes(g.slug)} onChange={(e) => toggle(g.slug, e.target.checked)} />
                    {g.name} <code className="muted">{g.slug}</code>
                  </label>
                ))}
              </div>
            ))}
        </fieldset>
        <p className="muted">
          You can revoke this access any time from <Link to="/keys">API keys → Connected apps</Link>.
        </p>
        <ErrorBox error={error} />
        <div className="row end">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void decide(false)}>
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy !== null || (restrict && picked.length === 0)} onClick={() => void decide(true)}>
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    </main>
  );
}
