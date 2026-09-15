import { beforeEach, describe, expect, it } from 'vitest';

import { GAME_PHASE } from '@/constants/room.constants';
import {
  MatchmakingService,
  quickPlaySettings,
  resetQuickPlayGate,
} from '@/services/matchmaking.service';
import type { RuntimePlayer, RuntimeRoom } from '@/types/socket.types';
import { makePlayer, makeRoom } from './helpers';

/**
 * Quick Play matchmaking: which rooms are candidates, and in what order.
 *
 * The eligibility rules and the ranking are pure functions of a room and a
 * user, so they are tested directly against runtime rooms — no database, no
 * socket, no registry. What is *not* covered here is the seating itself
 * (`roomService.joinRoom`, already covered by the room tests) and the retry
 * loop around it, which needs the live registry.
 */

const service = new MatchmakingService();

/** No blocks, the ordinary case. */
const NOBODY = new Set<string>();

/**
 * Overrides accepted by the builders.
 *
 * `players` is a `Map` on a `RuntimeRoom` but a plain array here, because
 * that is what `makeRoom` takes — it builds the map from it. Spelling the type
 * out rather than reaching for `Partial<RuntimeRoom>` is what keeps the two
 * from disagreeing.
 */
type RoomOverrides = Partial<Omit<RuntimeRoom, 'players'>> & {
  players?: RuntimePlayer[];
};

/** A public room in the lobby with one player and room for more. */
function waitingRoom(overrides: RoomOverrides = {}): RuntimeRoom {
  return makeRoom({
    players: [makePlayer({ userId: 'host' })],
    settings: quickPlaySettings(),
    phase: GAME_PHASE.lobby,
    ...overrides,
  });
}

beforeEach(() => {
  resetQuickPlayGate();
});

describe('quick play settings', () => {
  it('opens rooms that the next player can find', () => {
    // The one field that has to be right: a private quick-play room would be
    // invisible to the next Play tap, so every room would be a room of one.
    expect(quickPlaySettings().isPrivate).toBe(false);
  });

  it('otherwise uses the ordinary game defaults', () => {
    const settings = quickPlaySettings();
    expect(settings.maxPlayers).toBe(8);
    expect(settings.rounds).toBe(3);
    expect(settings.language).toBe('en');
    expect(settings.wordMode).toBe('normal');
    expect(settings.customWords).toEqual([]);
  });
});

describe('candidate eligibility', () => {
  it('accepts a public room waiting in the lobby', () => {
    expect(service.rejectionFor(waitingRoom(), 'me', NOBODY)).toBeNull();
  });

  it('ignores private rooms', () => {
    const room = waitingRoom({ settings: { ...quickPlaySettings(), isPrivate: true } });
    expect(service.rejectionFor(room, 'me', NOBODY)).toBe('private');
  });

  it('ignores full rooms', () => {
    const room = waitingRoom({
      players: [makePlayer({ userId: 'a' }), makePlayer({ userId: 'b' })],
      settings: { ...quickPlaySettings(), maxPlayers: 2 },
    });
    expect(service.rejectionFor(room, 'me', NOBODY)).toBe('full');
  });

  it('ignores a room that is one player over its own lowered cap', () => {
    // `updateSettings` floors `maxPlayers` at the current occupancy, so a room
    // can legitimately sit at exactly its cap. It is still full.
    const room = waitingRoom({
      players: [makePlayer({ userId: 'a' }), makePlayer({ userId: 'b' })],
      settings: { ...quickPlaySettings(), maxPlayers: 2 },
    });
    expect(service.rejectionFor(room, 'me', NOBODY)).toBe('full');
  });

  it('ignores games already in progress', () => {
    for (const phase of [
      GAME_PHASE.starting,
      GAME_PHASE.wordSelection,
      GAME_PHASE.drawing,
      GAME_PHASE.roundEnd,
    ]) {
      expect(service.rejectionFor(waitingRoom({ phase }), 'me', NOBODY)).toBe('in_progress');
    }
  });

  it('ignores a room showing its final scoreboard', () => {
    const room = waitingRoom({ phase: GAME_PHASE.gameEnd });
    expect(service.rejectionFor(room, 'me', NOBODY)).toBe('finishing');
  });

  it('accepts a paused room, which is waiting for exactly this player', () => {
    // A paused match has dropped below the minimum player count. Sending
    // somebody there is what restarts it.
    const room = waitingRoom({ phase: GAME_PHASE.paused });
    expect(service.rejectionFor(room, 'me', NOBODY)).toBeNull();
  });

  it('ignores closed rooms', () => {
    expect(service.rejectionFor(waitingRoom({ closed: true }), 'me', NOBODY)).toBe('closed');
  });

  it('ignores a room this player is banned from', () => {
    const room = waitingRoom({ bannedIds: new Set(['me']) });
    expect(service.rejectionFor(room, 'me', NOBODY)).toBe('banned');
  });

  it('ignores the room the player is already sitting in', () => {
    const room = waitingRoom({ players: [makePlayer({ userId: 'me' })] });
    expect(service.rejectionFor(room, 'me', NOBODY)).toBe('self');
  });

  it('ignores a room holding somebody a block stands between', () => {
    const room = waitingRoom({
      players: [makePlayer({ userId: 'host' }), makePlayer({ userId: 'enemy' })],
    });
    expect(service.rejectionFor(room, 'me', new Set(['enemy']))).toBe('blocked');
  });

  it('does not reject a room merely because a blocked user exists elsewhere', () => {
    const room = waitingRoom();
    expect(service.rejectionFor(room, 'me', new Set(['enemy']))).toBeNull();
  });

  it('checks privacy before occupancy', () => {
    // A private room is never a candidate, however empty. Reporting it as
    // "full" instead would be a confusing thing to see in the debug log.
    const room = waitingRoom({
      players: [],
      settings: { ...quickPlaySettings(), isPrivate: true },
    });
    expect(service.rejectionFor(room, 'me', NOBODY)).toBe('private');
  });
});

