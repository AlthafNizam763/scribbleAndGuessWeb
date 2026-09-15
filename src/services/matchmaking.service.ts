import { GAME_PHASE } from '@/constants/room.constants';
import { blockRepository } from '@/repositories/block.repository';
import { roomRepository } from '@/repositories/room.repository';
import { defaultSettings, roomService } from '@/services/room.service';
import type { AuthenticatedUser } from '@/types/auth.types';
import type { RoomSettingsDto } from '@/types/room.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { AppError, ErrorCode, errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Quick Play: find a public room worth joining, or open one.
 *
 * ## No second game engine
 *
 * Everything below is matchmaking and nothing else. Seating happens through
 * `roomService.joinRoom` and creating through `roomService.createRoom`, which
 * are the same calls the room code path and the socket handlers make. A room
 * produced by Quick Play is an ordinary room: the same settings shape, the
 * same lobby, the same engine, joinable afterwards by its code like any other.
 *
 * ## Why it reads the live registry rather than Mongo
 *
 * "Is there a seat free" is a question about this instant, and only the
 * in-memory registry knows. Mongo holds the last write-through, which is
 * correct about membership but can be a moment behind, and a matchmaker that
 * sends three players at the last seat of a room is worse than one that takes
 * a fraction longer. The Mongo scan exists as a fallback for the deployment
 * where the REST API runs in a different process from the realtime server and
 * has no registry to read — see `findCandidateDescriptor`.
 *
 * ## What "public" means here
 *
 * This game has no room passwords: a room is either listed and open
 * (`isPrivate: false`) or reachable only by its code (`isPrivate: true`).
 * There is no `password` field on `RoomSettings` to check, and adding one to
 * satisfy a checklist would be inventing a feature. So the brief's "ignore
 * private rooms" and "ignore password-protected rooms" are the same rule here
 * and `isPrivate` is it — which is strictly the safer reading, because a
 * code-only room is exactly what a password-protected one is for.
 */

/** Why a room was rejected, for the debug log. Never sent to a client. */
type Rejection =
  | 'closed'
  | 'private'
  | 'full'
  | 'in_progress'
  | 'finishing'
  | 'banned'
  | 'blocked'
  | 'self';

export interface QuickPlayOutcome {
  room: RuntimeRoom;
  /** Whether a room had to be opened because nothing suitable was waiting. */
  created: boolean;
  /** Whether the player was already seated here before Quick Play ran. */
  alreadySeated: boolean;
}

/**
 * Quick Play requests currently in flight, by user id.
 *
 * ## Why this is needed even though every step is idempotent
 *
 * Two taps a few hundred milliseconds apart both pass the "already in a room"
 * check — neither has seated anybody yet — and then both go on to create a
 * room, because neither found one waiting. The player ends up hosting two
 * empty rooms and sitting in whichever one the client rendered last, while the
 * other lingers until the sweeper closes it.
 *
 * A per-user gate held for the length of the call is the smallest thing that
 * prevents it. Process-local, like every other piece of live state here: a
 * user's sockets are pinned to one process by their connection, and the REST
 * path is idempotent enough that a second process racing it would at worst
 * return the room the first one just made.
 */
const inFlight = new Set<string>();

export class MatchmakingService {
  /**
   * The whole Quick Play flow: reuse, match, or create.
   *
   * Runs against the live registry, so this is the path the socket handler
   * takes and the path that actually seats anybody.
   */
  async quickPlay(user: AuthenticatedUser): Promise<QuickPlayOutcome> {
    if (inFlight.has(user.id)) {
      throw errors.invalidAction('Still finding you a room. One moment.');
    }
    inFlight.add(user.id);

    try {
      return await this.run(user);
    } finally {
      inFlight.delete(user.id);
    }
  }

  private async run(user: AuthenticatedUser): Promise<QuickPlayOutcome> {
    // Already seated somewhere live? Hand that room back rather than moving
    // them. A player who taps Play from a screen they reached mid-game should
    // land back where they were, not be pulled out of a match in progress.
    const existing = this.roomOf(user.id);
    if (existing) {
      logger.debug('quick play: already seated', { userId: user.id, roomId: existing.roomId });
      return { room: existing, created: false, alreadySeated: true };
    }

    const blocked = new Set(await blockRepository.relatedIds(user.id));

    // Every candidate, best first, so a room that fills underneath us can be
    // abandoned for the next one instead of failing the whole request.
    const candidates = this.rankCandidates(user.id, blocked);

    for (const room of candidates) {
      try {
        await roomService.joinRoom({ room, user });
        logger.info('quick play: matched', {
          userId: user.id,
          roomId: room.roomId,
          code: room.code,
          seated: room.players.size,
        });
        return { room, created: false, alreadySeated: false };
      } catch (error) {
        // The room filled, started or closed between ranking and joining.
        // That is the ordinary race this loop exists for; anything else is a
        // real failure and is not swallowed.
        if (isRetryableJoinFailure(error)) {
          logger.debug('quick play: candidate lost', {
            roomId: room.roomId,
            code: AppError.isAppError(error) ? error.code : 'unknown',
          });
          continue;
        }
        throw error;
      }
    }

    const room = await roomService.createRoom({
      owner: user,
      settings: quickPlaySettings(),
    });

    logger.info('quick play: opened a room', {
      userId: user.id,
      roomId: room.roomId,
      code: room.code,
    });

    return { room, created: true, alreadySeated: false };
  }

