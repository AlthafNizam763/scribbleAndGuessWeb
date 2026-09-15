import { Types } from 'mongoose';

import { INVITATION_STATUS, type InvitationStatusWire } from '@/constants/room.constants';
import { RoomInvitation, type RoomInvitationDocument } from '@/models/RoomInvitation';
import { isObjectId } from '@/repositories/user.repository';

/**
 * Data access for `room_invitations`.
 *
 * ## Every resolve is a guarded update
 *
 * Accepting, rejecting and expiring all move a row out of `pending`, and every
 * one of them filters on `status: pending` and reports whether it matched.
 * That is the concurrency guard: two taps on Accept, or a tap that races the
 * sweeper, produce one winner and one `false`, which the service turns into
 * "that invitation has already been handled" instead of seating somebody twice.
 *
 * ## Nothing here decides anything
 *
 * Whether a room has space, whether the caller may invite, whether a block
 * stands between two people — none of that is visible from this layer. It
 * moves rows; `invitation.service.ts` owns the rules.
 */

const asId = (value: string): Types.ObjectId => new Types.ObjectId(value);

/** Whether a thrown value is Mongo's duplicate-key error. */
export function isDuplicateInvitation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

export const invitationRepository = {
  /**
   * Inserts a pending invitation.
   *
   * Throws on a duplicate rather than upserting: the unique index is the rule,
   * and an upsert would quietly refresh somebody else's invitation instead of
   * refusing the second one.
   */
  async create(input: {
    roomId: string;
    roomCode: string;
    inviterId: string;
    inviteeId: string;
    expiresAt: Date;
  }): Promise<RoomInvitationDocument> {
    return (await RoomInvitation.create({
      roomId: asId(input.roomId),
      inviterId: asId(input.inviterId),
      inviteeId: asId(input.inviteeId),
      roomCode: input.roomCode.toUpperCase(),
      status: INVITATION_STATUS.pending,
      expiresAt: input.expiresAt,
    })) as RoomInvitationDocument;
  },

  async findById(invitationId: string) {
    if (!isObjectId(invitationId)) return null;
    return RoomInvitation.findById(invitationId).lean().exec();
  },

  /** The pending invitation for this pair, if one is outstanding. */
  async findPending(roomId: string, inviteeId: string) {
    if (!isObjectId(roomId) || !isObjectId(inviteeId)) return null;

    return RoomInvitation.findOne({
      roomId: asId(roomId),
      inviteeId: asId(inviteeId),
      status: INVITATION_STATUS.pending,
    })
      .lean()
      .exec();
  },

  /**
   * Moves one invitation out of `pending`, reporting whether it won the race.
   *
   * `false` means somebody — another tap, the sweeper, the room closing — got
   * there first, which is never an error in itself but is never a success
   * either.
   */
  async resolve(invitationId: string, status: InvitationStatusWire): Promise<boolean> {
    if (!isObjectId(invitationId)) return false;

    const result = await RoomInvitation.updateOne(
      { _id: asId(invitationId), status: INVITATION_STATUS.pending },
      { $set: { status } },
    ).exec();

    return result.modifiedCount === 1;
  },

  /** Everything still pending for one invitee, newest first. */
  async listForInvitee(inviteeId: string, limit: number, skip: number) {
    if (!isObjectId(inviteeId)) return [];

    return RoomInvitation.find({
      inviteeId: asId(inviteeId),
      status: INVITATION_STATUS.pending,
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  async countForInvitee(inviteeId: string): Promise<number> {
    if (!isObjectId(inviteeId)) return 0;

    return RoomInvitation.countDocuments({
      inviteeId: asId(inviteeId),
      status: INVITATION_STATUS.pending,
    }).exec();
  },

  /** Every outstanding invitation for one room, for the invite sheet. */
  async listPendingForRoom(roomId: string) {
    if (!isObjectId(roomId)) return [];

    return RoomInvitation.find({
      roomId: asId(roomId),
      status: INVITATION_STATUS.pending,
    })
      .lean()
      .exec();
  },

  /** How many invitations this user has sent to this room while pending. */
  async countSentByInviter(roomId: string, inviterId: string): Promise<number> {
    if (!isObjectId(roomId) || !isObjectId(inviterId)) return 0;

    return RoomInvitation.countDocuments({
      roomId: asId(roomId),
      inviterId: asId(inviterId),
      status: INVITATION_STATUS.pending,
    }).exec();
  },

  /**
   * Expires every pending invitation for one room.
   *
   * Called when the room closes. Without it a closed room's invitations would
   * sit pending until the sweeper reached them, and each one would render in
   * somebody's inbox as a room they can tap and be refused by.
   */
  async expireForRoom(roomId: string): Promise<number> {
    if (!isObjectId(roomId)) return 0;

    const result = await RoomInvitation.updateMany(
      { roomId: asId(roomId), status: INVITATION_STATUS.pending },
      { $set: { status: INVITATION_STATUS.expired } },
    ).exec();

    return result.modifiedCount;
  },

  /** Expires every pending invitation whose deadline has passed. */
  async expireLapsed(now: Date): Promise<number> {
    const result = await RoomInvitation.updateMany(
      { status: INVITATION_STATUS.pending, expiresAt: { $lte: now } },
      { $set: { status: INVITATION_STATUS.expired } },
    ).exec();

    return result.modifiedCount;
  },

  /**
   * Expires the pending invitations between two people, in both directions.
   *
   * Reached when a block is placed. An invitation that outlived the
   * relationship it was sent on is exactly what the block exists to prevent.
   */
  async expireBetween(a: string, b: string): Promise<number> {
    if (!isObjectId(a) || !isObjectId(b)) return 0;

    const result = await RoomInvitation.updateMany(
      {
        status: INVITATION_STATUS.pending,
        $or: [
          { inviterId: asId(a), inviteeId: asId(b) },
          { inviterId: asId(b), inviteeId: asId(a) },
        ],
      },
      { $set: { status: INVITATION_STATUS.expired } },
    ).exec();

    return result.modifiedCount;
  },
};
