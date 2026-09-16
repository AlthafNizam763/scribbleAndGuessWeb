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
 * fills, brackets and runs without anybody pressing anything. A bracket has
 * pairings, and pairings have to be decided at a moment: somebody has to close
 * registration, count who actually turned up, seed them, and open the first
 * matches. There is no arrangement of timestamps that does that on its own, so
 * this system has a stored `status` and a scheduler that advances it. The two
 * live side by side and share no rows.
 *
 * ## Three a day, and what that changed
 *
 * The product rule is **exactly three tournaments per calendar day**, at three
 * named times. It used to be "three at once, refilled the moment one ends",
 * and the difference is not a number — it is what identifies a tournament.
 *
 * A rolling slot is a *position*: slot 2 is whatever is in slot 2 right now,
 * and the same slot holds a different tournament every hour. A daily slot is a
 * *date and a time of day*: the morning tournament of 2026-09-16 is one event
 * for all time, it exists whether or not anybody joins it, and when it is over
 * nothing replaces it — the next one is the afternoon, which was always going
 * to happen anyway.
 *
 * That is why `{tournamentDate, dailySlot}` is the identity and the unique
 * index, and why nothing here counts live tournaments to decide whether to
 * create another. Counting is a read, creating is a write, and two schedulers
 * can both read `2` before either writes. Naming the slot turns "never a
 * fourth" into a write the database refuses.
 */

/** How many tournaments exist on one calendar day. The product rule. */
export const TOURNAMENTS_PER_DAY = 3;

/**
 * The three times of day a tournament happens at.
 *
 * Named rather than numbered because the name is shown to a player and has to
 * survive a change of clock: moving the evening tournament from 20:00 to 21:00
 * is a configuration change, and every row already stamped `EVENING` is still
 * correct afterwards. A stored `20:00` would have needed migrating.
 */
export const DAILY_SLOT = {
  morning: 'MORNING',
  afternoon: 'AFTERNOON',
  evening: 'EVENING',
} as const;

export type DailySlotWire = (typeof DAILY_SLOT)[keyof typeof DAILY_SLOT];

/** The slots in the order they happen. The listing's sort order. */
export const DAILY_SLOTS: readonly DailySlotWire[] = Object.freeze([
  DAILY_SLOT.morning,
  DAILY_SLOT.afternoon,
  DAILY_SLOT.evening,
]);

/**
 * A slot's position in the day, 1-based.
 *
 * Denormalised onto each row as `slotNumber` so a listing sorts in the
 * database rather than in memory — Mongo cannot order by a hand-written
 * sequence of strings, and "MORNING, AFTERNOON, EVENING" is not alphabetical.
 */
export const DAILY_SLOT_ORDER: Readonly<Record<DailySlotWire, number>> = Object.freeze({
  [DAILY_SLOT.morning]: 1,
  [DAILY_SLOT.afternoon]: 2,
  [DAILY_SLOT.evening]: 3,
});

/**
 * The names a daily tournament can be given.
 *
 * ## Why a fixed pool and not a generator
 *
 * Because a player has to be able to say which one they mean. "Ink Royale" is
 * a thing you can tell a friend to join; a generated name is a string nobody
 * can repeat and nobody can search for. Twenty is enough that the rotation
 * takes three weeks to come round — long enough that the same name never
 * reads as the same tournament — and small enough that they are all good.
 *
 * Every one of them is short, pronounceable and says "drawing competition".
 * None of them contains a player's name, a winner's name or a date: the name
 * is chosen when the tournament is created and never written again, so a
 * name that referred to a result would be a name that was wrong until the
 * result existed. See `name.service.ts` for how three are picked per day.
 */
export const TOURNAMENT_NAME_POOL: readonly string[] = Object.freeze([
  'Ink Royale',
  'Doodle Rush',
  'Sketch Clash',
  'Scribble Storm',
  'Canvas Kings',
  'Draw Duel',
  'Pencil Panic',
  'Sketch Masters',
  'Ink Warriors',
  'Doodle League',
  'Brush Battle',
  'The Drawing Cup',
  'Sketch Legends',
  'Paper Champions',
  'The Scribble Cup',
  'Creative Clash',
  'Drawing Rivals',
  'Masterpiece Match',
  'Ink Arena',
  'Ultimate Doodle Cup',
]);

