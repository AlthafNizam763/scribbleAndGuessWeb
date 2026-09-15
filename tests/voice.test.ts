import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GAME_PHASE } from '@/constants/room.constants';
import type { RuntimeRoom } from '@/types/socket.types';
import { AppError, ErrorCode } from '@/utils/errors';

import { makePlayer, makeRoom, makeRound } from './helpers';

/**
 * Guesser-only voice chat, and the one rule it exists to enforce.
 *
 * These tests are about *permission*, not about WebRTC. Nothing here opens a
 * peer connection or touches an SDP blob, because the server never does
 * either — it admits people to a group and relays strings between them, and
 * whether it admits the right people is the entire security surface.
 *
 * The socket layer is stubbed to a pair of recorders. That is deliberate: the
 * brief's security test is "emit `voice:join` from the drawer's client and
 * check the server refuses", and refusing is a property of the service, not of
 * Socket.IO. Driving a real socket here would test the transport.
 */

const emitted: { socketId: string; event: string; payload: unknown }[] = [];
const voiceEmitted: { roomId: string; event: string; payload: unknown }[] = [];

vi.mock('@/config/socket', () => ({
  emitToSocket: (socketId: string, event: string, payload: unknown) => {
    emitted.push({ socketId, event, payload });
  },
  emitToVoice: (roomId: string, event: string, payload: unknown) => {
    voiceEmitted.push({ roomId, event, payload });
  },
  // No server instance in a unit test: `detachSocket` finds nothing to detach,
  // which is exactly what happens for a socket that has already gone.
  getSocketServer: () => null,
}));

const { voiceService } = await import('@/services/voice.service');

/** A stand-in for the parts of `GameSocket` the voice service actually uses. */
function makeSocket(userId: string, socketId = `sock-${userId}`) {
  const joined = new Set<string>();
  const sentToOthers: { event: string; payload: unknown }[] = [];

  return {
    id: socketId,
    data: { user: { id: userId }, roomId: 'room-1', buckets: new Map() },
    join: (channel: string) => joined.add(channel),
    leave: (channel: string) => joined.delete(channel),
    to: () => ({
      emit: (event: string, payload: unknown) => sentToOthers.push({ event, payload }),
    }),
    joined,
    sentToOthers,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** A room mid-turn: `a` holds the pen, `b`, `c` and `d` are guessing. */
function drawingRoom(): RuntimeRoom {
  return makeRoom({
    phase: GAME_PHASE.drawing,
    players: [makePlayer({ userId: 'a' }), makePlayer({ userId: 'b' }), makePlayer({ userId: 'c' }), makePlayer({ userId: 'd' })],
    round: makeRound({ drawerId: 'a' }),
  });
}

/** Asserts a thrown `AppError` carries one specific code. */
function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(AppError.isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

beforeEach(() => {
  emitted.length = 0;
  voiceEmitted.length = 0;
});

describe('the drawer is refused', () => {
  it('cannot join voice', () => {
    const room = drawingRoom();
    expectCode(() => voiceService.join(room, makeSocket('a')), ErrorCode.DRAWER_VOICE_DISABLED);
    expect(room.voice.members.size).toBe(0);
  });

  it('cannot send an offer, an answer or a candidate', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));

    // All three signalling verbs go through `requirePeer`, so one refusal
    // covers offer, answer and ICE alike.
    expectCode(() => voiceService.requirePeer(room, 'a', 'b'), ErrorCode.DRAWER_VOICE_DISABLED);
  });

  it('cannot be addressed by a guesser', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));

    // `a` is not even in the group, but the refusal names the reason rather
    // than reporting a missing peer — a guesser must never be told to open a
    // connection to the drawer.
    expectCode(() => voiceService.requirePeer(room, 'b', 'a'), ErrorCode.DRAWER_VOICE_DISABLED);
  });

  it('cannot mute or unmute', () => {
    const room = drawingRoom();
    expectCode(() => voiceService.setMuted(room, 'a', true), ErrorCode.DRAWER_VOICE_DISABLED);
  });

  it('is never handed as a peer to anybody', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));
    voiceService.join(room, makeSocket('c'));

    const peers = voiceService.peers(room);
    expect(peers.map((peer) => peer.userId).sort()).toEqual(['b', 'c']);
    expect(voiceService.stateFor(room, 'b').peers.map((peer) => peer.userId)).toEqual(['c']);
  });

  it('is told voice is off, with no peers and no ICE servers', () => {
    const room = drawingRoom();
    const state = voiceService.stateFor(room, 'a');

    expect(state.enabled).toBe(false);
    expect(state.isDrawer).toBe(true);
    expect(state.peers).toEqual([]);
    // Withheld deliberately: a client that may not connect has no use for a
    // relay credential.
    expect(state.iceServers).toEqual([]);
  });
});