describe('candidate ranking', () => {
  /** Ranks a fixed set without touching the live registry. */
  function rank(rooms: RuntimeRoom[], blocked: Set<string> = NOBODY): RuntimeRoom[] {
    return rooms
      .filter((room) => service.rejectionFor(room, 'me', blocked) === null)
      .sort((a, b) => b.players.size - a.players.size || a.createdAtMs - b.createdAtMs);
  }

  it('prefers the room closest to starting', () => {
    const empty = waitingRoom({ roomId: 'empty', code: 'AAAAA', players: [] });
    const nearlyFull = waitingRoom({
      roomId: 'busy',
      code: 'BBBBB',
      players: [makePlayer({ userId: 'a' }), makePlayer({ userId: 'b' })],
    });

    // A player dropped into an empty room waits for strangers; one sent to a
    // room that is a player short of a game starts playing.
    expect(rank([empty, nearlyFull])[0]?.roomId).toBe('busy');
  });

  it('breaks ties on age, oldest first', () => {
    const older = waitingRoom({ roomId: 'older', code: 'AAAAA', createdAtMs: 1_000 });
    const newer = waitingRoom({ roomId: 'newer', code: 'BBBBB', createdAtMs: 2_000 });

    // Converges a burst of simultaneous taps on one room instead of scattering
    // players across several half-empty ones.
    expect(rank([newer, older]).map((room) => room.roomId)).toEqual(['older', 'newer']);
  });

  it('is deterministic for the same input', () => {
    const rooms = [
      waitingRoom({ roomId: 'a', code: 'AAAAA', createdAtMs: 3 }),
      waitingRoom({ roomId: 'b', code: 'BBBBB', createdAtMs: 1 }),
      waitingRoom({ roomId: 'c', code: 'CCCCC', createdAtMs: 2 }),
    ];

    const first = rank(rooms).map((room) => room.roomId);
    const second = rank([...rooms].reverse()).map((room) => room.roomId);

    expect(first).toEqual(second);
  });

  it('returns nothing when every room is ineligible', () => {
    const rooms = [
      waitingRoom({ settings: { ...quickPlaySettings(), isPrivate: true } }),
      waitingRoom({ phase: GAME_PHASE.drawing }),
      waitingRoom({ closed: true }),
    ];

    // Which is what makes the caller open a new room.
    expect(rank(rooms)).toEqual([]);
  });
});
