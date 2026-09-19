import { Types } from 'mongoose';

import { BOT_DIFFICULTY, type BotDifficultyWire } from '@/constants/autoTournament.constants';
import { GAME_CATALOG, gameDefinition } from '@/games/catalog';
import { gameAdapters } from '@/games/adapters';
import { spaceMysteryEngine } from '@/games/spaceMystery/engine';
import type { GameId, PlatformPlayerState, PlatformRoomState } from '@/games/game.types';
import { GameChatMessage } from '@/models/GameChatMessage';
import { GameMatch } from '@/models/GameMatch';
import { GamePlayer } from '@/models/GamePlayer';
import { GameResult } from '@/models/GameResult';
import { GameRoom, type GameRoomDocument, type GameRoomHydrated } from '@/models/GameRoom';
import { XPHistory } from '@/models/XPHistory';
import { botProfileService } from '@/services/bot/botProfile.service';
import { platformBotService } from '@/services/bot/platformBot.service';
import { platformVoiceService } from '@/services/platformVoice.service';
import { xpService } from '@/services/xp.service';
import type { AuthenticatedUser } from '@/types/auth.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { generateUniqueRoomCode, normalizeRoomCode } from '@/utils/generateRoomCode';
import { sanitizeName } from '@/utils/sanitize';

type State = Record<string, unknown>;

/**
 * The reusable room/match coordinator for the four new games. Scribble & Guess
 * intentionally continues through its mature Room/Game services; its card in
 * the same catalogue links to that engine rather than creating a rival room.
 */
export class GamePlatformService {
  /**
   * Pushes a room change to everybody seated in it.
   *
   * ## Why this is injected rather than imported
   *
   * The socket layer imports this service, so importing it back would form a
   * cycle whose behaviour depends on which module Node happens to load first.
   * The same arrangement the bot driver and the Space Mystery engine use, for
   * the same reason.
   *
   * ## Why it exists at all
   *
   * The lobby is REST — creating a room, seating bots, readying up are all
   * HTTP calls — and an HTTP call has no socket, so nothing in it reaches the
   * other people in the room. Without this, a host could add three Stupids and
   * be the only person who could see them, and a match started by the last
   * player to ready up would begin for that player and nobody else.
   *
   * Fire and forget: a seat taken is taken whether or not the broadcast
   * landed, so a failure here is logged and swallowed rather than turned into
   * an error the acting player would have to read.
   */
  private notifier: ((gameId: GameId, roomId: string, event: string) => Promise<void>) | null = null;

  bindNotifier(notify: (gameId: GameId, roomId: string, event: string) => Promise<void>): void {
    this.notifier = notify;
  }

  /** The public door onto [announce], for services that mutate a room. */
  notifyRoom(gameId: GameId, roomId: string, event: string): void {
    this.announce(gameId, roomId, event);
  }

  private announce(gameId: GameId, roomId: string, event: string): void {
    void this.notifier?.(gameId, roomId, event).catch((error: unknown) => {
      logger.exception('broadcasting a platform room change failed', error, { roomId, event });
    });

    // Anything that changed the room may have changed who is allowed to talk
    // — somebody eliminated at the bar, a match finishing. Costs one map
    // lookup in a room where nobody is in voice, which is most of them.
    void platformVoiceService.reconcile(gameId, roomId).catch((error: unknown) => {
      logger.exception('reconciling platform voice failed', error, { roomId });
    });
  }

  definitions() { return GAME_CATALOG; }
  definition(gameId: GameId) { return gameDefinition(gameId); }

  async listRooms(gameId: GameId): Promise<PlatformRoomState[]> {
    const rows = await GameRoom.find({ gameId, status: 'waiting', isPrivate: false, closedAt: null })
      .sort({ createdAt: 1 }).limit(50);
    return rows.map((room) => this.serializeRoom(room));
  }

  async roomSnapshot(gameId: GameId, roomId: string): Promise<PlatformRoomState> {
    return this.serializeRoom(await this.requireRoom(gameId, roomId));
  }

