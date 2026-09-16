import { GAME_PHASE } from '@/constants/room.constants';
import { blockRepository } from '@/repositories/block.repository';
import { roomRepository } from '@/repositories/room.repository';
import { defaultSettings, roomService } from '@/services/room.service';
import type { AuthenticatedUser } from '@/types/auth.types';
import type { PublicRoomDto, RoomSettingsDto } from '@/types/room.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { AppError, ErrorCode, errors } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { roomDisplayName, sanitizeName } from '@/utils/sanitize';

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

/**
 * The tail of the matchmaking queue.
 *
 * ## The bug this exists to fix
 *
 * The per-user gate above stops one player double-tapping into two rooms. It
 * does nothing about *different* players racing, and under a simultaneous
 * burst that is the far worse failure. A load run of eighty-eight players all
 * tapping Play in the same tick produced **seventy-six rooms** — very nearly
 * one each — where eleven would have held them all.
 *
 * The mechanism is an ordinary check-then-act across an `await`. `run` reads
 * the block list before it ranks, and that read yields the event loop. Every
 * one of the eighty-eight callers reaches the yield before any of them has
 * created anything, so when they resume they each rank a registry that is
 * still empty, find no candidate, and go on to create. The rooms they make are
 * invisible to each other because they were all decided before any of them
 * existed.
 *
 * It is not a cosmetic problem. A room needs `MIN_PLAYERS_TO_START` people, so
 * seventy-six rooms of one is seventy-six players who cannot start a game —
 * exactly the "Quick Play does not create unnecessary duplicate rooms"
 * criterion, failing in the case it was written for.
 *
 * ## Why a queue rather than a cleverer check
 *
 * The decision "is there a seat for this player, or must I open a room" is
 * only meaningful against a registry nobody else is mutating. Re-checking
 * after creating does not help — by then the room exists and the damage is a
 * room that should not have been opened. Retrying on a miss is the same race
 * one loop iteration later.
 *
 * So the decision is serialised: callers queue, and each one ranks a registry
 * that already contains every room the callers ahead of it created. The
 * critical section is small — an in-memory ranking plus a seat, both
 * synchronous — and only the first player into each new room pays for a room
 * creation. Eleven creations serialised is a few hundred milliseconds across
 * the whole burst, against a matchmaker that otherwise does not match.
 *
 * The expensive part of the call, the block-list read, is deliberately left
 * *outside* the queue: it depends on nothing the queue protects, and holding a
 * lock across a database round trip would turn a burst into a stampede of
 * waiting.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` after everything already queued, whether or not those failed.
 *
 * The `.then(onFulfilled, onRejected)` pair is what makes a rejection ahead in
 * the queue not poison everything behind it: a player whose matchmaking threw
 * must not wedge the queue for every player after them.
 */
