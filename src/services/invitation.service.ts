import { TIMING } from '@/constants/game.constants';
import { NOTIFICATION_TYPE } from '@/constants/notification.constants';
import {
  GAME_PHASE,
  INVITATION_STATUS,
  ROOM_STATUS,
  type InvitationStatusWire,
  type RoomStatusWire,
} from '@/constants/room.constants';
import { PAGE_LIMITS } from '@/constants/social.constants';
import { hasSocketServer, onlineUserIds } from '@/config/socket';
import { blockRepository } from '@/repositories/block.repository';
import { friendRepository } from '@/repositories/friend.repository';
import {
  invitationRepository,
  isDuplicateInvitation,
} from '@/repositories/invitation.repository';
import { roomRepository } from '@/repositories/room.repository';
import { userRepository } from '@/repositories/user.repository';
import { notificationService } from '@/services/notification.service';
import { notifyUserRoomEvent } from '@/services/room.notify';
import { roomService } from '@/services/room.service';
import { toUserSummary, type RankableUser } from '@/services/profile.serialize';
import type { AuthenticatedUser } from '@/types/auth.types';
import type {
  InviteCandidateDto,
  RoomInvitationDto,
  RoomSettingsDto,
} from '@/types/room.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Room invitations: who may be asked, who may ask, and what an answer does.
 *
 * ## Every refusal lives here, not in a validator and not in a client
 *
 * A validator can check that a body carries a friend id. Only this layer can
 * know whether that friend is already seated, already asked, blocked, banned,
 * or whether the room filled up while the invite sheet was open. So the whole
 * list the brief gives — no inviting the owner, no inviting a member, no
 * duplicate, no blocked user, not when full, not after the game starts, not
 * after the room closes — is enforced in one function against server state,
 * and both the REST endpoint and the socket event call it.
 *
 * The invite sheet renders the *same* answers through `listCandidates`, which
 * is why a greyed-out Invite button and a refused invite never disagree: they
 * are computed by the same rules over the same state. The sheet is a courtesy;
 * `invite` is the decision.
 *
 * ## Checks, and the one that actually decides
 *
 * The duplicate check reads before it writes, and that read can lose a race —
 * two devices tapping Invite on the same friend both see nothing pending.
 * What settles it is the partial unique index on room and invitee scoped to
 * `pending`, which lets one insert through and fails the other with a
 * duplicate-key error this service turns into the same refusal the pre-check
 * would have given. The read exists to produce a good message in the ordinary
 * case; the index is what makes the rule true. The same argument as
 * `friend.service.ts`, for the same reason.
 *
 * ## What an accept is, and is not
 *
 * Accepting re-runs every room check from scratch. An invitation is a
 * *permission to ask*, never a reservation: the room it named can have filled,
 * started or closed in the minutes since, and an accept that trusted the
 * snapshot it was rendered from would seat somebody in a room that no longer
 * has space. So the row only answers "were you invited"; the room answers
 * everything else, at the moment of the tap.
 */

/** Why a friend cannot be invited right now, or null when they can be. */
type CandidateRefusal =
  | 'self'
  | 'member'
  | 'invited'
  | 'blocked'
  | 'banned'
  | 'room_full'
  | 'in_progress'
  | 'closed';

/** The sentence a player reads for each refusal. */
const REFUSAL_TEXT: Record<CandidateRefusal, string> = {
  self: 'That is you.',
  member: 'Already in this room.',
  invited: 'Already invited.',
  // Deliberately vague, and deliberately the same in both directions. Naming
  // the block would tell a blocked party exactly what a block exists to hide,
  // and a blocker does not need reminding of their own.
  blocked: 'You cannot invite that player.',
  banned: 'Banned from this room.',
  room_full: 'Room is full.',
  in_progress: 'Game already started.',
  closed: 'Room is closed.',
};

/**
 * The most pending invitations one player may have outstanding to one room.
 *
 * A ceiling on top of the rate limiter rather than instead of it. The limiter
 * bounds how *fast* invitations can be sent; this bounds how many can be in
 * the air at once, which is the shape the abuse actually takes — one burst
 * addressed at a whole friends list. Twelve is the largest room, so anybody
 * filling a legitimate room stays comfortably under it.
 */
