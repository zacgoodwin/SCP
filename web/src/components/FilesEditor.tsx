import { useState } from 'react';
import type { FileIn } from '../api.ts';

interface Props {
  files: FileIn[];
  onChange: (files: FileIn[]) => void;
  /** false: one entry file, content only (path is fixed by the caller). */
  multi: boolean;
  /** Path shown for the single-file editor. */
  singlePath?: string;
}

const isBinary = (f: FileIn) => f.content === undefined && f.contentBase64 !== undefined;

// A textarea's value is newline-normalized to LF, so a one-character edit would rewrite every line
// ending of a CRLF file (and its sha256). The textarea shows LF (a CRLF value prop would differ from
// the DOM value and reset the caret on every keystroke); files that use CRLF get it back on store.
// ponytail: a mixed-ending file becomes all CRLF once edited.
const shown = (f: FileIn | undefined) => (f?.content ?? '').replace(/\r\n/g, '\n');
const stored = (f: FileIn | undefined, v: string) => (f?.content?.includes('\r\n') ? v.replace(/\n/g, '\r\n') : v);

/** Edits FileIn[] in place: one textarea for single-file kinds, a file list + editor for trees. */
export function FilesEditor({ files, onChange, multi, singlePath }: Props) {
  const [sel, setSel] = useState(0);
  const cur = Math.min(sel, files.length - 1);
  const set = (i: number, patch: Partial<FileIn>) => onChange(files.map((f, n) => (n === i ? { ...f, ...patch } : f)));

  if (!multi) {
    return (
      <label className="field">
        <span>
          Content <code className="muted">{singlePath ?? files[0]?.path}</code>
        </span>
        <textarea
          className="code-input"
          rows={24}
          spellCheck={false}
          value={shown(files[0])}
          onChange={(e) => set(0, { content: stored(files[0], e.target.value) })}
        />
      </label>
    );
  }

  const add = () => {
    let n = 1;
    while (files.some((f) => f.path === `file-${n}.md`)) n++;
    onChange([...files, { path: `file-${n}.md`, content: '' }]);
    setSel(files.length);
  };
  const remove = (i: number) => {
    onChange(files.filter((_, n) => n !== i));
    setSel(Math.max(0, i - 1));
  };
  const f = files[cur];

  return (
    <fieldset className="files-editor">
      <legend>Files ({files.length})</legend>
      <div className="files-editor-grid">
        <ul className="file-list" aria-label="Files">
          {files.map((file, i) => (
            <li key={i}>
              <button type="button" className={i === cur ? 'file-btn active' : 'file-btn'} aria-current={i === cur} onClick={() => setSel(i)}>
                {file.path || '(unnamed)'}
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="btn btn-small" onClick={add}>
              + Add file
            </button>
          </li>
        </ul>
        {f && (
          <div className="file-pane">
            <div className="row">
              <label className="field grow">
                <span>Path</span>
                <input value={f.path} onChange={(e) => set(cur, { path: e.target.value })} spellCheck={false} required />
              </label>
              <button type="button" className="btn btn-danger" disabled={files.length <= 1} onClick={() => remove(cur)}>
                Remove
              </button>
            </div>
            {isBinary(f) ? (
              <p className="muted">Binary file, kept unchanged.</p>
            ) : (
              <label className="field">
                <span>Content</span>
                <textarea
                  className="code-input"
                  rows={22}
                  spellCheck={false}
                  value={shown(f)}
                  onChange={(e) => set(cur, { content: stored(f, e.target.value) })}
                />
              </label>
            )}
          </div>
        )}
      </div>
    </fieldset>
  );
}
