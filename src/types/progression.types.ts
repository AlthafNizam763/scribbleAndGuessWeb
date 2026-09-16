/**
 * What the progression endpoints put on the wire.
 *
 * The same discipline as `social.types.ts`: these are what a *client* may see.
 * Note in particular that nothing here is writable — there is no request shape
 * in this file, because there is no endpoint by which a client sends XP, a
 * level, a counter or an unlock. Every one of them is server-computed.
 */

/** Where a player is on the curve. */
export interface LevelDto {
  level: number;
  /** The tier name, e.g. `Artist`. */
  title: string;
  /** Lifetime XP. */
  xp: number;
  /** Total XP at which the current level began. */
  levelStartXp: number;
  /** Total XP at which the next level begins, or null at the cap. */
  nextLevelXp: number | null;
  /** XP earned inside the current level. */
  xpIntoLevel: number;
  /** XP the current level spans, or null at the cap. */
  xpForNextLevel: number | null;
  /** 0..1 through the current level. 1 at the cap, so a bar renders full. */
  progress: number;
  /** Whether this player is at [MAX_LEVEL]. */
  isMaxLevel: boolean;
}

/** One achievement, as a client renders it — locked or not. */
export interface AchievementDto {
  key: string;
  name: string;
  description: string;
  /** XP paid on unlock. Shown on the locked card as an incentive. */
  xpReward: number;
  unlocked: boolean;
  /** When it unlocked, or null while locked. */
  unlockedAtMs: number | null;
  /** Where the watched counter stands now. */
  progress: number;
  /** What it has to reach. */
  target: number;
  /** Whether a progress bar says anything useful for this one. */
  showProgress: boolean;
}

/** The trophy case plus the summary line above it. */
export interface AchievementsPageDto {
  items: AchievementDto[];
  unlockedCount: number;
  totalCount: number;
}

/** One row of the XP history. */
export interface XpEventDto {
  id: string;
  reason: string;
  amount: number;
  count: number;
  balanceAfter: number;
  atMs: number;
}

/** A page of the XP history. */
export interface XpHistoryPageDto {
  items: XpEventDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/** Everything the progression screen needs, in one read. */
export interface ProgressionDto {
  level: LevelDto;
  achievements: AchievementsPageDto;
}

/**
 * What one finished match paid out, for the result screen.
 *
 * Returned by the end-of-match hook and broadcast with the game result, so the
 * client can animate what was earned without a second request. It is a
 * *report* of writes already made, never an instruction — the client cannot
 * decline it or alter it.
 */
export interface MatchProgressionDto {
  playerId: string;
  xpEarned: number;
  level: LevelDto;
  /** True when this match crossed a level boundary. */
  leveledUp: boolean;
  /** Achievements this match unlocked, if any. */
  unlocked: AchievementDto[];
}
