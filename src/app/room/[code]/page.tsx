'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { useGame } from '@/web/GameProvider';
import { GameView } from '@/web/components/GameView';
import { Lobby } from '@/web/components/Lobby';
import { ConnectionPill, FailureBanner, NoticeBanner } from '@/web/components/ui';

/**
 * One room, from lobby to final scores.
 *
 * ## Why the room is rejoined rather than required
 *
 * The URL carries the code, so this page can be arrived at cold: a reload, a
 * second tab, a pasted link. Rather than bouncing those to the home screen it
 * joins by code, which is the same request the join form makes and reaches the
 * same seat — the server recognises a returning member and restores them
 * instead of adding a duplicate.
 *
 * The attempt is guarded by a ref rather than by state. `joinRoom` updates
 * context, which re-renders this page, and an unguarded effect would read the
 * new state and join again — once per broadcast, forever.
 */
export default function RoomPage() {
  const router = useRouter();
  const params = useParams<{ code: string }>();
  const code = (params?.code ?? '').toUpperCase();

  const { session, room, connection, failure, notice, joinRoom, clearFailure, clearNotice } =
    useGame();

  /** The code this page has already tried to join. */
  const attempted = useRef<string | null>(null);

  /** Whether this page ever held the room, which decides what "no room" means. */
  const wasSeated = useRef(false);

  // No session means the browser arrived here without passing the name prompt.
  // The home screen owns that, so send them there rather than duplicating it.
  useEffect(() => {
    if (!session) router.replace('/');
  }, [session, router]);

  useEffect(() => {
    if (!session || connection !== 'connected') return;
    if (room?.code === code) return;
    if (attempted.current === code) return;

    attempted.current = code;
    joinRoom(code).catch(() => {
      // The banner shows why. Staying here with the failure visible is more
      // useful than a redirect that discards it.
    });
  }, [session, connection, room, code, joinRoom]);

  // Leaving, being kicked and the room closing all end the same way: the room
  // goes null. Once this page has actually held it, that can only mean the
  // seat is gone, so there is nothing left here to render and the home screen
  // is where the player belongs. Keyed off having been seated rather than off
  // the notice, because leaving deliberately sets no notice — and without this
  // the Leave button would drop the player on a permanent "Joining…" screen,
  // since the join guard has already fired for this code.
  useEffect(() => {
    if (room?.code === code) wasSeated.current = true;
    else if (wasSeated.current && room === null) router.replace('/');
  }, [room, code, router]);

  if (!session) return null;

  return (
    <main className="page">
      <div className="brand">
        <h1>Scribble &amp; Guess</h1>
        <span className="spacer" />
        <ConnectionPill state={connection} />
      </div>

      <NoticeBanner notice={notice} onDismiss={clearNotice} />
      <FailureBanner failure={failure} onDismiss={clearFailure} />

      {!room ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {connection === 'connected' ? `Joining ${code}…` : 'Connecting to the game server…'}
          </p>
          {failure ? (
            <button
              type="button"
              className="btn--primary"
              style={{ marginTop: '1rem' }}
              onClick={() => router.replace('/')}
            >
              Back to home
            </button>
          ) : null}
        </div>
      ) : room.status === 'waiting' ? (
        <Lobby room={room} />
      ) : (
        <GameView room={room} />
      )}
    </main>
  );
}
