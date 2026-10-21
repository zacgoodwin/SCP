import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import * as api from '../api.ts';
import { safeNext, useAuth } from '../auth.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';

export function RegisterPage() {
  const { me, config, refresh } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (me) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Register sets the session cookie itself; a second login would open an orphan session.
      await api.register(email.trim(), username.trim(), password);
      await refresh();
      nav(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (config && !config.registration) {
    return (
      <main className="auth-page">
        <div className="card auth-card stack">
          <h1>Registration is closed</h1>
          <p>This SCP instance does not accept new sign-ups. Ask an admin to create an account for you.</p>
          <Link to="/login" className="btn btn-primary btn-block">
            Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <form className="card auth-card stack" onSubmit={submit}>
        <h1>Create an account</h1>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Username</span>
          <input
            autoComplete="username"
            required
            pattern="[a-z0-9][a-z0-9_\-]{1,31}"
            title="2-32 characters: lowercase letters, digits, _ and -, starting with a letter or digit"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
          />
          <small className="muted">Lowercase letters, digits, _ and -.</small>
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          <small className="muted">At least 8 characters.</small>
        </label>
        <ErrorBox error={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <p className="muted">
          Have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