const MAX_PENDING_PER_INVITER = 16;

export class InvitationService {
  // ---------------------------------------------------------------- sending --

  /**
   * Invites one friend to one room.
   *
   * Refuses, in this order: a room that cannot take anybody, a caller who is
   * not entitled to invite, a target who cannot be invited, and finally a
   * duplicate. The order matters for the message — "the game already started"
   * is more useful than "that player is already invited" when both are true.
   */
  async invite(input: {
    room: RuntimeRoom;
    inviter: AuthenticatedUser;
    inviteeId: string;
  }): Promise<RoomInvitationDto> {
    const { room, inviter, inviteeId } = input;

    this.assertRoomAcceptsInvites(room);

    // Only somebody seated may invite. The brief says "the room owner or
    // authorized players", and a seated member is what that means in a game
    // with no other roles: everybody in the lobby can already read the code
    // aloud, so letting them send the same code as a notification grants
    // nothing new. What it must never be is a stranger, and that is exactly
    // what this refuses.
    roomService.assertMember(room, inviter.id);

    if (inviteeId === inviter.id) {
      throw errors.invalidAction(REFUSAL_TEXT.self);
    }

    const invitee = await userRepository.findById(inviteeId);
    if (!invitee) throw errors.notFound('That player no longer exists.');

    if (room.hostId === inviteeId || room.players.has(inviteeId)) {
      throw errors.invalidAction(REFUSAL_TEXT.member);
    }

    if (room.bannedIds.has(inviteeId)) {
      throw errors.banned(REFUSAL_TEXT.banned);
    }

    if (await blockRepository.existsBetween(inviter.id, inviteeId)) {
      throw errors.invalidAction(REFUSAL_TEXT.blocked);
    }

    // Invitations are a friends feature. Without this an invitation would be a
    // way to put a notification in a stranger's list, which is precisely what
    // the friend-request flow is gated and rate limited to prevent — routing
    // around that gate through a room would make it decorative.
    if (!(await friendRepository.areFriends(inviter.id, inviteeId))) {
      throw errors.invalidAction('You can only invite friends.');
    }

    const pending = await invitationRepository.findPending(room.roomId, inviteeId);
    if (pending && new Date(pending.expiresAt).getTime() > Date.now()) {
      throw errors.invalidAction(REFUSAL_TEXT.invited);
    }

    // A lapsed row still holds the unique slot, so it is retired before the
    // re-invite rather than colliding with it.
    if (pending) {
      await invitationRepository.resolve(String(pending._id), INVITATION_STATUS.expired);
    }

    const outstanding = await invitationRepository.countSentByInviter(
      room.roomId,
      inviter.id,
    );
    if (outstanding >= MAX_PENDING_PER_INVITER) {
      throw errors.rateLimited('You have too many invitations out for this room.');
    }

    const expiresAt = new Date(Date.now() + TIMING.invitationTtlMs);

    let created;
    try {
      created = await invitationRepository.create({
        roomId: room.roomId,
        roomCode: room.code,
        inviterId: inviter.id,
        inviteeId,
        expiresAt,
      });
    } catch (error) {
      // The index caught an invitation the read above could not see: a second
      // device, or the inviter's own double tap.
      if (isDuplicateInvitation(error)) {
        throw errors.invalidAction(REFUSAL_TEXT.invited);
      }
      throw error;
    }

    const dto = this.serialize({
      id: String(created._id),
      roomId: room.roomId,
      roomCode: room.code,
      status: INVITATION_STATUS.pending,
      createdAtMs: Date.now(),
      expiresAtMs: expiresAt.getTime(),
      inviter: summaryOf(inviter),
      invitee: toUserSummary(invitee as RankableUser),
      room,
    });

    // Addressed to the person, so it lands on every device they are signed in
    // on. This is what makes "show the invitation immediately without
    // refreshing" true; a friend who is offline finds it in their inbox
    // instead, because the row is written either way.
    notifyUserRoomEvent(inviteeId, 'invitationReceived', { invitation: dto });

    // The durable half. `expiresAt` is on the row, so the notification can
    // still be sitting in the inbox after the invitation has lapsed — which is
    // correct: the accept path re-checks the deadline and refuses, and a
    // notification that vanished on expiry would leave the invitee wondering
    // whether they imagined it.
    void notificationService.notify({
      userId: inviteeId,
      type: NOTIFICATION_TYPE.roomInvitation,
      title: 'Room invitation',
      body: `${inviter.username} invited you to room ${room.code}.`,
      actorId: inviter.id,
      data: {
        invitationId: dto.id,
        roomId: room.roomId,
        roomCode: room.code,
        expiresAtMs: expiresAt.getTime(),
      },
    });

    logger.info('room invitation sent', {
      roomId: room.roomId,
      inviterId: inviter.id,
      inviteeId,
    });

    return dto;
  }

