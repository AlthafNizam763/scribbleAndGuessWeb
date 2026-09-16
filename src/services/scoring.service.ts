import { SCORING } from '@/constants/game.constants';
import type { WordDifficultyWire } from '@/constants/room.constants';

/**
 * Points (brief section 33).
 *
 * Pure functions over numbers: no clock, no database, no room. That is what
 * makes the formula testable and what lets the Flutter client run the identical
 * rules for its offline practice mode. The server is still the only thing that
 * *awards* points — the client merely predicts them.
 *
 * ## The shape of a guesser's score
 *
 * Speed is the main signal, order is the tie-breaker. A guess at the buzzer is
 * still worth `minGuessPoints`, because a game where a late correct answer
 * scores nothing teaches players to stop trying, which is the opposite of what
 * a party game wants.
 *
 *   points = (min + (max - min) x timeRatio + orderBonus) x difficultyMultiplier
 *
 * The brief's worked example uses `base + remaining x 2 + orderBonus`. This
 * formula is the same idea normalised against the round length, which matters
 * because the host can set the timer anywhere from 30 to 180 seconds: a flat
 * "two points per second left" would make a long round worth triple a short
 * one for identical play.
 */

export interface ScoringConfig {
  maxGuessPoints: number;
  minGuessPoints: number;
  firstGuessBonus: number;
  secondGuessBonus: number;
  thirdGuessBonus: number;
  drawerPointsPerGuess: number;
  drawerAllGuessedBonus: number;
  drawerMaxPoints: number;
  difficultyMultiplier: Record<WordDifficultyWire, number>;
}

/** The default weights, mirroring `ScoringConfig.standard` on the client. */
export const defaultScoringConfig: ScoringConfig = {
  maxGuessPoints: SCORING.maxGuessPoints,
  minGuessPoints: SCORING.minGuessPoints,
  firstGuessBonus: SCORING.firstGuessBonus,
  secondGuessBonus: SCORING.secondGuessBonus,
  thirdGuessBonus: SCORING.thirdGuessBonus,
  drawerPointsPerGuess: SCORING.drawerPointsPerGuess,
  drawerAllGuessedBonus: SCORING.drawerAllGuessedBonus,
  drawerMaxPoints: SCORING.drawerMaxPoints,
  difficultyMultiplier: { ...SCORING.difficultyMultiplier },
};

/** Fraction of the turn still unspent, clamped to 0..1. */
function timeRatio(msRemaining: number, msTotal: number): number {
  if (msTotal <= 0 || msRemaining <= 0) return 0;
  return msRemaining >= msTotal ? 1 : msRemaining / msTotal;
}

function multiplierFor(config: ScoringConfig, difficulty: WordDifficultyWire): number {
  return config.difficultyMultiplier[difficulty] ?? 1;
}

export class ScoringService {
  constructor(private readonly config: ScoringConfig = defaultScoringConfig) {}

  /**
   * What one correct guesser earns.
   *
   * `guessOrder` is 1-based: the first player to get it is 1. Anything past
   * third place earns no order bonus, only the time component.
   */
  guesserPoints(input: {
    msRemaining: number;
    msTotal: number;
    guessOrder: number;
    /**
     * The game mode's multiplier, applied last.
     *
     * Compensates for how much harder a mode makes guessing rather than
     * rewarding the choice of mode — so no mode is the obvious one to farm.
     * Defaults to 1, so a caller that does not care need not pass it.
     */
    modeMultiplier?: number;
    difficulty: WordDifficultyWire;
  }): number {
    const { config } = this;
    const ratio = timeRatio(input.msRemaining, input.msTotal);
    const span = config.maxGuessPoints - config.minGuessPoints;
    const timeComponent = config.minGuessPoints + span * ratio;

    const order = input.guessOrder < 1 ? 1 : input.guessOrder;
    const orderBonus =
      order === 1
        ? config.firstGuessBonus
        : order === 2
          ? config.secondGuessBonus
          : order === 3
            ? config.thirdGuessBonus
            : 0;

    const total =
      (timeComponent + orderBonus) *
      multiplierFor(config, input.difficulty) *
      (input.modeMultiplier ?? 1);
    return Math.max(0, Math.round(total));
  }

  /**
   * What the drawer earns for the turn.
   *
   * Scaled by how many players got it, so a drawing nobody can read scores
   * nothing and a clear one scores well — and capped, so drawing for a full
   * room is not worth more than winning several rounds of guessing.
   *
   * `totalGuessers` excludes the drawer: they cannot guess their own word.
   */
  drawerPoints(input: {
    correctGuessers: number;
    totalGuessers: number;
    /** The game mode's multiplier. See `guesserPoints`. */
    modeMultiplier?: number;
    difficulty: WordDifficultyWire;
  }): number {
    const { config } = this;
    if (input.totalGuessers <= 0 || input.correctGuessers <= 0) return 0;

    const guessed = Math.min(input.correctGuessers, input.totalGuessers);
    const earned =
      config.drawerPointsPerGuess *
      guessed *
      multiplierFor(config, input.difficulty) *
      (input.modeMultiplier ?? 1);
    const withBonus = guessed >= input.totalGuessers ? earned + config.drawerAllGuessedBonus : earned;

    return Math.min(Math.max(0, Math.round(withBonus)), Math.max(0, config.drawerMaxPoints));
  }

  /**
   * Ranks players highest score first, with ties sharing a rank.
   *
   * Standard competition ranking: two players on 300 are both 1st and the next
   * is 3rd. Ties break by name so the order is stable between broadcasts —
   * a leaderboard that reshuffles equal scores on every repaint looks broken.
   */
  standings<T extends { playerId: string; name: string; score: number }>(
    players: readonly T[],
  ): (T & { rank: number })[] {
    const sorted = [...players].sort(
      (a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.playerId.localeCompare(b.playerId),
    );

    const ranked: (T & { rank: number })[] = [];
    let previousScore: number | null = null;
    let previousRank = 0;

    sorted.forEach((player, index) => {
      const rank = previousScore === player.score ? previousRank : index + 1;
      previousScore = player.score;
      previousRank = rank;
      ranked.push({ ...player, rank });
    });

    return ranked;
  }
}

/** The instance the game engine uses. */
export const scoringService = new ScoringService();
