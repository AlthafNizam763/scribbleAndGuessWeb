import type { NextResponse } from 'next/server';

import { connectToDatabase } from '@/config/database';
import { XP_HISTORY_LIMITS } from '@/constants/progression.constants';
import { PAGE_LIMITS } from '@/constants/social.constants';
import { requireUser } from '@/middleware/auth.middleware';
import { ok } from '@/middleware/error.middleware';
import { clientIdentity, enforceHttpLimit } from '@/middleware/rateLimit.middleware';
import { parseQuery } from '@/middleware/validation.middleware';
import { progressionRepository } from '@/repositories/progression.repository';
import { userRepository } from '@/repositories/user.repository';
import { achievementService } from '@/services/achievement.service';
import { describeLevel } from '@/services/xp.service';
import type { XpEventDto, XpHistoryPageDto } from '@/types/progression.types';
import { pageQuerySchema } from '@/validators/social.validator';

/**
 * XP, levels and achievements over REST.
 *
 * ## Every route here is a read
 *
 * There is no endpoint in this file that changes anything, and that is the
 * point: XP is awarded by the game engine from facts it owns, and achievements
 * unlock as a consequence. A client has nothing to send — which is the whole
 * of "prevent XP manipulation" and "prevent duplicate achievement rewards" at
 * this layer.
 *
 * ## Whose progression can be read
 *
 * The caller's own, and anybody's achievements. Achievements are public the
 * way the leaderboard is public — a trophy nobody can see is not a trophy —
 * whereas the XP *history* is the caller's alone, because it is an itemised
 * record of when somebody played and for how long.
 */
export const progressionController = {
  /** `GET /api/progression/me` — level, XP and the whole catalogue. */
  async me(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('progressionRead', clientIdentity(request, user.id));

    await connectToDatabase();

    const [row, achievements] = await Promise.all([
      userRepository.findById(user.id),
      achievementService.listFor(user.id),
    ]);

    return ok({
      level: describeLevel(row?.xp ?? 0),
      achievements,
    });
  },

  /**
   * `GET /api/achievements?userId=` — the catalogue, for anybody.
   *
   * Defaults to the caller. A stranger's id returns their unlocks against the
   * same catalogue, which is what lets a profile screen show somebody else's
   * badges without a second endpoint.
   */
  async achievements(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('progressionRead', clientIdentity(request, user.id));

    await connectToDatabase();

    const target = new URL(request.url).searchParams.get('userId')?.trim();
    const userId = target && target.length > 0 ? target : user.id;

    return ok(await achievementService.listFor(userId));
  },

  /** `GET /api/progression/xp?page=&limit=` — the caller's own history. */
  async xpHistory(request: Request): Promise<NextResponse> {
    const user = await requireUser(request);
    enforceHttpLimit('progressionRead', clientIdentity(request, user.id));

    await connectToDatabase();

    const parsed = parseQuery(request, pageQuerySchema);
    const page = Math.min(Math.max(1, parsed.page), PAGE_LIMITS.maxPage);
    const limit = Math.min(
      Math.max(1, parsed.limit ?? XP_HISTORY_LIMITS.defaultLimit),
      XP_HISTORY_LIMITS.maxLimit,
    );
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      progressionRepository.listXp(user.id, limit, skip),
      progressionRepository.countXp(user.id),
    ]);

    const items: XpEventDto[] = rows.map((row) => ({
      id: String(row._id),
      reason: String(row.reason),
      amount: row.amount ?? 0,
      count: row.count ?? 1,
      balanceAfter: row.balanceAfter ?? 0,
      atMs: ((row as { createdAt?: Date }).createdAt ?? new Date()).getTime(),
    }));

    const body: XpHistoryPageDto = {
      items,
      total,
      page,
      limit,
      hasMore: skip + items.length < total,
    };

    return ok(body);
  },
};
