import type {
  ChatTypeWire,
  GamePhaseWire,
  WordCategoryWire,
  WordDifficultyWire,
} from '@/constants/room.constants';

/** `lib/models/word_item.dart`. */
export interface WordItemDto {
  text: string;
  category: WordCategoryWire;
  difficulty: WordDifficultyWire;
}

/**
 * `lib/models/game_state.dart`, as broadcast on `s:game:state`.
 *
 * ## The `word` field is the whole security model
 *
 * It is populated for exactly two audiences: the current drawer, and everyone
 * once the turn has ended. For every other recipient it is `null`, and
 * `maskedWord` plus `wordLength` are all they get (brief section 21).
 *
 * Because one broadcast goes to many recipients with different entitlements,
 * this object is built per-recipient by `serializeGameState(runtime, viewerId)`
 * rather than once per room. That is the reason the game socket emits in a
 * loop over sockets instead of using `io.to(room).emit`.
 */
export interface GameStateDto {
  roomCode: string;
  phase: GamePhaseWire;
  currentRound: number;
  totalRounds: number;
  turnIndex: number;
  drawerId: string | null;
  /** The answer. Null unless the recipient is the drawer or the turn ended. */
  word: string | null;
  /** The answer as blanks and revealed letters, e.g. `_ _ E _ _`. */
  maskedWord: string;
  /** Zero in `hidden` word mode until the first hint lands. */
  wordLength: number;
  hintIndices: number[];
  /** Absolute epoch milliseconds on the server clock. */
  turnStartMs: number;
  turnEndMs: number;
  correctGuesserIds: string[];
  roundScores: Record<string, number>;
  /** Only ever non-empty for the drawer during word selection. */
  wordChoices: WordItemDto[];

  /**
   * Whether the drawer may see the board they are drawing on.
   *
   * Stated by the server rather than left to the client: a blind mode where
   * the canvas is merely hidden by the app is a mode anybody can switch off.
   * True for everybody in every mode but Blind, and true for guessers always —
   * they are reading the drawing, which is the game.
   */
  drawerSeesBoard: boolean;
}

/** `lib/models/round_result.dart`, sent with `s:game:roundEnd`. */
export interface RoundResultDto {
  /**
   * The match this turn belongs to, and which turn of it.
   *
   * Carried here rather than on the game state because this is the exact
   * moment a replay becomes available — the turn has ended, so the
   * drawing and the word are both readable — and because a round result
   * is sent once per turn where the game state is sent on every hint and
   * every score change. The pair is what the replay endpoints are keyed
   * by; nothing in the protocol ever puts a round document id on the wire.
   *
   * `gameId` is null for a turn played outside a persisted match, which
   * is what a client checks before offering a replay.
   */
  gameId: string | null;
  turnNumber: number;
  round: number;
  /** Revealed here, and not a moment earlier (brief section 46). */
  word: string;
  drawerId: string;
  scoreDeltas: Record<string, number>;
  totals: Record<string, number>;
  correctOrder: string[];
}

/** `lib/models/player_score.dart`. */
export interface PlayerScoreDto {
  playerId: string;
  name: string;
  avatarId: number;
  avatarColorIndex: number;
  score: number;
  /** 1-based, with ties sharing a rank. */
  rank: number;
}

/** `lib/models/game_result.dart`, sent with `s:game:end`. */
/**
 * Who did what, for the shareable result card.
 *
 * Every field is a player id or null — never a name or a score. The card that
 * renders these already has the standings, so repeating a name here would be
 * a second copy able to disagree with the first.
 */
export interface MatchAwardsDto {
  /** Highest final score. Null on an empty match. */
  topScorerId: string | null;
  /** Most perfect turns drawn, tie-broken on turns drawn. */
  bestDrawerId: string | null;
  /** Most correct guesses. */
  bestGuesserId: string | null;
  /** Most first-place guesses. */
  fastestGuesserId: string | null;
}

export interface GameResultDto {
  roomCode: string;
  standings: PlayerScoreDto[];
  totalRounds: number;
  /** Which rule set this match ran under. */
  gameMode: string;
  /** Who did what, for the result card. */
  awards: MatchAwardsDto;
}

/** `lib/models/chat_message.dart`, sent with `s:chat:message`. */
export interface ChatMessageDto {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  type: ChatTypeWire;
  timestampMs: number;
}

/** The `s:game:hint` payload. */
export interface HintDto {
  hintIndices: number[];
  maskedWord: string;
}
