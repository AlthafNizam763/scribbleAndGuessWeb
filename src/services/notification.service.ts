import { emitToUser } from '@/config/socket';
import {
  NOTIFICATION_LIMITS,
  type NotificationTypeWire,
} from '@/constants/notification.constants';
import { PAGE_LIMITS } from '@/constants/social.constants';
import { NOTIFICATION_EVENTS, type NotificationEventName } from '@/constants/socket.constants';
import type { NotificationDocument } from '@/models/Notification';
import { notificationRepository } from '@/repositories/notification.repository';
import { userRepository } from '@/repositories/user.repository';
import { toUserSummary } from '@/services/profile.serialize';
import type { NotificationDto, NotificationPageDto } from '@/types/notification.types';
import type { UserSummaryDto } from '@/types/social.types';
import { AppError, ErrorCode } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * The notification centre (brief section: Notifications Center).
 *
 * ## The one rule every producer goes through
 *
 * Nothing else in this codebase writes to `notifications`. Friend requests,
 * room invitations, achievements and game results all call `notify` here, and
 * that is what makes three things true in one place rather than eleven:
 *
 * 1. **The row is written before the push.** A notification exists for an
 *    offline player exactly as it does for a connected one.
 * 2. **A failure never fails the action.** Every path below is fire-and-forget
 *    from the caller's point of view: a friend request that was accepted in
 *    Mongo is accepted whether or not the notification landed. This is the
 *    same argument as `social.notify.ts`, one layer up.
 * 3. **The badge count is computed server-side.** A client never adds one to
 *    its own number; it is told what the number is.
 *
 * ## Why `notify` swallows its own errors
 *
 * It is called from inside social and game flows that have already committed
 * their real work. Letting a notification write throw there would turn a
 * cosmetic failure into a failed friend request, which is strictly worse than
 * a missing nudge. A caller that needs to know a row was written — none today
 * — would use `notificationRepository` directly.
 */

function expiryFrom(now: number): Date {
  return new Date(now + NOTIFICATION_LIMITS.retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Trims server-authored text to the bounds the schema enforces.
 *
 * The ellipsis is part of the budget, not an addition to it — a truncation
 * that overshoots the limit by three characters is exactly the write the
 * schema would then reject, which is the one failure mode a clamp exists to
 * prevent.
 */
const ELLIPSIS = '...';

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;

  return `${trimmed.slice(0, Math.max(0, max - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}`;
}

export interface NotifyInput {
  userId: string;
  type: NotificationTypeWire;
  title: string;
  body: string;
  actorId?: string | null;
  data?: Record<string, unknown>;
}

function toDto(
  doc: NotificationDocument | Record<string, unknown>,
  actor: UserSummaryDto | null,
): NotificationDto {
  const row = doc as NotificationDocument & { createdAt?: Date };

  return {
    id: String(row._id),
    type: row.type as NotificationTypeWire,
    title: row.title,
    body: row.body,
    actor,
    data: (row.data as Record<string, unknown>) ?? {},
    isRead: row.readAt != null,
    createdAtMs: (row.createdAt ?? new Date()).getTime(),
    readAtMs: row.readAt ? new Date(row.readAt).getTime() : null,
  };
}

/** Public cards for a set of actor ids, in one query. */
async function actorsFor(ids: string[]): Promise<Map<string, UserSummaryDto>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const users = await userRepository.findManyByIds(unique);
  return new Map(users.map((user) => [String(user._id), toUserSummary(user)]));
}

function push(userId: string, name: NotificationEventName, payload: Record<string, unknown>): void {
  const event = NOTIFICATION_EVENTS[name];

  try {
    const body = { ...payload, atMs: Date.now() };
    emitToUser(userId, event.canonical, body);
    emitToUser(userId, event.alias, body);
  } catch (error) {
    // A push nobody received costs a badge that updates on the next open.
    logger.exception('notification push failed', error, { userId, event: event.canonical });
  }
}

export class NotificationService {
  /**
   * Writes one notification and pushes it.
   *
   * Returns the row it wrote, or null when the write failed — which callers
   * are free to ignore, and all of them do.
   */
  async notify(input: NotifyInput): Promise<NotificationDto | null> {
    try {
      const doc = await notificationRepository.create({
        userId: input.userId,
        type: input.type,
        title: clamp(input.title, NOTIFICATION_LIMITS.maxTitleLength),
        body: clamp(input.body, NOTIFICATION_LIMITS.maxBodyLength),
        actorId: input.actorId ?? null,
        data: input.data ?? {},
        expiresAt: expiryFrom(Date.now()),
      });

      const actors = await actorsFor(input.actorId ? [input.actorId] : []);
      const dto = toDto(doc, input.actorId ? (actors.get(input.actorId) ?? null) : null);

      push(input.userId, 'created', {
        notification: dto,
        unreadCount: await notificationRepository.unreadCount(input.userId),
      });

      return dto;
    } catch (error) {
      logger.exception('notification write failed', error, {
        userId: input.userId,
        type: input.type,
      });
      return null;
    }
  }

