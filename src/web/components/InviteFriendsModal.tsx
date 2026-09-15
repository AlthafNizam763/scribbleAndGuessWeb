'use client';

import { useCallback, useEffect, useState } from 'react';

import { useGame } from '@/web/GameProvider';
import { ApiError } from '@/web/api';
import { ListState } from '@/web/components/PageShell';
import { Avatar } from '@/web/components/ui';
import { fetchInviteCandidates } from '@/web/rooms';
import type { InviteCandidateDto } from '@/web/types';

/**
 * The invite sheet: the caller's friends, annotated for one room.
 *
 * ## Why every button state here is the server's answer
 *
 * A row can be un-invitable for reasons this client cannot see: the friend is
 * blocked in either direction, already holds a seat, already has an unanswered
 * invitation, or the room has filled, started or closed since the sheet was
 * opened. The server decides all of it and sends `canInvite` with a
 * `blockedReason` written for a player to read, so the sheet greys the button
 * and shows that sentence rather than re-deriving the rule and getting a
 * different answer.
 *
 * ## Why a sent row is marked locally
 *
 * An accepted invite does not change the friend row on its own — the list is
 * only re-read when the sheet reopens — so a friend who was just asked would
 * still show an enabled Invite, and a second tap would be refused as a
 * duplicate. Marking the id locally turns that into "Invited" immediately,
 * which is the state the server now holds anyway.
 */
export function InviteFriendsModal({
  roomId,
  onClose,
}: {
  roomId: string;
  onClose: () => void;
}) {
  const { session, inviteFriend } = useGame();

  const [candidates, setCandidates] = useState<InviteCandidateDto[]>([]);
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
      const page = await fetchInviteCandidates(session.token, roomId);
      setCandidates(page.items ?? []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.friendlyMessage : 'Could not load your friends.');
    } finally {
      setLoading(false);
    }
  }, [session, roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape closes, which is the one keyboard affordance a modal owes its user.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleInvite(friend: InviteCandidateDto) {
    setSendingId(friend.id);
    setRowError(null);
    try {
      await inviteFriend(roomId, friend.id);
      setSentIds((ids) => (ids.includes(friend.id) ? ids : [...ids, friend.id]));
    } catch (cause) {
      const message =
        cause instanceof ApiError
          ? cause.friendlyMessage
          : cause instanceof Error
            ? cause.message
            : 'That invitation was not sent.';
      setRowError({ id: friend.id, message });
      // Whatever refused it — the room filled, they joined, somebody blocked
      // somebody — has already made this list wrong, so it is re-read.
      void load();
    } finally {
      setSendingId(null);
    }
  }

  return (
    // The backdrop closes on a click that started and ended on the backdrop
    // itself; `onClick` on the panel would swallow clicks meant for buttons.
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Invite friends">
        <div className="modal__head">
          <h2>Invite friends</h2>
          <span className="spacer" />
          <button type="button" className="btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modal__body">
          <ListState
            loading={loading && candidates.length === 0}
            error={candidates.length === 0 ? error : null}
            empty={candidates.length === 0}
            emptyText="You have no friends to invite yet. Add some from the Friends screen."
            onRetry={load}
          />

          {candidates.length > 0 ? (
            <ul className="rows">
              {candidates.map((friend) => (
                <FriendInviteRow
                  key={friend.id}
                  friend={friend}
                  sent={sentIds.includes(friend.id)}
                  sending={sendingId === friend.id}
                  error={rowError?.id === friend.id ? rowError.message : null}
                  onInvite={() => handleInvite(friend)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One friend row: who they are, whether they are reachable, and one button. */
function FriendInviteRow({
  friend,
  sent,
  sending,
  error,
  onInvite,
}: {
  friend: InviteCandidateDto;
  sent: boolean;
  sending: boolean;
  error: string | null;
  onInvite: () => void;
}) {
  const invited = sent || friend.isInvited;

  const label = friend.isMember
    ? 'Joined'
    : invited
      ? 'Invited'
      : sending
        ? 'Inviting…'
        : 'Invite';

  return (
    <li className="row-card">
      <Avatar name={friend.username} colorIndex={friend.avatarColorIndex} />

      <span className="row-card__main">
        <span className="row-card__title">{friend.username}</span>
        <span className="presence">
          <span className={`dot dot--${friend.isOnline ? 'connected' : 'disconnected'}`} />
          {friend.isOnline ? 'Online' : 'Offline'}
        </span>
        {error ? (
          <span className="row-card__detail" style={{ color: 'var(--bad)' }}>
            {error}
          </span>
        ) : !friend.canInvite && friend.blockedReason && !friend.isMember && !invited ? (
          <span className="row-card__detail">{friend.blockedReason}</span>
        ) : null}
      </span>

      {friend.isMember || invited ? (
        <span className={`badge ${friend.isMember ? 'badge--good' : ''}`}>{label}</span>
      ) : (
        <button
          type="button"
          className={friend.canInvite ? 'btn--primary' : ''}
          onClick={onInvite}
          disabled={sending || !friend.canInvite}
          title={friend.blockedReason ?? undefined}
        >
          {label}
        </button>
      )}
    </li>
  );
}