  async createRoom(input: { gameId: GameId; owner: AuthenticatedUser; isPrivate?: boolean; maxPlayers?: number }): Promise<PlatformRoomState> {
    const definition = gameDefinition(input.gameId);
    if (input.gameId === 'SCRIBBLE_GUESS') {
      throw errors.invalidAction('Use the existing Scribble & Guess room flow.');
    }
    const maxPlayers = bounded(input.maxPlayers ?? definition.maxPlayers, definition.minPlayers, definition.maxPlayers);
    const roomCode = await this.newCode();
    const player = humanPlayer(input.owner);
    const room = await GameRoom.create({
      roomCode, gameId: input.gameId, ownerId: input.owner.id, status: 'waiting',
      isPrivate: input.isPrivate === true, maxPlayers, players: [player], matchId: null,
    });
    return this.serializeRoom(room);
  }

  async quickMatch(gameId: GameId, user: AuthenticatedUser): Promise<{ room: PlatformRoomState; created: boolean }> {
    if (gameId === 'SCRIBBLE_GUESS') throw errors.invalidAction('Use the existing Scribble & Guess Quick Play.');
    const definition = gameDefinition(gameId);
    const existing = await this.findSeat(user.id);
    if (existing) return { room: this.serializeRoom(existing), created: false };
    const candidates = await GameRoom.find({ gameId, status: 'waiting', isPrivate: false, closedAt: null })
      .sort({ 'players.length': -1, createdAt: 1 }).limit(30);
    for (const room of candidates) {
      if (room.players.length >= room.maxPlayers) continue;
      await this.addPlayer(room, user);
      return { room: this.serializeRoom(room), created: false };
    }
    return { room: await this.createRoom({ gameId, owner: user, maxPlayers: definition.maxPlayers }), created: true };
  }

  async joinRoom(gameId: GameId, roomIdOrCode: string, user: AuthenticatedUser): Promise<PlatformRoomState> {
    const room = await this.requireRoom(gameId, roomIdOrCode);
    await this.addPlayer(room, user);
    return this.serializeRoom(room);
  }

  async leaveRoom(gameId: GameId, roomId: string, userId: string): Promise<PlatformRoomState> {
    const room = await this.requireRoom(gameId, roomId);
    const index = room.players.findIndex((player) => player.playerId === userId);
    if (index < 0) throw errors.notMember();
    room.players.splice(index, 1);
    if (String(room.ownerId) === userId && room.players[0]) room.ownerId = new Types.ObjectId(room.players[0].playerId);
    if (room.players.length === 0) {
      room.status = 'closed';
      room.closedAt = new Date();

      // The last player has gone. A real-time game is still ticking twenty
      // times a second at this point, simulating a ship with nobody on it, and
      // would keep doing so until the process restarted — so the room closing
      // is what stops the clock. Four of the five adapters do not implement
      // this and the call costs them a property lookup.
      if (room.matchId) gameAdapters[gameId].onMatchEnded?.(String(room.matchId));
    }
    await room.save();

    // Dropping a seat mid-match also drops any pending Stupid turn: a timer
    // that fires into a room somebody just left is how a board ends up with a
    // move nobody made.
    platformBotService.clearRoom(roomId);
    return this.serializeRoom(room);
  }

  async readyRoom(gameId: GameId, roomId: string, userId: string, ready: boolean): Promise<{ room: PlatformRoomState; started: boolean }> {
    const room = await this.requireRoom(gameId, roomId);
    const player = room.players.find((candidate) => candidate.playerId === userId);
    if (!player) throw errors.notMember();
    if (room.status !== 'waiting') throw errors.gameAlreadyStarted();
    player.isReady = ready;
    await room.save();
    const definition = gameDefinition(gameId);
    const humans = room.players.filter((candidate) => !candidate.isBot);
    if (room.players.length >= definition.minPlayers && humans.length > 0 && room.players.every((candidate) => candidate.isBot || candidate.isReady)) {
      await this.startRoom(room);
      this.announce(gameId, roomId, 'game:match_started');
      return { room: this.serializeRoom(room), started: true };
    }
    this.announce(gameId, roomId, 'game:player_ready');
    return { room: this.serializeRoom(room), started: false };
  }

