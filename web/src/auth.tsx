import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import * as api from './api.ts';

interface AuthState {
  /** undefined while loading, null when logged out. */
  me: api.Me | null | undefined;
  config: api.AuthConfig | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<api.Me | null | undefined>(undefined);
  const [config, setConfig] = useState<api.AuthConfig | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.getMe());
    } catch (e) {
      // 401 is the normal logged-out answer; anything else also leaves us logged out, but say why.
      if (!(e instanceof api.ApiError && e.status === 401)) console.warn('auth/me failed:', api.errorMessage(e));
      setMe(null);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api.getAuthConfig().then(setConfig, () => setConfig(null));
  }, [refresh]);

  // A 401 mid-session drops `me`, so RequireAuth sends the user to /login?next= instead of leaving
  // every action failing with "login or API key required".
  useEffect(() => {
    const ended = () => setMe(null);
    window.addEventListener(api.SESSION_ENDED, ended);
    return () => window.removeEventListener(api.SESSION_ENDED, ended);
  }, []);

  return <AuthContext value={{ me, config, refresh, signOut }}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** The logged-in user; only valid under RequireAuth. */
export function useUser(): api.User {
  const { me } = useAuth();
  if (!me) throw new Error('useUser outside RequireAuth');
  return me.user;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const loc = useLocation();
  if (me === undefined) return <div className="page-loading" role="status">Loading…</div>;
  if (me === null) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return children;
}

/** Only same-app relative paths are honored as ?next= targets (no open redirect). */
export const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
