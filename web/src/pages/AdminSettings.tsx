import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api.ts';
import * as admin from '../api-admin.ts';
import { useUser } from '../auth.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { useToast } from '../components/Toast.tsx';
import { bytes, dateTime, timeAgo } from '../format.ts';

/** D4 (docs/PLAN-v2.md): OIDC, GitHub token, import limits, storage and OAuth clients. */
export function AdminSettingsPage() {
  const me = useUser();
  if (!me.isAdmin) {
    return (
      <div className="page">
        <h1>Settings</h1>
        <div className="empty">
          <p>Only admins can change server settings.</p>
          <Link className="btn" to="/">
            Back to the dashboard
          </Link>
        </div>
      </div>
    );
  }
  return <Settings />;
}

function Settings() {
  const [settings, setSettings] = useState<admin.AdminSettings | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = () => admin.getSettings().then(setSettings, setError);
  useEffect(() => void load(), []);

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <p className="eyebrow">Admin</p>
          <h1>Settings</h1>
          <p className="muted">Login, imports, storage and OAuth clients. Values set through environment variables are read-only here; unset the variable to manage them.</p>
        </div>
      </header>
      <ErrorBox error={error} />
      {settings !== null ? (
        <>
          <OidcCard settings={settings} onSaved={setSettings} />
          <GithubCard settings={settings} onSaved={setSettings} />
          <ImportsCard settings={settings} onSaved={setSettings} />
          <StorageCard settings={settings} onSwept={setSettings} />
          <OAuthClientsCard />
        </>
      ) : error ? null : (
        <p className="muted" role="status">Loading…</p>
      )}
    </div>
  );
}

const Source = ({ source }: { source: admin.SettingSource }) =>
  source === 'env' ? <span className="badge badge-kind">environment</span> : source === 'settings' ? <span className="badge badge-public">configured</span> : <span className="muted">not configured</span>;