  /**
   * Writes the same notification to many people.
   *
   * One insert for the rows, then one push each. The fan-out cases — a friend
   * started playing, a tournament was announced — are why this is not a loop
   * over `notify`: that would be one insert and one count query per recipient,
   * which is how a twelve-friend list becomes twenty-four round trips on a
   * path that runs at the start of every match.
   */
  async notifyMany(userIds: string[], input: Omit<NotifyInput, 'userId'>): Promise<number> {
    const recipients = [...new Set(userIds)].filter(Boolean);
    if (recipients.length === 0) return 0;

    const title = clamp(input.title, NOTIFICATION_LIMITS.maxTitleLength);
    const body = clamp(input.body, NOTIFICATION_LIMITS.maxBodyLength);
    const expiresAt = expiryFrom(Date.now());

    try {
      const written = await notificationRepository.createMany(
        recipients.map((userId) => ({
          userId,
          type: input.type,
          title,
          body,
          actorId: input.actorId ?? null,
          data: input.data ?? {},
          expiresAt,
        })),
      );

      // The push carries no row: a client that gets this re-reads the list.
      // Serialising a document per person for a payload most of them will
      // never look at is work the badge does not need.
      await Promise.all(
        recipients.map(async (userId) => {
          push(userId, 'unreadChanged', {
            unreadCount: await notificationRepository.unreadCount(userId),
          });
        }),
      );

      return written;
    } catch (error) {
      logger.exception('notification fan-out failed', error, {
        type: input.type,
        recipients: recipients.length,
      });
      return 0;
    }
  }

  /** `GET /api/notifications` */
  async list(
    userId: string,
    page: number,
    limit: number,
    unreadOnly: boolean,
  ): Promise<NotificationPageDto> {
    const skip = (page - 1) * limit;

    const [rows, total, unreadCount] = await Promise.all([
      notificationRepository.list(userId, limit, skip, unreadOnly),
      notificationRepository.count(userId, unreadOnly),
      notificationRepository.unreadCount(userId),
    ]);

    const actors = await actorsFor(rows.map((row) => String(row.actorId ?? '')));

    const items = rows.map((row) =>
      toDto(row, row.actorId ? (actors.get(String(row.actorId)) ?? null) : null),
    );

    return {
      items,
      unreadCount,
      total,
      page,
      limit,
      hasMore: skip + items.length < total,
    };
  }

  /** `PATCH /api/notifications/:id/read` */
  async markRead(userId: string, notificationId: string): Promise<{ unreadCount: number }> {
    const updated = await notificationRepository.markRead(userId, notificationId);

    if (!updated) {
      // Either the row is not theirs, or it was already read. Those are told
      // apart here and nowhere else: marking an already-read row read is a
      // no-op the client should not see as an error, but a stranger's id must
      // stay indistinguishable from an id that never existed.
      const exists = await notificationRepository.findOwned(userId, notificationId);
      if (!exists) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Notification not found.');
      }
    }

    const unreadCount = await notificationRepository.unreadCount(userId);
    push(userId, 'unreadChanged', { unreadCount, notificationId });

    return { unreadCount };
  }

  /** `PATCH /api/notifications/read-all` */
  async markAllRead(userId: string): Promise<{ updated: number; unreadCount: number }> {
    const updated = await notificationRepository.markAllRead(userId);

    push(userId, 'unreadChanged', { unreadCount: 0 });

    return { updated, unreadCount: 0 };
  }

  /** `DELETE /api/notifications/:id` */
  async remove(userId: string, notificationId: string): Promise<{ unreadCount: number }> {
    const deleted = await notificationRepository.remove(userId, notificationId);

    if (!deleted) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Notification not found.');
    }

    const unreadCount = await notificationRepository.unreadCount(userId);
    push(userId, 'unreadChanged', { unreadCount, notificationId });

    return { unreadCount };
  }

  /** The badge, on its own. */
  async unreadCount(userId: string): Promise<number> {
    return notificationRepository.unreadCount(userId);
  }
}

/**
 * Clamps paging the way the friends and leaderboard lists do.
 *
 * Deliberately a sibling of `listPaging` rather than an import of it: this
 * list has its own `maxLimit`, and sharing the function would mean either a
 * parameter nobody else passes or a silent coupling between two features' page
 * sizes.
 */
export function notificationPaging(input: { page?: number; limit?: number }): {
  page: number;
  limit: number;
} {
  const page = Math.min(Math.max(1, input.page ?? 1), PAGE_LIMITS.maxPage);
  const limit = Math.min(
    Math.max(1, input.limit ?? NOTIFICATION_LIMITS.defaultLimit),
    NOTIFICATION_LIMITS.maxLimit,
  );

  return { page, limit };
}

export const notificationService = new NotificationService();
