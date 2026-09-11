import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_PLAYERS_TO_START } from '@/constants/game.constants';
import { GAME_PHASE } from '@/constants/room.constants';
import { TIMER } from '@/services/timer.service';
import type { RuntimeRoom } from '@/types/socket.types';

import { makePlayer, makeRoom, makeRound } from './helpers';

/**
 * The minimum-player rule (brief section 18, applied for the whole match and
 * not only at the start).
 *
 * A game needs MIN_PLAYERS_TO_START people to *begin*; it needs just as many to
 * *continue*, because one person cannot both draw and guess. These tests pin
 * that: a room that falls short parks the match in the paused phase rather than
 * running turns for whoever is left, and it picks up again on its own once
 * somebody arrives.
 *
 * Everything durable is stubbed. The state machine is a pure function of the
 * runtime room, and mixing a database into that would test mongoose rather than
 * the rule.
 */

vi.mock('@/repositories/room.repository', () => ({
  roomRepository: { persistRuntime: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/repositories/round.repository', () => ({
  roundRepository: {
    create: vi.fn().mockResolvedValue({ _id: 'round-doc' }),
    startTurn: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    recordHint: vi.fn().mockResolvedValue(undefined),
    recordCorrectGuess: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/repositories/game.repository', () => ({
  gameRepository: {
    create: vi.fn().mockResolvedValue({ _id: 'game-doc' }),
    updateProgress: vi.fn().mockResolvedValue(undefined),
    addUsedWord: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/repositories/user.repository', () => ({
  userRepository: {
    touch: vi.fn().mockResolvedValue(undefined),
    recordGameResult: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/services/chat.service', () => ({
  chatService: {
    system: vi.fn().mockResolvedValue(undefined),
    presence: vi.fn().mockResolvedValue(undefined),
  },
}));

const { gameService } = await import('@/services/game.service');
const { drawingService } = await import('@/services/drawing.service');
const { chatService } = await import('@/services/chat.service');

/** A room mid-turn, with `count` connected players and `a` holding the pen. */
function playingRoom(count: number): RuntimeRoom {
  const ids = ['a', 'b', 'c', 'd'].slice(0, count);
  const room = makeRoom({
    players: ids.map((userId) => makePlayer({ userId })),
    phase: GAME_PHASE.drawing,
    turnOrder: [...ids],
    turnIndex: 0,
    currentRound: 1,
    gameId: 'game-1',
    round: makeRound({ drawerId: 'a' }),
  });
  // Something booked, so a test can show that pausing cancels it.
  room.timers.set(TIMER.turn, setTimeout(() => {}, 60_000));
  return room;
}

/** Removes a player the way every exit path does, then tells the engine. */
async function leave(room: RuntimeRoom, userId: string): Promise<void> {
  room.players.delete(userId);
  room.turnOrder = room.turnOrder.filter((id) => id !== userId);
  await gameService.onPlayerLeft(room, userId);
}

describe('the minimum-player rule', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(chatService.system).mockClear();
  });

  it('needs two, which is what the lobby also enforces', () => {
    expect(MIN_PLAYERS_TO_START).toBe(2);
  });

  it('pauses a two-player game the moment one of them leaves', async () => {
    const room = playingRoom(2);

    await leave(room, 'b');

    expect(room.phase).toBe(GAME_PHASE.paused);
    // No round means no drawer, no word and no deadline for the client to
    // render, so the last player is left with nothing to carry on with.
    expect(room.round).toBeNull();
    expect(room.timers.has(TIMER.turn)).toBe(false);
  });

  it('leaves the board empty, so the abandoned drawing is not a free clue', async () => {
    const room = playingRoom(2);
    room.board.strokes.push({
      id: 's1',
      a: 'a',
      p: [[0.1, 0.1]],
      c: 0xff000000,
      w: 4,
      t: 'pen',
      ts: Date.now(),
    });

    await leave(room, 'b');

    expect(room.board.strokes).toHaveLength(0);
  });

  it('refuses to draw while paused, even for the player who held the pen', async () => {
    const room = playingRoom(2);

    await leave(room, 'b');

    expect(() => drawingService.assertCanDraw(room, 'a')).toThrow();
  });

  it('keeps a three-player game running when one leaves', async () => {
    const room = playingRoom(3);

    await leave(room, 'c');

    expect(room.phase).toBe(GAME_PHASE.drawing);
    expect(room.round).not.toBeNull();
  });

  it('pauses once a three-player game is down to one', async () => {
    const room = playingRoom(3);

    await leave(room, 'c');
    await leave(room, 'a');

    expect(room.phase).toBe(GAME_PHASE.paused);
  });

  it('pauses a departure during the scoreboard, where no round is live', async () => {
    // The case the engine used to miss entirely: it returned early whenever the
    // round had already ended, so the next turn was scheduled regardless.
    const room = playingRoom(2);
    room.phase = GAME_PHASE.roundEnd;
    room.round!.ended = true;

    await leave(room, 'b');

    expect(room.phase).toBe(GAME_PHASE.paused);
  });

  it('pauses a departure during the countdown, where there is no round yet', async () => {
    const room = playingRoom(2);
    room.phase = GAME_PHASE.starting;
    room.round = null;

    await leave(room, 'b');

    expect(room.phase).toBe(GAME_PHASE.paused);
  });

  it('counts a reconnecting player, so a blip does not pause the game', async () => {
    const room = playingRoom(2);
    room.players.get('b')!.connection = 'reconnecting';

    await gameService.onPlayerLeft(room, 'b');

    expect(room.phase).toBe(GAME_PHASE.drawing);
  });

  it('pauses once when two players leave in the same tick', async () => {
    // Each departure arrives on its own async chain. Without the state change
    // being made before the first await, both would pass the guard, pause the
    // room twice and announce it twice.
    const room = playingRoom(3);
    for (const id of ['b', 'c']) {
      room.players.delete(id);
      room.turnOrder = room.turnOrder.filter((seat) => seat !== id);
    }

    await Promise.all([
      gameService.onPlayerLeft(room, 'b'),
      gameService.onPlayerLeft(room, 'c'),
    ]);

    expect(room.phase).toBe(GAME_PHASE.paused);
    expect(vi.mocked(chatService.system)).toHaveBeenCalledTimes(1);
  });

  it('does not pause a lobby or a finished game', async () => {
    for (const phase of [GAME_PHASE.lobby, GAME_PHASE.gameEnd] as const) {
      const room = playingRoom(1);
      room.phase = phase;
      expect(await gameService.pauseForMissingPlayers(room)).toBe(false);
      expect(room.phase).toBe(phase);
    }
  });
});

describe('resuming a paused game', () => {
  /** A room paused mid-match, exactly as pauseForMissingPlayers leaves it. */
  async function pausedRoom(): Promise<RuntimeRoom> {
    const room = playingRoom(2);
    await leave(room, 'b');
    return room;
  }

  it('stays paused while the room is still short', async () => {
    const room = await pausedRoom();

    await gameService.resumeIfPossible(room);

    expect(room.phase).toBe(GAME_PHASE.paused);
  });

  it('resumes through the same countdown a fresh match starts with', async () => {
    const room = await pausedRoom();
    room.players.set('z', makePlayer({ userId: 'z' }));

    await gameService.resumeIfPossible(room);

    expect(room.phase).toBe(GAME_PHASE.starting);
    expect(room.timers.has(TIMER.startCountdown)).toBe(true);
  });

  it('seats the arrival in the turn order, so the match cannot deadlock', async () => {
    // The player who left took their seat out of the order with them. Without
    // this the resumed match would have a turn order the newcomer is not in and
    // would run out of drawers immediately.
    const room = await pausedRoom();
    room.players.set('z', makePlayer({ userId: 'z' }));

    await gameService.resumeIfPossible(room);

    expect(room.turnOrder).toContain('z');
    expect(room.turnIndex).toBeLessThanOrEqual(room.turnOrder.length);
  });

  it('keeps the scores and the round number the paused match had', async () => {
    const room = playingRoom(2);
    room.players.get('a')!.score = 140;
    room.currentRound = 2;

    await leave(room, 'b');
    room.players.set('z', makePlayer({ userId: 'z' }));
    await gameService.resumeIfPossible(room);

    expect(room.players.get('a')!.score).toBe(140);
    expect(room.currentRound).toBe(2);
  });

  it('does nothing to a game that was never paused', async () => {
    const room = playingRoom(3);

    await gameService.resumeIfPossible(room);

    expect(room.phase).toBe(GAME_PHASE.drawing);
  });
});
