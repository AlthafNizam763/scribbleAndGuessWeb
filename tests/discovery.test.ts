import { beforeEach, describe, expect, it, vi } from 'vitest';

import { blockRepository } from '@/repositories/block.repository';
import { DiscoveryService } from '@/services/discovery.service';
import { GameRoom } from '@/models/GameRoom';
import { matchmakingService } from '@/services/matchmaking.service';
import { roomService } from '@/services/room.service';
import type { AuthenticatedUser } from '@/types/auth.types';

/**
 * Quick Match: merging two room engines into one list.
 *
 * What is worth testing here is exactly the part this service adds — the
 * merge, the ordering, the join-route tag and the two filters a cross-game
 * browser needs that a per-game list does not. Both *sources* are stubbed,
 * because each already has its own tests (`matchmaking.test.ts` for the
 * Scribble side) and re-asserting their rules here would only give them a
 * second place to be wrong.
 */

const service = new DiscoveryService();

const USER = { id: 'me', username: 'Me', avatarId: 0, avatarColorIndex: 0 } as AuthenticatedUser;

/** One Scribble room, in the shape `matchmakingService.describe` returns. */
function scribbleRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scribble-1',
    code: 'AAAAA',
    name: "Alice's room",
    hostId: 'alice',
    hostName: 'Alice',
    playerCount: 3,
    maxPlayers: 8,
    status: 'waiting',
    rounds: 3,
    drawTimeSeconds: 80,
    language: 'en',
    createdAtMs: 1_000,
    ...overrides,
  };
}

/** One platform room, in the shape a lean `GameRoom` query returns. */
function platformRoom(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'ludo-1',
    roomCode: 'BBBBB',
    gameId: 'LUDO',
    ownerId: 'bob',
    status: 'waiting',
    isPrivate: false,
    maxPlayers: 4,
    createdAt: new Date(2_000),
    players: [
      {
        playerId: 'bob',
        username: 'Bob',
        isBot: false,
      },
    ],
    ...overrides,
  };
}

/** Stubs `GameRoom.find(...).sort(...).limit(...).lean()` to yield `rows`. */
function stubGameRooms(rows: unknown[]): void {
  vi.spyOn(GameRoom, 'find').mockReturnValue({
    sort: () => ({ limit: () => ({ lean: async () => rows }) }),
  } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(blockRepository, 'relatedIds').mockResolvedValue([]);
  vi.spyOn(roomService, 'liveRoomOf').mockReturnValue(null);
  vi.spyOn(matchmakingService, 'listPublicFromStorage').mockResolvedValue([]);
  stubGameRooms([]);
});

