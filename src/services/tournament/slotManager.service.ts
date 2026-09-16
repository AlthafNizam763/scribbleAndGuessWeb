import { env } from '@/config/env';
import {
  AUTO_TOURNAMENT_DEFAULTS,
  AUTO_TOURNAMENT_FORMAT,
  AUTO_TOURNAMENT_STATUS,
  CREATED_BY_TYPE,
  SLOT_HOLDING_STATUSES,
  type BotDifficultyWire,
} from '@/constants/autoTournament.constants';
import { AutoTournament, type AutoTournamentDocument } from '@/models/AutoTournament';
import { announceTournament } from '@/services/tournament/notify';
import { logger } from '@/utils/logger';

/**
 * Keeping exactly N tournaments in existence.
 *
 * ## Why slots rather than a count
 *
 * "Always three tournaments" could be enforced by counting the live ones and
 * creating the difference. It should not be, because counting is a read and
 * creating is a write, and two schedulers can both read `2` before either
 * writes — which is how you end up with four.
 *
 * Numbering the slots turns the rule into a uniqueness constraint. The partial
 * unique index on `AutoTournament.slotNumber` — restricted to the statuses
 * that hold a slot — means a second insert into an occupied slot is refused by
 * the database. Two schedulers racing to fill slot 2 both try; one succeeds,
 * the other gets a duplicate-key error, logs it as the ordinary event it is,
 * and moves on. There is no window, because there is no read to be stale.
 *
 * ## Why a tournament number as well as a slot
 *
 * The slot is a position and is reused for ever. The number is an identity and
 * never is — "Daily Scribble Cup #12" names one event for all time, which is
 * what makes announcing a winner afterwards mean anything. Slot 2 has held
 * dozens of them.
 */

export class TournamentSlotManager {
  /** How many slots this deployment maintains. */
  get slotCount(): number {
    return env.tournament.slotCount;
  }

  /**
   * Which slots currently hold nothing.
   *
   * A single query over the four slot-holding statuses, rather than one query
   * per slot: the whole point of the listing screen is that three slots are
   * cheap to read, and the scheduler asks this every tick.
   */
  async vacantSlots(): Promise<number[]> {
    const occupied = await AutoTournament.find({
      isAutomatic: true,
      status: { $in: [...SLOT_HOLDING_STATUSES] },
    })
      .select({ slotNumber: 1 })
      .lean()
      .exec();

    const taken = new Set(occupied.map((row) => row.slotNumber));

    const vacant: number[] = [];
    for (let slot = 1; slot <= this.slotCount; slot++) {
      if (!taken.has(slot)) vacant.push(slot);
    }
    return vacant;
  }

  /**
   * Fills every vacant slot.
   *
   * Returns what was actually created, which is not always what was attempted:
   * a slot filled by another instance between the scan and the insert produces
   * a duplicate-key error rather than a second tournament, and that slot is
   * simply absent from the result.
   */
  async fillVacantSlots(): Promise<AutoTournamentDocument[]> {
    const vacant = await this.vacantSlots();
    if (vacant.length === 0) return [];

    const created: AutoTournamentDocument[] = [];

    for (const slotNumber of vacant) {
      const tournament = await this.createInSlot(slotNumber).catch((error: unknown) => {
        // One slot failing must not stop the others being filled. A
        // deployment with two of its three slots open is a degraded listing;
        // one where a throw abandoned the loop is an empty one.
        logger.exception('creating a tournament failed', error, { slotNumber });
        return null;
      });

      if (!tournament) continue;
      created.push(tournament);

      // Tell anybody watching the listing what replaced what. A client that
      // was showing "Daily Scribble Cup #11 — Completed" can swap the card for
      // #14 rather than going blank until somebody pulls to refresh.
      //
      // Looked up rather than tracked: the previous occupant is simply the
      // most recently finished tournament in this slot, and asking the
      // database is both correct after a restart and cheaper than carrying
      // state between ticks. Absent on a cold start, which is the one time
      // there genuinely is no predecessor.
      const previous = await AutoTournament.findOne({
        slotNumber,
        _id: { $ne: tournament._id },
      })
        .sort({ createdAt: -1 })
        .select({ _id: 1 })
        .lean()
        .exec();

      if (previous) this.announceReplacement(tournament, String(previous._id));
    }

    return created;
  }