  async startRoom(room: GameRoomHydrated): Promise<string> {
    if (room.status !== 'waiting') throw errors.gameAlreadyStarted();
    const definition = gameDefinition(room.gameId as GameId);
    if (room.players.length < definition.minPlayers) throw errors.invalidAction(`This game needs ${definition.minPlayers} players.`);
    const players = room.players.map(toPlatformPlayer);
    const adapter = gameAdapters[room.gameId as GameId];
    const privateState = adapter.startMatch(adapter.createMatch(players));
    const publicState = adapter.getPublicState(privateState);
    const match = await GameMatch.create({
      gameId: room.gameId, roomId: room._id, status: 'playing',
      turnUserId: publicState.currentPlayerId ?? null, privateState, publicState, startedAt: new Date(),
    });
    room.matchId = match._id; room.status = 'playing'; await room.save();
    await GamePlayer.insertMany(players.map((player) => ({
      gameId: room.gameId, roomId: room._id, matchId: match._id, playerId: player.playerId,
      userId: player.userId, isBot: player.isBot,
    })));

    // A real-time game starts its simulation here, once there is a match id
    // to key it on. Four of the five adapters do not implement this, so this
    // is a property lookup for them and nothing more. Branching on the hook
    // rather than on the game id is what keeps this service generic.
    adapter.onMatchStarted?.({
      matchId: String(match._id), roomId: String(room._id), players,
    });

    // The first turn may already belong to a Stupid — the turn order is
    // shuffled — so the match has to be reconciled the moment it starts,
    // not only after the first human action. A real-time game has no turn
    // holder, so this returns immediately for one.
    platformBotService.reconcile({
      gameId: room.gameId as GameId, roomId: String(room._id), matchId: String(match._id),
      status: 'playing', turnUserId: match.turnUserId ?? null,
    });

    return String(match._id);
  }

  async matchForViewer(gameId: GameId, matchId: string, viewerId: string): Promise<State> {
    const match = await this.requireMatch(gameId, matchId);
    const room = await GameRoom.findById(match.roomId);
    if (!room || !room.players.some((player) => player.playerId === viewerId)) throw errors.notMember();
    const adapter = gameAdapters[gameId];

    // A real-time match's truth is in memory, not in this document — the
    // document holds who is playing and, eventually, who won. Falling back to
    // the adapter's own thin projection covers the two cases where the
    // simulation cannot answer: a match that has finished and been dropped,
    // and a process that has restarted under a live room.
    const live = adapter.realtime === true
      ? spaceMysteryEngine.viewFor(String(match._id), viewerId)
      : null;

    // Merged rather than chosen. The adapter's projection carries the things
    // that are true for the whole match — for Space Mystery, the floor plan —
    // and the live one carries what is true this instant. A client needs both,
    // and the map is deliberately absent from the ten-a-second frames because
    // sending it there would be the largest thing on the wire by far.
    const durable = adapter.getPrivatePlayerState(asState(match.privateState), viewerId);

    return {
      matchId: String(match._id), roomId: String(match.roomId), gameId, status: match.status,
      state: live === null ? durable : { ...durable, ...live },
      result: match.status === 'completed' ? match.result : null,
    };
  }

  async result(gameId: GameId, matchId: string, userId: string): Promise<State> {
    const state = await this.matchForViewer(gameId, matchId, userId);
    if (state.status !== 'completed') throw errors.invalidAction('The match has not finished.');
    return record(state.result);
  }

  async action(gameId: GameId, matchId: string, userId: string, action: State): Promise<State> {
    const match = await this.requireMatch(gameId, matchId);
    const room = await GameRoom.findById(match.roomId);
    if (!room || !room.players.some((player) => player.playerId === userId)) throw errors.notMember();
    if (match.status !== 'playing') throw errors.gameNotStarted();
    const adapter = gameAdapters[gameId];
    const privateState = adapter.updateGameState(adapter.handlePlayerAction(asState(match.privateState), userId, action));
    const result = adapter.getResult(privateState);
    const completed = result !== null;
    match.privateState = privateState;
    match.publicState = adapter.getPublicState(privateState);
    match.turnUserId = typeof match.publicState.currentPlayerId === 'string' ? match.publicState.currentPlayerId : null;
    if (completed) { match.status = 'completed'; match.result = result; match.endedAt = new Date(); }
    await match.save();
    if (completed) { room.status = 'completed'; await room.save(); await this.recordResult(room, match, result); }

    /**
     * Tell the table what just happened.
     *
     * Here rather than in the socket handler, and that is the fix for a real
     * bug: the handler only ran for actions that *arrived over a socket*, so a
     * human's move was broadcast and a Stupid's — which comes through the bot
     * driver, straight into this method — was not. A room of one person and
     * three bots would freeze after the player's turn and unfreeze only when
     * they acted again, with three bot moves arriving at once.
     *
     * One funnel for every action, whoever made it.
     */
    this.announce(
      gameId,
      String(room._id),
      completed ? 'game:match_completed' : 'game:match_state',
    );

    // The single funnel every platform state change passes through, which is
    // why the Stupids are hung here rather than at each call site. Costs one
    // property read in a room with no bots in it.
    platformBotService.reconcile({
      gameId, roomId: String(room._id), matchId: String(match._id),
      status: match.status, turnUserId: match.turnUserId ?? null,
    });

    return this.matchForViewer(gameId, matchId, userId);
  }

