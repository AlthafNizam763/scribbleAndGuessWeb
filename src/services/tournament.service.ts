import { TOURNAMENT_LIMITS, TOURNAMENT_STATUS, type TournamentStatusWire } from '@/constants/tournament.constants';
import { Tournament, TournamentEntry, type TournamentDocument } from '@/models/Tournament';
import { isObjectId, userRepository } from '@/repositories/user.repository';
import { toUserSummary, type RankableUser } from '@/services/profile.serialize';
import type { UserSummaryDto } from '@/types/social.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Tournaments: registration, scoring and the board.
 *
 * ## Status is derived, never stored
 *
 * Three timestamps decide everything. A stored status column would be wrong
 * for every tournament between the moment one opens and the moment a job
 * noticed — and would require that job to exist at all. Deriving it means the
 * answer is always current, and the feature needs no scheduler.
 *
 * ## A score here is the same score as everywhere else
 *
 * The game engine calls `recordMatch` when a match finishes, with the score it
 * already computed. There is no separate tournament scoring, no client-supplied
 * total, and no endpoint that writes a score — which is the whole of "validate
 * tournament scores on the backend": the number never leaves the server's
 * control in the first place.
 */

export interface TournamentDto {
  id: string;
  name: string;
  description: string;
  format: string;
  gameMode: string;
  categories: string[];
  status: TournamentStatusWire;
  registerFromMs: number;
  startsAtMs: number;
  endsAtMs: number;
  rewardXp: number;
  rewardBadgeKey: string | null;
  entrantCount: number;
  /** Whether the caller has registered. */
  isRegistered: boolean;
  winner: UserSummaryDto | null;
}

export interface TournamentRowDto extends UserSummaryDto {
  rank: number;
  score: number;
  matchesPlayed: number;
  matchesWon: number;
  isSelf: boolean;
}

export class TournamentService {
  /**
   * Where a tournament is, from the clock alone.
   *
   * The order of the checks matters: `finished` is tested first so a closed
   * tournament never reads as live because two timestamps overlap in a badly
   * configured row.
   */
  statusOf(tournament: { registerFrom: Date; startsAt: Date; endsAt: Date }, now = Date.now()): TournamentStatusWire {
    if (now >= tournament.endsAt.getTime()) return TOURNAMENT_STATUS.finished;
    if (now >= tournament.startsAt.getTime()) return TOURNAMENT_STATUS.live;
    if (now >= tournament.registerFrom.getTime()) return TOURNAMENT_STATUS.registering;
    return TOURNAMENT_STATUS.announced;
  }

  /** Whether a match finishing now counts towards this tournament. */
  isLive(tournament: { registerFrom: Date; startsAt: Date; endsAt: Date }, now = Date.now()): boolean {
    return this.statusOf(tournament, now) === TOURNAMENT_STATUS.live;
  }

  /** Everything on now or coming up, soonest first. */
  async list(viewerId: string): Promise<TournamentDto[]> {
    const now = new Date();

    const rows = await Tournament.find({ endsAt: { $gte: new Date(now.getTime() - 86_400_000) } })
      .sort({ startsAt: 1 })
      .limit(50)
      .lean()
      .exec();

    return Promise.all(rows.map((row) => this.toDto(row as TournamentDocument, viewerId)));
  }

  /** One tournament. */
  async get(tournamentId: string, viewerId: string): Promise<TournamentDto> {
    if (!isObjectId(tournamentId)) throw errors.notFound('That tournament does not exist.');

    const row = await Tournament.findById(tournamentId).lean().exec();
    if (!row) throw errors.notFound('That tournament does not exist.');

    return this.toDto(row as TournamentDocument, viewerId);
  }

  private async toDto(row: TournamentDocument, viewerId: string): Promise<TournamentDto> {
    const [entrantCount, mine, winner] = await Promise.all([
      TournamentEntry.countDocuments({ tournamentId: row._id }).exec(),
      TournamentEntry.exists({ tournamentId: row._id, userId: viewerId }).exec(),
      row.winnerId ? userRepository.findById(String(row.winnerId)) : Promise.resolve(null),
    ]);

    return {
      id: String(row._id),
      name: row.name,
      description: row.description ?? '',
      format: row.format,
      gameMode: row.gameMode,
      categories: [...(row.categories ?? [])],
      status: this.statusOf(row),
      registerFromMs: row.registerFrom.getTime(),
      startsAtMs: row.startsAt.getTime(),
      endsAtMs: row.endsAt.getTime(),
      rewardXp: row.rewardXp ?? 0,
      rewardBadgeKey: row.rewardBadgeKey ?? null,
      entrantCount,
      isRegistered: mine !== null,
      winner: winner ? toUserSummary(winner as RankableUser) : null,
    };
  }

