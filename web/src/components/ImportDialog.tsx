import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import * as api from '../api.ts';
import { ErrorBox } from './ErrorBox.tsx';
import { Modal } from './Modal.tsx';

// Every extension the server's importUpload takes (items/import.ts).
const ACCEPT = '.md,.markdown,.zip,.skill,.html,.htm,.svg,.mmd,.jsx,.tsx';
const ALL_KINDS = Object.values(api.KINDS_BY_PLANE).flat();

export function ImportDialog({ open, onClose, plane }: { open: boolean; onClose: () => void; plane?: api.Plane }) {
  const nav = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const kinds = plane ? api.KINDS_BY_PLANE[plane] : ALL_KINDS;
  // A one-kind plane (Skills, Artifacts) imports as that kind: detection never yields 'artifact' for
  // a .md, which would land an Artifacts-page import in Prompts & MDs.
  const [kind, setKind] = useState<api.Kind | ''>(kinds.length === 1 ? kinds[0] : '');
  const [visibility, setVisibility] = useState<api.Visibility>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { item } = await api.importItem(file, { kind: kind || undefined, visibility });
      onClose();
      nav(`/items/${item.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Import" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>File</span>
          <input type="file" accept={ACCEPT} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <small className="muted">A .md file, a skill folder as .zip or .skill, or an artifact (.html, .md, .svg, .mmd, .jsx, .tsx).</small>
        </label>
        <label className="field">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as api.Kind | '')}>
            <option value="">Detect automatically</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Visibility</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as api.Visibility)}>
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
        </label>
        <ErrorBox error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!file || busy}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
