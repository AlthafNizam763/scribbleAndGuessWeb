import { env } from '@/config/env';
import {
  AUTO_TOURNAMENT_FORMAT,
  AUTO_TOURNAMENT_STATUS,
  CREATED_BY_TYPE,
  DAILY_SLOTS,
  DAILY_SLOT_ORDER,
  TOURNAMENTS_PER_DAY,
  type BotDifficultyWire,
  type DailySlotWire,
} from '@/constants/autoTournament.constants';
import { AutoTournament, type AutoTournamentDocument } from '@/models/AutoTournament';
import { tournamentNameService } from '@/services/tournament/name.service';
import { announceTournament } from '@/services/tournament/notify';
import { addDays, todayKey, zonedInstant } from '@/utils/dayKey';
import { logger } from '@/utils/logger';

/**
 * Publishing the day's three tournaments.
 *
 * ## The rule, and where it actually lives
 *
 * "Exactly three tournaments per calendar day, never four." That is not
 * enforced here. It is enforced by the unique index on
 * `{tournamentDate, dailySlot, isAutomatic}`, and this class is written so
 * that it *cannot* be enforced anywhere else:
 *
 * - The loop below is over `DAILY_SLOTS`, a frozen list of three. There is no
 *   arithmetic that could produce a fourth slot and no input that could ask
 *   for one.
 * - Nothing counts existing tournaments to decide whether to create another.
 *   Counting is a read and creating is a write, and two schedulers can both
 *   read `2` before either writes.
 * - A duplicate insert is expected, caught, and logged as the ordinary event
 *   it is. Two instances starting at the same second both try to create this
 *   evening's tournament; one wins, the other gets `E11000` and moves on.
 *
 * So every one of the things the brief asks about — two cron requests
 * arriving together, a restart, a scheduler retry, several Render instances,
 * the same endpoint called repeatedly — is the same case, and it is handled by
 * the database refusing the second write rather than by anything noticing.
 *
 * ## What is not here
 *
 * Refilling. The rolling system this replaced created a replacement the moment
 * a tournament ended, which is why it needed a notion of a slot being free.
 * A daily slot is never free: `{2026-09-16, MORNING}` is that morning's
 * tournament whatever became of it, and when it finishes nothing takes its
 * place — the afternoon one was always going to happen anyway. A cancelled
 * tournament is not replaced either, for exactly the same reason.
 *
 * ## The timeline of one tournament
 *
 * Every deadline is measured *backwards* from the published start, because the
 * start is the part a player was told about:
 *
 * ```
 *   startAt − 90m ── registration opens ──► REGISTRATION
 *   startAt − 10m ── registration closes ─► CHECK_IN
 *   startAt       ── check-in closes ─────► bots fill, bracket, RUNNING
 * ```
 */

/** The instants one daily tournament runs to. */
export interface SlotSchedule {
  startAt: Date;
  registrationOpenAt: Date;
  registrationCloseAt: Date;
  checkInOpenAt: Date;
  checkInCloseAt: Date;
  botFillAt: Date;
}

export class TournamentDailyPlanner {
  /** How many tournaments exist on one day. Three, and not configurable. */
  get perDay(): number {
    return TOURNAMENTS_PER_DAY;
  }

  /** Today, in the configured zone. The system's definition of "today". */
  today(now: Date = new Date()): string {
    return todayKey(env.tournament.timeZone, now);
  }

  /**
   * The days that should currently have tournaments published.
   *
   * Today, plus however many days ahead the deployment prepares. Tomorrow's
   * three exist before midnight so the day rolls over into a published
   * schedule rather than into an empty screen — which is the whole of
   * "automatically prepare the next day's 3 tournaments".
   */
  daysToPrepare(now: Date = new Date()): string[] {
    const first = this.today(now);
    const days: string[] = [first];

    for (let ahead = 1; ahead <= env.tournament.prepareDaysAhead; ahead++) {
      days.push(addDays(first, ahead));
    }

    return days;
  }

