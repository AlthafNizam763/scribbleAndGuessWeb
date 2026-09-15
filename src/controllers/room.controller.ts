import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { getSocketServer } from '@/config/socket';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseBody } from '@/middleware/validation.middleware';
import { roomRepository } from '@/repositories/room.repository';
import { chatService } from '@/services/chat.service';
import { gameService } from '@/services/game.service';
import { lobbyService } from '@/services/lobby.service';
import { matchmakingService, quickPlaySettings } from '@/services/matchmaking.service';
import { roomService } from '@/services/room.service';
import { quickPlaySchema } from '@/validators/social.validator';
import {
  createRoomSchema,
  joinRoomSchema,
  normalizeCreateRoomBody,
  readySchema,
  roomSettingsSchema,
  updateSettingsSchema,
} from '@/validators/room.validator';
import { errors } from '@/utils/errors';

/**
 * Room endpoints (brief section 11).
 *
 * ## How these relate to the socket
 *
 * The Flutter client does room work over the socket, because a room is a live
 * thing and it needs the pushes anyway. These endpoints exist for everything
 * else: a second client, a health check, a test harness, or a player who wants
 * to look at a room before connecting.
 *
 * They call the same services, so a room created here is joinable over the
 * socket and vice versa. What they cannot do is seat a *socket* — that needs a
 * live connection — so creating a room over REST makes the caller its host and
 * member, and their socket picks the seat up on its next `c:hello`.
 */
export const roomController = {
  /** `POST /api/rooms` (brief section 12) */
  async create(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('createRoom', clientIdentity(request, user.id));

    await connectToDatabase();

    const body = await parseBody(request, createRoomSchema);
    const settings = roomSettingsSchema.parse(normalizeCreateRoomBody(body));

    const room = await roomService.createRoom({ owner: user, settings });

    return ok({ room: roomService.serializeRoom(room) }, 201);
  },

  /** `POST /api/rooms/join` (brief section 13) */
  async join(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('joinRoom', clientIdentity(request, user.id));

    await connectToDatabase();

    const body = await parseBody(request, joinRoomSchema);
    const code = body.roomCode ?? body.code ?? '';

    const room = roomService.getByCode(code);
    if (!room) throw errors.roomNotFound();

    const { rejoined } = await roomService.joinRoom({ room, user });

    if (!rejoined) {
      await chatService.presence(room, `${user.username} joined.`, true);
      await gameService.broadcastState(room);
    }

    return ok({ room: roomService.serializeRoom(room) });
  },

  /**
   * `POST /api/rooms/quick-play` (brief section 2)
   *
   * Finds a public room with a free seat and puts the caller in it, opening
   * one when nothing suitable is waiting. Takes no parameters: the point of
   * the button is that there is nothing to decide.
   *
   * ## Two deployments, two paths
   *
   * The live room registry is process-local. When this process is also the one
   * holding the sockets — which is what `server.ts` builds, and the default —
   * matchmaking runs against that registry and the caller is genuinely seated
   * here. Their socket picks the seat up on its next handshake, exactly as it
   * does for a room created over REST today.
   *
   * When the realtime server runs as a separate process (`socket-server.ts`),
   * this one has no registry to read or to seat anybody in. It falls back to
   * naming a room out of Mongo and hands back the code with `joined: false`,
   * and the client joins it over the socket — where the authoritative checks
   * run anyway. Creating is safe from either process because the room row is
   * written before anybody sits down.
   *
   * `joined` is in the response precisely so a client never has to guess which
   * of the two happened.
   */
  async quickPlay(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('quickPlay', clientIdentity(request, user.id));

    await connectToDatabase();

    // Body is ignored; parsed only so a malformed one fails predictably.
    await parseBody(request, quickPlaySchema);

    if (getSocketServer() !== null) {
      const outcome = await matchmakingService.quickPlay(user);

      // A room the caller was already in is not a new arrival, so it gets no
      // presence line and no broadcast — they never left.
      if (!outcome.alreadySeated) {
        await chatService.presence(outcome.room, `${user.username} joined.`, true);
        await gameService.broadcastState(outcome.room);
      }

      return ok({
        room: roomService.serializeRoom(outcome.room),
        roomCode: outcome.room.code,
        created: outcome.created,
        alreadySeated: outcome.alreadySeated,
        joined: true,
      });
    }

    const existing = await roomRepository.findLiveForUser(user.id);
    const live = existing.find((room) => !room.closedAt);
    if (live) {
      return ok({
        room: null,
        roomCode: live.roomCode,
        created: false,
        alreadySeated: true,
        joined: false,
      });
    }

    const candidate = await matchmakingService.findCandidateDescriptor(user.id);
    if (candidate) {
      return ok({
        room: null,
        roomCode: candidate.roomCode,
        created: false,
        alreadySeated: false,
        joined: false,
      });
    }

    const room = await roomService.createRoom({ owner: user, settings: quickPlaySettings() });

    return ok(
      {
        room: roomService.serializeRoom(room),
        roomCode: room.code,
        created: true,
        alreadySeated: false,
        joined: false,
      },
      201,
    );
  },

  /** `GET /api/rooms/:roomId` */
  async get(request: Request, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    // Accepts either an id or a room code, because the client's lobby route is
    // `/room/:code` and it would otherwise have to keep a second identifier.
    const room = roomService.get(roomId) ?? roomService.getByCode(roomId);
    if (!room) throw errors.roomNotFound();

    // Private rooms are not browsable: you have to be in one to read it.
    if (room.settings.isPrivate && !room.players.has(user.id)) {
      throw errors.roomNotFound();
    }

    return ok({
      room: roomService.serializeRoom(room),
      lobby: lobbyService.snapshot(room),
      game: gameService.serializeGameState(room, user.id),
    });
  },

  /** `POST /api/rooms/:roomId/leave` */
  async leave(request: Request, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const room = roomService.get(roomId) ?? roomService.getByCode(roomId);
    if (!room) throw errors.roomNotFound();

    const player = room.players.get(user.id);
    if (!player) throw errors.notMember();

    const { roomEmpty } = await roomService.removePlayer(room, user.id);

    if (roomEmpty) {
      await roomService.close(room, 'last player left');
    } else {
      await chatService.presence(room, `${player.username} left.`, false);
      await gameService.onPlayerLeft(room, user.id);
      await gameService.broadcastState(room);
    }

    return ok({ left: true });
  },

  /** `PATCH /api/rooms/:roomId/settings` */
  async updateSettings(request: Request, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const room = roomService.get(roomId) ?? roomService.getByCode(roomId);
    if (!room) throw errors.roomNotFound();

    const { settings } = await parseBody(request, updateSettingsSchema);
    await roomService.updateSettings({ room, userId: user.id, settings });
    await gameService.broadcastState(room);

    return ok({ room: roomService.serializeRoom(room) });
  },

  /** `POST /api/rooms/:roomId/ready` */
  async setReady(request: Request, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const room = roomService.get(roomId) ?? roomService.getByCode(roomId);
    if (!room) throw errors.roomNotFound();

    const { ready } = await parseBody(request, readySchema);
    await roomService.setReady(room, user.id, ready);
    await gameService.broadcastState(room);

    return ok({ room: roomService.serializeRoom(room), lobby: lobbyService.snapshot(room) });
  },
};
