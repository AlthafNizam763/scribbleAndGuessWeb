import { request } from '@/web/api';
import type { NotificationDto, NotificationPageDto } from '@/types/notification.types';

/**
 * The notification endpoints.
 *
 * ## Why every mutation returns a count
 *
 * The badge draws whatever the server last said, and never arithmetic on its
 * own previous value. A tab that decremented its own counter would drift the
 * first time it missed a push — a sleeping laptop, a dropped socket — and
 * nothing would ever bring it back. So each call below hands the caller the
 * authoritative figure, and the provider stores that.
 *
 * ## There is no create
 *
 * Notifications are written by the server from events that already happened.
 * There is no endpoint that would put a row in an inbox, so there is nothing
 * here that could call one.
 *
 * Like `rooms.ts`, this owns no rules: a row that is not the caller's comes
 * back as a 404 `ApiError` carrying the sentence the server wrote.
 */

export type { NotificationDto, NotificationPageDto };

/** One page of the caller's inbox, newest first. */
export function fetchNotifications(
  token: string,
  options: { page?: number; limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationPageDto> {
  const query = new URLSearchParams();
  if (options.page) query.set('page', String(options.page));
  if (options.limit) query.set('limit', String(options.limit));
  if (options.unreadOnly) query.set('unreadOnly', 'true');

  const suffix = query.toString();
  return request<NotificationPageDto>(
    suffix ? `/api/notifications?${suffix}` : '/api/notifications',
    { token },
  );
}

/** Marks one row read. Returns the server's new unread count. */
export async function markNotificationRead(
  token: string,
  notificationId: string,
): Promise<number> {
  const result = await request<{ unreadCount: number }>(
    `/api/notifications/${notificationId}/read`,
    { method: 'PATCH', token },
  );

  return result?.unreadCount ?? 0;
}

/** Clears the whole backlog. Returns the new unread count, always zero. */
export async function markAllNotificationsRead(token: string): Promise<number> {
  const result = await request<{ updated: number; unreadCount: number }>(
    '/api/notifications/read-all',
    { method: 'PATCH', token },
  );

  return result?.unreadCount ?? 0;
}

/** Deletes one row. Returns the new unread count. */
export async function deleteNotification(
  token: string,
  notificationId: string,
): Promise<number> {
  const result = await request<{ unreadCount: number }>(
    `/api/notifications/${notificationId}`,
    { method: 'DELETE', token },
  );

  return result?.unreadCount ?? 0;
}
