import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GAME_PHASE } from '@/constants/room.constants';
import { BOT_DIFFICULTY } from '@/constants/autoTournament.constants';
import { botProfileService, type BotIdentity } from '@/services/bot/botProfile.service';
import { roomService } from '@/services/room.service';
import { StupidsService } from '@/services/stupids.service';
import type { RuntimePlayer, RuntimeRoom } from '@/types/socket.types';
import { makePlayer, makeRoom } from './helpers';

/**
 * PLAY WITH STUPID: who may seat bots, how many, and what happens at the edges.
 *
 * The service is tested against runtime rooms directly — no socket, no
 * registry — because everything it decides is a pure function of the room and
 * the caller. The one thing it does not own is what a Stupid *does* once
 * seated: that is `botPlayerService`, covered by `botPlayer.test.ts`, and the
 * separation is the point — this file proves seats appear, that file proves
 * they play by the rules.
 */

const service = new StupidsService();

/** A six-strong roster, enough to exhaust in a test. */
const ROSTER: BotIdentity[] = Array.from({ length: 6 }, (_, index) => ({
  botId: `stupid-${index}`,
  playerId: `bot-id-${index}`,
  displayName: `Stupid ${index}`,
  avatarId: index,
  avatarColorIndex: index,
  difficulty: BOT_DIFFICULTY.normal,
}));

/** A lobby with one human host and room for seven more. */
function lobby(overrides: Partial<Omit<RuntimeRoom, 'players'>> & { players?: RuntimePlayer[] } = {}): RuntimeRoom {
  const room = makeRoom({
    players: [makePlayer({ userId: 'host' })],
    phase: GAME_PHASE.lobby,
    ...overrides,
  });
  room.hostId = overrides.hostId ?? 'host';
  return room;
}

beforeEach(() => {
  // `take` slices the roster from a rotation offset, so it is stubbed to a
  // plain prefix: this file is about seating rules, and a test that also had
  // to predict the rotation would fail for the wrong reason when the rotation
  // changed.
  vi.spyOn(botProfileService, 'take').mockImplementation(
    async ({ count }: { count: number }) => ROSTER.slice(0, count),
  );
  // Persistence is the room repository's job and has its own tests; here it
  // would only be a database round trip in the middle of a pure-logic check.
  vi.spyOn(roomService, 'persist').mockResolvedValue(undefined);
});

describe('seating Stupids', () => {
  it('seats the number asked for', async () => {
    const room = lobby();

    const seated = await service.seat({ room, actorId: 'host', count: 3 });

    expect(seated).toHaveLength(3);
    expect(room.players.size).toBe(4);
    expect([...room.players.values()].filter((player) => player.isBot)).toHaveLength(3);
  });

  it('marks every seated Stupid as a bot with no socket', async () => {
    const room = lobby();

    await service.seat({ room, actorId: 'host', count: 1 });

    const bot = [...room.players.values()].find((player) => player.isBot);
    expect(bot?.isBot).toBe(true);
    // No socket ids is what makes every broadcast helper skip a bot for free —
    // including the one that sends the drawer their word. A bot that somehow
    // acquired one could be sent the answer.
    expect(bot?.socketIds.size).toBe(0);
  });

  it('clamps the ask to the seats actually free', async () => {
    // Seven of eight seats taken: one free, four asked for.
    const room = lobby({
      players: Array.from({ length: 7 }, (_, index) => makePlayer({ userId: `p${index}` })),
      hostId: 'p0',
    });

    const seated = await service.seat({ room, actorId: 'p0', count: 4 });

    expect(seated).toHaveLength(1);
    expect(room.players.size).toBe(room.settings.maxPlayers);
  });

  it('never seats the same Stupid twice', async () => {
    const room = lobby();

    await service.seat({ room, actorId: 'host', count: 2 });
    await service.seat({ room, actorId: 'host', count: 2 });

    const botIds = [...room.players.values()]
      .filter((player) => player.isBot)
      .map((player) => player.botId);

    expect(botIds).toHaveLength(4);
    expect(new Set(botIds).size).toBe(4);
  });

  it('refuses anybody but the host', async () => {
    const room = lobby({
      players: [makePlayer({ userId: 'host' }), makePlayer({ userId: 'guest' })],
    });

    await expect(
      service.seat({ room, actorId: 'guest', count: 1 }),
    ).rejects.toThrow();
  });

  it('refuses once the match has started', async () => {
    const room = lobby({ phase: GAME_PHASE.drawing });

    await expect(
      service.seat({ room, actorId: 'host', count: 1 }),
    ).rejects.toThrow();
  });

  it('refuses a full room', async () => {
    const room = lobby({
      players: Array.from({ length: 8 }, (_, index) => makePlayer({ userId: `p${index}` })),
      hostId: 'p0',
    });

    await expect(
      service.seat({ room, actorId: 'p0', count: 1 }),
    ).rejects.toThrow();
  });

  it('refuses a room with no people left in it', async () => {
    // A room of nothing but bots is one the engine is about to close. Seating
    // more into it would keep it alive with nobody watching.
    const room = lobby({
      players: [makePlayer({ userId: 'host', isBot: true, botId: 'stupid-9' })],
    });

    await expect(
      service.seat({ room, actorId: 'host', count: 1 }),
    ).rejects.toThrow();
  });
});

describe('clearing Stupids', () => {
  it('removes every bot and leaves the people', async () => {
    const room = lobby({
      players: [makePlayer({ userId: 'host' }), makePlayer({ userId: 'friend' })],
    });
    await service.seat({ room, actorId: 'host', count: 3 });

    const removed = await service.clear(room, 'host');

    expect(removed).toBe(3);
    expect(room.players.size).toBe(2);
    expect([...room.players.values()].every((player) => !player.isBot)).toBe(true);
  });

  it('refuses anybody but the host', async () => {
    const room = lobby({
      players: [makePlayer({ userId: 'host' }), makePlayer({ userId: 'guest' })],
    });

    await expect(service.clear(room, 'guest')).rejects.toThrow();
  });

  it('refuses once the match has started', async () => {
    const room = lobby({ phase: GAME_PHASE.drawing });

    await expect(service.clear(room, 'host')).rejects.toThrow();
  });
});
