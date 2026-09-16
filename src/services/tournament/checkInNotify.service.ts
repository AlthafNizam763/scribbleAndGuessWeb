import {
  PLAYER_TYPE,
  REGISTRATION_STATUS,
} from '@/constants/autoTournament.constants';
import {
  CHECK_IN_PUSH_COPY,
  NOTIFICATION_LOG_STATUS,
  NOTIFICATION_TYPE,
  PUSH_NOTIFICATION_TYPE,
  notificationKeyFor,
  type NotificationLogStatusWire,
} from '@/constants/notification.constants';
import { TournamentRegistration } from '@/models/AutoTournament';
import { NotificationLog } from '@/models/NotificationLog';
import { notificationService } from '@/services/notification.service';
import { pushService, type PushResult } from '@/services/push.service';
import { announceToPlayer } from '@/services/tournament/notify';
import { logger } from '@/utils/logger';

/**
 * Telling the right people that check-in has opened.
 *
 * ## The bug this exists to fix
 *
 * `openCheckIn` used to announce the transition with one Socket.IO broadcast
 * to the tournament lobby channel and nothing else. That reaches a client with
 * a live connection that has *already opened the tournament screen* — and the
 * person the notification is for is, by construction, none of those things.
 * They registered, closed the app, and put the phone in their pocket. There
 * was no socket, no inbox row, and no push, so nothing happened at all.
 *
 * Three deliveries now go out, and they are not alternatives to each other:
 *
 * 1. **A push**, which the operating system renders whether the app is open,
 *    backgrounded, terminated or has never been launched since boot. This is
 *    the only one that reaches a closed app, and it is the point of the whole
 *    change.
 * 2. **An inbox row**, so somebody who had notifications turned off, or who
 *    opens the app before the push lands, still finds out. Written through
 *    `notificationService`, which is the one writer to `notifications`.
 * 3. **A socket event**, addressed to the player rather than to the lobby
 *    channel, so a client already on the screen updates without polling.
 *
 * ## Why the fan-out is addressed and never broadcast
 *
 * Three tournaments run at once and a player is in at most one of them. The
 * recipient list below is built from `TournamentRegistration` filtered by
 * `tournamentId`, so slot 2's check-in is delivered to slot 2's entrants and
 * to nobody else. A broadcast would be both wrong and, on a phone at 2am,
 * genuinely unpleasant.
 *
 * ## Why a duplicate is impossible rather than unlikely
 *
 * The scheduler is deliberately safe to run twice — an in-process loop and an
 * external cron may both tick, and either can be retried after a crash. The
 * status transition that calls this is a conditional write and happens once,
 * but "happens once" is a property of the *write*, not of this function: a
 * process that died between moving the status and sending would otherwise be
 * retried by a peer that found the tournament already in `CHECK_IN`.
 *
 * So the claim is a row in `notificationLogs` with a unique index on
 * `userId + tournamentId + type`, inserted *before* anything is sent. A
 * duplicate key means somebody else already owns that recipient and this
 * process skips them. There is no read-then-write and therefore no window.
 *
 * The consequence is at-most-once rather than exactly-once: a crash after the
 * claim and before the send loses that notification. That is the right trade
 * here — a player who missed a nudge still has the countdown on the screen and
 * the inbox row, while a player woken twice at 2am has been failed by the
 * system in a way they will remember.
 */

/** What one tournament's fan-out did. */
export interface CheckInNotifyResult {
  tournamentId: string;
  /** Registered humans who were eligible to be told. */
  eligibleUsers: number;
  /** Of those, the ones this process claimed (the rest were already sent). */
  claimed: number;
  /** Active device tokens found across the claimed recipients. */
  tokensFound: number;
  notificationsSent: number;
  notificationsFailed: number;
  /** Claimed recipients with no registered device to push to. */
  notificationsSkipped: number;
}

/**
 * The registration statuses that still mean "in this tournament".
 *
 * Everything the brief asks to exclude is expressed by its absence:
 * `WITHDRAWN` is a cancelled registration, `NO_SHOW` is somebody already
 * written off, and `ELIMINATED` is how a cancelled tournament and a knocked-
 * out player both end up — so a removed player cannot be reached by this.
 * `CHECKED_IN` is included because a player who confirmed early has not done
 * anything wrong; the push is still the fastest way to tell them the window
 * they were waiting for is open.
 */
const ELIGIBLE_STATUSES = [
  REGISTRATION_STATUS.registered,
  REGISTRATION_STATUS.checkedIn,
] as const;