describe('guessers', () => {
  it('form a full mesh with each other', () => {
    const room = drawingRoom();

    // Each joiner is handed exactly the peers already in the group, which is
    // what makes the mesh complete without duplicating a connection: B gets
    // nobody, C gets B, D gets B and C.
    expect(voiceService.join(room, makeSocket('b'))).toEqual([]);
    expect(voiceService.join(room, makeSocket('c')).map((p) => p.userId)).toEqual(['b']);
    expect(voiceService.join(room, makeSocket('d')).map((p) => p.userId)).toEqual(['b', 'c']);

    expect(room.voice.members.size).toBe(3);
    expect(room.voice.members.has('a')).toBe(false);
  });

  it('may mute and unmute, and the change is visible to peers', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));
    voiceService.join(room, makeSocket('c'));

    expect(voiceService.setMuted(room, 'b', true)).toBe(true);
    // Setting it again is not a change, so no event goes out for it.
    expect(voiceService.setMuted(room, 'b', true)).toBe(false);

    expect(voiceService.stateFor(room, 'c').peers).toEqual([{ userId: 'b', muted: true }]);
  });

  it('get ICE servers with their state', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));

    const state = voiceService.stateFor(room, 'b');
    expect(state.enabled).toBe(true);
    // The STUN default from `env.ts`. TURN is absent unless configured, which
    // is the point: voice works for free out of the box.
    expect(state.iceServers[0]?.urls).toContain('stun:stun.l.google.com:19302');
  });

  it('keep their mute state across a rejoin', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b', 'sock-1'));
    voiceService.setMuted(room, 'b', true);

    // A reconnect: same player, new socket. The seat moves rather than
    // doubling up, and the microphone stays where the player left it.
    voiceService.join(room, makeSocket('b', 'sock-2'));

    expect(room.voice.members.size).toBe(1);
    expect(room.voice.members.get('b')?.socketId).toBe('sock-2');
    expect(room.voice.members.get('b')?.muted).toBe(true);
  });
});

describe('reconciliation', () => {
  it('hangs up the player who has just become the drawer', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));
    voiceService.join(room, makeSocket('c'));
    voiceService.join(room, makeSocket('d'));

    // The pen moves to B. Nothing else about the room changes.
    room.round = makeRound({ drawerId: 'b' });
    voiceService.reconcile(room);

    expect(room.voice.members.has('b')).toBe(false);
    expect([...room.voice.members.keys()].sort()).toEqual(['c', 'd']);

    // The group is told to close their connection to B...
    expect(voiceEmitted.some((e) => e.event === 's:voice:peerLeft')).toBe(true);
    // ...and B itself is told directly, because it is no longer in the group
    // that got the announcement. Without this the new drawer's microphone
    // would stay live.
    const toB = emitted.find((e) => e.socketId === 'sock-b');
    expect(toB?.event).toBe('s:voice:state');
    expect((toB?.payload as { enabled: boolean }).enabled).toBe(false);
  });

  it('lets the previous drawer back in when the pen moves on', () => {
    const room = drawingRoom();
    expectCode(() => voiceService.join(room, makeSocket('a')), ErrorCode.DRAWER_VOICE_DISABLED);

    room.round = makeRound({ drawerId: 'b' });
    voiceService.reconcile(room);

    expect(voiceService.stateFor(room, 'a').enabled).toBe(true);
    expect(() => voiceService.join(room, makeSocket('a'))).not.toThrow();
  });

  it('empties the group when the match leaves a voice phase', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));
    voiceService.join(room, makeSocket('c'));

    room.phase = GAME_PHASE.paused;
    voiceService.reconcile(room);

    expect(room.voice.members.size).toBe(0);
  });

  it('drops a player the room has written off', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));
    voiceService.join(room, makeSocket('c'));

    room.players.get('b')!.connection = 'disconnected';
    voiceService.reconcile(room);

    expect([...room.voice.members.keys()]).toEqual(['c']);
  });

  it('drops a player who left the room outright', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));
    voiceService.join(room, makeSocket('c'));

    room.players.delete('b');
    voiceService.reconcile(room);

    expect([...room.voice.members.keys()]).toEqual(['c']);
  });

  it('is silent when nothing moved', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));
    voiceService.join(room, makeSocket('c'));

    voiceEmitted.length = 0;
    emitted.length = 0;

    // Runs on every state broadcast — every hint, every guess — so a no-op has
    // to actually cost nothing on the wire.
    voiceService.reconcile(room);
    voiceService.reconcile(room);

    expect(voiceEmitted).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

describe('phases without a voice group', () => {
  it('refuses a join in the lobby', () => {
    const room = makeRoom({
      phase: GAME_PHASE.lobby,
      players: [makePlayer({ userId: 'a' }), makePlayer({ userId: 'b' })],
    });

    expectCode(() => voiceService.join(room, makeSocket('b')), ErrorCode.INVALID_ACTION);
  });

  it('refuses a join from somebody who is not in the room', () => {
    const room = drawingRoom();
    expectCode(() => voiceService.join(room, makeSocket('stranger')), ErrorCode.NOT_ROOM_MEMBER);
  });

  it('allows voice across the scoreboard between turns', () => {
    const room = drawingRoom();
    room.phase = GAME_PHASE.roundEnd;

    // The turn is over but the pen has not moved yet, so the rule still names
    // the same person.
    expect(voiceService.stateFor(room, 'b').enabled).toBe(true);
    expect(voiceService.stateFor(room, 'a').enabled).toBe(false);
  });
});

describe('leaving', () => {
  it('is always permitted, including for the drawer', () => {
    const room = drawingRoom();
    voiceService.join(room, makeSocket('b'));

    // A client that has just been made drawer calls this to comply. It must
    // never be refused for being the drawer, or the compliant client would be
    // stuck holding a connection it was told to drop.
    room.round = makeRound({ drawerId: 'b' });
    expect(() => voiceService.leave(room, 'b', 'left')).not.toThrow();
    expect(room.voice.members.size).toBe(0);
  });

  it('is a no-op for somebody who never joined', () => {
    const room = drawingRoom();
    expect(voiceService.leave(room, 'c', 'left')).toBe(false);
    expect(voiceEmitted).toEqual([]);
  });
});
