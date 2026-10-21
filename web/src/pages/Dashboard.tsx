import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import * as api from '../api.ts';
import { useAuth, useUser } from '../auth.tsx';
import { CopyBlock } from '../components/CopyBlock.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { ImportDialog } from '../components/ImportDialog.tsx';
import { PlaneCounts, VisibilityBadge } from './Groups.tsx';

type Counts = { skills: number; mds: number; artifacts: number; groups?: number; keys?: number };

/** GET /stats; until C4 ships it (404), count own items per plane from list totals. */
async function loadCounts(): Promise<Counts> {
  try {
    return await api.getStats();
  } catch (e) {
    if (!(e instanceof api.ApiError && e.status === 404)) throw e;
    const total = (plane: api.Plane) => api.listItems({ plane, owner: 'me', limit: 1 }).then((r) => r.total);
    const [skills, mds, artifacts] = await Promise.all([total('skill'), total('md'), total('artifact')]);
    return { skills, mds, artifacts };
  }
}

export function DashboardPage() {
  const user = useUser();
  const { config } = useAuth();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [groups, setGroups] = useState<api.GroupSummary[]>([]);
  const [group, setGroup] = useState('my-group');
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    loadCounts().then(setCounts, setError);
    api.listGroups().then(
      (r) => {
        setGroups(r.groups);
        if (r.groups[0]) setGroup(r.groups[0].slug);
      },
      () => {}, // groups API may not exist yet; the slug input still works
    );
  }, []);

  const myGroups = groups.filter((x) => x.owner.id === user.id);
  const publicUrl = config?.publicUrl ?? window.location.origin;
  const g = group.trim() || 'my-group';
  const stat = (label: string, value: number | undefined, to: string) => (
    <li className="card stat">
      <Link to={to}>
        <span className="stat-value">{counts ? (value ?? '–') : '…'}</span>
        <span className="stat-label">{label}</span>
      </Link>
    </li>
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Welcome, {user.username}</h1>
          <p className="muted">Manage skills, prompts and artifacts, bundle them into groups, and connect agents.</p>
        </div>
      </header>

      <ErrorBox error={error} />
      <ul className="stats" aria-label="Your content">
        {stat('Skills', counts?.skills, '/skills?mine=1')}
        {stat('Prompts & MDs', counts?.mds, '/mds?mine=1')}
        {stat('Artifacts', counts?.artifacts, '/artifacts?mine=1')}
        {stat('Groups', counts?.groups, '/groups')}
        {stat('API keys', counts?.keys, '/keys')}
      </ul>

      <section className="card stack">
        <h2>Quick links</h2>
        <div className="row wrap">
          <Link className="btn" to="/items/new?plane=skill">New skill</Link>
          <Link className="btn" to="/items/new?plane=md">New prompt or MD</Link>
          <Link className="btn" to="/items/new?plane=artifact">New artifact</Link>
          <button type="button" className="btn" onClick={() => setImportOpen(true)}>Import a file</button>
          <Link className="btn" to="/groups">Build a group</Link>
          <Link className="btn" to="/keys">Mint an API key</Link>
        </div>
      </section>

      <section className="card stack" aria-labelledby="my-groups-h">
        <div className="row wrap">
          <h2 id="my-groups-h" className="grow">
            Your groups
          </h2>
          <Link className="btn btn-small" to="/groups">
            All groups
          </Link>
        </div>
        {myGroups.length === 0 ? (
          <div className="empty">
            <p>You have no groups yet. A group turns a set of items into one MCP server and one bundle.</p>
            <Link className="btn btn-primary" to="/groups">
              Create a group
            </Link>
          </div>
        ) : (
          <ul className="pick-list">
            {myGroups.map((x) => {
              const s = encodeURIComponent(x.slug);
              return (
                <li key={x.id} className="pick-row">
                  <div className="grow stack-tight">
                    <div className="row wrap">
                      <Link to={`/groups/${s}`} className="item-card-title">
                        {x.name}
                      </Link>
                      <VisibilityBadge visibility={x.visibility} />
                    </div>
                    <PlaneCounts counts={x.counts} />
                  </div>
                  <div className="row wrap">
                    <Link className="btn btn-small" to={`/groups/${s}#connect`}>
                      Connect
                    </Link>
                    <Link className="btn btn-small" to={`/keys?group=${s}`}>
                      New key
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h2>Connect an agent</h2>
        <p>
          Every group is an MCP server at <code>{publicUrl}/mcp/&lt;group&gt;</code> and a downloadable bundle at{' '}
          <code>/api/v1/groups/&lt;group&gt;/bundle.zip</code>. Both take an API key as a Bearer token:{' '}
          <Link to="/keys">mint one</Link> and paste it in place of <code>&lt;key&gt;</code> (or export it as <code>SCP_KEY</code>).
        </p>
        <label className="field narrow">
          <span>Group</span>
          {groups.length > 0 ? (
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              {groups.map((x) => (
                <option key={x.id} value={x.slug}>
                  {x.name} ({x.slug})
                </option>
              ))}
            </select>
          ) : (
            <input value={group} onChange={(e) => setGroup(e.target.value)} spellCheck={false} />
          )}
        </label>
        <CopyBlock
          label="Claude Code (MCP over HTTP)"
          text={`claude mcp add --transport http scp-${g} ${publicUrl}/mcp/${g} --header "Authorization: Bearer <key>"`}
        />
        <CopyBlock
          label="Install the bundle into this project (curl)"
          text={`curl -fsSL -H "Authorization: Bearer $SCP_KEY" "${publicUrl}/api/v1/groups/${g}/bundle.zip?target=claude-code" -o scp-${g}.zip && unzip -o scp-${g}.zip`}
        />
      </section>
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
