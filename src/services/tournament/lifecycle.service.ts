import {
  AUTO_TOURNAMENT_STATUS,
  PLAYER_TYPE,
  REGISTRATION_STATUS,
} from '@/constants/autoTournament.constants';
import {
  AutoTournament,
  TournamentRegistration,
  type AutoTournamentDocument,
  type TournamentRegistrationDocument,
} from '@/models/AutoTournament';
import { tournamentBotFillService } from '@/services/tournament/botFill.service';
import { tournamentBracketService } from '@/services/tournament/bracket.service';
import { tournamentMatchService } from '@/services/tournament/match.service';
import { announceTournament } from '@/services/tournament/notify';
import { logger } from '@/utils/logger';

/**
 * One tournament's walk from created to finished.
 *
 * ```
 *   UPCOMING ──open──> REGISTRATION ──deadline──> CHECK_IN ──deadline──┐
 *                            │                        │                │
 *                            └──── nobody joined ─────┴──> CANCELLED   │
 *                                                                      │
 *                          RUNNING <──── bracket drawn ────────────────┘
 *                            │
 *                            └──── final decided ────> COMPLETED
 * ```
 *
 * ## Every transition is a conditional write
 *
 * Each method below moves the status with an `updateOne` that names the status
 * it expects to replace, and does its work only when that update actually
 * modified a row. Two schedulers arriving at the same deadline therefore
 * produce one transition: the second finds the status already moved and its
 * update changes nothing.
 *
 * This is what makes the whole system safe to run from a loop in this process
 * *and* from an external cron at the same time, and safe across a restart in
 * the middle of any step.
 *
 * ## Why per-tournament isolation matters here
 *
 * The scheduler calls these once per tournament and catches per tournament.
 * A bracket that fails to seed in slot 1 must not stop slot 2's registration
 * closing — three tournaments are three independent events that happen to
 * share a scheduler, and the only thing they genuinely share is the lock.
 */

export class TournamentLifecycleService {
  /** Opens registration on a freshly created tournament. */
  async openRegistration(tournament: AutoTournamentDocument): Promise<boolean> {
    const moved = await AutoTournament.updateOne(
      { _id: tournament._id, status: AUTO_TOURNAMENT_STATUS.upcoming },
      { $set: { status: AUTO_TOURNAMENT_STATUS.registration } },
    ).exec();

    if ((moved.modifiedCount ?? 0) === 0) return false;

    announceTournament('registrationOpened', {
      tournamentId: String(tournament._id),
      slotNumber: tournament.slotNumber,
      name: tournament.name,
      registrationCloseAtMs: tournament.registrationCloseAt.getTime(),
      minPlayers: tournament.minPlayers,
      maxPlayers: tournament.maxPlayers,
    });

    logger.info('tournament registration opened', { tournamentId: String(tournament._id) });
    return true;
  }

  /**
   * Closes registration and opens check-in.
   *
   * ## Why check-in exists at all
   *
   * Because a knockout pairing needs both players to actually be there. Ten
   * minutes is long enough that somebody who registered at the start has
   * wandered off, and a bracket seeded from registrations would spend its
   * first round handing out walkovers. Check-in is the two-minute question
   * "are you still here?", and it is the answer — not the registration — that
   * the bracket is drawn from.
   *
   * A tournament nobody registered for is cancelled here rather than made to
   * sit through a check-in nobody will attend.
   */
  async closeRegistration(tournament: AutoTournamentDocument): Promise<boolean> {
    const tournamentId = String(tournament._id);

    const humans = await TournamentRegistration.countDocuments({
      tournamentId,
      playerType: PLAYER_TYPE.human,
      status: REGISTRATION_STATUS.registered,
    }).exec();

    if (humans < tournament.minHumanPlayers) {
      await this.cancel(
        tournament,
        humans === 0
          ? 'Nobody registered for this tournament.'
          : 'Not enough players registered.',
      );
      return true;
    }

    const moved = await AutoTournament.updateOne(
      { _id: tournament._id, status: AUTO_TOURNAMENT_STATUS.registration },
      { $set: { status: AUTO_TOURNAMENT_STATUS.checkIn } },
    ).exec();

    if ((moved.modifiedCount ?? 0) === 0) return false;

    announceTournament('checkInOpened', {
      tournamentId,
      slotNumber: tournament.slotNumber,
      checkInCloseAtMs: tournament.checkInCloseAt.getTime(),
      registeredHumans: humans,
    });

    logger.info('tournament check-in opened', { tournamentId, humans });
    return true;
  }

