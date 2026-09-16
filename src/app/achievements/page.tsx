'use client';

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '@/web/api';
import { useGame } from '@/web/GameProvider';
import { PageShell, ListState } from '@/web/components/PageShell';
import { fetchProgression, type ProgressionDto } from '@/web/progression';

/**
 * The trophy case, with the XP bar above it.
 *
 * ## Why locked entries are shown
 *
 * The catalogue is a list of things to aim at, not only a record of what has
 * been done. A player who has unlocked nothing should still see twelve cards
 * with progress on them — which is also the only way the countable ones
 * ("43 / 100 guesses") mean anything.
 *
 * ## Nothing here is computed
 *
 * The level, the XP, the progress fractions and the unlock state all arrive
 * from the server. This page renders them. That is what keeps the level shown
 * here the same as the one the leaderboard sorts by.
 */
export default function AchievementsPage() {
  const { session } = useGame();

  const [progression, setProgression] = useState<ProgressionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;

    setLoading(true);
    setError(null);
    try {
      setProgression(await fetchProgression(session.token));
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.friendlyMessage : 'Could not load your progress.',
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const level = progression?.level;
  const items = progression?.achievements.items ?? [];

  // Unlocked first, then by how close the rest are — so somebody scrolling
  // meets what they nearly have before what they have barely started.
  const sorted = [...items].sort((a, b) => {
    if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
    return b.progress / b.target - a.progress / a.target;
  });

  return (
    <PageShell title="Achievements">
      {level ? (
        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0 }}>
              Level {level.level} · {level.title}
            </h2>
            <span className="spacer" />
            <span className="muted">
              {level.isMaxLevel
                ? `${level.xp} XP`
                : `${level.xpIntoLevel} / ${level.xpForNextLevel} XP`}
            </span>
          </div>

          <div
            role="progressbar"
            aria-valuenow={Math.round(level.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
              marginTop: '0.6rem',
              height: '12px',
              border: '2px solid currentColor',
              borderRadius: '6px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.round(level.progress * 100)}%`,
                height: '100%',
                background: '#46d18a',
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>
            {progression
              ? `${progression.achievements.unlockedCount} of ${progression.achievements.totalCount} unlocked`
              : 'Achievements'}
          </h2>
          <span className="spacer" />
          <button type="button" className="btn--ghost" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <ListState
          loading={loading && items.length === 0}
          error={items.length === 0 ? error : null}
          empty={items.length === 0}
          emptyText="No achievements to show yet."
          onRetry={load}
        />

        {sorted.length > 0 ? (
          <ul className="rows" style={{ marginTop: '0.75rem' }}>
            {sorted.map((entry) => (
              <li
                key={entry.key}
                className="row-card"
                style={{ opacity: entry.unlocked ? 1 : 0.7 }}
              >
                <span className="avatar" aria-hidden="true">
                  {entry.unlocked ? '🏅' : '🔒'}
                </span>
                <span className="row-card__main">
                  <h3 style={{ margin: 0, fontWeight: entry.unlocked ? 700 : 500 }}>
                    {entry.name}
                  </h3>
                  <span className="row-card__detail">
                    {entry.description}
                    {entry.showProgress && !entry.unlocked
                      ? ` · ${entry.progress} / ${entry.target}`
                      : ''}
                  </span>
                </span>
                <span className="muted">+{entry.xpReward} XP</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <p className="muted" style={{ fontSize: '0.8rem' }}>
        XP and achievements are awarded by the server when a match finishes.
        Abandoned games pay nothing.
      </p>
    </PageShell>
  );
}