/**
 * Where an automatic tournament is in its life.
 *
 * Stored, not derived — see the note at the top of this file. The scheduler is
 * the only thing that writes it, and every write is a conditional update that
 * names the status it expects to replace, so two schedulers racing produce one
 * transition rather than two.
 */
export const AUTO_TOURNAMENT_STATUS = {
  /**
   * Created and scheduled; registration has not opened yet.
   *
   * The state a daily tournament spends most of its life in. The evening
   * tournament is created at the start of the day and sits here for hours,
   * showing a start time and a countdown, which is the whole point of
   * publishing a schedule rather than a surprise.
   */
  upcoming: 'UPCOMING',
  /** Anybody may register. */
  registration: 'REGISTRATION',
  /**
   * Registration closed; the roster is final and the start countdown is
   * running.
   *
   * ## Not reached by a daily tournament
   *
   * This is the fast-start path's last phase, used by a deployment that runs
   * with `checkInEnabled` off: the roster seals and a fifteen-second clock
   * runs. A daily tournament seals at check-in instead, because it has a
   * published start time and does not need to invent one.
   *
   * Kept in the enum, in `LIVE_STATUSES` and handled by the scheduler, because
   * a deploy can land while a tournament is sitting in it and that tournament
   * still has to reach a bracket rather than becoming a row nothing advances.
   */
  starting: 'STARTING',
  /**
   * Registration closed; registered humans must confirm they are here.
   *
   * The daily model's last gate before the bracket. Registration for the
   * evening tournament can open hours before it starts, so "are you still
   * there?" is a real question with a real answer — unlike in the rolling
   * model, where the whole window was two minutes and asking it was the delay
   * it was meant to prevent.
   */
  checkIn: 'CHECK_IN',
  /** Bracket drawn, matches being played. */
  running: 'RUNNING',
  /** Finished, with a winner. The card stays, showing the result. */
  completed: 'COMPLETED',
  /** Abandoned before it could run. Nothing replaces it. */
  cancelled: 'CANCELLED',
} as const;

export type AutoTournamentStatusWire =
  (typeof AUTO_TOURNAMENT_STATUS)[keyof typeof AUTO_TOURNAMENT_STATUS];

/**
 * The statuses of a tournament that has not finished.
 *
 * What the scheduler sweeps and what a player can still be *in*. It no longer
 * decides whether another tournament may be created — that is
 * `{tournamentDate, dailySlot}` and the unique index on it, which holds
 * whatever status the row is in. A completed morning tournament does not free
 * anything up, because the afternoon one was never waiting on it.
 */
export const LIVE_STATUSES: readonly AutoTournamentStatusWire[] = Object.freeze([
  AUTO_TOURNAMENT_STATUS.upcoming,
  AUTO_TOURNAMENT_STATUS.registration,
  AUTO_TOURNAMENT_STATUS.starting,
  AUTO_TOURNAMENT_STATUS.checkIn,
  AUTO_TOURNAMENT_STATUS.running,
]);

/** The statuses in which a tournament is over, however it ended. */
export const FINISHED_STATUSES: readonly AutoTournamentStatusWire[] = Object.freeze([
  AUTO_TOURNAMENT_STATUS.completed,
  AUTO_TOURNAMENT_STATUS.cancelled,
]);

/** The statuses in which the roster is final and nobody new may join. */
export const SEALED_STATUSES: readonly AutoTournamentStatusWire[] = Object.freeze([
  AUTO_TOURNAMENT_STATUS.starting,
  AUTO_TOURNAMENT_STATUS.checkIn,
  AUTO_TOURNAMENT_STATUS.running,
]);

