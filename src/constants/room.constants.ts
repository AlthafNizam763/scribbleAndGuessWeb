/**
 * The enum value strings that travel on the wire.
 *
 * Every one of these is a Dart enum `name` (or its `wire` override) from
 * `lib/models/enums.dart`. The client parses defensively and falls back to a
 * default on anything it does not recognise, which means a typo here would not
 * throw — it would silently show the wrong thing. So these are transcribed
 * from the Dart source rather than invented, and must be changed in lockstep.
 */

/** `RoomStatus` — note the wire values differ from the Dart identifiers. */
export const ROOM_STATUS = {
  waiting: 'waiting',
  starting: 'starting',
  inGame: 'playing',
  roundResult: 'round_result',
  finished: 'finished',
  closed: 'closed',
} as const;
export type RoomStatusWire = (typeof ROOM_STATUS)[keyof typeof ROOM_STATUS];

/** `GamePhase` — again, wire values, not Dart identifiers. */
export const GAME_PHASE = {
  lobby: 'waiting',
  starting: 'starting',
  wordSelection: 'word_selection',
  drawing: 'drawing',
  roundEnd: 'round_result',
  gameEnd: 'final_result',
  /**
   * A started match that cannot legally run right now, because the room has
   * dropped below `MIN_PLAYERS_TO_START` active players.
   *
   * Deliberately a phase rather than a flag beside one. A paused game is
   * neither in the lobby — the scores, the turn order and the round number are
   * all still live — nor mid-turn: there is no drawer, no word and no
   * countdown. Every guard in the engine already keys off the phase, so
   * expressing it here is what makes "the last player cannot carry on alone"
   * true by construction rather than only in the UI.
   */
  paused: 'paused',
} as const;
export type GamePhaseWire = (typeof GAME_PHASE)[keyof typeof GAME_PHASE];

/** `PlayerConnection`. */
export const CONNECTION = {
  connected: 'connected',
  reconnecting: 'reconnecting',
  disconnected: 'disconnected',
} as const;
export type ConnectionWire = (typeof CONNECTION)[keyof typeof CONNECTION];

/** `DrawTool`. */
export const DRAW_TOOL = { pen: 'pen', eraser: 'eraser' } as const;
export type DrawToolWire = (typeof DRAW_TOOL)[keyof typeof DRAW_TOOL];

/** `WordCategory`, in the client's declaration order. */
export const WORD_CATEGORIES = [
  'animals',
  'food',
  'objects',
  'places',
  'movies',
  'sports',
  'jobs',
  'technology',
  'nature',
  'music',
  'vehicles',
  'random',
] as const;
export type WordCategoryWire = (typeof WORD_CATEGORIES)[number];

/** `WordDifficulty`. */
export const WORD_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type WordDifficultyWire = (typeof WORD_DIFFICULTIES)[number];

/** `WordMode`. */
export const WORD_MODES = ['normal', 'hidden', 'combination'] as const;
export type WordModeWire = (typeof WORD_MODES)[number];

/** `AppLanguage`. */
export const LANGUAGES = ['en', 'ml', 'hi', 'de', 'ja', 'ru', 'es', 'fr'] as const;
export type LanguageWire = (typeof LANGUAGES)[number];

/** `ChatMessageType`. */
export const CHAT_TYPE = {
  chat: 'chat',
  guess: 'guess',
  correctGuess: 'correctGuess',
  closeGuess: 'closeGuess',
  system: 'system',
  playerJoined: 'playerJoined',
  playerLeft: 'playerLeft',
  hint: 'hint',
} as const;
export type ChatTypeWire = (typeof CHAT_TYPE)[keyof typeof CHAT_TYPE];

/** `GuessVerdict` from the client's guess matcher. */
export const VERDICT = { correct: 'correct', close: 'close', wrong: 'wrong' } as const;
export type VerdictWire = (typeof VERDICT)[keyof typeof VERDICT];

/**
 * The lifecycle of a room invitation.
 *
 * ## Why `expired` is a stored status and not merely a date comparison
 *
 * An invitation carries an `expiresAt`, so "is this still good" is answerable
 * without writing anything — and the accept path does exactly that, because a
 * row that lapsed one millisecond ago must be refused whether or not a sweeper
 * has run yet.
 *
 * The status exists anyway because the *unique index* keys off it. Only
 * `pending` rows constrain a re-invite, so a lapsed invitation that stayed
 * `pending` forever would block the same friend from ever being asked again.
 * Writing `expired` is what releases the slot; the date is what decides.
 */
export const INVITATION_STATUS = {
  /** Sent, unanswered, and not yet past `expiresAt`. */
  pending: 'pending',
  /** The invitee accepted. They may or may not still be in the room. */
  accepted: 'accepted',
  /** The invitee declined. */
  rejected: 'rejected',
  /** Nobody answered in time, or the room closed underneath it. */
  expired: 'expired',
} as const;

export type InvitationStatusWire =
  (typeof INVITATION_STATUS)[keyof typeof INVITATION_STATUS];
