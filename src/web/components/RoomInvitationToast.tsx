'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import { useGame } from '@/web/GameProvider';
import { Avatar } from '@/web/components/ui';

/**
 * The interrupt for an invitation that arrived just now.
 *
 * ## Why this is mounted in the layout
 *
 * The brief's requirement is that an online friend sees the invitation
 * "immediately without refreshing" — which means wherever they happen to be.
 * A toast rendered by the inbox page would only ever appear to somebody
 * already looking at their invitations, who least needs telling. Mounting it
 * beside the provider in the root layout puts it on every screen, and costs
 * nothing on the ones with no invitation to show, where it renders null.
 *
 * ## Why it is suppressed inside that room
 *
 * A player can reach a lobby before the toast is dismissed — accepting from
 * the inbox, or joining by code after being asked. Offering Accept for a room
 * they are already sitting in is noise, so the toast stands down once the
 * live room matches it.
 */
export function RoomInvitationToast() {
  const router = useRouter();
  const pathname = usePathname();
  const { incomingInvitation, room, busy, acceptInvitation, rejectInvitation, dismissIncoming } =
    useGame();

  const [acting, setActing] = useState(false);

  if (!incomingInvitation) return null;
  if (room?.id === incomingInvitation.roomId) return null;

  // The inbox shows the same invitation with the same two buttons; a toast on
  // top of its own row would be a second copy of one decision.
  if (pathname === '/rooms/invitations') return null;

  const inviter = incomingInvitation.inviter;

  async function handleAccept() {
    if (!incomingInvitation) return;

    setActing(true);
    try {
      const code = await acceptInvitation(incomingInvitation);
      router.push(`/room/${code}`);
    } catch {
      // Refused — the provider has put the server's sentence in the banner and
      // cleared the toast, so there is nothing to do here.
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="toast" role="alert">
      <div className="row" style={{ marginBottom: '0.6rem' }}>
        <Avatar
          name={inviter?.username ?? '?'}
          colorIndex={inviter?.avatarColorIndex ?? 0}
        />
        <span className="row-card__main">
          <h3>{inviter?.username ?? 'Someone'} invited you</h3>
          <span className="row-card__detail">
            Room {incomingInvitation.roomCode} ·{' '}
            {incomingInvitation.playerCount ?? '—'}/{incomingInvitation.maxPlayers} ·{' '}
            {incomingInvitation.isPublic ? 'Public' : 'Private'}
          </span>
        </span>
      </div>

      <div className="row row--wrap">
        <button
          type="button"
          className="btn--primary"
          onClick={handleAccept}
          disabled={busy || acting}
        >
          {acting ? 'Joining…' : 'Accept'}
        </button>
        <button
          type="button"
          className="btn--ghost"
          onClick={() => void rejectInvitation(incomingInvitation)}
          disabled={acting}
        >
          Reject
        </button>
        <span className="spacer" />
        <button type="button" className="btn--ghost" onClick={dismissIncoming} disabled={acting}>
          Later
        </button>
      </div>
    </div>
  );
}
