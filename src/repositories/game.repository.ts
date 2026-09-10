import type { Types } from 'mongoose';

import { Game, type GameDocument } from '@/models/Game';
import { isObjectId } from '@/repositories/user.repository';
import type { GamePhaseWire } from '@/constants/room.constants';
import type { PlayerScoreDto } from '@/types/game.types';

/** Data access for `games`. */
export const gameRepository = {
  async create(input: {
    roomId: string;
    roomCode: string;
    totalRounds: number;
    turnOrder: string[];
  }): Promise<GameDocument> {
    return (await Game.create({
      roomId: input.roomId,
      roomCode: input.roomCode,
      totalRounds: input.totalRounds,
      turnOrder: input.turnOrder as unknown as Types.ObjectId[],
      currentRound: 1,
      turnIndex: 0,
    })) as GameDocument;
  },

  async findById(gameId: string) {
    if (!isObjectId(gameId)) return null;
    return Game.findById(gameId).lean().exec();
  },

  async updateProgress(
    gameId: string,
    patch: {
      phase?: GamePhaseWire;
      currentRound?: number;
      turnIndex?: number;
      currentRoundId?: string | null;
    },
  ): Promise<void> {
    if (!isObjectId(gameId)) return;
    await Game.updateOne({ _id: gameId }, { $set: patch }).exec();
  },

  /** Records a word as used, so the same match never deals it twice. */
  async addUsedWord(gameId: string, word: string): Promise<void> {
    if (!isObjectId(gameId)) return;
    await Game.updateOne({ _id: gameId }, { $addToSet: { usedWords: word } }).exec();
  },

  async finish(
    gameId: string,
    input: { standings: PlayerScoreDto[]; winnerId: string | null },
  ): Promise<void> {
    if (!isObjectId(gameId)) return;
    await Game.updateOne(
      { _id: gameId },
      {
        $set: {
          phase: 'final_result',
          endedAt: new Date(),
          winnerId: input.winnerId,
          standings: input.standings.map((entry) => ({
            userId: entry.playerId,
            username: entry.name,
            avatarId: entry.avatarId,
            avatarColorIndex: entry.avatarColorIndex,
            score: entry.score,
            rank: entry.rank,
          })),
        },
      },
    ).exec();
  },

  /** Abandons a game that will never finish, so it is not left "in progress". */
  async abort(gameId: string): Promise<void> {
    if (!isObjectId(gameId)) return;
    await Game.updateOne(
      { _id: gameId, endedAt: null },
      { $set: { phase: 'final_result', endedAt: new Date() } },
    ).exec();
  },
};
