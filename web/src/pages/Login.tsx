import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import * as api from '../api.ts';
import { safeNext, useAuth } from '../auth.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';

export function LoginPage() {
  const { me, config, refresh } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const next = safeNext(params.get('next'));
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (me) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(login.trim(), password);
      await refresh();
      nav(next, { replace: true });
    } catch (err) {
      setError(err instanceof api.ApiError && err.status === 401 ? new Error('Wrong login or password.') : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="card auth-card stack" onSubmit={submit}>
        <h1>Sign in to SCP</h1>
        <label className="field">
          <span>Email or username</span>
          <input autoComplete="username" required autoFocus value={login} onChange={(e) => setLogin(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorBox error={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {config?.registration !== false && (
          <p className="muted">
            No account? <Link to={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>Register</Link>
          </p>
        )}
      </form>
    </main>
  );
}
