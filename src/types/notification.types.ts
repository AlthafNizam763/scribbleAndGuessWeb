import type { NotificationTypeWire } from '@/constants/notification.constants';
import type { UserSummaryDto } from '@/types/social.types';

/**
 * What the notification endpoints put on the wire.
 *
 * The same discipline as `social.types.ts`: a `NotificationDocument` holds an
 * `actorId`, and what a client is shown is a public card built from it. There
 * is no field here to put an email, a token or a score in.
 */

export interface NotificationDto {
  id: string;
  type: NotificationTypeWire;
  title: string;
  body: string;
  /** The person who caused it, or null for system notifications. */
  actor: UserSummaryDto | null;
  /**
   * Ids the client needs to act on a tap — a request id, a room code, an
   * achievement key. Never authoritative data: the client re-reads the real
   * row over REST when the notification is opened.
   */
  data: Record<string, unknown>;
  isRead: boolean;
  createdAtMs: number;
  readAtMs: number | null;
}

/** One page of an inbox, with the badge number alongside. */
export interface NotificationPageDto {
  items: NotificationDto[];
  /** Capped at `NOTIFICATION_LIMITS.maxUnreadCount`; the client renders "99+". */
  unreadCount: number;
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}
