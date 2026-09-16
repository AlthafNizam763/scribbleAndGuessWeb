import { env } from '@/config/env';
import {
  AUTO_TOURNAMENT_STATUS,
  LIVE_STATUSES,
  MATCH_STATUS,
  PLAYER_TYPE,
  REGISTRATION_STATUS,
} from '@/constants/autoTournament.constants';
import {
  AutoTournament,
  TournamentRegistration,
  type AutoTournamentDocument,
  type TournamentRegistrationDocument,
} from '@/models/AutoTournament';
import {
  TournamentMatch,
  TournamentRound,
  type TournamentMatchDocument,
} from '@/models/TournamentMatch';
import { isObjectId } from '@/repositories/user.repository';
import { tournamentBotFillService } from '@/services/tournament/botFill.service';
import { tournamentLifecycleService } from '@/services/tournament/lifecycle.service';
import { tournamentDailyPlanner } from '@/services/tournament/dailyPlanner.service';
import { announceTournament, tournamentRef } from '@/services/tournament/notify';
import {
  anonymousViewerState,
  participantViewerState,
  toMatchDto,
  toParticipantDto,
  toTournamentDto,
} from '@/services/tournament/serialize';
import type { AuthenticatedUser } from '@/types/auth.types';
import type {
  AutoTournamentDto,
  TournamentBracketDto,
  TournamentParticipantDto,
} from '@/types/tournament.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * What a player can do with a tournament.
 *
 * ## What is absent, and why that is the feature
 *
 * There is no `create`. There is no `addBot`, no `setSettings`, no
 * `setBracket`, no `reportResult` and no `setWinner`. A player-facing service
 * that cannot express those things is a stronger guarantee than a route that
 * checks a role before refusing them — a role check is one misconfiguration
 * away from passing, while a method that does not exist cannot be called.
 *
 * Everything a tournament *is* comes from the organiser bot: the scheduler
 * creates it, the fill service seats the AI, the bracket service draws the
 * pairings and the game engine decides the matches. This file offers three
 * verbs — register, withdraw, check in — and a set of reads.
 *
 * ## A player may be in more than one of a day's tournaments
 *
 * This is the rule that reversed. The old system refused a second
 * registration while a first was live, because tournaments ran back to back
 * and being in two meant being called to two matches at the same moment.
 *
 * Three tournaments a day, hours apart, are not that. Winning the morning
 * tournament is not a reason to be locked out of the evening one, and missing
 * the morning is not a reason to be locked out of the afternoon — both would
 * be the app taking something away for no reason a player could see. So
 * registration is per tournament and unrestricted, each one is joined
 * separately, and none of them registers anybody for another.
 *
 * What remains is much narrower, and lives in `match.service.enter`: a player
 * cannot be in two *matches* at the same instant, because the game engine
 * seats one player in one room. That can only happen when two tournaments
 * overlap, which the schedule makes rare and an over-running bracket makes
 * possible.
 */

export class AutoTournamentService {
  // ------------------------------------------------------------------ reads

  /**
   * One calendar day's tournaments, in the order they happen.
   *
   * At most three, because at most three exist — the unique index on
   * `{tournamentDate, dailySlot, isAutomatic}` is what guarantees that, so
   * this method does not slice, cap or otherwise defend against a fourth. If
   * one ever appeared the right response would be to find out how, not to hide
   * it.
   *
   * ## Why finished tournaments are still in it
   *
   * Because the morning tournament's result is the most interesting thing on
   * the screen at lunchtime. The rolling system dropped a tournament from the
   * listing the moment it ended and put its replacement in the same slot; a
   * day's schedule is a different object, and removing this morning's from it
   * would leave a player who played in it with nowhere to see how it went.
   */
  async listDay(
    tournamentDate: string,
    viewerId: string | null,
  ): Promise<{ tournamentDate: string; timeZone: string; tournaments: AutoTournamentDto[] }> {
    const rows = (await AutoTournament.find({ isAutomatic: true, tournamentDate })
      .sort({ slotNumber: 1 })
      .lean()
      .exec()) as AutoTournamentDocument[];

    return {
      tournamentDate,
      // Sent so a client can label the schedule with the zone it is in rather
      // than assuming the reader's own — "20:00 IST" is an answer, "20:00" on
      // a phone set to another zone is a wrong one.
      timeZone: env.tournament.timeZone,
      tournaments: await this.decorate(rows, viewerId),
    };
  }

