/**
 * Levels, XP awards and the achievement catalogue.
 *
 * As with `social.constants.ts`, every string here travels on the wire: the
 * clients render an achievement by its key and parse a level from a number, so
 * a value changed here is a protocol change rather than a rename. Worse than
 * that, an achievement key is *stored* — one already unlocked under an old key
 * would be unlocked again under the new one, which is the exact duplicate the
 * feature exists to prevent. Keys are append-only.
 */

// ---------------------------------------------------------------------------
// XP
// ---------------------------------------------------------------------------

/**
 * What each thing a player can do is worth.
 *
 * ## Why these are flat amounts and not a share of the score
 *
 * Score already rewards playing well, and rewarding it twice would make XP a
 * second leaderboard that says the same thing. XP is meant to measure *time
 * invested* rather than skill, so a player who guesses slowly and loses still
 * levels up — just more slowly than one who does not. That is also why
 * `participated` exists at all: finishing a match you lost is still an hour of
 * play, and a system that paid nothing for it would punish losing twice.
 *
 * ## The ones that are defined but not yet awarded
 *
 * `dailyLogin`, `dailyChallenge` and `tournament` have no trigger in the
 * codebase yet — the daily challenge, streak and tournament features are not
 * built. They are declared here rather than in whichever file eventually
 * awards them, so that when those features land the amounts are already
 * balanced against the ones in play instead of being invented locally.
 */
export const XP_AWARDS = {
  /** Reading somebody's drawing correctly. The commonest award by far. */
  correctGuess: 10,
  /** Being the *first* to read it. Paid on top of `correctGuess`. */
  firstCorrectGuess: 5,
  /** Taking a turn as drawer and finishing it. */
  drawingCompleted: 15,
  /** Everybody who could guess your drawing did. On top of `drawingCompleted`. */
  perfectDrawing: 20,
  /** Finishing a match, whatever the result. */
  participated: 25,
  /** Finishing it in first place. Paid on top of `participated`. */
  wonGame: 50,
  /** Finishing a match with at least one friend in it. */
  playedWithFriend: 15,

  // --- declared, not yet awarded; see the note above -----------------------
  dailyLogin: 20,
  dailyChallenge: 75,
  tournament: 100,
} as const;

export type XpReason = keyof typeof XP_AWARDS;

/**
 * The level curve.
 *
 * ## Why a formula rather than a table
 *
 * The brief names five levels — 1, 5, 10, 20, 50 — and a table would have to
 * invent the forty-five between them anyway. A formula gives every level a
 * defined threshold, cannot have a gap, and is trivially checkable: level *n*
 * begins at `LEVEL_BASE_XP * (n - 1)^LEVEL_EXPONENT`, rounded.
 *
 * The exponent is what makes early levels quick and late ones a commitment.
 * At these numbers level 5 is roughly four matches, level 10 about fifteen,
 * level 20 around seventy, and level 50 is a long-haul number — which is the
 * shape the named tiers imply.
 */
export const LEVEL_BASE_XP = 100;
export const LEVEL_EXPONENT = 1.6;

/** The highest level. XP past it still accumulates and still shows. */
export const MAX_LEVEL = 50;

/**
 * The named tiers, as the profile renders them.
 *
 * Sparse on purpose: a player between two tiers carries the lower one's title,
 * so only the levels that *change* the title are listed. Ordered ascending;
 * `titleForLevel` walks it backwards.
 */
export const LEVEL_TITLES: readonly { minLevel: number; title: string }[] = [
  { minLevel: 1, title: 'Beginner' },
  { minLevel: 5, title: 'Sketcher' },
  { minLevel: 10, title: 'Artist' },
  { minLevel: 20, title: 'Master' },
  { minLevel: 50, title: 'Legend' },
] as const;

