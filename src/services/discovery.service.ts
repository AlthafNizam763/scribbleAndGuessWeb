import { blockRepository } from '@/repositories/block.repository';
import { GAME_IDS, type GameId } from '@/games/game.types';
import { gameDefinition } from '@/games/catalog';
import { GameRoom } from '@/models/GameRoom';
import { getSocketServer } from '@/config/socket';
import { matchmakingService } from '@/services/matchmaking.service';
import { roomService } from '@/services/room.service';
import type { AuthenticatedUser } from '@/types/auth.types';
import type { DiscoverableRoomDto, RoomDiscoveryPageDto } from '@/types/discovery.types';

/**
 * Quick Match: every joinable public room, whatever game it belongs to.
 *
 * ## Why this exists
 *
 * The platform has two room engines and always will. Scribble & Guess runs on
 * the mature `Room` service — an in-process registry, socket-first, with its
 * own matchmaking and ban rules — and the newer games run on `GameRoom`
 * through the generic platform service. Both are correct for what they do, and
 * merging them would mean rewriting the one that already works.
 *
 * What a player wants, though, is one list. So this service reads both and
 * flattens them into a single row type, tagging each row with the route a
 * client must take to join it. Nothing here re-implements joinability: each
 * engine is asked for rooms it already considers open, and the join itself
 * still goes through that engine and is still re-checked there.
 *
 * ## The list is a snapshot
 *
 * Occupancy is read at the moment of the request. A room can fill between this
 * response and the tap that follows it, and the join will be refused — which is
 * correct, and is why the client refreshes on a refusal rather than trusting
 * these numbers.
 */
export class DiscoveryService {
  /**
   * Every public room the caller could join right now, newest activity first.
   *
   * @param user  the caller, so blocks and their own seat can be accounted for
   * @param limit total rows across all games
   * @param gameIds optional filter; omitted means every game
   */
  async publicRooms(
    user: AuthenticatedUser,
    options: { limit: number; gameIds?: GameId[] } = { limit: 30 },
  ): Promise<RoomDiscoveryPageDto> {
    const wanted = new Set<GameId>(options.gameIds?.length ? options.gameIds : GAME_IDS);
    const blocked = new Set(await blockRepository.relatedIds(user.id));

    // Both engines are read at once: they touch different collections and
    // neither depends on the other's answer, so waiting for them in sequence
    // would only add the slower one's latency to the faster one's.
    const [scribble, platform] = await Promise.all([
      wanted.has('SCRIBBLE_GUESS')
        ? this.scribbleRooms(user, blocked, options.limit)
        : Promise.resolve([]),
      this.platformRooms(user, blocked, [...wanted].filter((id) => id !== 'SCRIBBLE_GUESS'), options.limit),
    ]);

    // Interleaved by recency rather than grouped by game, so a quiet game's
    // one open room is not buried under a busy game's ten.
    const items = [...scribble, ...platform]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, options.limit);

    const seat = roomService.liveRoomOf(user.id);

    return {
      items,
      total: items.length,
      // So the screen can say "leave that room first" before the player taps
      // Join and is refused. The refusal is still the server's; this only
      // saves a round trip to hear it.
      currentRoomId: seat?.roomId ?? null,
      currentRoomCode: seat?.code ?? null,
    };
  }

  /**
   * The Scribble & Guess side, borrowed wholesale from its own matchmaker.
   *
   * Deliberately not a fresh query: `matchmakingService` already knows which
   * rooms are public, waiting, unfull, unstarted and clear of the caller's
   * blocks, and it reads the live socket registry when there is one — which is
   * the only place exact occupancy exists.
   */
  private async scribbleRooms(
    user: AuthenticatedUser,
    blocked: Set<string>,
    limit: number,
  ): Promise<DiscoverableRoomDto[]> {
    const rows = getSocketServer()
      ? matchmakingService.listPublic(user.id, blocked, limit)
      : await matchmakingService.listPublicFromStorage(user.id, blocked, limit);

    return rows.map((room) => ({
      gameId: 'SCRIBBLE_GUESS' as const,
      gameName: gameDefinition('SCRIBBLE_GUESS').displayName,
      roomId: room.id,
      code: room.code,
      name: room.name,
      hostName: room.hostName,
      playerCount: room.playerCount,
      maxPlayers: room.maxPlayers,
      status: room.status,
      createdAtMs: room.createdAtMs,
      joinVia: 'ROOM' as const,
    }));
  }

  /**
   * The other four games, in one query rather than one query per game.
   *
   * The filter mirrors `GamePlatformService.listRooms` exactly — waiting,
   * public, not closed — with two additions a browser needs that a per-game
   * list does not: rooms the caller is already sitting in are dropped, because
   * offering somebody a seat they hold is nonsense, and so are rooms holding
   * anybody either party has blocked.
   */
  private async platformRooms(
    user: AuthenticatedUser,
    blocked: Set<string>,
    gameIds: GameId[],
    limit: number,
  ): Promise<DiscoverableRoomDto[]> {
    if (gameIds.length === 0) return [];

    const rows = await GameRoom.find({
      gameId: { $in: gameIds },
      status: 'waiting',
      isPrivate: false,
      closedAt: null,
    })
      .sort({ createdAt: -1 })
      // Over-fetched because the two filters below run in application code:
      // seat and block membership live inside the players array, and
      // expressing them as query predicates would not survive the next change
      // to how a seat is recorded.
      .limit(limit * 2)
      .lean();

    const items: DiscoverableRoomDto[] = [];

    for (const room of rows) {
      if (room.players.length >= room.maxPlayers) continue;

      const humans = room.players.filter((player) => !player.isBot);
      if (humans.some((player) => player.playerId === user.id)) continue;
      if (humans.some((player) => blocked.has(player.playerId))) continue;

      const definition = gameDefinition(room.gameId as GameId);
      const owner = room.players.find((player) => player.playerId === String(room.ownerId));

      items.push({
        gameId: room.gameId as GameId,
        gameName: definition.displayName,
        roomId: String(room._id),
        code: room.roomCode,
        // The platform engine has no room-name field, so a room is named after
        // whoever opened it — the same convention the Scribble browser uses.
        name: owner ? `${owner.username}'s room` : definition.displayName,
        hostName: owner?.username ?? 'Host',
        playerCount: room.players.length,
        maxPlayers: room.maxPlayers,
        status: room.status,
        createdAtMs: room.createdAt.getTime(),
        joinVia: 'GAME_PLATFORM' as const,
      });

      if (items.length >= limit) break;
    }

    return items;
  }
}

export const discoveryService = new DiscoveryService();
