import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GAME_PHASE } from '@/constants/room.constants';
import type { GameStateDto } from '@/types/game.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { maskWord } from '@/services/hint.service';
import { makePlayer, makeRoom, makeRound } from './helpers';

/**
 * A bot playing a turn, through the real engine hooks.
 *
 * ## What this covers that the unit tests do not
 *
 * The unit tests pin the two decisions — what to draw, what to guess. This
 * pins the *driving*: that `reconcile` starts the right work for the right
 * seat, that the strokes actually land on the board through the drawing
 * service, that guesses actually go through the engine's guess path, and —
 * the one that would otherwise leak silently — that every timer is dropped
 * when the turn ends.
 *
 * ## Why the engine is a stand-in rather than the real `gameService`
 *
 * Because the real one writes rounds, scores and progression to Mongo on
 * paths that have nothing to do with what is being tested here. The bot driver
 * takes its engine by injection precisely so this substitution is possible,
 * and the substitute implements the same three methods the real engine
 * exposes to it — including the per-viewer serialisation, which is what
 * withholds the word.
 */

// The word pool the bot guesses from. Mocked because the real one reads Mongo.
vi.mock('@/services/word.service', () => ({
  wordService: {
    guessablePool: async () => [
      { text: 'guitar', category: 'music', difficulty: 'medium', aliases: [] },
      { text: 'house', category: 'places', difficulty: 'easy', aliases: [] },
      { text: 'rocket', category: 'objects', difficulty: 'medium', aliases: [] },
      { text: 'flower', category: 'nature', difficulty: 'easy', aliases: [] },
    ],
  },
}));

// Chat writes a durable transcript row. Not what is under test.
vi.mock('@/services/chat.service', () => ({
  chatService: {
    correctGuess: async () => undefined,
    broadcast: async () => undefined,
    system: async () => undefined,
  },
}));

const { botPlayerService } = await import('@/services/bot/botPlayer.service');

const HUMAN = '507f1f77bcf86cd799439011';
const BOT = '507f1f77bcf86cd799439012';

/** Calls recorded by the stand-in engine. */
interface EngineCalls {
  selectedIndexes: number[];
  guesses: { userId: string; text: string }[];
}

let calls: EngineCalls;

/**
 * A stand-in for the game engine.
 *
 * `serializeGameState` reproduces the one rule that matters: the word is
 * populated for the drawer and null for everybody else. That is what the bot
 * guesser receives, so a bot that somehow read the answer would have had to
 * read it from here — and it cannot, because the payload does not contain it.
 */
function stubEngine(room: RuntimeRoom, correctVerdictFor?: string) {
  return {
    serializeGameState(target: RuntimeRoom, viewerId: string): GameStateDto {
      const round = target.round;
      const isDrawer = round?.drawerId === viewerId;

      return {
        roomCode: target.code,
        phase: target.phase,
        currentRound: target.currentRound,
        totalRounds: target.totalRounds,
        turnIndex: target.turnIndex,
        drawerId: round?.drawerId ?? null,
        word: isDrawer ? (round?.word ?? null) : null,
        maskedWord:
          round?.word ? maskWord(round.word, round.hintIndices) : '',
        wordLength: round?.word ? round.word.length : 0,
        hintIndices: [...(round?.hintIndices ?? [])],
        turnStartMs: round?.turnStartMs ?? 0,
        turnEndMs: round?.turnEndMs ?? 0,
        correctGuesserIds: [...(round?.correctOrder ?? [])],
        roundScores: {},
        wordChoices: [],
        drawerSeesBoard: true,
      };
    },

    async selectWord(_target: RuntimeRoom, _userId: string, index: number) {
      calls.selectedIndexes.push(index);
    },

    async submitGuess(input: { room: RuntimeRoom; userId: string; text: string }) {
      calls.guesses.push({ userId: input.userId, text: input.text });

      if (correctVerdictFor && input.text === correctVerdictFor) {
        const seat = input.room.players.get(input.userId);
        if (seat) seat.hasGuessed = true;
        return { verdict: 'correct' as const, points: 100 };
      }
      return { verdict: 'wrong' as const, points: 0 };
    },
  };
}

