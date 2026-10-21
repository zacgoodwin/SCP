import { useState } from 'react';

/** A snippet in a <pre> with a copy button. */
export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard needs a secure context; the text stays selectable
    }
  };
  return (
    <figure className="copy-block">
      <figcaption>
        <span>{label}</span>
        <button type="button" className="btn btn-small" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
    </figure>
  );
}