  /**
   * Records the end of a real-time match.
   *
   * The turn-based games finish inside [action], because the move that ended
   * the match is the same call that has to save it. A real-time match ends on
   * a tick — a reactor timing out, the last traitor ejected — with no player
   * action anywhere near it, so the engine calls this instead.
   *
   * Idempotent: a simulation that reports twice, or reports into a match some
   * other path has already closed, must not award experience twice.
   */
  async completeRealtimeMatch(gameId: GameId, matchId: string, result: State): Promise<void> {
    const match = await this.requireMatch(gameId, matchId);
    if (match.status === 'completed') return;

    const room = await GameRoom.findById(match.roomId);
    if (!room) return;

    match.status = 'completed';
    match.result = result;
    match.publicState = { ...record(match.publicState), status: 'completed', result };
    match.turnUserId = null;
    match.endedAt = new Date();
    await match.save();

    room.status = 'completed';
    await room.save();
    await this.recordResult(room, match, result);
  }

  /**
   * Seats up to [count] Stupids in a waiting room. Owner only.
   *
   * The platform twin of `stupidsService`, which does the same job for
   * Scribble & Guess. Kept separate rather than generalised because the two
   * engines store a seat differently — one in an in-process registry, one in a
   * Mongo document — and the shared part is the roster, which both take from
   * `botProfileService`.
   *
   * Returns how many were actually seated: an over-ask into a nearly full room
   * fills what is there rather than refusing.
   */
  async addStupids(input: {
    gameId: GameId;
    roomId: string;
    actorId: string;
    count: number;
    /**
     * How hard the seated bots play. Defaults to Normal.
     *
     * The host's choice, not the roster's: the same Smug Dave is a different
     * opponent on Easy and on Hard, because difficulty scales what a bot
     * *notices* rather than replacing its character. See `personalityFor`.
     */
    difficulty?: BotDifficultyWire;
  }): Promise<number> {
    const room = await this.requireRoom(input.gameId, input.roomId);

    if (String(room.ownerId) !== input.actorId) {
      throw errors.invalidAction('Only the room owner can add Stupids.');
    }
    if (room.status !== 'waiting') {
      throw errors.gameAlreadyStarted();
    }

    const definition = gameDefinition(input.gameId);
    if (!definition.supportsBots) {
      throw errors.invalidAction(`${definition.displayName} has no Stupids yet.`);
    }

    const humans = room.players.filter((player) => !player.isBot);
    if (humans.length === 0) throw errors.invalidAction('This room has no players in it.');

    const seats = Math.max(0, Math.min(input.count, room.maxPlayers - room.players.length));
    if (seats === 0) throw errors.invalidAction('This room is full.');

    // Already-seated bots are skipped: `take` returns a distinct slice, but a
    // second tap would otherwise hand back the same first entries.
    const already = new Set(room.players.map((player) => player.botId).filter(Boolean));

    const roster = await botProfileService.take({
      count: seats + already.size,
      difficulty: input.difficulty ?? BOT_DIFFICULTY.normal,
      // Rotates on the room, so two rooms open at once do not both field Mr
      // Whiskers while Big Yawn never plays.
      rotationKey: String(room._id),
    });

    const picked = roster.filter((identity) => !already.has(identity.botId)).slice(0, seats);

    for (const identity of picked) {
      room.players.push({
        playerId: identity.playerId,
        // Null, deliberately: a bot has no user row, and the end-of-match
        // reward path keys off `userId` precisely so it can skip them.
        userId: null,
        username: identity.displayName,
        avatarId: identity.avatarId,
        avatarColorIndex: identity.avatarColorIndex,
        isBot: true,
        botId: identity.botId,
        botDifficulty: identity.difficulty,
        // Ready on arrival: nothing is going to tap a button for them, and
        // `readyRoom` already starts once every non-bot seat is ready.
        isReady: true,
        connected: true,
        joinedAtMs: Date.now(),
      });
    }

    if (picked.length > 0) {
      await room.save();
      this.announce(input.gameId, input.roomId, 'game:room_updated');
    }
    return picked.length;
  }

