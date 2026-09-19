import type { BotPersonality } from '@/games/game.types';

/**
 * The shapes the Space Mystery simulation runs on.
 *
 * Separated from the engine because the bots read most of them and the adapter
 * projects a few, and a three-way import cycle between those files is not
 * worth the one fewer file.
 */

export type SpaceRole = 'crew' | 'traitor';

/** Everything the simulation knows about one body on the ship. */
export interface SpacePlayer {
  playerId: string;
  username: string;
  isBot: boolean;
  botId: string | null;

  /** Null for a person. The dials the bot plays on; see `botPersonalities`. */
  personality: BotPersonality | null;

  role: SpaceRole;
  alive: boolean;

  x: number;
  y: number;

  /** Last movement intent, already clamped to a unit vector. */
  inputX: number;
  inputY: number;

  /** -1 or 1. Presentation only, but the server owns it so ghosts agree. */
  facing: number;

  /** Station ids. A traitor's list is fake and never counts towards repair. */
  tasks: string[];
  completed: string[];

  /** The station being worked at, and when the work finishes. */
  working: { stationId: string; endsAtMs: number } | null;

  /** Milliseconds until this traitor may act again. Always 0 for crew. */
  killCooldownMs: number;

  /** The vent mouth this traitor is hiding in, or null. */
  ventId: string | null;

  /** Bot working memory. Never populated for a person, never read by one. */
  memory: BotMemory | null;
}

export interface SpaceBody {
  playerId: string;
  x: number;
  y: number;
  atMs: number;
}

export type SabotageKind = 'breach' | 'lights' | 'comms';

export interface SpaceSabotage {
  kind: SabotageKind;
  byId: string;
  startedAtMs: number;
  /** When the crew loses (breach) or when it lifts by itself (lights, comms). */
  deadlineAtMs: number;
  /** Who is currently holding each breach station down. */
  holds: Record<string, string | null>;
}

export type MeetingPhase = 'discussion' | 'voting';

export interface SpaceMeeting {
  reason: 'body' | 'emergency';
  callerId: string;
  /** Whose body was found, for the card at the top of the meeting. */
  bodyOf: string | null;
  phase: MeetingPhase;
  endsAtMs: number;
  /** `null` is a deliberate skip, which is different from not having voted. */
  votes: Record<string, string | null>;
  /** What was said. Bots speak here; people use the ordinary room chat too. */
  said: { playerId: string; text: string; atMs: number }[];
}

/**
 * A public thing that happened, for the client to react to.
 *
 * Kept as a short list on the match and replaced every tick rather than
 * accumulated: a client that missed one is a client that was not looking, and
 * a log that grew for a whole match would be the largest thing on the wire.
 */
export interface SpaceEvent {
  type:
    | 'task_done' | 'body_found' | 'meeting' | 'vote_cast' | 'ejected'
    | 'sabotage' | 'sabotage_fixed' | 'vent' | 'eliminated' | 'win';
  playerId?: string;
  targetId?: string;
  detail?: string;
  atMs: number;
}

export interface SpaceMatch {
  matchId: string;
  roomId: string;
  status: 'playing' | 'completed';
  players: Map<string, SpacePlayer>;
  /** Seat order, so the client can colour players consistently. */
  order: string[];
  bodies: SpaceBody[];
  sabotage: SpaceSabotage | null;
  meeting: SpaceMeeting | null;
  /** Emergency meetings each player has left. */
  emergencies: Record<string, number>;
  /** Total real tasks assigned to the crew, and how many are finished. */
  taskTotal: number;
  taskDone: number;
  events: SpaceEvent[];
  result: Record<string, unknown> | null;
  startedAtMs: number;
  lastTickMs: number;
  ticks: number;
}

/**
 * What one bot has worked out, and nothing else.
 *
 * ## The rule this type exists to enforce
 *
 * Every field here is written **only** from that bot's own visible projection
 * — the same one a person in that seat is sent. Nothing in the simulation
 * writes to a bot's memory directly, and the engine passes bots their view
 * rather than the match. That is what stops a crew bot from knowing who the
 * traitor is: it is not that it has been asked not to look, it is that the
 * object it reasons over has never contained the answer.
 *
 * The one exception is deliberate and correct: a traitor bot knows it is a
 * traitor and knows its fellow traitors, because a traitor at the table knows
 * both. That is set at match start, from its own role, and is the only fact in
 * here not learned by looking.
 */
export interface BotMemory {
  /** Where this bot is heading, as nav node ids, nearest first. */
  path: { x: number; y: number }[];
  /** What it is currently trying to do. */
  intent: 'task' | 'wander' | 'hunt' | 'report' | 'meeting' | 'fix' | 'lurk';
  /** The station it is walking to, when [intent] is `task` or `fix`. */
  targetStationId: string | null;
  /** Who it is stalking, when [intent] is `hunt`. */
  targetPlayerId: string | null;

  /** Milliseconds until it reconsiders. Bots do not re-plan every tick. */
  thinkInMs: number;

  /**
   * Suspicion per player, built only from what this bot has actually seen:
   * somebody standing over a body, somebody who was the last one in a room
   * with the victim, somebody who vented in plain sight.
   */
  suspicion: Record<string, number>;

  /** Who it saw where, most recent first. Trimmed; this is not a log. */
  sightings: { playerId: string; roomId: string | null; atMs: number }[];

  /**
   * The room this bot was standing in on the last tick before the meeting.
   *
   * Its alibi, and true: a bot that says it was in the reactor was in the
   * reactor, because this is written from its own position and nowhere else.
   */
  lastRoomId: string | null;

  /** Fellow traitors. Empty for crew, and never written by the simulation. */
  allies: string[];

  /** Whether it has already spoken in the current meeting. */
  spoke: boolean;
}