export class TournamentCheckInNotifier {
  /**
   * Announces check-in for one tournament.
   *
   * Never throws. It is called from inside a status transition that has
   * already committed, and a notification failure must not roll that back or
   * stop the scheduler advancing the other two slots — the same argument
   * `notificationService.notify` makes one layer down.
   */
  async announceCheckIn(tournamentId: string, tournamentName: string): Promise<CheckInNotifyResult> {
    const result: CheckInNotifyResult = {
      tournamentId,
      eligibleUsers: 0,
      claimed: 0,
      tokensFound: 0,
      notificationsSent: 0,
      notificationsFailed: 0,
      notificationsSkipped: 0,
    };

    try {
      const userIds = await this.eligibleUserIds(tournamentId);
      result.eligibleUsers = userIds.length;

      if (userIds.length === 0) {
        logger.info('[TOURNAMENT_NOTIFICATION] nobody to tell', { tournamentId });
        return result;
      }

      const claimed = await this.claim(tournamentId, userIds);
      result.claimed = claimed.length;

      if (claimed.length === 0) {
        // Every recipient was claimed by an earlier run. This is the duplicate
        // scheduler tick doing exactly what it should.
        logger.info('[TOURNAMENT_NOTIFICATION] already announced', {
          tournamentId,
          eligibleUsers: userIds.length,
        });
        return result;
      }

      // The inbox rows and the socket badge, for everybody at once. Written
      // before the push so a notification exists even if FCM is unreachable.
      await notificationService.notifyMany(claimed, {
        type: NOTIFICATION_TYPE.tournamentCheckInOpen,
        title: CHECK_IN_PUSH_COPY.title,
        body: CHECK_IN_PUSH_COPY.body,
        data: {
          type: PUSH_NOTIFICATION_TYPE.tournamentCheckInOpen,
          tournamentId,
          route: CHECK_IN_PUSH_COPY.route,
        },
      });

      // The addressed socket event, for a client already on the screen.
      for (const userId of claimed) {
        announceToPlayer(userId, 'checkInOpened', {
          tournamentId,
          name: tournamentName,
        });
      }

      await this.push(tournamentId, claimed, result);

      logger.info('[TOURNAMENT_NOTIFICATION] check-in fan-out complete', {
        tournamentId,
        eligibleUsers: result.eligibleUsers,
        tokensFound: result.tokensFound,
        notificationsSent: result.notificationsSent,
        notificationsFailed: result.notificationsFailed,
        notificationsSkipped: result.notificationsSkipped,
      });

      return result;
    } catch (error) {
      logger.exception('[TOURNAMENT_NOTIFICATION] check-in fan-out failed', error, {
        tournamentId,
      });
      return result;
    }
  }

  /**
   * The people who should be told.
   *
   * Humans only — a bot has no phone — and only rows still holding a seat. The
   * query is filtered by `tournamentId` first, which is both the index prefix
   * and the reason three simultaneous tournaments cannot leak into each
   * other's notifications.
   */
  private async eligibleUserIds(tournamentId: string): Promise<string[]> {
    const rows = await TournamentRegistration.find({
      tournamentId,
      playerType: PLAYER_TYPE.human,
      status: { $in: [...ELIGIBLE_STATUSES] },
      userId: { $ne: null },
    })
      .select({ userId: 1 })
      .lean()
      .exec();

    const ids = rows
      .map((row) => (row.userId ? String(row.userId) : ''))
      .filter((id) => id.length > 0);

    // A player with two registration rows in one tournament should not be told
    // twice. The unique index on the collection makes that impossible today;
    // this costs nothing and does not depend on it staying that way.
    return [...new Set(ids)];
  }