  // -------------------------------------------------------------- answering --

  /**
   * Accepts an invitation and takes the seat.
   *
   * Every room check runs again here — see the note on accepts in the file
   * header. The invitation only answers "were you invited"; whether there is
   * space, whether the game has started and whether the room still exists are
   * answered by the room, now.
   */
  async accept(
    user: AuthenticatedUser,
    invitationId: string,
  ): Promise<{ room: RuntimeRoom; rejoined: boolean }> {
    const invitation = await this.requireOpenInvitation(invitationId);

    if (String(invitation.inviteeId) !== user.id) {
      throw errors.notMember('That invitation is not yours to accept.');
    }

    // `hydrate` rather than `get`: a room created by the REST process, or one
    // that outlived a restart, is live and joinable but not in this process's
    // registry. A genuinely dead room still resolves to null.
    const room = await roomService.hydrate(String(invitation.roomId));
    if (!room || room.closed) {
      await invitationRepository.resolve(invitationId, INVITATION_STATUS.expired);
      throw errors.roomNotFound(REFUSAL_TEXT.closed);
    }

    // A block placed after the invitation was sent must win, exactly as it
    // does for a friend request accepted into one.
    if (await blockRepository.existsBetween(user.id, String(invitation.inviterId))) {
      await invitationRepository.resolve(invitationId, INVITATION_STATUS.expired);
      throw errors.invalidAction('That invitation is no longer available.');
    }

    this.assertRoomAcceptsJoins(room, user.id);
    this.assertNotSeatedElsewhere(user.id, room.roomId);

    // Flip the row first. It is the one with the concurrency guard on it, so
    // losing this step means another tap already answered the invitation and
    // there is nothing left to do. Seating first would let a double tap take a
    // seat against an invitation that was being rejected.
    const moved = await invitationRepository.resolve(
      invitationId,
      INVITATION_STATUS.accepted,
    );
    if (!moved) throw errors.invalidAction('That invitation has already been handled.');

    const { rejoined } = await roomService.joinRoom({ room, user });

    notifyUserRoomEvent(String(invitation.inviterId), 'invitationAccepted', {
      invitationId,
      roomId: room.roomId,
      roomCode: room.code,
      user: summaryOf(user),
    });

    logger.info('room invitation accepted', {
      roomId: room.roomId,
      userId: user.id,
      invitationId,
    });

    return { room, rejoined };
  }

  /** Declines an invitation, and tells the inviter. */
  async reject(user: AuthenticatedUser, invitationId: string): Promise<void> {
    const invitation = await this.requireOpenInvitation(invitationId);

    if (String(invitation.inviteeId) !== user.id) {
      throw errors.notMember('That invitation is not yours to reject.');
    }

    const moved = await invitationRepository.resolve(
      invitationId,
      INVITATION_STATUS.rejected,
    );
    if (!moved) throw errors.invalidAction('That invitation has already been handled.');

    // The inviter is told their invitation was closed, and by whom — they
    // already know who they asked. Nothing else travels: no reason, and no
    // room state the invitee happened to see.
    notifyUserRoomEvent(String(invitation.inviterId), 'invitationRejected', {
      invitationId,
      roomId: String(invitation.roomId),
      user: summaryOf(user),
    });

    logger.info('room invitation rejected', { userId: user.id, invitationId });
  }

  // ------------------------------------------------------------------ lists --

