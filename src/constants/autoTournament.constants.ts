/**
 * The automatic multi-tournament system.
 *
 * ## What this is, and how it differs from `tournament.constants.ts`
 *
 * The older file describes a *points* tournament: a scheduled window, a
 * derived status and a leaderboard fed by ordinary ranked matches. Nothing
 * runs it — three timestamps and the clock decide everything — and that is
 * exactly why it cannot express what is wanted here.
 *
 * This file describes a *knockout* tournament that an organiser bot creates,
 * fills, brackets, runs and replaces without anybody pressing anything. A
 * bracket has pairings, and pairings have to be decided at a moment: somebody
 * has to close registration, count who actually turned up, seed them, and open
 * the first matches. There is no arrangement of timestamps that does that on
 * its own, so this system has a stored `status` and a scheduler that advances
 * it. The two live side by side and share no rows.
 *
 * ## The three slots
 *
 * The product rule is "exactly three tournaments, always". That is modelled as
 * three numbered *slots*, each holding at most one tournament that is not yet
 * finished. A slot is released when its tournament completes or is cancelled,
 * and the scheduler immediately creates a replacement in it. Making the slot
 * the unit — rather than counting active tournaments — is what makes "never a
 * fourth" enforceable by a unique index rather than by a count that two
 * schedulers could read at the same time.
 */

/** How many tournaments run at once. The product rule, in one number. */
export const TOURNAMENT_SLOT_COUNT = 3;

/** The slot numbers, as a list, so callers do not build ranges by hand. */
export const TOURNAMENT_SLOTS: readonly number[] = Object.freeze(
  Array.from({ length: TOURNAMENT_SLOT_COUNT }, (_, index) => index + 1),
);

/**
 * Where an automatic tournament is in its life.
 *
 * Stored, not derived — see the note at the top of this file. The scheduler is
 * the only thing that writes it, and every write is a conditional update that
 * names the status it expects to replace, so two schedulers racing produce one
 * transition rather than two.
 */
export const AUTO_TOURNAMENT_STATUS = {
  /** Created, registration has not opened. Usually momentary. */
  upcoming: 'UPCOMING',
  /** Anybody may register. */
  registration: 'REGISTRATION',
  /** Registration closed; registered humans must confirm they are here. */
  checkIn: 'CHECK_IN',
  /** Bracket drawn, matches being played. */
  running: 'RUNNING',
  /** Finished, with a winner. The slot is released. */
  completed: 'COMPLETED',
  /** Abandoned before it could run. The slot is released. */
  cancelled: 'CANCELLED',
} as const;

export type AutoTournamentStatusWire =
  (typeof AUTO_TOURNAMENT_STATUS)[keyof typeof AUTO_TOURNAMENT_STATUS];

/**
 * The statuses that hold a slot.
 *
 * A tournament in any of these occupies its slot and blocks a replacement.
 * The unique partial index in `AutoTournament` is built from exactly this
 * list, so "never a fourth tournament" and "never two in one slot" are the
 * same fact expressed once.
 */
export const SLOT_HOLDING_STATUSES: readonly AutoTournamentStatusWire[] = Object.freeze([
  AUTO_TOURNAMENT_STATUS.upcoming,
  AUTO_TOURNAMENT_STATUS.registration,
  AUTO_TOURNAMENT_STATUS.checkIn,
  AUTO_TOURNAMENT_STATUS.running,
]);

/** The statuses in which a player is considered to be *in* a tournament. */
export const ACTIVE_PARTICIPATION_STATUSES = SLOT_HOLDING_STATUSES;

/** The only format the automatic system runs. */
export const AUTO_TOURNAMENT_FORMAT = 'KNOCKOUT' as const;

/** Who created a tournament. There is exactly one legal value. */
export const CREATED_BY_TYPE = {
  /** The organiser bot. Nothing else may create an automatic tournament. */
  systemBot: 'SYSTEM_BOT',
} as const;

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** Whether a seat belongs to a person or to the server. */
export const PLAYER_TYPE = {
  human: 'HUMAN',
  aiBot: 'AI_BOT',
} as const;

export type PlayerTypeWire = (typeof PLAYER_TYPE)[keyof typeof PLAYER_TYPE];

/** How hard a bot plays. */
export const BOT_DIFFICULTY = {
  easy: 'EASY',
  normal: 'NORMAL',
  hard: 'HARD',
} as const;

export type BotDifficultyWire = (typeof BOT_DIFFICULTY)[keyof typeof BOT_DIFFICULTY];

/**
 * One registration's standing in its tournament.
 *
 * `registered` and `checkedIn` are the two states of the pre-match phases;
 * `active`, `eliminated` and `winner` describe a bracket in progress. A row is
 * never deleted — a player who missed check-in becomes `no_show` rather than
 * disappearing, because the bracket has to be able to explain why somebody who
 * signed up is not in it.
 */