  /**
   * Registers the caller.
   *
   * Refused once a tournament has ended, and once it is full. Registering
   * while it is *running* is deliberately allowed: a points tournament has no
   * pairings to disturb, and turning somebody away from a weekend event
   * because they heard about it on Saturday afternoon serves nobody.
   */
  async register(tournamentId: string, userId: string): Promise<void> {
    const row = await Tournament.findById(tournamentId).lean().exec();
    if (!row) throw errors.notFound('That tournament does not exist.');

    const status = this.statusOf(row as TournamentDocument);

    if (status === TOURNAMENT_STATUS.finished) {
      throw errors.invalidAction('That tournament has finished.');
    }
    if (status === TOURNAMENT_STATUS.announced) {
      throw errors.invalidAction('Registration has not opened yet.');
    }

    const entrants = await TournamentEntry.countDocuments({ tournamentId }).exec();
    if (entrants >= TOURNAMENT_LIMITS.maxEntrants) {
      throw errors.invalidAction('That tournament is full.');
    }

    try {
      await TournamentEntry.create({ tournamentId, userId });
      logger.info('tournament registration', { tournamentId, userId });
    } catch (error) {
      // The unique index caught a double tap. Registering twice is a no-op,
      // not an error — the caller is registered either way.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }

  /**
   * Folds one finished match into every live tournament the player is in.
   *
   * Called by the game engine with the score it already computed. `$inc` so
   * two matches finishing at once for one player cannot lose an increment —
   * the same reasoning as `recordGameResult`.
   *
   * Only *ranked* matches should reach here; the caller decides that, because
   * it is the caller that knows the mode.
   */
  async recordMatch(input: {
    userId: string;
    score: number;
    won: boolean;
  }): Promise<number> {
    const now = new Date();

    // Live tournaments only: a match played after the window closed does not
    // count, however long the room had been open.
    const live = await Tournament.find({
      startsAt: { $lte: now },
      endsAt: { $gt: now },
    })
      .select({ _id: 1 })
      .lean()
      .exec();

    if (live.length === 0) return 0;

    const result = await TournamentEntry.updateMany(
      {
        tournamentId: { $in: live.map((row) => row._id) },
        userId: input.userId,
      },
      {
        $inc: {
          score: Math.max(0, input.score),
          matchesPlayed: 1,
          matchesWon: input.won ? 1 : 0,
        },
      },
    ).exec();

    return result.modifiedCount ?? 0;
  }

  /** One page of a tournament's board. */
  async board(input: {
    tournamentId: string;
    viewerId: string;
    page: number;
    limit: number;
  }): Promise<{ items: TournamentRowDto[]; total: number; page: number; hasMore: boolean }> {
    const page = Math.max(1, input.page);
    const limit = Math.min(Math.max(1, input.limit), TOURNAMENT_LIMITS.maxLimit);
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      TournamentEntry.find({ tournamentId: input.tournamentId })
        .sort({ score: -1, matchesWon: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      TournamentEntry.countDocuments({ tournamentId: input.tournamentId }).exec(),
    ]);

    const users = await userRepository.findManyByIds(rows.map((row) => String(row.userId)));
    const byId = new Map(users.map((user) => [String(user._id), user]));

    const items = rows.map<TournamentRowDto>((row, index) => {
      const user = byId.get(String(row.userId));
      const summary = user
        ? toUserSummary(user as RankableUser)
        : { id: String(row.userId), username: '', avatarId: 0, avatarColorIndex: 0 };

      return {
        ...summary,
        // Absolute within the tournament rather than within the page, so a
        // row means the same thing however it was paged to.
        rank: skip + index + 1,
        score: row.score ?? 0,
        matchesPlayed: row.matchesPlayed ?? 0,
        matchesWon: row.matchesWon ?? 0,
        isSelf: String(row.userId) === input.viewerId,
      };
    });

    return { items, total, page, hasMore: skip + items.length < total };
  }

  /**
   * Closes a finished tournament and records its winner.
   *
   * Idempotent: a tournament already closed is left alone, so this is safe to
   * call from anywhere — a scheduled sweep, an admin action, or the first read
   * after it ended.
   */
  async close(tournamentId: string): Promise<string | null> {
    const row = await Tournament.findById(tournamentId).lean().exec();
    if (!row) return null;
    if (row.closedAt) return row.winnerId ? String(row.winnerId) : null;

    if (this.statusOf(row as TournamentDocument) !== TOURNAMENT_STATUS.finished) {
      return null;
    }

    const top = await TournamentEntry.findOne({ tournamentId })
      .sort({ score: -1, matchesWon: -1, _id: 1 })
      .lean()
      .exec();

    // A tournament nobody entered still closes — it simply has no winner.
    const winnerId = top?.userId ? String(top.userId) : null;

    await Tournament.updateOne(
      { _id: tournamentId, closedAt: null },
      { $set: { closedAt: new Date(), winnerId } },
    ).exec();

    logger.info('tournament closed', { tournamentId, winnerId });
    return winnerId;
  }
}

export const tournamentService = new TournamentService();