  /** Today's tournaments, in the deployment's configured timezone. */
  async listToday(viewerId: string | null): Promise<{
    tournamentDate: string;
    timeZone: string;
    tournaments: AutoTournamentDto[];
  }> {
    return this.listDay(tournamentDailyPlanner.today(), viewerId);
  }

  /** Everything currently being played. */
  async listActive(viewerId: string | null): Promise<AutoTournamentDto[]> {
    return this.listByStatus(viewerId, [AUTO_TOURNAMENT_STATUS.running]);
  }

  /**
   * Everything still to come: scheduled, taking entries, or in check-in.
   *
   * Spans days rather than stopping at midnight, because tomorrow's schedule
   * is published tonight and "what is coming up" is a fair question to ask at
   * eleven in the evening. Ordered by when they start, which across two days
   * is the only ordering that means anything.
   */
  async listUpcoming(viewerId: string | null): Promise<AutoTournamentDto[]> {
    return this.listByStatus(viewerId, [
      AUTO_TOURNAMENT_STATUS.upcoming,
      AUTO_TOURNAMENT_STATUS.registration,
      AUTO_TOURNAMENT_STATUS.starting,
      AUTO_TOURNAMENT_STATUS.checkIn,
    ]);
  }

  private async listByStatus(
    viewerId: string | null,
    statuses: string[],
  ): Promise<AutoTournamentDto[]> {
    const rows = (await AutoTournament.find({ isAutomatic: true, status: { $in: statuses } })
      .sort({ startAt: 1 })
      .lean()
      .exec()) as AutoTournamentDocument[];

    return this.decorate(rows, viewerId);
  }

  /**
   * Turns rows into DTOs, resolving the caller's own state for all of them at
   * once.
   *
   * ## Why the registrations are fetched in one query
   *
   * Because a player can now hold a place in every tournament on the screen,
   * so "am I in this one?" is a different answer per card rather than the one
   * answer it used to be. Asked per row it would be three queries to draw
   * three cards; asked once with `$in` it is one, and the map is what each
   * row's viewer block is built from.
   */
  private async decorate(
    rows: AutoTournamentDocument[],
    viewerId: string | null,
  ): Promise<AutoTournamentDto[]> {
    if (rows.length === 0) return [];

    const mine = viewerId
      ? await this.registrationsOf(viewerId, rows.map((row) => String(row._id)))
      : new Map<string, TournamentRegistrationDocument>();

    return Promise.all(rows.map((row) => this.toDto(row, viewerId, mine)));
  }

  /** One tournament, or null when the id names something else entirely. */
  async find(tournamentId: string, viewerId: string | null): Promise<AutoTournamentDto | null> {
    const row = await this.row(tournamentId);
    if (!row) return null;

    const [dto] = await this.decorate([row], viewerId);
    return dto ?? null;
  }

  /** One tournament, or a 404. */
  async get(tournamentId: string, viewerId: string | null): Promise<AutoTournamentDto> {
    const dto = await this.find(tournamentId, viewerId);
    if (!dto) throw errors.notFound('That tournament does not exist.');
    return dto;
  }

