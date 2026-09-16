import { describe, expect, it } from 'vitest';

import { tournamentBotFillService } from '@/services/tournament/botFill.service';

/**
 * How many AI players a tournament gets.
 *
 * ## Why this is the most tested thing in the feature
 *
 * Because it is the only place where a product rule and an arithmetic rule
 * meet, and getting it wrong is silent. Too few bots and a tournament that
 * people joined cannot start; too many and a person's seat goes to a robot; a
 * missing floor and the server plays a bracket against itself and announces a
 * winner to nobody.
 *
 * Every example the brief gives is a case below, plus the edges the brief does
 * not name — because those are the ones an implementation gets wrong.
 */

/** The standard tournament: four to sixteen, at most three bots. */
const STANDARD = {
  minPlayers: 4,
  maxPlayers: 16,
  minHumanPlayers: 1,
  maxBots: 3,
  allowBots: true,
};

function plan(humans: number, botsAlready = 0, overrides: Partial<typeof STANDARD> = {}) {
  return tournamentBotFillService.plan({
    humans,
    botsAlready,
    ...STANDARD,
    ...overrides,
  });
}

describe('filling a four-player tournament', () => {
  it('adds nothing when four people turned up', () => {
    const outcome = plan(4);

    expect(outcome.botsAdded).toBe(0);
    expect(outcome.total).toBe(4);
    expect(outcome.cancelReason).toBeNull();
  });

  it('adds one bot for three people', () => {
    expect(plan(3)).toMatchObject({ botsAdded: 1, total: 4, cancelReason: null });
  });

  it('adds two bots for two people', () => {
    expect(plan(2)).toMatchObject({ botsAdded: 2, total: 4, cancelReason: null });
  });

  it('adds three bots for one person', () => {
    expect(plan(1)).toMatchObject({ botsAdded: 3, total: 4, cancelReason: null });
  });

  /**
   * The rule the whole feature rests on. A tournament with no people in it is
   * the server playing against itself, and there is no number of bots that
   * makes that worth doing.
   */
  it('cancels rather than fielding a tournament of nothing but bots', () => {
    const outcome = plan(0);

    expect(outcome.botsAdded).toBe(0);
    expect(outcome.cancelReason).toBe('Nobody checked in for this tournament.');
  });
});

describe('preferring people to bots', () => {
  /**
   * Six humans is a six-player tournament. Topping it up to eight because the
   * bracket would be tidier would take two seats nobody asked for and produce
   * a draw with two byes in it — worse in every direction.
   */
  it('never adds bots to a tournament that already has enough people', () => {
    expect(plan(6).botsAdded).toBe(0);
    expect(plan(11).botsAdded).toBe(0);
    expect(plan(16).botsAdded).toBe(0);
  });

  /**
   * The explicit warning in the brief: a sixteen-player ceiling is a ceiling,
   * not a quota. Nothing fills it with bots because it exists.
   */
  it('does not fill a large tournament to its maximum', () => {
    const outcome = plan(2, 0, { maxPlayers: 16 });

    expect(outcome.botsAdded).toBe(2);
    expect(outcome.total).toBe(4);
  });

  it('counts bots that are already on the roster', () => {
    // One person and one bot already there: it needs two more, not three.
    expect(plan(1, 1)).toMatchObject({ botsAdded: 2, total: 4 });
  });
});

describe('the limits', () => {
  it('never exceeds the bot ceiling, and cancels when that leaves too few', () => {
    // One human, a minimum of six, but only three bots allowed: five is not a
    // playable tournament, so it does not run rather than running short.
    const outcome = plan(1, 0, { minPlayers: 6, maxBots: 3 });

    expect(outcome.botsAdded).toBe(0);
    expect(outcome.cancelReason).toContain('4 players available');
  });

  it('never exceeds the player ceiling', () => {
    const outcome = plan(3, 0, { minPlayers: 8, maxPlayers: 4, maxBots: 8 });

    expect(outcome.botsAdded).toBe(0);
    expect(outcome.cancelReason).not.toBeNull();
  });

  it('cancels a short tournament when bots are switched off', () => {
    const outcome = plan(2, 0, { allowBots: false });

    expect(outcome.botsAdded).toBe(0);
    expect(outcome.cancelReason).toBe('Only 2 players checked in.');
  });

  it('still runs on people alone when bots are switched off', () => {
    expect(plan(5, 0, { allowBots: false }).cancelReason).toBeNull();
  });

  /**
   * A deployment could require more than one person. The check runs before any
   * arithmetic, so no combination of bots can route around it.
   */
  it('honours a higher human minimum', () => {
    const outcome = plan(1, 0, { minHumanPlayers: 2 });

    expect(outcome.botsAdded).toBe(0);
    expect(outcome.cancelReason).toContain('at least 2 real players');
  });
});

describe('what the outcome reports', () => {
  it('describes the roster it decided on, not the one it was given', () => {
    const outcome = plan(2);

    expect(outcome).toEqual({
      humans: 2,
      botsBefore: 0,
      botsAdded: 2,
      total: 4,
      cancelReason: null,
    });
  });
});
