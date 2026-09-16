import type { Server, Socket } from 'socket.io';

import type { BotDifficultyWire } from '@/constants/autoTournament.constants';
import type { ConnectionWire, GamePhaseWire, WordDifficultyWire } from '@/constants/room.constants';
import type { AuthenticatedUser } from '@/types/auth.types';
import type { StrokeDto } from '@/types/drawing.types';
import type { WordItemDto } from '@/types/game.types';
import type { TeamWire } from '@/constants/gameModes.constants';
import type { RoomSettingsDto } from '@/types/room.types';

/** What every ack-bearing client event resolves to. */
export type Ack<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** The ack callback Socket.IO hands a handler. */
export type AckFn<T = Record<string, unknown>> = (response: Ack<T>) => void;

/** Per-socket state, populated by the auth middleware. */
export interface SocketData {
  user: AuthenticatedUser;
  /** The room this socket is seated in, or null in the lobby-less state. */
  roomId: string | null;
  /** Rate-limiter buckets, keyed by action. */
  buckets: Map<string, { tokens: number; updatedAt: number }>;
}

/**
 * The event map for both directions.
 *
 * Socket.IO's generics want a map of event name to listener signature. This
 * protocol has around forty events whose payloads are already described by the
 * DTO types, and duplicating all of them as a typed map would buy very little:
 * the payloads are built by serialisers that are themselves typed, and the
 * event names come from `socket.constants.ts` rather than string literals at
 * call sites. So the map stays open, and correctness comes from the
 * serialisers.
 */
export interface WireEvents {
  [event: string]: (...args: unknown[]) => void;
}

export type GameSocket = Socket<WireEvents, WireEvents, Record<string, never>, SocketData>;

export type GameServer = Server<WireEvents, WireEvents, Record<string, never>, SocketData>;

// ---------------------------------------------------------------------------
// In-memory authoritative state
// ---------------------------------------------------------------------------

/**
 * ## Why the live game lives in memory
 *
 * The realtime loop reads room state on every stroke, every guess and every
 * timer tick. Round-tripping to Mongo for each would add latency to the one
 * thing players notice most and would turn a busy room into a write storm
 * (brief section 24). So the authoritative state is a plain object in this
 * process, and Mongo is written *through* on state changes worth surviving a
 * restart: joins, leaves, scores, round ends.
 *
 * The trade-off is that a restart drops in-flight rounds. That is acceptable
 * for a game of this shape and is why the structures below are rebuildable
 * from the `rooms` and `games` collections — see `hydrateRoom` in
 * `room.service.ts`.
 *
 * Scaling past one process needs the room-to-process affinity a Redis adapter
 * provides (brief section 68); the socket layer is structured so that adapter
 * can be dropped in without touching these types.
 */

/** A seat in a live room. */
export interface RuntimePlayer {
  userId: string;
  username: string;
  avatarId: number;
  avatarColorIndex: number;

  score: number;
  roundScore: number;

  isReady: boolean;
  isMuted: boolean;
  hasGuessed: boolean;
  guessOrder: number | null;

  connection: ConnectionWire;
  /** Every live socket this player holds. More than one means two devices. */
  socketIds: Set<string>;
  joinedAt: number;
  lastSeenAt: number;
  /** When the reconnect grace period expires, or null while connected. */
  disconnectDeadline: number | null;

  /**
   * What this player has done *this match*, for XP and achievements.
   *
   * ## Why it is tallied in memory and written once
   *
   * A correct guess is worth XP, and a busy room produces a dozen a minute.
   * Writing each one immediately would put a database round trip on the
   * hottest path in the game, for a number nothing reads until the match ends.
   * So the engine counts here and the progression service folds the whole
   * tally into the user row in one `$inc` at `endGame`.
   *
   * ## It is also how "no XP for abandoned games" is enforced
   *
   * Not by a check, but by construction: a tally that never reaches the end of
   * a match is discarded with the room. A game that is abandoned, closed, or
   * paused into oblivion pays nothing, because the only code that reads this
   * runs after the final standings are computed.
   */
  matchStats: RuntimeMatchStats;

  /** Which side this player is on. `none` outside a team mode. */
  team: TeamWire;

  /**
   * Whether this seat is driven by the server rather than by a person.
   *
   * ## Why the flag is on the seat and not looked up
   *
   * The game engine asks "is this a bot" on paths that must not touch the
   * database: every broadcast, every turn transition, and the end-of-match
   * write that decides whose lifetime stats move. A lookup there would put a
   * query on the hot path, and — worse — a lookup that failed would default to
   * *human*, which is the direction that puts an AI on the world leaderboard.
   *
   * ## What being a bot changes
   *
   * Only two things, and neither is inside the rules of play. A bot has no
   * socket, so nothing is ever sent to it and it cannot be impersonated by one
   * — there is no connection to impersonate. And a bot is excluded from the
   * durable writes at the end of a match: lifetime stats, XP, achievements,
   * streaks and every leaderboard. It still draws, guesses, scores and wins
   * exactly as a player does, because the engine does not branch on this
   * anywhere else.
   */
  isBot: boolean;