  /**
   * The caller's unanswered invitations, newest first.
   *
   * Lapsed rows and rows pointing at dead rooms are retired as they are found
   * rather than rendered. A list that showed either would be offering a button
   * whose only possible outcome is a refusal, and the sweeper may be a minute
   * away.
   */
  async listInvitations(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{
    items: RoomInvitationDto[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      invitationRepository.listForInvitee(userId, limit, skip),
      invitationRepository.countForInvitee(userId),
    ]);

    if (rows.length === 0) {
      return { items: [], total, page, limit, hasMore: false };
    }

    const now = Date.now();
    const live: typeof rows = [];

    for (const row of rows) {
      if (new Date(row.expiresAt).getTime() <= now) {
        this.retire(String(row._id));
        continue;
      }
      live.push(row);
    }

    // One read for every inviter and one for every room, rather than a lookup
    // per row: a page of twenty-five would otherwise be fifty round trips.
    const [inviters, roomDocuments] = await Promise.all([
      userRepository.findManyByIds(live.map((row) => String(row.inviterId))),
      roomRepository.findManyByIds(live.map((row) => String(row.roomId))),
    ]);

    const inviterById = new Map(
      inviters.map((user) => [String(user._id), user as RankableUser]),
    );
    const roomById = new Map(roomDocuments.map((doc) => [String(doc._id), doc]));

    const items: RoomInvitationDto[] = [];

    for (const row of live) {
      const roomId = String(row.roomId);
      const runtime = roomService.get(roomId);
      const stored = roomById.get(roomId);

      // Gone from the registry *and* from storage, or closed in storage. There
      // is nothing left to accept, so the row is retired rather than drawn as
      // a tappable dead end.
      const runtimeDead = !runtime || runtime.closed;
      const storedDead = !stored || stored.closedAt !== null;
      if (runtimeDead && storedDead) {
        this.retire(String(row._id));
        continue;
      }

      const inviter = inviterById.get(String(row.inviterId));

      items.push(
        this.serialize({
          id: String(row._id),
          roomId,
          roomCode: runtime?.code ?? stored?.roomCode ?? row.roomCode,
          status: INVITATION_STATUS.pending,
          createdAtMs: new Date(row.createdAt ?? Date.now()).getTime(),
          expiresAtMs: new Date(row.expiresAt).getTime(),
          inviter: inviter ? toUserSummary(inviter) : null,
          invitee: null,
          room: runtime && !runtime.closed ? runtime : null,
          stored: stored
            ? {
                playerCount: stored.players.length,
                settings: stored.settings as unknown as RoomSettingsDto,
                status: stored.status as RoomStatusWire,
              }
            : null,
        }),
      );
    }

    return { items, total, page, limit, hasMore: skip + rows.length < total };
  }

  /**
   * The caller's friends, each annotated with whether they can be invited.
   *
   * ## Why the server decides the button state
   *
   * Every flag here is a fact about the room or about a relationship, and a
   * client that worked them out itself would be deciding who it may invite —
   * the same argument `friend.service.relation` makes for the profile button.
   * The sheet renders what it is given and offers nothing the server would
   * refuse.
   *
   * Blocked friends are dropped from the list entirely rather than shown as
   * un-invitable, because a row reading "you cannot invite this person" is the
   * disclosure a block exists to prevent.
   */
  async listCandidates(
    room: RuntimeRoom,
    userId: string,
    limit: number,
  ): Promise<InviteCandidateDto[]> {
    const friendIds = await friendRepository.friendIdsOf(userId);
    if (friendIds.length === 0) return [];

    const [users, blockedIds, pendingRows] = await Promise.all([
      userRepository.findManyByIds(friendIds.slice(0, limit)),
      blockRepository.relatedIds(userId),
      invitationRepository.listPendingForRoom(room.roomId),
    ]);

    const blocked = new Set(blockedIds);
    const now = Date.now();

    const invited = new Set(
      pendingRows
        .filter((row) => new Date(row.expiresAt).getTime() > now)
        .map((row) => String(row.inviteeId)),
    );

    const visible = users.filter((user) => !blocked.has(String(user._id)));

    // Presence is only knowable in the process holding the sockets. Where it
    // is not, `lastSeenAt` inside the reconnect grace window is the honest
    // approximation — and nothing in the rules depends on it either way, so a
    // friend shown as offline can still be invited.
    const online = onlineUserIds(visible.map((user) => String(user._id)));
    const socketsHere = hasSocketServer();

    const roomRefusal = this.roomRefusal(room);

    const candidates = visible.map((raw) => {
      const user = raw as RankableUser;
      const id = String(user._id);
      const lastSeenAtMs = new Date(user.lastSeenAt ?? 0).getTime();
      const isMember = room.players.has(id);
      const isInvited = invited.has(id);

      const refusal: CandidateRefusal | null =
        id === userId
          ? 'self'
          : isMember
            ? 'member'
            : room.bannedIds.has(id)
              ? 'banned'
              : isInvited
                ? 'invited'
                : roomRefusal;

      return {
        ...toUserSummary(user),
        isOnline: socketsHere
          ? online.has(id)
          : now - lastSeenAtMs < TIMING.reconnectGraceMs,
        isMember,
        isInvited,
        canInvite: refusal === null,
        blockedReason: refusal === null ? null : REFUSAL_TEXT[refusal],
        lastSeenAtMs,
      } satisfies InviteCandidateDto;
    });

    // Invitable first, then online, then by name: the list is a thing to act
    // on, so the rows that can be acted on belong at the top.
    return candidates.sort(
      (a, b) =>
        Number(b.canInvite) - Number(a.canInvite) ||
        Number(b.isOnline) - Number(a.isOnline) ||
        a.username.localeCompare(b.username),
    );
  }

