import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

import { DEVICE_PLATFORMS, DEVICE_TOKEN_LIMITS } from '@/constants/notification.constants';

/**
 * One device a player can be reached on when the app is not running.
 *
 * ## Why this collection exists at all
 *
 * Because the socket cannot answer the question the check-in notification asks.
 * `emitToUser` reaches every device that is *connected right now*, which by
 * definition excludes the player who registered for a tournament and then put
 * their phone in a pocket — the exact person the notification is for. An FCM
 * token is the address of a device rather than of a connection, and it stays
 * valid while the app is closed.
 *
 * ## Why the token is the unique key, not the user
 *
 * A person has several devices and a device has several owners. A phone handed
 * to a sibling who signs in as a guest gets the *same* FCM token under a new
 * user id, and if `userId` were the key both rows would survive and the
 * sibling's tournament notifications would be delivered to the first player's
 * handset. Keying on the token means the upsert moves it to whoever holds the
 * device now, which is the only reading that is ever correct.
 *
 * ## Why rows are deactivated rather than deleted
 *
 * `isActive: false` is written both by a sign-out and by FCM telling us a
 * token is dead (`messaging/registration-token-not-registered`). Keeping the
 * row means the next `getToken()` on that device upserts onto it and brings
 * it back, with its `createdAt` intact, instead of churning a new `_id` on
 * every reinstall. The sweeper below eventually removes the ones that never
 * come back.
 */

const userDeviceTokenSchema = new Schema(
  {
    /** Who this device is currently signed in as. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * The FCM registration token.
     *
     * Opaque and long — Google does not document a maximum, and observed
     * values have grown over time — so the bound below is generous rather than
     * exact. It exists to stop somebody posting a megabyte, not to validate
     * the format.
     */
    token: {
      type: String,
      required: true,
      trim: true,
      minlength: DEVICE_TOKEN_LIMITS.minTokenLength,
      maxlength: DEVICE_TOKEN_LIMITS.maxTokenLength,
    },

    platform: { type: String, enum: DEVICE_PLATFORMS, required: true },

    /**
     * A stable id for the handset, when the client can produce one.
     *
     * Not a key and not trusted: it is here so a support question — "which of
     * this player's three phones stopped getting notifications" — has an
     * answer. Token uniqueness is what actually prevents duplicates.
     */
    deviceId: {
      type: String,
      trim: true,
      maxlength: DEVICE_TOKEN_LIMITS.maxDeviceIdLength,
      default: null,
    },

    /** Whether this device should be sent to. */
    isActive: { type: Boolean, required: true, default: true },

    /**
     * The last time the client presented this token, or the last time a send
     * to it succeeded.
     *
     * The freshness signal FCM asks callers to keep: a token untouched for
     * months belongs to an app that has been uninstalled, and sending to it is
     * wasted quota.
     */
    lastUsedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, collection: 'userDeviceTokens' },
);

/**
 * The uniqueness rule, and the reason the upsert is safe.
 *
 * One row per token, globally. Two devices cannot share a token, so a
 * collision here always means the same handset re-registering — possibly as a
 * different user — and the upsert's `$set` is exactly the right resolution.
 */
userDeviceTokenSchema.index({ token: 1 }, { unique: true });

/**
 * The send query: every live device for one person.
 *
 * Partial over `isActive: true` because that is the only value the send path
 * ever asks for, and a deactivated row is dead weight in an index whose whole
 * job is to be small enough to stay hot.
 */
userDeviceTokenSchema.index(
  { userId: 1, lastUsedAt: -1 },
  { partialFilterExpression: { isActive: true } },
);

/**
 * The per-user uniqueness the brief asks for.
 *
 * Strictly implied by the global unique index above — if a token is unique
 * everywhere it is unique within a user — so this one is *not* declared
 * unique. Declaring it so would be a second unique constraint enforcing a
 * weaker condition, which buys nothing and costs a write check. It exists as
 * a plain compound index because `findOne({ userId, token })` is how a
 * sign-out finds the row to deactivate.
 */
userDeviceTokenSchema.index({ userId: 1, token: 1 });

/**
 * Mongo's sweeper for devices that never came back.
 *
 * A year, and measured from `lastUsedAt`, which every registration and every
 * successful send pushes forward — so this only ever reaches a device that has
 * not opened the app in twelve months. Deliberately far longer than the
 * notification TTL: a row here is an address, and a player who reinstalls
 * after a long break should keep their place rather than be rediscovered.
 */
userDeviceTokenSchema.index(
  { lastUsedAt: 1 },
  { expireAfterSeconds: DEVICE_TOKEN_LIMITS.retentionSeconds },
);

export type UserDeviceTokenDocument = InferSchemaType<typeof userDeviceTokenSchema> & {
  _id: Types.ObjectId;
};

export const UserDeviceToken: Model<UserDeviceTokenDocument> =
  (models.UserDeviceToken as Model<UserDeviceTokenDocument>) ??
  model<UserDeviceTokenDocument>('UserDeviceToken', userDeviceTokenSchema);