  /**
   * Creates one tournament in one slot.
   *
   * Returns null when the slot was taken underneath us, which is a normal
   * outcome under concurrency and not an error.
   *
   * ## Why the number is retried rather than locked
   *
   * `tournamentNumber` is unique across all time, so allocating one means
   * reading the highest and adding one — a read-then-write with exactly the
   * race this class exists to avoid. Rather than introduce a counter document
   * and a second lock, the insert simply retries: a collision on the number is
   * cheap to detect, rare in practice (the scheduler holds a lock, so the only
   * contender is a lock that has just expired), and the retry converges.
   */
  async createInSlot(slotNumber: number): Promise<AutoTournamentDocument | null> {
    const config = env.tournament;
    const now = Date.now();

    const registrationCloseAt = new Date(now + config.registrationMs);
    const checkInCloseAt = new Date(registrationCloseAt.getTime() + config.checkInMs);

    for (let attempt = 0; attempt < 5; attempt++) {
      const tournamentNumber = await this.nextTournamentNumber();

      try {
        const created = await AutoTournament.create({
          slotNumber,
          tournamentNumber,
          name: `${AUTO_TOURNAMENT_DEFAULTS.namePrefix} #${tournamentNumber}`,
          description:
            'Free knockout tournament. Register, check in, and play your way to the final.',
          // Created dark, then opened by the lifecycle service in the same
          // tick. The two are separate so that "registration opened" is an
          // event with a cause rather than a side effect of a row appearing —
          // and so a deployment that wanted a delayed opening could have one
          // without changing anything here.
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

          registrationOpenAt: new Date(now),
          registrationCloseAt,
          checkInOpenAt: registrationCloseAt,
          checkInCloseAt,
          startAt: checkInCloseAt,

          createdByType: CREATED_BY_TYPE.systemBot,
          createdByUserId: null,
          isAutomatic: true,
        });

        logger.info('tournament created', {
          tournamentId: String(created._id),
          slotNumber,
          tournamentNumber,
        });

        announceTournament('created', {
          tournamentId: String(created._id),
          slotNumber,
          tournamentNumber,
          name: created.name,
        });

        return created as AutoTournamentDocument;
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;

        const message = String((error as { message?: string }).message ?? '');

        // The slot was filled by somebody else. Not an error — it is the
        // constraint doing exactly what it is there for.
        if (message.includes('one_live_tournament_per_slot')) {
          logger.info('a tournament slot was filled concurrently', { slotNumber });
          return null;
        }

        // The number collided. Retry with a fresh one.
        logger.debug('tournament number collided; retrying', { slotNumber, attempt });
      }
    }

    logger.error('could not allocate a tournament number', { slotNumber });
    return null;
  }

  /**
   * The next display number.
   *
   * Reads the highest ever issued rather than counting rows, so numbers keep
   * increasing after old tournaments are pruned — a #7 that came back around
   * would make two different events share a name.
   */
  private async nextTournamentNumber(): Promise<number> {
    const highest = await AutoTournament.findOne({})
      .sort({ tournamentNumber: -1 })
      .select({ tournamentNumber: 1 })
      .lean()
      .exec();

    return (highest?.tournamentNumber ?? 0) + 1;
  }

  /**
   * Announces that a released slot has been refilled.
   *
   * Separate from `fillVacantSlots` because the two answer different
   * questions. That one is the scheduler keeping the invariant; this is the
   * client being told "the cup you were just watching finished, and here is
   * what is in its place" — which is the difference between a listing that
   * updates and one that goes blank until somebody pulls to refresh.
   */
  announceReplacement(replacement: AutoTournamentDocument, previousId: string): void {
    announceTournament('nextScheduled', {
      slotNumber: replacement.slotNumber,
      previousTournamentId: previousId,
      tournamentId: String(replacement._id),
      tournamentNumber: replacement.tournamentNumber,
      name: replacement.name,
      registrationCloseAtMs: replacement.registrationCloseAt.getTime(),
    });
  }
}

export const tournamentSlotManager = new TournamentSlotManager();
