import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import * as api from '../api.ts';
import { safeNext, useAuth } from '../auth.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';

/**
 * Where the SSO callback sends a first sign-in whose verified email matches a password account: the
 * account's password is the proof that links the identity (POST /auth/oidc/link/confirm).
 */
export function LinkSsoPage() {
  const { config, refresh } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('t') ?? '';
  const [account, setAccount] = useState<{ email: string; username: string } | null>(null);
  const [dead, setDead] = useState<unknown>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const label = config?.oidc?.label || 'single sign-on';

  useEffect(() => {
    api.oidcPendingLink(token).then(setAccount, setDead);
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.oidcConfirmLink(token, password);
      await refresh();
      nav(safeNext(r.next), { replace: true });
    } catch (err) {
      if (err instanceof api.ApiError && err.code === 'bad_link_token') setDead(err);
      else setError(err instanceof api.ApiError && err.code === 'invalid_credentials' ? new Error('Wrong password.') : err);
    } finally {
      setBusy(false);
    }
  };

  if (dead) {
    return (
      <main className="auth-page">
        <div className="card auth-card stack">
          <p className="auth-brand">SCP</p>
          <h1>Link expired</h1>
          <p className="muted">This request to link {label} expired or was already used. Sign in again to start over.</p>
          <Link className="btn btn-primary btn-block" to="/login">
            Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <form className="card auth-card stack" onSubmit={submit}>
        <p className="auth-brand">SCP</p>
        <h1>Link {label}?</h1>
        <p>An account with this email already exists. Link {label} to it?</p>
        {account ? (
          <p className="muted">
            {account.email} ({account.username})
          </p>
        ) : (
          <p className="muted" role="status">
            Loading…
          </p>
        )}
        <label className="field">
          <span>That account's password</span>
          <input type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorBox error={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !account}>
          {busy ? 'Linking…' : 'Link and sign in'}
        </button>
        <Link className="btn btn-block" to="/login">
          Cancel
        </Link>
      </form>
    </main>
  );
}
