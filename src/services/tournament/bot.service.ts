import { botProfileService } from '@/services/bot/botProfile.service';
import {
  tournamentScheduler,
  type SchedulerTickResult,
} from '@/services/tournament/scheduler.service';
import { tournamentSlotManager } from '@/services/tournament/slotManager.service';
import { logger } from '@/utils/logger';

/**
 * The organiser.
 *
 * ## What this is
 *
 * The thing that stands in for the person who would otherwise be creating
 * tournaments, watching the clock, chasing people to check in, drawing the
 * bracket, opening the rooms and announcing the winner. It has no opinions of
 * its own — every decision is made by the services beneath it — but it is the
 * one name that means "the tournaments run themselves", and it is what
 * `server.ts` and `socket-server.ts` start.
 *
 * ## Why it is a thin facade and not where the logic lives
 *
 * Because the logic divides cleanly along lines that have nothing to do with
 * "being a bot": keeping three slots filled, walking one tournament through
 * its states, drawing a bracket, deciding when a match may start. Each of
 * those is testable on its own and none of them needs to know that a bot is
 * what called it. Collapsing them into one class would produce a file nobody
 * could hold in their head, and the first thing that would get lost in it is
 * exactly which write is the one that makes a transition idempotent.
 *
 * ## What it deliberately cannot do
 *
 * Play. The organiser creates and runs tournaments; the *players* that fill
 * short rosters are a different subsystem entirely (`services/bot/`), with a
 * different lifetime, its own worker ceiling, and no knowledge of brackets.
 * The two share only the profile roster — one to decide who to seat, the other
 * to decide who is drawing.
 */

export class TournamentBot {
  /**
   * Wakes the organiser up.
   *
   * Safe to call twice: the scheduler's own `start` is idempotent, and the
   * roster seeding is an upsert. Called from both process entry points, only
   * one of which runs in any given deployment.
   */
  async start(): Promise<void> {
    // Before the scheduler, so the very first tick has a roster to fill from
    // rather than discovering an empty one and cancelling a tournament that
    // three people had joined.
    await botProfileService.ensureSeeded().catch((error: unknown) => {
      logger.exception('seeding the bot roster failed', error);
      return [];
    });

    tournamentScheduler.start();

    logger.info('tournament organiser running', {
      slots: tournamentSlotManager.slotCount,
    });
  }

  /** Stops the loop. Used by shutdown and by tests. */
  stop(): void {
    tournamentScheduler.stop();
  }

  /**
   * Runs one pass by hand.
   *
   * This is what the internal endpoint calls, and what a test drives. It takes
   * the same lock the loop does, so an external cron and an in-process loop
   * can both be running without coordinating — which matters during a
   * migration from one to the other.
   */
  async tick(): Promise<SchedulerTickResult> {
    return tournamentScheduler.runOnce();
  }
}

export const tournamentBot = new TournamentBot();
