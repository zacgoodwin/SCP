import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import * as api from '../api.ts';
import { useAuth } from '../auth.tsx';
import { ErrorBox } from './ErrorBox.tsx';
import { Modal } from './Modal.tsx';
import { useToast } from './Toast.tsx';

/** Layout opens the dialog when the URL carries this hash: where the SSO round trip for a stale session returns. */
export const SET_PASSWORD_HASH = '#set-password';

/**
 * Change password, or for an account created by single sign-on (`hasPassword` false) set a first,
 * break-glass one: no current password, but the server wants an SSO sign-in from the last 10 minutes.
 */
export function ChangePasswordDialog({ open, hasPassword, onClose }: { open: boolean; hasPassword: boolean; onClose: () => void }) {
  const toast = useToast();
  const { config, refresh } = useAuth();
  const { pathname, search } = useLocation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reauth, setReauth] = useState(false);

  const close = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    setReauth(false);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError(new Error('The new passwords do not match.'));
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(hasPassword ? current : undefined, next);
      await refresh();
      toast(hasPassword ? 'Password changed.' : 'Password set. You can now also sign in with it.', 'ok');
      close();
    } catch (err) {
      if (err instanceof api.ApiError && err.code === 'reauth_required') {
        setReauth(true);
        setError(new Error(`For your security, sign in with ${config?.oidc?.label || 'single sign-on'} again first; you come straight back here.`));
      } else {
        // The server answers a wrong current password with the generic login error.
        setError(err instanceof api.ApiError && err.code === 'invalid_credentials' ? new Error('The current password is incorrect.') : err);
      }
    } finally {
      setBusy(false);
    }
  };

  const title = hasPassword ? 'Change password' : 'Set a password';
  return (
    <Modal open={open} title={title} onClose={close}>
      <form className="stack" onSubmit={submit}>
        {hasPassword ? (
          <label className="field">
            <span>Current password</span>
            <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
        ) : (
          <p className="muted">Your account signs in with single sign-on. A password lets you sign in with your username or email when the identity provider is unavailable. Single sign-on keeps working.</p>
        )}
        <label className="field">
          <span>New password</span>
          <input type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <ErrorBox error={error} />
        {reauth && config?.oidc?.enabled && (
          <a className="btn btn-block" href={`/api/v1/auth/oidc/start?next=${encodeURIComponent(pathname + search + SET_PASSWORD_HASH)}`}>
            Continue with {config.oidc.label}
          </a>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : title}
          </button>
        </div>
      </form>
    </Modal>
  );
}
