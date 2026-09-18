import type { Message, MulticastMessage } from 'firebase-admin/messaging';

import { getPushMessaging, isFirebaseConfigured, maskToken } from '@/config/firebaseAdmin';
import { PUSH_ANDROID_CHANNEL } from '@/constants/notification.constants';
import type { UserDeviceTokenDocument } from '@/models/UserDeviceToken';
import { deviceTokenRepository } from '@/repositories/deviceToken.repository';
import { logger } from '@/utils/logger';

/**
 * Firebase Cloud Messaging, from the server only.
 *
 * ## Why push exists alongside Socket.IO
 *
 * They answer different questions and neither replaces the other. A socket
 * event reaches a device with a live connection, which is the right tool for
 * everything that happens *while somebody is playing* — a stroke, a guess, a
 * score. A push reaches a device whose app is backgrounded or dead, which is
 * the only tool for anything with a deadline attached. The tournament check-in
 * is the second kind: the whole point is to reach the player who registered
 * and then put their phone away, and no amount of socket work can do that,
 * because there is no socket.
 *
 * So the check-in flow sends both. The socket event updates the screen of
 * anybody already looking at it; the push reaches everybody else.
 *
 * ## The delivery shape, and why every message carries `notification`
 *
 * A data-only message is handed to the app to display, which means it is not
 * displayed at all when the app has been terminated — exactly the case this
 * feature exists for. A message carrying a `notification` block is rendered by
 * the system itself whether the app is backgrounded, terminated, or has never
 * been opened since boot, and the `data` block still arrives for the tap
 * handler. That is why both are always set.
 *
 * ## What is never sent
 *
 * No room code, no token, no score, nothing a client could treat as
 * authoritative. The payload is `type`, `tournamentId` and `route` — enough to
 * open the right screen, which then re-reads the real state over REST. A push
 * is a pointer, on the same argument as the notification row it accompanies.
 */

/** What a caller wants delivered. */
export interface PushPayload {
  title: string;
  body: string;
  /**
   * The tap payload. Values must be strings — FCM rejects anything else in a
   * data block — so callers pass strings and this does not stringify for them,
   * which would hide a number that was meant to be an id.
   */
  data: Record<string, string>;
  /** Overrides the default high-importance channel. Rarely wanted. */
  androidChannelId?: string;
}

/** What one send attempt did. */
export interface PushResult {
  /** Device tokens that FCM accepted. */
  sent: number;
  /** Device tokens FCM rejected for any reason. */
  failed: number;
  /** Rejected tokens that were dead, and have been deactivated. */
  pruned: number;
  /** True when there was nothing to send to. */
  noRecipients: boolean;
  /**
   * True when nothing was even attempted, because no service account is
   * configured.
   *
   * Told apart from [noRecipients] deliberately. Both used to report the same
   * `noRecipients: true`, which pointed every investigation at the wrong half
   * of the system: "this player has never registered a handset" is a client
   * problem, and "this deployment cannot send at all" is a missing environment
   * variable, and the log line whose whole job is to answer "why did nothing
   * arrive" could not distinguish them.
   */
  notConfigured: boolean;
}

const EMPTY: PushResult = {
  sent: 0,
  failed: 0,
  pruned: 0,
  noRecipients: true,
  notConfigured: false,
};

/**
 * The FCM error codes that mean "this device is gone for good".
 *
 * Everything else — a quota error, a 5xx, a timeout — is transient and the
 * token is left alone. Getting this set wrong in the permissive direction
 * costs a wasted send; getting it wrong in the other direction silently
 * unsubscribes a working device, which is why only these two are listed and
 * why neither is inferred from a message string.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Whether an error is worth one more attempt. */
function isRetryable(code: string | undefined): boolean {
  if (!code) return false;
  return (
    code === 'messaging/server-unavailable' ||
    code === 'messaging/internal-error' ||
    code === 'messaging/unknown-error' ||
    code === 'messaging/quota-exceeded'
  );
}

/** Builds the Android and APNs blocks that make a push interrupt. */
function deliveryOptions(payload: PushPayload): Pick<Message, 'android' | 'apns'> {
  return {
    android: {
      // `high` is what wakes a dozing device. The default would hold the
      // message until the next maintenance window, which for a check-in with a
      // two-minute deadline is the same as not sending it.
      priority: 'high',
      notification: {
        channelId: payload.androidChannelId ?? PUSH_ANDROID_CHANNEL.id,
        // The monochrome status-bar icon. Android tints it; a full-colour
        // launcher icon here renders as a white blob on API 21+.
        icon: 'ic_stat_notification',
        defaultSound: true,
      },
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default', contentAvailable: true } },
    },
  };
}

export class PushService {
  /** Whether a service account is configured. */
  get isConfigured(): boolean {
    return isFirebaseConfigured();
  }

