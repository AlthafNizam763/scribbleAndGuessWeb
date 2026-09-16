import { ROOM_DEFAULTS, TIMING } from '@/constants/game.constants';
import { CONNECTION, GAME_PHASE, ROOM_STATUS } from '@/constants/room.constants';
import { invitationRepository } from '@/repositories/invitation.repository';
import { roomRepository } from '@/repositories/room.repository';
import { userRepository } from '@/repositories/user.repository';
import type { AuthenticatedUser } from '@/types/auth.types';
import type { PlayerDto, RoomDto, RoomSettingsDto } from '@/types/room.types';
import type { BotDifficultyWire } from '@/constants/autoTournament.constants';
import { TEAM } from '@/constants/gameModes.constants';
import { emptyChat, emptyMatchStats } from '@/types/socket.types';
import type {
  RuntimePlayer,
  RuntimeRoom,
  RuntimeTournamentBinding,
} from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { generateUniqueRoomCode, normalizeRoomCode } from '@/utils/generateRoomCode';
import { logger } from '@/utils/logger';
import { emitToRoom } from '@/config/socket';
import { SERVER_ROOM_LOCKED } from '@/constants/socket.constants';
import { notifyRoomEvent } from '@/services/room.notify';
import { gameModeService } from '@/services/gameMode.service';
import { spectatorService } from '@/services/spectator.service';
import { timerService } from '@/services/timer.service';
import { voiceService } from '@/services/voice.service';

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
  /**
   * Hydrations currently in flight, by room id.
   *
   * `hydrate` reads the registry, misses, awaits Mongo and then writes the
   * room it built. Two callers racing that — two players reconnecting to the
   * same room after a restart, which is exactly when a restart produces a
   * burst of reconnects — both miss, both build a `RuntimeRoom`, and the
   * second write replaces the first. Any player seated on the first object is
   * then in a room nothing points at any more: their socket is in the channel,
   * the registry disagrees, and they are invisible to everybody.
   *
   * Parking the promise here closes the window. The first caller does the
   * work, every other caller awaits the same result, and they all end up
   * holding one room object.
   */
  hydrating: Map<string, Promise<RuntimeRoom | null>>;
}

const globalRegistry = globalThis as typeof globalThis & {
  __scribbleRooms?: Registry;
};

const registry: Registry = (globalRegistry.__scribbleRooms ??= {
  byId: new Map(),
  byCode: new Map(),
  hydrating: new Map(),
});

