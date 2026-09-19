import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectToDatabase } from '@/config/database';
import { resetSocketServer } from '@/config/socket';
import { GAME_CATALOG } from '@/games/catalog';
import { spaceMysteryEngine } from '@/games/spaceMystery/engine';
import { GameRoom } from '@/models/GameRoom';
import { User } from '@/models/User';
import { authService } from '@/services/auth.service';
import { gamePlatformService } from '@/services/game_platform.service';
import { rematchService } from '@/services/rematch.service';
import { attachSocketServer } from '@/socket/socket.server';
import type { GameServer } from '@/types/socket.types';

/**
 * The journey the Flutter lobby actually makes, end to end, over a real socket.
 *
 * ## Why this test exists
 *
 * Every other test in this suite calls a service directly. That is the right
 * shape for a rules engine and it cannot catch the class of bug this file is
 * here for: a client that does everything correctly and still sees nothing.
 *
 * The three games' lobbies create rooms over **REST**, and a REST call has no
 * socket attached to it — so nothing in it can put the caller's connection
 * into the room's broadcast channel. Before `game:subscribe` existed, a host
 * could create a room, seat three bots, ready up, watch the server start a
 * match, and sit on the lobby screen forever, because every broadcast went to
 * a channel they were not in. Nothing threw. Nothing logged. The lobby simply
 * dead-ended, which is exactly what the client phase was asked to fix.
 *
 * So this walks the whole path in the same order the app does:
 *
 *   1. create a room the way the REST controller does;
 *   2. connect a socket and `game:subscribe` to it, which is the bridge;
 *   3. seat bots the way the REST controller does, and expect the broadcast;
 *   4. ready up, and expect `game:match_started` with **this seat's own**
 *      projection;
 *   5. take a turn, and expect the result to arrive as a broadcast.
 *
 * A regression in any of those is a game that cannot be reached, which no
 * amount of adapter testing would notice.
 */

let mongod: MongoMemoryServer;
let http: HttpServer;
let server: GameServer;
let port: number;

/** A real account, because the handshake refuses anything else. */
async function makeUser(name: string): Promise<{ id: string; token: string }> {
  const user = await User.create({
    username: name,
    email: `${name}@example.test`,
    passwordHash: 'x'.repeat(60),
    authProvider: 'email',
    avatarId: 1,
    avatarColorIndex: 2,
  });
  const id = String(user._id);
  return { id, token: authService.issueToken(id, 'email') };
}

/** Connects a client exactly as `SocketService` does: token in the handshake. */
async function connectClient(token: string): Promise<ClientSocket> {
  const socket = connect(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });

  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket never connected')), 8000);
  });
  return socket;
}

