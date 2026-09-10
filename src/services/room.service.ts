import { ROOM_DEFAULTS, TIMING } from '@/constants/game.constants';
import { CONNECTION, GAME_PHASE, ROOM_STATUS } from '@/constants/room.constants';
import { roomRepository } from '@/repositories/room.repository';
import { userRepository } from '@/repositories/user.repository';
import type { AuthenticatedUser } from '@/types/auth.types';
import type { PlayerDto, RoomDto, RoomSettingsDto } from '@/types/room.types';
import type { RuntimePlayer, RuntimeRoom } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { generateUniqueRoomCode, normalizeRoomCode } from '@/utils/generateRoomCode';
import { logger } from '@/utils/logger';
import { timerService } from '@/services/timer.service';

/**
 * Rooms: the live registry, membership and moderation.
 *
 * ## The registry
 *
 * Live rooms are held in a process-local `Map` and mirrored into Mongo on
 * every change worth surviving a restart. The map is the authority while the
 * process is up — see the note on `RuntimeRoom` in `types/socket.types.ts` for
 * why — and it is parked on `globalThis` so a Next.js hot reload in
 * development does not orphan every room mid-game.
 *
 * ## What this service does not do
 *
 * It does not run the game. Turn order, words, scoring and phase transitions
 * all live in `game.service.ts`. This file owns who is in a room, what the
 * settings are, and who is allowed to stay.
 */

interface Registry {
  byId: Map<string, RuntimeRoom>;
  /** Room code (upper case) to room id, so a join is a lookup not a scan. */
  byCode: Map<string, string>;
}

const globalRegistry = globalThis as typeof globalThis & {
  __scribbleRooms?: Registry;
};

const registry: Registry = (globalRegistry.__scribbleRooms ??= {
  byId: new Map(),
  byCode: new Map(),
});

/** The default settings a room starts with. */
export function defaultSettings(): RoomSettingsDto {
  return {
    maxPlayers: ROOM_DEFAULTS.maxPlayers,
    rounds: ROOM_DEFAULTS.rounds,
    drawTimeSeconds: ROOM_DEFAULTS.drawTimeSeconds,
    wordChoiceCount: ROOM_DEFAULTS.wordChoiceCount,
    hintCount: ROOM_DEFAULTS.hintCount,
    wordSelectSeconds: ROOM_DEFAULTS.wordSelectSeconds,
    wordMode: 'normal',
    language: 'en',
    categories: [],
    customWords: [],
    allowVoteKick: ROOM_DEFAULTS.allowVoteKick,
    isPrivate: ROOM_DEFAULTS.isPrivate,
  };
}

export class RoomService {
  // -------------------------------------------------------------- registry --

  get(roomId: string): RuntimeRoom | null {
    return registry.byId.get(roomId) ?? null;
  }

  /** Throws `ROOM_NOT_FOUND` rather than returning null, for handler use. */
  require(roomId: string): RuntimeRoom {
    const room = this.get(roomId);
    if (!room || room.closed) throw errors.roomNotFound();
    return room;
  }

  getByCode(code: string): RuntimeRoom | null {
    const roomId = registry.byCode.get(normalizeRoomCode(code));
    return roomId ? this.get(roomId) : null;
  }

  /** Every live room. Used by the sweeper and by health reporting. */
  all(): RuntimeRoom[] {
    return [...registry.byId.values()];
  }

  // ------------------------------------------------------------- lifecycle --

  /** Creates a room, seats the creator and makes them host. */
  async createRoom(input: {
    owner: AuthenticatedUser;
    settings: RoomSettingsDto;
  }): Promise<RuntimeRoom> {
    const code = await generateUniqueRoomCode((candidate) =>
      // Both the live map and Mongo are consulted: a room created by another
      // process, or one that outlived a restart, still owns its code.
      registry.byCode.has(candidate)
        ? Promise.resolve(true)
        : roomRepository.isCodeTaken(candidate),
    );

    if (!code) {
      logger.error('exhausted room code attempts');
      throw errors.internal('Could not allocate a room code. Try again.');
    }

    const document = await roomRepository.create({
      roomCode: code,
      ownerId: input.owner.id,
      settings: input.settings,
    });

    const roomId = String(document._id);
    const room: RuntimeRoom = {
      roomId,
      code,
      hostId: input.owner.id,
      createdAtMs: Date.now(),
      settings: input.settings,
      players: new Map(),
      bannedIds: new Set(),
      phase: GAME_PHASE.lobby,
      gameId: null,
      totalRounds: input.settings.rounds,
      currentRound: 0,
      turnOrder: [],
      turnIndex: 0,
      turnNumber: 0,
      usedWords: new Set(),
      round: null,
      board: { strokes: [], redoStack: [] },
      voteKick: null,
      timers: new Map(),
      emptySince: Date.now(),
      closed: false,
    };

    registry.byId.set(roomId, room);
    registry.byCode.set(code, roomId);

    this.seat(room, input.owner);
    await this.persist(room);

    logger.info('room created', { roomId, code, hostId: input.owner.id });
    return room;
  }

