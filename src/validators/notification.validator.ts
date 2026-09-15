import { z } from 'zod';

import { NOTIFICATION_LIMITS } from '@/constants/notification.constants';
import { PAGE_LIMITS } from '@/constants/social.constants';

/**
 * Validation for the notification endpoints.
 *
 * The same "coerce, do not reject" rule as `social.validator.ts`: a `limit` of
 * 5000 is an optimistic client rather than an attack, so it is clamped.
 *
 * ## What is deliberately absent
 *
 * No schema here accepts a `userId`, a `type`, a `title` or a `body`. Every
 * notification is server-authored — there is no endpoint by which a client can
 * put a row in anybody's inbox, including its own — so the only inputs are
 * paging and the id of a row the caller already owns.
 */

/** `GET /api/notifications?page=&limit=&unreadOnly=` */
export const notificationQuerySchema = z.object({
  page: z.coerce.number().int().catch(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .catch(NOTIFICATION_LIMITS.defaultLimit)
    .default(NOTIFICATION_LIMITS.defaultLimit)
    .transform((value) => Math.min(Math.max(value, 1), NOTIFICATION_LIMITS.maxLimit)),
  /**
   * Narrows the page to unread rows.
   *
   * Accepts the string `true` because it arrives as a query parameter; any
   * other value reads as false rather than failing, since a mistyped filter
   * should show the whole list, not an error.
   */
  unreadOnly: z
    .union([z.boolean(), z.string()])
    .catch(false)
    .default(false)
    .transform((value) => value === true || value === 'true' || value === '1'),
});

/** The page depth bound, shared with every other list endpoint. */
export const maxNotificationPage = PAGE_LIMITS.maxPage;
