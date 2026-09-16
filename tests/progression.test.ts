import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_KEY,
  LEVEL_TITLES,
  MAX_LEVEL,
  XP_AWARDS,
  levelForXp,
  titleForLevel,
  xpForLevel,
} from '@/constants/progression.constants';
import { friendRepository } from '@/repositories/friend.repository';
import { progressionRepository } from '@/repositories/progression.repository';
import { userRepository } from '@/repositories/user.repository';
import { achievementService } from '@/services/achievement.service';
import { notificationService } from '@/services/notification.service';
import { progressionService } from '@/services/progression.service';
import { describeLevel, totalOf, xpService } from '@/services/xp.service';
import { emptyMatchStats, type RuntimeRoom } from '@/types/socket.types';
import { makePlayer, makeRoom } from './helpers';

/**
 * XP, levels and achievements.
 *
 * ## What is worth asserting here
 *
 * Two rules carry the whole feature, and both are about what must *not*
 * happen: an achievement must never pay twice, and no number a client controls
 * may become XP. Everything else — the curve, the award table — is arithmetic
 * that is only interesting because those two depend on it being stable.
 *
 * The third is the one the brief states directly: an abandoned or invalid game
 * pays nothing. That is enforced structurally rather than by a check, so the
 * tests go at the structure: a match with too few players, and a match where
 * nobody drew.
 *
 * As in the other suites the repositories are spied rather than the modules
 * mocked, so nothing here opens a database connection.
 */

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439012';

beforeEach(() => {
  vi.restoreAllMocks();
  // Notifications are fire-and-forget everywhere they are used; stubbed so the
  // tests assert on progression rather than on a push nobody is listening to.
  vi.spyOn(notificationService, 'notify').mockResolvedValue(null);
});

// ---------------------------------------------------------------- the curve

