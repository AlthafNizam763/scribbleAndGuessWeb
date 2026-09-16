import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { INVITATION_STATUS } from '@/constants/room.constants';

/**
 * One invitation to one room, from the moment it is sent until it is answered.
 *
 * ## Why this is a collection and not a field on the room
 *
 * An invitation outlives the thing it points at. The room is in-memory state
 * mirrored into Mongo; the invitation has to be readable by a player who is
 * not in that room, is not connected, and may not open the app for a minute —
 * `GET /api/rooms/invitations` is answered from here with no room registry
 * involved at all. Hanging a list off the room document would mean an invitee
 * could only find their invitations by scanning every room.
 *
 * It is also the audit trail. A rejected invitation is kept, which is what
 * makes "you already asked them and they said no" answerable, and what a
 * future cool-down on re-inviting would key off.
 *
 * ## The unique index, and the rule it makes true
 *
 * The brief says a friend must not be invited twice to the same room. The
 * service checks before it writes, and that check can lose a race: two devices
 * tapping Invite on the same friend both see nothing pending. What settles it
 * is the partial unique index below, which lets exactly one insert through and
 * fails the other with a duplicate-key error the service turns into the same
 * refusal the pre-check would have produced.
 *
 * `partialFilterExpression` scopes the constraint to `pending`, so a friend
 * who declined — or whose invitation lapsed — can be asked again. Without it,
 * one rejection would bar that person from the room for the room's whole life.
 *
 * ## Expiry
 *
 * `expiresAt` is the authority on whether an invitation is still answerable,
 * and the accept path compares against it directly rather than trusting the
 * status: a row that lapsed a moment ago must be refused whether or not the
 * sweeper has reached it. The status is written to `expired` by the sweeper
 * purely to release the unique-index slot.
 *
 * Deliberately *not* a Mongo TTL index. A TTL would delete the row, which
 * would lose the record of the invitation and — worse — silently free the
 * pending slot at a time nothing in the application controls. Lapsing is a
 * state change here, not a deletion.
 */

const roomInvitationSchema = new Schema(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },

    /** Who sent it. Always a seated member of the room at the time. */
    inviterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /** Who it is for. Always an accepted friend of the inviter. */
    inviteeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    status: {
      type: String,
      enum: Object.values(INVITATION_STATUS),
      required: true,
      default: INVITATION_STATUS.pending,
    },

    /**
     * The room code as it stood when the invitation was sent.
     *
     * Denormalised on purpose. The invitations list has to render "join ABCDE"
     * for a player who is nowhere near that room, and codes are recycled only
     * after a room closes — at which point the invitation is dead anyway. This
     * is what lets the list be answered from one query instead of a room
     * lookup per row.
     */
    roomCode: { type: String, required: true, uppercase: true, trim: true },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'room_invitations' },
);

/** At most one *pending* invitation per (room, invitee). */
roomInvitationSchema.index(
  { roomId: 1, inviteeId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: INVITATION_STATUS.pending },
  },
);

/**
 * The invitee's inbox: "what am I being asked to join", newest first.
 *
 * Covers the brief's `inviteeId` and `status` indexes as prefixes, so neither
 * is declared separately — an index a compound prefix already serves costs a
 * write on every insert and buys nothing.
 */
roomInvitationSchema.index({ inviteeId: 1, status: 1, createdAt: -1 });

/**
 * Everything outstanding for one room.
 *
 * Read by the invite sheet, to mark a friend as already invited, and by the
 * close path, which expires a dead room's invitations in one write.
 */
roomInvitationSchema.index({ roomId: 1, status: 1 });

/** The sweeper's scan: pending rows whose deadline has passed. */
roomInvitationSchema.index({ status: 1, expiresAt: 1 });

/**
 * Mongo's own sweeper, deleting a row an hour after it stopped being useful.
 *
 * ## Why this is not the same thing as the application sweeper
 *
 * `invitationService.expireLapsed()` moves a lapsed invitation from `pending`
 * to `expired`. That is a *status* change, and it has to happen promptly
 * because it is what releases the unique-index slot so the same friend can be
 * invited to that room again. This index does not do that job and cannot
 * replace it: it only deletes.
 *
 * What it adds is the other half — rows that are answered, rejected or expired
 * still sit in the collection forever, and nothing reads them. An invitation is
 * not history anybody looks at; the notification it produced is its own row
 * with its own TTL. So they are deleted.
 *
 * ## Why an hour past `expiresAt`, not at it
 *
 * Deleting exactly at the deadline would race the accept path, which reads the
 * row and *then* compares `expiresAt` in order to answer `Invitation expired`
 * rather than `Not found`. A player tapping a stale invitation should be told
 * it lapsed, not told it never existed. An hour of margin makes that
 * impossible to hit, and Mongo's TTL monitor only runs once a minute anyway,
 * so a tighter figure would be false precision.
 *
 * Accepted and rejected rows are deleted on the same clock. They carry the
 * same `expiresAt` they were created with, so they leave an hour after the
 * invitation would have lapsed regardless of how quickly it was answered.
 */
roomInvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });

export type RoomInvitationDocument = InferSchemaType<typeof roomInvitationSchema> & {
  _id: Types.ObjectId;
};

export const RoomInvitation: Model<RoomInvitationDocument> =
  (models.RoomInvitation as Model<RoomInvitationDocument>) ??
  model<RoomInvitationDocument>('RoomInvitation', roomInvitationSchema);
