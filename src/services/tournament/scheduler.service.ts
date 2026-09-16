import { randomUUID } from 'node:crypto';

import { connectToDatabase } from '@/config/database';
import { env } from '@/config/env';
import {
  AUTO_TOURNAMENT_STATUS,
  LIVE_STATUSES,
  SCHEDULER_TIMING,
} from '@/constants/autoTournament.constants';
import { AutoTournament, type AutoTournamentDocument } from '@/models/AutoTournament';
import { TournamentSchedulerLock } from '@/models/TournamentBotProfile';
import { botProfileService } from '@/services/bot/botProfile.service';
import { tournamentDailyPlanner } from '@/services/tournament/dailyPlanner.service';
import { tournamentLifecycleService } from '@/services/tournament/lifecycle.service';
import { tournamentMatchService } from '@/services/tournament/match.service';
import { logger } from '@/utils/logger';

/**
 * The organiser's clock.
 *
 * ## What a tick does
 *
 * Exactly one pass over the world, in an order chosen so that work created by
 * one step is picked up by a later one in the same tick where that is safe:
 *
 * 1. Publish any of today's or tomorrow's three tournaments that do not exist
 *    yet, so the day rolls over into a schedule rather than an empty screen.
 * 2. Open registration on anything `UPCOMING` whose window has arrived —
 *    including what step 1 just created, which matters on the first boot of a
 *    deployment where a slot's window is already open.
 * 3. Advance every unfinished tournament past whichever of its deadlines has
 *    passed — the registration window, the check-in window, or, on a
 *    deployment running without check-in, the bot fill and the countdown.
 * 4. Decide the matches whose entry deadline lapsed.
 * 5. Move every running tournament past a finished round.
 *
 * ## What it does not do
 *
 * Create a replacement for anything. A tournament that completes or is
 * cancelled leaves nothing to fill: its slot is a date and a time of day, both
 * of which are now in the past. The next tournament is the next one on the
 * schedule, which step 1 published hours ago.
 *
 * ## Why one lock and not one per tournament
 *
 * A tick is short — a handful of indexed queries and, occasionally, a bracket
 * insert — so contention costs nothing, and a single lock makes the ordering
 * above actually hold. Per-tournament locks would let step 1 in one process
 * interleave with step 5 in another, which is harder to reason about for no
 * gain at three tournaments.
 *
 * The isolation the product needs is between *tournaments*, not between
 * processes, and that comes from step 3 catching per tournament: slot 1 can
 * throw without slot 2 or 3 noticing.
 *
 * ## Two ways to drive it
 *
 * A timer in this process (`start`), and an HTTP endpoint for an external
 * cron. Both go through `runOnce`, both take the same lock, and running both
 * at once is safe — which is deliberate, because a deployment migrating from
 * one to the other should not have to coordinate the switch.
 */

/** The identity this process holds the lock under. Only ever for logging. */
const OWNER = `${process.pid}:${randomUUID().slice(0, 8)}`;

/** What one tick did, for the endpoint's response and for the logs. */
export interface SchedulerTickResult {
  ran: boolean;
  /** Set when the lock was held by somebody else. */
  skippedReason?: string;
  created: number;
  opened: number;
  advanced: number;
  matchesDecided: number;
  errors: number;
  durationMs: number;
}

let loop: NodeJS.Timeout | null = null;

