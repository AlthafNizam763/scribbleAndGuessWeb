'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useGame } from '@/web/GameProvider';
import { PageShell, ListState } from '@/web/components/PageShell';
import { Avatar } from '@/web/components/ui';
import type { RoomInvitationDto } from '@/web/types';

/**
 * The invitations inbox.
 *
 * ## Why this page holds no list of its own
 *
 * The invitations live on the provider, because three things need them at
 * once: this page, the count on the home screen, and the toast that interrupts
 * for a new one. A copy fetched here would be a fourth that could disagree
 * with all three — and would go stale the moment a push arrived while the page
 * was open, which is precisely the case the feature exists for.
 *
 * So this renders provider state and asks it to refresh on mount. Real-time
 * arrivals need no work here at all: the socket handler updates the provider
 * and this re-renders.
 */
export default function RoomInvitationsPage() {
  const router = useRouter();
  const { invitations, busy, acceptInvitation, rejectInvitation, refreshInvitations } = useGame();

  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void refreshInvitations().finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [refreshInvitations]);

  async function handleAccept(invitation: RoomInvitationDto) {
    setActingId(invitation.id);
    try {
      const code = await acceptInvitation(invitation);
      router.push(`/room/${code}`);
    } catch {
      // `Room is full`, `Game already started`, `Invitation expired` — the
      // provider has already put the server's own sentence in the banner, and
      // re-read the inbox, so the spent row is on its way out.
    } finally {
      setActingId(null);
    }
  }

  return (
    <PageShell title="Invitations">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Waiting for an answer</h2>
          <span className="spacer" />
          <button
            type="button"
            className="btn--ghost"
            onClick={() => {
              setLoading(true);
              void refreshInvitations().finally(() => setLoading(false));
            }}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <ListState
          loading={loading && invitations.length === 0}
          error={null}
          empty={invitations.length === 0}
          emptyText="No invitations right now. A friend can invite you from their room lobby."
        />

        {invitations.length > 0 ? (
          <ul className="rows" style={{ marginTop: '0.75rem' }}>
            {invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                busy={busy || actingId === invitation.id}
                onAccept={() => handleAccept(invitation)}
                onReject={() => void rejectInvitation(invitation)}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </PageShell>
  );
}

/**
 * One invitation, with everything the brief says it must show.
 *
 * The occupancy and status on it are a snapshot taken when the list was read,
 * so they are shown as information and not as permission: Accept stays enabled
 * even for a room that looks full, because the server decides that on the way
 * in and says so in terms written for the player. The one exception is a room
 * already known to be gone, where there is nothing left to be refused by.
 */
function InvitationRow({
  invitation,
  busy,
  onAccept,
  onReject,
}: {
  invitation: RoomInvitationDto;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const inviter = invitation.inviter;
  const isClosed = invitation.roomStatus === 'closed';
  // Anything past `waiting` — starting, playing, a round result, finished — is
  // a match already under way, and the server refuses all of them alike.
  const hasStarted = !isClosed && invitation.roomStatus !== 'waiting';
  const isFull =
    invitation.playerCount !== null && invitation.playerCount >= invitation.maxPlayers;

  const note = isClosed
    ? 'Room is closed'
    : hasStarted
      ? 'Game already started'
      : isFull
        ? 'Room is full'
        : null;

  return (
    <li className="row-card">
      <Avatar
        name={inviter?.username ?? '?'}
        colorIndex={inviter?.avatarColorIndex ?? 0}
      />

      <span className="row-card__main">
        <span className="row-card__title">
          {inviter?.username ?? 'Someone'} invited you
        </span>
        <span className="row-card__detail">
          Room {invitation.roomCode} ·{' '}
          {invitation.playerCount ?? '—'}/{invitation.maxPlayers} players ·{' '}
          {invitation.isPublic ? 'Public' : 'Private'}
        </span>
      </span>

      {note ? <span className="badge badge--warn">{note}</span> : null}

      <button type="button" className="btn--primary" onClick={onAccept} disabled={busy || isClosed}>
        Accept
      </button>
      <button type="button" className="btn--ghost" onClick={onReject} disabled={busy}>
        Reject
      </button>
    </li>
  );
}