/** One request/ack round trip, unwrapped like `SocketService.request` does. */
function request(
  socket: ClientSocket,
  event: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} never acked`)), 8000);
    socket.emit(event, body, (ack: Record<string, unknown>) => {
      clearTimeout(timer);
      if (ack?.ok === true) resolve(ack);
      else reject(new Error(`${event} refused: ${JSON.stringify(ack?.error)}`));
    });
  });
}

/** Waits for one pushed event, which is what the repository listens for. */
function nextEvent(
  socket: ClientSocket,
  event: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${event} never arrived`)),
      timeoutMs,
    );
    socket.once(event, (payload: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

beforeAll(async () => {
  /**
   * Bound to the port and database name the suite's own `MONGODB_URI` names.
   *
   * The handshake middleware calls `connectToDatabase()`, which reads the
   * configured URI at module load — so an ad-hoc connection to a random
   * in-memory port would leave every socket rejected with AUTH_ERROR while
   * mongoose sat happily connected to a database nothing was looking at. The
   * in-memory server therefore stands exactly where the app expects to find
   * one, and the app connects to it by its own ordinary path.
   */
  mongod = await MongoMemoryServer.create({
    instance: { port: 27017, dbName: 'scribbleAndGuess_test' },
  });
  await connectToDatabase();

  http = createServer();
  server = attachSocketServer(http);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  port = (http.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  server.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  resetSocketServer();
  await mongoose.disconnect();
  await mongod.stop();
});

describe('the lobby-to-table journey', () => {
  it('refuses a socket with no token at all', async () => {
    // The whole protocol rests on this: every handler reads
    // `socket.data.user.id` and none of them checks it first.
    await expect(connectClient('not-a-real-token')).rejects.toThrow();
  });

  it('carries a host from an empty lobby to a running Kazhutha match', async () => {
    const host = await makeUser('kazhutha-host');
    const socket = await connectClient(host.token);

    try {
      // (1) The REST lobby's create, called the way its controller calls it.
      const room = await gamePlatformService.createRoom({
        gameId: 'KAZHUTHA',
        owner: {
          id: host.id,
          username: 'kazhutha-host',
          avatarId: 1,
          avatarColorIndex: 2,
        } as never,
        isPrivate: true,
      });
      expect(room.players).toHaveLength(1);

      // (2) The bridge. Without this the socket is in no channels and every
      // assertion below times out — which is precisely the bug it was added
      // to fix, and why this is asserted rather than assumed.
      const attached = await request(socket, 'game:subscribe', {
        gameId: 'KAZHUTHA',
        roomId: room.roomId,
      });
      const attachedRoom = attached.room as Record<string, unknown>;
      expect(attachedRoom.roomId).toBe(room.roomId);
      // No match yet, so the ack carries the room and nothing else.
      expect(attached.match ?? null).toBeNull();

      // (3) Seating bots is REST too, so the broadcast is the only way the
      // host's own screen — and everybody else's — learns about it.
      const updated = nextEvent(socket, 'game:room_updated');
      const seated = await gamePlatformService.addStupids({
        gameId: 'KAZHUTHA',
        roomId: room.roomId,
        actorId: host.id,
        count: 3,
        difficulty: 'HARD',
      });
      expect(seated).toBe(3);

      const broadcast = (await updated).room as Record<string, unknown>;
      const seats = broadcast.players as Record<string, unknown>[];
      expect(seats).toHaveLength(4);
      // The difficulty the host picked reached the seat, which is the whole
      // point of threading it through.
      expect(seats.filter((seat) => seat.isBot)).toHaveLength(3);
      expect(seats.find((seat) => seat.isBot)?.botDifficulty).toBe('HARD');

      // (4) Ready up. Bots are seated ready, so this starts the match — and
      // the *broadcast* is what tells the client, not the REST reply.
      const started = nextEvent(socket, 'game:match_started');
      const result = await gamePlatformService.readyRoom(
        'KAZHUTHA',
        room.roomId,
        host.id,
        true,
      );
      expect(result.started).toBe(true);

      const match = await started;
      expect(match.matchId).toBeTruthy();
      expect(match.status).toBe('playing');

      // This seat's own projection: a real hand of real cards, and counts —
      // never the contents — for everybody else.
      const state = match.state as Record<string, unknown>;
      const hand = state.hand as string[];
      expect(Array.isArray(hand)).toBe(true);
      expect(hand.length).toBeGreaterThan(0);
      expect(hand.every((card) => /^[2-9TJQKA][SHDC]$/.test(card))).toBe(true);
      expect(state.donkeyCard).toBe('QS');

      for (const seat of state.players as Record<string, unknown>[]) {
        // The assertion that matters: no other hand is anywhere in here.
        expect(Object.keys(seat).sort()).toEqual(
          ['cardCount', 'finishPosition', 'out', 'playerId'],
        );
      }

      // (5) A turn. Three of the four seats are bots, so whoever is on turn
      // may already be one — the client only ever acts when it is its own go.
      if (state.currentPlayerId === host.id) {
        const target = (state.players as Record<string, unknown>[]).find(
          (seat) => seat.playerId !== host.id && Number(seat.cardCount) > 0,
        );
        expect(target).toBeDefined();

        const moved = nextEvent(socket, 'game:match_state');
        await request(socket, 'kazhutha:draw_card', {
          gameId: 'KAZHUTHA',
          matchId: match.matchId,
          targetPlayerId: target!.playerId,
          cardIndex: 0,
        });

        // The consequence arrives as a broadcast, which is what keeps the
        // player who acted and the players who did not looking at one table.
        const after = (await moved).state as Record<string, unknown>;
        expect(after.gameId).toBe('KAZHUTHA');
      } else {
        // A bot is on turn. The driver takes it on a timer, and the same
        // broadcast carries it — so the client is fed either way.
        const botTurn = await nextEvent(socket, 'game:match_state', 12_000);
        expect((botTurn.state as Record<string, unknown>).gameId).toBe('KAZHUTHA');
      }
    } finally {
      socket.disconnect();
    }
  }, 60_000);

  it('refuses to attach a socket to a room its user is not seated in', async () => {
    const owner = await makeUser('room-owner');
    const stranger = await makeUser('stranger');

    const room = await gamePlatformService.createRoom({
      gameId: 'BLUFF_BAR',
      owner: {
        id: owner.id, username: 'room-owner', avatarId: 1, avatarColorIndex: 0,
      } as never,
      isPrivate: true,
    });

    const socket = await connectClient(stranger.token);
    try {
      // Otherwise knowing a room id would be enough to watch somebody else's
      // hand arrive ten times a second.
      await expect(
        request(socket, 'game:subscribe', {
          gameId: 'BLUFF_BAR',
          roomId: room.roomId,
        }),
      ).rejects.toThrow();
    } finally {
      socket.disconnect();
    }
  }, 30_000);

  it('starts a Space Mystery match and streams frames to the seat', async () => {
    const host = await makeUser('space-host');
    const socket = await connectClient(host.token);

    try {
      const room = await gamePlatformService.createRoom({
        gameId: 'SPACE_MYSTERY',
        owner: {
          id: host.id, username: 'space-host', avatarId: 3, avatarColorIndex: 1,
        } as never,
        isPrivate: true,
      });

      await request(socket, 'game:subscribe', {
        gameId: 'SPACE_MYSTERY',
        roomId: room.roomId,
      });

      // Four is this game's minimum, so three bots make a match.
      await gamePlatformService.addStupids({
        gameId: 'SPACE_MYSTERY',
        roomId: room.roomId,
        actorId: host.id,
        count: 3,
        difficulty: 'NORMAL',
      });

      const started = nextEvent(socket, 'game:match_started');
      const ready = await gamePlatformService.readyRoom(
        'SPACE_MYSTERY', room.roomId, host.id, true,
      );
      expect(ready.started).toBe(true);

      // The match envelope carries the floor plan — once, because sending it
      // ten times a second would be the largest thing on the wire.
      const match = await started;
      const envelope = match.state as Record<string, unknown>;
      const map = envelope.map as Record<string, unknown>;
      expect((map.rooms as unknown[]).length).toBeGreaterThan(0);
      expect((map.stations as unknown[]).length).toBeGreaterThan(0);

      // And then the simulation's own frames, which is what the ship is drawn
      // from. This is the assertion that proves the realtime path reaches a
      // client at all.
      const frame = await nextEvent(socket, 'space:state', 15_000);
      expect(frame.phase).toBe('station');

      const you = frame.you as Record<string, unknown>;
      expect(['crew', 'traitor']).toContain(you.role);
      expect(you.playerId).toBe(host.id);
      expect(Array.isArray(you.tasks)).toBe(true);

      // Nobody else's role is in the payload — the single most important
      // property of this game's wire format.
      for (const mate of frame.players as Record<string, unknown>[]) {
        if (mate.playerId === host.id) continue;
        if (you.role === 'traitor' && (you.allies as string[]).includes(String(mate.playerId))) {
          continue;
        }
        expect(mate.role, `${String(mate.playerId)} leaked a role`).toBeNull();
      }

      // Movement is accepted and integrated by the server; the client never
      // sends a position.
      socket.emit('space:move', {
        gameId: 'SPACE_MYSTERY',
        matchId: match.matchId,
        dx: 1,
        dy: 0,
      });
      const laterFrame = await nextEvent(socket, 'space:state', 15_000);
      expect(laterFrame.serverMs).toBeDefined();
    } finally {
      socket.disconnect();
    }
  }, 60_000);
});

describe('platform voice, and who the server lets talk', () => {
  /** A room with one human host and enough bots to start. */
  async function tableFor(gameId: 'KAZHUTHA' | 'SPACE_MYSTERY', name: string) {
    const host = await makeUser(name);
    const socket = await connectClient(host.token);

    const room = await gamePlatformService.createRoom({
      gameId,
      owner: { id: host.id, username: name, avatarId: 1, avatarColorIndex: 0 } as never,
      isPrivate: true,
    });
    await request(socket, 'game:subscribe', { gameId, roomId: room.roomId });
    await gamePlatformService.addStupids({
      gameId, roomId: room.roomId, actorId: host.id,
      count: gameId === 'SPACE_MYSTERY' ? 3 : 2, difficulty: 'NORMAL',
    });

    return { host, socket, room };
  }

  it('hands a joiner the ICE servers and the mesh it has to build', async () => {
    const { host, socket, room } = await tableFor('KAZHUTHA', 'voice-kazhutha');
    try {
      await gamePlatformService.readyRoom('KAZHUTHA', room.roomId, host.id, true);

      const ack = await request(socket, 'game:voice_joined', {
        gameId: 'KAZHUTHA',
        roomId: room.roomId,
      });

      // Everything the brief's join acknowledgement names.
      expect(ack.enabled).toBe(true);
      expect(ack.voiceRoomId).toBe(room.roomId);
      expect(ack.reason).toBe('ok');
      expect(ack.muted).toBe(false);
      expect(Array.isArray(ack.peers)).toBe(true);
      // Alone so far, and never listed as its own peer.
      expect(ack.peers).toHaveLength(0);
      // ICE comes from the server so no credential is compiled into the app.
      expect(Array.isArray(ack.iceServers)).toBe(true);

      const muted = await request(socket, 'game:player_muted', {
        gameId: 'KAZHUTHA', roomId: room.roomId, muted: true,
      });
      expect(muted.muted).toBe(true);
    } finally {
      socket.disconnect();
    }
  }, 60_000);

  it('refuses voice to somebody who is not seated in the room', async () => {
    const stranger = await makeUser('voice-stranger');
    const owner = await makeUser('voice-owner');

    const room = await gamePlatformService.createRoom({
      gameId: 'KAZHUTHA',
      owner: { id: owner.id, username: 'voice-owner', avatarId: 1, avatarColorIndex: 0 } as never,
      isPrivate: true,
    });

    const socket = await connectClient(stranger.token);
    try {
      // Knowing a room id must not be enough to join its mesh and listen.
      await expect(
        request(socket, 'game:voice_joined', {
          gameId: 'KAZHUTHA',
          roomId: room.roomId,
        }),
      ).rejects.toThrow(/NOT_IN_GAME|not in that game/i);
    } finally {
      socket.disconnect();
    }
  }, 30_000);

  it('keeps the Meridian silent until a meeting is called', async () => {
    const { host, socket, room } = await tableFor('SPACE_MYSTERY', 'voice-space');
    try {
      await gamePlatformService.readyRoom('SPACE_MYSTERY', room.roomId, host.id, true);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The crew is walking around the ship. An open channel for the whole
      // match cannot be infiltrated — the traitor is whoever stops talking —
      // so voice is closed, and closed by refusal rather than a hidden button.
      await expect(
        request(socket, 'game:voice_joined', {
          gameId: 'SPACE_MYSTERY',
          roomId: room.roomId,
        }),
      ).rejects.toThrow(/VOICE_NOT_AVAILABLE|meeting/i);

      // Call one, and it opens.
      const match = await gamePlatformService.roomSnapshot('SPACE_MYSTERY', room.roomId);
      spaceMysteryEngine.input(String(match.matchId), host.id, { type: 'meeting' });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const ack = await request(socket, 'game:voice_joined', {
        gameId: 'SPACE_MYSTERY',
        roomId: room.roomId,
      });
      expect(ack.enabled).toBe(true);
      expect(ack.reason).toBe('ok');
    } finally {
      socket.disconnect();
    }
  }, 60_000);

  it('will not relay a frame to a player who is not in the mesh', async () => {
    const { host, socket, room } = await tableFor('KAZHUTHA', 'voice-relay');
    try {
      await gamePlatformService.readyRoom('KAZHUTHA', room.roomId, host.id, true);
      await request(socket, 'game:voice_joined', {
        gameId: 'KAZHUTHA', roomId: room.roomId,
      });

      // A bot has a seat but no microphone. Addressing one is how a modified
      // client would probe for who is listening.
      const bots = (await gamePlatformService.roomSnapshot('KAZHUTHA', room.roomId))
        .players.filter((player) => player.isBot);
      expect(bots.length).toBeGreaterThan(0);

      await expect(
        request(socket, 'game:voice_offer', {
          gameId: 'KAZHUTHA',
          roomId: room.roomId,
          targetId: bots[0]!.playerId,
          description: { type: 'offer', sdp: 'v=0' },
        }),
      ).rejects.toThrow();
    } finally {
      socket.disconnect();
    }
  }, 60_000);
});

describe('Bluff Bar, end to end', () => {
  it('deals a hand and accepts a claim', async () => {
    const host = await makeUser('bluff-host');
    const socket = await connectClient(host.token);

    try {
      const room = await gamePlatformService.createRoom({
        gameId: 'BLUFF_BAR',
        owner: { id: host.id, username: 'bluff-host', avatarId: 1, avatarColorIndex: 0 } as never,
        isPrivate: true,
      });
      await request(socket, 'game:subscribe', { gameId: 'BLUFF_BAR', roomId: room.roomId });
      await gamePlatformService.addStupids({
        gameId: 'BLUFF_BAR', roomId: room.roomId, actorId: host.id,
        count: 2, difficulty: 'EASY',
      });

      const started = nextEvent(socket, 'game:match_started');
      await gamePlatformService.readyRoom('BLUFF_BAR', room.roomId, host.id, true);

      const match = await started;
      const state = match.state as Record<string, unknown>;

      // Five cards, each with an instance id — the shoe holds duplicates, so
      // "the ace of spades" is ambiguous and `b07` is not.
      const hand = state.hand as { id: string; card: string }[];
      expect(hand).toHaveLength(5);
      expect(hand.every((entry) => typeof entry.id === 'string')).toBe(true);

      // The shoe's composition is public: it is what makes calling a lie an
      // argument from arithmetic rather than a coin toss.
      expect(state.deckComposition).toBeDefined();
      expect(['A', 'K', 'Q']).toContain(state.tableRank);

      // Nobody else's cards are anywhere in this payload.
      for (const seat of state.players as Record<string, unknown>[]) {
        expect(Object.keys(seat)).not.toContain('hand');
        expect(seat.glassesRemaining).toBe(6);
      }

      if (state.currentPlayerId === host.id) {
        const moved = nextEvent(socket, 'game:match_state');
        await request(socket, 'bluff:declare', {
          gameId: 'BLUFF_BAR',
          matchId: match.matchId,
          cardIds: [hand[0]!.id],
        });

        const after = (await moved).state as Record<string, unknown>;
        // A claim carries a count and never the faces. That is the game.
        const claim = after.lastClaim as Record<string, unknown> | null;
        if (claim) expect(Object.keys(claim).sort()).toEqual(['atMs', 'count', 'playerId']);
      }
    } finally {
      socket.disconnect();
    }
  }, 60_000);
});

describe('rematch', () => {
  it('replays the table when everybody who is asked says yes', async () => {
    const host = await makeUser('rematch-host');
    const socket = await connectClient(host.token);

    try {
      const room = await gamePlatformService.createRoom({
        gameId: 'KAZHUTHA',
        owner: { id: host.id, username: 'rematch-host', avatarId: 1, avatarColorIndex: 0 } as never,
        isPrivate: true,
      });
      await request(socket, 'game:subscribe', { gameId: 'KAZHUTHA', roomId: room.roomId });
      await gamePlatformService.addStupids({
        gameId: 'KAZHUTHA', roomId: room.roomId, actorId: host.id,
        count: 2, difficulty: 'NORMAL',
      });
      await gamePlatformService.readyRoom('KAZHUTHA', room.roomId, host.id, true);

      // Force the match to a close the way a finished game does, so the
      // rematch is offered against a completed room rather than a live one.
      await GameRoom.updateOne(
        { _id: room.roomId },
        { $set: { status: 'completed' } },
      );

      // One human and two bots: the bots are seated as accepted on creation,
      // so the host's own request is the only answer outstanding — and it
      // counts as their yes.
      const restarted = nextEvent(socket, 'game:match_started', 15_000);
      const offer = await request(socket, 'game:rematch_request', {
        gameId: 'KAZHUTHA',
        roomId: room.roomId,
      });

      const rematch = offer.rematch as Record<string, unknown>;
      expect(rematch.accepted).toContain(host.id);
      // Three seats: the host plus both Stupids, who never decline.
      expect((rematch.accepted as string[]).length).toBe(3);

      // And it started, which is the whole point.
      const next = await restarted;
      expect(next.status).toBe('playing');
      expect((next.state as Record<string, unknown>).hand).toBeDefined();
    } finally {
      socket.disconnect();
    }
  }, 60_000);

  it('takes a declining player out of the room rather than carrying them', async () => {
    const host = await makeUser('rematch-asker');
    const guest = await makeUser('rematch-decliner');

    const room = await gamePlatformService.createRoom({
      gameId: 'KAZHUTHA',
      owner: { id: host.id, username: 'rematch-asker', avatarId: 1, avatarColorIndex: 0 } as never,
      isPrivate: true,
    });
    await gamePlatformService.joinRoom('KAZHUTHA', room.roomId, {
      id: guest.id, username: 'rematch-decliner', avatarId: 2, avatarColorIndex: 1,
    } as never);
    await GameRoom.updateOne({ _id: room.roomId }, { $set: { status: 'completed' } });

    await rematchService.request('KAZHUTHA', room.roomId, host.id);
    await rematchService.respond('KAZHUTHA', room.roomId, guest.id, false);

    // Out of the room entirely. Leaving them seated is exactly the trap the
    // offer exists to avoid: everybody else's acceptances would otherwise
    // carry them into a match they had just declined.
    const after = await gamePlatformService.roomSnapshot('KAZHUTHA', room.roomId);
    expect(after.players.some((player) => player.playerId === guest.id)).toBe(false);
  }, 30_000);

  it('refuses to offer a rematch to somebody who is not in the room', async () => {
    const owner = await makeUser('rematch-owner');
    const stranger = await makeUser('rematch-stranger');

    const room = await gamePlatformService.createRoom({
      gameId: 'KAZHUTHA',
      owner: { id: owner.id, username: 'rematch-owner', avatarId: 1, avatarColorIndex: 0 } as never,
      isPrivate: true,
    });
    await GameRoom.updateOne({ _id: room.roomId }, { $set: { status: 'completed' } });

    await expect(
      rematchService.request('KAZHUTHA', room.roomId, stranger.id),
    ).rejects.toThrow();
  }, 30_000);
});

describe('rematch, the awkward cases', () => {
  /// A finished room with one human owner and however many bots.
  async function finishedRoom(
    gameId: 'KAZHUTHA' | 'BLUFF_BAR' | 'SPACE_MYSTERY' | 'LUDO',
    name: string,
    bots: number,
    guests: string[] = [],
  ) {
    const host = await makeUser(name);
    const room = await gamePlatformService.createRoom({
      gameId,
      owner: { id: host.id, username: name, avatarId: 1, avatarColorIndex: 0 } as never,
      isPrivate: true,
    });

    // Everybody is seated *before* the room is marked finished: joining a
    // room that is not waiting is refused, exactly as it should be.
    const seated: { id: string; token: string }[] = [];
    for (const guestName of guests) {
      const guest = await makeUser(guestName);
      await gamePlatformService.joinRoom(gameId, room.roomId, {
        id: guest.id, username: guestName, avatarId: 2, avatarColorIndex: 1,
      } as never);
      seated.push(guest);
    }

    if (bots > 0) {
      await gamePlatformService.addStupids({
        gameId, roomId: room.roomId, actorId: host.id, count: bots, difficulty: 'NORMAL',
      });
    }
    await GameRoom.updateOne({ _id: room.roomId }, { $set: { status: 'completed' } });
    return { host, room, guests: seated };
  }

  it('treats a second request as agreeing with the first', async () => {
    const { host, room, guests } = await finishedRoom('KAZHUTHA', 'dup-host', 0, ['dup-guest']);
    const guest = guests[0]!;

    const first = await rematchService.request('KAZHUTHA', room.roomId, host.id);
    expect(first.accepted).toEqual([host.id]);

    // Two players tapping "Rematch" in the same second is the normal case, not
    // an error. The second tap is agreement, not a competing offer.
    const second = await rematchService.request('KAZHUTHA', room.roomId, guest.id);
    expect(second.requestedBy).toBe(host.id);
    expect(second.accepted).toContain(guest.id);
  }, 30_000);

  it('does not double-count somebody who answers twice', async () => {
    // Two guests, so the offer is still open after the first one answers.
    // With only one, their answer is the last one outstanding and the rematch
    // starts — at which point there is correctly nothing left to answer, and
    // the idempotency this is about could never be exercised.
    const { host, room, guests } = await finishedRoom(
      'KAZHUTHA', 'twice-host', 1, ['twice-guest', 'twice-other'],
    );
    const guest = guests[0]!;

    await rematchService.request('KAZHUTHA', room.roomId, host.id);
    await rematchService.respond('KAZHUTHA', room.roomId, guest.id, true);

    // A double tap, or a reconnect replaying the answer.
    const twice = await rematchService.respond('KAZHUTHA', room.roomId, guest.id, true);

    expect(twice.open).toBe(true);
    expect(twice.accepted.filter((id) => id === guest.id)).toHaveLength(1);
    expect(twice.pending).toEqual([guests[1]!.id]);
  }, 30_000);

  it('closes a lapsed offer rather than leaving it open forever', async () => {
    const { host, room, guests } = await finishedRoom('SPACE_MYSTERY', 'lapse-host', 0, ['lapse-guest']);
    const guest = guests[0]!;

    await rematchService.request('SPACE_MYSTERY', room.roomId, host.id);

    // Wind the deadline into the past rather than waiting thirty seconds. The
    // behaviour under test is what happens *after* it passes, not the clock.
    await GameRoom.updateOne(
      { _id: room.roomId },
      { $set: { 'rematch.deadlineAtMs': Date.now() - 1 } },
    );

    await expect(
      rematchService.respond('SPACE_MYSTERY', room.roomId, guest.id, true),
    ).rejects.toThrow(/expired/i);

    const after = await rematchService.stateFor('SPACE_MYSTERY', room.roomId);
    expect(after.open).toBe(false);
    expect(after.outcome).toBe('failed');
  }, 30_000);

  it('fails cleanly when too few want another round', async () => {
    // Space Mystery needs four. One human alone cannot make a match, and the
    // right answer is to say so rather than to start an unplayable one or to
    // leave them sitting in the room.
    const { host, room } = await finishedRoom('SPACE_MYSTERY', 'short-host', 0);

    const offer = await rematchService.request('SPACE_MYSTERY', room.roomId, host.id);
    expect(offer.minPlayers).toBe(4);

    const settled = await rematchService.stateFor('SPACE_MYSTERY', room.roomId);
    // Either it topped up with bots and started, or it failed — never a match
    // with one player in it.
    if (settled.outcome === 'started') {
      const snapshot = await gamePlatformService.roomSnapshot('SPACE_MYSTERY', room.roomId);
      expect(snapshot.players.length).toBeGreaterThanOrEqual(4);
    } else {
      expect(settled.outcome).toBe('failed');
    }
  }, 30_000);

  it('closes the room when everybody walks away', async () => {
    const { host, room, guests } = await finishedRoom('KAZHUTHA', 'empty-host', 0, ['empty-guest']);
    const guest = guests[0]!;

    await rematchService.request('KAZHUTHA', room.roomId, host.id);
    await rematchService.respond('KAZHUTHA', room.roomId, guest.id, false);
    await gamePlatformService.leaveRoom('KAZHUTHA', room.roomId, host.id).catch(() => null);

    // No stale room left holding seats nobody is in.
    const closed = await GameRoom.findById(room.roomId).lean().exec();
    expect(closed?.players ?? []).toHaveLength(0);
    expect(closed?.status).toBe('closed');
  }, 30_000);

  it('settles an offer whose last outstanding player walked out', async () => {
    // Not the same as declining. Declining is an answer; closing the app and
    // leaving the room is silence, and the seat is gone while the offer is
    // still standing. The failure this guards against is an offer that can
    // never be answered because the only person it is waiting on is no longer
    // in the room — a room that stays open with nobody in it.
    const { host, room, guests } = await finishedRoom(
      'KAZHUTHA', 'walkout-host', 0, ['walkout-guest'],
    );
    const guest = guests[0]!;

    await rematchService.request('KAZHUTHA', room.roomId, host.id);
    const open = await rematchService.stateFor('KAZHUTHA', room.roomId);
    expect(open.pending).toEqual([guest.id]);

    await gamePlatformService.leaveRoom('KAZHUTHA', room.roomId, guest.id);

    // The deadline is the backstop for silence, so drive it rather than
    // waiting thirty seconds for it.
    await GameRoom.updateOne(
      { _id: room.roomId },
      { $set: { 'rematch.deadlineAtMs': Date.now() - 1 } },
    );
    await rematchService.request('KAZHUTHA', room.roomId, host.id);

    const settled = await rematchService.stateFor('KAZHUTHA', room.roomId);
    expect(settled.open).toBe(false);
    // Whatever it decided, nobody is left pending and the departed guest is
    // not still holding a seat.
    expect(settled.pending).toEqual([]);

    const after = await GameRoom.findById(room.roomId).lean().exec();
    expect((after?.players ?? []).map((p) => p.playerId)).not.toContain(guest.id);
  }, 30_000);

  it('offers a rematch on every platform game', async () => {
    // The service is game-agnostic by design, and this is the assertion that
    // keeps it so: a game added later gets rematch without touching it.
    for (const gameId of ['KAZHUTHA', 'BLUFF_BAR', 'LUDO'] as const) {
      const { host, room } = await finishedRoom(gameId, `every-${gameId}`, 1);
      const offer = await rematchService.request(gameId, room.roomId, host.id);

      expect(offer.requestedBy).toBe(host.id);
      // The Stupid is seated as accepted: it is not being asked, it just plays.
      expect(offer.accepted.length).toBeGreaterThanOrEqual(2);
    }
  }, 60_000);
});

describe('the catalogue the client renders its buttons from', () => {
  it('offers bots for all three of the games this work covers', () => {
    // The lobby draws PLAY WITH STUPID straight off this flag, so a game that
    // claims bots it cannot play ships a button that does nothing.
    for (const gameId of ['KAZHUTHA', 'BLUFF_BAR', 'SPACE_MYSTERY']) {
      const game = GAME_CATALOG.find((entry) => entry.gameId === gameId);
      expect(game?.supportsBots, gameId).toBe(true);
    }
  });
});