  /**
   * Takes the send claim for each recipient, returning the ones won.
   *
   * `insertMany` with `ordered: false` so one duplicate does not abandon the
   * rest of the batch: the write continues past each collision and reports
   * them together. Mongo's own unique index is the arbiter, so two processes
   * arriving on the same millisecond split the recipients between them rather
   * than both claiming all of them.
   *
   * Rows land as `SKIPPED` and are promoted to `SENT` or `FAILED` once the
   * send has an answer. A process that dies in between leaves `SKIPPED`, which
   * is both an accurate description of what the recipient got and a claim that
   * stops a retry sending a second copy.
   */
  private async claim(tournamentId: string, userIds: string[]): Promise<string[]> {
    const docs = userIds.map((userId) => ({
      userId,
      tournamentId,
      type: PUSH_NOTIFICATION_TYPE.tournamentCheckInOpen,
      notificationKey: notificationKeyFor(
        PUSH_NOTIFICATION_TYPE.tournamentCheckInOpen,
        tournamentId,
        userId,
      ),
      status: NOTIFICATION_LOG_STATUS.skipped,
      sentAt: null,
    }));

    try {
      const inserted = await NotificationLog.insertMany(docs, { ordered: false });
      return inserted.map((row) => String(row.userId));
    } catch (error) {
      // A partial success. `insertMany` throws on the duplicates but has
      // already written the rest, and the driver reports which failed — so the
      // claim is whatever did not collide.
      const failedIndexes = new Set(
        ((error as { writeErrors?: { index: number }[] }).writeErrors ?? []).map(
          (write) => write.index,
        ),
      );

      // No writeErrors at all means this was not a duplicate-key failure but
      // something else — a dropped connection, say. Claiming nothing is the
      // safe reading: the next tick retries, and at worst the announcement is
      // one tick late.
      if (failedIndexes.size === 0) {
        logger.exception('[TOURNAMENT_NOTIFICATION] claim failed', error, { tournamentId });
        return [];
      }

      return userIds.filter((_, index) => !failedIndexes.has(index));
    }
  }

  /**
   * Pushes to each claimed recipient and records how it went.
   *
   * ## Why one send per person rather than one multicast for all
   *
   * Because the ledger is per person. A single multicast returns one row per
   * *token*, and mapping those back onto users to decide whose log says `SENT`
   * is bookkeeping that would have to stay correct as tokens are added and
   * pruned underneath it. A tournament has at most sixteen people in it, each
   * with a handful of devices, so the loop is a few indexed queries and a few
   * small multicasts — and every log row is then exactly true.
   *
   * `sendToUsers` is still the right call for a genuine fan-out where the
   * ledger is not per person; nothing today has one.
   */
  private async push(
    tournamentId: string,
    userIds: string[],
    result: CheckInNotifyResult,
  ): Promise<void> {
    if (!pushService.isConfigured) {
      // Not an error: a deployment without a service account is a supported
      // configuration. Said at warn level because on a *production* deployment
      // it is the reason the feature is not working.
      logger.warn('[FCM] check-in push skipped, firebase not configured', {
        tournamentId,
        recipients: userIds.length,
      });
      result.notificationsSkipped = userIds.length;
      return;
    }

    const payload = {
      title: CHECK_IN_PUSH_COPY.title,
      body: CHECK_IN_PUSH_COPY.body,
      data: {
        type: PUSH_NOTIFICATION_TYPE.tournamentCheckInOpen,
        tournamentId,
        route: CHECK_IN_PUSH_COPY.route,
      },
    };

    for (const userId of userIds) {
      const outcome: PushResult = await pushService.sendToUser(userId, payload);

      result.tokensFound += outcome.sent + outcome.failed;

      const status: NotificationLogStatusWire = outcome.noRecipients
        ? NOTIFICATION_LOG_STATUS.skipped
        : outcome.sent > 0
          ? NOTIFICATION_LOG_STATUS.sent
          : NOTIFICATION_LOG_STATUS.failed;

      if (status === NOTIFICATION_LOG_STATUS.sent) result.notificationsSent += 1;
      else if (status === NOTIFICATION_LOG_STATUS.failed) result.notificationsFailed += 1;
      else result.notificationsSkipped += 1;

      await this.recordOutcome(tournamentId, userId, status, outcome);
    }
  }

  /** Promotes one claim row to its real outcome. Best effort. */
  private async recordOutcome(
    tournamentId: string,
    userId: string,
    status: NotificationLogStatusWire,
    outcome: PushResult,
  ): Promise<void> {
    await NotificationLog.updateOne(
      {
        userId,
        tournamentId,
        type: PUSH_NOTIFICATION_TYPE.tournamentCheckInOpen,
      },
      {
        $set: {
          status,
          sentAt: status === NOTIFICATION_LOG_STATUS.sent ? new Date() : null,
          errorMessage:
            status === NOTIFICATION_LOG_STATUS.failed
              ? `${outcome.failed} device(s) rejected the message`
              : null,
        },
      },
    )
      .exec()
      .catch((error: unknown) => {
        // The claim is what prevents a duplicate, and it is already written.
        // Losing the outcome costs a wrong status in the ledger and nothing
        // else, so it must not fail the send that already happened.
        logger.exception('[TOURNAMENT_NOTIFICATION] recording an outcome failed', error, {
          tournamentId,
          userId,
        });
      });
  }
}

export const tournamentCheckInNotifier = new TournamentCheckInNotifier();
