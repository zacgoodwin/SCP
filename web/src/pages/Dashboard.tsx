import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import * as api from '../api.ts';
import { useAuth, useUser } from '../auth.tsx';
import { CopyBlock } from '../components/CopyBlock.tsx';
import { ErrorBox } from '../components/ErrorBox.tsx';
import { groupLabel } from '../format.ts';
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
  const [myGroups, setMyGroups] = useState<api.GroupSummary[]>([]);
  const [sharedGroups, setSharedGroups] = useState<api.GroupSummary[]>([]);
  const [group, setGroup] = useState('my-group');
  const [importOpen, setImportOpen] = useState(false);

  // Reloaded after an import (ImportDialog onImported), so the stat tiles and group lists show what it wrote.
  const load = () => {
    loadCounts().then(setCounts, setError);
    // Two lists, each its own query: the readable page lists own groups first, so a user with 200 groups
    // would never see a shared one on it. The first group to arrive becomes the Connect default, except
    // for an admin's "others" list: it is every other user's group (admins read them all), not a share.
    const pick = (r: { groups: api.GroupSummary[] }) => setGroup((g) => (g === 'my-group' && r.groups[0] ? r.groups[0].slug : g));
    api.listGroups({ owner: 'me', limit: 200 }).then((r) => (setMyGroups(r.groups), pick(r)), () => {});
    api.listGroups({ owner: 'others', limit: 200 }).then(
      (r) => {
        setSharedGroups(r.groups);
        if (!user.isAdmin) pick(r);
      },
      () => {},
    );
  };
  useEffect(load, []);

  const groups = [...myGroups, ...sharedGroups];
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
        <div className="page-title">
          <h1>Welcome, {user.username}</h1>
          <p className="muted">Manage skills, prompts and artifacts, bundle them into groups, and connect agents.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => setImportOpen(true)}>
            Import
          </button>
          <Link className="btn btn-primary" to="/items/new?plane=skill">
            New skill
          </Link>
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
        <header className="card-head">
          <h2>Quick links</h2>
        </header>
        <div className="row wrap">
          <Link className="btn" to="/items/new?plane=skill">New skill</Link>
          <Link className="btn" to="/items/new?plane=md">New prompt or MD</Link>
          <Link className="btn" to="/items/new?plane=artifact">New artifact</Link>
          <button type="button" className="btn" onClick={() => setImportOpen(true)}>Import</button>
          <Link className="btn" to="/groups">Build a group</Link>
          <Link className="btn" to="/keys">Mint an API key</Link>
        </div>
      </section>

      <section className="card stack" aria-labelledby="my-groups-h">
        <header className="card-head">
          <h2 id="my-groups-h">Your groups</h2>
          <Link className="btn btn-small" to="/groups">
            All groups
          </Link>
        </header>
        {myGroups.length === 0 ? (
          <div className="empty">
            <p>You have no groups yet.</p>
            <p className="muted">A group turns a set of items into one MCP server and one bundle.</p>
            <Link className="btn btn-primary" to="/groups">
              Create a group
            </Link>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Contents</th>
                  <th scope="col" className="cell-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {myGroups.map((x) => {
                  const s = encodeURIComponent(x.slug);
                  return (
                    <tr key={x.id}>
                      <td className="cell-main">
                        <span className="row wrap">
                          <Link to={`/groups/${s}`} className="item-card-title">
                            {x.name}
                          </Link>
                          <VisibilityBadge visibility={x.visibility} />
                        </span>
                        <code className="cell-sub">{x.slug}</code>
                      </td>
                      <td>
                        <PlaneCounts counts={x.counts} />
                      </td>
                      <td className="cell-actions">
                        <span className="row">
                          <Link className="btn btn-small" to={`/groups/${s}#connect`}>
                            Connect
                          </Link>
                          <Link className="btn btn-small" to={`/keys?group=${s}`}>
                            New key
                          </Link>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack" aria-labelledby="shared-groups-h">
        <header className="card-head">
          {/* An admin reads every group, so their "others" list is every other user's, private ones included: say so. */}
          <h2 id="shared-groups-h">{user.isAdmin ? "Other users' groups" : 'Shared with you'}</h2>
          <Link className="btn btn-small" to="/groups">
            Browse groups
          </Link>
        </header>
        {user.isAdmin && sharedGroups.length > 0 && <p className="muted">As an admin you see every group, not only the ones shared with you or made public.</p>}
        {sharedGroups.length === 0 ? (
          <div className="empty">
            <p>{user.isAdmin ? 'No other user has a group yet.' : 'No one has shared a group with you yet.'}</p>
            <p className="muted">Groups other users share with you or make public show up here (the first 200; browse for the rest).</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Contents</th>
                  <th scope="col" className="cell-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sharedGroups.map((x) => {
                  const s = encodeURIComponent(x.slug);
                  return (
                    <tr key={x.id}>
                      <td className="cell-main">
                        <span className="row wrap">
                          <Link to={`/groups/${s}`} className="item-card-title">
                            {x.name}
                          </Link>
                          <VisibilityBadge visibility={x.visibility} />
                        </span>
                        <code className="cell-sub">{x.slug}</code>
                      </td>
                      <td>{x.owner.username}</td>
                      <td>
                        <PlaneCounts counts={x.counts} />
                      </td>
                      <td className="cell-actions">
                        <Link className="btn btn-small" to={`/groups/${s}#connect`}>
                          Connect
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack">
        <header className="card-head">
          <h2>Connect an agent</h2>
        </header>
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
                  {groupLabel(x)}
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
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={load} />
    </div>
  );
}
