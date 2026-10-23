import { useRef, useState } from 'react';

/** A snippet in a <pre> with a copy button. */
export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const code = useRef<HTMLElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      setTimeout(() => setState('idle'), 1500);
    } catch {
      // clipboard needs a secure context and permission; select the text so a hand copy is one keystroke
      setState('failed');
      if (code.current) window.getSelection()?.selectAllChildren(code.current);
    }
  };
  return (
    <figure className="copy-block">
      <figcaption>
        <span>{label}</span>
        <button type="button" className="btn btn-small" onClick={copy} aria-live="polite">
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed: select the text' : 'Copy'}
        </button>
      </figcaption>
      <pre>
        <code ref={code}>{text}</code>
      </pre>
    </figure>
  );
}
