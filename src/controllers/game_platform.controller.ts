import { BOT_DIFFICULTY, type BotDifficultyWire } from '@/constants/autoTournament.constants';
import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { isGameId, type GameId } from '@/games/game.types';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { gamePlatformService } from '@/services/game_platform.service';
import { errors } from '@/utils/errors';

/** REST facade over the reusable game platform. Every state-changing call is authenticated. */
export const gamePlatformController = {
  async list(request: Request): Promise<NextResponse> {
    await requireUser(request);
    return ok({ items: gamePlatformService.definitions(), total: 5 });
  },

  async detail(request: Request, value: string): Promise<NextResponse> {
    await requireUser(request);
    return ok({ game: gamePlatformService.definition(parseGameId(value)) });
  },

  async rooms(request: Request, value: string): Promise<NextResponse> {
    await requireUser(request); await connectToDatabase();
    const gameId = parseGameId(value);
    return ok({ items: await gamePlatformService.listRooms(gameId) });
  },

  async createRoom(request: Request, value: string): Promise<NextResponse> {
    const user = await requireUser(request); enforceHttpLimit('createRoom', clientIdentity(request, user.id));
    const body = await objectBody(request); const gameId = parseGameId(value);
    const room = await gamePlatformService.createRoom({
      gameId, owner: user, isPrivate: body.isPrivate === true,
      maxPlayers: numberOrUndefined(body.maxPlayers),
    });
    return ok({ room }, 201);
  },

  async quickMatch(request: Request, value: string): Promise<NextResponse> {
    const user = await requireUser(request); enforceHttpLimit('quickPlay', clientIdentity(request, user.id));
    const gameId = parseGameId(value);
    const outcome = await gamePlatformService.quickMatch(gameId, user);
    return ok(outcome, outcome.created ? 201 : 200);
  },

  async join(request: Request, value: string, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request); enforceHttpLimit('joinRoom', clientIdentity(request, user.id));
    const room = await gamePlatformService.joinRoom(parseGameId(value), roomId, user);
    return ok({ room });
  },

  async leave(request: Request, value: string, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    return ok({ room: await gamePlatformService.leaveRoom(parseGameId(value), roomId, user.id), left: true });
  },

  async ready(request: Request, value: string, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request); const body = await objectBody(request);
    const ready = typeof body.ready === 'boolean' ? body.ready : true;
    return ok(await gamePlatformService.readyRoom(parseGameId(value), roomId, user.id, ready));
  },

  /**
   * `POST /api/games/:gameId/rooms/:roomId/stupids` — seat bot players.
   *
   * Owner only and lobby only, both enforced in the service. The body names a
   * count and nothing else: which Stupids get seated, and at what difficulty,
   * is the server's decision — a client that could name a bot could name the
   * same one twice, or one an operator has switched off.
   *
   * `DELETE` on the same path removes them all, so filling a room with bots is
   * not a one-way door when real players turn up.
   */
  async addStupids(request: Request, value: string, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('moderation', clientIdentity(request, user.id));
    await connectToDatabase();

    const body = await objectBody(request);
    const asked = numberOrUndefined(body.count) ?? 1;

    // An unrecognised difficulty falls back to Normal rather than failing the
    // call: the host asked for bots, and refusing the whole request over a
    // dial the client got wrong would leave them with an empty room.
    const wanted = typeof body.difficulty === 'string' ? body.difficulty.toUpperCase() : '';
    const difficulty = (Object.values(BOT_DIFFICULTY) as string[]).includes(wanted)
      ? wanted as BotDifficultyWire
      : BOT_DIFFICULTY.normal;

    const seated = await gamePlatformService.addStupids({
      gameId: parseGameId(value), roomId, actorId: user.id,
      // Clamped rather than refused: somebody asking for twelve in a four-seat
      // game wants the seats filled, not an error they cannot act on.
      count: Math.max(1, Math.min(Math.floor(asked), 16)),
      difficulty,
    });

    return ok({ seated, room: await gamePlatformService.roomSnapshot(parseGameId(value), roomId) });
  },

  async clearStupids(request: Request, value: string, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const removed = await gamePlatformService.clearStupids(parseGameId(value), roomId, user.id);
    return ok({ removed, room: await gamePlatformService.roomSnapshot(parseGameId(value), roomId) });
  },

  async match(request: Request, value: string, matchId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    return ok(await gamePlatformService.matchForViewer(parseGameId(value), matchId, user.id));
  },

  async result(request: Request, value: string, matchId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    return ok({ result: await gamePlatformService.result(parseGameId(value), matchId, user.id) });
  },

  async action(request: Request, value: string, matchId: string): Promise<NextResponse> {
    const user = await requireUser(request); enforceHttpLimit('action', clientIdentity(request, user.id));
    return ok(await gamePlatformService.action(parseGameId(value), matchId, user.id, await objectBody(request)));
  },

  async chat(request: Request, value: string, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request); enforceHttpLimit('chat', clientIdentity(request, user.id));
    const body = await objectBody(request);
    return ok({ message: await gamePlatformService.sendChat(parseGameId(value), roomId, user, typeof body.message === 'string' ? body.message : '') }, 201);
  },
};

function parseGameId(value: string): GameId {
  if (!isGameId(value)) throw errors.notFound('Game not found.');
  return value;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === 'GET') return {};
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
