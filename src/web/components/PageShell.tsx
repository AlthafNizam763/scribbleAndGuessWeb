'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useGame } from '@/web/GameProvider';
import { ConnectionPill, FailureBanner, NoticeBanner } from '@/web/components/ui';

/**
 * The frame the browser, inbox and friends screens share.
 *
 * ## Why the session guard lives here
 *
 * All three of these pages are reachable by URL, so all three can be arrived
 * at with no session — a reload, a bookmark, a pasted link. The home screen
 * owns the name prompt, and duplicating it three times would give three places
 * for it to drift. So the rule is the same one `/room/[code]` already applies:
 * no session means go back to the screen that can create one.
 *
 * The redirect runs in an effect rather than during render because navigating
 * while rendering is not allowed; `null` is returned in the meantime so the
 * page never draws its empty state to somebody who is merely signed out.
 */
export function PageShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { session, connection, failure, notice, clearFailure, clearNotice } = useGame();

  useEffect(() => {
    if (!session) router.replace('/');
  }, [session, router]);

  if (!session) return null;

  return (
    <main className="page page--narrow">
      <div className="brand">
        <h1>{title}</h1>
        <span className="spacer" />
        <ConnectionPill state={connection} />
      </div>

      <div className="row" style={{ marginBottom: '1rem' }}>
        <button type="button" className="btn--ghost" onClick={() => router.push('/')}>
          ← Home
        </button>
      </div>

      <NoticeBanner notice={notice} onDismiss={clearNotice} />
      <FailureBanner failure={failure} onDismiss={clearFailure} />

      {children}
    </main>
  );
}

/**
 * The three things a list can be doing instead of showing rows.
 *
 * Kept as one component because the pages that use it must not disagree about
 * the order those are checked in: an error that arrived on a list which
 * already had rows is still an error, and a first load with nothing yet is
 * "Loading", not "None". Deciding that once here is what keeps a screen from
 * flashing "No rooms" for the duration of its own first fetch.
 */
export function ListState({
  loading,
  error,
  empty,
  emptyText,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyText: string;
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <div className="empty">
        <p style={{ marginTop: 0 }}>{error}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  if (loading) return <p className="empty">Loading…</p>;
  if (empty) return <p className="empty">{emptyText}</p>;

  return null;
}