  /**
   * Rebuilds a live room from its stored document.
   *
   * Reached when a player reconnects to a room this process has no memory of —
   * after a restart, say. Membership, scores and settings come back; an
   * in-flight round does not, because the board and the countdown only ever
   * existed in memory. The room lands back in the lobby, which is the honest
   * outcome: the alternative is resuming a turn whose drawing is gone.
   */
  async hydrate(roomId: string): Promise<RuntimeRoom | null> {
    const existing = this.get(roomId);
    if (existing) return existing;

    const document = await roomRepository.findById(roomId);
    if (!document || document.closedAt) return null;

    const room: RuntimeRoom = {
      roomId,
      code: document.roomCode,
      hostId: String(document.ownerId),
      createdAtMs: new Date(document.createdAt ?? Date.now()).getTime(),
      settings: { ...defaultSettings(), ...(document.settings as unknown as RoomSettingsDto) },
      players: new Map(),
      bannedIds: new Set(document.bannedUserIds.map(String)),
      phase: GAME_PHASE.lobby,
      gameId: null,
      totalRounds: document.settings?.rounds ?? ROOM_DEFAULTS.rounds,
      currentRound: 0,
      turnOrder: [],
      turnIndex: 0,
      turnNumber: 0,
      usedWords: new Set(),
      round: null,
      board: { strokes: [], redoStack: [] },
      voteKick: null,
      timers: new Map(),
      emptySince: Date.now(),
      closed: false,
    };

    for (const stored of document.players) {
      const userId = String(stored.userId);
      room.players.set(userId, {
        userId,
        username: stored.username,
        avatarId: stored.avatarId,
        avatarColorIndex: stored.avatarColorIndex,
        score: stored.score,
        roundScore: 0,
        isReady: false,
        isMuted: stored.isMuted,
        hasGuessed: false,
        guessOrder: null,
        // Everyone is disconnected until a socket actually shows up.
        connection: CONNECTION.disconnected,
        socketIds: new Set(),
        joinedAt: new Date(stored.joinedAt ?? Date.now()).getTime(),
        lastSeenAt: Date.now(),
        disconnectDeadline: Date.now() + TIMING.reconnectGraceMs,
      });
    }

    registry.byId.set(roomId, room);
    registry.byCode.set(room.code, roomId);

    logger.info('room hydrated from storage', { roomId, code: room.code });
    return room;
  }

  /** Closes a room, cancels its timers and drops it from the registry. */
  async close(room: RuntimeRoom, reason: string): Promise<void> {
    if (room.closed) return;

    room.closed = true;
    timerService.cancelAll(room);

    registry.byId.delete(room.roomId);
    registry.byCode.delete(room.code);

    await roomRepository.markClosed(room.roomId).catch((error: unknown) => {
      logger.exception('failed to mark room closed', error, { roomId: room.roomId });
    });

    logger.info('room closed', { roomId: room.roomId, code: room.code, reason });
  }

  /** Mirrors the live room into Mongo. Failures are logged, never thrown. */
  async persist(room: RuntimeRoom): Promise<void> {
    try {
      await roomRepository.persistRuntime(room);
    } catch (error) {
      // A failed mirror costs durability, not correctness: the live room is
      // still authoritative. Taking down a turn over it would be worse.
      logger.exception('failed to persist room', error, { roomId: room.roomId });
    }
  }

  // ------------------------------------------------------------ membership --

