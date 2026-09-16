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

/**
 * `DrawTool`.
 *
 * ## Why every tool is still a stroke
 *
 * A rectangle is two points and a tool name; a fill is a colour and a tool
 * name. Neither is a special message — both go down the same `begin/append/end`
 * path as a scribble, land in the same append-only `board.strokes` array, and
 * are undone by the same `undo`. That is what keeps one ordering rule, one
 * replay, and one redo stack for the whole feature: a tool that needed its own
 * transport would need its own undo too, and the two stacks would drift.
 *
 * ## The three families
 *
 * - **Freehand** (`pen`, `pencil`, `marker`, `brush`, `eraser`) stream points
 *   while the finger is down.
 * - **Shapes** (`line`, `rectangle`, `circle`) carry exactly two points — the
 *   drag's start and end — and are sent once, on release. Streaming them would
 *   be a packet per frame for a geometry that only matters when it settles.
 * - **Fill** (`fill`) carries no meaningful geometry at all; see the note on
 *   `SHAPE_TOOLS` below for what it does and, importantly, what it does not.
 */
export const DRAW_TOOL = {
  /** The default fine nib. Solid, round cap. */
  pen: 'pen',
  /** Thinner and slightly translucent, so overlaps read as shading. */
  pencil: 'pencil',
  /** Wide, translucent and square-capped: strokes build up where they cross. */
  marker: 'marker',
  /** Solid, but its width follows pointer pressure where a device reports it. */
  brush: 'brush',
  /** Paints in the page colour. Never a real cut-out — see `drawing.service`. */
  eraser: 'eraser',
  /** Floods the whole canvas with one colour. */
  fill: 'fill',
  /** A straight segment between two points. */
  line: 'line',
  /** An axis-aligned rectangle between two corners. */
  rectangle: 'rectangle',
  /** An ellipse inscribed in the box between two corners. */
  circle: 'circle',
} as const;
export type DrawToolWire = (typeof DRAW_TOOL)[keyof typeof DRAW_TOOL];

export const DRAW_TOOLS = Object.values(DRAW_TOOL) as DrawToolWire[];

/**
 * The tools defined by two points rather than by a path.
 *
 * Used by the server only to bound how many points it will keep: a rectangle
 * that arrived with four hundred points is a bug or an attack, and either way
 * only the first two mean anything.
 */
export const SHAPE_TOOLS: readonly DrawToolWire[] = [
  DRAW_TOOL.line,
  DRAW_TOOL.rectangle,
  DRAW_TOOL.circle,
] as const;

/**
 * The tools whose width and points are irrelevant.
 *
 * `fill` floods the **entire canvas**, not an enclosed region, and that is a
 * deliberate limitation rather than an unfinished one. A region flood fill is
 * a pixel operation: it needs a rasterised bitmap to walk, and every client
 * here rasterises at a different size with different anti-aliasing. The same
 * fill would spill past a hand-drawn gap on a tablet and stop at it on a
 * phone, so the shared canvas would stop being shared — and the turn-end
 * snapshot, which is a list of strokes and not an image, could not record
 * which happened. A whole-canvas fill replays identically everywhere, at any
 * resolution, from two numbers.
 */
export const FILL_TOOLS: readonly DrawToolWire[] = [DRAW_TOOL.fill] as const;

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

/**
 * `AppLanguage` — the word-bank languages.
 *
 * `ta` and `ar` are accepted here so a room may be created in them and their
 * words seeded — the client offers both. Note that accepting a language is not
 * the same as having a word bank for it: `wordService.pool` falls back to the
 * bundled list when a language has no seeded rows, so an unseeded language
 * plays in English rather than failing to start.
 */
export const LANGUAGES = [
  'en',
  'ml',
  'hi',
  'ta',
  'ar',
  'de',
  'ja',
  'ru',
  'es',
  'fr',
] as const;
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
