import { request } from '@/web/api';
import type {
  AchievementsPageDto,
  MatchProgressionDto,
  ProgressionDto,
  XpHistoryPageDto,
} from '@/types/progression.types';

/**
 * The XP, level and achievement endpoints.
 *
 * ## Every call here is a read
 *
 * There is nothing in this file that writes, because there is no endpoint that
 * would accept one: XP is awarded by the game engine from facts it owns, and
 * achievements unlock as a consequence. A browser tab has nothing to send —
 * which is the whole of "prevent XP manipulation" at this layer.
 *
 * Like `rooms.ts` and `notifications.ts`, it owns no rules.
 */

export type { AchievementsPageDto, MatchProgressionDto, ProgressionDto, XpHistoryPageDto };

/** The caller's level and full achievement catalogue, in one read. */
export function fetchProgression(token: string): Promise<ProgressionDto> {
  return request<ProgressionDto>('/api/progression/me', { token });
}

/**
 * The catalogue for one player, or the caller when `userId` is omitted.
 *
 * Locked entries come back too: the screen is a list of things to aim at, not
 * only a trophy case.
 */
export function fetchAchievements(
  token: string,
  userId?: string,
): Promise<AchievementsPageDto> {
  const suffix = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  return request<AchievementsPageDto>(`/api/achievements${suffix}`, { token });
}

/** A page of the caller's own XP history, newest first. */
export function fetchXpHistory(
  token: string,
  page = 1,
  limit = 25,
): Promise<XpHistoryPageDto> {
  return request<XpHistoryPageDto>(
    `/api/progression/xp?page=${page}&limit=${limit}`,
    { token },
  );
}
