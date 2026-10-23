import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import * as api from '../api.ts';
import { useAuth, useUser } from '../auth.tsx';
import { ChangePasswordDialog, SET_PASSWORD_HASH } from './ChangePasswordDialog.tsx';
import { useToast } from './Toast.tsx';

const NAV: { to: string; label: string }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/skills', label: 'Skills' },
  { to: '/mds', label: 'Prompts & MDs' },
  { to: '/artifacts', label: 'Artifacts' },
  { to: '/groups', label: 'Groups' },
  { to: '/keys', label: 'API Keys' },
  { to: '/activity', label: 'Activity' },
];

/** Shown under an "Admin" heading to admins only (D4). */
const ADMIN_NAV: { to: string; label: string }[] = [
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/logs', label: 'Logs' },
  { to: '/admin/settings', label: 'Settings' },
];

export function Layout() {
  const user = useUser();
  const { me, signOut, config, refresh } = useAuth();
  const hasPassword = me?.hasPassword !== false;
  const toast = useToast();
  const nav = useNavigate();
  const { pathname, search, hash } = useLocation();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);
  // Back from the SSO sign-in the set-password dialog asked for: reopen it, and drop the hash.
  useEffect(() => {
    if (hash !== SET_PASSWORD_HASH) return;
    setPwOpen(true);
    nav(pathname + search, { replace: true });
  }, [hash, pathname, search, nav]);

  const logout = async () => {
    await signOut();
    nav('/login');
  };
  // The signed-in session is what proves this account is yours to link; the callback never links by email alone.
  // A POST, not a link: a GET would start the link under the Lax cookie from any page that navigates here.
  const link = async () => {
    try {
      window.location.assign((await api.oidcLink(pathname)).url);
    } catch (e) {
      toast(api.errorMessage(e), 'error');
    }
  };
  // Offered whenever a link exists, OIDC configured or not (the issuer may have changed); 409 for an account without a password.
  const unlink = async () => {
    try {
      await api.oidcUnlink();
      await refresh();
      toast('Single sign-on unlinked. Sign in with your password from now on, or link again from this menu.', 'ok');
    } catch (e) {
      toast(api.errorMessage(e), 'error');
    }
  };

  const item = (n: { to: string; label: string }) => (
    <li key={n.to}>
      <NavLink to={n.to} end={n.to === '/'} className="nav-link">
        {n.label}
      </NavLink>
    </li>
  );

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
              <li className="nav-heading" role="presentation">
                Workspace
              </li>
              {NAV.map(item)}
              {user.isAdmin && (
                <>
                  <li className="nav-heading nav-admin" role="presentation">
                    Admin
                  </li>
                  {ADMIN_NAV.map(item)}
                </>
              )}
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
                {hasPassword ? 'Change password' : 'Set a password'}
              </button>
              {user.oidcLinked ? (
                <button type="button" className="btn btn-block" onClick={() => void unlink()}>
                  Unlink {config?.oidc?.label || 'single sign-on'}
                </button>
              ) : (
                config?.oidc?.enabled && (
                  <button type="button" className="btn btn-block" onClick={() => void link()}>
                    Link {config.oidc.label}
                  </button>
                )
              )}
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
      <ChangePasswordDialog open={pwOpen} hasPassword={hasPassword} onClose={() => setPwOpen(false)} />
    </div>
  );
}
