import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BOT_DIFFICULTY, type BotDifficultyWire } from '@/constants/autoTournament.constants';
import { PlatformBotService, type PlatformBotEngine } from '@/services/bot/platformBot.service';

/**
 * The driver that takes a Stupid's turn.
 *
 * ## What is worth proving here, and what is not
 *
 * Not the move: which token to push is the adapter's, and has its own tests.
 * This file is about the three things the *driver* owns, each of which fails
 * in a way no screenshot would show:
 *
 * 1. It never acts for a person.
 * 2. It does not recurse. A room of Stupids hands the turn back and forth, and
 *    taking each turn inside the call that triggered it would blow the stack.
 *    The timer is what breaks the chain, so the timer is what is asserted.
 * 3. It cleans up. A pending turn that fires into a finished match is how a
 *    board ends up with a move nobody made.
 *
 * Fake timers throughout, so a 3.6-second Big Yawn does not cost 3.6 seconds.
 */

type State = Record<string, unknown>;

let service: PlatformBotService;
let actions: { userId: string; action: State }[];

/** A room whose seats and turn order the test drives directly. */
function engineWith(options: {
  seats: { playerId: string; isBot: boolean; botId: string | null; botDifficulty: BotDifficultyWire | null }[];
  /** The seat on turn after each action, in order. `null` ends the match. */
  turns: (string | null)[];
}): PlatformBotEngine {
  let cursor = 0;

  return {
    seats: async () => options.seats,

    matchForViewer: async (_gameId, _matchId, viewerId) => ({
      matchId: 'm1', roomId: 'r1', status: 'playing',
      // The Ludo shape, which is enough for the adapter to return a `roll`.
      state: {
        gameId: 'LUDO', status: 'playing', currentPlayerId: options.turns[cursor] ?? viewerId,
        dice: null, order: options.seats.map((s) => s.playerId),
        positions: Object.fromEntries(options.seats.map((s) => [s.playerId, [-1, -1, -1, -1]])),
      },
    }),

    action: async (_gameId, _matchId, userId, action) => {
      actions.push({ userId, action });
      cursor++;
      const next = options.turns[cursor] ?? null;
      return {
        matchId: 'm1', roomId: 'r1',
        status: next === null ? 'completed' : 'playing',
        state: { gameId: 'LUDO', status: next === null ? 'completed' : 'playing', currentPlayerId: next },
      };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  service = new PlatformBotService();
  actions = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const BOT = { playerId: 'bot', isBot: true, botId: 'quickdrawer', botDifficulty: BOT_DIFFICULTY.normal };
const HUMAN = { playerId: 'human', isBot: false, botId: null, botDifficulty: null };

function reconcile(turnUserId: string | null, status = 'playing'): void {
  service.reconcile({ gameId: 'LUDO', roomId: 'r1', matchId: 'm1', status, turnUserId });
}

/**
 * Lets the driver's seat lookup resolve.
 *
 * `reconcile` is deliberately fire-and-forget — nothing waits on a bot — so
 * the timer is registered a microtask later, after the seats come back. A test
 * asserting on `activeWorkers` immediately would be asking before the answer
 * exists.
 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('scheduling', () => {
  it('takes a turn when a Stupid is on turn', async () => {
    service.bindEngine(engineWith({ seats: [BOT, HUMAN], turns: ['bot', 'human'] }));

    reconcile('bot');
    // Nothing yet: the turn is on a timer, which is what stops it recursing.
    expect(actions).toHaveLength(0);

    await vi.runOnlyPendingTimersAsync();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.userId).toBe('bot');
  });

  it('never acts for a person', async () => {
    service.bindEngine(engineWith({ seats: [BOT, HUMAN], turns: ['human'] }));

    reconcile('human');
    await vi.runOnlyPendingTimersAsync();

    expect(actions).toHaveLength(0);
    expect(service.activeWorkers()).toBe(0);
  });

  it('does nothing for a match that is not playing', async () => {
    service.bindEngine(engineWith({ seats: [BOT], turns: ['bot'] }));

    reconcile('bot', 'completed');
    await vi.runOnlyPendingTimersAsync();

    expect(actions).toHaveLength(0);
  });

  it('does nothing when no seat is on turn', async () => {
    service.bindEngine(engineWith({ seats: [BOT], turns: [] }));

    // Space Mystery has no turn holder at all; a driver that scheduled
    // anyway would fire into a game it cannot play.
    reconcile(null);
    await vi.runOnlyPendingTimersAsync();

    expect(actions).toHaveLength(0);
  });
});

describe('a room with more than one Stupid', () => {
  it('hands the turn on without recursing', async () => {
    const second = { playerId: 'bot2', isBot: true, botId: 'lazycat', botDifficulty: BOT_DIFFICULTY.easy };
    service.bindEngine(
      engineWith({ seats: [BOT, second], turns: ['bot', 'bot2', 'bot', null] }),
    );

    reconcile('bot');

    // Each turn starts from a fresh tick, so draining the queue repeatedly is
    // what advances the match — and the stack never grows.
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    expect(actions.map((entry) => entry.userId)).toEqual(['bot', 'bot2', 'bot']);
  });

  it('stops once the match completes', async () => {
    service.bindEngine(engineWith({ seats: [BOT], turns: ['bot', null] }));

    reconcile('bot');
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    // A timer surviving a finished match is how a board gets a move nobody
    // made.
    expect(actions).toHaveLength(1);
    expect(service.activeWorkers()).toBe(0);
  });
});

describe('cleanup', () => {
  it('replaces a pending turn rather than stacking them', async () => {
    service.bindEngine(engineWith({ seats: [BOT, HUMAN], turns: ['bot', 'human'] }));

    reconcile('bot');
    reconcile('bot');
    reconcile('bot');
    await settle();

    // Only one seat can be on turn, so a second pending turn is always either
    // a duplicate or stale.
    expect(service.activeWorkers()).toBe(1);

    await vi.runOnlyPendingTimersAsync();
    expect(actions).toHaveLength(1);
  });

  it('drops a pending turn when the room is cleared', async () => {
    service.bindEngine(engineWith({ seats: [BOT], turns: ['bot'] }));

    reconcile('bot');
    await settle();
    expect(service.activeWorkers()).toBe(1);

    service.clearRoom('r1');
    await vi.runOnlyPendingTimersAsync();

    expect(actions).toHaveLength(0);
    expect(service.activeWorkers()).toBe(0);
  });

  it('survives an engine that throws', async () => {
    service.bindEngine({
      seats: async () => [BOT],
      matchForViewer: async () => { throw new Error('the database fell over'); },
      action: async () => ({}),
    });

    reconcile('bot');
    // A failed bot turn must never take the match with it: a person can still
    // act, and the next state change reconciles again.
    await expect(vi.runOnlyPendingTimersAsync()).resolves.not.toThrow();
    expect(actions).toHaveLength(0);
  });

  it('does nothing at all before an engine is bound', async () => {
    reconcile('bot');
    await vi.runOnlyPendingTimersAsync();

    expect(actions).toHaveLength(0);
  });
});
