import type { KeyboardEvent } from 'react';

interface Props<T extends string> {
  tabs: readonly (readonly [T, string])[];
  value: T;
  onChange: (tab: T) => void;
  /** aria-label of the tablist. */
  label: string;
  /** Tab buttons are `${idPrefix}-${tab}`: the panel's aria-labelledby names the active one. */
  idPrefix: string;
  /** The tabpanel the tabs control. */
  panelId: string;
}

/** ARIA tabs: one Tab stop for the list (roving tabIndex), Left and Right move between tabs and focus the new one. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix, panelId }: Props<T>) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = tabs.findIndex(([t]) => t === value);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
    onChange(next);
    document.getElementById(`${idPrefix}-${next}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
      {tabs.map(([t, text]) => (
        <button
          key={t}
          type="button"
          role="tab"
          id={`${idPrefix}-${t}`}
          aria-selected={value === t}
          aria-controls={panelId}
          tabIndex={value === t ? 0 : -1}
          className="tab"
          onClick={() => onChange(t)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
