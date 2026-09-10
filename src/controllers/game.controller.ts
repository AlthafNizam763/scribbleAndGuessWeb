import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { parseBody } from '@/middleware/validation.middleware';
import { gameRepository } from '@/repositories/game.repository';
import { gameService } from '@/services/game.service';
import { roomService } from '@/services/room.service';
import { roundService } from '@/services/round.service';
import { startGameSchema } from '@/validators/game.validator';
import { errors } from '@/utils/errors';

/** Game endpoints (brief section 18). */
export const gameController = {
  /**
   * `POST /api/games/start`
   *
   * Host-only, minimum-player-count enforced, both checked inside
   * `gameService.startGame` — the same code the socket's `c:game:start` runs.
   * The room is found by id or by code so a caller holding either can start.
   */
  async start(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const body = await parseBody(request, startGameSchema);
    const key = body.roomId ?? body.roomCode ?? '';

    const room = roomService.get(key) ?? roomService.getByCode(key);
    if (!room) throw errors.roomNotFound();

    await gameService.startGame(room, user.id);

    return ok({
      game: gameService.serializeGameState(room, user.id),
      room: roomService.serializeRoom(room),
    });
  },

  /**
   * `GET /api/games/:gameId`
   *
   * History, not live state. A finished game's standings and rounds are safe
   * to read; a live one returns only its progress, because its current word
   * lives in the round document and must not travel over a REST call that any
   * player could make.
   */
  async get(request: Request, gameId: string): Promise<NextResponse> {
    await requireUser(request);
    await connectToDatabase();

    const game = await gameRepository.findById(gameId);
    if (!game) throw errors.notFound('That game does not exist.');

    const finished = game.endedAt !== null;

    return ok({
      game: {
        id: String(game._id),
        roomCode: game.roomCode,
        phase: game.phase,
        currentRound: game.currentRound,
        totalRounds: game.totalRounds,
        startedAt: game.startedAt,
        endedAt: game.endedAt,
        standings: game.standings,
        winnerId: game.winnerId ? String(game.winnerId) : null,
      },
      // Withheld until the game is over: a round summary carries every word.
      rounds: finished ? await roundService.summary(gameId) : [],
    });
  },

  /**
   * `GET /api/games/:gameId/rounds`
   *
   * Finished rounds only. `roundService.history` filters on `endedAt`, so a
   * live round's word cannot be read out of it.
   */
  async rounds(request: Request, gameId: string): Promise<NextResponse> {
    await requireUser(request);
    await connectToDatabase();

    return ok({ rounds: await roundService.history(gameId) });
  },
};
