import { Link, useRouteError } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="page">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Go to the dashboard</Link>
      </p>
    </div>
  );
}

/** Router errorElement: a render crash shows this instead of a blank page. */
export function RouteErrorPage() {
  const err = useRouteError();
  console.error(err);
  return (
    <main className="auth-page">
      <div className="card auth-card stack">
        <h1>Something went wrong</h1>
        <p className="muted">{err instanceof Error ? err.message : 'Unexpected error.'}</p>
        <a className="btn btn-primary btn-block" href="/">
          Reload
        </a>
      </div>
    </main>
  );
}