/**
 * Total XP needed to *reach* [level].
 *
 * Level 1 is zero, so a brand-new account is level 1 rather than level 0 —
 * there is no such thing as an unranked player here.
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(LEVEL_BASE_XP * Math.pow(level - 1, LEVEL_EXPONENT));
}

/**
 * The level [xp] buys, capped at [MAX_LEVEL].
 *
 * ## Why the closed form is not enough on its own
 *
 * `xpForLevel` *rounds*, so its thresholds are integers that sit slightly
 * either side of the real curve. Inverting the un-rounded formula therefore
 * disagrees with it at the boundaries — a player holding exactly the XP that
 * `xpForLevel` says buys level 3 would be reported as level 2, which is the
 * one moment they are most likely to be looking.
 *
 * So the closed form is used as a starting guess and then corrected against
 * `xpForLevel` itself, which makes that function the single definition of
 * where a level begins. The correction moves at most a step or two, so this is
 * still effectively constant time however much XP an account has.
 */
export function levelForXp(xp: number): number {
  if (xp <= 0) return 1;

  let level = Math.floor(Math.pow(xp / LEVEL_BASE_XP, 1 / LEVEL_EXPONENT)) + 1;

  while (level < MAX_LEVEL && xpForLevel(level + 1) <= xp) level += 1;
  while (level > 1 && xpForLevel(level) > xp) level -= 1;

  return Math.min(Math.max(1, level), MAX_LEVEL);
}