  // ------------------------------------------------------------------ sweep --

  /** Retires every invitation whose deadline has passed. */
  async expireLapsed(): Promise<number> {
    try {
      const expired = await invitationRepository.expireLapsed(new Date());
      if (expired > 0) logger.info('invitations expired', { expired });
      return expired;
    } catch (error) {
      logger.exception('expiring lapsed invitations failed', error);
      return 0;
    }
  }

  // ----------------------------------------------------------------- guards --

  /**
   * Whether a room can take anybody at all right now, as a refusal reason.
   *
   * Shared by `invite` and `listCandidates` so that the greyed-out button and
   * the refused request give the same answer for the same reason.
   */
  private roomRefusal(room: RuntimeRoom): CandidateRefusal | null {
    if (room.closed) return 'closed';
    if (room.players.size >= room.settings.maxPlayers) return 'room_full';

    // A paused match counts as a lobby: it is waiting for exactly the player
    // somebody is about to invite, and refusing would keep it paused.
    if (room.phase !== GAME_PHASE.lobby && room.phase !== GAME_PHASE.paused) {
      return 'in_progress';
    }

    return null;
  }

  /** Throws whatever refusal `roomRefusal` names, if there is one. */
  private assertRoomAcceptsInvites(room: RuntimeRoom): void {
    const refusal = this.roomRefusal(room);
    if (refusal === null) return;

    if (refusal === 'closed') throw errors.roomNotFound(REFUSAL_TEXT.closed);
    if (refusal === 'room_full') throw errors.roomFull(REFUSAL_TEXT.room_full);
    throw errors.gameAlreadyStarted(REFUSAL_TEXT.in_progress);
  }

  /**
   * Whether this user may take a seat in this room, checked at the last moment.
   *
   * Used by the invitation accept *and* the public-room join, which is the
   * point: the brief lists the same questions for both flows, and asking them
   * in one place is what stops the two paths drifting into two different
   * definitions of "joinable".
   */
  assertRoomAcceptsJoins(room: RuntimeRoom, userId: string): void {
    if (room.closed) throw errors.roomNotFound(REFUSAL_TEXT.closed);
    if (room.bannedIds.has(userId)) throw errors.banned();

    // A member coming back is never refused for space or for phase: they
    // already hold the seat, and turning a reconnect into a refusal would cost
    // somebody the match they are in the middle of (brief section 38).
    if (room.players.has(userId)) return;

    if (room.players.size >= room.settings.maxPlayers) {
      throw errors.roomFull(REFUSAL_TEXT.room_full);
    }

    if (room.phase !== GAME_PHASE.lobby && room.phase !== GAME_PHASE.paused) {
      throw errors.gameAlreadyStarted(REFUSAL_TEXT.in_progress);
    }
  }