  /**
   * Everybody in a tournament, humans and AI alike.
   *
   * Bots are included and clearly flagged rather than filtered out. Hiding
   * them would make a four-player tournament look like four people, which is
   * the specific thing the product forbids.
   */
  async participants(
    tournamentId: string,
    viewerId: string | null,
  ): Promise<TournamentParticipantDto[]> {
    const row = await this.row(tournamentId);
    if (!row) throw errors.notFound('That tournament does not exist.');

    const rows = (await TournamentRegistration.find({
      tournamentId,
      status: { $ne: REGISTRATION_STATUS.withdrawn },
    })
      // Seeded players in bracket order, then everybody else by arrival.
      .sort({ seed: 1, joinedAt: 1 })
      .lean()
      .exec()) as TournamentRegistrationDocument[];

    return rows.map((entry) => toParticipantDto(entry, viewerId));
  }

  /**
   * The bracket.
   *
   * Room codes are blanked for anybody who is not playing in that particular
   * match — see `toMatchDto`. The room refuses outsiders regardless, so this
   * is the second of two locks rather than the only one.
   */
  async bracket(tournamentId: string, viewerId: string | null): Promise<TournamentBracketDto> {
    const row = await this.row(tournamentId);
    if (!row) throw errors.notFound('That tournament does not exist.');

    const [rounds, matches, registrations] = await Promise.all([
      TournamentRound.find({ tournamentId }).sort({ roundNumber: 1 }).lean().exec(),
      TournamentMatch.find({ tournamentId })
        .sort({ roundNumber: 1, matchNumber: 1 })
        .lean()
        .exec(),
      TournamentRegistration.find({ tournamentId }).lean().exec(),
    ]);

    // One lookup table for the whole bracket rather than a query per slot: a
    // sixteen-player draw is fifteen matches and thirty slot reads, which as
    // individual queries would be thirty round trips to render one screen.
    const byId = new Map(
      registrations.map((entry) => [
        String(entry._id),
        entry as TournamentRegistrationDocument,
      ]),
    );

    const viewerSeats = new Set(
      registrations
        .filter((entry) => viewerId && entry.userId && String(entry.userId) === viewerId)
        .map((entry) => String(entry._id)),
    );

    return {
      tournamentId,
      totalRounds: row.totalRounds ?? 0,
      currentRound: row.currentRound ?? 0,
      rounds: rounds.map((round) => ({
        roundNumber: round.roundNumber,
        name: round.name,
        matches: matches
          .filter((match) => match.roundNumber === round.roundNumber)
          .map((match) =>
            toMatchDto({
              row: match as TournamentMatchDocument,
              playerA: match.slotA ? (byId.get(String(match.slotA)) ?? null) : null,
              playerB: match.slotB ? (byId.get(String(match.slotB)) ?? null) : null,
              viewerId,
              viewerIsParticipant:
                (match.slotA !== null && viewerSeats.has(String(match.slotA))) ||
                (match.slotB !== null && viewerSeats.has(String(match.slotB))),
            }),
          ),
      })),
    };
  }

