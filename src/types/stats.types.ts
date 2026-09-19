/**
 * The detailed player statistics (brief section: Player Statistics).
 *
 * ## Why this is a separate shape from `UserStatsDto`
 *
 * `UserStatsDto` is the *card* — five numbers shown on a leaderboard row, a
 * friend list and a profile header, and sent with every one of them. This is
 * the full record, read once when somebody opens their stats screen. Folding
 * the two together would put twenty fields on every leaderboard row to serve
 * a screen nobody is looking at.
 *
 * Every number here is derived from counters the game engine writes. None is
 * accepted from a client, and `PATCH /api/users/me` has no field for any of
 * them.
 */
export interface PlayerStatsDto {
  // --- matches -------------------------------------------------------------
  gamesPlayed: number;
  gamesWon: number;
  /** Games finished without winning. Derived, never stored. */
  gamesLost: number;
  /** Wins as a percentage, to one decimal place. */
  winRate: number;

  /** Matches finished in a room that had at least one Stupid in it. */
  botGamesPlayed: number;
  /** The rest. Derived, so the two always sum to `gamesPlayed`. */
  onlineGamesPlayed: number;
  /**
   * Matches finished per game id, highest first.
   *
   * The multi-game profile's one genuinely new line: which of these somebody
   * actually plays. Sent as an ordered array rather than a map so the client
   * renders the server's ordering instead of inventing its own, and so a game
   * this client has never heard of still appears with its id.
   */
  gamesByGameId: { gameId: string; played: number }[];

  // --- scoring -------------------------------------------------------------
  totalScore: number;
  /** The best single match score. */
  bestRoundScore: number;
  /** Mean score per finished match, rounded. */
  averageScore: number;

  // --- guessing ------------------------------------------------------------
  correctGuesses: number;
  /** Correct guesses that were the first of their turn. */
  firstGuesses: number;
  /** Correct guesses inside the opening fraction of a turn. */
  fastGuesses: number;

  // --- drawing -------------------------------------------------------------
  /** Turns taken as the drawer and finished. */
  drawingTurns: number;
  /** Turns drawn where every eligible guesser got it. */
  perfectDrawings: number;
  /** Perfect drawings as a percentage of turns drawn. */
  perfectDrawingRate: number;

  // --- streaks -------------------------------------------------------------
  currentWinStreak: number;
  bestWinStreak: number;

  // --- progression ---------------------------------------------------------
  xp: number;
  level: number;
  levelTitle: string;
  achievementsUnlocked: number;
  achievementsTotal: number;

  // --- meta ----------------------------------------------------------------
  /** When the account was created. */
  joinedAtMs: number;
  lastSeenAtMs: number;
}
