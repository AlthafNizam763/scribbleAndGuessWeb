import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INPUT_LIMITS } from '@/constants/game.constants';
import { DRAW_TOOL } from '@/constants/room.constants';
import { drawingService } from '@/services/drawing.service';
import {
  RATE_LIMITS,
  enforceHttpLimit,
  resetRateLimits,
} from '@/middleware/rateLimit.middleware';
import type { StrokeDto } from '@/types/drawing.types';
import { AppError, ErrorCode } from '@/utils/errors';
import { makeRoom } from './helpers';

/**
 * The scalability fixes, asserted as behaviour rather than as implementation.
 *
 * Every case here corresponds to a finding in `docs/SCALABILITY_AUDIT.md`. The
 * point of each is that the *observable* contract did not change — a drawing
 * relay that finds a stroke, a rate limiter that refuses a flood — while the
 * cost of honouring it did. Where a test can only see the cost, it measures it
 * against a bound that the old implementation would miss by an order of
 * magnitude rather than against a stopwatch, so the suite does not become
 * flaky on a loaded machine.
 */

/** A stroke as the service stores it, already sanitised. */
function stroke(id: string, overrides: Partial<StrokeDto> = {}): StrokeDto {
  return {
    id,
    a: 'drawer-1',
    p: [
      [0.1, 0.1],
      [0.2, 0.2],
    ],
    c: 0xff000000,
    w: 4,
    t: DRAW_TOOL.pen,
    ts: Date.now(),
    ...overrides,
  };
}

describe('B-2 — the board id index', () => {
  it('appends to a stroke buried under thousands of others', () => {
    const room = makeRoom();

    // The stroke the batch belongs to goes on first, so every later stroke is
    // something a linear scan would have to walk past.
    drawingService.begin(room, stroke('target'));
    for (let i = 0; i < 3000; i++) {
      drawingService.begin(room, stroke(`filler-${i}`));
    }

    expect(drawingService.append(room, 'target', [[0.5, 0.5]])).toBe(true);
    expect(room.board.strokes[0]?.p).toHaveLength(3);
  });

  it('keeps append cheap as the board grows', () => {
    const room = makeRoom();
    drawingService.begin(room, stroke('target'));

    const timeAppends = (): number => {
      const started = process.hrtime.bigint();
      for (let i = 0; i < 2000; i++) drawingService.append(room, 'target', [[0.5, 0.5]]);
      return Number(process.hrtime.bigint() - started);
    };

    const onASmallBoard = timeAppends();

    for (let i = 0; i < 3000; i++) drawingService.begin(room, stroke(`filler-${i}`));

    const onALargeBoard = timeAppends();

    // A scan would be ~3000x the work on the second run. A lookup is flat, so
    // the bound is deliberately loose — this is asserting the difference
    // between O(1) and O(n), not a particular number of nanoseconds.
    expect(onALargeBoard).toBeLessThan(onASmallBoard * 20 + 5_000_000);
  });

  it('refuses a stroke id that is already on the board', () => {
    const room = makeRoom();

    expect(drawingService.begin(room, stroke('one'))).toBe(true);
    expect(drawingService.begin(room, stroke('one'))).toBe(false);
    expect(room.board.strokes).toHaveLength(1);
  });

  it('stops finding a stroke that was undone, and finds it again after redo', () => {
    const room = makeRoom();
    drawingService.begin(room, stroke('one'));

    drawingService.undo(room, 'drawer-1');
    expect(drawingService.append(room, 'one', [[0.5, 0.5]])).toBe(false);

    drawingService.redo(room);
    expect(drawingService.append(room, 'one', [[0.5, 0.5]])).toBe(true);
  });

  it('stops finding a stroke after the board is cleared', () => {
    const room = makeRoom();
    drawingService.begin(room, stroke('one'));

    drawingService.clear(room);

    expect(drawingService.append(room, 'one', [[0.5, 0.5]])).toBe(false);
    expect(room.board.strokes).toHaveLength(0);
  });

  it('recovers when the board is mutated behind the service', () => {
    const room = makeRoom();
    drawingService.begin(room, stroke('indexed'));

    // The game engine hands out a fresh board between turns, and the test
    // helpers push strokes directly. Neither goes through this service, so the
    // index has to notice and rebuild rather than answer from a stale map.
    room.board.strokes.push(stroke('pushed-directly'));

    expect(drawingService.append(room, 'pushed-directly', [[0.5, 0.5]])).toBe(true);
    expect(drawingService.append(room, 'indexed', [[0.5, 0.5]])).toBe(true);
  });

  it('recovers when the board is replaced wholesale', () => {
    const room = makeRoom();
    drawingService.begin(room, stroke('old'));

    room.board = { strokes: [stroke('new')], redoStack: [] };

    expect(drawingService.append(room, 'new', [[0.5, 0.5]])).toBe(true);
    expect(drawingService.append(room, 'old', [[0.5, 0.5]])).toBe(false);
  });

  it('still refuses a board past the stroke ceiling', () => {
    const room = makeRoom();
    for (let i = 0; i < INPUT_LIMITS.maxStrokesPerBoard; i++) {
      drawingService.begin(room, stroke(`s-${i}`));
    }

    expect(drawingService.begin(room, stroke('one-too-many'))).toBe(false);
    expect(room.board.strokes).toHaveLength(INPUT_LIMITS.maxStrokesPerBoard);
  });
});

