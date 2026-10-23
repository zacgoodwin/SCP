import { useEffect, useState, type FormEvent } from 'react';
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

/** The same import again (same zip File, or the same GitHub source) with more options: folderKinds, onNameClash or frontmatterErrors from a later screen. */
type Rerun = (more: imp.ImportGroupOpts) => Promise<imp.ImportResult>;
/** Run an import (first time or again) and show what came of it. */
type OnRun = (run: Rerun, more?: imp.ImportGroupOpts) => Promise<void>;

/** A re-run joins the group the first run created (its slug is taken now) instead of creating it again. */
const sameGroup = (r: imp.ImportResult): imp.ImportGroupOpts => (r.group ? { group: undefined, groupName: undefined, intoGroup: r.group.slug } : {});

export function ImportDialog({
  open,
  onClose,
  onImported,
  plane,
  intoGroup,
}: {
  open: boolean;
  onClose: () => void;
  /** A pack or GitHub import finished (whatever it wrote): the page behind reloads what it lists. */
  onImported?: (r: imp.ImportResult) => void;
  plane?: api.Plane;
  /** Preselect this existing group (the group page's "Import into this group"); the File tab, which takes no group, is left out. */
  intoGroup?: string;
}) {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>(intoGroup ? 'pack' : 'file');
  const [result, setResult] = useState<imp.ImportResult | null>(null);
  const [limits, setLimits] = useState<imp.ImportLimits | null>(null);

  // Read on every open: an admin may have changed them. Unreadable (an older server), the server's 413 is the only check.
  useEffect(() => {
    if (!open) return;
    let live = true;
    imp.getImportLimits().then(
      (l) => {
        if (live) setLimits(l);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open]);
  const [rerun, setRerun] = useState<Rerun | null>(null);
  // Folder kinds picked so far: each re-run sends them all, so an earlier pick is not offered again.
  const [folderKinds, setFolderKinds] = useState<Record<string, imp.FolderKind>>({});
  // 0rdh: a 409 frontmatter_errors (nothing imported yet) and the run to answer it with.
  const [ask, setAsk] = useState<{ units: imp.FrontmatterUnit[]; run: Rerun; more: imp.ImportGroupOpts } | null>(null);

  const close = () => {
    setResult(null);
    setFolderKinds({});
    setAsk(null);
    onClose();
  };
  // Per docs/PLAN-v2.md D6: a created group wins, else the single item, else the list. Anything skipped
  // shows the list first (it links to the group), or the skip reasons would be lost.
  const done = (r: imp.ImportResult, again: Rerun) => {
    setRerun(() => again);
    setAsk(null);
    onImported?.(r);
    if (r.group && r.items.length > 0 && r.skipped.length === 0) {
      close();
      nav(`/groups/${encodeURIComponent(r.group.slug)}`);
    } else if (r.items.length === 1 && r.skipped.length === 0) {
      close();
      nav(`/items/${r.items[0].id}`);
    } else setResult(r);
  };
  // Units with frontmatter errors are asked about before anything is written (409); every other outcome is a result.
  const show: OnRun = async (run, more = {}) => {
    try {
      done(await run(more), run);
    } catch (e) {
      const units = imp.frontmatterErrorsOf(e);
      if (!units) throw e;
      setAsk({ units, run, more });
    }
  };
  const importFolders = async (picked: Record<string, imp.FolderKind>) => {
    if (!rerun || !result) return;
    const all = { ...folderKinds, ...picked };
    setFolderKinds(all);
    await show(rerun, { folderKinds: all, ...sameGroup(result) });
  };
  // 5ef6: the same import with clashing names prefixed; what it already imported stays `unchanged`.
  const importPrefixed = async () => {
    if (!rerun || !result) return;
    await show((more) => rerun({ ...more, onNameClash: 'prefix' }), { folderKinds, ...sameGroup(result) });
  };
  // 0rdh: "Import anyway" or "Skip these" re-posts the import the 409 answered, with the choice.
  const answer = async (choice: 'import' | 'skip') => {
    if (!ask) return;
    const { run, more } = ask;
    await show((m) => run({ ...m, frontmatterErrors: choice }), more);
  };
  // An artifact is one file with a format; a pack or repository tree cannot become one (the server refuses kind: artifact).
  const tabs = plane === 'artifact' ? TABS.filter(([t]) => t === 'file') : intoGroup ? TABS.filter(([t]) => t !== 'file') : TABS;

  return (
    <Modal open={open} title={intoGroup ? `Import into ${intoGroup}` : 'Import'} onClose={close}>
      {ask ? (
        <FrontmatterPrompt units={ask.units} onChoose={answer} onCancel={close} />
      ) : result ? (
        <ImportResultView result={result} onClose={close} onImportFolders={rerun ? importFolders : undefined} onImportPrefixed={rerun ? importPrefixed : undefined} />
      ) : (
        <div className="stack">
          <Tabs tabs={tabs} value={tab} onChange={setTab} label="Import source" idPrefix="itab" panelId="import-panel" />
          <div id="import-panel" role="tabpanel" aria-labelledby={`itab-${tab}`}>
            {tab === 'file' ? (
              <FileForm plane={plane} limits={limits} onCancel={close} />
            ) : tab === 'pack' ? (
              <PackForm limits={limits} intoGroup={intoGroup} onCancel={close} onRun={show} />
            ) : (
              <GithubForm plane={plane} intoGroup={intoGroup} onCancel={close} onRun={show} />
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

/** jcfm: the description SCP writes as frontmatter when the one imported file has none. */
function DescriptionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>Description</span>
      <textarea rows={2} maxLength={1024} value={value} placeholder="Optional" onChange={(e) => onChange(e.target.value)} />
      <small className="muted">
        For an import of one item whose file has no frontmatter (a plain .md imported as a skill, say): SCP adds this description (and a skill's or agent's name) as its
        frontmatter, and adds it again on every update from the source. A file with frontmatter of its own keeps it.
      </small>
    </label>
  );
}

/** The group a pack or GitHub import lands in: none, a new one (slug + name), or an existing one the user owns. */
interface GroupChoice {
  mode: 'none' | 'new' | 'existing';
  slug: string;
  name: string;
  into: string;
}
const initialGroup = (into?: string): GroupChoice => ({ mode: into ? 'existing' : 'none', slug: '', name: '', into: into ?? '' });
const groupOpts = (g: GroupChoice): imp.ImportGroupOpts =>
  g.mode === 'new' ? { group: g.slug.trim() || undefined, groupName: g.name.trim() || undefined } : g.mode === 'existing' ? { intoGroup: g.into || undefined } : {};

function GroupFields({ value, onChange }: { value: GroupChoice; onChange: (g: GroupChoice) => void }) {
  const [groups, setGroups] = useState<api.GroupSummary[] | null>(null);
  const existing = value.mode === 'existing';
  useEffect(() => {
    if (existing && !groups) api.listGroups({ owner: 'me', limit: 200 }).then((r) => setGroups(r.groups), () => setGroups([]));
  }, [existing]);
  const set = (patch: Partial<GroupChoice>) => onChange({ ...value, ...patch });
  return (
    <>
      <label className="field">
        <span>Group</span>
        <select value={value.mode} onChange={(e) => set({ mode: e.target.value as GroupChoice['mode'] })}>
          <option value="none">None, import the items on their own</option>
          <option value="new">New group</option>
          <option value="existing">Existing group</option>
        </select>
        <small className="muted">Every imported item becomes a member of the group. Importing into a group again updates its items without adding them twice.</small>
      </label>
      {value.mode === 'new' && (
        <>
          <label className="field">
            <span>Group slug</span>
            <input className="code-input" value={value.slug} required spellCheck={false} placeholder="group-slug" onChange={(e) => set({ slug: e.target.value.toLowerCase() })} />
          </label>
          <label className="field">
            <span>Group name</span>
            <input value={value.name} placeholder="Defaults to the repo or zip name" onChange={(e) => set({ name: e.target.value })} />
          </label>
        </>
      )}
      {existing && (
        <label className="field">
          <span>Existing group</span>
          <select value={value.into} required onChange={(e) => set({ into: e.target.value })}>
            <option value="">{groups ? 'Pick one of your groups' : 'Loading…'}</option>
            {/* The preselected group while the list loads, or one an admin can edit but does not own (not among "my" groups). */}
            {value.into && !groups?.some((g) => g.slug === value.into) && <option value={value.into}>{value.into}</option>}
            {groups?.map((g) => (
              <option key={g.id} value={g.slug}>
                {g.name} ({g.slug})
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

function FileForm({ plane, limits, onCancel }: { plane?: api.Plane; limits: imp.ImportLimits | null; onCancel: () => void }) {
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
    if (limits) imp.refuseOversize(file, limits.maxFileMb);
    const { item } = await api.importItem(file, { kind: kind || undefined, visibility });
    onCancel();
    nav(`/items/${item.id}`);
  });

  return (
    <form className="stack" onSubmit={go}>
      <label className="field">
        <span>File</span>
        <input type="file" accept={ACCEPT} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <small className="muted">
          A .md file, a skill folder as .zip or .skill, or an artifact (.html, .md, .svg, .mmd, .jsx, .tsx){limits && `, up to ${limits.maxFileMb} MB`}.
        </small>
      </label>
      <KindSelect value={kind} kinds={kinds} onChange={setKind} />
      <VisibilitySelect value={visibility} onChange={setVisibility} />
      <ErrorBox error={error} />
      <Actions busy={busy} label="Import" disabled={!file} onCancel={onCancel} />
    </form>
  );
}

function PackForm({ limits, intoGroup, onCancel, onRun }: { limits: imp.ImportLimits | null; intoGroup?: string; onCancel: () => void; onRun: OnRun }) {
  const [file, setFile] = useState<File | null>(null);
  const [visibility, setVisibility] = useState<api.Visibility>('private');
  const [group, setGroup] = useState(() => initialGroup(intoGroup));
  const [description, setDescription] = useState('');
  const { busy, error, submit } = useSubmit();

  const go = submit(async () => {
    if (!file) return;
    if (limits) imp.refuseOversize(file, limits.maxArchiveMb);
    const opts = { visibility, description: description.trim() || undefined, ...groupOpts(group) };
    await onRun((more) => imp.importOrSkipped(imp.importPack(file, { ...opts, ...more })));
  });

  return (
    <form className="stack" onSubmit={go}>
      <label className="field">
        <span>Zip pack</span>
        <input type="file" accept=".zip" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <small className="muted">
          A zip holding many skills, agents, commands or MDs (a Claude Code plugin, a <code>.claude/</code> folder, <code>skills/*/SKILL.md</code>, or loose .md
          files). Each unit becomes one item, held to the per-version limits (1000 files, 30 MB);{' '}
          {limits
            ? `at most ${limits.maxItems} item${limits.maxItems === 1 ? '' : 's'} per import, the upload ${limits.maxArchiveMb} MB (zip and form fields together), the archive 20,000 files and ${limits.maxPackMb} MB unpacked.`
            : 'the upload and the unpacked archive are held to the size limits an admin sets.'}{' '}
          Re-uploading a zip under the same file name updates the items it created; a renamed file is treated as a new pack.
        </small>
      </label>
      <VisibilitySelect value={visibility} onChange={setVisibility} />
      <DescriptionField value={description} onChange={setDescription} />
      <GroupFields value={group} onChange={setGroup} />
      <ErrorBox error={error} />
      <Actions busy={busy} label="Import pack" disabled={!file} onCancel={onCancel} />
    </form>
  );
}

function GithubForm({ plane, intoGroup, onCancel, onRun }: { plane?: api.Plane; intoGroup?: string; onCancel: () => void; onRun: OnRun }) {
  const [url, setUrl] = useState('');
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [path, setPath] = useState('');
  // No artifact: a tree has no format, so the server refuses kind: artifact for a repository.
  const kinds = (plane ? api.KINDS_BY_PLANE[plane] : ALL_KINDS).filter((k) => k !== 'artifact');
  const [kind, setKind] = useState<api.Kind | ''>('');
  const [visibility, setVisibility] = useState<api.Visibility>('private');
  const [group, setGroup] = useState(() => initialGroup(intoGroup));
  const [description, setDescription] = useState('');
  const { busy, error, submit } = useSubmit();

  const byUrl = url.trim() !== '';
  const ready = byUrl || repo.trim() !== '';

  const go = submit(async () => {
    const where: imp.GithubImport = byUrl ? { url: url.trim() } : { repo: repo.trim(), ref: ref.trim() || undefined, path: path.trim() || undefined };
    const body: imp.GithubImport = { ...where, kind: kind || undefined, visibility, description: description.trim() || undefined, ...groupOpts(group) };
    await onRun((more) => imp.importOrSkipped(imp.importGithub({ ...body, ...more })));
  });

  return (
    <form className="stack" onSubmit={go}>
      <label className="field">
        <span>GitHub URL</span>
        <input
          // text, not url: type=url makes the browser refuse github.com/o/r before the server, which accepts it (hs8z).
          type="text"
          inputMode="url"
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
      {/* The server's `kind` turns detection off (jwz6): one item per .md for the single-file kinds, the whole tree one item for the rest. */}
      <label className="field">
        <span>Import items in folder as one type</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as api.Kind | '')}>
          <option value="">No, detect each item's type</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              Yes, all as {k}
            </option>
          ))}
        </select>
        <small className="muted">
          Picking a type turns detection off. Agent, command, prompt and instructions: each .md file directly in the folder (not in subfolders) becomes its own item of that type (README-style docs are
          left out). Skill, design and package: the whole folder becomes one item holding every file; a Path naming one .md file as a skill makes that file its SKILL.md.
          A repo of many kinds of items needs detection.
        </small>
      </label>
      <DescriptionField value={description} onChange={setDescription} />
      <VisibilitySelect value={visibility} onChange={setVisibility} />
      <GroupFields value={group} onChange={setGroup} />
      <p className="muted">Fetched through the GitHub API at the ref's current commit, which is pinned on every item for update checks.</p>
      <ErrorBox error={error} />
      <Actions busy={busy} label="Import from GitHub" disabled={!ready} onCancel={onCancel} />
    </form>
  );
}

/**
 * mvfp: folders of Markdown files detection did not recognise, each with a kind to import them as.
 * "Import selected" re-runs the same import with those folders mapped; re-imports version, never duplicate.
 */
function FolderOffer({ folders, onImport }: { folders: imp.SkippedFolder[]; onImport: (picked: Record<string, imp.FolderKind>) => Promise<void> }) {
  const [kinds, setKinds] = useState<Record<string, imp.FolderKind | ''>>({});
  const { busy, error, submit } = useSubmit();
  const picked = Object.fromEntries(Object.entries(kinds).filter(([, k]) => k)) as Record<string, imp.FolderKind>;

  return (
    <form className="stack" aria-label="Unrecognised folders" onSubmit={submit(() => onImport(picked))}>
      <p>These folders hold Markdown files SCP did not recognise. Import them as:</p>
      <ul className="link-list">
        {folders.map((f) => (
          <li key={f.path}>
            <label className="row wrap">
              <span>
                <code>{f.path ? `${f.path}/` : '(root)'}</code> has {f.count} Markdown file{f.count === 1 ? '' : 's'}
              </span>
              <select value={kinds[f.path] ?? ''} onChange={(e) => setKinds({ ...kinds, [f.path]: e.target.value as imp.FolderKind | '' })}>
                <option value="">skip</option>
                {imp.FOLDER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k === 'package' ? 'package (the folder as one item)' : `${k} (one per file)`}
                  </option>
                ))}
              </select>
            </label>
          </li>
        ))}
      </ul>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="submit" className="btn" disabled={busy || Object.keys(picked).length === 0}>
          {busy ? 'Importing…' : 'Import selected'}
        </button>
      </div>
    </form>
  );
}

/**
 * 0rdh: the import found units whose only problem is their frontmatter and wrote nothing yet. "Import anyway"
 * stores them with their upstream files (the errors become warnings on the item), "Skip these" imports the rest.
 */
function FrontmatterPrompt({ units, onChoose, onCancel }: { units: imp.FrontmatterUnit[]; onChoose: (c: 'import' | 'skip') => Promise<void>; onCancel: () => void }) {
  const { busy, error, submit } = useSubmit();
  return (
    <div className="stack" role="group" aria-label="Frontmatter errors">
      <p>
        {units.length === 1 ? 'One unit has' : `${units.length} units have`} frontmatter errors. Nothing has been imported yet. Claude Code may still load them: it falls back to the
        folder or file name and the first paragraph.
      </p>
      <ul className="link-list">
        {units.map((u) => (
          <li key={u.path}>
            <code>{u.path || '(root)'}</code> <span className="badge">{u.kind}</span>
            <ul className="lint-rows">
              {u.errors.map((m, i) => (
                <li key={i} className="muted">
                  {m}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn" disabled={busy} onClick={submit(() => onChoose('skip'))}>
          Skip these
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={submit(() => onChoose('import'))}>
          {busy ? 'Importing…' : 'Import anyway'}
        </button>
      </div>
    </div>
  );
}

/** 5ef6: units skipped because another source's item holds their name, offered again under a `<repo>-` prefixed name. */
function PrefixOffer({ clashes, onImport }: { clashes: imp.ImportResult['skipped']; onImport: () => Promise<void> }) {
  const { busy, error, submit } = useSubmit();
  return (
    <form className="stack" aria-label="Name clashes" onSubmit={submit(onImport)}>
      <p>You already have items with these names, so these were skipped. Import them under a prefixed name instead:</p>
      <ul className="link-list">
        {clashes.map((s) => (
          <li key={s.path}>
            <code>{s.path || '(root)'}</code> as <code>{s.prefixed}</code>
          </li>
        ))}
      </ul>
      <ErrorBox error={error} />
      <div className="row end">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Importing…' : 'Import these with the prefix'}
        </button>
      </div>
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
function ImportResultView({
  result,
  onClose,
  onImportFolders,
  onImportPrefixed,
}: {
  result: imp.ImportResult;
  onClose: () => void;
  /** Re-run the import with these folders mapped to a kind. */
  onImportFolders?: (picked: Record<string, imp.FolderKind>) => Promise<void>;
  /** Re-run the import with onNameClash 'prefix'. */
  onImportPrefixed?: () => Promise<void>;
}) {
  const { items, skipped, source, group } = result;
  const folders = result.skippedFolders ?? [];
  const clashes = skipped.filter((s) => s.prefixed);
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
          (<code>{group.slug}</code>) holds the imported items as members.
        </p>
      )}
      {clashes.length > 0 && onImportPrefixed && <PrefixOffer key={clashes.map((s) => s.path).join('\n')} clashes={clashes} onImport={onImportPrefixed} />}
      {folders.length > 0 && onImportFolders && <FolderOffer key={folders.map((f) => f.path).join('\n')} folders={folders} onImport={onImportFolders} />}
      {items.length === 0 ? (
        clashes.length === 0 && <p className="muted">Nothing in that source looked like a skill, agent, command, prompt or MD.</p>
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