/** The title a level carries. */
export function titleForLevel(level: number): string {
  for (let index = LEVEL_TITLES.length - 1; index >= 0; index -= 1) {
    const tier = LEVEL_TITLES[index];
    if (tier && level >= tier.minLevel) return tier.title;
  }
  return LEVEL_TITLES[0]?.title ?? 'Beginner';
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

/**
 * Which counter an achievement watches.
 *
 * Every achievement in this game is "some number reached some threshold", and
 * saying so explicitly is what lets one evaluator handle all of them. The
 * alternative — a predicate per achievement — would mean twelve functions that
 * each have to remember to be idempotent, and the thirteenth would not be.
 *
 * The counters themselves live on the user row and only ever increase, which
 * is what makes re-evaluating an achievement safe: a threshold once crossed
 * stays crossed, so a repeated evaluation is a no-op rather than a second
 * award.
 */
export const ACHIEVEMENT_METRIC = {
  gamesPlayed: 'gamesPlayed',
  gamesWon: 'gamesWon',
  correctGuesses: 'correctGuesses',
  firstGuesses: 'firstGuesses',
  fastGuesses: 'fastGuesses',
  perfectDrawings: 'perfectDrawings',
  bestWinStreak: 'bestWinStreak',
  bestRoundScore: 'bestRoundScore',
  friendCount: 'friendCount',
  dailyChallengesCompleted: 'dailyChallengesCompleted',
  tournamentsWon: 'tournamentsWon',
} as const;

export type AchievementMetric =
  (typeof ACHIEVEMENT_METRIC)[keyof typeof ACHIEVEMENT_METRIC];

/** One entry in the catalogue. */
export interface AchievementDefinition {
  /** Stable, stored, and append-only. Never renamed. */
  key: string;
  name: string;
  description: string;
  /** The counter this watches. */
  metric: AchievementMetric;
  /** The value that unlocks it. */
  threshold: number;
  /** XP paid once, on unlock. */
  xpReward: number;
  /**
   * Whether the progress bar is meaningful.
   *
   * False for the one-shot achievements whose metric is a *best* rather than a
   * count — "you have drawn one perfect picture out of the one required" is
   * not a bar worth drawing.
   */
  showProgress: boolean;
}

/**
 * The catalogue.
 *
 * ## Why it is a constant and not a collection
 *
 * The definitions are code: they change when a release changes them, they are
 * the same for every player, and they have to be readable by the evaluator
 * without a database round trip on the end-of-match path. What *is* stored is
 * the unlock — one row per player per key — which is the part that differs
 * between people.
 *
 * ## The two that cannot fire yet
 *
 * `daily_challenge` and `tournament_winner` watch counters nothing increments,
 * because the daily challenge and tournament features are not built. They are
 * catalogued now so the clients can render them as locked with zero progress —
 * which is honest — rather than having the list change shape later.
 */
export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  {
    key: 'first_game',
    name: 'First Game',
    description: 'Finish your first match.',
    metric: ACHIEVEMENT_METRIC.gamesPlayed,
    threshold: 1,
    xpReward: 25,
    showProgress: false,
  },
  {
    key: 'first_win',
    name: 'First Win',
    description: 'Finish a match in first place.',
    metric: ACHIEVEMENT_METRIC.gamesWon,
    threshold: 1,
    xpReward: 50,
    showProgress: false,
  },
  {
    key: 'ten_games',
    name: '10 Games Played',
    description: 'Finish ten matches.',
    metric: ACHIEVEMENT_METRIC.gamesPlayed,
    threshold: 10,
    xpReward: 100,
    showProgress: true,
  },
  {
    key: 'hundred_guesses',
    name: '100 Correct Guesses',
    description: 'Read one hundred drawings correctly.',
    metric: ACHIEVEMENT_METRIC.correctGuesses,
    threshold: 100,
    xpReward: 200,
    showProgress: true,
  },
  {
    key: 'fast_guesser',
    name: 'Fast Guesser',
    description: 'Guess a word in the first few seconds of a turn.',
    metric: ACHIEVEMENT_METRIC.fastGuesses,
    threshold: 1,
    xpReward: 50,
    showProgress: false,
  },
  {
    key: 'perfect_drawer',
    name: 'Perfect Drawer',
    description: 'Draw something everybody guesses.',
    metric: ACHIEVEMENT_METRIC.perfectDrawings,
    threshold: 1,
    xpReward: 75,
    showProgress: false,
  },
  {
    key: 'top_scorer',
    name: 'Top Scorer',
    description: 'Score 500 or more in a single match.',
    metric: ACHIEVEMENT_METRIC.bestRoundScore,
    threshold: 500,
    xpReward: 150,
    showProgress: true,
  },
  {
    key: 'win_streak_5',
    name: '5 Wins in a Row',
    description: 'Win five matches back to back.',
    metric: ACHIEVEMENT_METRIC.bestWinStreak,
    threshold: 5,
    xpReward: 250,
    showProgress: true,
  },
  {
    key: 'guess_master',
    name: 'Guess Master',
    description: 'Be the first to guess twenty-five times.',
    metric: ACHIEVEMENT_METRIC.firstGuesses,
    threshold: 25,
    xpReward: 200,
    showProgress: true,
  },
  {
    key: 'popular_player',
    name: 'Popular Player',
    description: 'Make ten friends.',
    metric: ACHIEVEMENT_METRIC.friendCount,
    threshold: 10,
    xpReward: 100,
    showProgress: true,
  },
  {
    key: 'daily_challenge',
    name: 'Daily Challenge Completed',
    description: 'Complete a daily challenge.',
    metric: ACHIEVEMENT_METRIC.dailyChallengesCompleted,
    threshold: 1,
    xpReward: 50,
    showProgress: false,
  },
  {
    key: 'tournament_winner',
    name: 'Tournament Winner',
    description: 'Win a tournament.',
    metric: ACHIEVEMENT_METRIC.tournamentsWon,
    threshold: 1,
    xpReward: 500,
    showProgress: false,
  },
] as const;

/** The catalogue, indexed by key, for the unlock path. */
export const ACHIEVEMENTS_BY_KEY: ReadonlyMap<string, AchievementDefinition> = new Map(
  ACHIEVEMENTS.map((entry) => [entry.key, entry]),
);

/**
 * What counts as a "fast" guess.
 *
 * A fraction of the turn rather than a fixed number of seconds, because the
 * drawing time is a room setting: eight seconds into a thirty-second turn is a
 * different feat from eight seconds into a two-minute one, and a fixed cut-off
 * would make the achievement trivial in long rooms and unreachable in short.
 */
export const FAST_GUESS_TIME_FRACTION = 0.85;

/** Bounds on the XP history endpoint. */
export const XP_HISTORY_LIMITS = {
  defaultLimit: 25,
  maxLimit: 50,
  /** How long a history row survives. Long enough to explain a level, not forever. */
  retentionDays: 90,
} as const;
