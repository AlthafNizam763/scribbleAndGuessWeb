import { env } from '@/config/env';
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
import { tournamentCheckInNotifier } from '@/services/tournament/checkInNotify.service';
import { tournamentMatchService } from '@/services/tournament/match.service';
import { announceTournament, tournamentRef } from '@/services/tournament/notify';
import { logger } from '@/utils/logger';

/**
 * One tournament's walk from created to finished.
 *
 * ```
 *   UPCOMING ──window arrives──> REGISTRATION ──registration closes──> CHECK_IN
 *   (hours, published)                  │                                 │
 *                                       │                                 │ at startAt:
 *                                       │                                 │ no-shows out,
 *                                       └──── nobody joined ────┐         │ bots in, seed
 *                                                               v         v
 *                                                          CANCELLED   RUNNING
 *                                                                         │
 *                                                                         v
 *                                                                     COMPLETED
 * ```
 *
 * ## The daily path, in one paragraph
 *
 * A tournament is published hours ahead and sits `UPCOMING` showing its start
 * time. Ninety minutes out, registration opens. Ten minutes out, it closes and
 * check-in asks the people who signed up whether they are still there. At the
 * published start the no-shows are written off, bots take whatever seats are
 * left, the bracket is drawn and play begins. Nothing in that sequence is
 * triggered by how many people turned up — a scheduled tournament starts when
 * it said it would.
 *
 * A tournament that reaches the start with nobody in it is cancelled, and
 * nothing replaces it: the next one is the next slot on the schedule, which
 * was published at the same time as this one. That is also the rule that makes
 * a bot-only tournament impossible, and it is checked at every gate.
 *
 * ## Why the fast-start methods are still here
 *
 * `startEarlyIfFull`, `fillAndStart` and `beginCountdown` belong to a
 * deployment running with `checkInEnabled` off, where a tournament seals its
 * roster on a timer instead of at a published time. Each is gated on the flag,
 * so under the daily configuration none of them fires — and `STARTING`, the
 * state they lead to, is never entered. They remain because that deployment is
 * still supported, and because a deploy can land while a tournament is sitting
 * in `STARTING`, which still has to reach a bracket rather than becoming a row
 * nothing advances.
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
  /**
   * Opens registration on a tournament whose window has arrived.
   *
   * ## Why the deadlines are trusted here rather than rewritten
   *
   * This is the one thing that inverted when tournaments became scheduled.
   *
   * The rolling system rewrote every deadline at this moment, because a
   * tournament was created and opened in the same breath and "forty-five
   * seconds from now" could only be measured from *now*. A daily tournament is
   * the opposite: its times were published when it was created, a player has
   * been looking at "starts 20:00" for an hour, and the only correct thing to
   * do with those times is leave them alone. Recomputing them here would move
   * the start of a tournament people are already waiting for.
   *
   * So this writes one field. The status is conditional on still being
   * `UPCOMING`, so two schedulers arriving together open it once.
   */
  async openRegistration(tournament: AutoTournamentDocument): Promise<boolean> {
    const config = env.tournament;

    const moved = await AutoTournament.updateOne(
      { _id: tournament._id, status: AUTO_TOURNAMENT_STATUS.upcoming },
      { $set: { status: AUTO_TOURNAMENT_STATUS.registration, countdownEndsAt: null } },
    ).exec();

    if ((moved.modifiedCount ?? 0) === 0) return false;

    announceTournament('registrationOpened', {
      ...tournamentRef(tournament, AUTO_TOURNAMENT_STATUS.registration),
      registrationOpenAtMs: tournament.registrationOpenAt.getTime(),
      registrationCloseAtMs: tournament.registrationCloseAt.getTime(),
      checkInOpenAtMs: tournament.checkInOpenAt.getTime(),
      checkInCloseAtMs: tournament.checkInCloseAt.getTime(),
      startAtMs: tournament.startAt.getTime(),
      botFillAtMs: tournament.botFillAt ? tournament.botFillAt.getTime() : null,
      startCountdownMs: config.startCountdownMs,
      checkInRequired: config.checkInEnabled,
      minPlayers: tournament.minPlayers,
      maxPlayers: tournament.maxPlayers,
    });

    logger.info('tournament registration opened', {
      tournamentId: String(tournament._id),
      tournamentDate: tournament.tournamentDate,
      dailySlot: tournament.dailySlot,
      closesAt: tournament.registrationCloseAt.toISOString(),
      startsAt: tournament.startAt.toISOString(),
    });
    return true;
  }

  /**
   * Counts the people actually in a tournament right now.
   *
   * "In" means holding a seat: registered, confirmed, or already playing.
   * Withdrawn and no-show rows are excluded because they are the two ways a
   * seat is given back.
   *
   * Written as one count rather than read from `humanPlayerCount`, because
   * every decision that uses it is a threshold — start, fill, cancel — and
   * enforcing a threshold against a denormalised number is how thresholds get
   * crossed twice.
   */
  private async countHumans(tournamentId: string): Promise<number> {
    return TournamentRegistration.countDocuments({
      tournamentId,
      playerType: PLAYER_TYPE.human,
      status: {
        $in: [
          REGISTRATION_STATUS.registered,
          REGISTRATION_STATUS.checkedIn,
          REGISTRATION_STATUS.active,
        ],
      },
    }).exec();
  }

  /**
   * Seals the roster and starts the countdown.
   *
   * The single door from `REGISTRATION` to `STARTING`, so the three reasons a
   * tournament might take it — full, filled, or out of time — cannot disagree
   * about what happens next. Each of them tops up with bots first and then
   * calls this, and this decides only two things: is it viable, and when does
   * it begin.
   *
   * Conditional on the status, so two schedulers and an in-flight registration
   * arriving together produce one countdown rather than three.
   */
  async beginCountdown(
    tournament: AutoTournamentDocument,
    reason: 'roster-full' | 'bots-filled' | 'window-closed',
  ): Promise<boolean> {
    const tournamentId = String(tournament._id);

    const humans = await this.countHumans(tournamentId);

    // The rule that makes a bot-only tournament impossible, checked on the
    // last door before the bracket rather than only on the first.
    if (humans < tournament.minHumanPlayers) {
      await this.cancel(
        tournament,
        humans === 0
          ? 'Nobody joined this tournament.'
          : 'Not enough players joined this tournament.',
      );
      return true;
    }

    const countdownEndsAt = new Date(Date.now() + env.tournament.startCountdownMs);

    const moved = await AutoTournament.updateOne(
      { _id: tournament._id, status: AUTO_TOURNAMENT_STATUS.registration },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.starting,
          countdownEndsAt,
          startAt: countdownEndsAt,
        },
      },
    ).exec();

    if ((moved.modifiedCount ?? 0) === 0) return false;

    const counts = await tournamentBotFillService.refreshCounts(tournamentId);

    announceTournament('countdownStarted', {
      ...tournamentRef(tournament, AUTO_TOURNAMENT_STATUS.starting),
      reason,
      countdownEndsAtMs: countdownEndsAt.getTime(),
      countdownMs: env.tournament.startCountdownMs,
      humanPlayerCount: counts.humans,
      botPlayerCount: counts.bots,
      totalPlayers: counts.humans + counts.bots,
    });

    logger.info('tournament countdown started', {
      tournamentId,
      reason,
      humans: counts.humans,
      bots: counts.bots,
    });
    return true;
  }

  /**
   * Tops a short roster up with bots, while registration is still open.
   *
   * ## Why this happens before the roster seals rather than after
   *
   * So that the seats are visibly taken. A player watching a lobby fill from
   * "1 player" to "1 player, 3 bots" and then counting down understands what
   * is about to happen; one who watches "1 player" sit there and then abruptly
   * finds themselves in a four-way bracket does not.
   *
   * Returns whether the tournament is now big enough to play, which is not the
   * same as whether any bot was added: a roster that was already full needs
   * none and is ready, and one that is short even after `maxBots` is not.
   */
  async topUpWithBots(tournament: AutoTournamentDocument): Promise<boolean> {
    const tournamentId = String(tournament._id);

    const humans = await this.countHumans(tournamentId);
    if (humans < tournament.minHumanPlayers) return false;

    const fill = await tournamentBotFillService.fill(tournament);

    if (fill.cancelReason) {
      await this.cancel(tournament, fill.cancelReason);
      return false;
    }

    if (fill.botsAdded > 0) {
      const counts = await tournamentBotFillService.refreshCounts(tournamentId);

      announceTournament('registrationUpdated', {
        ...tournamentRef(tournament, tournament.status),
        humanPlayerCount: counts.humans,
        botPlayerCount: counts.bots,
        totalPlayers: counts.humans + counts.bots,
      });
    }

    return fill.total >= tournament.minPlayers;
  }

  /**
   * The bot-fill deadline passed: fill the empty seats and count down.
   *
   * The ordinary path. A tournament with nobody in it is left alone rather
   * than cancelled here — it still has the rest of its window for somebody to
   * arrive, and cancelling at forty-five seconds would throw away more than a
   * minute of perfectly good registration time.
   */
  async fillAndStart(tournament: AutoTournamentDocument): Promise<boolean> {
    const humans = await this.countHumans(String(tournament._id));
    if (humans < tournament.minHumanPlayers) return false;

    const viable = await this.topUpWithBots(tournament);
    if (!viable) return false;

    return this.beginCountdown(tournament, 'bots-filled');
  }

  /**
   * Enough real people turned up: start without waiting for the fill deadline.
   *
   * Called from the registration path itself, so the response to the fourth
   * person joining is a countdown rather than a wait for the next tick. The
   * scheduler checks the same condition as a backstop, which is what covers a
   * registration that raced a restart.
   */
  async startEarlyIfFull(tournament: AutoTournamentDocument): Promise<boolean> {
    // With check-in on, a full roster is not a reason to start — it is a
    // reason to close registration on time and ask everybody to confirm.
    if (env.tournament.checkInEnabled) return false;
    if (tournament.status !== AUTO_TOURNAMENT_STATUS.registration) return false;

    const humans = await this.countHumans(String(tournament._id));
    if (humans < tournament.minPlayers) return false;

    return this.beginCountdown(tournament, 'roster-full');
  }

  /**
   * The countdown ran out. Draw the bracket and play.
   *
   * Everything expensive is in `seedAndStart`, which is shared with the
   * retired check-in path and is idempotent — so a failure here leaves the
   * tournament in `STARTING` and the next tick retries from the top rather
   * than stranding it.
   */
  async startCountedDownTournament(tournament: AutoTournamentDocument): Promise<boolean> {
    return this.seedAndStart(tournament, AUTO_TOURNAMENT_STATUS.starting);
  }

  /**
   * The registration window ran out.
   *
   * ## What this is now, and what it used to be
   *
   * It used to be the main event: registration closed and a two-minute
   * check-in opened. It is now the *backstop* — almost every tournament has
   * already left `REGISTRATION` through the bot fill or a full roster long
   * before this fires, and the ones that reach it are the two genuine edge
   * cases: nobody ever joined, or somebody joined in the last few seconds.
   *
   * Both are handled by the same two lines as everywhere else: top up with
   * bots, then count down. `beginCountdown` cancels a tournament with nobody
   * in it, so the empty case needs no branch of its own here.
   *
   * With `checkInEnabled` on, this opens check-in instead and the tournament
   * takes the old path.
   */
  async closeRegistration(tournament: AutoTournamentDocument): Promise<boolean> {
    const tournamentId = String(tournament._id);

    if (env.tournament.checkInEnabled) return this.openCheckIn(tournament);

    const humans = await this.countHumans(tournamentId);

    if (humans < tournament.minHumanPlayers) {
      await this.cancel(
        tournament,
        humans === 0 ? 'Nobody joined this tournament.' : 'Not enough players joined.',
      );
      return true;
    }

    // Best effort: a fill that could not reach `minPlayers` leaves the
    // countdown to decide, and the countdown's own viability check is what
    // cancels a tournament that cannot be played.
    await this.topUpWithBots(tournament);

    return this.beginCountdown(tournament, 'window-closed');
  }

  /**
   * Opens check-in. Only reachable with `checkInEnabled` on.
   *
   * Left intact rather than deleted, so turning the flag back on is a
   * configuration change rather than a revert.
   *
   * ## Why the notification is sent here and not by the caller
   *
   * Because this is the only place that knows the transition actually
   * happened. The `updateOne` below names the status it expects to replace, so
   * of two schedulers racing a deadline exactly one gets `modifiedCount: 1` —
   * and announcing from the caller would mean announcing on the strength of
   * "check-in is open", which is true for both of them and for every tick
   * afterwards.
   *
   * The fan-out is idempotent in its own right (see
   * `checkInNotify.service.ts`), so this is belt and braces rather than the
   * only guard — but it is what keeps the ordinary path to one attempt.
   */
  private async openCheckIn(tournament: AutoTournamentDocument): Promise<boolean> {
    const tournamentId = String(tournament._id);
    const humans = await this.countHumans(tournamentId);

    if (humans < tournament.minHumanPlayers) {
      await this.cancel(
        tournament,
        humans === 0
          ? 'Nobody registered for this tournament.'
          : 'Not enough players registered.',
      );
      return true;
    }

    const checkInOpenedAt = new Date();

    const moved = await AutoTournament.updateOne(
      { _id: tournament._id, status: AUTO_TOURNAMENT_STATUS.registration },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.checkIn,
          checkInOpenAt: checkInOpenedAt,
        },
      },
    ).exec();

    if ((moved.modifiedCount ?? 0) === 0) {
      logger.debug('[TOURNAMENT_CHECKIN] transition lost to another scheduler', {
        tournamentId,
        statusChanged: false,
      });
      return false;
    }

    announceTournament('checkInOpened', {
      ...tournamentRef(tournament, AUTO_TOURNAMENT_STATUS.checkIn),
      checkInOpenAtMs: checkInOpenedAt.getTime(),
      checkInCloseAtMs: tournament.checkInCloseAt.getTime(),
      startAtMs: tournament.startAt.getTime(),
      registeredHumans: humans,
    });

    // The part that reaches a phone in a pocket. Awaited rather than fired and
    // forgotten so a failure is logged inside the tick that caused it, and so
    // the scheduler's lock is still held while the ledger rows are written —
    // which is what keeps a concurrent tick from racing the claim. It cannot
    // throw: see the note on `announceCheckIn`.
    const fanOut = await tournamentCheckInNotifier.announceCheckIn(
      tournamentId,
      tournament.name,
    );

    logger.info('[TOURNAMENT_CHECKIN] check-in opened', {
      tournamentId,
      humans,
      statusChanged: true,
      checkInOpenedAt: checkInOpenedAt.toISOString(),
      notificationTriggered: fanOut.claimed > 0,
      notificationsSent: fanOut.notificationsSent,
      notificationsFailed: fanOut.notificationsFailed,
    });
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
      ...tournamentRef(tournament, AUTO_TOURNAMENT_STATUS.checkIn),
      humanPlayerCount: fill.humans,
      botPlayerCount: fill.botsBefore + fill.botsAdded,
      totalPlayers: fill.total,
    });

    if (fill.cancelReason) {
      await this.cancel(tournament, fill.cancelReason);
      return true;
    }

    return this.seedAndStart(tournament, AUTO_TOURNAMENT_STATUS.checkIn);
  }

  /**
   * Draws the bracket and opens the first round.
   *
   * ## Why both paths share this
   *
   * Because it is the part where a tournament becomes a bracket, and having
   * two copies of it — one for the countdown, one for check-in — would be two
   * places for the byes, the round count and the "not enough players" bail to
   * drift apart. `from` is the status the caller expects to be leaving, which
   * is what makes the final move conditional and therefore safe to retry.
   *
   * Every step is idempotent, so a failure part-way leaves the tournament
   * where it was and the next tick starts again from the top.
   */
  private async seedAndStart(
    tournament: AutoTournamentDocument,
    from: (typeof AUTO_TOURNAMENT_STATUS)[keyof typeof AUTO_TOURNAMENT_STATUS],
  ): Promise<boolean> {
    const tournamentId = String(tournament._id);

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
      { _id: tournament._id, status: from },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.running,
          totalRounds,
          currentRound: 1,
          startAt: new Date(),
          // The countdown is over, so the field that describes it stops
          // describing anything. Cleared rather than left pointing at a moment
          // in the past, which a client would render as a clock stuck on zero.
          countdownEndsAt: null,
        },
      },
    ).exec();

    if ((moved.modifiedCount ?? 0) === 0) return false;

    announceTournament('started', {
      ...tournamentRef(tournament, AUTO_TOURNAMENT_STATUS.running),
      totalRounds,
      currentRound: 1,
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
   * Abandons a tournament.
   *
   * Cancelling is a completely normal outcome — a quiet morning produces one —
   * so it is announced with a reason a client can show rather than logged as a
   * failure.
   *
   * ## Nothing is created in its place
   *
   * This is the other half of what changed with the daily model. A cancelled
   * rolling tournament freed its slot and the next tick filled it, because the
   * promise was "three at all times". The promise is now "three a day", and a
   * cancelled morning tournament has already used up the morning: creating a
   * replacement would be a fourth tournament on that day, which is the thing
   * the whole design refuses. The player's next tournament is the afternoon
   * one, which has been on the schedule since midnight and is unaffected.
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
            AUTO_TOURNAMENT_STATUS.starting,
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

    // Everybody's registration ends with the tournament. A row left `ACTIVE`
    // against a tournament that no longer is would keep showing up in "the
    // match you are in" checks for ever, and the player would be told they
    // were busy in a tournament that had been cancelled hours earlier.
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

    announceTournament('cancelled', {
      ...tournamentRef(tournament, AUTO_TOURNAMENT_STATUS.cancelled),
      reason,
    });

    logger.info('tournament cancelled', { tournamentId, reason });
    return true;
  }
}

export const tournamentLifecycleService = new TournamentLifecycleService();