describe('the level curve', () => {
  it('starts every account at level 1 rather than level 0', () => {
    expect(levelForXp(0)).toBe(1);
    expect(xpForLevel(1)).toBe(0);
    expect(describeLevel(0).level).toBe(1);
  });

  it('is monotonic: more XP never means a lower level', () => {
    let previous = 0;
    for (let xp = 0; xp <= 200_000; xp += 250) {
      const level = levelForXp(xp);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  /**
   * `levelForXp` inverts `xpForLevel` in closed form rather than looping, so
   * the two can drift apart if either is edited alone. This is the test that
   * catches that.
   */
  it('agrees with its own inverse at every level boundary', () => {
    for (let level = 1; level <= MAX_LEVEL; level += 1) {
      const threshold = xpForLevel(level);
      expect(levelForXp(threshold)).toBe(level);
      if (level > 1) expect(levelForXp(threshold - 1)).toBe(level - 1);
    }
  });

  it('caps at the maximum level however much XP is thrown at it', () => {
    expect(levelForXp(Number.MAX_SAFE_INTEGER)).toBe(MAX_LEVEL);

    const capped = describeLevel(xpForLevel(MAX_LEVEL) * 10);
    expect(capped.isMaxLevel).toBe(true);
    expect(capped.nextLevelXp).toBeNull();
    // A full bar rather than one stuck near the end forever.
    expect(capped.progress).toBe(1);
  });

  it('gives every named tier its title, and levels between tiers the lower one', () => {
    for (const tier of LEVEL_TITLES) {
      expect(titleForLevel(tier.minLevel)).toBe(tier.title);
    }
    expect(titleForLevel(4)).toBe('Beginner');
    expect(titleForLevel(9)).toBe('Sketcher');
    expect(titleForLevel(19)).toBe('Artist');
  });

  it('reports progress inside the current level, not across the whole curve', () => {
    const start = xpForLevel(5);
    const span = xpForLevel(6) - start;
    const half = describeLevel(start + Math.floor(span / 2));

    expect(half.level).toBe(5);
    expect(half.xpIntoLevel).toBeCloseTo(span / 2, -1);
    expect(half.progress).toBeGreaterThan(0.4);
    expect(half.progress).toBeLessThan(0.6);
  });
});

// ------------------------------------------------------------------- awards

describe('XP awards', () => {
  it('prices a payout from the table and never from its caller', () => {
    expect(
      totalOf([
        { reason: 'participated', count: 1 },
        { reason: 'correctGuess', count: 3 },
      ]),
    ).toBe(XP_AWARDS.participated + XP_AWARDS.correctGuess * 3);
  });

  it('ignores negative and fractional counts rather than paying for them', () => {
    expect(totalOf([{ reason: 'correctGuess', count: -100 }])).toBe(0);
    expect(totalOf([{ reason: 'correctGuess', count: 2.9 }])).toBe(
      XP_AWARDS.correctGuess * 2,
    );
  });

  it('writes the balance once for a whole batch, and a history row per line', async () => {
    const addXp = vi.spyOn(progressionRepository, 'addXp').mockResolvedValue({
      before: 0,
      after: 45,
      levelBefore: 1,
      levelAfter: 1,
    });
    const logXp = vi.spyOn(progressionRepository, 'logXp').mockResolvedValue();

    const outcome = await xpService.award({
      userId: USER_A,
      awards: [
        { reason: 'participated', count: 1 },
        { reason: 'correctGuess', count: 2 },
      ],
      gameId: null,
    });

    expect(outcome?.earned).toBe(XP_AWARDS.participated + XP_AWARDS.correctGuess * 2);
    expect(addXp).toHaveBeenCalledTimes(1);
    expect(logXp).toHaveBeenCalledTimes(2);
  });

  it('writes nothing at all when nothing was earned', async () => {
    const addXp = vi.spyOn(progressionRepository, 'addXp').mockResolvedValue(null);

    await expect(
      xpService.award({ userId: USER_A, awards: [{ reason: 'correctGuess', count: 0 }] }),
    ).resolves.toBeNull();

    expect(addXp).not.toHaveBeenCalled();
  });

  it('reports a level-up only when a boundary was actually crossed', async () => {
    vi.spyOn(progressionRepository, 'logXp').mockResolvedValue();

    vi.spyOn(progressionRepository, 'addXp').mockResolvedValue({
      before: 90,
      after: 140,
      levelBefore: 1,
      levelAfter: 2,
    });
    expect(
      (await xpService.award({ userId: USER_A, awards: [{ reason: 'wonGame', count: 1 }] }))
        ?.leveledUp,
    ).toBe(true);

    vi.spyOn(progressionRepository, 'addXp').mockResolvedValue({
      before: 200,
      after: 250,
      levelBefore: 2,
      levelAfter: 2,
    });
    expect(
      (await xpService.award({ userId: USER_A, awards: [{ reason: 'wonGame', count: 1 }] }))
        ?.leveledUp,
    ).toBe(false);
  });

  /**
   * The XP history is a log, not the authority. A failed history write must
   * not cost the player the XP, which has already been written.
   */
  it('keeps the XP when the history row fails to write', async () => {
    vi.spyOn(progressionRepository, 'addXp').mockResolvedValue({
      before: 0,
      after: 25,
      levelBefore: 1,
      levelAfter: 1,
    });
    vi.spyOn(progressionRepository, 'logXp').mockRejectedValue(new Error('mongo is down'));

    await expect(
      xpService.award({ userId: USER_A, awards: [{ reason: 'participated', count: 1 }] }),
    ).resolves.toMatchObject({ earned: XP_AWARDS.participated });
  });
});

// ------------------------------------------------------------- achievements

describe('the achievement catalogue', () => {
  it('has unique, stable keys', () => {
    const keys = ACHIEVEMENTS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ACHIEVEMENTS_BY_KEY.size).toBe(ACHIEVEMENTS.length);
  });

  it('gives every entry a positive threshold and reward', () => {
    for (const entry of ACHIEVEMENTS) {
      expect(entry.threshold).toBeGreaterThan(0);
      expect(entry.xpReward).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });
});

describe('unlocking achievements', () => {
  /** A counter snapshot that clears the first-game and first-win thresholds. */
  const WINNER = {
    gamesPlayed: 1,
    gamesWon: 1,
    correctGuesses: 0,
    firstGuesses: 0,
    fastGuesses: 0,
    perfectDrawings: 0,
    bestWinStreak: 1,
    bestRoundScore: 0,
    friendCount: 0,
    dailyChallengesCompleted: 0,
    tournamentsWon: 0,
  };

  it('unlocks exactly what the counters deserve', async () => {
    vi.spyOn(progressionRepository, 'unlockedKeys').mockResolvedValue(new Set());
    vi.spyOn(progressionRepository, 'unlock').mockResolvedValue(true);
    vi.spyOn(xpService, 'awardFixed').mockResolvedValue(null);

    const unlocked = await achievementService.evaluate({
      userId: USER_A,
      snapshot: WINNER,
    });

    expect(unlocked.map((entry) => entry.key).sort()).toEqual(['first_game', 'first_win']);
  });

  it('skips what is already unlocked without touching the database', async () => {
    vi.spyOn(progressionRepository, 'unlockedKeys').mockResolvedValue(
      new Set(['first_game', 'first_win']),
    );
    const unlock = vi.spyOn(progressionRepository, 'unlock').mockResolvedValue(true);

    const unlocked = await achievementService.evaluate({
      userId: USER_A,
      snapshot: WINNER,
    });

    expect(unlocked).toEqual([]);
    expect(unlock).not.toHaveBeenCalled();
  });

  /**
   * The rule the unique index exists for. Two evaluations racing both see the
   * achievement as deserved and unlocked by nobody; the index lets one insert
   * through, and only that one may pay.
   */
  it('pays nothing when the insert lost the race', async () => {
    vi.spyOn(progressionRepository, 'unlockedKeys').mockResolvedValue(new Set());
    vi.spyOn(progressionRepository, 'unlock').mockResolvedValue(false);
    const awardFixed = vi.spyOn(xpService, 'awardFixed').mockResolvedValue(null);

    const unlocked = await achievementService.evaluate({
      userId: USER_A,
      snapshot: WINNER,
    });

    expect(unlocked).toEqual([]);
    expect(awardFixed).not.toHaveBeenCalled();
  });

  it('pays the catalogue amount, never an amount from the caller', async () => {
    vi.spyOn(progressionRepository, 'unlockedKeys').mockResolvedValue(new Set());
    vi.spyOn(progressionRepository, 'unlock').mockResolvedValue(true);
    const awardFixed = vi.spyOn(xpService, 'awardFixed').mockResolvedValue(null);

    await achievementService.evaluate({
      userId: USER_A,
      snapshot: { ...WINNER, gamesWon: 0, bestWinStreak: 0 },
    });

    const definition = ACHIEVEMENTS_BY_KEY.get('first_game');
    expect(awardFixed).toHaveBeenCalledWith(
      expect.objectContaining({ amount: definition?.xpReward }),
    );
  });

  it('carries on with the rest when one unlock throws', async () => {
    vi.spyOn(progressionRepository, 'unlockedKeys').mockResolvedValue(new Set());
    vi.spyOn(xpService, 'awardFixed').mockResolvedValue(null);
    vi.spyOn(progressionRepository, 'unlock').mockImplementation(
      async ({ key }: { key: string }) => {
        if (key === 'first_game') throw new Error('mongo is down');
        return true;
      },
    );

    const unlocked = await achievementService.evaluate({
      userId: USER_A,
      snapshot: WINNER,
    });

    expect(unlocked.map((entry) => entry.key)).toEqual(['first_win']);
  });

  it('never reports progress past the target on a locked card', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue({
      gamesPlayed: 4_000,
      gamesWon: 0,
      correctGuesses: 9_999,
      firstGuesses: 0,
      fastGuesses: 0,
      perfectDrawings: 0,
      bestWinStreak: 0,
      bestRoundScore: 0,
      dailyChallengesCompleted: 0,
      tournamentsWon: 0,
    } as never);
    vi.spyOn(friendRepository, 'countFriends').mockResolvedValue(0);
    vi.spyOn(progressionRepository, 'listUnlocked').mockResolvedValue([]);

    const page = await achievementService.listFor(USER_A);
    const hundred = page.items.find((entry) => entry.key === 'hundred_guesses');

    expect(hundred?.progress).toBe(100);
    expect(hundred?.target).toBe(100);
  });

  it('returns locked entries too, so the screen is a list of things to aim at', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue(null as never);
    vi.spyOn(friendRepository, 'countFriends').mockResolvedValue(0);
    vi.spyOn(progressionRepository, 'listUnlocked').mockResolvedValue([]);

    const page = await achievementService.listFor(USER_A);

    expect(page.items).toHaveLength(ACHIEVEMENTS.length);
    expect(page.unlockedCount).toBe(0);
    expect(page.items.every((entry) => !entry.unlocked)).toBe(true);
  });
});

// --------------------------------------------------------- the match report

describe('recording a finished match', () => {
  /**
   * A room that has actually been played: two seats, turns taken.
   *
   * `turnNumber` is what `isRankedMatch` reads to tell a real match from one
   * a host started and immediately abandoned, so it is set here rather than
   * left at the builder's zero.
   */
  function playedRoom(): RuntimeRoom {
    const room = makeRoom({
      players: [
        makePlayer({ userId: USER_A, score: 120 }),
        makePlayer({ userId: USER_B, score: 80 }),
      ],
    });
    room.turnNumber = 4;
    return room;
  }

  const STANDINGS = [
    { playerId: USER_A, score: 120, won: true },
    { playerId: USER_B, score: 80, won: false },
  ];

  it('folds the in-memory tally into the stored counters', async () => {
    const room = playedRoom();
    const player = room.players.get(USER_A);
    if (player) {
      player.matchStats = {
        ...emptyMatchStats(),
        correctGuesses: 3,
        firstGuesses: 1,
        drawingTurns: 2,
        perfectDrawings: 1,
      };
    }

    const addCounters = vi.spyOn(progressionRepository, 'addCounters').mockResolvedValue();
    vi.spyOn(progressionRepository, 'recordStreak').mockResolvedValue(1);
    vi.spyOn(xpService, 'award').mockResolvedValue(null);
    vi.spyOn(achievementService, 'evaluate').mockResolvedValue([]);
    vi.spyOn(friendRepository, 'friendIdsOf').mockResolvedValue([]);
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ xp: 0 } as never);

    await progressionService.recordMatch({ room, standings: STANDINGS, gameId: null });

    expect(addCounters).toHaveBeenCalledWith(
      USER_A,
      expect.objectContaining({
        correctGuesses: 3,
        firstGuesses: 1,
        drawingTurns: 2,
        perfectDrawings: 1,
      }),
    );
  });

  it('prices the payout from the tally, and pays the winner more', async () => {
    const room = playedRoom();
    const winner = room.players.get(USER_A);
    if (winner) {
      winner.matchStats = { ...emptyMatchStats(), correctGuesses: 2, drawingTurns: 1 };
    }

    vi.spyOn(progressionRepository, 'addCounters').mockResolvedValue();
    vi.spyOn(progressionRepository, 'recordStreak').mockResolvedValue(1);
    vi.spyOn(achievementService, 'evaluate').mockResolvedValue([]);
    vi.spyOn(friendRepository, 'friendIdsOf').mockResolvedValue([]);
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ xp: 0 } as never);

    const award = vi.spyOn(xpService, 'award').mockResolvedValue(null);

    await progressionService.recordMatch({ room, standings: STANDINGS, gameId: null });

    const winnerCall = award.mock.calls.find((call) => call[0].userId === USER_A)?.[0];
    const loserCall = award.mock.calls.find((call) => call[0].userId === USER_B)?.[0];

    expect(winnerCall?.awards).toEqual(
      expect.arrayContaining([{ reason: 'wonGame', count: 1 }]),
    );
    expect(loserCall?.awards).not.toEqual(
      expect.arrayContaining([{ reason: 'wonGame', count: 1 }]),
    );
    // The loser still earns for turning up. Losing should not be punished twice.
    expect(loserCall?.awards).toEqual(
      expect.arrayContaining([{ reason: 'participated', count: 1 }]),
    );
  });

  it('pays the friend bonus only to somebody who played with a friend', async () => {
    const room = playedRoom();

    vi.spyOn(progressionRepository, 'addCounters').mockResolvedValue();
    vi.spyOn(progressionRepository, 'recordStreak').mockResolvedValue(1);
    vi.spyOn(achievementService, 'evaluate').mockResolvedValue([]);
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ xp: 0 } as never);
    vi.spyOn(friendRepository, 'friendIdsOf').mockImplementation(async (userId: string) =>
      userId === USER_A ? [USER_B] : [USER_A],
    );

    const award = vi.spyOn(xpService, 'award').mockResolvedValue(null);

    await progressionService.recordMatch({ room, standings: STANDINGS, gameId: null });

    for (const call of award.mock.calls) {
      expect(call[0].awards).toEqual(
        expect.arrayContaining([{ reason: 'playedWithFriend', count: 1 }]),
      );
    }
  });

  /** The brief's rule: an abandoned or invalid game pays nothing. */
  it('pays nothing for a match nobody drew in', async () => {
    const room = playedRoom();
    room.turnNumber = 0;

    const addCounters = vi.spyOn(progressionRepository, 'addCounters').mockResolvedValue();
    const award = vi.spyOn(xpService, 'award').mockResolvedValue(null);

    const reports = await progressionService.recordMatch({
      room,
      standings: STANDINGS,
      gameId: null,
    });

    expect(reports).toEqual([]);
    expect(addCounters).not.toHaveBeenCalled();
    expect(award).not.toHaveBeenCalled();
  });

  it('pays nothing for a match with too few players to have been one', async () => {
    const room = playedRoom();
    const award = vi.spyOn(xpService, 'award').mockResolvedValue(null);

    const reports = await progressionService.recordMatch({
      room,
      standings: [STANDINGS[0]!],
      gameId: null,
    });

    expect(reports).toEqual([]);
    expect(award).not.toHaveBeenCalled();
  });

  it('skips a player whose seat is gone without abandoning the others', async () => {
    const room = playedRoom();
    room.players.delete(USER_B);

    vi.spyOn(progressionRepository, 'addCounters').mockResolvedValue();
    vi.spyOn(progressionRepository, 'recordStreak').mockResolvedValue(1);
    vi.spyOn(achievementService, 'evaluate').mockResolvedValue([]);
    vi.spyOn(friendRepository, 'friendIdsOf').mockResolvedValue([]);
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ xp: 0 } as never);
    vi.spyOn(xpService, 'award').mockResolvedValue({
      earned: 25,
      level: describeLevel(25),
      leveledUp: false,
    });

    const reports = await progressionService.recordMatch({
      room,
      standings: STANDINGS,
      gameId: null,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.playerId).toBe(USER_A);
  });

  it('does not let one player failing cost everybody else their progression', async () => {
    const room = playedRoom();

    vi.spyOn(progressionRepository, 'recordStreak').mockResolvedValue(1);
    vi.spyOn(achievementService, 'evaluate').mockResolvedValue([]);
    vi.spyOn(friendRepository, 'friendIdsOf').mockResolvedValue([]);
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ xp: 0 } as never);
    vi.spyOn(xpService, 'award').mockResolvedValue({
      earned: 25,
      level: describeLevel(25),
      leveledUp: false,
    });
    vi.spyOn(progressionRepository, 'addCounters').mockImplementation(
      async (userId: string) => {
        if (userId === USER_A) throw new Error('mongo is down');
      },
    );

    const reports = await progressionService.recordMatch({
      room,
      standings: STANDINGS,
      gameId: null,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.playerId).toBe(USER_B);
  });

  it('counts an achievement reward in the match report', async () => {
    const room = playedRoom();

    vi.spyOn(progressionRepository, 'addCounters').mockResolvedValue();
    vi.spyOn(progressionRepository, 'recordStreak').mockResolvedValue(1);
    vi.spyOn(friendRepository, 'friendIdsOf').mockResolvedValue([]);
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ xp: 500 } as never);
    vi.spyOn(xpService, 'award').mockResolvedValue({
      earned: 25,
      level: describeLevel(25),
      leveledUp: false,
    });
    vi.spyOn(achievementService, 'evaluate').mockResolvedValue([
      {
        key: 'first_game',
        name: 'First Game',
        description: 'Finish your first match.',
        xpReward: 25,
        unlocked: true,
        unlockedAtMs: Date.now(),
        progress: 1,
        target: 1,
        showProgress: false,
      },
    ]);

    const reports = await progressionService.recordMatch({
      room,
      standings: STANDINGS,
      gameId: null,
    });

    expect(reports[0]?.xpEarned).toBe(50);
    expect(reports[0]?.unlocked).toHaveLength(1);
  });
});
