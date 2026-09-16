/**
 * Tournaments (brief section: Events and Tournaments).
 *
 * ## What a tournament is here
 *
 * A scheduled event with a registration window, a set of rules every match in
 * it plays under, and a leaderboard scoped to it. It is deliberately *not* a
 * bracket: a knockout needs every pairing to finish before the next begins,
 * which in a casual drawing game means somebody waits twenty minutes for a
 * match they are not in. A points tournament — play as many matches as you
 * like inside the window, best total wins — keeps everybody playing for the
 * whole event, which is what a weekend tournament is for.
 *
 * Bracket support is a later feature and would sit beside this rather than
 * replacing it; `TOURNAMENT_FORMAT` exists so a stored row can say which it is.
 */

export const TOURNAMENT_FORMAT = {
  /** Best total score across the window. The only format implemented. */
  points: 'points',
  /** Reserved. A knockout bracket; see the note above. */
  bracket: 'bracket',
} as const;

export type TournamentFormatWire =
  (typeof TOURNAMENT_FORMAT)[keyof typeof TOURNAMENT_FORMAT];

/**
 * Where a tournament is in its life.
 *
 * Derived from the clock rather than stored as a field that something has to
 * remember to advance — see `tournamentService.statusOf`. A status column
 * would be wrong for every tournament between the moment one opens and the
 * moment a job noticed.
 */
export const TOURNAMENT_STATUS = {
  /** Announced, registration not yet open. */
  announced: 'announced',
  /** Registration open, not yet started. */
  registering: 'registering',
  /** Running. Matches count towards it. */
  live: 'live',
  /** Over. The board is final. */
  finished: 'finished',
} as const;

export type TournamentStatusWire =
  (typeof TOURNAMENT_STATUS)[keyof typeof TOURNAMENT_STATUS];

export const TOURNAMENT_LIMITS = {
  maxNameLength: 60,
  maxDescriptionLength: 240,
  /** How many entrants one tournament may hold. */
  maxEntrants: 5000,
  /** Page size for the tournament board. */
  defaultLimit: 25,
  maxLimit: 100,
  /**
   * The shortest a tournament may run.
   *
   * Short enough for a lunchtime event, long enough that a single match
   * cannot be the whole thing — which would make it a race to finish one game
   * rather than a tournament.
   */
  minDurationMs: 15 * 60 * 1000,
} as const;