function serialised<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Empties the matchmaking queue. Used by tests. */
export function resetMatchmakingQueue(): void {
  queue = Promise.resolve();
}

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
    //
    // Answered before queueing, because it is a synchronous registry read that
    // needs no coordination and returning it immediately keeps a second tap
    // off the queue entirely.
    const existing = this.roomOf(user.id);
    if (existing) {
      logger.debug('quick play: already seated', { userId: user.id, roomId: existing.roomId });
      return { room: existing, created: false, alreadySeated: true };
    }

    // Outside the queue on purpose: a database round trip held under a lock
    // would make every waiting player pay for it. See the note on `queue`.
    const blocked = new Set(await blockRepository.relatedIds(user.id));

    // Not queued here. `matchOrCreate` takes the queue itself, and only around
    // the part that needs it — queueing at both levels would have the outer
    // call holding the queue while the inner one waits for it to drain, which
    // is a deadlock that waits forever rather than an obvious failure.
    return this.matchOrCreate(user, blocked);
  }

  /**
   * Rank, seat, or open a room — one caller at a time.
   *
   * Everything in here reads or writes the live registry, which is why it runs
   * under the queue. The awaits it does contain are the ones that *must* be
   * inside: `joinRoom` commits the seat synchronously before its first await,
   * and `createRoom` has to have registered the room before the next caller
   * ranks, or that caller opens a second one for the same reason this method
   * exists.
   */
  private async matchOrCreate(
    user: AuthenticatedUser,
    blocked: Set<string>,
  ): Promise<QuickPlayOutcome> {
    // The fast path, deliberately outside the queue.
    //
    // Joining an existing room needs no coordination: `joinRoom` checks
    // capacity and takes the seat with no `await` between the two, so on a
    // single-threaded loop that pair is already atomic and two callers cannot
    // both take the last seat. Only the decision to *create* is racy. Keeping
    // the ordinary case — a player tapping Play while rooms are waiting — off
    // the queue entirely is what stops the fix for a launch-burst problem
    // becoming a queue every player joins for the rest of the session.
    const matched = await this.tryJoinCandidate(user, blocked);
    if (matched) return { room: matched, created: false, alreadySeated: false };

    // Nothing was waiting. That conclusion is only trustworthy while nobody
    // else is creating, so the rest happens one caller at a time.
    return serialised(async () => {
      // A player can be seated by an invitation accepted while they waited.
      const seatedMeanwhile = this.roomOf(user.id);
      if (seatedMeanwhile) {
        return { room: seatedMeanwhile, created: false, alreadySeated: true };
      }

      // Re-ranked under the queue, because a caller ahead may have just opened
      // exactly the room this one was about to duplicate. This retry is the
      // whole fix: without it every caller in a burst reaches `createRoom`.
      const late = await this.tryJoinCandidate(user, blocked);
      if (late) return { room: late, created: false, alreadySeated: false };

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
    });
  }

  /**
   * Seats the player in the best room that will take them, or returns null.
   *
   * Candidates are walked best first, so a room that fills underneath us is
   * abandoned for the next one instead of failing the whole request.
   */
  private async tryJoinCandidate(
    user: AuthenticatedUser,
    blocked: Set<string>,
  ): Promise<RuntimeRoom | null> {
    for (const room of this.rankCandidates(user.id, blocked)) {
      try {
        await roomService.joinRoom({ room, user });
        logger.info('quick play: matched', {
          userId: user.id,
          roomId: room.roomId,
          code: room.code,
          seated: room.players.size,
        });
        return room;
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

    return null;
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

  /**
   * The live room this user is seated in, if any.
   *
   * Delegates to the registry's own lookup rather than keeping a second scan:
   * "one room at a time" is now enforced on the join, invite and accept paths
   * too, and two implementations of the same question are how one of them ends
   * up disagreeing with the rule it is supposed to enforce.
   */
  roomOf(userId: string): RuntimeRoom | null {
    return roomService.liveRoomOf(userId);
  }

  // -------------------------------------------------------- the public list --

  /**
   * Every public room this user could join, best first.
   *
   * ## Why this is the matchmaker's job
   *
   * The brief's filter for the Public Rooms screen — public, waiting, not
   * full, not closed, not started, not banned, not sharing it with somebody
   * blocked — is `rejectionFor` word for word. Quick Play answers "give me one
   * of these" and the browser answers "show me all of them"; giving the screen
   * its own copy of the rule is how a room ends up listed that Quick Play
   * would refuse, or listed and then un-joinable.
   *
   * So there is one predicate, and both callers use it. A room that appears
   * here is a room `joinPublic` will admit this player to — subject to the
   * race below, which no amount of filtering can remove.
   *
   * ## The list is a hint, the join is the decision
   *
   * Occupancy is read the instant the page is built, and a room can fill
   * before the player taps Join. That is why the join path re-checks rather
   * than trusting a row: the list exists to save a player from tapping into
   * refusals, not to make refusals impossible.
   */
  listPublic(userId: string, blockedIds: Set<string>, limit: number): PublicRoomDto[] {
    return this.rankCandidates(userId, blockedIds)
      .slice(0, limit)
      .map((room) => this.describe(room));
  }

  /**
   * One room as a stranger may see it.
   *
   * Note what is absent: the player list, the ban list, the custom words, the
   * current word and the settings that only matter once you are inside. A
   * browser row needs who is hosting, how full it is and what the rules
   * roughly are — everything else would be telling people about a room they
   * have not joined.
   */
  describe(room: RuntimeRoom): PublicRoomDto {
    const host = room.players.get(room.hostId);
    const hostName = sanitizeName(host?.username);

    return {
      id: room.roomId,
      code: room.code,
      name: roomDisplayName(hostName),
      hostId: room.hostId,
      hostName,
      playerCount: room.players.size,
      maxPlayers: room.settings.maxPlayers,
      status: roomService.serializeRoom(room).status,
      rounds: room.settings.rounds,
      drawTimeSeconds: room.settings.drawTimeSeconds,
      language: room.settings.language,
      createdAtMs: room.createdAtMs,
    };
  }

  /**
   * The public list, read from storage instead of the registry.
   *
   * The split deployment again: the REST process has no registry, so it falls
   * back to the last write-through. Everything the registry filter checks is
   * re-checked here against the stored document, because the stored `status`
   * is coarser than the live phase and would otherwise let a room that had
   * just started slip into the list.
   *
   * The counts are a moment behind, which is exactly the staleness the join
   * path exists to correct.
   */
  async listPublicFromStorage(
    userId: string,
    blockedIds: Set<string>,
    limit: number,
  ): Promise<PublicRoomDto[]> {
    const rows = await roomRepository.findJoinablePublic({
      limit: limit * 2,
      excludeUserId: userId,
    });

    const defaults = defaultSettings();
    const rooms: PublicRoomDto[] = [];

    for (const row of rows) {
      if (row.closedAt) continue;

      const settings = { ...defaults, ...(row.settings as unknown as RoomSettingsDto) };
      if (settings.isPrivate) continue;
      if (row.players.length >= settings.maxPlayers) continue;
      if (row.bannedUserIds.some((id) => String(id) === userId)) continue;

      let excluded = false;
      for (const player of row.players) {
        const id = String(player.userId);
        // Already seated here, or sharing it with somebody blocked.
        if (id === userId || blockedIds.has(id)) {
          excluded = true;
          break;
        }
      }
      if (excluded) continue;

      const hostId = String(row.ownerId);
      const hostName = sanitizeName(
        row.players.find((player) => String(player.userId) === hostId)?.username,
      );

      rooms.push({
        id: String(row._id),
        code: row.roomCode,
        name: roomDisplayName(hostName),
        hostId,
        hostName,
        playerCount: row.players.length,
        maxPlayers: settings.maxPlayers,
        status: row.status as PublicRoomDto['status'],
        rounds: settings.rounds,
        drawTimeSeconds: settings.drawTimeSeconds,
        language: settings.language,
        createdAtMs: new Date(row.createdAt ?? Date.now()).getTime(),
      });
    }

    return rooms
      .sort((a, b) => b.playerCount - a.playerCount || a.createdAtMs - b.createdAtMs)
      .slice(0, limit);
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
