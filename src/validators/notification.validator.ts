import { z } from 'zod';

import {
  DEVICE_PLATFORM,
  DEVICE_PLATFORMS,
  DEVICE_TOKEN_LIMITS,
  NOTIFICATION_LIMITS,
  type DevicePlatformWire,
} from '@/constants/notification.constants';
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
 * paging, the id of a row the caller already owns, and the address of a device
 * the caller is holding.
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

/**
 * `POST /api/notifications/device-token`
 *
 * The one schema in this file that accepts anything beyond paging, and the
 * exception is narrow on purpose: none of these fields names a *recipient*.
 * The row is always written against the authenticated caller — see
 * `deviceToken.controller.ts` — so the worst a malicious body can do is
 * register a device to its own sender.
 *
 * The token bounds are a sanity check, not a format check. FCM registration
 * tokens are opaque and have changed shape across SDK versions, so a stricter
 * rule would start rejecting valid devices on some future release; whether a
 * token is live is settled by a send, not here.
 */
export const deviceTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(
      DEVICE_TOKEN_LIMITS.minTokenLength,
      'That does not look like an FCM registration token.',
    )
    .max(DEVICE_TOKEN_LIMITS.maxTokenLength),
  /**
   * Defaulted rather than required, so a client built before this field
   * existed still registers. Android is the only platform shipping today.
   */
  platform: z.enum(DEVICE_PLATFORMS as [DevicePlatformWire, ...DevicePlatformWire[]])
    .catch(DEVICE_PLATFORM.android)
    .default(DEVICE_PLATFORM.android),
  /** Optional and untrusted; see the field's note on the model. */
  deviceId: z
    .string()
    .trim()
    .max(DEVICE_TOKEN_LIMITS.maxDeviceIdLength)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

/**
 * `DELETE /api/notifications/device-token`
 *
 * The token to retire. Sent in the body rather than the path because a
 * registration token is long, opaque and would end up in every access log if
 * it were part of the URL.
 */
export const deviceTokenRemovalSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, 'A device token is required.')
    .max(DEVICE_TOKEN_LIMITS.maxTokenLength),
});