  /**
   * The results table: who got how far.
   *
   * A knockout has no running score, so "leaderboard" here means placement.
   * Ranked by how deep each player went — the winner, then the finalist, then
   * the semi-finalists, and so on — which is the only ordering a bracket
   * actually produces.
   */
  async leaderboard(
    tournamentId: string,
    viewerId: string | null,
  ): Promise<{ items: (TournamentParticipantDto & { placement: number })[] }> {
    const row = await this.row(tournamentId);
    if (!row) throw errors.notFound('That tournament does not exist.');

    // A finished tournament answers from its own snapshot.
    //
    // ## Why not recompute it from the registration rows
    //
    // Because the result would drift. The rows are live: a display name
    // changes when somebody renames themselves, and the ordering is derived
    // from statuses that later code could touch. A placement table is a
    // historical record, and the only way to be sure it still says what it
    // said on the night is to have written it down on the night.
    const frozen = row.finalRankings ?? [];

    if (frozen.length > 0) {
      return {
        items: frozen
          .slice()
          .sort((a, b) => a.placement - b.placement)
          .map((entry) => ({
            registrationId: String(entry.registrationId),
            playerId: entry.userId ? String(entry.userId) : '',
            displayName: entry.displayName,
            avatarId: entry.avatarId ?? 0,
            avatarColorIndex: entry.avatarColorIndex ?? 0,
            playerType: entry.isBot ? PLAYER_TYPE.aiBot : PLAYER_TYPE.human,
            isBot: Boolean(entry.isBot),
            botDifficulty: null,
            status:
              entry.placement === 1
                ? REGISTRATION_STATUS.winner
                : REGISTRATION_STATUS.eliminated,
            seed: null,
            isSelf: Boolean(viewerId && entry.userId && String(entry.userId) === viewerId),
            placement: entry.placement,
          })),
      };
    }

    const rows = (await TournamentRegistration.find({
      tournamentId,
      status: {
        $in: [
          REGISTRATION_STATUS.winner,
          REGISTRATION_STATUS.eliminated,
          REGISTRATION_STATUS.active,
        ],
      },
    })
      .lean()
      .exec()) as TournamentRegistrationDocument[];

    const depth = (entry: TournamentRegistrationDocument): number => {
      if (entry.status === REGISTRATION_STATUS.winner) return Number.MAX_SAFE_INTEGER;
      // Still alive: they are at least as deep as the current round.
      if (entry.status === REGISTRATION_STATUS.active) return (row.currentRound ?? 1) + 0.5;
      return entry.eliminatedInRound ?? 0;
    };

    const ordered = [...rows].sort((a, b) => {
      const difference = depth(b) - depth(a);
      if (difference !== 0) return difference;
      // Tie-break on seed so the order is stable between reads.
      return (a.seed ?? 999) - (b.seed ?? 999);
    });

    return {
      items: ordered.map((entry, index) => ({
        ...toParticipantDto(entry, viewerId),
        placement: index + 1,
      })),
    };
  }

  // ----------------------------------------------------------------- writes

