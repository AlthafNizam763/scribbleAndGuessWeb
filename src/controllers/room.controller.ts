import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { getSocketServer } from '@/config/socket';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseBody, parseQuery } from '@/middleware/validation.middleware';
import { blockRepository } from '@/repositories/block.repository';
import { roomRepository } from '@/repositories/room.repository';
import { chatService } from '@/services/chat.service';
import { gameService } from '@/services/game.service';
import { invitationPaging, invitationService } from '@/services/invitation.service';
import { lobbyService } from '@/services/lobby.service';
import { matchmakingService, quickPlaySettings } from '@/services/matchmaking.service';
import { roomService } from '@/services/room.service';
import { pageQuerySchema, quickPlaySchema } from '@/validators/social.validator';
import {
  createRoomSchema,
  inviteToRoomSchema,
  joinRoomSchema,
  normalizeCreateRoomBody,
  publicRoomsQuerySchema,
  readySchema,
  roomObjectIdSchema,
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

    const room = await resolveRoom(code);
    if (!room) throw errors.roomNotFound();

    // The same two guards the id-shaped join and the invitation accept apply.
    // A code is how you reach a room, not a licence to be in two of them, and
    // "the room is full" has to be refused here as well or the REST path would
    // be the way around a rule the socket path enforces.
    invitationService.assertRoomAcceptsJoins(room, user.id);
    invitationService.assertNotSeatedElsewhere(user.id, room.roomId);

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
    const room = await resolveRoom(roomId);
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

    const room = await resolveRoom(roomId);
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

    const room = await resolveRoom(roomId);
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

    const room = await resolveRoom(roomId);
    if (!room) throw errors.roomNotFound();

    const { ready } = await parseBody(request, readySchema);
    await roomService.setReady(room, user.id, ready);
    await gameService.broadcastState(room);

    return ok({ room: roomService.serializeRoom(room), lobby: lobbyService.snapshot(room) });
  },

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  /**
   * `GET /api/rooms/:roomId/invite` — the caller's friends, annotated for this
   * room.
   *
   * The invite sheet's data, and the reason it can grey out a button rather
   * than let somebody tap into a refusal. Every flag on a row is decided by the
   * server; see the note on that in `invitation.service.ts`.
   *
   * Reading it requires being in the room, for the same reason sending an
   * invitation does: it discloses who is already seated.
   */
  async inviteCandidates(request: Request, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const room = await resolveRoom(roomId);
    if (!room) throw errors.roomNotFound();

    roomService.assertMember(room, user.id);

    const { limit } = parseQuery(request, pageQuerySchema);

    return ok({
      roomId: room.roomId,
      roomCode: room.code,
      playerCount: room.players.size,
      maxPlayers: room.settings.maxPlayers,
      items: await invitationService.listCandidates(room, user.id, limit),
    });
  },

  /** `POST /api/rooms/:roomId/invite` — ask one friend to join. */
  async invite(request: Request, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('roomInvite', clientIdentity(request, user.id));

    await connectToDatabase();

    const room = await resolveRoom(roomId);
    if (!room) throw errors.roomNotFound();

    const { inviteeId } = await parseBody(request, inviteToRoomSchema);

    const invitation = await invitationService.invite({
      room,
      inviter: user,
      inviteeId,
    });

    return ok({ invitation }, 201);
  },

  /** `GET /api/rooms/invitations?page=&limit=` — the caller's inbox. */
  async listInvitations(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const { page, limit } = invitationPaging(parseQuery(request, pageQuerySchema));

    return ok(await invitationService.listInvitations(user.id, page, limit));
  },

  /**
   * `POST /api/rooms/invitations/:invitationId/accept`
   *
   * Takes the seat and hands the room back, so the client can go straight to
   * the lobby without a second read. Their socket picks the seat up on its next
   * `c:room:join`, exactly as it does for a room created over REST.
   */
  async acceptInvitation(request: Request, invitationId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('invitationAction', clientIdentity(request, user.id));

    await connectToDatabase();

    const { room, rejoined } = await invitationService.accept(
      user,
      roomObjectIdSchema.parse(invitationId),
    );

    if (!rejoined) {
      await chatService.presence(room, `${user.username} joined.`, true);
      await gameService.broadcastState(room);
    }

    return ok({
      room: roomService.serializeRoom(room),
      roomCode: room.code,
      joined: true,
    });
  },

  /** `POST /api/rooms/invitations/:invitationId/reject` */
  async rejectInvitation(request: Request, invitationId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('invitationAction', clientIdentity(request, user.id));

    await connectToDatabase();

    await invitationService.reject(user, roomObjectIdSchema.parse(invitationId));

    return ok({ rejected: true });
  },

  // -------------------------------------------------------------------------
  // The public room list
  // -------------------------------------------------------------------------

  /**
   * `GET /api/rooms/public?page=&limit=`
   *
   * Public, waiting, not full, not closed, not started, nothing the caller is
   * banned from and nothing shared with somebody they have blocked. The filter
   * is `matchmakingService.rejectionFor`, which is the same predicate Quick
   * Play uses — see the note on that in `matchmaking.service.ts`.
   *
   * Private rooms are not merely hidden from this list: there is no parameter
   * that would include one, which is what makes "do not allow joining private
   * rooms through the public room list" true structurally rather than by
   * remembering to filter.
   */
  async publicRooms(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('publicRooms', clientIdentity(request, user.id));

    await connectToDatabase();

    const { page, limit } = parseQuery(request, publicRoomsQuerySchema);
    const blocked = new Set(await blockRepository.relatedIds(user.id));

    // The registry is exact about occupancy, and it is what the socket process
    // holds. Where there is none — the split deployment's REST side — the last
    // write-through is the best answer available, and the join re-checks it.
    const items = getSocketServer()
      ? matchmakingService.listPublic(user.id, blocked, limit)
      : await matchmakingService.listPublicFromStorage(user.id, blocked, limit);

    const current = roomService.liveRoomOf(user.id);

    return ok({
      items,
      total: items.length,
      page,
      limit,
      hasMore: false,
      // So the screen can say "leave that room first" before the player taps
      // Join and is refused. The refusal is still the server's; this only
      // saves a round trip to hear it.
      currentRoomId: current?.roomId ?? null,
      currentRoomCode: current?.code ?? null,
    });
  },

  // -------------------------------------------------------------------------
  // Joining and membership
  // -------------------------------------------------------------------------

  /**
   * `POST /api/rooms/:roomId/join`
   *
   * Joins by id or by code. Every rule the brief lists for a public-room join
   * is checked here and nowhere else: the room still exists, it has space, the
   * game has not started, and the caller is neither banned nor already seated
   * somewhere else.
   *
   * A private room is joinable through this endpoint by somebody holding its
   * code or its id, which is the same rule the socket join applies — a
   * code-only room is exactly a room you need the code for. What it is not is
   * browsable; see `publicRooms`.
   */
  async joinById(request: Request, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('joinRoom', clientIdentity(request, user.id));

    await connectToDatabase();

    const room = await resolveRoom(roomId);
    if (!room) throw errors.roomNotFound();

    invitationService.assertRoomAcceptsJoins(room, user.id);
    invitationService.assertNotSeatedElsewhere(user.id, room.roomId);

    const { rejoined } = await roomService.joinRoom({ room, user });

    if (!rejoined) {
      await chatService.presence(room, `${user.username} joined.`, true);
      await gameService.broadcastState(room);
    }

    return ok({
      room: roomService.serializeRoom(room),
      roomCode: room.code,
      joined: true,
      rejoined,
    });
  },

  /**
   * `GET /api/rooms/:roomId/members`
   *
   * Members only. A player list is not public information — it is who is in
   * the building — and a stranger who could read it for any room could follow
   * somebody around the lobby list. The public browser gets a count instead.
   */
  async members(request: Request, roomId: string): Promise<NextResponse> {
    const user = await requireUser(request);
    await connectToDatabase();

    const room = await resolveRoom(roomId);
    if (!room) throw errors.roomNotFound();

    roomService.assertMember(room, user.id);

    const snapshot = roomService.serializeRoom(room);

    return ok({
      roomId: room.roomId,
      roomCode: room.code,
      hostId: room.hostId,
      playerCount: room.players.size,
      maxPlayers: room.settings.maxPlayers,
      status: snapshot.status,
      members: snapshot.players,
    });
  },
};

/**
 * The live room for an id or a code, hydrating it from storage if need be.
 *
 * Every room endpoint accepts both, because the client's lobby route is
 * `/room/:code` while invitation and browser rows carry ids, and making
 * callers keep two identifiers straight is how one of them eventually sends
 * the wrong one. A miss falls through to storage for the same reason
 * `roomService.resolveByCode` does: a room created by the other process, or
 * one that outlived a restart, is live and joinable but not in this registry.
 */
async function resolveRoom(idOrCode: string) {
  const direct = roomService.get(idOrCode) ?? roomService.getByCode(idOrCode);
  if (direct) return direct;

  // A five-character code can never be a 24-character Mongo id, so the two
  // lookups cannot collide; this only decides which storage read is tried.
  if (/^[0-9a-fA-F]{24}$/.test(idOrCode)) return roomService.hydrate(idOrCode);

  return roomService.resolveByCode(idOrCode);
}
