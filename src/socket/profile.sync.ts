import { userRepository } from '@/repositories/user.repository';
import { roomService } from '@/services/room.service';
import type { GameSocket } from '@/types/socket.types';
import { logger } from '@/utils/logger';
import { profileSyncSchema } from '@/validators/auth.validator';

/**
 * Mirroring the device's display profile onto the user row.
 *
 * ## Why this exists
 *
 * A guest account is created by `POST /api/auth/guest` at app launch, before
 * the player has been shown the profile screen — the session has to exist from
 * the first frame because every room seat, score and drawer check is keyed by
 * its id. So the row is born holding a placeholder name and avatar, and the
 * real ones arrive a screen later via `PATCH /api/users/me`.
 *
 * That PATCH is fire-and-forget on the client, by design: a rename must not
 * appear to fail because the network was slow. Which means it can be lost —
 * and when it is, nothing ever corrected the row, so the lobby rendered the
 * placeholder (`Player`, avatar 0) for the rest of that account's life. The
 * client has always attached its profile to `c:hello`, `c:room:create` and
 * `c:room:join` precisely so the server could reconcile; that half was never
 * written. This is it.
 *
 * ## What is synchronised, and what is not
 *
 * Display data only: the name and the two avatar indices. The identity comes
 * from the verified token in the handshake middleware and nothing here can
 * touch it, so a client putting somebody else's `id` in the payload changes
 * nothing (brief section 52). Scores, stats and the auth provider are not
 * parameters of any call below.
 *
 * ## Why it is quiet
 *
 * A payload that does not validate leaves the stored profile alone rather than
 * overwriting it with a default, and a failed write is logged rather than
 * thrown: this runs on the way into a room, and a player must not be refused a
 * game because their name could not be mirrored.
 */

/** The three fields a device owns. */
interface DisplayProfile {
  name?: string;
  avatarId?: number;
  avatarColorIndex?: number;
}

/** Pulls `profile` out of a socket payload, whatever else it carries. */
function extract(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return null;
  const profile = (payload as { profile?: unknown }).profile;
  return profile && typeof profile === 'object' ? profile : null;
}

/**
 * Applies the profile in [payload] to the caller's account, if it differs.
 *
 * Updates the user row, the socket's cached identity and the player's seat in
 * any room they are already in, so the next `s:room:state` carries the new
 * name without a second round trip. Safe to call on every connect: when
 * nothing changed it does not write.
 */
export async function syncSocketProfile(socket: GameSocket, payload: unknown): Promise<void> {
  const raw = extract(payload);
  if (!raw) return;

  const parsed = profileSyncSchema.safeParse(raw);
  if (!parsed.success) {
    logger.debug('handshake profile ignored', {
      userId: socket.data.user.id,
      reason: parsed.error.issues[0]?.message,
    });
    return;
  }

  const user = socket.data.user;
  const incoming: DisplayProfile = parsed.data;

  const patch: DisplayProfile = {};
  if (incoming.name !== undefined && incoming.name !== user.username) {
    patch.name = incoming.name;
  }
  if (incoming.avatarId !== undefined && incoming.avatarId !== user.avatarId) {
    patch.avatarId = incoming.avatarId;
  }
  if (
    incoming.avatarColorIndex !== undefined &&
    incoming.avatarColorIndex !== user.avatarColorIndex
  ) {
    patch.avatarColorIndex = incoming.avatarColorIndex;
  }

  if (Object.keys(patch).length === 0) return;

  const { name, ...avatar } = patch;
  const update = { ...avatar, ...(name === undefined ? {} : { username: name }) };

  try {
    const updated = await userRepository.updateProfile(user.id, update);
    if (!updated) return;

    // The socket's copy is what every handler reads, and what `seat()` stamps
    // onto a new player, so it has to move with the row.
    user.username = updated.username;
    user.avatarId = updated.avatarId;
    user.avatarColorIndex = updated.avatarColorIndex;

    applyToSeat(socket, user.id);

    logger.info('profile synchronised from client', { userId: user.id, fields: Object.keys(update) });
  } catch (error) {
    // Display data. Never worth failing a join over.
    logger.exception('failed to synchronise profile', error, { userId: user.id });
  }
}

/** Copies the refreshed identity onto an already-seated player. */
function applyToSeat(socket: GameSocket, userId: string): void {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const player = roomService.get(roomId)?.players.get(userId);
  if (!player) return;

  player.username = socket.data.user.username;
  player.avatarId = socket.data.user.avatarId;
  player.avatarColorIndex = socket.data.user.avatarColorIndex;
}
