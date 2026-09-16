import { env } from '@/config/env';
import {
  ACTIVE_PARTICIPATION_STATUSES,
  AUTO_TOURNAMENT_STATUS,
  MATCH_STATUS,
  PLAYER_TYPE,
  REGISTRATION_STATUS,
  SLOT_HOLDING_STATUSES,
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
import { announceTournament } from '@/services/tournament/notify';
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
 * ## The one-tournament-at-a-time rule
 *
 * Enforced here, at registration, by a query over the caller's own rows. It is
 * a product rule rather than a technical one: a player in two brackets at once
 * would eventually be called to two matches at the same moment, and one of
 * them would have to be a walkover. Refusing at the door is kinder than
 * eliminating them from something they had no way to attend.
 */

export class AutoTournamentService {
  // ------------------------------------------------------------------ reads

  /**
   * The slots, as the listing screen draws them.
   *
   * One row per slot, holding the tournament in it or nothing. A slot with no
   * live tournament is *present and empty* rather than missing, because the
   * screen shows three cards and "a new tournament will be created
   * automatically" is a card, not an absence.
   */
  async listSlots(viewerId: string | null): Promise<{
    slots: { slotNumber: number; tournament: AutoTournamentDto | null }[];
  }> {
    const live = (await AutoTournament.find({
      isAutomatic: true,
      status: { $in: [...SLOT_HOLDING_STATUSES] },
    })
      .sort({ slotNumber: 1 })
      .lean()
      .exec()) as AutoTournamentDocument[];

    // Where the caller already is, resolved once for the whole listing rather
    // than per row. It is the same answer for all three, and it is what every
    // row's `blockedReason` is computed from.
    const engagement = viewerId ? await this.currentEngagement(viewerId) : null;

    const slotCount = Math.max(
      live.reduce((highest, row) => Math.max(highest, row.slotNumber), 0),
      // The configured count and the highest live slot, whichever is larger:
      // a deployment that reduced its slot count still shows the tournaments
      // already running in the slots it no longer creates into.
      env.tournament.slotCount,
    );

    const bySlot = new Map(live.map((row) => [row.slotNumber, row]));

    const slots = await Promise.all(
      Array.from({ length: slotCount }, (_, index) => index + 1).map(async (slotNumber) => {
        const row = bySlot.get(slotNumber);
        return {
          slotNumber,
          tournament: row ? await this.toDto(row, viewerId, engagement) : null,
        };
      }),
    );

    return { slots };
  }

  /** Everything currently running. */
  async listActive(viewerId: string | null): Promise<AutoTournamentDto[]> {
    return this.listByStatus(viewerId, [AUTO_TOURNAMENT_STATUS.running]);
  }

  /** Everything accepting players, or about to. */
  async listUpcoming(viewerId: string | null): Promise<AutoTournamentDto[]> {
    return this.listByStatus(viewerId, [
      AUTO_TOURNAMENT_STATUS.upcoming,
      AUTO_TOURNAMENT_STATUS.registration,
      AUTO_TOURNAMENT_STATUS.checkIn,
    ]);
  }

  private async listByStatus(
    viewerId: string | null,
    statuses: string[],
  ): Promise<AutoTournamentDto[]> {
    const rows = (await AutoTournament.find({ isAutomatic: true, status: { $in: statuses } })
      .sort({ slotNumber: 1 })
      .lean()
      .exec()) as AutoTournamentDocument[];

    const engagement = viewerId ? await this.currentEngagement(viewerId) : null;
    return Promise.all(rows.map((row) => this.toDto(row, viewerId, engagement)));
  }

  /** One tournament, or null when the id names something else entirely. */
  async find(tournamentId: string, viewerId: string | null): Promise<AutoTournamentDto | null> {
    const row = await this.row(tournamentId);
    if (!row) return null;

    const engagement = viewerId ? await this.currentEngagement(viewerId) : null;
    return this.toDto(row, viewerId, engagement);
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
   * Registers the caller.
   *
   * Four refusals, in the order that gives the most useful message first:
   * the tournament is not taking entries, the caller is already in one, the
   * caller is already in *this* one, and it is full.
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
      throw errors.invalidAction(
        row.status === AUTO_TOURNAMENT_STATUS.checkIn
          ? 'Registration has closed for this tournament.'
          : 'This tournament is not taking entries.',
      );
    }

    const existing = await this.currentEngagement(user.id);
    if (existing) {
      if (String(existing.tournamentId) === tournamentId) {
        // Already in. A no-op rather than an error: the caller is registered
        // either way, and a double tap should not read as a failure.
        return this.get(tournamentId, user.id);
      }
      throw errors.invalidAction(
        `You are already in ${existing.tournamentName}. You can join another once it finishes.`,
      );
    }

    const taken = await TournamentRegistration.countDocuments({
      tournamentId,
      status: { $ne: REGISTRATION_STATUS.withdrawn },
    }).exec();

    if (taken >= row.maxPlayers) throw errors.invalidAction('That tournament is full.');

    try {
      await TournamentRegistration.create({
        tournamentId,
        userId: user.id,
        botId: null,
        displayName: user.username,
        avatarId: user.avatarId,
        avatarColorIndex: user.avatarColorIndex,
        playerType: PLAYER_TYPE.human,
        isBot: false,
        botDifficulty: null,
        status: REGISTRATION_STATUS.registered,
      });
    } catch (error) {
      // The unique index caught a double tap that raced the check above.
      // Registered either way.
      if ((error as { code?: number }).code !== 11000) throw error;
    }

    const counts = await tournamentBotFillService.refreshCounts(tournamentId);

    announceTournament('registrationUpdated', {
      tournamentId,
      slotNumber: row.slotNumber,
      humanPlayerCount: counts.humans,
      botPlayerCount: counts.bots,
      totalPlayers: counts.humans + counts.bots,
    });

    logger.info('tournament registration', { tournamentId, userId: user.id });
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

    const removed = await TournamentRegistration.updateOne(
      { tournamentId, userId, status: REGISTRATION_STATUS.registered },
      { $set: { status: REGISTRATION_STATUS.withdrawn } },
    ).exec();

    if ((removed.modifiedCount ?? 0) === 0) {
      throw errors.invalidAction('You are not registered for that tournament.');
    }

    const counts = await tournamentBotFillService.refreshCounts(tournamentId);

    announceTournament('registrationUpdated', {
      tournamentId,
      slotNumber: row.slotNumber,
      humanPlayerCount: counts.humans,
      botPlayerCount: counts.bots,
      totalPlayers: counts.humans + counts.bots,
    });

    return this.get(tournamentId, userId);
  }

  /**
   * Confirms the caller is present for a tournament about to start.
   *
   * The write is conditional on the row still being `REGISTERED`, so checking
   * in twice is a no-op and checking in after the scheduler has already
   * written somebody off as a no-show fails honestly rather than resurrecting
   * them into a bracket that has been drawn.
   */
  async checkIn(tournamentId: string, userId: string): Promise<AutoTournamentDto> {
    const row = await this.row(tournamentId);
    if (!row) throw errors.notFound('That tournament does not exist.');

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
   * The live tournament this player is already in, if any.
   *
   * One query against `{userId, status}`, which is indexed for exactly this.
   * Asked on every registration attempt and once per listing — never once per
   * row, which is why the listing resolves it up front and passes it down.
   */
  private async currentEngagement(userId: string): Promise<{
    tournamentId: string;
    tournamentName: string;
    registration: TournamentRegistrationDocument;
  } | null> {
    if (!isObjectId(userId)) return null;

    const rows = (await TournamentRegistration.find({
      userId,
      status: {
        $in: [
          REGISTRATION_STATUS.registered,
          REGISTRATION_STATUS.checkedIn,
          REGISTRATION_STATUS.active,
        ],
      },
    })
      .lean()
      .exec()) as TournamentRegistrationDocument[];

    if (rows.length === 0) return null;

    // A registration row outlives its tournament — a cancelled tournament
    // clears them, but a crash between the two would leave one behind — so the
    // tournament's own status is what decides whether this still counts. That
    // is also what stops a stale row locking somebody out for ever.
    const tournaments = (await AutoTournament.find({
      _id: { $in: rows.map((entry) => entry.tournamentId) },
      status: { $in: [...ACTIVE_PARTICIPATION_STATUSES] },
    })
      .lean()
      .exec()) as AutoTournamentDocument[];

    const live = tournaments[0];
    if (!live) return null;

    const registration = rows.find(
      (entry) => String(entry.tournamentId) === String(live._id),
    );
    if (!registration) return null;

    return {
      tournamentId: String(live._id),
      tournamentName: live.name,
      registration,
    };
  }

  /** One tournament as a DTO, with the caller's state folded in. */
  private async toDto(
    row: AutoTournamentDocument,
    viewerId: string | null,
    engagement: Awaited<ReturnType<AutoTournamentService['currentEngagement']>>,
  ): Promise<AutoTournamentDto> {
    const tournamentId = String(row._id);

    const winner = row.winnerRegistrationId
      ? ((await TournamentRegistration.findById(row.winnerRegistrationId)
          .lean()
          .exec()) as TournamentRegistrationDocument | null)
      : null;

    const mine =
      engagement && engagement.tournamentId === tournamentId ? engagement.registration : null;

    if (!mine) {
      const blockedReason =
        engagement && row.status === AUTO_TOURNAMENT_STATUS.registration
          ? `You are already in ${engagement.tournamentName}.`
          : null;

      return toTournamentDto({
        row,
        viewerId,
        viewer: anonymousViewerState(row, blockedReason),
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