describe('Quick Match', () => {
  it('returns rooms from both engines in one list', async () => {
    vi.spyOn(matchmakingService, 'listPublicFromStorage').mockResolvedValue([
      scribbleRoom(),
    ] as never);
    stubGameRooms([platformRoom()]);

    const page = await service.publicRooms(USER, { limit: 30 });

    expect(page.items.map((room) => room.gameId)).toEqual(
      expect.arrayContaining(['SCRIBBLE_GUESS', 'LUDO']),
    );
    expect(page.total).toBe(2);
  });

  it('tags each row with the engine it must be joined through', async () => {
    vi.spyOn(matchmakingService, 'listPublicFromStorage').mockResolvedValue([
      scribbleRoom(),
    ] as never);
    stubGameRooms([platformRoom()]);

    const page = await service.publicRooms(USER, { limit: 30 });
    const routes = Object.fromEntries(
      page.items.map((room) => [room.gameId, room.joinVia]),
    );

    // The whole reason this field exists: a join sent to the wrong engine is
    // refused, and the client must not have to infer which from the game id.
    expect(routes.SCRIBBLE_GUESS).toBe('ROOM');
    expect(routes.LUDO).toBe('GAME_PLATFORM');
  });

  it('interleaves by recency rather than grouping by game', async () => {
    vi.spyOn(matchmakingService, 'listPublicFromStorage').mockResolvedValue([
      scribbleRoom({ id: 'old-scribble', createdAtMs: 1_000 }),
      scribbleRoom({ id: 'new-scribble', createdAtMs: 3_000 }),
    ] as never);
    stubGameRooms([platformRoom({ _id: 'mid-ludo', createdAt: new Date(2_000) })]);

    const page = await service.publicRooms(USER, { limit: 30 });

    // A quiet game's one open room must not be buried under a busy game's ten.
    expect(page.items.map((room) => room.roomId)).toEqual([
      'new-scribble',
      'mid-ludo',
      'old-scribble',
    ]);
  });

  it('drops platform rooms the caller is already sitting in', async () => {
    stubGameRooms([
      platformRoom({
        _id: 'mine',
        players: [{ playerId: 'me', username: 'Me', isBot: false }],
      }),
      platformRoom({ _id: 'theirs' }),
    ]);

    const page = await service.publicRooms(USER, { limit: 30 });

    expect(page.items.map((room) => room.roomId)).toEqual(['theirs']);
  });

  it('drops platform rooms holding somebody blocked', async () => {
    vi.spyOn(blockRepository, 'relatedIds').mockResolvedValue(['nemesis']);
    stubGameRooms([
      platformRoom({
        _id: 'awkward',
        players: [{ playerId: 'nemesis', username: 'Nemesis', isBot: false }],
      }),
      platformRoom({ _id: 'fine' }),
    ]);

    const page = await service.publicRooms(USER, { limit: 30 });

    expect(page.items.map((room) => room.roomId)).toEqual(['fine']);
  });

  it('drops full platform rooms', async () => {
    stubGameRooms([
      platformRoom({
        _id: 'full',
        maxPlayers: 1,
        players: [{ playerId: 'bob', username: 'Bob', isBot: false }],
      }),
    ]);

    const page = await service.publicRooms(USER, { limit: 30 });

    expect(page.items).toHaveLength(0);
  });

  it('counts a bot as an occupant but never as a reason to hide a room', async () => {
    stubGameRooms([
      platformRoom({
        _id: 'with-stupids',
        maxPlayers: 4,
        players: [
          { playerId: 'bob', username: 'Bob', isBot: false },
          { playerId: 'bot-1', username: 'Mr Whiskers', isBot: true },
        ],
      }),
    ]);

    const page = await service.publicRooms(USER, { limit: 30 });

    expect(page.items).toHaveLength(1);
    // Occupancy includes the Stupid, because it is holding a seat.
    expect(page.items[0]?.playerCount).toBe(2);
  });

  it('skips the Scribble engine entirely when it is filtered out', async () => {
    const scribble = vi
      .spyOn(matchmakingService, 'listPublicFromStorage')
      .mockResolvedValue([scribbleRoom()] as never);

    await service.publicRooms(USER, { limit: 30, gameIds: ['LUDO'] });

    expect(scribble).not.toHaveBeenCalled();
  });

  it('reports the seat the caller already holds', async () => {
    vi.spyOn(roomService, 'liveRoomOf').mockReturnValue({
      roomId: 'seated',
      code: 'ZZZZZ',
    } as never);

    const page = await service.publicRooms(USER, { limit: 30 });

    // So the screen can say "leave that room first" before the tap, rather
    // than letting somebody tap into a refusal.
    expect(page.currentRoomCode).toBe('ZZZZZ');
  });

  it('honours the limit across both engines combined', async () => {
    vi.spyOn(matchmakingService, 'listPublicFromStorage').mockResolvedValue([
      scribbleRoom({ id: 's1', createdAtMs: 5_000 }),
      scribbleRoom({ id: 's2', createdAtMs: 4_000 }),
    ] as never);
    stubGameRooms([
      platformRoom({ _id: 'l1', createdAt: new Date(3_000) }),
      platformRoom({ _id: 'l2', createdAt: new Date(2_000) }),
    ]);

    const page = await service.publicRooms(USER, { limit: 3 });

    expect(page.items).toHaveLength(3);
  });
});
