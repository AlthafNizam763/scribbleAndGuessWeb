import type { Server, Socket } from 'socket.io';

import type { ConnectionWire, GamePhaseWire, WordDifficultyWire } from '@/constants/room.constants';
import type { AuthenticatedUser } from '@/types/auth.types';
import type { StrokeDto } from '@/types/drawing.types';
import type { WordItemDto } from '@/types/game.types';
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
}

/** The live board. Rebuilt from scratch every turn. */
export interface RuntimeBoard {
  /** Committed strokes, in paint order. */
  strokes: StrokeDto[];
  /** Strokes the drawer undid, newest last. Cleared by any new stroke. */
  redoStack: StrokeDto[];
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

/** A live room: the single source of truth while the process is up. */
export interface RuntimeRoom {
  roomId: string;
  code: string;
  hostId: string;
  createdAtMs: number;

  settings: RoomSettingsDto;
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

  /** Handles for every timer this room owns, so they can all be cancelled. */
  timers: Map<string, NodeJS.Timeout>;

  /** When the room became empty, or null while somebody is seated. */
  emptySince: number | null;
  closed: boolean;
}
