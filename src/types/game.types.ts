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
}

/** `lib/models/round_result.dart`, sent with `s:game:roundEnd`. */
export interface RoundResultDto {
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
export interface GameResultDto {
  roomCode: string;
  standings: PlayerScoreDto[];
  totalRounds: number;
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
