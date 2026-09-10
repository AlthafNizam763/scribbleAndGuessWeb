import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseBody } from '@/middleware/validation.middleware';
import { chatService } from '@/services/chat.service';
import { gameService } from '@/services/game.service';
import { lobbyService } from '@/services/lobby.service';
import { roomService } from '@/services/room.service';
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
