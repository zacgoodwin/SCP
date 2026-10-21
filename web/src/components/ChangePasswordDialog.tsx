import { useState, type FormEvent } from 'react';
import * as api from '../api.ts';
import { ErrorBox } from './ErrorBox.tsx';
import { Modal } from './Modal.tsx';
import { useToast } from './Toast.tsx';

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const close = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError(new Error('The new passwords do not match.'));
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      toast('Password changed.', 'ok');
      close();
    } catch (err) {
      // The server answers a wrong current password with the generic login error.
      setError(err instanceof api.ApiError && err.code === 'invalid_credentials' ? new Error('The current password is incorrect.') : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Change password" onClose={close}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Current password</span>
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          <span>New password</span>
          <input type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <ErrorBox error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