  /**
   * How hard this bot plays, or null for a person.
   *
   * Set by the server when the seat is created and never read from a payload,
   * so a client cannot make an opponent easier.
   */
  botDifficulty: BotDifficultyWire | null;

  /** The bot's profile key, or null for a person. Used for logging and badges. */
  botId: string | null;
}

/** One player's per-match tally. Reset whenever the room returns to a lobby. */
export interface RuntimeMatchStats {
  correctGuesses: number;
  /** Correct guesses that were the first of their turn. */
  firstGuesses: number;
  /** Correct guesses inside the opening fraction of a turn. */
  fastGuesses: number;
  /** Turns drawn and finished. */
  drawingTurns: number;
  /** Turns drawn where every eligible guesser got it. */
  perfectDrawings: number;
}

/** A fresh tally. One place, so a new counter cannot be forgotten at a seat. */
export function emptyMatchStats(): RuntimeMatchStats {
  return {
    correctGuesses: 0,
    firstGuesses: 0,
    fastGuesses: 0,
    drawingTurns: 0,
    perfectDrawings: 0,
  };
}

/** The live board. Rebuilt from scratch every turn. */
export interface RuntimeBoard {
  /** Committed strokes, in paint order. */
  strokes: StrokeDto[];
  /** Strokes the drawer undid, newest last. Cleared by any new stroke. */
  redoStack: StrokeDto[];
  /**
   * `strokes` keyed by id, so `c:draw:append` is a lookup rather than a scan.
   *
   * Append runs about seventeen times a second per drawer and has to find the
   * stroke the batch belongs to. Searching `strokes` for it is O(n) against an
   * array that grows all turn — at the four-thousand-stroke ceiling that is a
   * four-thousand-element scan seventeen times a second, per room.
   *
   * Optional, and rebuilt by `DrawingService` whenever it disagrees with
   * `strokes` in length. That is what lets every other construction site — and
   * the test helpers, which push strokes directly — stay as they are: a board
   * built without an index simply grows one on first use, and a board mutated
   * behind this service's back is detected and re-indexed rather than silently
   * answering with stale strokes.
   */
  index?: Map<string, StrokeDto>;
}

/** An open vote-kick poll (brief section 45). */
export interface RuntimeVoteKick {
  targetId: string;
  /** Who has voted. A Set makes a duplicate vote a no-op by construction. */
  voterIds: Set<string>;
  /** How many votes are needed. Computed when the poll opens. */
  threshold: number;
  expiresAt: number;
}

/** The live turn. */
export interface RuntimeRound {
  roundId: string;
  roundNumber: number;
  turnNumber: number;
  drawerId: string;

  /** The secret. Never leaves this process except to the drawer. */
  word: string | null;
  wordDifficulty: WordDifficultyWire;
  wordAliases: string[];
  /** What the drawer was offered, so a selection can be verified. */
  wordChoices: (WordItemDto & { aliases: string[] })[];

  hintIndices: number[];
  hintsRevealed: number;

  turnStartMs: number;
  turnEndMs: number;

  /** Correct guessers in the order they got it. */
  correctOrder: string[];
  /** Points awarded this turn, per player id. */
  scoreDeltas: Map<string, number>;

  /** Set once the turn has ended, so the answer may be revealed. */
  ended: boolean;
}

/**
 * One seat in a room's voice group (brief: guesser-only voice chat).
 *
 * Bound to a *socket*, not merely a user. A player signed in on two devices
 * holds two sockets, and a mesh keyed by user id would hand both of them the
 * same offer and build two half-connections for one person. Pinning voice to
 * the socket that asked for it makes "who do I send this SDP to" a single
 * answer, and a second device joining simply takes the seat over.
 */
export interface RuntimeVoiceMember {
  userId: string;
  socketId: string;
  /** Whether their microphone track is currently disabled. */
  muted: boolean;
  joinedAt: number;
}

/**
 * The room's voice group.
 *
 * Membership only — no audio, no SDP and no candidates are ever kept here.
 * The server is a signalling relay: offers, answers and ICE candidates pass
 * through it and are forgotten, and the audio itself never touches this
 * process at all (it goes peer to peer over WebRTC, or via TURN when a NAT
 * forbids that).
 */
export interface RuntimeVoice {
  /** Current voice members, keyed by user id. Never contains the drawer. */
  members: Map<string, RuntimeVoiceMember>;
}