  /**
   * Registers the caller for one tournament, and only that one.
   *
   * Three refusals, in the order that gives the most useful message first: the
   * tournament is not taking entries, the caller is already in *this* one
   * (which is a no-op rather than an error), and it is full. Being in another
   * of the day's tournaments is not among them, and nothing here writes a
   * registration for any tournament other than the one named.
   *
   * ## Why the capacity check counts rather than reading the counter
   *
   * The denormalised `humanPlayerCount` exists so the listing does not fan out
   * into a count per slot. Enforcing a limit against it would mean enforcing a
   * limit against a cached number, and two registrations arriving together
   * would both read the stale value and both be admitted. The count is a
   * covered query on an index built for exactly this.
   */
  async register(tournamentId: string, user: AuthenticatedUser): Promise<AutoTournamentDto> {
    const row = await this.row(tournamentId);
    if (!row) throw errors.notFound('That tournament does not exist.');

    if (row.status !== AUTO_TOURNAMENT_STATUS.registration) {
      // Each of these is a different thing to tell somebody who just tapped
      // join, and the difference matters: a player who missed the window by a
      // minute and one who is looking at yesterday's result need different
      // sentences, and neither is helped by "cannot join".
      throw errors.invalidAction(this.whyNotJoinable(row));
    }

    const mine = await this.registrationOf(user.id, tournamentId);

    // Already in. A no-op rather than an error: the caller holds a place
    // either way, and a double tap should not read as a failure.
    if (mine && mine.status !== REGISTRATION_STATUS.withdrawn) {
      return this.get(tournamentId, user.id);
    }

    const taken = await TournamentRegistration.countDocuments({
      tournamentId,
      status: { $ne: REGISTRATION_STATUS.withdrawn },
    }).exec();

    if (taken >= row.maxPlayers) throw errors.invalidAction('That tournament is full.');

    // Whether joining is also the confirmation.
    //
    // ## Why this depends on a flag rather than always being one or the other
    //
    // With check-in on — the daily configuration — registration for the
    // evening tournament opens ninety minutes before it starts, so joining
    // says "I intend to play" and check-in says "I am here". They are
    // genuinely different claims and the bracket is drawn from the second.
    //
    // With it off, a tournament seals its roster within a minute or two of
    // opening and nobody has gone anywhere in between. Asking the question
    // there would be the delay it was meant to prevent, so the row is written
    // already confirmed and the seeder — which means "players who are actually
    // here" — keeps working unchanged.
    const autoReady = !env.tournament.checkInEnabled;

    const seat = {
      displayName: user.username,
      avatarId: user.avatarId,
      avatarColorIndex: user.avatarColorIndex,
      playerType: PLAYER_TYPE.human,
      isBot: false,
      botDifficulty: null,
      status: autoReady ? REGISTRATION_STATUS.checkedIn : REGISTRATION_STATUS.registered,
      checkedInAt: autoReady ? new Date() : null,
      joinedAt: new Date(),
      eliminatedInRound: null,
      eliminatedReason: null,
      seed: null,
    };

    try {
      // An upsert rather than an insert, because a registration row is never
      // deleted — withdrawing marks it `WITHDRAWN`. Somebody who withdrew and
      // changed their mind while the window is still open has a row already,
      // and an insert would be refused by the unique index as a duplicate of
      // the place they gave back.
      //
      // Filtered on the statuses a seat can be *re-taken* from, so this cannot
      // resurrect somebody the scheduler has already written off as a no-show
      // into a bracket that has been drawn.
      await TournamentRegistration.updateOne(
        {
          tournamentId,
          userId: user.id,
          status: {
            $in: [REGISTRATION_STATUS.withdrawn, REGISTRATION_STATUS.noShow],
          },
        },
        { $set: seat },
      )
        .exec()
        .then(async (result) => {
          if ((result.matchedCount ?? 0) > 0) return;

          await TournamentRegistration.create({
            tournamentId,
            userId: user.id,
            botId: null,
            ...seat,
          });
        });
    } catch (error) {
      // The unique index caught a double tap that raced the check above.
      // Registered either way.
      if ((error as { code?: number }).code !== 11000) throw error;
    }

    const counts = await tournamentBotFillService.refreshCounts(tournamentId);

    announceTournament('registrationUpdated', {
      ...tournamentRef(row, row.status),
      humanPlayerCount: counts.humans,
      botPlayerCount: counts.bots,
      totalPlayers: counts.humans + counts.bots,
    });

    logger.info('tournament registration', { tournamentId, userId: user.id });

    // The fourth person to join starts the countdown, here, rather than up to
    // one tick later. This is the "four real users start immediately" rule,
    // and putting it on the registration itself is what makes it feel
    // immediate: the response to the join already carries `STARTING`.
    //
    // Failure is swallowed deliberately. The scheduler checks the same
    // condition every tick, so the worst case is the countdown beginning a few
    // seconds later — and a player who successfully joined must not be handed
    // an error because an optimisation did not come off.
    await tournamentLifecycleService.startEarlyIfFull(row).catch((error: unknown) => {
      logger.exception('starting a full tournament early failed', error, { tournamentId });
      return false;
    });

    return this.get(tournamentId, user.id);
  }

  /**
   * Withdraws the caller.
   *
   * Only while registration is open. Past that the roster has been counted —
   * by the bot fill, by the seeder — and removing somebody would leave a hole
   * in a draw that has already been made. Somebody who changes their mind
   * later simply does not check in, which the tournament already handles.
   */
  async withdraw(tournamentId: string, userId: string): Promise<AutoTournamentDto> {
    const row = await this.row(tournamentId);
    if (!row) throw errors.notFound('That tournament does not exist.');

    if (row.status !== AUTO_TOURNAMENT_STATUS.registration) {
      throw errors.invalidAction('It is too late to withdraw from this tournament.');
    }

    // Both pre-bracket statuses, because which one a registration holds now
    // depends on a configuration flag: with check-in off a join is written
    // straight to `checkedIn`, and filtering on `registered` alone would mean
    // nobody could ever withdraw.
    const removed = await TournamentRegistration.updateOne(
      {
        tournamentId,
        userId,
        status: { $in: [REGISTRATION_STATUS.registered, REGISTRATION_STATUS.checkedIn] },
      },
      { $set: { status: REGISTRATION_STATUS.withdrawn, checkedInAt: null } },
    ).exec();

    if ((removed.modifiedCount ?? 0) === 0) {
      throw errors.invalidAction('You are not registered for that tournament.');
    }

    const counts = await tournamentBotFillService.refreshCounts(tournamentId);

    announceTournament('registrationUpdated', {
      ...tournamentRef(row, row.status),
      humanPlayerCount: counts.humans,
      botPlayerCount: counts.bots,
      totalPlayers: counts.humans + counts.bots,
    });

    return this.get(tournamentId, userId);
  }

