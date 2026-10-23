import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import * as api from '../api.ts';
import * as tools from '../api-tools.ts';
import { useUser } from '../auth.tsx';
import { CopyBlock } from '../components/CopyBlock.tsx';
import { PlatformTabs, ToolForm, checkCommand, commandFor, defaultPlatform, platformLabel, type Platform } from '../components/CliTools.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { useToast } from '../components/Toast.tsx';

/**
 * fx78: one card per CLI in the admin registry, with its install commands and check one-liner. Tools
 * are never items: their companion skills import as items, and this page is where the binary's own
 * install lives. Admins edit rows inline (the registry routes stay admin-only).
 */
export function ToolsPage() {
  const me = useUser();
  const toast = useToast();
  const { hash } = useLocation();
  const [rows, setRows] = useState<tools.ToolView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);

  const load = () => tools.listTools().then((r) => setRows(r.tools), setError);
  useEffect(() => void load(), []);

  const loaded = rows !== null;
  useEffect(() => {
    if (loaded && hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [loaded, hash]);

  const q = text.trim().toLowerCase();
  const shown = rows?.filter((t) => !q || t.name.includes(q) || t.homepage.toLowerCase().includes(q)) ?? null;

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Tools</h1>
          <p className="muted">
            Command-line tools that skills here need on your machine, with the commands to install them. SCP never runs these: copy them into a
            terminal yourself. The commands come from this instance's admins, never from the skills.
          </p>
        </div>
        {me.isAdmin && !adding && (
          <div className="page-actions">
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              Add tool
            </button>
          </div>
        )}
      </header>

      {adding && (
        <section className="card stack">
          <h2>Add a tool</h2>
          <ToolForm
            onCancel={() => setAdding(false)}
            onSaved={(t) => {
              setAdding(false);
              toast(`Added ${t.name}.`, 'ok');
              void load();
            }}
          />
        </section>
      )}

      <label className="field">
        <span className="sr-only">Search tools</span>
        <input type="search" placeholder="Search tools…" value={text} onChange={(e) => setText(e.target.value)} />
      </label>

      <ErrorBox error={error} />
      {shown === null ? (
        error ? null : <p className="muted" role="status">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="empty">
          {q ? <p>No tools match "{text.trim()}".</p> : <p>No tools are recorded yet.{me.isAdmin ? ' Add one with "Add tool".' : ' An admin adds them.'}</p>}
        </div>
      ) : (
        <ul className="requires-list">
          {shown.map((t) => (
            <ToolCard key={t.name} tool={t} isAdmin={me.isAdmin} onChange={() => void load()} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolCard({ tool, isAdmin, onChange }: { tool: tools.ToolView; isAdmin: boolean; onChange: () => void }) {
  const toast = useToast();
  const [platform, setPlatform] = useState<Platform>(defaultPlatform);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const cmd = commandFor(tool.install, platform);
  const anyCommand = Object.keys(tool.install).length > 0;
  const anchor = tools.toolAnchor(tool.name);

  const remove = async () => {
    if (!confirm(`Remove ${tool.name} from the registry? Group pages stop showing its install commands.`)) return;
    setBusy(true);
    try {
      await tools.deleteTool(tool.name);
      toast(`Removed ${tool.name}.`, 'ok');
      onChange();
    } catch (e) {
      toast(api.errorMessage(e), 'error');
      setBusy(false);
    }
  };

  return (
    <li className="card stack" id={anchor}>
      <header className="card-head">
        <h2>
          <code>{tool.name}</code>
        </h2>
        {isAdmin && (
          <span className="page-actions">
            <button type="button" className="btn btn-small" onClick={() => setEditing((e) => !e)}>
              {editing ? 'Close' : 'Edit'}
            </button>
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => void remove()}>
              Remove
            </button>
          </span>
        )}
      </header>
      {tool.homepage && (
        <p>
          <a href={tool.homepage} target="_blank" rel="noreferrer noopener">
            {tool.homepage}
          </a>
        </p>
      )}
      {editing ? (
        <ToolForm
          tool={tool}
          onCancel={() => setEditing(false)}
          onSaved={(t) => {
            setEditing(false);
            toast(`Saved ${t.name}.`, 'ok');
            onChange();
          }}
        />
      ) : !anyCommand ? (
        <p className="muted">No install command recorded.{tool.homepage ? ' See the homepage.' : ''}</p>
      ) : (
        <>
          <PlatformTabs value={platform} onChange={setPlatform} idPrefix={`${anchor}-p`} panelId={`${anchor}-panel`} />
          <div id={`${anchor}-panel`} role="tabpanel" aria-labelledby={`${anchor}-p-${platform}`} className="stack">
            {cmd ? (
              <CopyBlock label={`Install (${platformLabel(platform)})`} text={cmd} />
            ) : (
              <p className="muted">No install command recorded for {platformLabel(platform)}.</p>
            )}
            <CopyBlock label={`Check (${platform === 'windows' ? 'PowerShell' : 'shell'})`} text={checkCommand([tool.check], platform)} />
          </div>
        </>
      )}
      {(tool.usedBy.items.length > 0 || tool.usedBy.groups.length > 0) && (
        <p className="muted">
          Used by{' '}
          {[
            ...tool.usedBy.items.map((i) => (
              <Link key={`i:${i.id}`} to={`/items/${i.id}`}>
                {i.title || i.name}
              </Link>
            )),
            ...tool.usedBy.groups.map((g) => (
              <Link key={`g:${g.slug}`} to={`/groups/${encodeURIComponent(g.slug)}`}>
                {g.name} (group)
              </Link>
            )),
          ].map((el, i) => (
            <span key={el.key}>
              {i > 0 && ', '}
              {el}
            </span>
          ))}
        </p>
      )}
    </li>
  );
}