export const REGISTRATION_STATUS = {
  registered: 'REGISTERED',
  checkedIn: 'CHECKED_IN',
  /** Registered but never confirmed. Dropped before seeding. */
  noShow: 'NO_SHOW',
  /** Withdrew before registration closed. */
  withdrawn: 'WITHDRAWN',
  /** In the bracket and still alive. */
  active: 'ACTIVE',
  /** Knocked out. */
  eliminated: 'ELIMINATED',
  /** Won the whole thing. */
  winner: 'WINNER',
} as const;

export type RegistrationStatusWire =
  (typeof REGISTRATION_STATUS)[keyof typeof REGISTRATION_STATUS];

/** Registration statuses that still count towards a tournament's roster. */
export const ROSTER_STATUSES: readonly RegistrationStatusWire[] = Object.freeze([
  REGISTRATION_STATUS.registered,
  REGISTRATION_STATUS.checkedIn,
  REGISTRATION_STATUS.active,
  REGISTRATION_STATUS.eliminated,
  REGISTRATION_STATUS.winner,
]);

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

/** Where one bracket match is. */
export const MATCH_STATUS = {
  /** Waiting for both slots to be filled by the round below. */
  pending: 'PENDING',
  /** Both players known; a room exists and they may enter. */
  ready: 'READY',
  /** Being played. */
  running: 'RUNNING',
  /** Decided. */
  completed: 'COMPLETED',
  /** Nobody showed up, or the round was abandoned. */
  cancelled: 'CANCELLED',
} as const;

export type MatchStatusWire = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

/** How a completed match was decided. Kept for the bracket's explanation. */
export const MATCH_OUTCOME = {
  /** A match was played and somebody scored higher. */
  played: 'PLAYED',
  /** An odd bracket handed this player a free pass. */
  bye: 'BYE',
  /** The opponent never entered the room. */
  walkover: 'WALKOVER',
} as const;

export type MatchOutcomeWire = (typeof MATCH_OUTCOME)[keyof typeof MATCH_OUTCOME];

// ---------------------------------------------------------------------------
// Timings and sizes
// ---------------------------------------------------------------------------

/**
 * The defaults every automatic tournament is created with.
 *
 * Copied onto each tournament row at creation rather than read live, so a
 * tournament that is already running keeps the rules it opened under even if
 * the deployment's configuration changes underneath it. Overridable from the
 * environment — see `env.tournament`.
 */
export const AUTO_TOURNAMENT_DEFAULTS = {
  /** The public name every tournament is built from. */
  namePrefix: 'Daily Scribble Cup',

  /** Fewest players a tournament may start with, humans and bots together. */
  minPlayers: 4,
  /** Most players a tournament may hold. */
  maxPlayers: 16,
  /**
   * Fewest *people* required.
   *
   * One. This is the rule that makes a bot-only tournament impossible: it is
   * checked at the moment the bracket would be drawn, so a tournament nobody
   * joined is cancelled rather than played by six robots for nobody's benefit.
   */
  minHumanPlayers: 1,
  /** Most AI bots one tournament may contain. */
  maxBots: 3,
  /** Whether bots may be used to make a short tournament viable at all. */
  allowBots: true,
  /** The difficulty bots are added at. */
  botDifficulty: BOT_DIFFICULTY.normal,

  /** How long registration stays open. */
  registrationMs: 10 * 60 * 1000,
  /** How long registered humans have to confirm. */
  checkInMs: 2 * 60 * 1000,

  /**
   * How long a match room waits for its humans before it starts anyway.
   *
   * A knockout stalls if one player never opens the app, and the alternative
   * to a deadline is a bracket that never finishes. Past this the match is
   * decided as a walkover — or started with whoever is present, when that is
   * still a playable match.
   */
  matchEntryMs: 90 * 1000,

  /** Rounds each bracket match is played over. Short, because it is a duel. */
  matchRounds: 2,
} as const;

/** Bounds on the tournament listing and its boards. */
export const AUTO_TOURNAMENT_LIMITS = {
  maxNameLength: 80,
  maxDescriptionLength: 240,
  defaultPageSize: 25,
  maxPageSize: 100,
  /**
   * The largest bracket the seeder will build.
   *
   * Sixteen players is four rounds, which at two rounds of drawing per match
   * is already a long evening. It is also `maxPlayers`, so this is a belt on
   * top of a brace rather than a second policy.
   */
  maxBracketSize: 16,
} as const;

/**
 * How often the scheduler wakes, and how long it may hold the lock.
 *
 * The tick is short because the things it watches are deadlines measured in
 * minutes: a fifteen-second tick means a registration window closes within
 * fifteen seconds of when it said it would, which nobody notices, while a
 * sixty-second tick is visible on a two-minute check-in.
 *
 * The lease is far longer than a tick takes, because its job is not to bound
 * the work — it is to release a lock held by a process that died mid-tick. Too
 * short and a slow tick would run beside its own replacement; too long and a
 * crash would stall every tournament until it expired. Ninety seconds is
 * roughly six ticks of headroom.
 */
