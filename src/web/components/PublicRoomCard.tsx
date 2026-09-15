'use client';

import { Avatar, colorIndexFor } from '@/web/components/ui';
import type { PublicRoomDto } from '@/web/types';

/**
 * One row of the public browser.
 *
 * ## Why this greys Join out but does not decide it
 *
 * The row is a snapshot. A room that had a free seat when the list was drawn
 * can fill a moment later, so the server re-checks on join and its refusal is
 * the one that counts. What the disabled state buys is not correctness but
 * quiet: a full room's button should not invite a tap that can only fail.
 *
 * `blockedReason` is the same idea for the caller's own seat. The list already
 * knows they are sitting in another room, so the row says why it will not take
 * them rather than letting them find out from an error banner.
 */
export function PublicRoomCard({
  room,
  blockedReason,
  busy,
  onJoin,
}: {
  room: PublicRoomDto;
  /** Why Join is unavailable, or null when it is offered. */
  blockedReason: string | null;
  busy: boolean;
  onJoin: () => void;
}) {
  const isFull = room.playerCount >= room.maxPlayers;
  const reason = isFull ? 'Room is full' : blockedReason;

  return (
    <li className="row-card">
      <Avatar name={room.hostName} colorIndex={colorIndexFor(room.hostId)} />

      <span className="row-card__main">
        <span className="row-card__title">{room.name}</span>
        <span className="row-card__detail">
          {room.hostName} · {room.rounds} rounds · {room.drawTimeSeconds}s
        </span>
      </span>

      <span className="badge">{room.code}</span>

      <span className={isFull ? 'badge badge--warn' : 'badge badge--good'}>
        {room.playerCount}/{room.maxPlayers}
      </span>

      <button
        type="button"
        className={reason ? '' : 'btn--primary'}
        onClick={onJoin}
        disabled={busy || reason !== null}
        title={reason ?? undefined}
      >
        {isFull ? 'Full' : 'Join'}
      </button>
    </li>
  );
}