  /**
   * Live public rooms this user could join, best first.
   *
   * ## The ordering, and why it is not "emptiest first"
   *
   * The best room to be sent to is the one closest to starting: a match needs
   * `MIN_PLAYERS_TO_START` people, and a player dropped into an empty room
   * waits for strangers while a room one short of a game sits beside them. So
   * candidates are ranked by how full they are, descending, among rooms that
   * still have a seat.
   *
   * Ties break on age, oldest first, so a burst of simultaneous Play taps
   * converges on one room instead of spreading across several — and so the
   * ordering is deterministic, which is what makes it testable.
   */
  rankCandidates(userId: string, blockedIds: Set<string>): RuntimeRoom[] {
    const eligible: RuntimeRoom[] = [];

    for (const room of roomService.all()) {
      const rejection = this.rejectionFor(room, userId, blockedIds);
      if (rejection === null) eligible.push(room);
    }

    return eligible.sort(
      (a, b) => b.players.size - a.players.size || a.createdAtMs - b.createdAtMs,
    );
  }

  /**
   * Why this room is not a Quick Play candidate, or null when it is one.
   *
   * Written as one function returning a reason rather than as a chain of
   * `filter` calls so that every rule the brief lists is visible in one place
   * and testable by name.
   */
  rejectionFor(room: RuntimeRoom, userId: string, blockedIds: Set<string>): Rejection | null {
    if (room.closed) return 'closed';

    // Private is the whole gate: see the note on passwords in the file header.
    if (room.settings.isPrivate) return 'private';

    if (room.players.has(userId)) return 'self';
    if (room.bannedIds.has(userId)) return 'banned';
    if (room.players.size >= room.settings.maxPlayers) return 'full';

    // A started match is skipped even though this engine *does* allow joining
    // one. A newcomer mid-match is not in the turn order, so they cannot draw
    // for the rest of the game and spend their first turn watching. That is a
    // fine outcome for somebody who deliberately typed a friend's room code
    // and a poor one for somebody who tapped Play, so Quick Play holds out for
    // a lobby. A paused room counts as a lobby: it is waiting for exactly the
    // player this is about to send it.
    if (room.phase !== GAME_PHASE.lobby && room.phase !== GAME_PHASE.paused) {
      return room.phase === GAME_PHASE.gameEnd ? 'finishing' : 'in_progress';
    }

    // Blocking is symmetric for matchmaking: neither party should be dropped
    // into a voice-and-chat room with the other, and which of them placed the
    // block is not something the matchmaker needs to know.
    for (const seated of room.players.keys()) {
      if (blockedIds.has(seated)) return 'blocked';
    }

    return null;
  }

  /** The live room this user is seated in, if any. */
  roomOf(userId: string): RuntimeRoom | null {
    for (const room of roomService.all()) {
      if (!room.closed && room.players.has(userId)) return room;
    }
    return null;
  }

  // ------------------------------------------------------------- fallback --

  /**
   * A joinable room code, found without the live registry.
   *
   * For the deployment where the REST API and the realtime server are separate
   * processes: there is no registry on the REST side, so the best it can do is
   * name a room from Mongo and let the client join it over the socket, which
   * is where the authoritative checks run anyway.
   *
   * Returns null when nothing suitable is stored, which the caller turns into
   * "create one" — and creating is safe from either process, because the room
   * is written to Mongo before anybody is seated and the socket path hydrates
   * it on the first join.
   */
  async findCandidateDescriptor(
    userId: string,
  ): Promise<{ roomId: string; roomCode: string } | null> {
    const blocked = new Set(await blockRepository.relatedIds(userId));

    const rows = await roomRepository.findJoinablePublic({
      limit: 20,
      excludeUserId: userId,
    });

    const open = rows
      .filter((row) => {
        const maxPlayers = row.settings?.maxPlayers ?? defaultSettings().maxPlayers;
        if (row.players.length >= maxPlayers) return false;

        for (const player of row.players) {
          const id = String(player.userId);
          // Already seated here, or sharing it with somebody blocked.
          if (id === userId || blocked.has(id)) return false;
        }
        return true;
      })
      .sort((a, b) => b.players.length - a.players.length);

    const best = open[0];
    return best ? { roomId: String(best._id), roomCode: best.roomCode } : null;
  }
}

/**
 * The settings a Quick Play room opens with.
 *
 * The app defaults, with `isPrivate` stated rather than inherited. It is the
 * one field whose value is load-bearing here — a private Quick Play room would
 * be invisible to the next person who taps Play, so every Quick Play room
 * would be a room of one — and writing it out means a future change to
 * `ROOM_DEFAULTS.isPrivate` cannot quietly break matchmaking.
 *
 * Everything else is deliberately the ordinary default: eight players, three
 * rounds, eighty seconds, English, the normal word mode and the full category
 * pool. Quick Play is meant to be the game as it comes.
 */
export function quickPlaySettings(): RoomSettingsDto {
  return { ...defaultSettings(), isPrivate: false };
}

/**
 * Whether a failed join means "try the next room" rather than "give up".
 *
 * These are the three ways a candidate can go stale between being ranked and
 * being joined, and all of them are ordinary: somebody else took the last
 * seat, the host started the game, or the room emptied and closed. Anything
 * else — a database failure, a bug — must not be silently retried against
 * another room.
 */
function isRetryableJoinFailure(error: unknown): boolean {
  if (!AppError.isAppError(error)) return false;

  return (
    error.code === ErrorCode.ROOM_FULL ||
    error.code === ErrorCode.ROOM_NOT_FOUND ||
    error.code === ErrorCode.GAME_ALREADY_STARTED ||
    error.code === ErrorCode.INVALID_ACTION ||
    error.code === ErrorCode.PLAYER_BANNED
  );
}

/** Clears the in-flight gate. Used by tests. */
export function resetQuickPlayGate(): void {
  inFlight.clear();
}

export const matchmakingService = new MatchmakingService();