  /** Removes every Stupid from a waiting room. Owner only. */
  async clearStupids(gameId: GameId, roomId: string, actorId: string): Promise<number> {
    const room = await this.requireRoom(gameId, roomId);

    if (String(room.ownerId) !== actorId) {
      throw errors.invalidAction('Only the room owner can remove Stupids.');
    }
    if (room.status !== 'waiting') throw errors.gameAlreadyStarted();

    const before = room.players.length;
    room.players = room.players.filter((player) => !player.isBot) as typeof room.players;

    const removed = before - room.players.length;
    if (removed > 0) {
      await room.save();
      this.announce(gameId, roomId, 'game:room_updated');
    }
    return removed;
  }

  async sendChat(gameId: GameId, roomId: string, user: AuthenticatedUser, message: string): Promise<State> {
    const room = await this.requireRoom(gameId, roomId);
    if (!room.players.some((player) => player.playerId === user.id)) throw errors.notMember();
    const clean = message.replace(/[\u0000-\u001F]/g, '').trim().slice(0, 500);
    if (!clean) throw errors.validation('Write a message first.');
    const row = await GameChatMessage.create({
      gameId, roomId: room._id, matchId: room.matchId, userId: user.id,
      username: sanitizeName(user.username), message: clean, type: 'chat',
    });
    return { id: String(row._id), roomId, gameId, username: row.username, message: row.message, type: row.type, createdAtMs: row.createdAt.getTime() };
  }

  serializeRoom(room: GameRoomDocument): PlatformRoomState {
    return {
      roomId: String(room._id), roomCode: room.roomCode, gameId: room.gameId as GameId,
      ownerId: String(room.ownerId), status: room.status as PlatformRoomState['status'], isPrivate: room.isPrivate,
      maxPlayers: room.maxPlayers, players: room.players.map(toPlatformPlayer),
      matchId: room.matchId ? String(room.matchId) : null, createdAtMs: room.createdAt.getTime(),
      // The standing rematch offer, if there is one. Carried on the room
      // rather than pushed separately: it is a property of the room, and a
      // client that has just reconnected needs both in the same breath.
      rematch: room.rematch
        ? {
            open: room.rematch.outcome === 'open' && room.rematch.deadlineAtMs > Date.now(),
            requestedBy: room.rematch.requestedBy,
            deadlineAtMs: room.rematch.deadlineAtMs,
            accepted: [...room.rematch.accepted],
            declined: [...room.rematch.declined],
            outcome: room.rematch.outcome,
          }
        : null,
    };
  }

  private async addPlayer(room: GameRoomHydrated, user: AuthenticatedUser): Promise<void> {
    const existing = room.players.find((player) => player.playerId === user.id);
    if (existing) { existing.connected = true; await room.save(); return; }
    if (room.status !== 'waiting') throw errors.gameAlreadyStarted();
    if (room.players.length >= room.maxPlayers) throw errors.roomFull();
    const seated = await this.findSeat(user.id);
    if (seated && String(seated._id) !== String(room._id)) throw errors.invalidAction('Leave your current game room first.');
    room.players.push(humanPlayer(user));
    await room.save();
  }

  private async findSeat(userId: string): Promise<GameRoomHydrated | null> {
    return GameRoom.findOne({ 'players.playerId': userId, status: { $in: ['waiting', 'playing'] }, closedAt: null });
  }

  private async requireRoom(gameId: GameId, roomIdOrCode: string): Promise<GameRoomHydrated> {
    const condition = Types.ObjectId.isValid(roomIdOrCode)
      ? { _id: roomIdOrCode, gameId, closedAt: null }
      : { roomCode: normalizeRoomCode(roomIdOrCode), gameId, closedAt: null };
    const room = await GameRoom.findOne(condition);
    if (!room) throw errors.roomNotFound();
    return room;
  }

  private async requireMatch(gameId: GameId, matchId: string) {
    if (!Types.ObjectId.isValid(matchId)) throw errors.notFound('Match not found.');
    const match = await GameMatch.findOne({ _id: matchId, gameId });
    if (!match) throw errors.notFound('Match not found.');
    return match;
  }

  private async newCode(): Promise<string> {
    const code = await generateUniqueRoomCode(async (candidate) => (await GameRoom.exists({ roomCode: candidate, closedAt: null })) !== null);
    if (!code) throw errors.internal('Could not allocate a room code.');
    return code;
  }

