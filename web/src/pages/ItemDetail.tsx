import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import * as api from '../api.ts';
import * as imp from '../api-import.ts';
import { ArtifactPreview } from '../components/ArtifactPreview.tsx';
import { CopyBlock } from '../components/CopyBlock.tsx';
import { ErrorBox, LintList } from '../components/ErrorBox.tsx';
import { FilesEditor } from '../components/FilesEditor.tsx';
import { KindBadges } from '../components/ItemCard.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useToast } from '../components/Toast.tsx';
import { bytes, dateTime, decodeText, parseTags, timeAgo, toBase64 } from '../format.ts';
import { MULTI_FILE_KINDS } from '../templates.ts';
import { PLANE_LABEL, PLANE_PATH } from './ItemsList.tsx';

type Tab = 'files' | 'preview' | 'shares' | 'edit' | 'versions' | 'lint' | 'groups';

export function ItemDetailPage() {
  const { id = '' } = useParams();
  return <ItemView key={id} id={id} />;
}

function ItemView({ id }: { id: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [item, setItem] = useState<api.ItemDetail | null>(null);
  const [version, setVersion] = useState<api.VersionDetail | null>(null);
  const [versions, setVersions] = useState<api.VersionSummary[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('files');
  const [editingMeta, setEditingMeta] = useState(false);
  const [busy, setBusy] = useState(false);

  const wantSeq = Number(params.get('v')) || null;

  const loadVersions = () => api.listVersions(id).then((r) => setVersions(r.versions), () => setVersions([]));

  useEffect(() => {
    api.getItem(id).then((r) => setItem(r.item), setError);
    void loadVersions();
  }, [id]);

  // Resolve the selected version: the item's embedded latest, or fetch an older one.
  useEffect(() => {
    if (!item) return;
    if (!wantSeq || wantSeq === item.version.seq) return setVersion(item.version);
    let live = true;
    // A bad ?v= (stale link, typo) falls back to the latest version instead of leaving the panel on "Loading version…".
    api.getVersion(id, wantSeq).then(
      (r) => live && setVersion(r.version),
      (e) => {
        if (!live) return;
        toast(`Could not load v${wantSeq} (${api.errorMessage(e)}). Showing the latest version.`, 'error');
        selectVersion(item.latestSeq);
      },
    );
    return () => {
      live = false;
    };
  }, [item, wantSeq, id]);

  const selectVersion = (seq: number, latest = item?.latestSeq) =>
    setParams(
      (p) => {
        if (seq === latest) p.delete('v');
        else p.set('v', String(seq));
        return p;
      },
      { replace: true },
    );

  if (!item) {
    return (
      <div className="page">
        {error ? (
          <>
            <ErrorBox error={error} />
            <p>
              <Link to="/">Back to the dashboard</Link>
            </p>
          </>
        ) : (
          <p className="muted" role="status">Loading…</p>
        )}
      </div>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(api.errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const fork = () =>
    run(async () => {
      // The version on screen, like Files, Download and Edit.
      const r = await api.forkItem(item.id, seq);
      toast(`Forked v${seq} into your items.`, 'ok');
      nav(`/items/${r.item.id}`);
    });
  const remove = () => {
    if (!confirm(`Delete "${item.title || item.name}" and all of its versions? This cannot be undone.`)) return;
    void run(async () => {
      await api.deleteItem(item.id);
      toast('Deleted.', 'ok');
      nav(PLANE_PATH[item.plane]);
    });
  };
  const onNewVersion = (next: api.ItemDetail) => {
    setItem(next);
    selectVersion(next.latestSeq, next.latestSeq);
    setTab('files');
    void loadVersions();
    toast(`Saved v${next.latestSeq}.`, 'ok');
  };

  const tabs: [Tab, string][] = [
    ['files', 'Files'],
    ...(item.kind === 'artifact' ? ([['preview', 'Preview']] as [Tab, string][]) : []),
    ...(item.kind === 'artifact' && item.canEdit ? ([['shares', 'Shares']] as [Tab, string][]) : []),
    ...(item.canEdit ? ([['edit', 'Edit']] as [Tab, string][]) : []),
    ['versions', `Versions (${item.latestSeq})`],
    ['lint', `Lint${version?.lint.length ? ` (${version.lint.length})` : ''}`],
    ['groups', `Groups (${item.groups.length})`],
  ];
  const seqs = versions.length ? versions.map((v) => v.seq) : [item.latestSeq];
  const seq = version?.seq ?? item.latestSeq;

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to={PLANE_PATH[item.plane]}>{PLANE_LABEL[item.plane]}</Link> / {item.name}
      </nav>
      <header className="page-head">
        <div className="page-title">
          <h1>{item.title || item.name}</h1>
          <p className="row wrap">
            <KindBadges item={item} />
            <code className="muted">{item.name}</code>
            <span className="muted">
              by {item.owner.username} · updated <time dateTime={item.updatedAt}>{timeAgo(item.updatedAt)}</time>
            </span>
          </p>
        </div>
        <div className="page-actions">
          <label className="field inline">
            <span>Version</span>
            <select value={seq} onChange={(e) => selectVersion(Number(e.target.value))}>
              {seqs.map((s) => (
                <option key={s} value={s}>
                  v{s}
                  {s === item.latestSeq ? ' (latest)' : ''}
                </option>
              ))}
            </select>
          </label>
          <a className="btn" href={api.downloadZipUrl(item.id, seq)} download>
            Download zip
          </a>
          <button type="button" className="btn" disabled={busy} onClick={fork}>
            Fork
          </button>
          {item.canEdit && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </header>

      {editingMeta ? (
        <MetaEditor
          item={item}
          onCancel={() => setEditingMeta(false)}
          onSaved={(next) => {
            setItem(next);
            setEditingMeta(false);
            toast('Details saved.', 'ok');
          }}
        />
      ) : (
        <section className="meta">
          {item.description ? <p>{item.description}</p> : <p className="muted">No description.</p>}
          <div className="row wrap">
            {item.category && <span className="badge">{item.category}</span>}
            {item.tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
            {item.canEdit && (
              <button type="button" className="btn btn-small" onClick={() => setEditingMeta(true)}>
                Edit details
              </button>
            )}
          </div>
        </section>
      )}

      {item.source && (
        <SourcePanel
          item={item}
          source={item.source}
          onUpdated={(next) => {
            setItem(next);
            selectVersion(next.latestSeq, next.latestSeq);
            setTab('files');
            void loadVersions();
            toast(`Updated to v${next.latestSeq} from GitHub.`, 'ok');
          }}
          onRepinned={setItem}
        />
      )}

      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Item sections" idPrefix="tab" panelId="tab-panel" />
      <section id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="tab-panel">
        {!version ? (
          <p className="muted" role="status">Loading version…</p>
        ) : tab === 'files' ? (
          <FilesTab key={version.seq} item={item} version={version} />
        ) : tab === 'preview' ? (
          <ArtifactPreview item={item} version={version} />
        ) : tab === 'shares' ? (
          <SharesTab item={item} seq={version.seq} />
        ) : tab === 'edit' ? (
          <EditTab key={version.seq} item={item} version={version} onSaved={onNewVersion} />
        ) : tab === 'versions' ? (
          <VersionsTab versions={versions} current={version.seq} onSelect={(s) => (selectVersion(s), setTab('files'))} />
        ) : tab === 'lint' ? (
          <LintList lint={version.lint} />
        ) : (
          <GroupsTab item={item} />
        )}
      </section>
    </div>
  );
}

function MetaEditor({ item, onSaved, onCancel }: { item: api.ItemDetail; onSaved: (i: api.ItemDetail) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(item.title ?? '');
  const [description, setDescription] = useState(item.description ?? '');
  const [category, setCategory] = useState(item.category ?? '');
  const [tags, setTags] = useState(item.tags.join(', '));
  const [visibility, setVisibility] = useState(item.visibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.updateItem(item.id, { title, description, category: category || null, tags: parseTags(tags), visibility });
      onSaved(r.item);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Category</span>
          {item.kind === 'artifact' ? (
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">none</option>
              {/* Set over the API or MCP: show the real value instead of falling back to the first option. */}
              {item.category && !api.ARTIFACT_CATEGORIES.includes(item.category) && <option value={item.category}>{item.category}</option>}
              {api.ARTIFACT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : (
            <input value={category} onChange={(e) => setCategory(e.target.value)} />
          )}
        </label>
        <label className="field">
          <span>Tags</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
          <small className="muted">Comma separated.</small>
        </label>
        <label className="field">
          <span>Visibility</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as api.Visibility)}>
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
        </label>
        <label className="field span-2">
          <span>Description</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save details'}
        </button>
      </div>
    </form>
  );
}

/** Import provenance (D1): where the item came from, and for GitHub sources the check/update flow. */
function SourcePanel({
  item,
  source: s,
  onUpdated,
  onRepinned,
}: {
  item: api.ItemDetail;
  source: api.ItemSource;
  onUpdated: (i: api.ItemDetail) => void;
  /** Same item, new pinned commit, no new version. */
  onRepinned: (i: api.ItemDetail) => void;
}) {
  const [check, setCheck] = useState<imp.SourceCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = imp.sourceUrl(s);
  const short = (sha: string) => sha.slice(0, 7);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(imp.importErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const doCheck = run(async () => setCheck(await imp.checkSource(item.id)));
  const doUpdate = run(async () => {
    try {
      const r = await imp.updateSource(item.id);
      setCheck(null);
      onUpdated(r.item);
    } catch (e) {
      if (!(e instanceof api.ApiError && e.code === 'up_to_date')) throw e;
      // The tree matched, so the server only re-pinned the commit: reload the panel, or it keeps
      // showing the old sha next to "New commit … upstream" and an "Update to latest" that 409s again.
      setCheck(null);
      onRepinned((await api.getItem(item.id)).item);
      setError(imp.importErrorMessage(e));
    }
  });

  return (
    <section className="card stack-tight" aria-label="Source">
      <div className="row wrap">
        <strong>Source</strong>
        <span className="badge">{s.kind}</span>
        {s.repo && (url ? <a href={url} target="_blank" rel="noreferrer noopener">{s.repo}</a> : <code>{s.repo}</code>)}
        {s.path && <code className="muted">{s.path}</code>}
        {s.ref && <span className="muted">ref {s.ref}</span>}
        {s.commit && (
          <code className="muted" title={s.commit}>
            {s.kind === 'github' ? '@' : 'sha256 '}
            {short(s.commit)}
          </code>
        )}
      </div>
      {s.kind === 'github' && item.canEdit && (
        <div className="row wrap">
          <button type="button" className="btn btn-small" disabled={busy} onClick={doCheck}>
            {busy && !check ? 'Checking…' : 'Check for updates'}
          </button>
          {check &&
            (check.upToDate ? (
              <span className="muted" role="status">Up to date.</span>
            ) : (
              <>
                <span role="status">
                  New commit <code title={check.latestCommit}>{short(check.latestCommit)}</code> upstream.
                </span>
                <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={doUpdate}>
                  {busy ? 'Updating…' : 'Update to latest'}
                </button>
              </>
            ))}
          {error && (
            <span className="muted" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

const PREVIEW_LIMIT = 1024 * 1024;

type Row = { dir: string; depth: number } | { file: api.VersionFile; depth: number };

/** Sorted paths -> directory header rows + indented file rows. */
function treeRows(files: api.VersionFile[]): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!seen.has(dir)) {
        seen.add(dir);
        rows.push({ dir, depth: i - 1 });
      }
    }
    rows.push({ file, depth: parts.length - 1 });
  }
  return rows;
}

function FilesTab({ item, version }: { item: api.ItemDetail; version: api.VersionDetail }) {
  const [path, setPath] = useState(version.entryPath);
  const [text, setText] = useState<string | null | undefined>(undefined); // undefined loading, null binary/too large
  const [error, setError] = useState<unknown>(null);
  const file = version.files.find((f) => f.path === path);

  useEffect(() => {
    if (!file) return;
    setText(undefined);
    setError(null);
    if (file.size > PREVIEW_LIMIT) return setText(null);
    let live = true;
    api.getFileBytes(item.id, file.path, version.seq).then(
      (buf) => live && setText(decodeText(buf)),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
    // Keyed by seq and path, not the version object: saving item details replaces that object
    // (same immutable snapshot), which must not re-fetch.
  }, [item.id, version.seq, path]);

  return (
    <div className="files-view">
      <ul className="file-tree" aria-label="Files">
        {treeRows(version.files).map((r) =>
          'dir' in r ? (
            <li key={`d:${r.dir}`} className="tree-dir" style={{ paddingLeft: `${r.depth}rem` }}>
              {r.dir.split('/').pop()}/
            </li>
          ) : (
            <li key={r.file.path} style={{ paddingLeft: `${r.depth}rem` }}>
              <button type="button" className={r.file.path === path ? 'file-btn active' : 'file-btn'} aria-current={r.file.path === path} onClick={() => setPath(r.file.path)}>
                {r.file.path.split('/').pop()}
              </button>
            </li>
          ),
        )}
      </ul>
      <div className="file-content">
        {file ? (
          <>
            <div className="row file-head">
              <code>{file.path}</code>
              <span className="muted">{bytes(file.size)}</span>
              <a className="btn btn-small" href={api.fileUrl(item.id, file.path, version.seq)} download={file.path.split('/').pop()}>
                Download
              </a>
            </div>
            <ErrorBox error={error} />
            {text === undefined && !error ? (
              <p className="muted" role="status">Loading…</p>
            ) : text === null ? (
              <p className="muted">{file.size > PREVIEW_LIMIT ? 'Too large to preview.' : 'Binary file.'} Use Download to get it.</p>
            ) : (
              text !== undefined && <pre className="code-view">{text}</pre>
            )}
          </>
        ) : (
          <p className="muted">Select a file.</p>
        )}
      </div>
    </div>
  );
}

function EditTab({ item, version, onSaved }: { item: api.ItemDetail; version: api.VersionDetail; onSaved: (i: api.ItemDetail) => void }) {
  const [files, setFiles] = useState<api.FileIn[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // A version is a full snapshot, so load every file; binaries ride along as base64.
  useEffect(() => {
    let live = true;
    const sorted = [...version.files].sort((a, b) => (a.path === version.entryPath ? -1 : b.path === version.entryPath ? 1 : a.path.localeCompare(b.path)));
    Promise.all(
      sorted.map(async (f): Promise<api.FileIn> => {
        const buf = await api.getFileBytes(item.id, f.path, version.seq);
        const text = decodeText(buf);
        const mode = f.mode === 493 ? 493 : 420;
        return text === null ? { path: f.path, contentBase64: toBase64(buf), mode } : { path: f.path, content: text, mode };
      }),
    ).then((fs) => live && setFiles(fs), (e) => live && setError(e));
    return () => {
      live = false;
    };
    // seq, not the version object: a version is an immutable snapshot, and saving item details hands
    // back a new object for the same seq, which must not reload the files over unsaved edits.
  }, [item.id, version.seq]);

  if (!files) return error ? <ErrorBox error={error} /> : <p className="muted" role="status">Loading files…</p>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createVersion(item.id, files, note.trim() || undefined);
      onSaved(r.item);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const multi = MULTI_FILE_KINDS.includes(item.kind) || files.length > 1;
  return (
    <form className="stack" onSubmit={submit}>
      {version.seq !== item.latestSeq && (
        <p className="notice">
          Editing from v{version.seq}. Saving creates v{item.latestSeq + 1}.
        </p>
      )}
      <FilesEditor files={files} onChange={setFiles} multi={multi} />
      <label className="field">
        <span>Version note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed" />
      </label>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save as new version'}
        </button>
      </div>
    </form>
  );
}

function VersionsTab({ versions, current, onSelect }: { versions: api.VersionSummary[]; current: number; onSelect: (seq: number) => void }) {
  if (versions.length === 0) return <p className="muted">No version history available.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Note</th>
            <th scope="col">Created</th>
            <th scope="col">By</th>
            <th scope="col" className="cell-actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.seq} aria-current={v.seq === current}>
              <td>v{v.seq}</td>
              <td>{v.note || <span className="muted">-</span>}</td>
              <td>
                <time dateTime={v.createdAt} title={dateTime(v.createdAt)}>
                  {timeAgo(v.createdAt)}
                </time>
              </td>
              {/* The actor, as Activity shows it: a connected app (its client id), an API key, or the browser. */}
              <td className="muted">{v.createdBy?.clientId ? `app …${v.createdBy.clientId.slice(-6)}` : v.createdBy?.keyId ? `API key ${v.createdBy.keyId.slice(-6)}` : 'web'}</td>
              <td className="cell-actions">
                <button type="button" className="btn btn-small" disabled={v.seq === current} onClick={() => onSelect(v.seq)}>
                  {v.seq === current ? 'Viewing' : 'View'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** seq: the version on screen. A pinned link pins that one, not whatever is latest when the request lands. */
function SharesTab({ item, seq }: { item: api.ItemDetail; seq: number }) {
  const toast = useToast();
  const [shares, setShares] = useState<api.Share[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api.listShares(item.id).then((r) => setShares(r.shares), (e) => (setError(e), setShares([])));
  useEffect(() => void load(), [item.id]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createShare(item.id, pin ? seq : undefined);
      toast('Share link created.', 'ok');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (s: api.Share) => {
    if (!confirm('Revoke this link? Anyone opening it gets a 404 from now on.')) return;
    try {
      await api.revokeShare(s.id);
      toast('Link revoked.', 'ok');
      await load();
    } catch (err) {
      toast(api.errorMessage(err), 'error');
    }
  };

  return (
    <div className="stack">
      <form className="card stack" onSubmit={create}>
        <p>
          A share link renders this artifact for anyone who has the link, without signing in. Links are unguessable and can be revoked at any
          time.
        </p>
        <label className="toggle">
          <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
          Pin to this version (v{seq}); otherwise the link follows the latest version
        </label>
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create share link'}
          </button>
        </div>
      </form>
      <ErrorBox error={error} />
      {shares === null ? (
        <p className="muted" role="status">Loading…</p>
      ) : shares.length === 0 ? (
        <p className="muted">No share links yet.</p>
      ) : (
        <ul className="stack share-list">
          {shares.map((s) => (
            <li key={s.id} className={s.revokedAt ? 'card stack share revoked' : 'card stack share'}>
              <p className="row wrap">
                {s.revokedAt ? <span className="badge badge-disabled">revoked</span> : <span className="badge badge-public">active</span>}
                <span className="badge">{s.pinnedSeq ? `pinned v${s.pinnedSeq}` : 'follows latest'}</span>
                <span className="muted grow">
                  created <time dateTime={s.createdAt}>{timeAgo(s.createdAt)}</time>
                  {s.revokedAt && (
                    <>
                      {' '}
                      · revoked <time dateTime={s.revokedAt}>{timeAgo(s.revokedAt)}</time>
                    </>
                  )}
                </span>
                {!s.revokedAt && (
                  <button type="button" className="btn btn-small btn-danger" onClick={() => void revoke(s)}>
                    Revoke
                  </button>
                )}
              </p>
              {!s.revokedAt && (
                <>
                  <CopyBlock label="Share page" text={s.url} />
                  <CopyBlock label="Raw (artifact only, embeddable)" text={s.rawUrl} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GroupsTab({ item }: { item: api.ItemDetail }) {
  if (item.groups.length === 0) {
    return (
      <div className="empty">
        <p>Not in any group yet.</p>
        <p className="muted">Open a group you own and add this item from its "Add items" panel to serve it over MCP or in a bundle.</p>
        <Link className="btn btn-primary" to="/groups">
          Open groups
        </Link>
      </div>
    );
  }
  return (
    <ul className="link-list">
      {item.groups.map((g) => (
        <li key={g.slug}>
          <Link to={`/groups/${encodeURIComponent(g.slug)}`}>{g.name}</Link> <code className="muted">{g.slug}</code>
        </li>
      ))}
    </ul>
  );
}