/** The statuses in which a player is considered to be *in* a tournament. */
export const ACTIVE_PARTICIPATION_STATUSES = LIVE_STATUSES;

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

  /**
   * When each daily tournament starts, as minutes after local midnight.
   *
   * 10:00, 15:00 and 20:00 — mid-morning, mid-afternoon, and the evening slot
   * in the hours people actually play. Local to `timeZone` below, so these are
   * the times a player reads on their own clock rather than a UTC offset they
   * have to do arithmetic on.
   *
   * Every one of the timings under this is measured *backwards* from the
   * start, because the start is the thing that was published. A tournament
   * announced for eight in the evening has to begin at eight in the evening;
   * the windows in front of it are arranged to fit.
   */
  slotMinutes: {
    [DAILY_SLOT.morning]: 10 * 60,
    [DAILY_SLOT.afternoon]: 15 * 60,
    [DAILY_SLOT.evening]: 20 * 60,
  },

  /**
   * The timezone the calendar day and the slot times are read in.
   *
   * ## Why this is configured and not the server's own clock
   *
   * Because the server's clock is UTC on a host in Oregon and the players are
   * not. "Three tournaments a day" is a promise about *their* day: the evening
   * tournament has to be in the evening where somebody is sitting, and the day
   * has to roll over while they are asleep rather than in the middle of their
   * afternoon. Reading the host's zone would make both of those an accident of
   * where the deployment happens to run, and would change them silently the
   * day it moves.
   */
  timeZone: 'Asia/Kolkata',

  /**
   * How long before the start registration opens.
   *
   * Ninety minutes. Long enough that somebody who opens the app over lunch can
   * take a place in the afternoon tournament and come back for it; short
   * enough that the roster is not a list of people who signed up this morning
   * and forgot. It is also why check-in exists at all in the daily model —
   * over an hour and a half, "are you still here?" is a real question.
   */
  registrationLeadMs: 90 * 60 * 1000,

  /**
   * How long before the start registration closes and check-in opens.
   *
   * Ten minutes, which is both halves of one decision: it is how long a player
   * has to confirm, and it is how much notice somebody gets that the thing
   * they registered for is about to happen. Shorter and a player who put their
   * phone down misses it; longer and the tournament spends a quarter of an
   * hour asking a question nobody has changed their answer to.
   */
  checkInLeadMs: 10 * 60 * 1000,

  /**
   * How long the final countdown runs once the roster is sealed.
   *
   * Only reached by a deployment running with check-in off — a daily
   * tournament starts at its published time, not fifteen seconds after a
   * countdown somebody started. Kept because that deployment is still
   * supported and the fast-start path still uses it.
   */
  startCountdownMs: 15 * 1000,

  /**
   * How long after registration opens before bots start filling empty seats.
   *
   * Unused while check-in is on: the roster cannot seal before check-in
   * closes, so the seats are filled there, at the last moment that is still
   * before the start. Kept for the fast-start path.
   */
  botFillDelayMs: 45 * 1000,

  /**
   * Whether registered players must confirm they are present before the
   * bracket is drawn.
   *
   * ## On, and why that changed
   *
   * It was off while tournaments ran back to back on a two-minute window,
   * because over two minutes nobody has gone anywhere and the question was
   * itself the delay it was meant to prevent.
   *
   * A scheduled tournament is the opposite case. Registration for the evening
   * one opens ninety minutes before it starts, and a bracket drawn from
   * everybody who tapped join at half past six would be half walkovers. So the
   * last ten minutes ask, and the answer decides who is seeded.
   */
  checkInEnabled: true,

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
 * ## Why the tick is five seconds
 *
 * Because the tick is the error bar on every deadline in the system, and the
 * shortest of them are not the daily ones. A tournament's start time is known
 * hours in advance and nobody notices it beginning three seconds late — but a
 * match entry deadline is ninety seconds, a bot fill is a moment, and a round
 * that has finished should open the next one while the players are still
 * looking at the screen.
 *
 * Five seconds keeps all of those inside a rounding error. The cost is a
 * handful of indexed queries over at most six tournaments — today's three and
 * tomorrow's — which is nothing.
 *
 * The lease is far longer than a tick takes, because its job is not to bound
 * the work — it is to release a lock held by a process that died mid-tick. Too
 * short and a slow tick would run beside its own replacement; too long and a
 * crash would stall every tournament until it expired.
 */
export const SCHEDULER_TIMING = {
  tickMs: 5 * 1000,
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