  /**
   * Closes check-in, fills with bots, draws the bracket and starts play.
   *
   * The order is not negotiable and each step depends on the one before:
   *
   * 1. **Write off the no-shows.** Somebody who never confirmed is not in the
   *    field, and the bot fill has to count the real field.
   * 2. **Fill.** Add exactly the shortfall, or decide the tournament cannot
   *    run — see `botFill.service.ts` for the rules.
   * 3. **Seed.** Draw the bracket from the people and bots that are actually
   *    playing.
   * 4. **Open.** Create the first round's rooms and tell the players.
   *
   * A failure anywhere after step 2 leaves the tournament in `CHECK_IN` with
   * its roster written, so the next tick retries from the top — and every step
   * is idempotent, so retrying costs nothing.
   */
  async closeCheckIn(tournament: AutoTournamentDocument): Promise<boolean> {
    const tournamentId = String(tournament._id);

    // Anybody who did not confirm. Marked rather than deleted: the bracket has
    // to be able to explain why somebody who signed up is not in it.
    await TournamentRegistration.updateMany(
      {
        tournamentId,
        playerType: PLAYER_TYPE.human,
        status: REGISTRATION_STATUS.registered,
        checkedInAt: null,
      },
      { $set: { status: REGISTRATION_STATUS.noShow } },
    ).exec();

    await tournamentBotFillService.refreshCounts(tournamentId);

    const fill = await tournamentBotFillService.fill(tournament);

    announceTournament('checkInClosed', {
      tournamentId,
      humanPlayerCount: fill.humans,
      botPlayerCount: fill.botsBefore + fill.botsAdded,
      totalPlayers: fill.total,
    });

    if (fill.cancelReason) {
      await this.cancel(tournament, fill.cancelReason);
      return true;
    }

    await tournamentBotFillService.refreshCounts(tournamentId);

    const participants = (await TournamentRegistration.find({
      tournamentId,
      status: {
        $in: [REGISTRATION_STATUS.checkedIn, REGISTRATION_STATUS.active],
      },
    })
      .sort({ joinedAt: 1 })
      .lean()
      .exec()) as TournamentRegistrationDocument[];

    const { totalRounds } = await tournamentBracketService.generate({
      tournamentId,
      participants,
    });

    if (totalRounds === 0) {
      await this.cancel(tournament, 'Not enough players to draw a bracket.');
      return true;
    }

    await tournamentBracketService.resolveByes(tournamentId);

    // The bracket exists; the tournament is running. Conditional, so a second
    // caller that seeded the same (identical) bracket does not announce a
    // second start.
    const moved = await AutoTournament.updateOne(
      { _id: tournament._id, status: AUTO_TOURNAMENT_STATUS.checkIn },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.running,
          totalRounds,
          currentRound: 1,
          startAt: new Date(),
        },
      },
    ).exec();

    if ((moved.modifiedCount ?? 0) === 0) return false;

    announceTournament('started', {
      tournamentId,
      slotNumber: tournament.slotNumber,
      totalRounds,
      totalPlayers: participants.length,
    });

    // Byes may already have decided some of round one, so this both opens the
    // playable pairings and moves the tournament on if round one turned out to
    // be entirely byes — which a two-player bracket with one bye cannot be, but
    // a hand-configured one could.
    await tournamentMatchService.openReadyMatches(tournamentId);
    await tournamentMatchService.progressRounds(tournamentId);

    logger.info('tournament started', { tournamentId, totalRounds, players: participants.length });
    return true;
  }

  /**
   * Abandons a tournament and releases its slot.
   *
   * Cancelling is a completely normal outcome — a quiet hour produces one — so
   * it is announced with a reason a client can show rather than logged as a
   * failure. The slot is released the moment the status changes, and the next
   * scheduler tick creates the replacement.
   */
  async cancel(tournament: AutoTournamentDocument, reason: string): Promise<boolean> {
    const tournamentId = String(tournament._id);

    const moved = await AutoTournament.updateOne(
      {
        _id: tournament._id,
        status: {
          $in: [
            AUTO_TOURNAMENT_STATUS.upcoming,
            AUTO_TOURNAMENT_STATUS.registration,
            AUTO_TOURNAMENT_STATUS.checkIn,
            AUTO_TOURNAMENT_STATUS.running,
          ],
        },
      },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.cancelled,
          cancelReason: reason,
          completedAt: new Date(),
        },
      },
    ).exec();

    if ((moved.modifiedCount ?? 0) === 0) return false;

    // Everybody's registration ends with the tournament. Without this a player
    // whose tournament was cancelled would still count as "in an active
    // tournament" and could not join the replacement — which is the one thing
    // a cancellation must not do.
    await TournamentRegistration.updateMany(
      {
        tournamentId,
        status: {
          $in: [
            REGISTRATION_STATUS.registered,
            REGISTRATION_STATUS.checkedIn,
            REGISTRATION_STATUS.active,
          ],
        },
      },
      { $set: { status: REGISTRATION_STATUS.eliminated } },
    ).exec();

    announceTournament('cancelled', { tournamentId, slotNumber: tournament.slotNumber, reason });

    logger.info('tournament cancelled', { tournamentId, reason });
    return true;
  }
}

export const tournamentLifecycleService = new TournamentLifecycleService();
