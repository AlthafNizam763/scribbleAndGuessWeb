import { PAGE_LIMITS, REPORT_STATUS, canModerate, type ReportStatusWire } from '@/constants/social.constants';
import { Report } from '@/models/Report';
import { userRepository } from '@/repositories/user.repository';
import { toUserSummary, type RankableUser } from '@/services/profile.serialize';
import type { UserSummaryDto } from '@/types/social.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * The review queue behind the report button (brief section: Moderation).
 *
 * ## Why this is a separate service from `moderation.service`
 *
 * That one is in-game enforcement: kicking, banning, muting, and *filing* a
 * report. This is what happens afterwards, and it has a different audience and
 * a different permission. Keeping them apart means the in-game path has no
 * reason to import anything that can read the whole report collection.
 *
 * ## Nothing here is visible to a player
 *
 * Not to the reported account, and not to the reporter either. A report a
 * player could read back is a harassment channel of its own — "I reported you"
 * is the message, and the feature would be used to send it. Every route into
 * this service is behind `canModerate`.
 */

/** One report, as a reviewer sees it. */
export interface ReportReviewDto {
  id: string;
  reason: string;
  status: ReportStatusWire;
  reportedUser: UserSummaryDto | null;
  reporter: UserSummaryDto | null;
  roomId: string;
  gameId: string | null;
  createdAtMs: number;
  reviewedAtMs: number | null;
  reviewNote: string;
  /**
   * How many reports this account has attracted in total.
   *
   * The number that actually decides a case. One report is an argument; five
   * from five different rooms is a pattern, and a reviewer should not have to
   * run a second query to see the difference.
   */
  reportsAgainstTarget: number;
}

export class ReportReviewService {
  /** Refuses anybody who is not a moderator. */
  private async assertModerator(userId: string): Promise<void> {
    const user = await userRepository.findById(userId);

    if (!canModerate(user?.role)) {
      // Deliberately `NOT_FOUND` rather than a refusal: an ordinary player
      // probing the admin routes should not be able to tell that they exist.
      throw errors.notFound('Not found.');
    }
  }

  /**
   * One page of the review queue.
   *
   * Pending first and oldest first, because a queue is worked through rather
   * than browsed — the report nobody has looked at longest is the one that
   * matters most.
   */
  async list(input: {
    actorId: string;
    status?: ReportStatusWire;
    page: number;
    limit: number;
  }): Promise<{ items: ReportReviewDto[]; total: number; page: number; hasMore: boolean }> {
    await this.assertModerator(input.actorId);

    const page = Math.min(Math.max(1, input.page), PAGE_LIMITS.maxPage);
    const limit = Math.min(Math.max(1, input.limit), PAGE_LIMITS.maxLimit);
    const skip = (page - 1) * limit;

    const filter = input.status ? { status: input.status } : {};

    const [rows, total] = await Promise.all([
      Report.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean().exec(),
      Report.countDocuments(filter).exec(),
    ]);

    // Both parties and the per-target tally, gathered in three queries rather
    // than three per row.
    const userIds = [
      ...new Set(
        rows.flatMap((row) => [String(row.reportedUserId), String(row.reporterUserId)]),
      ),
    ];

    const [users, tallies] = await Promise.all([
      userRepository.findManyByIds(userIds),
      this.talliesFor([...new Set(rows.map((row) => String(row.reportedUserId)))]),
    ]);

    const byId = new Map(users.map((user) => [String(user._id), user]));

    const items = rows.map<ReportReviewDto>((row) => {
      const reported = byId.get(String(row.reportedUserId));
      const reporter = byId.get(String(row.reporterUserId));

      return {
        id: String(row._id),
        reason: row.reason,
        status: (row.status ?? REPORT_STATUS.pending) as ReportStatusWire,
        reportedUser: reported ? toUserSummary(reported as RankableUser) : null,
        reporter: reporter ? toUserSummary(reporter as RankableUser) : null,
        roomId: String(row.roomId),
        gameId: row.gameId ? String(row.gameId) : null,
        createdAtMs: (row.createdAt ?? new Date()).getTime(),
        reviewedAtMs: row.reviewedAt ? new Date(row.reviewedAt).getTime() : null,
        reviewNote: row.reviewNote ?? '',
        reportsAgainstTarget: tallies.get(String(row.reportedUserId)) ?? 0,
      };
    });

    return { items, total, page, hasMore: skip + items.length < total };
  }

  /** How many reports each of these accounts has attracted, in one query. */
  private async talliesFor(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();

    const rows = await Report.aggregate<{ _id: unknown; count: number }>([
      { $match: { reportedUserId: { $in: userIds.map((id) => id) } } },
      { $group: { _id: '$reportedUserId', count: { $sum: 1 } } },
    ]).exec();

    return new Map(rows.map((row) => [String(row._id), row.count]));
  }

  /**
   * Resolves one report.
   *
   * Upholding a report does not itself punish anybody — there is no automatic
   * ban here, deliberately. An account that should be removed is removed by an
   * operator who looked at it; a status that could ban would make the report
   * button a weapon, which is exactly what the queue exists to prevent.
   */
  async resolve(input: {
    actorId: string;
    reportId: string;
    status: ReportStatusWire;
    note?: string;
  }): Promise<{ id: string; status: ReportStatusWire; reviewedAtMs: number }> {
    await this.assertModerator(input.actorId);

    if (input.status === REPORT_STATUS.pending) {
      throw errors.validation('Resolve a report as actioned or dismissed.');
    }

    const updated = await Report.findByIdAndUpdate(
      input.reportId,
      {
        $set: {
          status: input.status,
          reviewedBy: input.actorId,
          reviewedAt: new Date(),
          reviewNote: (input.note ?? '').trim().slice(0, 280),
        },
      },
      { new: true },
    )
      .lean()
      .exec();

    if (!updated) throw errors.notFound('That report does not exist.');

    logger.info('report resolved', {
      reportId: input.reportId,
      status: input.status,
      by: input.actorId,
    });

    // Just the acknowledgement. Re-serialising the whole row would mean
    // another three queries to rebuild both user cards and the tally, for a
    // response whose only job is to let the queue drop a row.
    return {
      id: String(updated._id),
      status: input.status,
      reviewedAtMs: (updated.reviewedAt ?? new Date()).getTime(),
    };
  }

  /** How many reports are waiting, for a queue badge. */
  async pendingCount(actorId: string): Promise<number> {
    await this.assertModerator(actorId);
    return Report.countDocuments({ status: REPORT_STATUS.pending }).exec();
  }
}

export const reportReviewService = new ReportReviewService();
