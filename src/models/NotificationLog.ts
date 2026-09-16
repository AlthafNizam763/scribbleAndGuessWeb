import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import {
  NOTIFICATION_LOG_STATUS,
  NOTIFICATION_LOG_STATUSES,
  PUSH_NOTIFICATION_TYPES,
} from '@/constants/notification.constants';

/**
 * The record that one push was already decided for one person.
 *
 * ## What this is for, and what `notifications` is for
 *
 * `Notification` is the player's inbox: a row they can read, mark and delete.
 * This is the *sender's* ledger, which a player never sees and cannot touch.
 * They answer different questions, and merging them would mean a player able
 * to delete the evidence that stops a second push being sent.
 *
 * ## Why the unique index is the whole feature
 *
 * The tournament scheduler is deliberately safe to run twice — a timer in this
 * process and an external cron may both tick, and either may be retried after
 * a crash mid-tick. Every status transition it makes is already a conditional
 * write, so the *transition* happens once. The push is not a transition, and
 * without a claim of its own a retry that found the tournament already in
 * `CHECK_IN` could still fan a second notification out to everybody in it.
 *
 * So the send path inserts here *first*. The insert is the claim: if it
 * succeeds this process owns the send, and if it fails with a duplicate key
 * somebody else already owns it and this process does nothing. That is one
 * atomic operation with no read-then-write window, which is the same argument
 * the scheduler lock makes one level up.
 *
 * ## Why a failed send keeps its row
 *
 * Marked `FAILED` rather than deleted, so a token that FCM rejected is a
 * recorded fact instead of an invitation to try again on the next tick and
 * fail identically. A genuinely retryable failure is retried inside the send
 * (see `push.service.ts`); reaching this row means the attempt is over.
 */

const notificationLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * Which tournament this concerned.
     *
     * Required, because every type in `PUSH_NOTIFICATION_TYPES` is about one.
     * A future push that is not — a system announcement, say — would need this
     * relaxed and the unique index below reconsidered, which is exactly the
     * review such a change should get.
     */
    tournamentId: { type: Schema.Types.ObjectId, ref: 'AutoTournament', required: true },

    type: { type: String, enum: PUSH_NOTIFICATION_TYPES, required: true },

    /**
     * `TYPE:tournamentId:userId`, the human-readable form of the same claim
     * the compound index enforces.
     *
     * Stored as well as indexed because it is what the logs print: a support
     * question about one missing notification is answered by grepping for one
     * string rather than by reconstructing three ids.
     */
    notificationKey: { type: String, required: true },

    status: {
      type: String,
      enum: NOTIFICATION_LOG_STATUSES,
      required: true,
      default: NOTIFICATION_LOG_STATUS.sent,
    },

    sentAt: { type: Date, default: null },

    /** Why it failed, when it did. Never carries a token. */
    errorMessage: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true, collection: 'notificationLogs' },
);

/**
 * The claim. One push of one type, per tournament, per person — for ever.
 *
 * Exactly the index the brief asks for, and the reason the send path can be
 * written as "insert, then send" rather than "check, then send".
 */
notificationLogSchema.index({ userId: 1, tournamentId: 1, type: 1 }, { unique: true });

/**
 * The same claim under its printed name.
 *
 * Unique as well, so the two can never disagree: a row whose key was built
 * from different ids than its own fields would be a silent bug in the one
 * place that must not have one.
 */
notificationLogSchema.index({ notificationKey: 1 }, { unique: true });

/** "How did the fan-out for this tournament go", for the logs and for support. */
notificationLogSchema.index({ tournamentId: 1, status: 1 });

export type NotificationLogDocument = InferSchemaType<typeof notificationLogSchema> & {
  _id: Types.ObjectId;
};

export const NotificationLog: Model<NotificationLogDocument> =
  (models.NotificationLog as Model<NotificationLogDocument>) ??
  model<NotificationLogDocument>('NotificationLog', notificationLogSchema);
