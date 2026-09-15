import { Types } from 'mongoose';

import { NOTIFICATION_LIMITS } from '@/constants/notification.constants';
import { Notification, type NotificationDocument } from '@/models/Notification';
import { isObjectId } from '@/repositories/user.repository';

/**
 * Data access for `notifications`.
 *
 * As everywhere else in this layer there are no rules here — whether a caller
 * *may* read or clear a row is the service's business. What this module owns
 * is that every query is scoped by `userId`, which is the one invariant that
 * keeps one player's inbox out of another's: there is no method below that can
 * be called with only a notification id.
 */

const asId = (value: string): Types.ObjectId => new Types.ObjectId(value);

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  actorId?: string | null;
  data?: Record<string, unknown>;
  expiresAt: Date;
}

export const notificationRepository = {
  async create(input: CreateNotificationInput): Promise<NotificationDocument> {
    return (await Notification.create({
      userId: asId(input.userId),
      type: input.type,
      title: input.title,
      body: input.body,
      actorId: input.actorId && isObjectId(input.actorId) ? asId(input.actorId) : null,
      data: input.data ?? {},
      expiresAt: input.expiresAt,
    })) as NotificationDocument;
  },

  /**
   * Inserts many rows in one round trip.
   *
   * `ordered: false` so one bad row cannot suppress the rest — a fan-out to
   * every friend of a player who just started a game must not be abandoned
   * halfway because one recipient's row was rejected.
   */
  async createMany(inputs: CreateNotificationInput[]): Promise<number> {
    if (inputs.length === 0) return 0;

    const docs = await Notification.insertMany(
      inputs.map((input) => ({
        userId: asId(input.userId),
        type: input.type,
        title: input.title,
        body: input.body,
        actorId: input.actorId && isObjectId(input.actorId) ? asId(input.actorId) : null,
        data: input.data ?? {},
        expiresAt: input.expiresAt,
      })),
      { ordered: false },
    );

    return docs.length;
  },

  /** One page of an inbox, newest first. Served straight from the index. */
  async list(userId: string, limit: number, skip: number, unreadOnly = false) {
    const filter: Record<string, unknown> = { userId: asId(userId) };
    if (unreadOnly) filter.readAt = null;

    return Notification.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },

  async count(userId: string, unreadOnly = false): Promise<number> {
    const filter: Record<string, unknown> = { userId: asId(userId) };
    if (unreadOnly) filter.readAt = null;

    return Notification.countDocuments(filter).exec();
  },

  /**
   * The badge number, capped.
   *
   * `limit` on a count is what turns an `O(unread)` scan into a bounded one:
   * past the cap the exact figure is never rendered, so counting further would
   * be work whose result is thrown away.
   */
  async unreadCount(userId: string): Promise<number> {
    return Notification.countDocuments({ userId: asId(userId), readAt: null })
      .limit(NOTIFICATION_LIMITS.maxUnreadCount + 1)
      .exec();
  },

  /**
   * Marks one row read, but only if it belongs to the caller.
   *
   * The ownership check is the filter rather than a prior read: a row fetched,
   * checked and then written can be reassigned in between, and two queries are
   * two chances to get the predicate wrong. `null` back means "no such row of
   * yours", which the service reports as `NOT_FOUND` — the same answer a
   * stranger's id gets, so an id is never a probe for whether a row exists.
   */
  async markRead(userId: string, notificationId: string): Promise<NotificationDocument | null> {
    if (!isObjectId(notificationId)) return null;

    return Notification.findOneAndUpdate(
      { _id: asId(notificationId), userId: asId(userId), readAt: null },
      { $set: { readAt: new Date() } },
      { new: true },
    )
      .lean()
      .exec() as Promise<NotificationDocument | null>;
  },

  /** Whether a row of the caller's exists at all, read or not. */
  async findOwned(userId: string, notificationId: string) {
    if (!isObjectId(notificationId)) return null;
    return Notification.findOne({ _id: asId(notificationId), userId: asId(userId) }).lean().exec();
  },

  /** Marks the caller's whole backlog read. Returns how many changed. */
  async markAllRead(userId: string): Promise<number> {
    const result = await Notification.updateMany(
      { userId: asId(userId), readAt: null },
      { $set: { readAt: new Date() } },
    ).exec();

    return result.modifiedCount ?? 0;
  },

  /** Deletes one row of the caller's. Returns whether anything was deleted. */
  async remove(userId: string, notificationId: string): Promise<boolean> {
    if (!isObjectId(notificationId)) return false;

    const result = await Notification.deleteOne({
      _id: asId(notificationId),
      userId: asId(userId),
    }).exec();

    return (result.deletedCount ?? 0) > 0;
  },
};