  /**
   * Sends to one device token.
   *
   * The narrow path, used by diagnostics and by anything that already holds a
   * token. Prefer [sendToUser], which finds the tokens and prunes the dead
   * ones for you.
   */
  async sendToDeviceToken(token: string, payload: PushPayload): Promise<PushResult> {
    const messaging = getPushMessaging();
    if (!messaging) return { ...EMPTY, notConfigured: true };

    const message: Message = {
      token,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
      ...deliveryOptions(payload),
    };

    try {
      await this.withOneRetry(() => messaging.send(message));
      await deviceTokenRepository.touch([token]);
      return { sent: 1, failed: 0, pruned: 0, noRecipients: false, notConfigured: false };
    } catch (error) {
      const code = (error as { code?: string }).code;
      const pruned = DEAD_TOKEN_CODES.has(code ?? '')
        ? await deviceTokenRepository.deactivateTokens([token])
        : 0;

      logger.warn('[FCM] send to device failed', {
        maskedToken: maskToken(token),
        code: code ?? 'unknown',
        pruned,
      });

      return { sent: 0, failed: 1, pruned, noRecipients: false, notConfigured: false };
    }
  }

  /** Sends to every live device one person has. */
  async sendToUser(userId: string, payload: PushPayload): Promise<PushResult> {
    return this.sendToUsers([userId], payload);
  }

  /**
   * Sends to every live device of every person named.
   *
   * One query for the tokens and one multicast per batch, rather than a send
   * per recipient. That matters at sixteen players and would matter a great
   * deal more at a tournament-wide announcement; it also means the dead-token
   * pruning below happens once with the whole list rather than row by row.
   */
  async sendToUsers(userIds: string[], payload: PushPayload): Promise<PushResult> {
    const recipients = [...new Set(userIds)].filter(Boolean);
    if (recipients.length === 0) return { ...EMPTY };

    const messaging = getPushMessaging();
    if (!messaging) {
      logger.warn('[FCM] push requested but firebase is not configured', {
        recipients: recipients.length,
        type: payload.data.type ?? 'unknown',
        hint:
          'set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY ' +
          'on this deployment; until then every push is a logged no-op',
      });
      return { ...EMPTY, notConfigured: true };
    }

    const devices = await deviceTokenRepository.activeForUsers(recipients);
    const tokens = [...new Set(devices.map((row: UserDeviceTokenDocument) => row.token))];

    if (tokens.length === 0) {
      logger.info('[FCM] no active device tokens for recipients', {
        recipients: recipients.length,
        type: payload.data.type ?? 'unknown',
      });
      return { ...EMPTY };
    }

    const result: PushResult = { sent: 0, failed: 0, pruned: 0, noRecipients: false, notConfigured: false };
    const dead: string[] = [];
    const delivered: string[] = [];

    // FCM's multicast ceiling is 500 tokens per call.
    for (let start = 0; start < tokens.length; start += 500) {
      const batch = tokens.slice(start, start + 500);

      const message: MulticastMessage = {
        tokens: batch,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        ...deliveryOptions(payload),
      };

      try {
        const response = await this.withOneRetry(() =>
          messaging.sendEachForMulticast(message),
        );

        response.responses.forEach((one, index) => {
          if (one.success) {
            result.sent += 1;
            delivered.push(batch[index]!);
            return;
          }

          result.failed += 1;
          const code = one.error?.code;
          if (DEAD_TOKEN_CODES.has(code ?? '')) dead.push(batch[index]!);
          else {
            logger.warn('[FCM] delivery rejected', {
              maskedToken: maskToken(batch[index] ?? ''),
              code: code ?? 'unknown',
            });
          }
        });
      } catch (error) {
        // The whole batch failed — a network problem or a bad credential, not
        // a per-token rejection. Counted as failures so the caller's log is
        // honest, and no token is pruned: nothing here says any of them is
        // dead.
        result.failed += batch.length;
        logger.exception('[FCM] multicast failed', error, { batch: batch.length });
      }
    }

    if (dead.length > 0) {
      result.pruned = await deviceTokenRepository.deactivateTokens(dead);
    }
    if (delivered.length > 0) {
      await deviceTokenRepository.touch(delivered);
    }

    return result;
  }

  /**
   * Runs [attempt] once more if the first failure was transient.
   *
   * One retry, not a loop with a backoff. A push is time-sensitive — the
   * check-in window is minutes — so the useful choice is between "now" and
   * "not at all", and a second attempt a second later covers the one failure
   * that actually recurs at this scale: a momentary 503 from FCM. A longer
   * ladder would hold the scheduler's lock while it waited.
   *
   * Only codes in [isRetryable] are retried, so a rejected token is never sent
   * twice and a player never sees two notifications.
   */
  private async withOneRetry<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!isRetryable(code)) throw error;

      logger.warn('[FCM] transient failure, retrying once', { code });
      await new Promise((resolve) => setTimeout(resolve, 750));
      return attempt();
    }
  }
}

export const pushService = new PushService();
