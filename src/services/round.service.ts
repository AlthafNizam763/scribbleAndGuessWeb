import { roundRepository } from '@/repositories/round.repository';
import type { RoundResultDto } from '@/types/game.types';

/**
 * Round history.
 *
 * The *live* round is driven entirely by `game.service.ts` — it owns the
 * word, the countdown and the scoring. What is left for this service is
 * reading finished rounds back out of Mongo, which is what
 * `GET /api/games/:gameId/rounds` serves and what a post-match review would
 * use.
 *
 * Nothing here can leak a live answer: `toResult` refuses to return a word for
 * a round that has not ended, so even a mistaken call during a live turn
 * cannot become a back door around the word-privacy rules.
 */

export class RoundService {
  /** Every finished round of a game, oldest first. */
  async history(gameId: string): Promise<RoundResultDto[]> {
    const rounds = await roundRepository.findByGame(gameId);

    return rounds
      .filter((round) => round.endedAt !== null)
      .map((round) => ({
        round: round.roundNumber,
        gameId: String(round.gameId),
        turnNumber: round.turnNumber,
        word: round.word ?? '',
        drawerId: String(round.drawerId),
        scoreDeltas: Object.fromEntries(
          round.scoreDeltas instanceof Map
            ? round.scoreDeltas
            : Object.entries((round.scoreDeltas ?? {}) as Record<string, number>),
        ),
        totals: {},
        correctOrder: round.correctGuesses
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((guess) => String(guess.userId)),
      }));
  }

  /** How many players got each round, for a match summary. */
  async summary(gameId: string) {
    const rounds = await roundRepository.findByGame(gameId);

    return rounds
      .filter((round) => round.endedAt !== null)
      .map((round) => ({
        roundNumber: round.roundNumber,
        turnNumber: round.turnNumber,
        drawerId: String(round.drawerId),
        drawerName: round.drawerName,
        word: round.word ?? '',
        difficulty: round.wordDifficulty,
        correctGuessers: round.correctGuesses.length,
        endReason: round.endReason,
        durationMs: Math.max(0, round.turnEndMs - round.turnStartMs),
      }));
  }
}

export const roundService = new RoundService();
