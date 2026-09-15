'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { useGame } from '@/web/GameProvider';
import { PageShell, ListState } from '@/web/components/PageShell';
import { Avatar } from '@/web/components/ui';
import type { NotificationDto } from '@/web/notifications';

/**
 * The notification centre.
 *
 * ## Why the list comes from the provider rather than a fetch here
 *
 * Three things need it at once — this page, the badge on the home screen, and
 * the push listener that updates both. A fetch owned by this page would leave
 * the badge only ever correct on the page that could already see the list.
 * That is the same argument the invitations inbox makes, one file over.
 *
 * ## What a tap does
 *
 * Marks the row read and, when its type has somewhere to go, goes there. The
 * mark is not conditional on the destination: a type this build does not
 * recognise still counts as read once opened, which is what stops an unknown
 * type from pinning the badge on forever.
 */

/** Where each notification type leads, and what it is drawn with. */
const ROUTES: Record<string, string> = {
  friend_request: '/friends',
  friend_request_accepted: '/friends',
  room_invitation: '/rooms/invitations',
  friend_started_playing: '/rooms',
  friend_joined_room: '/rooms',
};

const GLYPHS: Record<string, string> = {
  friend_request: '👋',
  friend_request_accepted: '🤝',
  room_invitation: '✉️',
  friend_started_playing: '🎮',
  friend_joined_room: '🎮',
  user_joined_room: '🚪',
  game_result: '🏆',
  achievement_unlocked: '🎖️',
  daily_challenge_completed: '✅',
  tournament_announcement: '🚩',
  system_announcement: '📣',
};

/** Renders the age of a timestamp in a glyph or two, like the Flutter client. */
function relativeShort(atMs: number): string {
  const delta = Date.now() - atMs;
  if (delta < 10_000) return 'now';

  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 7)}w`;

  return `${Math.floor(days / 365)}y`;
}

export default function NotificationsPage() {
  const router = useRouter();
  const {
    notifications,
    unreadNotifications,
    refreshNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification,
  } = useGame();

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * The unread filter is applied here rather than re-requested.
   *
   * The page already holds the newest page of rows, and asking the server for
   * the same rows minus the read ones would be a round trip to hide something
   * already on screen. The *count* is still the server's, over the whole
   * inbox — which is why it is read from the provider and not from this list.
   */
  const rows = useMemo(
    () => (unreadOnly ? notifications.filter((row) => !row.isRead) : notifications),
    [notifications, unreadOnly],
  );

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshNotifications();
    } finally {
      setRefreshing(false);
    }
  }

  async function handleOpen(row: NotificationDto) {
    if (!row.isRead) void markNotificationRead(row.id);

    const destination = ROUTES[row.type];
    if (destination) router.push(destination);
  }

  return (
    <PageShell title="Notifications">
      <div className="card">
        <div className="row row--wrap">
          <h2 style={{ margin: 0 }}>
            {unreadNotifications > 0
              ? `${unreadNotifications > 99 ? '99+' : unreadNotifications} unread`
              : 'All caught up'}
          </h2>
          <span className="spacer" />
          <button
            type="button"
            className="btn--ghost"
            onClick={() => setUnreadOnly((value) => !value)}
          >
            {unreadOnly ? 'Show all' : 'Unread only'}
          </button>
          {unreadNotifications > 0 ? (
            <button
              type="button"
              className="btn--ghost"
              onClick={() => void markAllNotificationsRead()}
            >
              Mark all read
            </button>
          ) : null}
          <button
            type="button"
            className="btn--ghost"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <ListState
          loading={false}
          error={null}
          empty={rows.length === 0}
          emptyText={
            unreadOnly
              ? 'Nothing unread.'
              : 'Nothing yet. Friend requests and room invitations show up here.'
          }
        />

        {rows.length > 0 ? (
          <ul className="rows" style={{ marginTop: '0.75rem' }}>
            {rows.map((row) => (
              <li
                key={row.id}
                className="row-card"
                style={{ opacity: row.isRead ? 0.75 : 1 }}
              >
                {row.actor ? (
                  <Avatar
                    name={row.actor.username}
                    colorIndex={row.actor.avatarColorIndex}
                  />
                ) : (
                  <span className="avatar" aria-hidden="true">
                    {GLYPHS[row.type] ?? '🔔'}
                  </span>
                )}

                <button
                  type="button"
                  className="row-card__main btn--ghost"
                  style={{ textAlign: 'left' }}
                  onClick={() => void handleOpen(row)}
                >
                  <h3 style={{ margin: 0, fontWeight: row.isRead ? 500 : 700 }}>
                    {row.title}
                  </h3>
                  <span className="row-card__detail">
                    {row.body} · {relativeShort(row.createdAtMs)}
                  </span>
                </button>

                <button
                  type="button"
                  className="btn--ghost"
                  aria-label={`Delete ${row.title}`}
                  onClick={() => void deleteNotification(row.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Notifications are kept for 30 days. Everything they point at — a friend
        request, an invitation — lives in its own screen and outlives the
        notification.
      </p>
    </PageShell>
  );
}