  private async recordResult(room: GameRoomDocument, match: { _id: Types.ObjectId; gameId: string; privateState: unknown }, result: State): Promise<void> {
    await GameResult.updateOne({ matchId: match._id }, { $setOnInsert: { gameId: match.gameId, roomId: room._id, matchId: match._id, result } }, { upsert: true });
    const winnerIds = winners(result, asState(match.privateState));
    await Promise.all(room.players.filter((player) => !player.isBot && player.userId).map(async (player) => {
      const userId = String(player.userId);
      const key = `${String(match._id)}:${userId}`;
      try {
        await XPHistory.create({
          gameId: match.gameId, matchId: match._id, userId: player.userId,
          placement: winnerIds.has(player.playerId) ? 1 : 2, result: winnerIds.has(player.playerId) ? 'win' : 'loss',
          xpAmount: 0, uniqueRewardKey: key,
        });
      } catch (error: unknown) {
        if (isDuplicateKey(error)) return;
        throw error;
      }
      const outcome = await xpService.award({
        userId,
        awards: winnerIds.has(player.playerId)
          ? [{ reason: 'participated', count: 1 }, { reason: 'wonGame', count: 1 }]
          : [{ reason: 'participated', count: 1 }],
      });
      await XPHistory.updateOne({ uniqueRewardKey: key }, { $set: { xpAmount: outcome?.earned ?? 0 } });
    }));
  }
}

function humanPlayer(user: AuthenticatedUser): PlatformPlayerState {
  return { playerId: user.id, userId: user.id, username: sanitizeName(user.username), avatarId: user.avatarId, avatarColorIndex: user.avatarColorIndex, isBot: false, botDifficulty: null, isReady: false, connected: true, joinedAtMs: Date.now() };
}

function toPlatformPlayer(player: GameRoomDocument['players'][number]): PlatformPlayerState {
  return {
    playerId: player.playerId, userId: player.userId ? String(player.userId) : null, username: player.username,
    avatarId: player.avatarId, avatarColorIndex: player.avatarColorIndex, isBot: player.isBot,
    botDifficulty: player.botDifficulty as PlatformPlayerState['botDifficulty'], isReady: player.isReady,
    connected: player.connected, joinedAtMs: player.joinedAtMs,
  };
}

function asState(value: unknown): State { return record(value); }
function record(value: unknown): State { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as State : {}; }
function bounded(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.floor(value))); }
function isDuplicateKey(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000; }
function winners(result: State, privateState: State): Set<string> {
  const direct = typeof result.winnerId === 'string' ? [result.winnerId] : Array.isArray(result.winnerIds) ? result.winnerIds.filter((id): id is string => typeof id === 'string') : [];
  if (direct.length > 0) return new Set(direct);
  if (result.winnerTeam === 'navigators' || result.winnerTeam === 'shades') {
    return new Set(Object.entries(record(privateState.roles)).filter(([, role]) => role === (result.winnerTeam === 'navigators' ? 'navigator' : 'shade')).map(([id]) => id));
  }
  return new Set();
}

export const gamePlatformService = new GamePlatformService();

/**
 * Hands the engine to the bot driver, at module load.
 *
 * Here rather than inside the driver, which imports nothing from this file but
 * types: the two would otherwise form a cycle whose behaviour depends on which
 * one Node happens to load first. The same arrangement `game.service.ts` uses
 * for Scribble's bots, for the same reason.
 */
/**
 * Lets the Space Mystery simulation write its result back.
 *
 * Bound here, at module load, for the same reason the bot driver's engine is:
 * the simulation must not import this service — it is imported *by* it — and a
 * match that ends on a tick still has to reach the database.
 */
spaceMysteryEngine.bindRecorder((matchId, result) =>
  gamePlatformService.completeRealtimeMatch('SPACE_MYSTERY', matchId, result));

platformBotService.bindEngine({
  matchForViewer: (gameId, matchId, viewerId) =>
    gamePlatformService.matchForViewer(gameId, matchId, viewerId),
  action: (gameId, matchId, userId, action) =>
    gamePlatformService.action(gameId, matchId, userId, action),
  seats: async (roomId) => {
    const room = await GameRoom.findById(roomId).select('players').lean().exec();
    return (room?.players ?? []).map((player) => ({
      playerId: player.playerId,
      isBot: player.isBot === true,
      botId: player.botId ?? null,
      botDifficulty: player.botDifficulty ?? null,
    }));
  },
});