  /**
   * Confirms the caller is present for a tournament about to start.
   *
   * ## Why this still exists with check-in disabled
   *
   * Because clients in the wild call it. An app that shows a "I'm ready"
   * button and gets a 400 back has a broken screen, and the honest answer to
   * "am I confirmed?" is now *yes, since you joined* — so the endpoint returns
   * that rather than an error. It stays a real confirmation when the flag is
   * on.
   *
   * The write below is conditional on the row still being `REGISTERED`, so
   * checking in twice is a no-op and checking in after the scheduler has
   * written somebody off as a no-show fails honestly rather than resurrecting
   * them into a bracket that has been drawn.
   */
  async checkIn(tournamentId: string, userId: string): Promise<AutoTournamentDto> {
    const row = await this.row(tournamentId);
    if (!row) throw errors.notFound('That tournament does not exist.');

    if (!env.tournament.checkInEnabled) {
      const registration = await TournamentRegistration.findOne({ tournamentId, userId })
        .lean()
        .exec();

      if (!registration) throw errors.invalidAction('You are not in that tournament.');

      // Already confirmed by joining. Nothing to write, and nothing to refuse.
      return this.get(tournamentId, userId);
    }

    if (row.status !== AUTO_TOURNAMENT_STATUS.checkIn) {
      throw errors.invalidAction(
        row.status === AUTO_TOURNAMENT_STATUS.registration
          ? 'Check-in has not opened yet.'
          : 'Check-in has closed for this tournament.',
      );
    }

    const confirmed = await TournamentRegistration.updateOne(
      { tournamentId, userId, status: REGISTRATION_STATUS.registered },
      { $set: { status: REGISTRATION_STATUS.checkedIn, checkedInAt: new Date() } },
    ).exec();

    if ((confirmed.modifiedCount ?? 0) === 0) {
      const already = await TournamentRegistration.findOne({ tournamentId, userId })
        .lean()
        .exec();

      if (!already) throw errors.invalidAction('You are not registered for that tournament.');
      if (already.checkedInAt) return this.get(tournamentId, userId);

      throw errors.invalidAction('You can no longer check in for that tournament.');
    }

    logger.info('tournament check-in', { tournamentId, userId });
    return this.get(tournamentId, userId);
  }

  // ------------------------------------------------------------------ inner

  /** One tournament row, or null. */
  private async row(tournamentId: string): Promise<AutoTournamentDocument | null> {
    if (!isObjectId(tournamentId)) return null;
    return (await AutoTournament.findById(tournamentId)
      .lean()
      .exec()) as AutoTournamentDocument | null;
  }

  /**
   * The caller's own registrations across a set of tournaments.
   *
   * Keyed by tournament id, because a player may hold a place in every
   * tournament on the screen and each card needs its own answer. One query for
   * the whole listing — `{userId, tournamentId}` is indexed for it.
   *
   * Withdrawn rows come back rather than being filtered out: the viewer state
   * needs to tell "never joined" from "joined and left", and only the second
   * of those has a row to re-take.
   */
  private async registrationsOf(
    userId: string,
    tournamentIds: string[],
  ): Promise<Map<string, TournamentRegistrationDocument>> {
    const found = new Map<string, TournamentRegistrationDocument>();
    if (!isObjectId(userId) || tournamentIds.length === 0) return found;

    const rows = (await TournamentRegistration.find({
      userId,
      tournamentId: { $in: tournamentIds },
    })
      .lean()
      .exec()) as TournamentRegistrationDocument[];

    for (const entry of rows) found.set(String(entry.tournamentId), entry);
    return found;
  }

