import type { Types } from 'mongoose';

import { ROOM_STATUS } from '@/constants/room.constants';
import { Room, type RoomDocument } from '@/models/Room';
import { isObjectId } from '@/repositories/user.repository';
import type { RoomSettingsDto } from '@/types/room.types';
import type { RuntimeRoom } from '@/types/socket.types';

/** Data access for `rooms`. */
export const roomRepository = {
  async create(input: {
    roomCode: string;
    ownerId: string;
    settings: RoomSettingsDto;
  }): Promise<RoomDocument> {
    return (await Room.create({
      roomCode: input.roomCode,
      ownerId: input.ownerId,
      settings: input.settings,
      status: ROOM_STATUS.waiting,
      players: [],
    })) as RoomDocument;
  },

  async findById(roomId: string) {
    if (!isObjectId(roomId)) return null;
    return Room.findById(roomId).lean().exec();
  },

  /** Finds a live room by code. Closed rooms are invisible, so codes recycle. */
  async findLiveByCode(roomCode: string) {
    return Room.findOne({ roomCode: roomCode.toUpperCase(), closedAt: null }).lean().exec();
  },

  async isCodeTaken(roomCode: string): Promise<boolean> {
    const existing = await Room.exists({
      roomCode: roomCode.toUpperCase(),
      closedAt: null,
    }).exec();
    return existing !== null;
  },

  /**
   * Several rooms in one read, for a list that names rooms it is not in.
   *
   * The invitations inbox is the caller: a page of invitations points at up to
   * twenty-five different rooms, and a lookup per row would be twenty-five
   * round trips to render one screen. Closed rooms are returned rather than
   * filtered — the caller needs to know an invitation points at a dead room so
   * it can say so, and dropping the row here would render it as a blank.
   */
  async findManyByIds(roomIds: string[]) {
    const ids = roomIds.filter(isObjectId);
    if (ids.length === 0) return [];

    return Room.find({ _id: { $in: ids } })
      .lean()
      .exec();
  },

  /** Every live room this user is seated in. Used to restore after a reconnect. */
  async findLiveForUser(userId: string) {
    if (!isObjectId(userId)) return [];
    return Room.find({ 'players.userId': userId, closedAt: null }).lean().exec();
  },

  async markClosed(roomId: string): Promise<void> {
    if (!isObjectId(roomId)) return;
    await Room.updateOne(
      { _id: roomId },
      { $set: { status: ROOM_STATUS.closed, closedAt: new Date() } },
    ).exec();
  },

  /**
   * Writes the live room back to Mongo.
   *
   * Called on membership, settings and score changes — not on strokes, and not
   * on a timer. One `updateOne` replacing the whole mutable part of the
   * document is cheaper and less racy than a fan of targeted `$set`s, and the
   * in-memory room is the source of truth anyway, so there is nothing to merge.
   */
  async persistRuntime(runtime: RuntimeRoom): Promise<void> {
    if (!isObjectId(runtime.roomId)) return;

    const players = [...runtime.players.values()].map((player) => ({
      userId: player.userId as unknown as Types.ObjectId,
      username: player.username,
      avatarId: player.avatarId,
      avatarColorIndex: player.avatarColorIndex,
      score: player.score,
      roundScore: player.roundScore,
      isReady: player.isReady,
      isMuted: player.isMuted,
      hasGuessed: player.hasGuessed,
      guessOrder: player.guessOrder,
      connection: player.connection,
      joinedAt: new Date(player.joinedAt),
      lastSeenAt: new Date(player.lastSeenAt),
    }));

    await Room.updateOne(
      { _id: runtime.roomId },
      {
        $set: {
          hostId: runtime.hostId,
          ownerId: runtime.hostId,
          status: statusForPhase(runtime),
          settings: runtime.settings,
          players,
          bannedUserIds: [...runtime.bannedIds],
          currentGameId: runtime.gameId,
        },
      },
    ).exec();
  },

  /**
   * Public rooms that look joinable, for Quick Play.
   *
   * ## Why this exists beside the live registry
   *
   * Matchmaking normally runs against the in-memory registry, which is exact:
   * it knows who is seated this instant. That registry is process-local, so a
   * deployment that runs the REST API and the realtime server as two processes
   * (see `socket-server.ts`) has no registry on the REST side at all. This
   * query is what `POST /api/rooms/quick-play` falls back to there.
   *
   * The result is a *hint*, not a decision. The player counts come from the
   * last write-through, so a room can fill between this query and the join,
   * and the caller is expected to try the next candidate when that happens.
   * The authoritative refusal is still `roomService.joinRoom`.
   *
   * `status` is filtered rather than `phase` because only the coarse status is
   * mirrored into Mongo, and it is the right question anyway: "can this be
   * joined", not "what is happening this second".
   */
  async findJoinablePublic(input: {
    limit: number;
    excludeUserId?: string;
    excludeRoomIds?: string[];
  }) {
    const filter: Record<string, unknown> = {
      closedAt: null,
      'settings.isPrivate': false,
      status: { $in: [ROOM_STATUS.waiting, ROOM_STATUS.starting] },
    };

    // A room this player is banned from is not a candidate, and neither is one
    // they are already seated in — Quick Play would otherwise "find" the room
    // they are standing in and call it a match.
    if (input.excludeUserId) {
      filter.bannedUserIds = { $ne: input.excludeUserId };
    }
    if (input.excludeRoomIds && input.excludeRoomIds.length > 0) {
      filter._id = { $nin: input.excludeRoomIds.filter(isObjectId) };
    }

    return Room.find(filter)
      // Oldest first, so Quick Play fills the room that has been waiting
      // longest instead of scattering players across fresh ones.
      .sort({ createdAt: 1 })
      .limit(input.limit)
      .lean()
      .exec();
  },

  /** Rooms that have been closed long enough to delete outright. */
  async findSweepable(olderThan: Date) {
    return Room.find({ closedAt: { $ne: null, $lt: olderThan } })
      .select('_id')
      .lean()
      .exec();
  },

  async deleteById(roomId: string): Promise<void> {
    if (!isObjectId(roomId)) return;
    await Room.deleteOne({ _id: roomId }).exec();
  },
};

/**
 * Maps the live phase onto the coarser `RoomStatus` the room document carries.
 *
 * Two enums exist because they answer different questions: `GamePhase` is
 * "what is happening this second" and drives the game screen, while
 * `RoomStatus` is "can this room be joined" and drives the lobby and the join
 * endpoint. Collapsing them would make a room un-joinable during the two
 * seconds between turns.
 */
function statusForPhase(runtime: RuntimeRoom): string {
  if (runtime.closed) return ROOM_STATUS.closed;
  switch (runtime.phase) {
    case 'waiting':
      return ROOM_STATUS.waiting;
    case 'starting':
      return ROOM_STATUS.starting;
    case 'final_result':
      return ROOM_STATUS.finished;
    case 'round_result':
      return ROOM_STATUS.roundResult;
    default:
      return ROOM_STATUS.inGame;
  }
}
