import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import * as api from '../api.ts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { Modal } from '../components/Modal.tsx';
import { timeAgo } from '../format.ts';
import { slug as toSlug } from '../templates.ts';

export const VISIBILITY_LABEL: Record<api.GroupVisibility, string> = {
  private: 'Private',
  shared: 'Shared with users',
  public: 'Public to all signed-in users',
};

export function VisibilityBadge({ visibility }: { visibility: api.GroupVisibility }) {
  return <span className={`badge badge-${visibility}`}>{visibility}</span>;
}

export function PlaneCounts({ counts }: { counts: api.GroupSummary['counts'] }) {
  return (
    <span className="muted">
      {counts.skill} skill{counts.skill === 1 ? '' : 's'} · {counts.md} MD{counts.md === 1 ? '' : 's'} · {counts.artifact} artifact
      {counts.artifact === 1 ? '' : 's'}
    </span>
  );
}

export function GroupsPage() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<api.GroupSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    let live = true;
    setError(null);
    api.listGroups({ q: q || undefined, limit: 200 }).then(
      (r) => live && (setGroups(r.groups), setTotal(r.total)),
      (e) => live && (setError(e), setGroups([])),
    );
    return () => {
      live = false;
    };
  }, [q]);

  return (
    <div className="page">
      <header className="page-head">
        <div className="stack-tight">
          <h1>Groups</h1>
          <p className="muted">A group bundles skills, MDs and artifacts into one MCP server and one installable bundle.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setNewOpen(true)}>
          New group
        </button>
      </header>

      <label className="field">
        <span className="sr-only">Search groups</span>
        <input type="search" placeholder="Search groups…" value={text} onChange={(e) => setText(e.target.value)} />
      </label>

      <ErrorBox error={error} />
      {groups === null ? (
        <p className="muted" role="status">Loading…</p>
      ) : groups.length === 0 ? (
        <div className="empty">
          {q ? (
            <p>No groups match "{q}".</p>
          ) : (
            <>
              <p>No groups yet. Create one, add items to it, then connect an agent.</p>
              <button type="button" className="btn btn-primary" onClick={() => setNewOpen(true)}>
                Create a group
              </button>
            </>
          )}
        </div>
      ) : (
        <ul className="item-grid">
          {groups.map((gr) => (
            <li key={gr.id} className="card item-card">
              <div className="item-card-head">
                <Link to={`/groups/${encodeURIComponent(gr.slug)}`} className="item-card-title">
                  {gr.name}
                </Link>
                <VisibilityBadge visibility={gr.visibility} />
              </div>
              <code className="muted">{gr.slug}</code>
              {gr.description && <p className="clamp-2">{gr.description}</p>}
              <PlaneCounts counts={gr.counts} />
              <p className="item-card-meta muted">
                {gr.owner.username} · updated <time dateTime={gr.updatedAt}>{timeAgo(gr.updatedAt)}</time>
              </p>
            </li>
          ))}
        </ul>
      )}
      {groups && total > groups.length && (
        <p className="muted">
          Showing {groups.length} of {total} groups, yours first. Search to narrow the list.
        </p>
      )}
      <Modal open={newOpen} title="New group" onClose={() => setNewOpen(false)}>
        <NewGroupForm onCancel={() => setNewOpen(false)} />
      </Modal>
    </div>
  );
}

function NewGroupForm({ onCancel }: { onCancel: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<api.GroupVisibility>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const effectiveSlug = slugEdited ? slug : toSlug(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createGroup({ slug: effectiveSlug, name: name.trim(), description: description.trim() || undefined, visibility });
      nav(`/groups/${encodeURIComponent(r.group.slug)}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Slug</span>
        <input
          required
          className="code-input"
          value={effectiveSlug}
          spellCheck={false}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value.toLowerCase());
          }}
        />
        <small className="muted">
          Used in URLs: <code>/mcp/{effectiveSlug || '<slug>'}</code>. Cannot be changed later.
        </small>
      </label>
      <label className="field">
        <span>Description</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">
        <span>Visibility</span>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as api.GroupVisibility)}>
          {(Object.keys(VISIBILITY_LABEL) as api.GroupVisibility[]).map((v) => (
            <option key={v} value={v}>
              {VISIBILITY_LABEL[v]}
            </option>
          ))}
        </select>
      </label>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !effectiveSlug || !name.trim()}>
          {busy ? 'Creating…' : 'Create group'}
        </button>
      </div>
    </form>
  );
}
