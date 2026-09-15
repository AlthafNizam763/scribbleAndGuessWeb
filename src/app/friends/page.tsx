'use client';

import { useCallback, useEffect, useState } from 'react';

import { useGame } from '@/web/GameProvider';
import { ApiError } from '@/web/api';
import { PageShell, ListState } from '@/web/components/PageShell';
import { Avatar } from '@/web/components/ui';
import { fetchFriends } from '@/web/rooms';
import type { FriendDto } from '@/web/types';

/**
 * The friends list, and a way to pull one of them into the room you are in.
 *
 * ## Why Invite appears here as well as in the lobby
 *
 * The lobby's sheet is the right place to fill a room you are looking at. This
 * is the other direction: you came to see who is around, and one of them
 * should be playing. Both call the same `inviteFriend`, so both are governed
 * by the same server rules — blocked either way, already seated, already
 * asked, room full, game started, room closed. The difference is only that
 * the sheet can grey a button in advance, because it asked for rows annotated
 * for one specific room; here the refusal arrives after the tap and is shown
 * on the row.
 *
 * When the player is in no room there is nothing to invite anybody *to*, so
 * the column is simply absent rather than disabled.
 */
export default function FriendsPage() {
  const { session, room, inviteFriend } = useGame();

  const [friends, setFriends] = useState<FriendDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sentIds, setSentIds] = useState<string[]>([]);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(async () => {
    if (!session) return;

    setLoading(true);
    setError(null);
    try {
      const page = await fetchFriends(session.token);
      setFriends(page.items ?? []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.friendlyMessage : 'Could not load your friends.');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  // A seat given up invalidates the "already invited" marks, which were only
  // ever true of the room being left.
  useEffect(() => {
    setSentIds([]);
    setRowError(null);
  }, [room?.id]);

  async function handleInvite(friend: FriendDto) {
    if (!room) return;

    setSendingId(friend.id);
    setRowError(null);
    try {
      await inviteFriend(room.id, friend.id);
      setSentIds((ids) => (ids.includes(friend.id) ? ids : [...ids, friend.id]));
    } catch (cause) {
      setRowError({
        id: friend.id,
        message:
          cause instanceof ApiError
            ? cause.friendlyMessage
            : cause instanceof Error
              ? cause.message
              : 'That invitation was not sent.',
      });
    } finally {
      setSendingId(null);
    }
  }

  return (
    <PageShell title="Friends">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>
            {friends.length > 0 ? `${friends.length} friends` : 'Friends'}
          </h2>
          <span className="spacer" />
          <button type="button" className="btn--ghost" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <ListState
          loading={loading && friends.length === 0}
          error={friends.length === 0 ? error : null}
          empty={friends.length === 0}
          emptyText="No friends yet. Add people from the Flutter app, then invite them here."
          onRetry={load}
        />

        {friends.length > 0 ? (
          <ul className="rows" style={{ marginTop: '0.75rem' }}>
            {friends.map((friend) => (
              <li key={friend.id} className="row-card">
                <Avatar name={friend.username} colorIndex={friend.avatarColorIndex} />

                <span className="row-card__main">
                  <span className="row-card__title">{friend.username}</span>
                  <span className="row-card__detail">
                    {friend.gamesPlayed} games · {friend.totalScore} points ·{' '}
                    {lastSeenLabel(friend.lastSeenAtMs)}
                  </span>
                  {rowError?.id === friend.id ? (
                    <span className="row-card__detail" style={{ color: 'var(--bad)' }}>
                      {rowError.message}
                    </span>
                  ) : null}
                </span>

                {room ? (
                  sentIds.includes(friend.id) ? (
                    <span className="badge badge--good">Invited</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleInvite(friend)}
                      disabled={sendingId === friend.id}
                    >
                      {sendingId === friend.id ? 'Inviting…' : `Invite to ${room.code}`}
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {!room ? (
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          Open or join a room to invite any of these friends to it.
        </p>
      ) : null}
    </PageShell>
  );
}

/**
 * How long ago somebody was last seen, in the coarsest unit that still says
 * something. Presence is not on this payload — the friends endpoint is a
 * roster, not a live feed — so this is deliberately vague rather than a green
 * dot that would be asserting more than the data supports.
 */
function lastSeenLabel(lastSeenAtMs: number): string {
  if (!lastSeenAtMs) return 'never seen';

  const minutes = Math.floor((Date.now() - lastSeenAtMs) / 60_000);
  if (minutes < 2) return 'online now';
  if (minutes < 60) return `seen ${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `seen ${hours}h ago`;

  return `seen ${Math.floor(hours / 24)}d ago`;
}