  /**
   * When one slot on one day happens.
   *
   * Pure, and the single place these five instants are derived — the planner
   * writes them onto the row and the lifecycle service reads them back rather
   * than recomputing, so a tournament keeps the schedule it advertised even if
   * the deployment's configuration changes underneath it.
   */
  scheduleFor(tournamentDate: string, slot: DailySlotWire): SlotSchedule {
    const config = env.tournament;

    const startAt = zonedInstant(
      tournamentDate,
      config.slotMinutes[slot],
      config.timeZone,
    );

    const registrationOpenAt = new Date(startAt.getTime() - config.registrationLeadMs);
    const registrationCloseAt = new Date(startAt.getTime() - config.checkInLeadMs);

    return {
      startAt,
      registrationOpenAt,
      registrationCloseAt,
      // Check-in fills exactly the gap between registration closing and the
      // start. One window, described from both ends, so a client rendering
      // either never shows a gap the tournament is not actually in.
      checkInOpenAt: registrationCloseAt,
      checkInCloseAt: startAt,
      // The roster seals when check-in closes, and that is when the empty
      // seats are taken. With check-in off the fast-start path uses its own
      // delay instead — see `fillAndStart`.
      botFillAt: config.checkInEnabled
        ? startAt
        : new Date(registrationOpenAt.getTime() + config.botFillDelayMs),
    };
  }

  /**
   * Creates whatever is missing from every day that should be published.
   *
   * Returns what was actually created, which is not always what was attempted:
   * a slot another instance created between the scan and the insert produces a
   * duplicate-key error rather than a second tournament, and is simply absent
   * from the result.
   */
  async ensureScheduled(now: Date = new Date()): Promise<AutoTournamentDocument[]> {
    const created: AutoTournamentDocument[] = [];
    const today = this.today(now);

    for (const day of this.daysToPrepare(now)) {
      const made = await this.ensureDay(day, now).catch((error: unknown) => {
        // One day failing must not stop the others. A deployment missing
        // tomorrow's schedule is a degraded listing; one where a throw
        // abandoned the loop is missing today's as well.
        logger.exception('preparing a tournament day failed', error, { day });
        return [] as AutoTournamentDocument[];
      });

      // A client showing "what's on today" has no use for a tournament dated
      // tomorrow, and would re-read the day for nothing on each of the three.
      // One notice that a future day now exists is what a "what's next" strip
      // actually needs, and it is the only thing that separates these two
      // announcements.
      if (day !== today && made.length > 0) {
        announceTournament('nextScheduled', {
          tournamentDate: day,
          tournaments: made.map((row) => ({
            tournamentId: String(row._id),
            dailySlot: row.dailySlot,
            name: row.name,
            startAtMs: row.startAt.getTime(),
          })),
        });
      }

      created.push(...made);
    }

    return created;
  }

  /**
   * Creates whatever of one day's three tournaments does not exist yet.
   *
   * ## Why the existing rows are read first when the index is the real guard
   *
   * Two reasons, neither of them correctness. The names: the day's existing
   * tournaments are what a new one must not be called, and the pool is only
   * consulted once per day rather than once per slot. And the noise: without
   * it every tick of every instance would attempt three inserts and log three
   * duplicate-key errors for ever, which would bury the one that mattered.
   *
   * The read can be stale and that is fine. Staleness costs a rejected insert,
   * which is the case this is built around.
   */
  async ensureDay(
    tournamentDate: string,
    now: Date = new Date(),
  ): Promise<AutoTournamentDocument[]> {
    const existing = await AutoTournament.find({ tournamentDate })
      .select({ dailySlot: 1, name: 1 })
      .lean()
      .exec();

    const filled = new Set(existing.map((row) => row.dailySlot));
    const takenNames = existing.map((row) => row.name);

    const created: AutoTournamentDocument[] = [];

    for (const slot of DAILY_SLOTS) {
      if (filled.has(slot)) continue;

      const schedule = this.scheduleFor(tournamentDate, slot);

      // A tournament whose registration window has already closed is not
      // created.
      //
      // ## Why a missed slot is skipped rather than created late
      //
      // Because it could never be joined. A deployment that first boots at
      // nine in the evening would otherwise create that morning's tournament,
      // open nothing, find nobody in it and cancel it a tick later — three
      // states and a cancelled card, to say something that had already
      // happened. Skipping says the same thing by not saying it, and tomorrow
      // has all three.
      if (schedule.registrationCloseAt.getTime() <= now.getTime()) {
        logger.debug('skipping a daily tournament whose window has passed', {
          tournamentDate,
          dailySlot: slot,
        });
        continue;
      }

      const tournament = await this.createSlot(tournamentDate, slot, takenNames);
      if (!tournament) continue;

      created.push(tournament);
      takenNames.push(tournament.name);
    }

    return created;
  }