export class TournamentScheduler {
  /**
   * Starts the in-process loop.
   *
   * Idempotent, and a no-op when the deployment has said it is driven by an
   * external cron. The first tick runs immediately rather than after one
   * interval, so a fresh deployment has its three tournaments within a second
   * of booting instead of showing an empty listing for fifteen.
   */
  start(): void {
    if (loop) return;
    if (!env.tournament.schedulerEnabled) {
      logger.info('tournament scheduler loop disabled; expecting an external cron');
      return;
    }

    void this.runOnce().catch((error: unknown) => {
      logger.exception('the first tournament scheduler tick failed', error);
    });

    loop = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        logger.exception('a tournament scheduler tick failed', error);
      });
    }, SCHEDULER_TIMING.tickMs);

    // A server whose only remaining work is the organiser's next tick should
    // still be able to shut down.
    loop.unref?.();

    logger.info('tournament scheduler started', {
      tickMs: SCHEDULER_TIMING.tickMs,
      perDay: tournamentDailyPlanner.perDay,
      timeZone: env.tournament.timeZone,
      owner: OWNER,
    });
  }

  /** Stops the loop. Used by shutdown and by tests. */
  stop(): void {
    if (!loop) return;
    clearInterval(loop);
    loop = null;
  }

  /**
   * One pass, under the lock.
   *
   * Returns a result rather than throwing for the ordinary "somebody else is
   * running" case, because that is not a failure — it is the lock working.
   */
  async runOnce(): Promise<SchedulerTickResult> {
    const startedAt = Date.now();

    await connectToDatabase();

    const acquired = await this.acquireLock();
    if (!acquired) {
      return {
        ran: false,
        skippedReason: 'another scheduler holds the lock',
        created: 0,
        opened: 0,
        advanced: 0,
        matchesDecided: 0,
        errors: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const result: SchedulerTickResult = {
      ran: true,
      created: 0,
      opened: 0,
      advanced: 0,
      matchesDecided: 0,
      errors: 0,
      durationMs: 0,
    };

    try {
      // The bot roster has to exist before anything can be filled with one.
      // Cached after the first call, so this is free on every later tick.
      await botProfileService.ensureSeeded();

      result.created = (await tournamentDailyPlanner.ensureScheduled()).length;
      result.opened = await this.openNewTournaments(result);
      result.advanced = await this.advanceDeadlines(result);
      result.matchesDecided = await tournamentMatchService.sweepEntryDeadlines();
      await this.progressRunning(result);
    } finally {
      result.durationMs = Date.now() - startedAt;
      await this.releaseLock();
    }

    if (result.created > 0 || result.advanced > 0 || result.matchesDecided > 0) {
      logger.info('tournament scheduler tick', { ...result });
    } else {
      logger.debug('tournament scheduler tick', { ...result });
    }

    return result;
  }

  // ------------------------------------------------------------------ steps

  /**
   * Opens registration on every tournament whose window has arrived.
   *
   * ## Why the filter is on the clock and not just the status
   *
   * Because most `UPCOMING` tournaments are not due. Tomorrow evening's exists
   * from today and must sit dark until ninety minutes before it starts — the
   * rolling system opened everything it found, because everything it found had
   * been created a moment earlier for that purpose. Opening on sight here
   * would put all of tomorrow's tournaments into registration tonight.
   */
  private async openNewTournaments(result: SchedulerTickResult): Promise<number> {
    const now = new Date();

    const upcoming = await AutoTournament.find({
      isAutomatic: true,
      status: AUTO_TOURNAMENT_STATUS.upcoming,
      registrationOpenAt: { $lte: now },
      // And not already over. A scheduler that was down all morning should
      // not announce "registration is open" for a tournament whose window
      // closed two hours ago; the sweep below writes that one off instead.
      registrationCloseAt: { $gt: now },
    })
      .lean()
      .exec();

    let opened = 0;

    for (const row of upcoming) {
      const ok = await tournamentLifecycleService
        .openRegistration(row as AutoTournamentDocument)
        .catch((error: unknown) => {
          result.errors += 1;
          logger.exception('opening registration failed', error, {
            tournamentId: String(row._id),
          });
          return false;
        });
      if (ok) opened += 1;
    }

    return opened;
  }

  /**
   * Advances every tournament whose deadline has passed.
   *
   * ## Why the whole set is loaded rather than several targeted queries
   *
   * There are at most six — today's three and tomorrow's. Loading the
   * unfinished ones and branching in memory is one indexed query instead of
   * four, and it is what lets the catch sit around each tournament rather than
   * around each query, which is the isolation the product asked for: the
   * morning tournament failing must not stop the afternoon one opening.
   */
  private async advanceDeadlines(result: SchedulerTickResult): Promise<number> {
    const now = new Date();

    const live = await AutoTournament.find({
      isAutomatic: true,
      status: { $in: [...LIVE_STATUSES] },
    })
      .lean()
      .exec();

    let advanced = 0;

    for (const row of live) {
      const tournament = row as AutoTournamentDocument;

      try {
        // A scheduled tournament that was never opened, whose start time has
        // now passed. Only reachable after an outage that spanned its whole
        // window — but a row nothing will ever advance is worse than a
        // cancelled one, because the listing would show it as upcoming for
        // ever.
        if (tournament.status === AUTO_TOURNAMENT_STATUS.upcoming) {
          if (tournament.startAt <= now) {
            if (
              await tournamentLifecycleService.cancel(
                tournament,
                'This tournament could not be started.',
              )
            ) {
              advanced += 1;
            }
          }
          continue;
        }

        if (tournament.status === AUTO_TOURNAMENT_STATUS.registration) {
          // Ordered by how final each door is. The window closing is a hard
          // deadline and wins over everything; a full roster beats the fill
          // timer because it means no bot is needed at all.
          if (tournament.registrationCloseAt <= now) {
            if (await tournamentLifecycleService.closeRegistration(tournament)) advanced += 1;
            continue;
          }

          // Both early doors belong to the fast-start path. With check-in
          // switched back on, a tournament leaves `REGISTRATION` only at its
          // deadline and only into `CHECK_IN` — taking either of these would
          // start the bracket without ever asking the question the flag exists
          // to ask.
          if (env.tournament.checkInEnabled) continue;

          if (await tournamentLifecycleService.startEarlyIfFull(tournament)) {
            advanced += 1;
            continue;
          }

          // A row written before `botFillAt` existed has none. Treated as due,
          // because such a row has by definition been waiting through a
          // deploy and the fast path is the whole point.
          const fillDue = !tournament.botFillAt || tournament.botFillAt <= now;
          if (fillDue && (await tournamentLifecycleService.fillAndStart(tournament))) {
            advanced += 1;
          }
          continue;
        }

        if (tournament.status === AUTO_TOURNAMENT_STATUS.starting) {
          // A countdown with no end is a tournament that reached this state
          // before the field existed, or a write that half-landed. Starting it
          // is the safe reading: the roster is already sealed, and the failure
          // to avoid is a tournament that counts down for ever.
          const due = !tournament.countdownEndsAt || tournament.countdownEndsAt <= now;
          if (due && (await tournamentLifecycleService.startCountedDownTournament(tournament))) {
            advanced += 1;
          }
          continue;
        }

        if (
          tournament.status === AUTO_TOURNAMENT_STATUS.checkIn &&
          tournament.checkInCloseAt <= now
        ) {
          if (await tournamentLifecycleService.closeCheckIn(tournament)) advanced += 1;
        }
      } catch (error) {
        // Per tournament, deliberately. This is the isolation requirement,
        // and it is one `try` rather than a convention every future step has
        // to remember.
        result.errors += 1;
        logger.exception('advancing a tournament failed', error, {
          tournamentId: String(tournament._id),
          tournamentDate: tournament.tournamentDate,
          dailySlot: tournament.dailySlot,
          status: tournament.status,
        });
      }
    }

    return advanced;
  }

  /** Moves running tournaments past finished rounds. */
  private async progressRunning(result: SchedulerTickResult): Promise<void> {
    const running = await AutoTournament.find({
      isAutomatic: true,
      status: AUTO_TOURNAMENT_STATUS.running,
    })
      .select({ _id: 1 })
      .lean()
      .exec();

    for (const row of running) {
      await tournamentMatchService
        .progressRounds(String(row._id))
        .catch((error: unknown) => {
          result.errors += 1;
          logger.exception('progressing a tournament failed', error, {
            tournamentId: String(row._id),
          });
        });
    }
  }

  // ------------------------------------------------------------------- lock

  /**
   * Takes the lock, or reports that somebody else has it.
   *
   * One `findOneAndUpdate` with an upsert, filtered on the lock being unheld
   * *or expired*. Mongo applies that atomically, so of two processes trying at
   * the same instant exactly one comes back with a document. There is no
   * read-then-write and therefore no window.
   *
   * The upsert can itself collide — two processes inserting the first-ever
   * lock row — and that duplicate-key error is the losing process, reported as
   * "somebody else has it" rather than raised.
   */
  private async acquireLock(): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SCHEDULER_TIMING.lockLeaseMs);

    try {
      const taken = await TournamentSchedulerLock.findOneAndUpdate(
        {
          key: SCHEDULER_TIMING.lockKey,
          // Either nobody holds it, or whoever did has stopped renewing it.
          // The second clause is what recovers from a process that died
          // mid-tick: without it, one crash would stall every tournament for
          // ever.
          $or: [{ expiresAt: { $lte: now } }, { expiresAt: null }],
        },
        { $set: { owner: OWNER, expiresAt, acquiredAt: now } },
        { upsert: true, new: true },
      ).exec();

      return taken !== null;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  /**
   * Releases the lock, if this process still holds it.
   *
   * Filtered on `owner` so a tick that overran its lease — and whose lock has
   * since been taken by somebody else — cannot release the *new* holder's
   * lock out from under them.
   *
   * Best effort. A release that fails costs one lease of delay and nothing
   * else, which is exactly why the lease exists.
   */
  private async releaseLock(): Promise<void> {
    await TournamentSchedulerLock.updateOne(
      { key: SCHEDULER_TIMING.lockKey, owner: OWNER },
      { $set: { expiresAt: new Date(0) } },
    )
      .exec()
      .catch((error: unknown) => {
        logger.exception('releasing the tournament scheduler lock failed', error);
      });
  }
}

export const tournamentScheduler = new TournamentScheduler();
