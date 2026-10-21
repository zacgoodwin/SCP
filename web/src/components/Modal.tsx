import { useEffect, useRef, type ReactNode } from 'react';

/** Native <dialog> shown modally while `open`; Esc and the close button call onClose. */
export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="modal" aria-label={title} onClose={onClose}>
      <header className="modal-head">
        <h2>{title}</h2>
        <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {open && children}
    </dialog>
  );
}
