import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import * as api from '../api.ts';
import * as nested from '../api-groups.ts';
import { toolAnchor, type GroupWithRequires } from '../api-tools.ts';
import { PlatformTabs, checkCommand, commandFor, defaultPlatform, platformLabel, type Platform } from '../components/CliTools.tsx';
import { useAuth, useUser } from '../auth.tsx';
import { CopyBlock } from '../components/CopyBlock.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { ImportDialog } from '../components/ImportDialog.tsx';
import { KindBadges } from '../components/ItemCard.tsx';
import { Modal } from '../components/Modal.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useToast } from '../components/Toast.tsx';
import { parseTags, timeAgo } from '../format.ts';
import { PLANE_LABEL } from './ItemsList.tsx';
import { VISIBILITY_LABEL, VisibilityBadge } from './Groups.tsx';

const PLANES: api.Plane[] = ['skill', 'md', 'artifact'];
/** MD kinds that install as one file, so the install path can be overridden. */
const INSTALL_AS_KINDS: api.Kind[] = ['agent', 'command', 'instructions', 'prompt', 'design'];
const TARGETS: api.BundleTarget[] = ['claude-code', 'codex', 'generic'];

/** Member add/update errors with the server message plus what to do about it. */
function memberError(e: unknown): unknown {
  if (!(e instanceof api.ApiError)) return e;
  const hint =
    e.code === 'item_not_shareable'
      ? "Only items you own, or public items, can join a group: adding an item publishes it to the group's audience."
      : e.code === 'path_conflict' || e.status === 409
        ? 'Two members would install to the same path. Set a different "Install as" path on one of them, or remove one.'
        : null;
  return hint ? new api.ApiError(e.status, e.code, `${e.message}. ${hint}`, e.details) : e;
}

const conflictText = (c: api.ManifestConflict) => `${c.path}: ${c.items.join(', ')}`;

type OnChange = (next: api.GroupDetail) => void;

export function GroupDetailPage() {
  const { slug = '' } = useParams();
  return <GroupView key={slug} slug={slug} />;
}