  /** Adds a player to the room's seats. */
  private seat(room: RuntimeRoom, user: AuthenticatedUser): RuntimePlayer {
    const now = Date.now();
    const player: RuntimePlayer = {
      userId: user.id,
      username: user.username,
      avatarId: user.avatarId,
      avatarColorIndex: user.avatarColorIndex,
      score: 0,
      roundScore: 0,
      isReady: false,
      isMuted: false,
      hasGuessed: false,
      guessOrder: null,
      connection: CONNECTION.connected,
      socketIds: new Set(),
      joinedAt: now,
      lastSeenAt: now,
      disconnectDeadline: null,
    };

    room.players.set(user.id, player);
    room.emptySince = null;
    return player;
  }

  /**
   * Seats a player, or restores one who is already a member.
   *
   * Rejoining is not the same as joining: a player who reconnects keeps their
   * score, their seat and whether they already guessed this turn (brief
   * section 38). Only a genuinely new player is subject to the room-full and
   * game-in-progress checks — a member coming back always gets in, because
   * refusing them would punish a dropped connection with the loss of a match.
   */
  async joinRoom(input: {
    room: RuntimeRoom;
    user: AuthenticatedUser;
  }): Promise<{ player: RuntimePlayer; rejoined: boolean }> {
    const { room, user } = input;

    if (room.closed) throw errors.roomNotFound();
    if (room.bannedIds.has(user.id)) throw errors.banned();

    const existing = room.players.get(user.id);
    if (existing) {
      existing.connection = CONNECTION.connected;
      existing.disconnectDeadline = null;
      existing.lastSeenAt = Date.now();
      // Take the current profile: a player who changed their name between
      // sessions should come back under the new one.
      existing.username = user.username;
      existing.avatarId = user.avatarId;
      existing.avatarColorIndex = user.avatarColorIndex;
      room.emptySince = null;

      await this.persist(room);
      return { player: existing, rejoined: true };
    }

    if (room.players.size >= room.settings.maxPlayers) throw errors.roomFull();

    // Mid-match joining is allowed while the game is running but not during
    // the final scoreboard: a player who arrives then would sit through the
    // standings of a game they never played.
    if (room.phase === GAME_PHASE.gameEnd) {
      throw errors.invalidAction('That game is finishing. Try again in a moment.');
    }

    const player = this.seat(room, user);

    // A late arrival is not in the turn order and will not draw this match,
    // but they can guess and score from the next turn on.
    await this.persist(room);
    await userRepository.touch(user.id);

    logger.info('player joined', { roomId: room.roomId, userId: user.id });
    return { player, rejoined: false };
  }

  /**
   * Removes a player outright.
   *
   * Returns whether the room still has anybody in it, so the caller can decide
   * to close it. Host succession happens here rather than at the call site so
   * that every exit path — leaving, being kicked, timing out — leaves a room
   * with a host.
   */
  async removePlayer(room: RuntimeRoom, userId: string): Promise<{ roomEmpty: boolean }> {
    const player = room.players.get(userId);
    if (!player) return { roomEmpty: room.players.size === 0 };

    room.players.delete(userId);
    room.turnOrder = room.turnOrder.filter((id) => id !== userId);

    // A vote to kick somebody who has left is meaningless.
    if (room.voteKick?.targetId === userId) room.voteKick = null;
    room.voteKick?.voterIds.delete(userId);

    if (room.players.size === 0) {
      room.emptySince = Date.now();
      await this.persist(room);
      return { roomEmpty: true };
    }

    // The host left: hand the room to whoever has been here longest, so the
    // room keeps working rather than freezing with nobody able to start.
    if (room.hostId === userId) {
      const successor = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (successor) {
        room.hostId = successor.userId;
        logger.info('host transferred on exit', {
          roomId: room.roomId,
          from: userId,
          to: successor.userId,
        });
      }
    }

    await this.persist(room);
    return { roomEmpty: false };
  }

  // -------------------------------------------------------------- settings --