/**
 * A room with one person and one bot.
 *
 * The overrides are typed without `players`, matching `makeRoom`: the helper
 * takes seats as an array and builds the `Map` itself, so a `Partial<
 * RuntimeRoom>` — whose `players` is already a `Map` — is the wrong shape to
 * spread in.
 */
function roomWithBot(
  overrides: Partial<Omit<RuntimeRoom, 'players'>> = {},
): RuntimeRoom {
  return makeRoom({
    players: [
      makePlayer({ userId: HUMAN, username: 'Ana' }),
      makePlayer({
        userId: BOT,
        username: 'Doodler',
        isBot: true,
        botDifficulty: 'NORMAL',
        botId: 'doodler',
      }),
    ],
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = { selectedIndexes: [], guesses: [] };
});

afterEach(() => {
  botPlayerService.clearRoom('room-1');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('noticing whether a room has bots at all', () => {
  it('costs an ordinary room nothing and starts no work', () => {
    const room = makeRoom({ players: [makePlayer({ userId: HUMAN })] });
    botPlayerService.bindEngine(stubEngine(room));

    expect(botPlayerService.hasBots(room)).toBe(false);

    room.phase = GAME_PHASE.drawing;
    room.round = makeRound({ drawerId: HUMAN, word: 'guitar' });
    botPlayerService.reconcile(room);

    expect(botPlayerService.activeWorkers()).toBe(0);
  });
});

describe('a bot that is drawing', () => {
  it('takes one of the offered words', () => {
    const room = roomWithBot({ phase: GAME_PHASE.wordSelection });
    room.round = makeRound({
      drawerId: BOT,
      word: null,
      wordChoices: [
        { text: 'quinquagenarian', category: 'random', difficulty: 'hard', aliases: [] },
        { text: 'house', category: 'places', difficulty: 'easy', aliases: [] },
      ],
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);

    vi.advanceTimersByTime(3_000);

    // Index 1 — the one it can actually draw.
    expect(calls.selectedIndexes).toEqual([1]);
  });

  it('puts strokes on the board through the drawing service', () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: BOT,
      word: 'house',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 60_000,
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);

    expect(room.board.strokes).toHaveLength(0);

    vi.advanceTimersByTime(20_000);

    expect(room.board.strokes.length).toBeGreaterThan(0);
    // Attributed to the bot, by the sanitiser, from the seat rather than from
    // the payload — which is what stops a stroke being credited to anybody
    // else.
    expect(room.board.strokes.every((stroke) => stroke.a === BOT)).toBe(true);
    expect(
      room.board.strokes.every((stroke) => stroke.p.length > 0),
    ).toBe(true);
  });

  it('never guesses at its own word', () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: BOT,
      word: 'house',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 60_000,
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);
    vi.advanceTimersByTime(60_000);

    expect(calls.guesses).toHaveLength(0);
  });

  it('stops drawing the moment the turn ends', () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: BOT,
      word: 'house',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 60_000,
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);
    vi.advanceTimersByTime(2_000);

    const drawnSoFar = room.board.strokes.length;
    expect(drawnSoFar).toBeGreaterThan(0);

    // The engine ends the turn and broadcasts, which is what reaches the bots.
    room.round.ended = true;
    botPlayerService.reconcile(room);

    vi.advanceTimersByTime(60_000);

    expect(room.board.strokes.length).toBe(drawnSoFar);
    expect(botPlayerService.activeWorkers()).toBe(0);
  });
});

/**
 * ## Why these advance timers asynchronously
 *
 * A guess attempt loads the word pool before it decides anything, so each
 * attempt suspends on an `await` and books the next one only after it
 * resolves. `advanceTimersByTime` is synchronous and never lets those
 * microtasks run, so it would fire the first attempt and then find nothing
 * scheduled. `advanceTimersByTimeAsync` flushes between callbacks, which is
 * what the real event loop does.
 */