  /**
   * Creates one tournament, or returns null if it already existed.
   *
   * A duplicate is not an error here. It is the unique index doing the job it
   * is in the schema for, and the only correct response is to carry on.
   */
  async createSlot(
    tournamentDate: string,
    dailySlot: DailySlotWire,
    takenNames: readonly string[] = [],
  ): Promise<AutoTournamentDocument | null> {
    const config = env.tournament;
    const schedule = this.scheduleFor(tournamentDate, dailySlot);
    const name = tournamentNameService.nameFor(tournamentDate, dailySlot, takenNames);

    try {
      const created = await AutoTournament.create({
        tournamentDate,
        dailySlot,
        slotNumber: DAILY_SLOT_ORDER[dailySlot],

        name,
        description:
          'Free daily knockout tournament. Join, check in, and play your way to the final.',

        // Created dark and opened when its registration window arrives, which
        // for the evening tournament is hours later. That is the difference
        // from the rolling model, where "created" and "open" were the same
        // moment: a published schedule means a card that exists before it is
        // joinable.
        status: AUTO_TOURNAMENT_STATUS.upcoming,
        format: AUTO_TOURNAMENT_FORMAT,

        // The rules are copied onto the row, not read live. A tournament
        // already taking registrations keeps the size and bot policy it
        // advertised, even if the deployment is reconfigured mid-window.
        minPlayers: config.minPlayers,
        maxPlayers: config.maxPlayers,
        minHumanPlayers: config.minHumanPlayers,
        maxBots: config.maxBots,
        allowBots: config.allowBots,
        botDifficulty: config.botDifficulty as BotDifficultyWire,

        registrationOpenAt: schedule.registrationOpenAt,
        registrationCloseAt: schedule.registrationCloseAt,
        botFillAt: schedule.botFillAt,
        countdownEndsAt: null,
        checkInOpenAt: schedule.checkInOpenAt,
        checkInCloseAt: schedule.checkInCloseAt,
        startAt: schedule.startAt,

        createdByType: CREATED_BY_TYPE.systemBot,
        createdByUserId: null,
        isAutomatic: true,
      });

      logger.info('daily tournament created', {
        tournamentId: String(created._id),
        tournamentDate,
        dailySlot,
        name,
        startAt: schedule.startAt.toISOString(),
      });

      announceTournament('created', {
        tournamentId: String(created._id),
        tournamentDate,
        dailySlot,
        slotNumber: DAILY_SLOT_ORDER[dailySlot],
        name,
        status: AUTO_TOURNAMENT_STATUS.upcoming,
        startAtMs: schedule.startAt.getTime(),
        registrationOpenAtMs: schedule.registrationOpenAt.getTime(),
      });

      return created as AutoTournamentDocument;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;

      // Somebody else created it. Not an error — it is the constraint doing
      // exactly what it is there for, and the reason there is no read-modify-
      // write anywhere in this file.
      logger.info('a daily tournament slot was created concurrently', {
        tournamentDate,
        dailySlot,
      });
      return null;
    }
  }
}

export const tournamentDailyPlanner = new TournamentDailyPlanner();
