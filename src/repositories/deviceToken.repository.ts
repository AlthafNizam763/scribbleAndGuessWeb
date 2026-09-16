import { Types } from 'mongoose';

import { DEVICE_TOKEN_LIMITS, type DevicePlatformWire } from '@/constants/notification.constants';
import { UserDeviceToken, type UserDeviceTokenDocument } from '@/models/UserDeviceToken';

/**
 * Data access for device registrations.
 *
 * Every method here takes ids as strings and converts at the boundary, like
 * the other repositories in this directory, so no caller has to know that
 * Mongo wants `ObjectId`s.
 */

function oid(id: string): Types.ObjectId {
  return new Types.ObjectId(id);
}

export const deviceTokenRepository = {
  /**
   * Records that [token] now belongs to [userId], creating the row if needed.
   *
   * One upsert keyed on the token, which is what makes this correct for the
   * awkward cases rather than only the ordinary one:
   *
   * - **The same device, same user, again.** Ordinary. `lastUsedAt` moves and
   *   nothing else changes, which is exactly what the client calls this for on
   *   every launch.
   * - **The same device, a different user.** A shared handset, or a guest
   *   session replaced by another. `userId` is rewritten, so the notification
   *   follows the person now signed in rather than the person who was.
   * - **A token that FCM had rejected.** `isActive` goes back to true, because
   *   a device presenting a token is the strongest possible evidence that it
   *   is alive.
   *
   * Returns the stored row.
   */
  async upsert(input: {
    userId: string;
    token: string;
    platform: DevicePlatformWire;
    deviceId: string | null;
  }): Promise<UserDeviceTokenDocument> {
    const now = new Date();

    const row = await UserDeviceToken.findOneAndUpdate(
      { token: input.token },
      {
        $set: {
          userId: oid(input.userId),
          platform: input.platform,
          deviceId: input.deviceId,
          isActive: true,
          lastUsedAt: now,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();

    return row as UserDeviceTokenDocument;
  },

  /** Every live registration for one person, freshest first. */
  async activeForUser(userId: string): Promise<UserDeviceTokenDocument[]> {
    return UserDeviceToken.find({ userId: oid(userId), isActive: true })
      .sort({ lastUsedAt: -1 })
      .lean()
      .exec() as unknown as Promise<UserDeviceTokenDocument[]>;
  },

  /**
   * Every live registration for a set of people, in one query.
   *
   * The reason the tournament fan-out is two round trips rather than two per
   * recipient: sixteen players is one `$in` here, not sixteen `activeForUser`
   * calls.
   */
  async activeForUsers(userIds: string[]): Promise<UserDeviceTokenDocument[]> {
    if (userIds.length === 0) return [];

    return UserDeviceToken.find({
      userId: { $in: userIds.map(oid) },
      isActive: true,
    })
      .lean()
      .exec() as unknown as Promise<UserDeviceTokenDocument[]>;
  },

  /**
   * Retires the oldest registrations past the per-user cap.
   *
   * Least-recently-used, so the phone somebody is holding is never the one
   * dropped. Deactivated rather than deleted for the same reason as everywhere
   * else here: the device may come back, and when it does the upsert should
   * find its row.
   */
  async trimToCap(userId: string): Promise<number> {
    const surplus = await UserDeviceToken.find({ userId: oid(userId), isActive: true })
      .sort({ lastUsedAt: -1 })
      .skip(DEVICE_TOKEN_LIMITS.maxDevicesPerUser)
      .select({ _id: 1 })
      .lean()
      .exec();

    if (surplus.length === 0) return 0;

    const result = await UserDeviceToken.updateMany(
      { _id: { $in: surplus.map((row) => row._id) } },
      { $set: { isActive: false } },
    ).exec();

    return result.modifiedCount ?? 0;
  },

  /**
   * Signs one device out.
   *
   * Scoped to the owner, so presenting somebody else's token silences nothing:
   * a token is not a capability over the row it names.
   */
  async deactivateForUser(userId: string, token: string): Promise<boolean> {
    const result = await UserDeviceToken.updateOne(
      { userId: oid(userId), token },
      { $set: { isActive: false } },
    ).exec();

    return (result.modifiedCount ?? 0) > 0;
  },

  /** Signs every device of one person out. */
  async deactivateAllForUser(userId: string): Promise<number> {
    const result = await UserDeviceToken.updateMany(
      { userId: oid(userId), isActive: true },
      { $set: { isActive: false } },
    ).exec();

    return result.modifiedCount ?? 0;
  },

  /**
   * Retires tokens FCM has told us are dead.
   *
   * Not scoped to a user, deliberately: this is called with tokens that came
   * back from a send, and the authority is Google rather than the caller.
   */
  async deactivateTokens(tokens: string[]): Promise<number> {
    if (tokens.length === 0) return 0;

    const result = await UserDeviceToken.updateMany(
      { token: { $in: tokens } },
      { $set: { isActive: false } },
    ).exec();

    return result.modifiedCount ?? 0;
  },

  /** Moves `lastUsedAt` forward on tokens that just accepted a message. */
  async touch(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;

    await UserDeviceToken.updateMany(
      { token: { $in: tokens } },
      { $set: { lastUsedAt: new Date() } },
    ).exec();
  },

  /** How many live devices one person has. */
  async countActive(userId: string): Promise<number> {
    return UserDeviceToken.countDocuments({ userId: oid(userId), isActive: true }).exec();
  },
};
