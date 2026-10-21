import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth, useUser } from '../auth.tsx';
import { ChangePasswordDialog } from './ChangePasswordDialog.tsx';

const NAV: { to: string; label: string; admin?: boolean }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/skills', label: 'Skills' },
  { to: '/mds', label: 'Prompts & MDs' },
  { to: '/artifacts', label: 'Artifacts' },
  { to: '/groups', label: 'Groups' },
  { to: '/keys', label: 'API Keys' },
  { to: '/activity', label: 'Activity' },
  { to: '/admin/users', label: 'Admin', admin: true },
];

export function Layout() {
  const user = useUser();
  const { signOut } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  const logout = async () => {
    await signOut();
    nav('/login');
  };

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="sidebar">
        <div className="brand-row">
          <Link to="/" className="brand">
            SCP
          </Link>
          <button type="button" className="btn nav-toggle" aria-expanded={open} aria-controls="side-panel" onClick={() => setOpen((o) => !o)}>
            {open ? 'Close' : 'Menu'}
          </button>
        </div>
        <div id="side-panel" className={open ? 'side-panel open' : 'side-panel'}>
          <nav aria-label="Main">
            <ul className="nav-list">
              {NAV.filter((n) => !n.admin || user.isAdmin).map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} end={n.to === '/'} className="nav-link">
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <details className="user-menu">
            <summary>
              <span className="avatar" aria-hidden="true">
                {user.username.slice(0, 1).toUpperCase()}
              </span>
              {user.username}
            </summary>
            <div className="user-menu-items">
              <button type="button" className="btn btn-block" onClick={() => setPwOpen(true)}>
                Change password
              </button>
              <button type="button" className="btn btn-block" onClick={logout}>
                Log out
              </button>
            </div>
          </details>
        </div>
      </header>
      <main id="main" className="content" tabIndex={-1}>
        <Outlet />
      </main>
      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}
