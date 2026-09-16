import { maskToken } from '@/config/firebaseAdmin';
import type { DevicePlatformWire } from '@/constants/notification.constants';
import { deviceTokenRepository } from '@/repositories/deviceToken.repository';
import { logger } from '@/utils/logger';

/**
 * Device registration (brief sections: Flutter FCM, Backend device token
 * storage).
 *
 * ## Why there is no "is this a real token" check
 *
 * There is no offline way to validate an FCM registration token. It is an
 * opaque string issued by Google to one app instance, and the only authority
 * on whether it is live is a send — which is why the *send* path prunes dead
 * tokens rather than this one rejecting them up front. What this layer does
 * enforce is shape (length bounds, in the validator) and ownership: the row is
 * always written against the caller's own id, never one from the body.
 *
 * ## Why registering is idempotent and unconditional
 *
 * The client calls this on every launch, after every sign-in, and on every
 * token refresh — three paths that overlap constantly. Making it a plain
 * upsert means they cannot disagree and none of them has to check first.
 */

export interface RegisterDeviceInput {
  userId: string;
  token: string;
  platform: DevicePlatformWire;
  deviceId: string | null;
}

export class DeviceTokenService {
  /** `POST /api/notifications/device-token` */
  async register(input: RegisterDeviceInput): Promise<{ registered: true; devices: number }> {
    await deviceTokenRepository.upsert(input);

    // Retire the oldest surplus, if this person has collected more handsets
    // than the cap allows. After the upsert, so the device that just arrived
    // is the freshest and can never be the one retired.
    const retired = await deviceTokenRepository.trimToCap(input.userId);
    const devices = await deviceTokenRepository.countActive(input.userId);

    logger.info('[FCM] device token registered', {
      userId: input.userId,
      maskedToken: maskToken(input.token),
      platform: input.platform,
      tokenRegistered: true,
      tokenUpdated: true,
      devices,
      retired,
    });

    return { registered: true, devices };
  }

  /**
   * `DELETE /api/notifications/device-token`
   *
   * Called on sign-out. Scoped to the caller, so a token presented by somebody
   * who does not own it deactivates nothing — and reports success anyway,
   * because telling a caller "that token is not yours" is telling them it
   * belongs to somebody.
   */
  async unregister(userId: string, token: string): Promise<{ removed: boolean }> {
    const removed = await deviceTokenRepository.deactivateForUser(userId, token);

    logger.info('[FCM] device token unregistered', {
      userId,
      maskedToken: maskToken(token),
      removed,
    });

    return { removed };
  }

  /** Signs every one of this person's devices out. */
  async unregisterAll(userId: string): Promise<{ removed: number }> {
    const removed = await deviceTokenRepository.deactivateAllForUser(userId);

    logger.info('[FCM] all device tokens unregistered', { userId, removed });

    return { removed };
  }
}

export const deviceTokenService = new DeviceTokenService();
