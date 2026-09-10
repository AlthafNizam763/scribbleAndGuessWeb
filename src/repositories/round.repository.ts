import type { Types } from 'mongoose';

import { Round, type RoundDocument } from '@/models/Round';
import { isObjectId } from '@/repositories/user.repository';
import type { WordDifficultyWire } from '@/constants/room.constants';
import type { StrokeDto } from '@/types/drawing.types';
import type { WordItemDto } from '@/types/game.types';

/** Data access for `rounds`. */
export const roundRepository = {
  async create(input: {
    gameId: string;
    roomId: string;
    roundNumber: number;
    turnNumber: number;
    drawerId: string;
    drawerName: string;
    wordChoices: (WordItemDto & { aliases: string[] })[];
  }): Promise<RoundDocument> {
    return (await Round.create({
      gameId: input.gameId,
      roomId: input.roomId,
      roundNumber: input.roundNumber,
      turnNumber: input.turnNumber,
      drawerId: input.drawerId,
      drawerName: input.drawerName,
      wordChoices: input.wordChoices,
    })) as RoundDocument;
  },

  /** Records the drawer's pick and the deadlines the turn will run to. */
  async startTurn(
    roundId: string,
    input: {
      word: string;
      wordDifficulty: WordDifficultyWire;
      wordAliases: string[];
      turnStartMs: number;
      turnEndMs: number;
    },
  ): Promise<void> {
    if (!isObjectId(roundId)) return;
    await Round.updateOne({ _id: roundId }, { $set: input }).exec();
  },

  async recordHint(roundId: string, hintIndices: number[], hintsRevealed: number): Promise<void> {
    if (!isObjectId(roundId)) return;
    await Round.updateOne({ _id: roundId }, { $set: { hintIndices, hintsRevealed } }).exec();
  },

  /**
   * Appends one correct guess.
   *
   * `$push` on the array plus a guarded filter: the update only applies when
   * this user is not already in `correctGuesses`, so two guesses arriving in
   * the same millisecond cannot both append. The in-memory check in the game
   * service is the fast path; this is the durable backstop (brief section 32).
   */
  async recordCorrectGuess(
    roundId: string,
    input: {
      userId: string;
      username: string;
      order: number;
      msRemaining: number;
      points: number;
    },
  ): Promise<boolean> {
    if (!isObjectId(roundId)) return false;
    const result = await Round.updateOne(
      { _id: roundId, 'correctGuesses.userId': { $ne: input.userId } },
      {
        $push: {
          correctGuesses: {
            userId: input.userId as unknown as Types.ObjectId,
            username: input.username,
            order: input.order,
            msRemaining: input.msRemaining,
            points: input.points,
            guessedAt: new Date(),
          },
        },
        $set: { [`scoreDeltas.${input.userId}`]: input.points },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async finish(
    roundId: string,
    input: {
      scoreDeltas: Record<string, number>;
      snapshot: StrokeDto[];
      endReason: 'timeout' | 'allGuessed' | 'drawerLeft' | 'skipped' | 'aborted';
    },
  ): Promise<void> {
    if (!isObjectId(roundId)) return;
    await Round.updateOne(
      { _id: roundId },
      {
        $set: {
          scoreDeltas: input.scoreDeltas,
          snapshot: input.snapshot,
          endReason: input.endReason,
          endedAt: new Date(),
        },
      },
    ).exec();
  },

  async findByGame(gameId: string) {
    if (!isObjectId(gameId)) return [];
    return Round.find({ gameId }).sort({ turnNumber: 1 }).lean().exec();
  },
};