  /** Replaces the settings. Host only, and only outside a running game. */
  async updateSettings(input: {
    room: RuntimeRoom;
    userId: string;
    settings: RoomSettingsDto;
  }): Promise<void> {
    const { room, userId, settings } = input;

    this.assertHost(room, userId);

    if (room.phase !== GAME_PHASE.lobby && room.phase !== GAME_PHASE.gameEnd) {
      throw errors.gameAlreadyStarted('Settings can only change between games.');
    }

    // Lowering the cap below the people already seated would leave the room
    // over its own limit, so the floor is the current occupancy.
    const maxPlayers = Math.max(settings.maxPlayers, room.players.size);

    room.settings = { ...settings, maxPlayers };
    room.totalRounds = settings.rounds;

    await this.persist(room);
  }

  /** Sets the ready flag for one player. */
  async setReady(room: RuntimeRoom, userId: string, ready: boolean): Promise<void> {
    const player = room.players.get(userId);
    if (!player) throw errors.notMember();

    player.isReady = ready;
    player.lastSeenAt = Date.now();
    await this.persist(room);
  }

  // ------------------------------------------------------------ moderation --

  assertHost(room: RuntimeRoom, userId: string): void {
    if (room.hostId !== userId) throw errors.notOwner();
  }

  assertMember(room: RuntimeRoom, userId: string): RuntimePlayer {
    const player = room.players.get(userId);
    if (!player) throw errors.notMember();
    return player;
  }

  /** Hands the host role to another seated player. */
  async transferHost(room: RuntimeRoom, fromId: string, toId: string): Promise<void> {
    this.assertHost(room, fromId);
    this.assertMember(room, toId);

    room.hostId = toId;
    await this.persist(room);
    logger.info('host transferred', { roomId: room.roomId, from: fromId, to: toId });
  }

  /** Mutes or unmutes a player in chat (brief section 43). */
  async setMuted(room: RuntimeRoom, actorId: string, targetId: string, muted: boolean): Promise<void> {
    this.assertHost(room, actorId);

    const target = this.assertMember(room, targetId);
    if (targetId === actorId) throw errors.invalidAction('You cannot mute yourself.');

    target.isMuted = muted;
    await this.persist(room);
  }

  /** Adds a room-scoped ban (brief section 42). */
  async ban(room: RuntimeRoom, actorId: string, targetId: string): Promise<void> {
    this.assertHost(room, actorId);
    if (targetId === actorId) throw errors.invalidAction('You cannot ban yourself.');

    room.bannedIds.add(targetId);
    await this.removePlayer(room, targetId);
    logger.info('player banned', { roomId: room.roomId, targetId, actorId });
  }

  // ----------------------------------------------------------- serialising --

  /** One seat as the client's `Player` model. */
  serializePlayer(room: RuntimeRoom, player: RuntimePlayer): PlayerDto {
    return {
      id: player.userId,
      name: player.username,
      avatarId: player.avatarId,
      avatarColorIndex: player.avatarColorIndex,
      score: player.score,
      roundScore: player.roundScore,
      isHost: room.hostId === player.userId,
      isDrawing: room.round?.drawerId === player.userId && !room.round.ended,
      isReady: player.isReady,
      hasGuessed: player.hasGuessed,
      guessOrder: player.guessOrder,
      isMuted: player.isMuted,
      connection: player.connection,
    };
  }

  /**
   * The room as the client's `Room` model, for `s:room:state`.
   *
   * Safe to send to anybody: it carries no word, no turn deadline and nothing
   * else a guesser should not see. The secret lives in the game state, which
   * is serialised per recipient instead.
   */
  serializeRoom(room: RuntimeRoom): RoomDto {
    return {
      id: room.roomId,
      code: room.code,
      hostId: room.hostId,
      players: [...room.players.values()].map((player) => this.serializePlayer(room, player)),
      settings: room.settings,
      status: statusFor(room),
      createdAtMs: room.createdAtMs,
      bannedIds: [...room.bannedIds],
    };
  }
}

/** Maps the live phase onto the coarser `RoomStatus` the client reads. */
function statusFor(room: RuntimeRoom) {
  if (room.closed) return ROOM_STATUS.closed;
  switch (room.phase) {
    case GAME_PHASE.lobby:
      return ROOM_STATUS.waiting;
    case GAME_PHASE.starting:
      return ROOM_STATUS.starting;
    case GAME_PHASE.roundEnd:
      return ROOM_STATUS.roundResult;
    case GAME_PHASE.gameEnd:
      return ROOM_STATUS.finished;
    default:
      return ROOM_STATUS.inGame;
  }
}

export const roomService = new RoomService();
