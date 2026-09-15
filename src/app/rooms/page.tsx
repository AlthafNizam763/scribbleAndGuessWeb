'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { useGame } from '@/web/GameProvider';
import { ApiError } from '@/web/api';
import { PageShell, ListState } from '@/web/components/PageShell';
import { PublicRoomCard } from '@/web/components/PublicRoomCard';
import { fetchPublicRooms, leaveRoomById } from '@/web/rooms';
import type { PublicRoomDto } from '@/web/types';

/**
 * The public room browser.
 *
 * ## Why joining goes through the socket and not the REST join
 *
 * `POST /api/rooms/:roomId/join` seats the *account*; it is what the Flutter
 * app calls, and what accepting an invitation calls. But a browser tab also
 * has to get its *connection* into the room, and that only happens on
 * `c:room:join`. Routing to `/room/:code` does exactly that through the join
 * effect the room page already owns — so the path taken here is: look the row
 * up by code, navigate, let the existing machinery seat the socket. One way
 * into a lobby rather than two that can disagree.
 *
 * The list is filtered by the server, not here. Every room it returns is
 * already public, waiting, not full, not closed, and not hosted by somebody
 * who blocked the caller — reapplying any of that in this file would add a
 * second opinion that could only ever be the wrong one.
 */
export default function PublicRoomsPage() {
  const router = useRouter();
  const { session, room, busy, joinRoom, leaveRoom } = useGame();

  const [rooms, setRooms] = useState<PublicRoomDto[]>([]);
  const [current, setCurrent] = useState<{ id: string; code: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;

    setLoading(true);
    setError(null);
    try {
      const page = await fetchPublicRooms(session.token);
      setRooms(page.items ?? []);
      setCurrent(
        page.currentRoomId && page.currentRoomCode
          ? { id: page.currentRoomId, code: page.currentRoomCode }
          : null,
      );
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.friendlyMessage : 'Could not load the room list.',
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The seat the caller already holds, if any.
   *
   * The live room wins over the server's snapshot because it is fresher in the
   * direction that matters: coming back from a lobby the socket has already
   * reported the seat given up, and a stale `currentRoomId` would keep every
   * Join disabled until a refresh.
   */
  const seated = room ? { id: room.id, code: room.code } : current;

  /** Gives up the existing seat so a different room can be joined. */
  async function handleLeaveCurrent() {
    if (!session || !seated) return;

    setError(null);
    try {
      // A room this tab is connected to is left over the socket, which frees
      // the connection as well as the seat. A seat held only on the account —
      // a tab closed mid-game, or the Flutter app still holding it — has no
      // socket here to leave and is released over REST.
      if (room) await leaveRoom();
      else await leaveRoomById(session.token, seated.id);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.friendlyMessage : 'Could not leave that room.');
    } finally {
      setCurrent(null);
      await load();
    }
  }

  async function handleJoin(target: PublicRoomDto) {
    setJoiningId(target.id);
    setError(null);
    try {
      await joinRoom(target.code);
      router.push(`/room/${target.code}`);
    } catch {
      // The provider has put the server's sentence — `Room is full`, `Game
      // already started` — in the banner the shell renders. The list is
      // re-read because whatever refused the join has already made this
      // snapshot wrong.
      void load();
    } finally {
      setJoiningId(null);
    }
  }

  const blockedReason = seated
    ? 'You are already in another room. Leave that room first.'
    : null;

  return (
    <PageShell title="Public rooms">
      {seated ? (
        <div className="banner banner--info" role="status">
          <div className="row row--wrap">
            <span>You are already in another room. Leave that room first.</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn--ghost"
              onClick={() => router.push(`/room/${seated.code}`)}
            >
              Open {seated.code}
            </button>
            <button type="button" className="btn--danger" onClick={handleLeaveCurrent}>
              Leave
            </button>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Open rooms</h2>
          <span className="spacer" />
          <button type="button" className="btn--ghost" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <ListState
          loading={loading && rooms.length === 0}
          error={rooms.length === 0 ? error : null}
          empty={rooms.length === 0}
          emptyText="No public rooms are waiting for players right now. Create one from the home screen."
          onRetry={load}
        />

        {rooms.length > 0 ? (
          <ul className="rows" style={{ marginTop: '0.75rem' }}>
            {rooms.map((entry) => (
              <PublicRoomCard
                key={entry.id}
                room={entry}
                blockedReason={blockedReason}
                busy={busy || joiningId === entry.id}
                onJoin={() => handleJoin(entry)}
              />
            ))}
          </ul>
        ) : null}

        {error && rooms.length > 0 ? (
          <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>
            {error}
          </p>
        ) : null}
      </div>

      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Private rooms are never listed here. Join one with its code from the home screen, or by
        accepting an invitation.
      </p>
    </PageShell>
  );
}
