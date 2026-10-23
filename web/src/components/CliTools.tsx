import { useState, type FormEvent } from 'react';
import * as tools from '../api-tools.ts';
import { ErrorBox } from './ErrorBox.tsx';
import { Tabs } from './Tabs.tsx';

/** The platforms a reader picks between; a registry row's `any` command fills in for each. */
export type Platform = 'macos' | 'linux' | 'windows';
export const PLATFORM_TABS: readonly (readonly [Platform, string])[] = [
  ['macos', 'macOS'],
  ['linux', 'Linux'],
  ['windows', 'Windows'],
];
export const platformLabel = (p: Platform) => PLATFORM_TABS.find(([k]) => k === p)![1];

/** The viewer's platform, from userAgentData where the browser has it. "mac" first: "darwin" contains "win". */
export function defaultPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = (nav.userAgentData?.platform || nav.platform || nav.userAgent || '').toLowerCase();
  return p.includes('mac') || /iphone|ipad/.test(p) ? 'macos' : p.includes('win') ? 'windows' : 'linux';
}

export const commandFor = (install: tools.CliInstall, p: Platform): string | undefined => install[p] || install.any;

/** Prints the binaries missing from PATH. Names are validated server side (no shell metacharacters). */
export function checkCommand(bins: string[], p: Platform): string {
  if (p === 'windows') {
    return `foreach ($b in ${bins.map((b) => `'${b}'`).join(',')}) { if (-not (Get-Command $b -ErrorAction SilentlyContinue)) { "missing: $b" } }`;
  }
  return `for b in ${bins.join(' ')}; do command -v "$b" >/dev/null 2>&1 || echo "missing: $b"; done`;
}

export function PlatformTabs({ value, onChange, idPrefix, panelId }: { value: Platform; onChange: (p: Platform) => void; idPrefix: string; panelId: string }) {
  return <Tabs tabs={PLATFORM_TABS} value={value} onChange={onChange} label="Platform" idPrefix={idPrefix} panelId={panelId} />;
}

const INSTALL_FIELDS: [tools.InstallPlatform, string][] = [
  ['macos', 'macOS'],
  ['linux', 'Linux'],
  ['windows', 'Windows (PowerShell)'],
  ['any', 'Any platform (used where a platform has none)'],
];

/**
 * Admin editor for one registry row: create when `tool` is absent, else replace. Every command is one
 * line that readers will paste into a terminal, so it is reviewed here and audited on save.
 */
export function ToolForm({ tool, onSaved, onCancel }: { tool?: tools.CliTool; onSaved: (t: tools.CliTool) => void; onCancel?: () => void }) {
  const [name, setName] = useState(tool?.name ?? '');
  const [homepage, setHomepage] = useState(tool?.homepage ?? '');
  const [check, setCheck] = useState(tool && tool.check !== tool.name ? tool.check : '');
  const [install, setInstall] = useState<tools.CliInstall>(tool?.install ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = { homepage: homepage.trim(), check: check.trim(), install };
      const r = tool ? await tools.updateTool(tool.name, input) : await tools.createTool(name.trim(), input);
      onSaved(r.tool);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const id = (f: string) => `tool-${tool?.name ?? 'new'}-${f}`;
  return (
    <form className="stack" onSubmit={submit}>
      {!tool && (
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-z0-9][a-z0-9._\-]{0,63}" placeholder="roborev" autoComplete="off" />
          <small className="muted">The name skills list in metadata.requires.</small>
        </label>
      )}
      <label className="field">
        <span>Homepage</span>
        <input type="url" value={homepage} onChange={(e) => setHomepage(e.target.value)} placeholder="https://…" autoComplete="off" />
      </label>
      <label className="field">
        <span>Binary on PATH</span>
        <input value={check} onChange={(e) => setCheck(e.target.value)} placeholder={name || tool?.name || 'defaults to the name'} autoComplete="off" />
      </label>
      {INSTALL_FIELDS.map(([k, label]) => (
        <label key={k} className="field" htmlFor={id(k)}>
          <span>Install command: {label}</span>
          <input id={id(k)} value={install[k] ?? ''} onChange={(e) => setInstall((i) => ({ ...i, [k]: e.target.value }))} autoComplete="off" spellCheck={false} />
        </label>
      ))}
      <p className="muted">Readers copy these into a terminal. SCP never runs them. Each is one line; every change is in the audit log.</p>
      <ErrorBox error={error} />
      <div className="row end">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : tool ? 'Save' : 'Add tool'}
        </button>
      </div>
    </form>
  );
}