function GroupView({ slug }: { slug: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const { hash } = useLocation();
  const [group, setGroup] = useState<api.GroupDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [manifest, setManifest] = useState<api.Manifest | null>(null);
  const [manifestError, setManifestError] = useState<unknown>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // The manifest's install paths and conflicts depend on the bundle target picked in ConnectSection.
  const [target, setTarget] = useState<api.BundleTarget>('claude-code');

  const loadManifest = (live = () => true) =>
    api.getManifest(slug, target).then(
      (m) => live() && (setManifest(m), setManifestError(null)),
      (e) => live() && (setManifest(null), setManifestError(e)),
    );

  useEffect(() => {
    api.getGroup(slug).then((r) => setGroup(r.group), setError);
  }, [slug]);

  useEffect(() => {
    let live = true;
    void loadManifest(() => live);
    return () => {
      live = false;
    };
  }, [slug, target]);

  const loaded = group !== null;
  useEffect(() => {
    if (loaded && hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [loaded, hash]);

  if (!group) {
    return (
      <div className="page">
        {error ? (
          <>
            <ErrorBox error={error} />
            <p>
              <Link to="/groups">Back to groups</Link>
            </p>
          </>
        ) : (
          <p className="muted" role="status">Loading…</p>
        )}
      </div>
    );
  }

  const onChange: OnChange = (next) => {
    setGroup(next);
    void loadManifest();
  };
  const remove = async () => {
    if (!confirm(`Delete group "${group.name}"? Agents using /mcp/${group.slug} and its bundle lose access. Items are not deleted.`)) return;
    try {
      await api.deleteGroup(group.slug);
      toast('Group deleted.', 'ok');
      nav('/groups');
    } catch (e) {
      toast(api.errorMessage(e), 'error');
    }
  };

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/groups">Groups</Link> / {group.slug}
      </nav>
      <header className="page-head">
        <div className="page-title">
          <h1>{group.name}</h1>
          <p className="row wrap">
            <VisibilityBadge visibility={group.visibility} />
            <code className="muted">{group.slug}</code>
            <span className="muted">
              by {group.owner.username} · updated <time dateTime={group.updatedAt}>{timeAgo(group.updatedAt)}</time>
            </span>
          </p>
          {group.description ? <p>{group.description}</p> : group.canEdit && <p className="muted">No description.</p>}
          {group.tags.length > 0 && (
            <ul className="tags" aria-label="Tags">
              {group.tags.map((t) => (
                <li key={t} className="tag">
                  {t}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="page-actions">
          {group.canEdit && (
            <>
              <button type="button" className="btn" onClick={() => setEditOpen(true)}>
                Edit details
              </button>
              <button type="button" className="btn" onClick={() => setImportOpen(true)}>
                Import into this group
              </button>
            </>
          )}
          <a className="btn btn-primary" href="#connect">
            Connect
          </a>
        </div>
      </header>
      {!group.canEdit && <p className="notice">You have read-only access to this group.</p>}

      <div className={group.canEdit ? 'builder-grid' : 'stack'}>
        <MembersSection group={group} conflicts={manifest?.conflicts ?? []} manifest={manifest} target={target} onChange={onChange} />
        {group.canEdit && <AddItemsPanel group={group} onChange={onChange} />}
      </div>
      <RequiresSection group={group} />
      <IncludesSection group={group} onChange={onChange} />
      <InstructionsSection key={`i:${group.instructions ?? ''}`} group={group} onChange={onChange} />
      <SharingSection group={group} onChange={onChange} />
      <ConnectSection group={group} manifest={manifest} manifestError={manifestError} target={target} setTarget={setTarget} />

      {group.canEdit && (
        <section className="card stack danger-zone" aria-labelledby="danger-h">
          <header className="card-head">
            <h2 id="danger-h">Delete group</h2>
          </header>
          <p className="muted">Removes the group, its MCP endpoint and bundle. Member items stay in their planes.</p>
          <div>
            <button type="button" className="btn btn-danger" onClick={remove}>
              Delete group
            </button>
          </div>
        </section>
      )}

      <Modal open={editOpen} title="Edit group" onClose={() => setEditOpen(false)}>
        <EditGroupForm
          group={group}
          onCancel={() => setEditOpen(false)}
          onSaved={(next) => {
            onChange(next);
            setEditOpen(false);
            toast('Group saved.', 'ok');
          }}
        />
      </Modal>
      {group.canEdit && (
        <ImportDialog
          open={importOpen}
          intoGroup={group.slug}
          onClose={() => setImportOpen(false)}
          onImported={() => api.getGroup(slug).then((r) => onChange(r.group), () => {})}
        />
      )}
    </div>
  );
}

function EditGroupForm({ group, onSaved, onCancel }: { group: api.GroupDetail; onSaved: OnChange; onCancel: () => void }) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [tags, setTags] = useState(group.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.updateGroup(group.slug, { name: name.trim(), description, tags: parseTags(tags) });
      onSaved(r.group);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">
        <span>Tags</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
        <small className="muted">Comma separated.</small>
      </label>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/** Runs one group mutation, feeding the new group to onChange and keeping the error for display. */
function useMutation(onChange: OnChange, mapError: (e: unknown) => unknown = (e) => e) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<{ group: api.GroupDetail }>) => {
    setBusy(true);
    setError(null);
    try {
      onChange((await fn()).group);
      return true;
    } catch (e) {
      setError(mapError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, reset: () => setError(null) };
}

const toMemberIn = (m: api.GroupMember): api.MemberIn => ({
  itemId: m.item.id,
  ...(m.pinnedSeq ? { pinnedSeq: m.pinnedSeq } : {}),
  ...(m.installAs ? { installAs: m.installAs } : {}),
});

function MembersSection({
  group,
  conflicts,
  manifest,
  target,
  onChange,
}: {
  group: api.GroupDetail;
  conflicts: api.ManifestConflict[];
  manifest: api.Manifest | null;
  target: api.BundleTarget;
  onChange: OnChange;
}) {
  const { busy, error, run } = useMutation(onChange, memberError);
  const members = group.members;
  // `via` names the group holding the member's row, at any depth; it is a page the viewer can open only
  // when it is a direct include whose name they were given (a grandchild, or a child gone private, 404s).
  const openable = new Set(((group as nested.GroupDetailV2).includes ?? []).filter((i) => i.name).map((i) => i.slug));
  // PUT replaces every member, so each change is applied to the server's current list, not this
  // page's copy: one an agent (create_artifact) or another tab added since the page loaded would
  // silently leave the group. change returns null when there is nothing to do on the fresh list.
  // Members that flow in through an included group have no row here, so they are left out of the PUT.
  const put = (change: (fresh: api.GroupMember[]) => api.GroupMember[] | null) =>
    run(async () => {
      const fresh = (await api.getGroup(group.slug)).group;
      const next = change(fresh.members.filter((m) => !nested.viaOf(m)));
      return next ? api.putMembers(group.slug, next.map(toMemberIn)) : { group: fresh };
    });
  const patch = (id: string, change: Partial<api.GroupMember>) => put((list) => list.map((m) => (m.item.id === id ? { ...m, ...change } : m)));

  // Swap with the nearest member of the same plane, so display order within a plane is what moves.
  const move = (id: string, dir: -1 | 1) =>
    void put((fresh) => {
      const list = [...fresh];
      const i = list.findIndex((m) => m.item.id === id);
      if (i < 0) return null;
      let j = i + dir;
      while (j >= 0 && j < list.length && list[j].item.plane !== list[i].item.plane) j += dir;
      if (j < 0 || j >= list.length) return null;
      [list[i], list[j]] = [list[j], list[i]];
      return list;
    });

  return (
    <section className="card stack" aria-labelledby="members-h">
      <header className="card-head">
        <h2 id="members-h">Members ({members.length})</h2>
        {group.canEdit && (
          <a className="btn btn-small" href="#add-items">
            Add items
          </a>
        )}
      </header>
      {conflicts.length > 0 && (
        <div className="error-box" role="alert">
          <strong>
            {conflicts.length} install path conflict{conflicts.length === 1 ? '' : 's'}
          </strong>
          <ul>
            {conflicts.map((c, i) => (
              <li key={i}>{conflictText(c)}</li>
            ))}
          </ul>
          <p>Two members install to the same path, so bundle.zip cannot be built until you set "Install as" on one of them or remove it.</p>
        </div>
      )}
      <ErrorBox error={error} />
      {members.length === 0 ? (
        <div className="empty">
          <p>No members yet.</p>
          {group.canEdit ? (
            <>
              <p className="muted">Pick skills, MDs and artifacts from the panel to serve them over MCP and in the bundle.</p>
              <a className="btn btn-primary" href="#add-items">
                Add skills, MDs and artifacts
              </a>
            </>
          ) : (
            <p className="muted">The owner has not added anything to this group.</p>
          )}
        </div>
      ) : (
        PLANES.map((plane) => {
          const list = members.filter((m) => m.item.plane === plane);
          if (list.length === 0) return null;
          return (
            <section key={plane} className="stack-tight" aria-labelledby={`plane-${plane}`}>
              <h3 id={`plane-${plane}`} className="plane-head">
                {PLANE_LABEL[plane]} ({list.length})
              </h3>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Install path</th>
                      <th scope="col">Version</th>
                      {group.canEdit && <th scope="col">Install as</th>}
                      {group.canEdit && (
                        <th scope="col" className="cell-actions">
                          <span className="sr-only">Actions</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m, i) => (
                      <MemberRow
                        key={m.item.id}
                        m={m}
                        // The path for the bundle target picked below, so rows match the conflict banner.
                        installPath={manifest?.items.find((x) => x.id === m.item.id)?.installPath ?? m.installPath}
                        target={manifest ? target : 'claude-code'}
                        // A member from an included group is edited in that group, not here; the editor's
                        // columns still render (empty) so the table stays aligned.
                        canEdit={group.canEdit && !nested.viaOf(m)}
                        viaOpenable={openable.has(nested.viaOf(m) ?? '')}
                        editorColumns={group.canEdit}
                        busy={busy}
                        first={i === 0}
                        last={i === list.length - 1}
                        onPin={(pinnedSeq) => void patch(m.item.id, { pinnedSeq })}
                        onInstallAs={(installAs) => patch(m.item.id, { installAs })}
                        onMove={(dir) => move(m.item.id, dir)}
                        onRemove={() => void run(() => api.removeMember(group.slug, m.item.id))}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })
      )}
    </section>
  );
}

interface MemberRowProps {
  m: api.GroupMember;
  installPath: string;
  target: api.BundleTarget;
  canEdit: boolean;
  /** The `via` group is a direct include the viewer can read, so it links; else it is named as plain text. */
  viaOpenable: boolean;
  /** The group is editable, so the "Install as" and actions columns exist (even if this row cannot use them). */
  editorColumns: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  onPin: (seq: number | null) => void;
  onInstallAs: (path: string | null) => Promise<boolean>;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

function MemberRow({ m, installPath, target, canEdit, viaOpenable, editorColumns, busy, first, last, onPin, onInstallAs, onMove, onRemove }: MemberRowProps) {
  const [versions, setVersions] = useState<number[] | null>(null);
  const [installAs, setInstallAs] = useState(m.installAs ?? '');
  useEffect(() => setInstallAs(m.installAs ?? ''), [m.installAs]);

  const label = m.item.title || m.item.name;
  const via = nested.viaOf(m);
  // Versions are sequential and immutable, so 1..latest is right until the list loads (with notes) on focus.
  const loadVersions = () => {
    if (versions === null) api.listVersions(m.item.id).then((r) => setVersions(r.versions.map((v) => v.seq)), () => {});
  };
  const seqs = versions ?? Array.from({ length: m.item.latestSeq }, (_, i) => m.item.latestSeq - i);
  const dirty = installAs.trim() !== (m.installAs ?? '');

  return (
    <tr>
      <td className="cell-main">
        <span className="row wrap">
          <Link to={`/items/${m.item.id}`} className="item-card-title">
            {label}
          </Link>
          <KindBadges item={{ ...m.item, executable: m.executable }} />
        </span>
        <span className="cell-sub">
          {m.item.owner.username}
          {via && (
            <>
              {' '}
              · via {viaOpenable ? <Link to={`/groups/${encodeURIComponent(via)}`}>{via}</Link> : <code>{via}</code>}
            </>
          )}
        </span>
      </td>
      <td>
        <code className="install-path" title={`Install path in the ${target} bundle`}>
          {installPath}
        </code>
      </td>
      <td>
        {canEdit ? (
          <select
            aria-label={`Version of ${label}`}
            value={m.pinnedSeq ?? ''}
            disabled={busy}
            onFocus={loadVersions}
            onPointerDown={loadVersions}
            onChange={(e) => onPin(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">latest (v{m.item.latestSeq})</option>
            {seqs.map((s) => (
              <option key={s} value={s}>
                pin v{s}
              </option>
            ))}
          </select>
        ) : (
          <span>
            v{m.resolvedSeq} <span className="muted">({m.pinnedSeq ? `pinned v${m.pinnedSeq}` : 'latest'})</span>
          </span>
        )}
      </td>
      {editorColumns && (
        <td>
          {canEdit && INSTALL_AS_KINDS.includes(m.item.kind) && (
            <form
              className="install-as"
              onSubmit={(e) => {
                e.preventDefault();
                void onInstallAs(installAs.trim() || null);
              }}
            >
              <input
                className="code-input"
                aria-label={`Install path override for ${label}`}
                value={installAs}
                placeholder="default path"
                spellCheck={false}
                onChange={(e) => setInstallAs(e.target.value)}
              />
              {dirty && (
                <button type="submit" className="btn btn-small" disabled={busy}>
                  Save
                </button>
              )}
            </form>
          )}
        </td>
      )}
      {editorColumns && (
        <td className="cell-actions">
          {canEdit && (
            <span className="row">
              <button type="button" className="btn btn-small" aria-label={`Move ${label} up`} disabled={busy || first} onClick={() => onMove(-1)}>
                ↑
              </button>
              <button type="button" className="btn btn-small" aria-label={`Move ${label} down`} disabled={busy || last} onClick={() => onMove(1)}>
                ↓
              </button>
              <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={onRemove}>
                Remove
              </button>
            </span>
          )}
        </td>
      )}
    </tr>
  );
}

const PICK_TABS: [api.Plane | '', string][] = [
  ['', 'All'],
  ['skill', 'Skills'],
  ['md', 'MDs'],
  ['artifact', 'Artifacts'],
];

/** A 409 path_conflict on add, shown under the item with an "Install as" retry (f1y7). */
function InstallAsRetry({ message, canRetry, busy, onRetry }: { message: string; canRetry: boolean; busy: boolean; onRetry: (installAs: string) => void }) {
  const [installAs, setInstallAs] = useState('');
  return (
    <div className="error-box" role="alert">
      <strong>{message}</strong>
      {canRetry ? (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (installAs.trim()) onRetry(installAs.trim());
          }}
        >
          <label className="field inline grow">
            <span>Install as</span>
            <input className="code-input" value={installAs} placeholder="docs/NAME.md" spellCheck={false} onChange={(e) => setInstallAs(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-small btn-primary" disabled={busy || !installAs.trim()}>
            Add at this path
          </button>
        </form>
      ) : (
        <p>This kind always installs to its own path. Set "Install as" on the member it clashes with, or remove that member.</p>
      )}
    </div>
  );
}

function AddItemsPanel({ group, onChange }: { group: api.GroupDetail; onChange: OnChange }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<{ id: string; message: string } | null>(null);
  // A failed add (e.g. a path conflict) is stale once the group changes, such as after setting "Install as".
  useEffect(() => {
    setError(null);
    setConflict(null);
  }, [group]);
  const [plane, setPlane] = useState<api.Plane | ''>('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<api.ItemSummary[] | null>(null);
  const [searchError, setSearchError] = useState<unknown>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    let live = true;
    setSearchError(null);
    api.search({ q, plane: plane || undefined, limit: 30 }).then(
      (r) => live && setResults(r.results),
      (e) => live && (setSearchError(e), setResults([])),
    );
    return () => {
      live = false;
    };
  }, [q, plane]);

  const inGroup = new Set(group.members.map((m) => m.item.id));
  const add = async (it: api.ItemSummary, installAs?: string) => {
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      onChange((await api.addMember(group.slug, { itemId: it.id, ...(installAs ? { installAs } : {}) })).group);
      toast(`Added ${it.title || it.name}.`, 'ok');
    } catch (e) {
      // A path clash stays with the item, so the retry can send installAs for it.
      if (e instanceof api.ApiError && e.code === 'path_conflict') setConflict({ id: it.id, message: e.message });
      else setError(memberError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="add-items" className="card stack" aria-labelledby="add-h">
      <header className="card-head">
        <h2 id="add-h">Add items</h2>
      </header>
      <label className="field">
        <span className="sr-only">Search items to add</span>
        <input type="search" placeholder="Search skills, MDs and artifacts…" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <Tabs tabs={PICK_TABS} value={plane} onChange={setPlane} label="Filter by plane" idPrefix="pick" panelId="pick-results" />
      <ErrorBox error={error} />
      <ErrorBox error={searchError} />
      <div id="pick-results" role="tabpanel" aria-live="polite">
        {results === null ? (
          <p className="muted" role="status">Searching…</p>
        ) : results.length === 0 ? (
          <div className="empty">
            <p>{q ? `Nothing matches "${q}".` : 'No items you can add yet.'}</p>
            <Link className="btn" to={`/items/new${plane ? `?plane=${plane}` : ''}`}>
              Create an item
            </Link>
          </div>
        ) : (
          <ul className="pick-list">
            {results.map((it) => {
              const added = inGroup.has(it.id);
              return (
                <li key={it.id} className="pick-row">
                  <div className="grow stack-tight">
                    <div className="row wrap">
                      <strong className="pick-title">{it.title || it.name}</strong>
                      <KindBadges item={it} />
                    </div>
                    <span className="muted">
                      <code>{it.name}</code> · {it.owner.username}
                    </span>
                    {it.description && <p className="clamp-2 muted">{it.description}</p>}
                    {conflict?.id === it.id && (
                      <InstallAsRetry message={conflict.message} canRetry={INSTALL_AS_KINDS.includes(it.kind)} busy={busy} onRetry={(p) => void add(it, p)} />
                    )}
                  </div>
                  <button
                    type="button"
                    className={added ? 'btn btn-small' : 'btn btn-small btn-primary'}
                    disabled={added || busy}
                    aria-label={added ? `${it.title || it.name} is already in the group` : `Add ${it.title || it.name}`}
                    onClick={() => void add(it)}
                  >
                    {added ? 'Added' : 'Add'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Included groups (58z1): their members flow into this one; readers see the ones that currently flow. */
/**
 * f9j0: the CLIs the group's skills need, with copy-paste install commands from the admin registry
 * (never from the items). The server cannot see the reader's machine, so this lists everything and
 * the check one-liner prints what is missing. Nothing renders when no member requires a CLI.
 */
function RequiresSection({ group }: { group: api.GroupDetail }) {
  const requires = (group as GroupWithRequires).requires ?? [];
  const [platform, setPlatform] = useState<Platform>(defaultPlatform);
  if (!requires.length) return null;
  const known = requires.flatMap((r) => {
    const cmd = r.tool && commandFor(r.tool.install, platform);
    return cmd ? [cmd] : [];
  });
  const bins = requires.map((r) => r.tool?.check ?? r.name);
  return (
    <section className="card stack" id="requires" aria-labelledby="requires-h">
      <header className="card-head">
        <h2 id="requires-h">Requires</h2>
      </header>
      <p className="muted">
        Command-line tools this group's skills need on your machine. SCP never runs these commands: copy them into a terminal yourself. Install
        commands come from this instance's tool registry, kept by its admins.
      </p>
      <PlatformTabs value={platform} onChange={setPlatform} idPrefix="req" panelId="requires-panel" />
      <div id="requires-panel" role="tabpanel" aria-labelledby={`req-${platform}`} className="stack">
        <ul className="stack requires-list">
          {requires.map((r) => {
            const cmd = r.tool && commandFor(r.tool.install, platform);
            return (
              <li key={r.name} className="stack">
                <p>
                  <strong>
                    {r.tool ? (
                      <Link to={`/tools#${toolAnchor(r.name)}`} title="Open its card in Tools">
                        <code>{r.name}</code>
                      </Link>
                    ) : (
                      <code>{r.name}</code>
                    )}
                  </strong>{' '}
                  <span className="muted">
                    needed by{' '}
                    {r.items.map((it, i) => (
                      <span key={it.id}>
                        {i > 0 && ', '}
                        <Link to={`/items/${it.id}`}>{it.name}</Link>
                      </span>
                    ))}
                  </span>
                  {r.tool?.homepage && (
                    <>
                      {' · '}
                      <a href={r.tool.homepage} target="_blank" rel="noreferrer noopener">
                        homepage
                      </a>
                    </>
                  )}
                </p>
                {cmd ? (
                  <CopyBlock label={`Install ${r.name} (${platformLabel(platform)})`} text={cmd} />
                ) : r.tool ? (
                  <p className="muted">No install command recorded for {platformLabel(platform)}.</p>
                ) : (
                  <p className="muted">
                    Not in this instance's tool registry, so SCP has no install command for it.
                    {r.sources?.map((s) => (
                      <span key={s}>
                        {' '}
                        Source:{' '}
                        <a href={s} target="_blank" rel="noreferrer noopener">
                          {s.replace('https://github.com/', '')}
                        </a>
                        .
                      </span>
                    ))}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {known.length > 0 && <CopyBlock label={`Install all (${platformLabel(platform)}, one command per line)`} text={known.join('\n')} />}
        <CopyBlock label={`Check what's missing (${platform === 'windows' ? 'PowerShell' : 'shell'})`} text={checkCommand(bins, platform)} />
      </div>
    </section>
  );
}

function IncludesSection({ group, onChange }: { group: api.GroupDetail; onChange: OnChange }) {
  const toast = useToast();
  const { busy, error, run } = useMutation(onChange);
  const g = group as nested.GroupDetailV2;
  const includes = g.includes ?? [];
  const includedBy = g.includedBy ?? [];
  const [text, setText] = useState('');
  const [found, setFound] = useState<api.GroupSummary[]>([]);
  const [searchError, setSearchError] = useState<unknown>(null);

  useEffect(() => {
    const q = text.trim();
    if (!q) return setFound([]);
    let live = true;
    const t = setTimeout(
      () =>
        api.listGroups({ q, limit: 20 }).then(
          (r) => live && (setFound(r.groups), setSearchError(null)),
          (e) => live && (setFound([]), setSearchError(e)),
        ),
      200,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text]);

  // PUT replaces the list, applied to the server's current one (like members).
  const reorder = (slug: string, dir: -1 | 1) =>
    run(async () => {
      const fresh = ((await api.getGroup(group.slug)).group as nested.GroupDetailV2).includes ?? [];
      const list = fresh.map((i) => i.slug);
      const i = list.indexOf(slug);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return { group };
      [list[i], list[j]] = [list[j], list[i]];
      return nested.putIncludes(group.slug, list);
    });
  const add = async (slug: string) => {
    if (await run(() => nested.addInclude(group.slug, slug))) {
      setText('');
      toast(`Included ${slug}.`, 'ok');
    }
  };

  const excluded = new Set([group.slug, ...includes.map((i) => i.slug)]);
  // The server's include rule (include_not_shareable): the owner's own groups or public ones; a group shared by name is readable, not republishable.
  const candidates = found.filter((f) => !excluded.has(f.slug) && (f.owner.id === group.owner.id || f.visibility === 'public'));

  if (!group.canEdit && includes.length === 0 && includedBy.length === 0) return null;

  return (
    <section className="card stack" aria-labelledby="includes-h">
      <header className="card-head">
        <h2 id="includes-h">Included groups ({includes.length})</h2>
      </header>
      <p className="muted">
        Everything an included group serves flows into this one (its own members and its includes, up to 4 levels), after this group's own
        members. An item already here is not repeated. You can include your own groups and public ones (not groups merely shared with you); a
        public one keeps flowing only while it stays public.
      </p>
      <ErrorBox error={error} />
      {includes.length === 0 ? (
        <p className="muted">No included groups.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Owner</th>
                <th scope="col">Members</th>
                {group.canEdit && (
                  <th scope="col" className="cell-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {includes.map((inc, i) => (
                <tr key={inc.slug}>
                  <td className="cell-main">
                    <span className="row wrap">
                      {/* No name means the viewer cannot read the group itself (it 404s for them): the slug alone, not a dead link. */}
                      {inc.name ? (
                        <Link to={`/groups/${encodeURIComponent(inc.slug)}`} className="item-card-title">
                          {inc.name}
                        </Link>
                      ) : (
                        <span className="item-card-title">{inc.slug}</span>
                      )}
                      {/* Editors keep a stale row so they can remove it; readers never see one. */}
                      {inc.flowing === false && (
                        <span className="badge badge-disabled" title="Not flowing: the group is private or shared, or its owner is disabled. Its members are not served here until it is public again.">
                          not flowing
                        </span>
                      )}
                    </span>
                    <code className="cell-sub">{inc.slug}</code>
                  </td>
                  <td>{inc.owner.username || <span className="muted">-</span>}</td>
                  <td>{inc.name ? inc.memberCount : <span className="muted">-</span>}</td>
                  {group.canEdit && (
                    <td className="cell-actions">
                      <span className="row">
                        <button type="button" className="btn btn-small" aria-label={`Move ${inc.name || inc.slug} up`} disabled={busy || i === 0} onClick={() => void reorder(inc.slug, -1)}>
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          aria-label={`Move ${inc.name || inc.slug} down`}
                          disabled={busy || i === includes.length - 1}
                          onClick={() => void reorder(inc.slug, 1)}
                        >
                          ↓
                        </button>
                        <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => void run(() => nested.removeInclude(group.slug, inc.slug))}>
                          Remove
                        </button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {group.canEdit && (
        <div className="stack-tight user-search">
          <label className="field narrow">
            <span>Include a group</span>
            <input type="search" placeholder="Search groups by name or slug…" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
          </label>
          <ErrorBox error={searchError} />
          {text.trim() && (
            <ul className="chips" aria-label="Matching groups">
              {candidates.length === 0 ? (
                <li className="muted">No other matching groups.</li>
              ) : (
                candidates.map((c) => (
                  <li key={c.slug}>
                    <button type="button" className="chip" disabled={busy} title={`${c.name} by ${c.owner.username}`} onClick={() => void add(c.slug)}>
                      + {c.slug}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
      {includedBy.length > 0 && (
        <p className="muted">
          Included by:{' '}
          {includedBy.map((r, i) => (
            <span key={r.slug}>
              {i > 0 && ', '}
              <Link to={`/groups/${encodeURIComponent(r.slug)}`}>{r.slug}</Link>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function InstructionsSection({ group, onChange }: { group: api.GroupDetail; onChange: OnChange }) {
  const toast = useToast();
  const { busy, error, run } = useMutation(onChange);
  const [text, setText] = useState(group.instructions ?? '');
  const dirty = text !== (group.instructions ?? '');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.updateGroup(group.slug, { instructions: text }))) toast('Instructions saved.', 'ok');
  };

  return (
    <section className="card stack" aria-labelledby="instr-h">
      <header className="card-head">
        <h2 id="instr-h">Instructions</h2>
      </header>
      <p className="muted">
        Markdown sent to agents in the MCP <code>initialize</code> response and included in the bundle. Say what this group is for and when to
        use which item.
      </p>
      {group.canEdit ? (
        <form className="stack" onSubmit={save}>
          <label className="field">
            <span className="sr-only">Instructions (markdown)</span>
            <textarea className="code-input" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="# How to use this group" />
          </label>
          <ErrorBox error={error} />
          <div className="row end">
            {dirty && (
              <button type="button" className="btn" onClick={() => setText(group.instructions ?? '')}>
                Discard
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save instructions'}
            </button>
          </div>
        </form>
      ) : group.instructions ? (
        <pre className="code-view">{group.instructions}</pre>
      ) : (
        <p className="muted">No instructions.</p>
      )}
    </section>
  );
}

function SharingSection({ group, onChange }: { group: api.GroupDetail; onChange: OnChange }) {
  const { busy, error, run } = useMutation(onChange);
  // Applied to the server's current list, like member changes: PATCH replaces the whole list.
  const setShared = (change: (fresh: string[]) => string[]) =>
    run(async () => api.updateGroup(group.slug, { sharedWith: change((await api.getGroup(group.slug)).group.sharedWith) }));

  return (
    <section className="card stack" aria-labelledby="share-h">
      <header className="card-head">
        <h2 id="share-h">Sharing</h2>
        <VisibilityBadge visibility={group.visibility} />
      </header>
      {group.canEdit ? (
        <fieldset className="radio-list" disabled={busy}>
          <legend className="sr-only">Visibility</legend>
          {(Object.keys(VISIBILITY_LABEL) as api.GroupVisibility[]).map((v) => (
            <label key={v} className="toggle">
              <input
                type="radio"
                name="group-visibility"
                value={v}
                checked={group.visibility === v}
                onChange={() => void run(() => api.updateGroup(group.slug, { visibility: v }))}
              />
              {VISIBILITY_LABEL[v]}
            </label>
          ))}
        </fieldset>
      ) : (
        <p>{VISIBILITY_LABEL[group.visibility]}</p>
      )}
      <p className="muted">Everyone who can see the group can read all of its members, including your private items.</p>
      {/* The server only lists sharedWith to editors, so a reader would wrongly see "Nobody yet". Editors see the
          list whatever the visibility: the names survive a switch to private or public and grant access again on
          a switch back to shared, so they must stay visible and removable. */}
      {group.canEdit && (
        <div className="stack-tight">
          <h3 className="plane-head">Shared with</h3>
          {group.visibility !== 'shared' && (
            <p className="muted">These users get access only while visibility is Shared. The list is kept for when you switch back; remove a name to stop that.</p>
          )}
          {group.sharedWith.length === 0 ? (
            <p className="muted">Nobody yet: add users below.</p>
          ) : (
            <ul className="chips" aria-label="Shared with">
              {group.sharedWith.map((u) => (
                <li key={u} className="chip user-chip">
                  {u}
                  {group.canEdit && (
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Stop sharing with ${u}`}
                      disabled={busy}
                      onClick={() => void setShared((list) => list.filter((x) => x !== u))}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {group.canEdit && (
            <UserSearch exclude={[group.owner.username, ...group.sharedWith]} disabled={busy} onPick={(u) => void setShared((list) => (list.includes(u) ? list : [...list, u]))} />
          )}
        </div>
      )}
      <ErrorBox error={error} />
    </section>
  );
}

function UserSearch({ exclude, disabled, onPick }: { exclude: string[]; disabled: boolean; onPick: (username: string) => void }) {
  const [text, setText] = useState('');
  const [users, setUsers] = useState<string[]>([]);

  useEffect(() => {
    const q = text.trim();
    if (!q) return setUsers([]);
    let live = true;
    const t = setTimeout(() => api.searchUsers(q).then((r) => live && setUsers(r.users.map((u) => u.username)), () => live && setUsers([])), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text]);

  const options = users.filter((u) => !exclude.includes(u));
  return (
    <div className="stack-tight user-search">
      <label className="field narrow">
        <span>Add a user</span>
        <input type="search" placeholder="Username…" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
      </label>
      {text.trim() && (
        <ul className="chips" aria-label="Matching users">
          {options.length === 0 ? (
            <li className="muted">No matching users.</li>
          ) : (
            options.map((u) => (
              <li key={u}>
                <button
                  type="button"
                  className="chip"
                  disabled={disabled}
                  onClick={() => {
                    onPick(u);
                    setText('');
                  }}
                >
                  + {u}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

type ConnectTab = 'claude' | 'json' | 'plugin' | 'bash' | 'ps';
const CONNECT_TABS: [ConnectTab, string][] = [
  ['claude', 'Claude Code'],
  ['json', 'MCP JSON'],
  ['plugin', 'Plugin marketplace'],
  ['bash', 'Bundle (bash)'],
  ['ps', 'Bundle (PowerShell)'],
];

function withTarget(url: string, target: api.BundleTarget): string {
  const u = new URL(url, window.location.origin);
  u.searchParams.set('target', target);
  return u.toString();
}

/** SCP's own files in every plugin.zip (server groups/bundle.ts PLUGIN_OWN). */
const PLUGIN_OWN = ['.claude-plugin/plugin.json', '.mcp.json'];

/** Whether `path` is where a member named `name` lands in the plugin layout (server groups/bundle.ts pluginPath), which a rename moves. */
const isPluginPath = (path: string, name: string) =>
  [`skills/${name}/`, `agents/${name}.md`, `commands/${name}.md`, `output-styles/${name}.md`, `hooks/${name}.json`, `mcp/${name}.json`].includes(path) ||
  (path.startsWith('docs/') && path.endsWith(`/${name}/`) && path.split('/').length === 4);

/** What to do about a download the server refuses, by the manifest's problem code (and, for a conflict, its path). */
function fixFor({ code, conflict }: Pick<api.BuildProblem, 'code' | 'conflict'>, what: 'bundle' | 'plugin'): string {
  if (code === 'path_conflict') {
    if (what === 'bundle') return 'Set "Install as" on one of the two members, or remove one.';
    // mc52: a server name, SCP's own file or a hook's or MCP server's stored file stays whatever the item is named.
    if (conflict?.path.startsWith('mcpServers:')) {
      return `Change the server name '${decodeURIComponent(conflict.path.slice('mcpServers:'.length))}' in one member's .mcp.json, or remove one of them; renaming the item does not change it.`;
    }
    if (conflict?.path.startsWith('outputStyle:')) {
      return `Two output styles are named '${decodeURIComponent(conflict.path.slice('outputStyle:'.length))}' in Claude Code: change the frontmatter name of one, or remove one of them.`;
    }
    if (conflict && PLUGIN_OWN.includes(conflict.path)) return `SCP writes ${conflict.path} itself: move or remove that file in the hook or MCP server item that stores it.`;
    // Not two same-named members at their plugin path: a hook's or MCP server's stored file.
    if (conflict && !(conflict.items.length === 1 && isPluginPath(conflict.path, conflict.items[0]))) {
      return `A hook or MCP server keeps its files at their stored paths whatever it is named: move ${conflict.path} in one of the items, or remove one.`;
    }
    return 'The plugin layout has no "Install as" override, so remove or rename one of the two before this group can be a plugin.';
  }
  if (code === 'bundle_too_large') return 'Remove members or pin smaller versions until the group is under 100 MB.';
  return 'Remove members or pin smaller versions until the group holds fewer files.';
}

/** A download the server would refuse (409/413/400 JSON, which the browser's download shelf shows as a bare "Failed"): the reason as visible text, reachable without hover or focus. */
function DisabledDownload({ id, label, problem }: { id: string; label: string; problem: string | null }) {
  return (
    <span className="row">
      <button type="button" className="btn" disabled aria-describedby={id}>
        {label}
      </button>
      <span id={id} className="muted">
        Cannot be built: {problem}
      </span>
    </span>
  );
}

/** What each flagged kind does there (server groups/bundle.ts executableOf). */
const FLAGGED: Partial<Record<api.Kind, string>> = {
  hook: 'hooks',
  'mcp-server': 'MCP servers',
  skill: 'skills that run commands',
  command: 'commands that run commands',
  'output-style': "an output style that replaces the user's own",
};

/** mc52: above the install options whenever a member would act on the installing machine as part of the group's plugin. */
function ExecutableBanner({ flag }: { flag: api.ExecutableFlag }) {
  const what = flag.kinds.map((k) => FLAGGED[k] ?? k).join(', ');
  return (
    <div className="error-box" role="note">
      <strong>This group runs code on the machine that installs it</strong>
      <p>
        Installed as a Claude Code plugin (Plugin marketplace, plugin.zip), it acts there without asking ({what}):{' '}
        {(flag.items ?? []).map((i, n) => (
          <span key={i.id}>
            {n > 0 && ', '}
            <Link to={`/items/${i.id}`}>{i.name}</Link>
          </span>
        ))}
        . A bundle carries hooks and MCP servers only as inert copies. Install the plugin only if you trust what these items run.
      </p>
    </div>
  );
}

function ConnectSection({
  group,
  manifest,
  manifestError,
  target,
  setTarget,
}: {
  group: api.GroupDetail;
  manifest: api.Manifest | null;
  manifestError: unknown;
  target: api.BundleTarget;
  setTarget: (t: api.BundleTarget) => void;
}) {
  const { config } = useAuth();
  // The pasted key is the viewer's, so the marketplace is theirs: scp-<viewer>, whoever owns the group.
  const user = useUser();
  const [tab, setTab] = useState<ConnectTab>('claude');
  const [catalog, setCatalog] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);

  const publicUrl = (config?.publicUrl ?? window.location.origin).replace(/\/$/, '');
  const slug = group.slug;
  const name = `scp-${slug}`;
  const mcpUrl = group.endpoints?.mcp || `${publicUrl}/mcp/${slug}`;
  const bundle = withTarget(group.endpoints?.bundle || `${publicUrl}/api/v1/groups/${slug}/bundle.zip`, target);
  const zip = `${name}.zip`;
  // marketplace.json lists the key owner's own groups and the ones shared with them by name; Claude Code resolves
  // <slug>@<marketplace> against that list, so another user's public group installs from its plugin.zip only. An
  // admin reads every shared group, so for them it is listed only when they are named on it (sharedWith is filled for editors).
  const listed = group.owner.id === user.id || (group.visibility === 'shared' && (!user.isAdmin || group.sharedWith.includes(user.username)));
  const pluginZip = `${publicUrl}/m/<YOUR_KEY>/${slug}/plugin.zip`;
  // The manifest and every download share one member walk, so a manifest refused as group_full means
  // bundle.zip, plugin.zip and the snippets fail the same way: the reason gates them all.
  const blocked = manifestError instanceof api.ApiError && manifestError.code === 'group_full' ? { problem: manifestError.message, code: manifestError.code } : null;
  const pluginProblem = blocked ?? (manifest?.plugin && !manifest.plugin.ok ? manifest.plugin : null);
  const bundleProblem = blocked ?? (manifest?.bundle && !manifest.bundle.ok ? manifest.bundle : null);
  const bundleHint = (ok: string) => (bundleProblem ? `bundle.zip cannot be built: ${bundleProblem.problem}. ${fixFor(bundleProblem, 'bundle')}` : ok);

  const snippet: Record<ConnectTab, string> = {
    claude: `claude mcp add --transport http ${name} ${mcpUrl} --header "Authorization: Bearer <YOUR_KEY>"`,
    json: JSON.stringify({ mcpServers: { [name]: { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer <YOUR_KEY>' } } } }, null, 2),
    plugin: listed
      ? `claude plugin marketplace add ${publicUrl}/m/<YOUR_KEY>/marketplace.json\nclaude plugin install ${slug}@scp-${user.username}`
      : `curl -fsSL "${pluginZip}" -o ${slug}-plugin.zip`,
    bash: `curl -fsSL -H "Authorization: Bearer $SCP_KEY" "${bundle}" -o ${zip} && unzip -o ${zip}`,
    ps: `Invoke-WebRequest -Headers @{Authorization="Bearer $env:SCP_KEY"} -Uri "${bundle}" -OutFile ${zip}; Expand-Archive -Force ${zip} .`,
  };
  const hint: Record<ConnectTab, string> = {
    claude: 'Run in a terminal; replace <YOUR_KEY> with an API key.',
    json: 'Add to .mcp.json (or your client\'s MCP config); replace <YOUR_KEY> with an API key.',
    plugin: pluginProblem
      ? `Not in the marketplace: ${pluginProblem.problem}. ${fixFor(pluginProblem, 'plugin')}`
      : listed
        ? `Your groups and the ones shared with you by name become plugins (skills, agents, commands, output styles, hooks and MCP servers, plus this group's MCP server), in a marketplace named after the key's owner, scp-${user.username}. Claude Code only installs archives over https, so a localhost SCP needs the plugin.zip download below instead.`
        : `Another user's public group is not listed in your marketplace (anyone can create any number of them), so claude plugin install cannot find it by name: download its plugin.zip with your key and unpack it where Claude Code loads plugins from.`,
    bash: bundleHint('Export SCP_KEY first, then run from the project root.'),
    ps: bundleHint('Set $env:SCP_KEY first, then run from the project root.'),
  };

  // Fetched on open and again whenever the group changes (members, pins, details) while open.
  const [catalogOpen, setCatalogOpen] = useState(false);
  useEffect(() => {
    if (!catalogOpen) return;
    let live = true;
    api.getCatalog(slug).then(
      (c) => live && (setCatalog(c), setCatalogError(null)),
      (e) => live && (setCatalog(null), setCatalogError(e)),
    );
    return () => {
      live = false;
    };
  }, [catalogOpen, slug, group.updatedAt]);

  return (
    <section id="connect" className="card stack" aria-labelledby="connect-h">
      <header className="card-head">
        <h2 id="connect-h">Connect</h2>
        <Link className="btn btn-small" to={`/keys?group=${encodeURIComponent(slug)}`}>
          New key for this group
        </Link>
      </header>
      {group.executable && <ExecutableBanner flag={group.executable} />}
      {!!manifest?.withheld?.length && (
        <p className="muted" role="note">
          Not served here, as they run code that another owner added to a group this one includes:{' '}
          {manifest.withheld.map((w, n) => (
            <span key={w.id}>
              {n > 0 && ', '}
              <Link to={`/items/${w.id}`}>{w.name}</Link> (in {w.via})
            </span>
          ))}
          . Add one to this group directly to serve it.
        </p>
      )}
      <p className="muted">
        Agents use this group as an MCP server or as a bundle installed into a project. Both need an API key:{' '}
        <Link to={`/keys?group=${encodeURIComponent(slug)}`}>create a key restricted to this group</Link>.
      </p>
      <Tabs tabs={CONNECT_TABS} value={tab} onChange={setTab} label="Connection method" idPrefix="ctab" panelId="connect-panel" />
      <div id="connect-panel" role="tabpanel" aria-labelledby={`ctab-${tab}`} className="stack">
        <p className="muted">{hint[tab]}</p>
        <CopyBlock label={CONNECT_TABS.find(([t]) => t === tab)![1]} text={snippet[tab]} />
      </div>
      <div className="row wrap">
        <label className="field inline">
          <span>Bundle target</span>
          <select value={target} onChange={(e) => setTarget(e.target.value as api.BundleTarget)}>
            {TARGETS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {bundleProblem ? (
          <DisabledDownload id="bundle-problem" label="Download bundle" problem={bundleProblem.problem} />
        ) : (
          <a className="btn" href={api.bundleUrl(slug, target)} download={zip}>
            Download bundle
          </a>
        )}
        {pluginProblem ? (
          <DisabledDownload id="plugin-problem" label="Download plugin.zip" problem={pluginProblem.problem} />
        ) : (
          <a className="btn" href={nested.pluginZipUrl(slug)} download={`${slug}-plugin.zip`} title="Claude Code plugin layout; .mcp.json carries a <YOUR_KEY> placeholder">
            Download plugin.zip
          </a>
        )}
      </div>
      <details className="disclosure">
        <summary>Manifest</summary>
        {manifest ? (
          <pre className="code-view">{JSON.stringify(manifest, null, 2)}</pre>
        ) : manifestError ? (
          <ErrorBox error={manifestError} />
        ) : (
          <p className="muted" role="status">Loading…</p>
        )}
      </details>
      <details className="disclosure" onToggle={(e) => setCatalogOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Catalog (catalog.md)</summary>
        {catalog !== null ? <pre className="code-view">{catalog}</pre> : catalogError ? <ErrorBox error={catalogError} /> : <p className="muted" role="status">Loading…</p>}
      </details>
    </section>
  );
}
