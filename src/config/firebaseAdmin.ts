import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

import { env } from '@/config/env';
import { logger } from '@/utils/logger';

/**
 * The Firebase Admin app, created at most once.
 *
 * ## Why this is lazy rather than initialised at boot
 *
 * Because push is optional. A deployment with no service account — every dev
 * machine, the test run, the load-test stack — must boot, serve, and run the
 * tournament scheduler exactly as it does today. Initialising at import time
 * would make a missing credential a startup failure for a feature that the
 * rest of the system does not depend on.
 *
 * It is also a hot-reload concern. `next dev` re-evaluates modules, and the
 * Admin SDK throws on a second `initializeApp` for the same name — the same
 * reason `models/*.ts` all check `models.X` before calling `model()`. The
 * `getApps()` check below is that guard.
 *
 * ## Why the credential is never logged
 *
 * `env.firebase.privateKey` is a signing key: anybody holding it can send a
 * notification to any device in the project and read the project's messaging
 * quota. Nothing here prints it, and the one diagnostic that mentions the
 * service account prints only the client email, which is not a secret.
 */

/** The app name, so this never collides with a default app somebody else made. */
const APP_NAME = 'scribble-guess-push';

let cached: Messaging | null = null;
let failed = false;

/** Whether a service account was supplied at all. */
export function isFirebaseConfigured(): boolean {
  return env.firebase.configured;
}

/**
 * The messaging client, or null when push is not available.
 *
 * Null is a normal answer, not an error: it means either no credential was
 * configured or the one that was could not be used. Callers treat both the
 * same way — log it and carry on — because a tournament must open check-in
 * whether or not anybody can be told about it.
 *
 * A failure is latched. Retrying a malformed private key on every send would
 * be one expensive throw per recipient, and the fix is a redeploy rather than
 * a retry.
 */
export function getPushMessaging(): Messaging | null {
  if (cached) return cached;
  if (failed || !env.firebase.configured) return null;

  try {
    const app: App =
      getApps().find((candidate) => candidate.name === APP_NAME) ??
      initializeApp(
        {
          credential: cert({
            projectId: env.firebase.projectId,
            clientEmail: env.firebase.clientEmail,
            // Already converted from literal `\n` sequences in `env.ts`.
            privateKey: env.firebase.privateKey,
          }),
          projectId: env.firebase.projectId,
        },
        APP_NAME,
      );

    cached = getMessaging(app);

    logger.info('[FCM] firebase admin ready', {
      projectId: env.firebase.projectId,
      clientEmail: env.firebase.clientEmail,
    });

    return cached;
  } catch (error) {
    failed = true;
    // Almost always a private key whose newlines did not survive the secret
    // store. Said plainly, because the symptom otherwise is "notifications
    // silently stopped".
    logger.exception('[FCM] firebase admin initialisation failed', error, {
      projectId: env.firebase.projectId,
    });
    return null;
  }
}

/** Drops the cached client. Tests only. */
export function resetPushMessagingForTests(): void {
  cached = null;
  failed = false;
}

/**
 * Hides all but the last few characters of a registration token.
 *
 * A token is a capability: whoever holds it can deliver a notification to that
 * handset. Logs are read by more people than the database is, so the tail is
 * all that is ever printed — enough to tell two devices apart in a trace, and
 * not enough to send to either. `logger.redact` also blanks any field called
 * `token`; this exists so the *masked* value can be logged under a name that
 * survives redaction.
 */
export function maskToken(token: string): string {
  if (token.length <= 8) return '***';
  return `***${token.slice(-6)}`;
}
