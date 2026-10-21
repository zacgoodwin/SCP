import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import * as api from '../api.ts';
import * as imp from '../api-import.ts';
import { ErrorBox } from './ErrorBox.tsx';
import { KindBadges } from './ItemCard.tsx';
import { Modal } from './Modal.tsx';
import { Tabs } from './Tabs.tsx';

// Every extension the server's importUpload takes (items/import.ts).
const ACCEPT = '.md,.markdown,.zip,.skill,.html,.htm,.svg,.mmd,.jsx,.tsx';
const ALL_KINDS = Object.values(api.KINDS_BY_PLANE).flat();

type Tab = 'file' | 'pack' | 'github';
const TABS: [Tab, string][] = [
  ['file', 'File'],
  ['pack', 'Zip pack'],
  ['github', 'GitHub'],
];

/** The API error with the statuses that read badly (404 route, 413, bad_source) spelled out; details kept for ErrorBox. */
const friendly = (e: unknown) => (e instanceof api.ApiError ? new api.ApiError(e.status, e.code, imp.importErrorMessage(e), e.details) : e);

export function ImportDialog({
  open,
  onClose,
  onImported,
  plane,
}: {
  open: boolean;
  onClose: () => void;
  /** A pack or GitHub import finished (whatever it wrote): the page behind reloads what it lists. */
  onImported?: (r: imp.ImportResult) => void;
  plane?: api.Plane;
}) {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('file');
  const [result, setResult] = useState<imp.ImportResult | null>(null);

  const close = () => {
    setResult(null);
    onClose();
  };
  // Per docs/PLAN-v2.md D6: a created group wins, else the single item, else the list. Anything skipped
  // shows the list first (it links to the group), or the skip reasons would be lost.
  const done = (r: imp.ImportResult) => {
    onImported?.(r);
    if (r.group && r.items.length > 0 && r.skipped.length === 0) {
      close();
      nav(`/groups/${encodeURIComponent(r.group.slug)}`);
    } else if (r.items.length === 1 && r.skipped.length === 0) {
      close();
      nav(`/items/${r.items[0].id}`);
    } else setResult(r);
  };
  // An artifact is one file with a format; a pack or repository tree cannot become one (the server refuses kind: artifact).
  const tabs = plane === 'artifact' ? TABS.filter(([t]) => t === 'file') : TABS;

  return (
    <Modal open={open} title="Import" onClose={close}>
      {result ? (
        <ImportResultView result={result} onClose={close} />
      ) : (
        <div className="stack">
          <Tabs tabs={tabs} value={tab} onChange={setTab} label="Import source" idPrefix="itab" panelId="import-panel" />
          <div id="import-panel" role="tabpanel" aria-labelledby={`itab-${tab}`}>
            {tab === 'file' ? (
              <FileForm plane={plane} onCancel={close} />
            ) : tab === 'pack' ? (
              <PackForm onCancel={close} onDone={done} />
            ) : (
              <GithubForm plane={plane} onCancel={close} onDone={done} />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Wraps a submit handler: busy flag, error capture (friendly message), always resets busy. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function Actions({ busy, label, disabled, onCancel }: { busy: boolean; label: string; disabled: boolean; onCancel: () => void }) {
  return (
    <div className="row end">
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className="btn btn-primary" disabled={disabled || busy}>
        {busy ? 'Importing…' : label}
      </button>
    </div>
  );
}

function KindSelect({ value, kinds, onChange }: { value: api.Kind | ''; kinds: api.Kind[]; onChange: (k: api.Kind | '') => void }) {
  return (
    <label className="field">
      <span>Kind</span>
      <select value={value} onChange={(e) => onChange(e.target.value as api.Kind | '')}>
        <option value="">Detect automatically</option>
        {kinds.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </label>
  );
}

function VisibilitySelect({ value, onChange }: { value: api.Visibility; onChange: (v: api.Visibility) => void }) {
  return (
    <label className="field">
      <span>Visibility</span>
      <select value={value} onChange={(e) => onChange(e.target.value as api.Visibility)}>
        <option value="private">private</option>
        <option value="public">public</option>
      </select>
    </label>
  );
}

/** Optional "also create group <slug>" for pack and GitHub imports. */
function GroupFields({ group, groupName, onGroup, onGroupName }: { group: string; groupName: string; onGroup: (s: string) => void; onGroupName: (s: string) => void }) {
  return (
    <>
      <label className="field">
        <span>Also create a group (optional)</span>
        <input className="code-input" value={group} spellCheck={false} placeholder="group-slug" onChange={(e) => onGroup(e.target.value.toLowerCase())} />
        <small className="muted">Every imported item becomes a member. Leave empty to import the items on their own.</small>
      </label>
      {group.trim() && (
        <label className="field">
          <span>Group name</span>
          <input value={groupName} placeholder="Defaults to the repo or zip name" onChange={(e) => onGroupName(e.target.value)} />
        </label>
      )}
    </>
  );
}

function FileForm({ plane, onCancel }: { plane?: api.Plane; onCancel: () => void }) {
  const nav = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const kinds = plane ? api.KINDS_BY_PLANE[plane] : ALL_KINDS;
  // A one-kind plane (Skills, Artifacts) imports as that kind: detection never yields 'artifact' for
  // a .md, which would land an Artifacts-page import in Prompts & MDs.
  const [kind, setKind] = useState<api.Kind | ''>(kinds.length === 1 ? kinds[0] : '');
  const [visibility, setVisibility] = useState<api.Visibility>('private');
  const { busy, error, submit } = useSubmit();

  const go = submit(async () => {
    if (!file) return;
    const { item } = await api.importItem(file, { kind: kind || undefined, visibility });
    onCancel();
    nav(`/items/${item.id}`);
  });

  return (
    <form className="stack" onSubmit={go}>
      <label className="field">
        <span>File</span>
        <input type="file" accept={ACCEPT} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <small className="muted">A .md file, a skill folder as .zip or .skill, or an artifact (.html, .md, .svg, .mmd, .jsx, .tsx).</small>
      </label>
      <KindSelect value={kind} kinds={kinds} onChange={setKind} />
      <VisibilitySelect value={visibility} onChange={setVisibility} />
      <ErrorBox error={error} />
      <Actions busy={busy} label="Import" disabled={!file} onCancel={onCancel} />
    </form>
  );
}

function PackForm({ onCancel, onDone }: { onCancel: () => void; onDone: (r: imp.ImportResult) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [visibility, setVisibility] = useState<api.Visibility>('private');
  const [group, setGroup] = useState('');
  const [groupName, setGroupName] = useState('');
  const { busy, error, submit } = useSubmit();

  const go = submit(async () => {
    if (!file) return;
    onDone(await imp.importOrSkipped(imp.importPack(file, { visibility, group: group.trim() || undefined, groupName: groupName.trim() || undefined })));
  });

  return (
    <form className="stack" onSubmit={go}>
      <label className="field">
        <span>Zip pack</span>
        <input type="file" accept=".zip" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <small className="muted">
          A zip holding many skills, agents, commands or MDs (a Claude Code plugin, a <code>.claude/</code> folder, <code>skills/*/SKILL.md</code>, or loose .md
          files). Each unit becomes one item, held to the per-version limits (1000 files, 30 MB); the upload may be 35 MB (zip and form fields together), the archive 20,000 files and
          64 MB unpacked. Re-uploading a zip under the same file name updates the items it created; a renamed file is treated as a new pack.
        </small>
      </label>
      <VisibilitySelect value={visibility} onChange={setVisibility} />
      <GroupFields group={group} groupName={groupName} onGroup={setGroup} onGroupName={setGroupName} />
      <ErrorBox error={error} />
      <Actions busy={busy} label="Import pack" disabled={!file} onCancel={onCancel} />
    </form>
  );
}

function GithubForm({ plane, onCancel, onDone }: { plane?: api.Plane; onCancel: () => void; onDone: (r: imp.ImportResult) => void }) {
  const [url, setUrl] = useState('');
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [path, setPath] = useState('');
  // No artifact: a tree has no format, so the server refuses kind: artifact for a repository.
  const kinds = (plane ? api.KINDS_BY_PLANE[plane] : ALL_KINDS).filter((k) => k !== 'artifact');
  const [kind, setKind] = useState<api.Kind | ''>('');
  const [visibility, setVisibility] = useState<api.Visibility>('private');
  const [group, setGroup] = useState('');
  const [groupName, setGroupName] = useState('');
  const { busy, error, submit } = useSubmit();

  const byUrl = url.trim() !== '';
  const ready = byUrl || repo.trim() !== '';

  const go = submit(async () => {
    const where: imp.GithubImport = byUrl ? { url: url.trim() } : { repo: repo.trim(), ref: ref.trim() || undefined, path: path.trim() || undefined };
    onDone(
      await imp.importOrSkipped(
        imp.importGithub({
          ...where,
          kind: kind || undefined,
          visibility,
          group: group.trim() || undefined,
          groupName: groupName.trim() || undefined,
        }),
      ),
    );
  });

  return (
    <form className="stack" onSubmit={go}>
      <label className="field">
        <span>GitHub URL</span>
        <input
          type="url"
          value={url}
          spellCheck={false}
          placeholder="https://github.com/owner/repo/tree/main/skills"
          onChange={(e) => setUrl(e.target.value)}
        />
        <small className="muted">
          A repo, a <code>/tree/&lt;ref&gt;/&lt;path&gt;</code> folder, or a <code>/blob/…/SKILL.md</code> file (its folder is imported). Or fill in the fields below.
        </small>
      </label>
      <div className="form-grid">
        <label className="field">
          <span>owner/repo</span>
          <input className="code-input" value={repo} spellCheck={false} placeholder="owner/repo" disabled={byUrl} onChange={(e) => setRepo(e.target.value)} />
        </label>
        <label className="field">
          <span>Ref</span>
          <input className="code-input" value={ref} spellCheck={false} placeholder="default branch" disabled={byUrl} onChange={(e) => setRef(e.target.value)} />
        </label>
        <label className="field span-2">
          <span>Path</span>
          <input className="code-input" value={path} spellCheck={false} placeholder="repo root" disabled={byUrl} onChange={(e) => setPath(e.target.value)} />
        </label>
      </div>
      {/* The server's `kind` means "this whole tree is one item", not a hint for detection. */}
      <label className="field">
        <span>Import the whole folder as one item</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as api.Kind | '')}>
          <option value="">No, detect every skill, agent, command, prompt and MD in it</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              Yes, as one {k}
            </option>
          ))}
        </select>
        <small className="muted">Picking a kind turns unit detection off: the tree becomes a single item (a bare skill folder, a package). A repo of many units needs detection.</small>
      </label>
      <VisibilitySelect value={visibility} onChange={setVisibility} />
      <GroupFields group={group} groupName={groupName} onGroup={setGroup} onGroupName={setGroupName} />
      <p className="muted">Fetched through the GitHub API at the ref's current commit, which is pinned on every item for update checks.</p>
      <ErrorBox error={error} />
      <Actions busy={busy} label="Import from GitHub" disabled={!ready} onCancel={onCancel} />
    </form>
  );
}

const OP_LABEL: Record<imp.ImportOp, string> = { create: 'created', version: 'updated', unchanged: 'unchanged' };

/** "Created 1, updated 1, unchanged 2" (ops the server reports), else the plain count. */
function opSummary(items: imp.ImportResult['items']): string {
  const n = (op: imp.ImportOp) => items.filter((it) => it.op === op).length;
  if (!items.some((it) => it.op)) return `Imported ${items.length} item${items.length === 1 ? '' : 's'}`;
  const parts = (['create', 'version', 'unchanged'] as imp.ImportOp[]).filter((op) => n(op) > 0).map((op) => `${OP_LABEL[op]} ${n(op)}`);
  return parts.join(', ').replace(/^./, (c) => c.toUpperCase());
}

/** Pack/GitHub outcome when there is no single place to go: the items (as links), the group when one was created, and what was skipped. */
function ImportResultView({ result, onClose }: { result: imp.ImportResult; onClose: () => void }) {
  const { items, skipped, source, group } = result;
  return (
    <div className="stack">
      <p>
        {opSummary(items)}
        {source?.repo && (
          <>
            {' '}
            from <code>{source.repo}</code>
            {source.commit && <code className="muted">@{source.commit.slice(0, 7)}</code>}
          </>
        )}
        {skipped.length > 0 && `, skipped ${skipped.length}`}.
      </p>
      {group && (
        <p>
          Group{' '}
          <Link to={`/groups/${encodeURIComponent(group.slug)}`} onClick={onClose}>
            {group.name}
          </Link>{' '}
          (<code>{group.slug}</code>) was created with the imported items as members.
        </p>
      )}
      {items.length === 0 ? (
        <p className="muted">Nothing in that source looked like a skill, agent, command, prompt or MD.</p>
      ) : (
        <ul className="link-list" aria-label="Imported items">
          {items.map((it) => (
            <li key={it.id} className="row wrap">
              <Link to={`/items/${it.id}`} onClick={onClose}>
                {it.title || it.name}
              </Link>
              <KindBadges item={it} />
              {it.op && <span className={it.op === 'unchanged' ? 'badge badge-disabled' : 'badge'}>{OP_LABEL[it.op]}</span>}
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <details open={items.length === 0}>
          <summary>Skipped ({skipped.length})</summary>
          <ul className="link-list">
            {skipped.map((s, i) => (
              <li key={i}>
                <code>{s.path || '(root)'}</code> <span className="muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="row end">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