export const SCHEDULER_TIMING = {
  tickMs: 15 * 1000,
  lockLeaseMs: 90 * 1000,
  /** The lock every scheduler run contends for. One row, one key. */
  lockKey: 'tournament:scheduler',
} as const;

/**
 * How a bot behaves at each difficulty.
 *
 * ## Why accuracy is a probability and not a switch
 *
 * A bot that always gets the word is not a difficulty setting, it is a wall:
 * every human loses every match to it and the bracket becomes a formality.
 * A bot that never does is furniture. So each difficulty is a *rate* — how
 * often a guess attempt is the real word — and the rest of the attempts are
 * plausible wrong words drawn from the same pool, which is what makes a bot
 * read as a player having a go rather than as an oracle being throttled.
 *
 * ## Why the delays are ranges
 *
 * Two bots in one match on fixed delays would guess in lockstep, in the same
 * order, every round. The range is re-rolled per attempt, so they interleave.
 */
export const BOT_BEHAVIOUR = {
  [BOT_DIFFICULTY.easy]: {
    /** Milliseconds between guess attempts. */
    guessDelayMs: { min: 8_000, max: 15_000 },
    /** Chance one attempt is the correct word, once the bot has any evidence. */
    accuracy: 0.35,
    /** Milliseconds between stroke batches while drawing. */
    strokeIntervalMs: 260,
    /** Fraction of the template's strokes this difficulty bothers to draw. */
    strokeCompleteness: 0.7,
    /** How far a drawn point may wander from the template, in unit-square terms. */
    jitter: 0.03,
  },
  [BOT_DIFFICULTY.normal]: {
    guessDelayMs: { min: 4_000, max: 10_000 },
    accuracy: 0.55,
    strokeIntervalMs: 180,
    strokeCompleteness: 0.9,
    jitter: 0.018,
  },
  [BOT_DIFFICULTY.hard]: {
    guessDelayMs: { min: 2_000, max: 6_000 },
    accuracy: 0.78,
    strokeIntervalMs: 120,
    strokeCompleteness: 1,
    jitter: 0.008,
  },
} as const satisfies Record<
  BotDifficultyWire,
  {
    guessDelayMs: { min: number; max: number };
    accuracy: number;
    strokeIntervalMs: number;
    strokeCompleteness: number;
    jitter: number;
  }
>;

/**
 * Ceilings on what the bot subsystem may cost this process.
 *
 * A bot is a chain of timers, and timers are the one resource a bug here could
 * exhaust silently. Everything below bounds that: how many bots may be mid-
 * action at once across every room, how many strokes one bot may put on a
 * board, and how many guesses it may attempt in a turn.
 */
export const BOT_LIMITS = {
  /** Bots holding a live drawing or guessing task, across the whole process. */
  maxConcurrentWorkers: 24,
  /** Strokes one bot drawer will put on the board in one turn. */
  maxStrokesPerTurn: 40,
  /** Points in one batch the bot sends. Well under the drawing service's cap. */
  pointsPerBatch: 12,
  /** Guess attempts one bot makes in one turn. */
  maxGuessAttemptsPerTurn: 12,
  /**
   * How long after a turn opens a bot waits before doing anything.
   *
   * A bot that began drawing on the same tick the turn opened would put marks
   * on the board before the clients had finished rendering the new round, and
   * the first strokes would be missed. It also just looks wrong.
   */
  warmUpMs: 900,
} as const;

/**
 * The bot roster.
 *
 * Fixed and small on purpose. `botId` is the stable key — it is what a
 * registration row points at and what the server validates a bot seat against,
 * so a client claiming to be a bot has to name one of these and still gets
 * nowhere, because nothing in the client path consults this list at all.
 *
 * The display names are deliberately not person-shaped. A bot called "Priya"
 * would be indistinguishable from a player at a glance; "ScribbleBot" is not.
 */
export const BOT_PROFILES: readonly {
  botId: string;
  displayName: string;
  avatarId: number;
  avatarColorIndex: number;
}[] = Object.freeze([
  { botId: 'scribbler', displayName: 'Scribbler', avatarId: 3, avatarColorIndex: 0 },
  { botId: 'sketcher', displayName: 'Sketcher', avatarId: 7, avatarColorIndex: 1 },
  { botId: 'doodler', displayName: 'Doodler', avatarId: 11, avatarColorIndex: 2 },
  { botId: 'guessmaster', displayName: 'GuessMaster', avatarId: 5, avatarColorIndex: 3 },
  { botId: 'pixeler', displayName: 'Pixeler', avatarId: 14, avatarColorIndex: 4 },
  { botId: 'quickdrawer', displayName: 'QuickDrawer', avatarId: 9, avatarColorIndex: 5 },
]);

/**
 * The badge every client shows beside a bot.
 *
 * Here rather than in each UI so the three clients cannot drift into showing a
 * bot as a person on one of them. The server sends it on every serialised bot,
 * so a client that renders what it is given is correct by default.
 */
export const BOT_LABEL = {
  emoji: '🤖',
  /** Shown under the name. The difficulty is appended by the client. */
  subtitle: 'AI Player',
} as const;
