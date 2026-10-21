import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import * as api from '../api.ts';
import { useUser } from '../auth.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { Modal } from '../components/Modal.tsx';
import { useToast } from '../components/Toast.tsx';
import { dateTime, timeAgo } from '../format.ts';

export function AdminUsersPage() {
  const me = useUser();
  if (!me.isAdmin) {
    return (
      <div className="page">
        <h1>Users</h1>
        <div className="empty">
          <p>Only admins can manage users.</p>
          <Link className="btn" to="/">
            Back to the dashboard
          </Link>
        </div>
      </div>
    );
  }
  return <UsersAdmin meId={me.id} />;
}

function UsersAdmin({ meId }: { meId: string }) {
  const toast = useToast();
  const [users, setUsers] = useState<api.User[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [resetFor, setResetFor] = useState<api.User | null>(null);

  const load = () => api.listUsers().then((r) => setUsers(r.users), (e) => (setError(e), setUsers([])));
  useEffect(() => void load(), []);

  const replace = (u: api.User) => setUsers((list) => list?.map((x) => (x.id === u.id ? u : x)) ?? null);
  // 409s (last admin, yourself) come back as readable messages; show them as-is.
  const act = async (u: api.User, fn: () => Promise<void>, done: string) => {
    setBusy(u.id);
    try {
      await fn();
      toast(done, 'ok');
    } catch (e) {
      toast(api.errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  const patch = (u: api.User, p: { isAdmin?: boolean; disabled?: boolean }, done: string) =>
    act(u, async () => replace((await api.updateUser(u.id, p)).user), done);
  const remove = (u: api.User) => {
    if (!confirm(`Delete user ${u.username}? Their items, groups and keys are deleted too. This cannot be undone.`)) return;
    void act(u, async () => {
      await api.deleteUser(u.id);
      setUsers((list) => list?.filter((x) => x.id !== u.id) ?? null);
    }, `Deleted ${u.username}.`);
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Users</h1>
        <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          New user
        </button>
      </header>
      <ErrorBox error={error} />
      {users === null ? (
        <p className="muted" role="status">Loading…</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} aria-current={u.id === meId}>
                  <td>
                    {u.username}
                    {u.id === meId && <span className="muted"> (you)</span>}
                  </td>
                  <td>{u.email}</td>
                  <td>{u.isAdmin ? <span className="badge badge-kind">admin</span> : <span className="muted">user</span>}</td>
                  <td>{u.disabled ? <span className="badge badge-disabled">disabled</span> : <span className="muted">active</span>}</td>
                  <td>
                    <time dateTime={u.createdAt} title={dateTime(u.createdAt)}>
                      {timeAgo(u.createdAt)}
                    </time>
                  </td>
                  <td>
                    <div className="row wrap">
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy === u.id}
                        onClick={() => void patch(u, { isAdmin: !u.isAdmin }, u.isAdmin ? `${u.username} is no longer an admin.` : `${u.username} is now an admin.`)}
                      >
                        {u.isAdmin ? 'Remove admin' : 'Make admin'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy === u.id}
                        onClick={() => void patch(u, { disabled: !u.disabled }, u.disabled ? `Enabled ${u.username}.` : `Disabled ${u.username}.`)}
                      >
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                      {/* A reset revokes the target's sessions and keys; your own password changes from the account menu. */}
                      {u.id !== meId && (
                        <button type="button" className="btn btn-small" disabled={busy === u.id} onClick={() => setResetFor(u)}>
                          Reset password
                        </button>
                      )}
                      <button type="button" className="btn btn-small btn-danger" disabled={busy === u.id} onClick={() => remove(u)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={createOpen} title="New user" onClose={() => setCreateOpen(false)}>
        <CreateUserForm
          onCancel={() => setCreateOpen(false)}
          onCreated={(u) => {
            setUsers((list) => [...(list ?? []), u]);
            setCreateOpen(false);
            toast(`Created ${u.username}.`, 'ok');
          }}
        />
      </Modal>
      <Modal open={resetFor !== null} title={`Reset password for ${resetFor?.username ?? ''}`} onClose={() => setResetFor(null)}>
        {resetFor && (
          <ResetPasswordForm
            user={resetFor}
            onCancel={() => setResetFor(null)}
            onDone={() => {
              toast(`Password reset for ${resetFor.username}. Their sessions were signed out.`, 'ok');
              setResetFor(null);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function CreateUserForm({ onCreated, onCancel }: { onCreated: (u: api.User) => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated((await api.createUser({ email, username, password, isAdmin })).user);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Email</span>
        <input type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>Username</span>
        <input
          required
          autoComplete="off"
          pattern="[a-z0-9][a-z0-9_\-]{1,31}"
          title="2-32 chars: lowercase letters, digits, - and _"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
        />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <small className="muted">At least 8 characters.</small>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
        Admin
      </label>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </form>
  );
}

function ResetPasswordForm({ user, onDone, onCancel }: { user: api.User; onDone: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(user.id, { password });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>New password</span>
        <input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <small className="muted">At least 8 characters. Signs {user.username} out everywhere.</small>
      </label>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Reset password'}
        </button>
      </div>
    </form>
  );
}
