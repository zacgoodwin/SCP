import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import * as api from '../api.ts';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { FilesEditor } from '../components/FilesEditor.tsx';
import { parseTags } from '../format.ts';
import { deriveName, entryPath, MULTI_FILE_KINDS, templateFiles } from '../templates.ts';
import { PLANE_LABEL, PLANE_PATH } from './ItemsList.tsx';

const PLANES: api.Plane[] = ['skill', 'md', 'artifact'];

export function NewItemPage() {
  const [params] = useSearchParams();
  const p = params.get('plane') as api.Plane;
  const plane = PLANES.includes(p) ? p : 'skill';
  const k = params.get('kind') as api.Kind;
  const kind = api.KINDS_BY_PLANE[plane].includes(k) ? k : api.KINDS_BY_PLANE[plane][0];
  return <NewItemForm key={plane} plane={plane} initialKind={kind} />;
}

function NewItemForm({ plane, initialKind }: { plane: api.Plane; initialKind: api.Kind }) {
  const nav = useNavigate();
  const [kind, setKind] = useState(initialKind);
  const [format, setFormat] = useState<api.Format>('html');
  const [category, setCategory] = useState('tool');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [visibility, setVisibility] = useState<api.Visibility>('private');
  const [files, setFiles] = useState<api.FileIn[]>(() => templateFiles(initialKind, 'html'));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const multi = MULTI_FILE_KINDS.includes(kind);
  const derived = name.trim() || deriveName(files[0]?.content ?? '', title);
  const singlePath = entryPath(kind, format, derived);

  // Swap the template while the user has not typed into the content yet.
  const retemplate = (nextKind: api.Kind, nextFormat: api.Format) => {
    if (!dirty) setFiles(templateFiles(nextKind, nextFormat));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: api.ItemCreate = {
        kind,
        name: name.trim() || undefined,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        tags: parseTags(tags),
        visibility,
        files: multi ? files : [{ ...files[0], path: singlePath }],
      };
      if (kind === 'artifact') Object.assign(body, { format, category });
      const { item } = await api.createItem(body);
      nav(`/items/${item.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to={PLANE_PATH[plane]}>{PLANE_LABEL[plane]}</Link> / New
      </nav>
      <h1>New {plane === 'md' ? 'prompt or MD' : plane}</h1>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          {plane === 'md' && (
            <label className="field">
              <span>Kind</span>
              <select
                value={kind}
                onChange={(e) => {
                  const v = e.target.value as api.Kind;
                  setKind(v);
                  retemplate(v, format);
                }}
              >
                {api.KINDS_BY_PLANE.md.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === 'artifact' && (
            <>
              <label className="field">
                <span>Format</span>
                <select
                  value={format}
                  onChange={(e) => {
                    const v = e.target.value as api.Format;
                    setFormat(v);
                    retemplate(kind, v);
                  }}
                >
                  {api.FORMATS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Category</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {api.ARTIFACT_CATEGORIES.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              placeholder={derived || 'derived'}
              pattern={kind === 'skill' ? '[a-z0-9]+(-[a-z0-9]+)*' : '[a-z0-9][a-z0-9._\\-]{0,63}'}
              maxLength={64}
            />
            <small className="muted">Optional. Derived from the frontmatter name or the title when left blank.</small>
          </label>
          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Visibility</span>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as api.Visibility)}>
              <option value="private">private (you and your groups)</option>
              <option value="public">public (every signed-in user)</option>
            </select>
          </label>
          <label className="field">
            <span>Tags</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="pdf, docs, review" />
            <small className="muted">Comma separated.</small>
          </label>
          <label className="field span-2">
            <span>Description</span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        <FilesEditor
          files={files}
          multi={multi}
          singlePath={singlePath}
          onChange={(f) => {
            setFiles(f);
            setDirty(true);
          }}
        />

        <ErrorBox error={error} />
        <div className="row end">
          <Link className="btn" to={PLANE_PATH[plane]}>
            Cancel
          </Link>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