// A registry cached from before this field existed — a hot reload across the
// change — would carry the first two maps and not this one.
registry.hydrating ??= new Map();

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
    voiceEnabled: ROOM_DEFAULTS.voiceEnabled,
    chatEnabled: ROOM_DEFAULTS.chatEnabled,
    gameMode: ROOM_DEFAULTS.gameMode,
    allowSpectators: ROOM_DEFAULTS.allowSpectators,
    friendsOnly: ROOM_DEFAULTS.friendsOnly,
    wordDifficulty: ROOM_DEFAULTS.wordDifficulty,
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

  /**
   * The live room this user is seated in, if any.
   *
   * The registry has no user index, so this is a scan — over the rooms this
   * process is holding, which is a handful even under load, and only on the
   * join and invite paths rather than per packet. An index would be a second
   * structure to keep in step with `players`, and the failure mode of getting
   * that wrong is a player who can never join anything again.
   *
   * This is what makes "one room at a time" answerable at all: a seat is held
   * in the registry, not on a socket, so a player who joined over REST and
   * then opened a socket is still, correctly, in one room.
   */
  liveRoomOf(userId: string): RuntimeRoom | null {
    for (const room of registry.byId.values()) {
      if (!room.closed && room.players.has(userId)) return room;
    }
    return null;
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
      voice: { members: new Map() },
      chat: emptyChat(),
      spectators: new Map(),
      locked: false,
      timers: new Map(),
      emptySince: Date.now(),
      closed: false,
      // An ordinary room. A bracket match is built by `createProtectedRoom`
      // below, which is the only thing that ever sets either of these.
      tournament: null,
      allowedUserIds: null,
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

    // Somebody else is already rebuilding this room. Awaiting their result is
    // what stops two callers each building one and the second discarding the
    // first — see the note on `Registry.hydrating`.
    const pending = registry.hydrating.get(roomId);
    if (pending) return pending;

    const attempt = this.hydrateOnce(roomId).finally(() => {
      registry.hydrating.delete(roomId);
    });

    registry.hydrating.set(roomId, attempt);
    return attempt;
  }

  /** The actual rebuild. Only ever one of these in flight per room. */
  private async hydrateOnce(roomId: string): Promise<RuntimeRoom | null> {
    const document = await roomRepository.findById(roomId);
    if (!document || document.closedAt) return null;

    // The read above is the only await, but it is long enough for `createRoom`
    // to have registered this very room in the meantime. Handing back what is
    // in the registry rather than replacing it keeps the live object — and
    // anybody already seated on it — rather than the one just rebuilt from a
    // document that is now behind.
    const raced = this.get(roomId);
    if (raced) return raced;

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
      voice: { members: new Map() },
      chat: emptyChat(),
      spectators: new Map(),
      locked: false,
      timers: new Map(),
      emptySince: Date.now(),
      closed: false,
      // An ordinary room. A bracket match is built by `createProtectedRoom`
      // below, which is the only thing that ever sets either of these.
      tournament: null,
      allowedUserIds: null,
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
        matchStats: emptyMatchStats(),
        team: TEAM.none,
        // A rehydrated room is always an ordinary one. Bracket matches are not
        // recovered across a restart — the scheduler re-opens the match rather
        // than resuming a room whose board and countdown only ever existed in
        // memory — so there is no bot seat to restore here, and defaulting to
        // human is the safe direction: a seat wrongly marked as a bot would be
        // a person quietly denied their own XP.
        isBot: false,
        botDifficulty: null,
        botId: null,
      });
    }

    registry.byId.set(roomId, room);
    registry.byCode.set(room.code, roomId);

    logger.info('room hydrated from storage', { roomId, code: room.code });
    return room;
  }

  /**
   * The live room for a code, hydrating it from storage when necessary.
   *
   * ## Why the join path needs this
   *
   * `getByCode` only knows about rooms *this process* created. That is the
   * right answer almost always — the realtime process owns the registry and
   * every room is born in it — but there are two cases where a perfectly live
   * room is not in the map: it outlived a restart, or it was created by the
   * REST process in a split deployment (Quick Play does exactly that when it
   * cannot reach a registry). In both, the room exists in Mongo, its code is
   * still reserved, and refusing the join with `ROOM_NOT_FOUND` would be
   * wrong.
   *
   * So a miss falls through to storage. A room that is genuinely unknown or
   * closed still resolves to null and still produces the same refusal, so
   * nothing that worked before behaves differently: this only adds an answer
   * where the old one was "no" by accident.
   */
  async resolveByCode(code: string): Promise<RuntimeRoom | null> {
    const live = this.getByCode(code);
    if (live) return live;

    const stored = await roomRepository.findLiveByCode(normalizeRoomCode(code));
    if (!stored || stored.closedAt) return null;

    return this.hydrate(String(stored._id));
  }

  /** Closes a room, cancels its timers and drops it from the registry. */
  async close(room: RuntimeRoom, reason: string): Promise<void> {
    if (room.closed) return;

    room.closed = true;
    timerService.cancelAll(room);

    // Nobody is left to broadcast to, so `reconcile` will never run again for
    // this room. Dropping the voice group here is what stops a closed room's
    // members holding peer connections to each other after the room is gone.
    voiceService.clear(room);

    registry.byId.delete(room.roomId);
    registry.byCode.delete(room.code);

    await roomRepository.markClosed(room.roomId).catch((error: unknown) => {
      logger.exception('failed to mark room closed', error, { roomId: room.roomId });
    });

    // Every unanswered invitation to this room is now an invitation to
    // nowhere. Expiring them here rather than waiting for the sweeper is what
    // stops somebody's inbox showing a room they can tap and only then be told
    // is gone — and it releases the unique-index slot, so the same friend can
    // be invited to whatever room is opened next.
    await invitationRepository.expireForRoom(room.roomId).catch((error: unknown) => {
      logger.exception('failed to expire room invitations', error, {
        roomId: room.roomId,
      });
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
      matchStats: emptyMatchStats(),
      team: TEAM.none,
      // This path seats a *person*: `user` came from an authenticated socket
      // or an authenticated request. A bot never arrives here — see
      // `seatBot` — which is what makes it impossible for a client to obtain
      // a bot seat, whatever it puts in its payload.
      isBot: false,
      botDifficulty: null,
      botId: null,
    };

    room.players.set(user.id, player);
    room.emptySince = null;
    return player;
  }

  /**
   * Seats an AI player.
   *
   * ## Why this is a separate method and not a flag on `joinRoom`
   *
   * `joinRoom` is reachable from a socket and from a REST route; every one of
   * its arguments ultimately comes from a request. A `isBot` parameter on it
   * would be one refactor away from being settable by a caller, and the
   * failure mode is a human seat that scores like a player and is excluded
   * from the leaderboard — or worse, the reverse.
   *
   * This method is not reachable from any handler. It is called by the
   * tournament match service and by nothing else, with a profile the server
   * looked up itself. That is the whole of "clients cannot impersonate bots":
   * not a check, but the absence of a path.
   *
   * ## Why a bot is `connected` with no sockets
   *
   * `connection` drives the minimum-player rule and the reconnect sweep, and a
   * bot must count towards the first and be invisible to the second. It holds
   * no socket ids, so every broadcast helper skips it for free: nothing is
   * ever sent to a bot, including the word.
   */
  seatBot(
    room: RuntimeRoom,
    bot: {
      playerId: string;
      botId: string;
      displayName: string;
      avatarId: number;
      avatarColorIndex: number;
      difficulty: BotDifficultyWire;
    },
  ): RuntimePlayer {
    const now = Date.now();
    const player: RuntimePlayer = {
      userId: bot.playerId,
      username: bot.displayName,
      avatarId: bot.avatarId,
      avatarColorIndex: bot.avatarColorIndex,
      score: 0,
      roundScore: 0,
      isReady: true,
      isMuted: false,
      hasGuessed: false,
      guessOrder: null,
      connection: CONNECTION.connected,
      socketIds: new Set(),
      joinedAt: now,
      lastSeenAt: now,
      disconnectDeadline: null,
      matchStats: emptyMatchStats(),
      team: TEAM.none,
      isBot: true,
      botDifficulty: bot.difficulty,
      botId: bot.botId,
    };

    room.players.set(bot.playerId, player);
    room.emptySince = null;

    logger.info('bot seated', {
      roomId: room.roomId,
      botId: bot.botId,
      difficulty: bot.difficulty,
    });

    return player;
  }

  /**
   * Creates a room only named players may enter.
   *
   * Used by the bracket to open a match. The protection is `allowedUserIds`
   * rather than the existing `locked` flag or a private setting, because those
   * two answer different questions — locked stops *new* arrivals including the
   * ones who are supposed to be here, and private only hides the room from a
   * listing. This is the one that says who the room is for.
   *
   * The host is the first participant. A host is required by the engine — it
   * is who `startGame` is attributed to — but nothing about a bracket match is
   * host-driven: the match service starts it on a deadline, so which seat
   * holds the role has no effect on play.
   */
  async createProtectedRoom(input: {
    ownerId: string;
    settings: RoomSettingsDto;
    allowedUserIds: readonly string[];
    tournament: RuntimeTournamentBinding;
  }): Promise<RuntimeRoom> {
    const code = await generateUniqueRoomCode((candidate) =>
      registry.byCode.has(candidate)
        ? Promise.resolve(true)
        : roomRepository.isCodeTaken(candidate),
    );

    if (!code) {
      logger.error('exhausted room code attempts for a tournament match');
      throw errors.internal('Could not allocate a room code. Try again.');
    }

    const document = await roomRepository.create({
      roomCode: code,
      ownerId: input.ownerId,
      settings: input.settings,
    });

    const roomId = String(document._id);
    const room: RuntimeRoom = {
      roomId,
      code,
      hostId: input.ownerId,
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
      voice: { members: new Map() },
      chat: emptyChat(),
      spectators: new Map(),
      locked: false,
      timers: new Map(),
      emptySince: Date.now(),
      closed: false,
      tournament: input.tournament,
      allowedUserIds: new Set(input.allowedUserIds),
    };

    registry.byId.set(roomId, room);
    registry.byCode.set(code, roomId);

    await this.persist(room);

    logger.info('tournament match room created', {
      roomId,
      code,
      matchId: input.tournament.matchId,
      tournamentId: input.tournament.tournamentId,
    });

    return room;
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

    // A bracket match is for its two participants. Checked before the rejoin
    // branch below, unlike the host's lock, because the two rules differ in
    // kind: a lock is temporary and its own members must still get back in,
    // while somebody outside a pairing is *never* a member of that room and
    // there is no state in which they become one.
    //
    // Refused as "not found" rather than "not allowed": a tournament room's
    // code is guessable in the same way any room code is, and confirming that
    // a guess named a real match would be the one useful thing to learn from
    // guessing.
    if (room.allowedUserIds && !room.allowedUserIds.has(user.id)) {
      logger.warn('refused an outsider at a tournament match room', {
        roomId: room.roomId,
        userId: user.id,
      });
      throw errors.roomNotFound();
    }

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

    // The host's lock. Checked after the rejoin branch above on purpose: a
    // locked room still lets its own people back in after a dropped
    // connection, which is what makes locking safe to use mid-match.
    if (room.locked) {
      throw errors.invalidAction('That room is locked.');
    }

    // The mode's ceiling as well as the room's — a Duo room holds two people
    // however its `maxPlayers` was left.
    if (room.players.size >= gameModeService.seatLimit(room)) throw errors.roomFull();

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

    // The brief's `room:player_joined`. Only for a genuinely new seat: a
    // reconnecting member never left, and announcing their return as an
    // arrival would put a second "joined" line in front of everybody who
    // watched them drop. The `room:updated` snapshot covers that case.
    notifyRoomEvent(room.roomId, 'playerJoined', {
      roomId: room.roomId,
      player: this.serializePlayer(room, player),
      playerCount: room.players.size,
      maxPlayers: room.settings.maxPlayers,
    });

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

    // The brief's `room:player_left`. Emitted here rather than at the four
    // call sites that can remove somebody — leaving, being kicked, timing out,
    // the room closing — because this is the one place all of them pass
    // through, and a fifth exit path added later gets it for free.
    notifyRoomEvent(room.roomId, 'playerLeft', {
      roomId: room.roomId,
      playerId: userId,
      username: player.username,
      playerCount: room.players.size,
      maxPlayers: room.settings.maxPlayers,
    });

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

    const wasSpectatable = room.settings.allowSpectators;

    room.settings = { ...settings, maxPlayers };
    room.totalRounds = settings.rounds;

    // A host switching spectating off means "nobody watches", not "no *new*
    // watchers" — so the gallery is emptied rather than grandfathered.
    if (wasSpectatable && !settings.allowSpectators) {
      spectatorService.clear(room, 'spectating_disabled');
    }

    await this.persist(room);
  }

  /**
   * Locks or unlocks the room against new arrivals. Host only.
   *
   * Distinct from making the room private. Private decides whether it is
   * *listed*; locked decides whether it is *joinable* — so a host can keep a
   * public room in the browser while stopping strangers walking into the game
   * they have already started. Nobody seated is affected either way.
   */
  async setLocked(room: RuntimeRoom, actorId: string, locked: boolean): Promise<void> {
    this.assertHost(room, actorId);

    if (room.locked === locked) return;
    room.locked = locked;

    emitToRoom(room.roomId, SERVER_ROOM_LOCKED, { locked });
    logger.info('room lock changed', { roomId: room.roomId, locked });

    await this.persist(room);
  }

  /**
   * Ends the room for everybody. Host only.
   *
   * A deliberate act, distinct from the sweeper closing an empty room: the
   * host is telling a room full of people that the session is over, so it goes
   * through `close`, which broadcasts the reason and disconnects the seats.
   */
  async endRoom(room: RuntimeRoom, actorId: string): Promise<void> {
    this.assertHost(room, actorId);
    await this.close(room, 'host_ended');
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
      team: player.team,
      isBot: player.isBot,
      botDifficulty: player.botDifficulty,
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
      spectators: spectatorService.serialize(room),
      locked: room.locked,
    };
  }
}

/** Maps the live phase onto the coarser `RoomStatus` the client reads. */
function statusFor(room: RuntimeRoom) {
  if (room.closed) return ROOM_STATUS.closed;
  switch (room.phase) {
    case GAME_PHASE.lobby:
    // A paused match is advertised as waiting, because that is what the room
    // is actually doing and what a prospective joiner needs to know: it has
    // room, it is open, and arriving is what restarts it.
    case GAME_PHASE.paused:
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
