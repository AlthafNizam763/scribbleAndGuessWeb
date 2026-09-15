import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import {
  NOTIFICATION_LIMITS,
  NOTIFICATION_TYPES,
} from '@/constants/notification.constants';

/**
 * One nudge addressed to one person.
 *
 * ## Why this is stored at all, given the socket already pushes
 *
 * The socket push and this row answer different questions. The push says
 * "something just happened" to a device that is connected right now; the row
 * says "here is what happened while you were away" to a device that opens the
 * app tomorrow. A feature built only on pushes loses every event for every
 * offline player, which is most events for most players.
 *
 * So the write comes first and the push is the optimisation, exactly as in
 * `social.notify.ts`: a push that fails costs a badge that appears a screen
 * later, never a notification that never existed.
 *
 * ## What it may carry
 *
 * `title` and `body` are rendered as stored, so they are server-authored and
 * bounded. `data` carries the ids the client needs to act on a tap — a request
 * id, a room code — and nothing else: no tokens, no email, no scores that
 * could be read back as authoritative. A notification is a pointer into the
 * REST API, not a copy of it, and the client re-reads the real row on tap.
 */

const notificationSchema = new Schema(
  {
    /** Who this is for. Every query in the repository leads with it. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: { type: String, enum: NOTIFICATION_TYPES, required: true },

    title: { type: String, required: true, trim: true, maxlength: NOTIFICATION_LIMITS.maxTitleLength },
    body: { type: String, required: true, trim: true, maxlength: NOTIFICATION_LIMITS.maxBodyLength },

    /**
     * Who caused it, when that is a person.
     *
     * Optional because a system announcement has no actor. Stored as an id
     * rather than a name so a rename is reflected the next time the list is
     * read — the serializer hydrates the public card from `users`.
     */
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Type-specific ids for the tap target. Free-form by design; see the
     * class comment above for why, and for what may not go in here.
     */
    data: { type: Schema.Types.Mixed, default: () => ({}) },

    readAt: { type: Date, default: null },

    /**
     * When Mongo may delete this row.
     *
     * Set by the service from `NOTIFICATION_LIMITS.retentionDays`. Unlike
     * `RoomInvitation.expiresAt` — which is a *state* the accept path checks,
     * and deliberately not a TTL — expiry here really is deletion: an old
     * notification has no meaning to preserve, and nothing reads a row after
     * its window. So the TTL index below does the sweeping and no scheduled
     * job has to exist for it.
     */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'notifications' },
);

/**
 * The inbox query: one person's notifications, newest first.
 *
 * `userId` leads because it is the equality predicate on every read, and
 * `createdAt` follows so the sort comes off the index rather than a blocking
 * in-memory stage. `_id` is the tie-break that keeps paging stable when two
 * rows share a millisecond — without it, a notification can appear on two
 * consecutive pages or on neither.
 */
notificationSchema.index({ userId: 1, createdAt: -1, _id: -1 });

/**
 * The unread badge, and the "mark all as read" write.
 *
 * A partial index over unread rows only. The alternative — a compound index
 * including `readAt` — would index every row a player has ever received to
 * answer a question that only concerns the handful they have not opened. This
 * one stays proportional to the backlog rather than to the history.
 */
notificationSchema.index(
  { userId: 1, createdAt: -1 },
  { partialFilterExpression: { readAt: null } },
);

/** Mongo's sweeper. `expireAfterSeconds: 0` means "delete at `expiresAt`". */
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type NotificationDocument = InferSchemaType<typeof notificationSchema> & {
  _id: Types.ObjectId;
};

export const Notification: Model<NotificationDocument> =
  (models.Notification as Model<NotificationDocument>) ??
  model<NotificationDocument>('Notification', notificationSchema);