  /** The caller's registration in one tournament, or null. */
  private async registrationOf(
    userId: string,
    tournamentId: string,
  ): Promise<TournamentRegistrationDocument | null> {
    if (!isObjectId(userId)) return null;

    return (await TournamentRegistration.findOne({ userId, tournamentId })
      .lean()
      .exec()) as TournamentRegistrationDocument | null;
  }

  /**
   * Why a tournament cannot be joined, in a sentence to show somebody.
   *
   * ## Why each of these is a different sentence
   *
   * Because they lead somewhere different. A tournament that has not opened
   * yet is one to come back to — and the card is already showing when. One
   * that closed is one to miss and move on from. A finished one is a result to
   * read. "You cannot join this tournament" would be true of all three and
   * useful for none of them.
   */
  private whyNotJoinable(row: AutoTournamentDocument): string {
    switch (row.status) {
      case AUTO_TOURNAMENT_STATUS.upcoming:
        return 'Registration for this tournament has not opened yet.';
      case AUTO_TOURNAMENT_STATUS.starting:
      case AUTO_TOURNAMENT_STATUS.checkIn:
        return 'Registration has closed for this tournament.';
      case AUTO_TOURNAMENT_STATUS.running:
        return 'This tournament has already started.';
      case AUTO_TOURNAMENT_STATUS.completed:
        return 'This tournament has finished.';
      case AUTO_TOURNAMENT_STATUS.cancelled:
        return 'This tournament was cancelled.';
      default:
        return 'This tournament is not taking entries.';
    }
  }

  /** One tournament as a DTO, with the caller's state folded in. */
  private async toDto(
    row: AutoTournamentDocument,
    viewerId: string | null,
    registrations: Map<string, TournamentRegistrationDocument>,
  ): Promise<AutoTournamentDto> {
    const tournamentId = String(row._id);

    // Only for a tournament that finished before the snapshot fields existed.
    // A completed one carries its winner on the row — see the snapshot note in
    // the model — so that a result keeps the name it was won under.
    const winner =
      row.winnerRegistrationId && !row.winnerDisplayName
        ? ((await TournamentRegistration.findById(row.winnerRegistrationId)
            .lean()
            .exec()) as TournamentRegistrationDocument | null)
        : null;

    const held = registrations.get(tournamentId) ?? null;

    // A withdrawn row is not a place. Its holder is treated as somebody who is
    // not in this tournament, which is what lets them join again while the
    // window is still open.
    const mine = held && held.status !== REGISTRATION_STATUS.withdrawn ? held : null;

    if (!mine) {
      // Nothing about another tournament blocks this one any more, so the only
      // reasons left are about this tournament's own state — which its status
      // and its clock already say. A card outside its registration window does
      // not need a sentence explaining that it is outside its registration
      // window.
      return toTournamentDto({
        row,
        viewerId,
        viewer: anonymousViewerState(row, null),
        winner,
      });
    }

    const activeMatch = (await TournamentMatch.findOne({
      tournamentId,
      status: { $in: [MATCH_STATUS.ready, MATCH_STATUS.running] },
      $or: [{ slotA: mine._id }, { slotB: mine._id }],
    })
      .sort({ roundNumber: -1 })
      .lean()
      .exec()) as TournamentMatchDocument | null;

    return toTournamentDto({
      row,
      viewerId,
      viewer: participantViewerState({ row, registration: mine, activeMatch }),
      winner,
    });
  }
}

export const autoTournamentService = new AutoTournamentService();