describe('B-6 — http rate limit bucket eviction', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('reclaims buckets whose own rule has a small burst', () => {
    // `guess` holds 8 tokens at most. The old sweep compared every bucket
    // against `action.burst` (20), so a map full of these could never be
    // reclaimed: it scanned all ten thousand entries, deleted nothing, and did
    // it again on the very next request.
    expect(RATE_LIMITS.guess.burst).toBeLessThan(RATE_LIMITS.action.burst);

    for (let i = 0; i < 10_050; i++) {
      enforceHttpLimit('guess', `user:sweep-${i}`);
    }

    // The sweep runs inside `enforceHttpLimit`, so by now it has happened. A
    // bucket spent exactly once refills within a fraction of a second at 2/s,
    // so essentially all of them are reclaimable.
    enforceHttpLimit('guess', 'user:trigger');

    // Nothing observable exposes the map, so the assertion is the one thing a
    // caller can see: the limiter still works, and did not spend the request
    // walking a map it could not shrink.
    const started = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) enforceHttpLimit('guess', `user:after-${i}`);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(250);
  });

  it('still refuses a caller who is over their limit', () => {
    const spend = (): void => enforceHttpLimit('guestLogin', 'ip:1.2.3.4');

    for (let i = 0; i < RATE_LIMITS.guestLogin.burst; i++) spend();

    expect(spend).toThrow();
    try {
      spend();
    } catch (error) {
      expect(AppError.isAppError(error) && error.code).toBe(ErrorCode.RATE_LIMITED);
    }
  });

  it('keeps separate buckets per caller', () => {
    for (let i = 0; i < RATE_LIMITS.guestLogin.burst; i++) {
      enforceHttpLimit('guestLogin', 'ip:1.1.1.1');
    }

    expect(() => enforceHttpLimit('guestLogin', 'ip:1.1.1.1')).toThrow();
    // A second caller is unaffected by the first one's flood.
    expect(() => enforceHttpLimit('guestLogin', 'ip:2.2.2.2')).not.toThrow();
  });

  it('keeps separate buckets per action', () => {
    for (let i = 0; i < RATE_LIMITS.guestLogin.burst; i++) {
      enforceHttpLimit('guestLogin', 'ip:3.3.3.3');
    }

    expect(() => enforceHttpLimit('guestLogin', 'ip:3.3.3.3')).toThrow();
    // Spending the login allowance must not cost the same caller their reads.
    expect(() => enforceHttpLimit('publicRooms', 'ip:3.3.3.3')).not.toThrow();
  });
});

