import { GAME_PHASE } from '@/constants/room.constants';
import { defaultSettings } from '@/services/room.service';
import { TEAM } from '@/constants/gameModes.constants';
import { emptyChat, emptyMatchStats } from '@/types/socket.types';
import type { RuntimePlayer, RuntimeRoom, RuntimeRound } from '@/types/socket.types';

/**
 * Builders for the in-memory game state.
 *
 * The runtime room is a plain object, which is what makes the engine testable
 * without a database or a socket: a test can construct exactly the situation
 * it cares about — mid-turn, one player disconnected, three already guessed —
 * and call the service directly.
 */

export function makePlayer(overrides: Partial<RuntimePlayer> & { userId: string }): RuntimePlayer {
  return {
    // Spread below, so a test can hand in a partial tally and still get a
    // complete one — the progression counters are read unconditionally by the
    // end-of-match path, and a missing field there is a crash rather than a
    // zero.
    matchStats: emptyMatchStats(),
    team: TEAM.none,
    username: `player-${overrides.userId}`,
    avatarId: 0,
    avatarColorIndex: 0,
    score: 0,
    roundScore: 0,
    isReady: false,
    isMuted: false,
    hasGuessed: false,
    guessOrder: null,
    connection: 'connected',
    socketIds: new Set<string>(),
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
    disconnectDeadline: null,
    ...overrides,
  };
}

export function makeRound(overrides: Partial<RuntimeRound> = {}): RuntimeRound {
  const now = Date.now();
  return {
    roundId: 'round-1',
    roundNumber: 1,
    turnNumber: 1,
    drawerId: 'a',
    word: 'guitar',
    wordDifficulty: 'medium',
    wordAliases: [],
    wordChoices: [],
    hintIndices: [],
    hintsRevealed: 0,
    turnStartMs: now,
    turnEndMs: now + 60_000,
    correctOrder: [],
    scoreDeltas: new Map<string, number>(),
    ended: false,
    ...overrides,
  };
}

export function makeRoom(
  overrides: Partial<Omit<RuntimeRoom, 'players'>> & { players?: RuntimePlayer[] } = {},
): RuntimeRoom {
  const { players, ...rest } = overrides;

  const room: RuntimeRoom = {
    roomId: 'room-1',
    code: 'A7K9P',
    hostId: players?.[0]?.userId ?? 'a',
    createdAtMs: Date.now(),
    settings: defaultSettings(),
    players: new Map((players ?? []).map((player) => [player.userId, player])),
    bannedIds: new Set<string>(),
    phase: GAME_PHASE.lobby,
    gameId: null,
    totalRounds: 3,
    currentRound: 0,
    turnOrder: [],
    turnIndex: 0,
    turnNumber: 0,
    usedWords: new Set<string>(),
    round: null,
    board: { strokes: [], redoStack: [] },
    voteKick: null,
    voice: { members: new Map() },
    chat: emptyChat(),
    spectators: new Map(),
    locked: false,
    timers: new Map(),
    emptySince: null,
    closed: false,
    ...rest,
  };

  return room;
}