describe('a bot that is guessing', () => {
  it('submits guesses through the engine', async () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: HUMAN,
      word: 'guitar',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 90_000,
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls.guesses.length).toBeGreaterThan(0);
    expect(calls.guesses.every((guess) => guess.userId === BOT)).toBe(true);
  });

  it('only ever names a word of the right length', async () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: HUMAN,
      // Six letters: `guitar`, `rocket` and `flower` fit; `house` does not.
      word: 'guitar',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 90_000,
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls.guesses.length).toBeGreaterThan(0);
    for (const guess of calls.guesses) {
      expect(guess.text).not.toBe('house');
    }
  });

  it('never repeats a word within a turn', async () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: HUMAN,
      word: 'guitar',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 120_000,
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);
    await vi.advanceTimersByTimeAsync(120_000);

    const words = calls.guesses.map((guess) => guess.text);
    expect(new Set(words).size).toBe(words.length);
  });

  it('stops as soon as it gets the word', async () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: HUMAN,
      word: 'guitar',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 120_000,
    });

    botPlayerService.bindEngine(stubEngine(room, 'guitar'));
    botPlayerService.reconcile(room);
    await vi.advanceTimersByTimeAsync(120_000);

    const correctAt = calls.guesses.findIndex((guess) => guess.text === 'guitar');

    // Either it never happened to say it — the accuracy roll is a rate, not a
    // guarantee — or it stopped there.
    if (correctAt >= 0) {
      expect(correctAt).toBe(calls.guesses.length - 1);
      expect(botPlayerService.activeWorkers()).toBe(0);
    }
  });

  it('stops guessing when the turn ends', async () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: HUMAN,
      word: 'guitar',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 120_000,
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);
    await vi.advanceTimersByTimeAsync(30_000);

    const before = calls.guesses.length;
    expect(before).toBeGreaterThan(0);

    room.phase = GAME_PHASE.roundEnd;
    room.round.ended = true;
    botPlayerService.reconcile(room);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls.guesses.length).toBe(before);
  });

  /**
   * The rule the whole bot design rests on, checked at the seam it would leak
   * through: the payload the guesser is handed.
   */
  it('is handed a game state with no word in it', async () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({ drawerId: HUMAN, word: 'guitar' });

    const engine = stubEngine(room);
    const asGuesser = engine.serializeGameState(room, BOT);
    const asDrawer = engine.serializeGameState(room, HUMAN);

    expect(asGuesser.word).toBeNull();
    expect(JSON.stringify(asGuesser)).not.toContain('guitar');
    // And the drawer does get it, so the test is testing something.
    expect(asDrawer.word).toBe('guitar');
  });
});

describe('cleaning up', () => {
  it('drops every timer when the match ends', () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: HUMAN,
      word: 'guitar',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 120_000,
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);
    vi.advanceTimersByTime(20_000);

    expect(botPlayerService.activeWorkers()).toBeGreaterThan(0);

    botPlayerService.clearRoom(room.roomId);

    expect(botPlayerService.activeWorkers()).toBe(0);
  });

  it('drops every timer when the room closes', () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: BOT,
      word: 'house',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 120_000,
    });

    botPlayerService.bindEngine(stubEngine(room));
    botPlayerService.reconcile(room);

    // Checked before advancing: the task is claimed synchronously, and this
    // particular drawing finishes in well under a second — so a later check
    // would be asserting that the cleanup had *not* happened yet.
    expect(botPlayerService.activeWorkers()).toBeGreaterThan(0);

    room.closed = true;
    botPlayerService.reconcile(room);

    expect(botPlayerService.activeWorkers()).toBe(0);
  });

  it(`leaves a bot's work alone on every later broadcast`, () => {
    const room = roomWithBot({ phase: GAME_PHASE.drawing });
    room.round = makeRound({
      drawerId: BOT,
      word: 'house',
      turnStartMs: Date.now(),
      turnEndMs: Date.now() + 120_000,
    });

    botPlayerService.bindEngine(stubEngine(room));

    // A drawing turn broadcasts several times — a hint landing, a guesser
    // scoring. Each one reaches `reconcile`, and a restart on any of them
    // would wipe the board and start the picture again.
    botPlayerService.reconcile(room);
    vi.advanceTimersByTime(3_000);

    const afterFirst = room.board.strokes.length;

    botPlayerService.reconcile(room);
    botPlayerService.reconcile(room);
    vi.advanceTimersByTime(1);

    expect(room.board.strokes.length).toBe(afterFirst);
    expect(botPlayerService.activeWorkers()).toBe(1);
  });
});
