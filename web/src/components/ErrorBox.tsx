import { useEffect, useRef } from 'react';
import { ApiError, lintFromError, type Lint } from '../api.ts';

const LEVELS: Lint['level'][] = ['error', 'warn', 'info'];

/** Lint findings grouped by level. */
export function LintList({ lint }: { lint: Lint[] }) {
  if (lint.length === 0) return <p className="muted">No lint findings.</p>;
  return (
    <div className="lint">
      {LEVELS.map((level) => {
        const rows = lint.filter((l) => l.level === level);
        if (rows.length === 0) return null;
        return (
          <section key={level}>
            <h4 className={`lint-head lint-${level}`}>
              {level} ({rows.length})
            </h4>
            <ul className="lint-rows">
              {rows.map((l, i) => (
                <li key={i}>
                  <code>{l.code}</code> {l.message}
                  {l.path && <span className="muted"> ({l.path})</span>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** A zod issue ({path: [...], message}) or an import skip ({path: 'a/b', reason}). */
interface Issue {
  path?: (string | number)[] | string;
  message?: string;
  reason?: string;
}

/**
 * Inline error: message, plus the lint list (422) or validation issues (400) when present. With
 * `onRetry`, a Retry button: a list page whose load failed keeps its list unknown (never the empty
 * state, which would read as "you have none") and offers to load again.
 */
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would call it as the cleanup.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [error]);
  if (!error) return null;
  const lint = lintFromError(error);
  const issues =
    !lint && error instanceof ApiError && Array.isArray(error.details) ? (error.details as Issue[]) : null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div ref={ref} className="error-box" role="alert">
      <strong>{message}</strong>
      {lint && <LintList lint={lint} />}
      {issues && (
        <ul>
          {issues.map((i, n) => {
            const at = Array.isArray(i.path) ? i.path.join('.') : i.path;
            return (
              <li key={n}>
                {at ? <code>{at}</code> : null} {i.message ?? i.reason ?? JSON.stringify(i)}
              </li>
            );
          })}
        </ul>
      )}
      {onRetry && (
        <p>
          <button type="button" className="btn btn-small" onClick={onRetry}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
