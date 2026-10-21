import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Tone = 'ok' | 'error' | 'info';
interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => {});

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const push = useCallback((text: string, tone: Tone = 'info') => {
    const id = nextId++;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000);
  }, []);

  return (
    <ToastContext value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.text}</span>
            <button type="button" className="btn-icon" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

/** push(text, tone) shows a transient message. */
export const useToast = () => useContext(ToastContext);