  /**
   * Refuses a join when this player already holds a seat somewhere else.
   *
   * The brief's rule, in its exact wording. A player in two rooms would be
   * drawing in one while guessing in the other, and the server is the only
   * thing that can see both. Leaving is always allowed, so this is a refusal
   * the player can act on rather than a dead end.
   */
  assertNotSeatedElsewhere(userId: string, targetRoomId: string): void {
    const current = roomService.liveRoomOf(userId);
    if (!current || current.roomId === targetRoomId) return;

    throw errors.invalidAction(
      'You are already in another room. Leave that room first.',
    );
  }

  /** Loads an invitation, refusing anything that is not still answerable. */
  private async requireOpenInvitation(invitationId: string) {
    const invitation = await invitationRepository.findById(invitationId);
    if (!invitation) throw errors.notFound('That invitation no longer exists.');

    if (invitation.status !== INVITATION_STATUS.pending) {
      throw invitation.status === INVITATION_STATUS.expired
        ? errors.invalidAction('Invitation expired.')
        : errors.invalidAction('That invitation has already been handled.');
    }

    // The date decides, not the status: a row that lapsed a moment ago must be
    // refused whether or not the sweeper has reached it yet.
    if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
      await invitationRepository.resolve(invitationId, INVITATION_STATUS.expired);
      throw errors.invalidAction('Invitation expired.');
    }

    return invitation;
  }

  /** Retires one row in the background. A failure costs a hidden line, nothing more. */
  private retire(invitationId: string): void {
    void invitationRepository
      .resolve(invitationId, INVITATION_STATUS.expired)
      .catch((error: unknown) => {
        logger.debug('could not retire invitation', { invitationId, error: String(error) });
      });
  }

  // ------------------------------------------------------------ serialising --

  /**
   * One invitation as both clients read it.
   *
   * The occupancy comes from the live room where there is one and from the
   * last write-through otherwise, which is the best answer available to a
   * process that may not be holding the room. It is a *snapshot*, and the
   * accept path re-checks all of it — see the file header.
   */
  private serialize(input: {
    id: string;
    roomId: string;
    roomCode: string;
    status: InvitationStatusWire;
    createdAtMs: number;
    expiresAtMs: number;
    inviter: RoomInvitationDto['inviter'];
    invitee: RoomInvitationDto['invitee'];
    room: RuntimeRoom | null;
    stored?: {
      playerCount: number;
      settings: RoomSettingsDto;
      status: RoomStatusWire;
    } | null;
  }): RoomInvitationDto {
    const { room, stored } = input;
    const settings = room?.settings ?? stored?.settings ?? null;

    return {
      id: input.id,
      roomId: input.roomId,
      roomCode: input.roomCode,
      status: input.status,
      inviter: input.inviter,
      invitee: input.invitee,
      playerCount: room ? room.players.size : (stored?.playerCount ?? null),
      maxPlayers: settings?.maxPlayers ?? 0,
      isPublic: settings ? !settings.isPrivate : false,
      roomStatus: room
        ? roomService.serializeRoom(room).status
        : (stored?.status ?? ROOM_STATUS.closed),
      createdAtMs: input.createdAtMs,
      expiresAtMs: input.expiresAtMs,
    };
  }
}

/**
 * The public card for an already-authenticated caller.
 *
 * `AuthenticatedUser` carries the four fields a summary needs but is not a
 * `RankableUser`, and loading the row again purely to serialise a name and an
 * avatar would be a query for data already in hand.
 */
function summaryOf(user: AuthenticatedUser) {
  return {
    id: user.id,
    username: user.username,
    avatarId: user.avatarId,
    avatarColorIndex: user.avatarColorIndex,
  };
}

/** Normalises a page request for the invitation list. */
export function invitationPaging(input: { page?: number; limit?: number }): {
  page: number;
  limit: number;
} {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? PAGE_LIMITS.defaultLimit), 1),
    PAGE_LIMITS.maxLimit,
  );
  const page = Math.max(Math.trunc(input.page ?? 1), 1);

  if (page > PAGE_LIMITS.maxPage) {
    throw errors.validation(`Pages stop at ${PAGE_LIMITS.maxPage}.`);
  }

  return { page, limit };
}

export const invitationService = new InvitationService();