describe('B-13 — simultaneous Quick Play converges on shared rooms', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  /**
   * The regression this locks down was found by the load run, not by reading
   * the code: eighty-eight players tapping Play in one tick produced
   * seventy-six rooms.
   *
   * The mechanism is reproduced faithfully here — every caller yields at the
   * block-list read before any of them has created anything — so this test
   * fails against the unserialised matchmaker and passes against the queued
   * one. What it asserts is the property that actually matters to a player:
   * a burst of Quick Plays produces rooms with enough people in them to start
   * a game.
   */
  it('seats a burst of players into shared rooms rather than one room each', async () => {
    // The yield that caused the race. A real block-list read is a database
    // round trip; one macrotask reproduces the same lost-update window.
    vi.doMock('@/repositories/block.repository', () => ({
      blockRepository: {
        relatedIds: vi.fn(
          async () => await new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 1)),
        ),
      },
    }));

    let created = 0;
    vi.doMock('@/repositories/room.repository', () => ({
      roomRepository: {
        isCodeTaken: vi.fn().mockResolvedValue(false),
        create: vi.fn(async () => {
          created += 1;
          // Creating a room is not instantaneous either, and the gap is part
          // of the window a later caller could rank inside.
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { _id: `room-${created}` };
        }),
        persistRuntime: vi.fn().mockResolvedValue(undefined),
        markClosed: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue(null),
      },
    }));

    vi.doMock('@/repositories/user.repository', () => ({
      userRepository: { touch: vi.fn().mockResolvedValue(undefined) },
      isObjectId: () => true,
    }));

    const { matchmakingService } = await import('@/services/matchmaking.service');

    const PLAYERS = 40;
    const players = Array.from({ length: PLAYERS }, (_, index) => ({
      id: `user-${index}`,
      username: `player${index}`,
      avatarId: 0,
      avatarColorIndex: 0,
    }));

    // All in one tick, which is the condition that broke it.
    const outcomes = await Promise.all(
      players.map((player) => matchmakingService.quickPlay(player as never)),
    );

    const rooms = new Set(outcomes.map((outcome) => outcome.room.roomId));
    const seatLimit = 8;
    const floor = Math.ceil(PLAYERS / seatLimit);

    // Everybody got a seat.
    expect(outcomes).toHaveLength(PLAYERS);

    // And they share rooms. Before the fix this was 30-something rooms for
    // forty players; the ideal is five.
    expect(rooms.size).toBeLessThanOrEqual(floor + 1);

    // No room took more than it should have.
    const occupancy = new Map<string, number>();
    for (const outcome of outcomes) {
      occupancy.set(outcome.room.roomId, (occupancy.get(outcome.room.roomId) ?? 0) + 1);
    }
    for (const count of occupancy.values()) expect(count).toBeLessThanOrEqual(seatLimit);

    // The point of all of it: every room has enough people to start a match.
    const tooSmall = [...occupancy.values()].filter((count) => count < 2).length;
    expect(tooSmall).toBeLessThanOrEqual(1);
  });

  it('keeps the queue moving when one caller fails', async () => {
    vi.doMock('@/repositories/block.repository', () => ({
      blockRepository: {
        relatedIds: vi.fn(
          async () => await new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 1)),
        ),
      },
    }));

    let attempt = 0;
    vi.doMock('@/repositories/room.repository', () => ({
      roomRepository: {
        isCodeTaken: vi.fn().mockResolvedValue(false),
        create: vi.fn(async () => {
          attempt += 1;
          // The first caller's room creation fails outright.
          if (attempt === 1) throw new Error('mongo is down');
          return { _id: `room-${attempt}` };
        }),
        persistRuntime: vi.fn().mockResolvedValue(undefined),
        markClosed: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue(null),
      },
    }));

    vi.doMock('@/repositories/user.repository', () => ({
      userRepository: { touch: vi.fn().mockResolvedValue(undefined) },
      isObjectId: () => true,
    }));

    const { matchmakingService } = await import('@/services/matchmaking.service');

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        matchmakingService.quickPlay({
          id: `failing-${index}`,
          username: `p${index}`,
          avatarId: 0,
          avatarColorIndex: 0,
        } as never),
      ),
    );

    // One failed; a rejection ahead in the queue must not wedge the rest.
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'fulfilled').length).toBe(4);
  });
});

describe('B-5 — concurrent hydration of one room', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('builds the room once and hands every caller the same object', async () => {
    const findById = vi.fn().mockImplementation(
      async () =>
        // A real read is not instantaneous, and the window this closes is
        // exactly the time spent awaiting it.
        await new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                _id: 'room-hydrate-1',
                roomCode: 'HYD01',
                ownerId: 'owner-1',
                createdAt: new Date(),
                closedAt: null,
                bannedUserIds: [],
                settings: { rounds: 3, maxPlayers: 8 },
                players: [
                  {
                    userId: 'owner-1',
                    username: 'owner',
                    avatarId: 0,
                    avatarColorIndex: 0,
                    score: 0,
                    isMuted: false,
                    joinedAt: new Date(),
                  },
                ],
              }),
            10,
          ),
        ),
    );

    vi.doMock('@/repositories/room.repository', () => ({
      roomRepository: {
        findById,
        persistRuntime: vi.fn().mockResolvedValue(undefined),
        markClosed: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { roomService } = await import('@/services/room.service');

    // Five reconnects landing together, which is what a restart produces.
    const rooms = await Promise.all([
      roomService.hydrate('room-hydrate-1'),
      roomService.hydrate('room-hydrate-1'),
      roomService.hydrate('room-hydrate-1'),
      roomService.hydrate('room-hydrate-1'),
      roomService.hydrate('room-hydrate-1'),
    ]);

    // One read, not five.
    expect(findById).toHaveBeenCalledTimes(1);

    // And crucially one object: a second `registry.set` would have replaced
    // the first, orphaning anybody already seated on it.
    const first = rooms[0];
    expect(first).not.toBeNull();
    for (const room of rooms) expect(room).toBe(first);

    // The registry agrees with what the callers are holding.
    expect(roomService.get('room-hydrate-1')).toBe(first);
  });

  it('lets a later hydration retry after a failed read', async () => {
    const findById = vi
      .fn()
      .mockRejectedValueOnce(new Error('mongo is down'))
      .mockResolvedValueOnce(null);

    vi.doMock('@/repositories/room.repository', () => ({
      roomRepository: {
        findById,
        persistRuntime: vi.fn().mockResolvedValue(undefined),
        markClosed: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { roomService } = await import('@/services/room.service');

    await expect(roomService.hydrate('room-hydrate-2')).rejects.toThrow('mongo is down');

    // The in-flight entry must be cleared on failure too, or the room could
    // never be hydrated again for the life of the process.
    await expect(roomService.hydrate('room-hydrate-2')).resolves.toBeNull();
    expect(findById).toHaveBeenCalledTimes(2);
  });
});