function OidcCard({ settings, onSaved }: { settings: admin.AdminSettings; onSaved: (s: admin.AdminSettings) => void }) {
  const toast = useToast();
  const o = settings.oidc;
  // Read-only per field: SCP_OIDC_LABEL alone must not lock the issuer, client id and secret.
  const envOf = (f: admin.OidcField) => o.envFields.includes(f);
  const env = (['issuer', 'clientId', 'clientSecret', 'autoRegister', 'label'] as admin.OidcField[]).every(envOf);
  const [issuer, setIssuer] = useState(o.issuer ?? '');
  const [clientId, setClientId] = useState(o.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [autoRegister, setAutoRegister] = useState(o.autoRegister);
  const [label, setLabel] = useState(o.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async (patch: admin.SettingsPatch['oidc']) => {
    setBusy(true);
    setError(null);
    try {
      const s = await admin.putSettings({ oidc: patch });
      onSaved(s);
      setClientSecret('');
      toast('OIDC settings saved.', 'ok');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Only the fields the environment leaves alone (the API answers 400 env_managed for the others).
    // A blank secret field keeps the stored secret; "Clear secret" removes it.
    void save({
      ...(envOf('issuer') ? {} : { issuer }),
      ...(envOf('clientId') ? {} : { clientId }),
      ...(envOf('autoRegister') ? {} : { autoRegister }),
      ...(envOf('label') ? {} : { label }),
      ...(clientSecret && !envOf('clientSecret') ? { clientSecret } : {}),
    });
  };

  return (
    <section className="card stack">
      <header className="card-head">
        <h2>OIDC login</h2>
        <Source source={o.source} />
      </header>
      <p className="muted">
        Single sign-on against an external identity provider. Login works once the issuer, client id and client secret are all set.
        {o.envFields.length > 0 && ` Set by the environment (SCP_OIDC_*), read-only here: ${o.envFields.join(', ')}.`}
      </p>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Issuer URL</span>
          <input value={issuer} onChange={(e) => setIssuer(e.target.value)} disabled={envOf('issuer')} placeholder="https://idp.example.com" autoComplete="off" />
        </label>
        <label className="field">
          <span>Client id</span>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={envOf('clientId')} autoComplete="off" />
        </label>
        <label className="field">
          <span>Client secret</span>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            disabled={envOf('clientSecret')}
            autoComplete="new-password"
            placeholder={o.clientSecretSet ? 'Set. Leave blank to keep it.' : 'Not set'}
          />
          <small className="muted">
            {o.clientSecretSet ? 'A secret is stored; it is never shown again.' : 'No secret stored.'}{' '}
            {o.clientSecretSet && !envOf('clientSecret') && (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void save({ clientSecret: '' })}>
                Clear secret
              </button>
            )}
          </small>
        </label>
        <label className="field">
          <span>Button label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={envOf('label')} maxLength={100} autoComplete="off" />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={autoRegister} onChange={(e) => setAutoRegister(e.target.checked)} disabled={envOf('autoRegister')} />
          Create an account on first login (auto-register)
        </label>
        <ErrorBox error={error} />
        {!env && (
          <div className="row end">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save OIDC settings'}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

function GithubCard({ settings, onSaved }: { settings: admin.AdminSettings; onSaved: (s: admin.AdminSettings) => void }) {
  const toast = useToast();
  const g = settings.github;
  const env = g.source === 'env';
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await admin.putSettings({ github: { token: value } }));
      setToken('');
      toast(value ? 'GitHub token saved.' : 'GitHub token cleared.', 'ok');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <header className="card-head">
        <h2>GitHub imports</h2>
        <Source source={g.source} />
      </header>
      <p className="muted">
        A token raises the GitHub API rate limit for every user's imports and lets admins import private repositories the token can reach (other
        accounts are refused a private repository, so the token never widens their access). {g.tokenSet ? 'A token is stored.' : 'No token stored.'}
        {env && ' It comes from SCP_GITHUB_TOKEN and cannot be edited here.'}
      </p>
      {!env && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void save(token.trim());
          }}
        >
          <label className="field">
            <span>Personal access token</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder={g.tokenSet ? 'Set. Enter a new one to replace it.' : 'ghp_…'} />
          </label>
          <ErrorBox error={error} />
          <div className="row end">
            {g.tokenSet && (
              <button type="button" className="btn" disabled={busy} onClick={() => void save('')}>
                Clear token
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy || !token.trim()}>
              {busy ? 'Saving…' : 'Save token'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** [field, label, unit, default, max]: the server's config.ts IMPORT_LIMITS. */
const IMPORT_FIELDS: [admin.ImportField, string, string, number, number][] = [
  ['maxItems', 'Items per import', 'items', 200, 2000],
  ['maxArchiveMb', 'Archive size (GitHub download, zip upload)', 'MB compressed', 35, 256],
  ['maxPackMb', 'Pack size, unpacked', 'MB', 64, 256],
];
/** github.ts ZIPBALL_SLOTS: repository downloads in flight at once, each holding up to the archive cap. */
const DOWNLOAD_SLOTS = 3;

function ImportsCard({ settings, onSaved }: { settings: admin.AdminSettings; onSaved: (s: admin.AdminSettings) => void }) {
  const toast = useToast();
  const im = settings.imports;
  const envOf = (f: admin.ImportField) => im.envFields.includes(f);
  const [values, setValues] = useState<Record<admin.ImportField, string>>({ maxItems: String(im.maxItems), maxArchiveMb: String(im.maxArchiveMb), maxPackMb: String(im.maxPackMb) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Only the fields the environment leaves alone; a blank field goes back to the default.
      const patch: NonNullable<admin.SettingsPatch['imports']> = {};
      for (const [f] of IMPORT_FIELDS) if (!envOf(f)) patch[f] = values[f].trim() === '' ? '' : Number(values[f]);
      const s = await admin.putSettings({ imports: patch });
      onSaved(s);
      setValues({ maxItems: String(s.imports.maxItems), maxArchiveMb: String(s.imports.maxArchiveMb), maxPackMb: String(s.imports.maxPackMb) });
      toast('Import limits saved.', 'ok');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <header className="card-head">
        <h2>Imports</h2>
      </header>
      <p className="muted">
        Limits for pack and GitHub imports. Up to {DOWNLOAD_SLOTS} repository downloads run at once, each holding up to the archive size in memory
        (now {DOWNLOAD_SLOTS * im.maxArchiveMb} MB at most), and every import holds its unpacked files. A GitHub folder whose repository archive is
        over the cap is fetched file by file instead, one API request per file.
        {im.envFields.length > 0 && ` Set by the environment (SCP_IMPORT_*), read-only here: ${im.envFields.join(', ')}.`}
      </p>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        {IMPORT_FIELDS.map(([f, label, unit, def, max]) => (
          <label className="field" key={f}>
            <span>{label}</span>
            <input
              type="number"
              min={1}
              max={max}
              step={1}
              value={values[f]}
              onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              disabled={envOf(f)}
              placeholder={String(def)}
            />
            <small className="muted">
              {unit}, 1 to {max} (default {def}){envOf(f) ? '. Set by the environment.' : '. Leave blank for the default.'}
            </small>
          </label>
        ))}
        <ErrorBox error={error} />
        {im.envFields.length < IMPORT_FIELDS.length && (
          <div className="row end">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save import limits'}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

function StorageCard({ settings, onSwept }: { settings: admin.AdminSettings; onSwept: (s: admin.AdminSettings) => void }) {
  const toast = useToast();
  const s = settings.storage;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const sweep = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await admin.runGc();
      toast(r.deletedBlobs ? `Deleted ${r.deletedBlobs} orphan blobs, freed ${bytes(r.freedBytes)}.` : 'Nothing to sweep.', 'ok');
      onSwept(await admin.getSettings());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <header className="card-head">
        <h2>Storage</h2>
        <button type="button" className="btn btn-small" disabled={busy || s.orphanBlobs === 0} onClick={() => void sweep()}>
          {busy ? 'Sweeping…' : 'Sweep orphan blobs'}
        </button>
      </header>
      <dl className="kv">
        <dt>Users</dt>
        <dd>{s.users}</dd>
        <dt>Groups</dt>
        <dd>{s.groups}</dd>
        <dt>Items</dt>
        <dd>{s.items}</dd>
        <dt>Versions</dt>
        <dd>{s.versions}</dd>
        <dt>Blobs</dt>
        <dd>
          {s.blobs} ({bytes(s.blobBytes)})
        </dd>
        <dt>Orphan blobs</dt>
        <dd>
          {s.orphanBlobs} ({bytes(s.orphanBytes)})
        </dd>
        <dt>Registration</dt>
        <dd>{settings.registration.enabled ? 'open' : 'disabled'} <span className="muted">(SCP_ALLOW_REGISTRATION)</span></dd>
      </dl>
      <p className="muted">
        Blob rows are removed in the same transaction as the item or user delete that drops their last reference, and a full sweep runs at boot
        (this reclaims space left by a database created before v2). The button runs that sweep by hand and is disabled while there is nothing to
        sweep.
      </p>
      <ErrorBox error={error} />
    </section>
  );
}

/** D2's GET /oauth/clients; until that chunk is merged the endpoint 404s and the card says so. */
const CLIENTS_PAGE = 50;

function OAuthClientsCard() {
  const toast = useToast();
  const [clients, setClients] = useState<admin.OAuthClient[] | null>(null);
  const [total, setTotal] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Paged: anonymous registration makes the list attacker-sized, so the first 50 load and the rest on request.
  const load = (offset: number) =>
    admin.listOAuthClients({ limit: CLIENTS_PAGE, offset }).then(
      (r) => {
        setClients((list) => [...(offset ? (list ?? []) : []), ...r.clients]);
        setTotal(r.total);
      },
      (e) => {
        // A failed listing is not "no clients": the list stays unknown (null) beside the error, never the empty state.
        if (e instanceof ApiError && e.status === 404) {
          setUnavailable(true);
          setClients((list) => list ?? []);
        } else setError(e);
      },
    );
  useEffect(() => {
    void load(0);
  }, []);

  const toggle = async (c: admin.OAuthClient) => {
    setBusy(c.id);
    try {
      const r = await admin.patchOAuthClient(c.id, !c.disabled);
      setClients((list) => list?.map((x) => (x.id === c.id ? { ...x, ...r.client } : x)) ?? null);
      toast(r.client.disabled ? `Disabled ${c.name}.` : `Enabled ${c.name}.`, 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card stack">
      <header className="card-head">
        <h2>OAuth clients</h2>
      </header>
      <p className="muted">
        MCP clients that registered to log in with OAuth. Disabling one suspends access for every user who approved it, until it is enabled again; users
        revoke a grant for good from their own Connected apps. A registration nobody consented to is dropped after 7 days.
      </p>
      <ErrorBox error={error} />
      {clients === null ? (
        error ? null : <p className="muted" role="status">Loading…</p>
      ) : unavailable ? (
        <p className="muted">The OAuth server is not available on this instance.</p>
      ) : clients.length === 0 ? (
        <div className="empty">
          <p>No clients have registered yet.</p>
          <p className="muted">A hosted MCP host registers itself the first time a user connects it to a group's MCP URL.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Redirect URIs</th>
                <th scope="col">Auth</th>
                <th scope="col">Grants</th>
                <th scope="col">Registered</th>
                <th scope="col">Status</th>
                <th scope="col" className="cell-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name} <code className="muted">…{c.id.slice(-6)}</code>
                  </td>
                  <td>
                    {(c.redirectUris ?? []).map((u) => (
                      <div key={u}>
                        <code>{u}</code>
                      </div>
                    ))}
                  </td>
                  <td>{c.authMethod}</td>
                  <td>{c.grants}</td>
                  <td>
                    <time dateTime={c.createdAt} title={dateTime(c.createdAt)}>
                      {timeAgo(c.createdAt)}
                    </time>
                  </td>
                  <td>{c.disabled ? <span className="badge badge-disabled">disabled</span> : <span className="muted">active</span>}</td>
                  <td className="cell-actions">
                    <button type="button" className="btn btn-small" disabled={busy === c.id} onClick={() => void toggle(c)}>
                      {c.disabled ? 'Enable' : 'Disable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {clients.length < total && (
            <div className="row">
              <button type="button" className="btn btn-small" onClick={() => void load(clients.length)}>
                Load more ({total - clients.length} of {total} not shown)
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