/** A live room: the single source of truth while the process is up. */
/**
 * One recently-broadcast message, kept so it can be reacted to or withdrawn.
 *
 * ## Why this is in memory and bounded
 *
 * A reaction has to resolve a message id to its author — to check that a
 * deletion is the author's own — and doing that in Mongo would be a query per
 * tap on an emoji. It is also pointless past the recent past: nobody reacts to
 * a line that scrolled away ten minutes ago, and the transcript in Mongo is
 * the durable record either way.
 *
 * So the index holds the last `chatIndexLimit` messages of a live room and
 * forgets the rest. A reaction to something older is refused as "no such
 * message", which is indistinguishable from a message that never existed and
 * is the honest answer: this process no longer knows.
 */
export interface RuntimeChatMessage {
  senderId: string;
  /** Emoji to the set of users who reacted with it. */
  reactions: Map<string, Set<string>>;
}

/** A room's recent chat, for reactions and deletion. */
export interface RuntimeChat {
  /** Insertion-ordered, so the oldest entry is the first to evict. */
  recent: Map<string, RuntimeChatMessage>;
  /** Who is typing, to the epoch millisecond their last keystroke arrived. */
  typing: Map<string, number>;
}

/** A fresh chat index. */
export function emptyChat(): RuntimeChat {
  return { recent: new Map(), typing: new Map() };
}

export interface RuntimeRoom {
  roomId: string;
  code: string;
  hostId: string;
  createdAtMs: number;

  settings: RoomSettingsDto;

  /**
   * Who is watching without a seat.
   *
   * A separate map rather than a flag on `players`, and that is the whole
   * design: every rule in the engine iterates `players` — the turn order, the
   * minimum-player check, scoring, the all-guessed test, voice membership. A
   * spectator *flag* would mean auditing every one of those to exclude them,
   * and the one that was missed would be a watcher who could win the game.
   *
   * Being absent from `players` makes "cannot draw, cannot guess, cannot
   * score" true by construction rather than by a check.
   */
  spectators: Map<string, RuntimeSpectator>;

  /** Whether the host has locked the room against new arrivals. */
  locked: boolean;

  /** Recent messages and who is typing. Never persisted. */
  chat: RuntimeChat;
  /** Seats in turn order. A Map keeps insertion order and O(1) lookup. */
  players: Map<string, RuntimePlayer>;
  bannedIds: Set<string>;

  phase: GamePhaseWire;

  gameId: string | null;
  totalRounds: number;
  currentRound: number;
  /** Player ids in the order they draw, fixed when the game starts. */
  turnOrder: string[];
  turnIndex: number;
  turnNumber: number;
  usedWords: Set<string>;

  round: RuntimeRound | null;
  board: RuntimeBoard;
  voteKick: RuntimeVoteKick | null;
  /** Who is in voice right now. Rebuilt from scratch by every turn. */
  voice: RuntimeVoice;

  /** Handles for every timer this room owns, so they can all be cancelled. */
  timers: Map<string, NodeJS.Timeout>;

  /** When the room became empty, or null while somebody is seated. */
  emptySince: number | null;
  closed: boolean;

  /**
   * The bracket match this room exists to play, or null for an ordinary room.
   *
   * ## Why the room knows about the tournament and not the other way round
   *
   * Three things have to happen at moments only the room knows about: nobody
   * outside the pairing may take a seat, the match must start once its
   * participants are present, and the bracket must be told the result the
   * instant the engine computes it. All three are room events. Making the room
   * carry a small, optional back-reference means the game engine's two hooks
   * are one field test each and cost an ordinary room nothing.
   *
   * Everything in it is written by the server when the room is created. There
   * is no path by which a client can set, clear or change it, which is what
   * makes "outsiders cannot enter tournament matches" a property of the room
   * rather than a check somebody has to remember.
   */
  tournament: RuntimeTournamentBinding | null;

  /**
   * Who is allowed to take a seat, or null for a room anybody may join.
   *
   * Checked by `roomService.joinRoom` before anything else about membership.
   * A protected room refuses a stranger even if it has space, is unlocked and
   * is in its lobby — which is exactly what a bracket match needs and what no
   * combination of the existing room settings expresses.
   */
  allowedUserIds: Set<string> | null;
}

/** A room's link back to the bracket position it is playing. */
export interface RuntimeTournamentBinding {
  tournamentId: string;
  matchId: string;
  roundNumber: number;
  matchNumber: number;
  /**
   * The two participants' seat ids, in bracket-slot order.
   *
   * Seat ids, not user ids, because one of them may be a bot — and the result
   * has to be reported back in terms the bracket understands.
   */
  registrationIdByPlayerId: Record<string, string>;
}

/**
 * Somebody watching a room without holding a seat.
 *
 * Deliberately a far smaller record than a player: a spectator has no score,
 * no ready flag, no guess state, no team and no turn. There is nothing here
 * for the game to read, which is exactly the point — a spectator cannot affect
 * a match because there is no field through which they could.
 */
export interface RuntimeSpectator {
  userId: string;
  username: string;
  avatarId: number;
  avatarColorIndex: number;
  /** Every live socket this watcher holds. */
  socketIds: Set<string>;
  joinedAt: number;
}
