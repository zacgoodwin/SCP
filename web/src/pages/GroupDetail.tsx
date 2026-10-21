import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import * as api from '../api.ts';
import { useAuth } from '../auth.tsx';
import { CopyBlock } from '../components/CopyBlock.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { KindBadges } from '../components/ItemCard.tsx';
import { Modal } from '../components/Modal.tsx';
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
        <div className="stack-tight grow">
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
        <div className="row wrap">
          {group.canEdit && (
            <button type="button" className="btn" onClick={() => setEditOpen(true)}>
              Edit details
            </button>
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
      <InstructionsSection key={`i:${group.instructions ?? ''}`} group={group} onChange={onChange} />
      <SharingSection group={group} onChange={onChange} />
      <ConnectSection group={group} manifest={manifest} manifestError={manifestError} target={target} setTarget={setTarget} />

      {group.canEdit && (
        <section className="card stack danger-zone" aria-labelledby="danger-h">
          <h2 id="danger-h">Delete group</h2>
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
  // PUT replaces every member, so each change is applied to the server's current list, not this
  // page's copy: one an agent (create_artifact) or another tab added since the page loaded would
  // silently leave the group. change returns null when there is nothing to do on the fresh list.
  const put = (change: (fresh: api.GroupMember[]) => api.GroupMember[] | null) =>
    run(async () => {
      const fresh = (await api.getGroup(group.slug)).group;
      const next = change(fresh.members);
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
      <h2 id="members-h">Members ({members.length})</h2>
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
          <p>Two members install to the same path, so the bundle would overwrite one with the other. Set "Install as" on one, or remove it.</p>
        </div>
      )}
      <ErrorBox error={error} />
      {members.length === 0 ? (
        <div className="empty">
          <p>No members yet.</p>
          {group.canEdit ? (
            <a className="btn" href="#add-items">
              Add skills, MDs and artifacts
            </a>
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
              <ul className="member-list">
                {list.map((m, i) => (
                  <MemberRow
                    key={m.item.id}
                    m={m}
                    // The path for the bundle target picked below, so rows match the conflict banner.
                    installPath={manifest?.items.find((x) => x.id === m.item.id)?.installPath ?? m.installPath}
                    target={manifest ? target : 'claude-code'}
                    canEdit={group.canEdit}
                    busy={busy}
                    first={i === 0}
                    last={i === list.length - 1}
                    onPin={(pinnedSeq) => void patch(m.item.id, { pinnedSeq })}
                    onInstallAs={(installAs) => patch(m.item.id, { installAs })}
                    onMove={(dir) => move(m.item.id, dir)}
                    onRemove={() => void run(() => api.removeMember(group.slug, m.item.id))}
                  />
                ))}
              </ul>
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
  busy: boolean;
  first: boolean;
  last: boolean;
  onPin: (seq: number | null) => void;
  onInstallAs: (path: string | null) => Promise<boolean>;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

function MemberRow({ m, installPath, target, canEdit, busy, first, last, onPin, onInstallAs, onMove, onRemove }: MemberRowProps) {
  const [versions, setVersions] = useState<number[] | null>(null);
  const [installAs, setInstallAs] = useState(m.installAs ?? '');
  useEffect(() => setInstallAs(m.installAs ?? ''), [m.installAs]);

  const label = m.item.title || m.item.name;
  // Versions are sequential and immutable, so 1..latest is right until the list loads (with notes) on focus.
  const loadVersions = () => {
    if (versions === null) api.listVersions(m.item.id).then((r) => setVersions(r.versions.map((v) => v.seq)), () => {});
  };
  const seqs = versions ?? Array.from({ length: m.item.latestSeq }, (_, i) => m.item.latestSeq - i);
  const dirty = installAs.trim() !== (m.installAs ?? '');

  return (
    <li className="member-row">
      <div className="member-main">
        <div className="row wrap">
          <Link to={`/items/${m.item.id}`} className="item-card-title">
            {label}
          </Link>
          <KindBadges item={m.item} />
        </div>
        <code className="install-path" title={`Install path in the ${target} bundle`}>
          {installPath}
        </code>
        <span className="muted">
          v{m.resolvedSeq} · {m.pinnedSeq ? `pinned v${m.pinnedSeq}` : 'latest'} · {m.item.owner.username}
        </span>
      </div>
      {canEdit && (
        <div className="member-controls">
          <label className="field inline">
            <span>Version</span>
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
          </label>
          {INSTALL_AS_KINDS.includes(m.item.kind) && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void onInstallAs(installAs.trim() || null);
              }}
            >
              <label className="field inline grow">
                <span>Install as</span>
                <input
                  className="code-input"
                  aria-label={`Install path override for ${label}`}
                  value={installAs}
                  placeholder="default path"
                  spellCheck={false}
                  onChange={(e) => setInstallAs(e.target.value)}
                />
              </label>
              {dirty && (
                <button type="submit" className="btn btn-small" disabled={busy}>
                  Save
                </button>
              )}
            </form>
          )}
          <div className="row">
            <button type="button" className="btn btn-small" aria-label={`Move ${label} up`} disabled={busy || first} onClick={() => onMove(-1)}>
              ↑
            </button>
            <button type="button" className="btn btn-small" aria-label={`Move ${label} down`} disabled={busy || last} onClick={() => onMove(1)}>
              ↓
            </button>
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

const PICK_TABS: [api.Plane | '', string][] = [
  ['', 'All'],
  ['skill', 'Skills'],
  ['md', 'MDs'],
  ['artifact', 'Artifacts'],
];

function AddItemsPanel({ group, onChange }: { group: api.GroupDetail; onChange: OnChange }) {
  const toast = useToast();
  const { busy, error, run, reset } = useMutation(onChange, memberError);
  // A failed add (e.g. a path conflict) is stale once the group changes, such as after setting "Install as".
  useEffect(reset, [group]);
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
  const add = async (it: api.ItemSummary) => {
    if (await run(() => api.addMember(group.slug, { itemId: it.id }))) toast(`Added ${it.title || it.name}.`, 'ok');
  };

  return (
    <section id="add-items" className="card stack" aria-labelledby="add-h">
      <h2 id="add-h">Add items</h2>
      <label className="field">
        <span className="sr-only">Search items to add</span>
        <input type="search" placeholder="Search skills, MDs and artifacts…" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="tabs" role="tablist" aria-label="Filter by plane">
        {PICK_TABS.map(([p, label]) => (
          <button key={p || 'all'} type="button" role="tab" className="tab" aria-selected={plane === p} aria-controls="pick-results" onClick={() => setPlane(p)}>
            {label}
          </button>
        ))}
      </div>
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
      <h2 id="instr-h">Instructions</h2>
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
      <h2 id="share-h">Sharing</h2>
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
      {/* The server only lists sharedWith to editors, so a reader would wrongly see "Nobody yet". */}
      {group.visibility === 'shared' && group.canEdit && (
        <div className="stack-tight">
          <h3 className="plane-head">Shared with</h3>
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

type ConnectTab = 'claude' | 'json' | 'bash' | 'ps';
const CONNECT_TABS: [ConnectTab, string][] = [
  ['claude', 'Claude Code'],
  ['json', 'MCP JSON'],
  ['bash', 'Bundle (bash)'],
  ['ps', 'Bundle (PowerShell)'],
];

function withTarget(url: string, target: api.BundleTarget): string {
  const u = new URL(url, window.location.origin);
  u.searchParams.set('target', target);
  return u.toString();
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
  const [tab, setTab] = useState<ConnectTab>('claude');
  const [catalog, setCatalog] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);

  const publicUrl = (config?.publicUrl ?? window.location.origin).replace(/\/$/, '');
  const slug = group.slug;
  const name = `scp-${slug}`;
  const mcpUrl = group.endpoints?.mcp || `${publicUrl}/mcp/${slug}`;
  const bundle = withTarget(group.endpoints?.bundle || `${publicUrl}/api/v1/groups/${slug}/bundle.zip`, target);
  const zip = `${name}.zip`;

  const snippet: Record<ConnectTab, string> = {
    claude: `claude mcp add --transport http ${name} ${mcpUrl} --header "Authorization: Bearer <YOUR_KEY>"`,
    json: JSON.stringify({ mcpServers: { [name]: { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer <YOUR_KEY>' } } } }, null, 2),
    bash: `curl -fsSL -H "Authorization: Bearer $SCP_KEY" "${bundle}" -o ${zip} && unzip -o ${zip}`,
    ps: `Invoke-WebRequest -Headers @{Authorization="Bearer $env:SCP_KEY"} -Uri "${bundle}" -OutFile ${zip}; Expand-Archive -Force ${zip} .`,
  };
  const hint: Record<ConnectTab, string> = {
    claude: 'Run in a terminal; replace <YOUR_KEY> with an API key.',
    json: 'Add to .mcp.json (or your client\'s MCP config); replace <YOUR_KEY> with an API key.',
    bash: 'Export SCP_KEY first, then run from the project root.',
    ps: 'Set $env:SCP_KEY first, then run from the project root.',
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
      <h2 id="connect-h">Connect</h2>
      <p className="muted">
        Agents use this group as an MCP server or as a bundle installed into a project. Both need an API key:{' '}
        <Link to={`/keys?group=${encodeURIComponent(slug)}`}>create a key restricted to this group</Link>.
      </p>
      <div className="tabs" role="tablist" aria-label="Connection method">
        {CONNECT_TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" id={`ctab-${t}`} className="tab" aria-selected={tab === t} aria-controls="connect-panel" onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
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
        <a className="btn" href={api.bundleUrl(slug, target)} download={zip}>
          Download bundle
        </a>
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
