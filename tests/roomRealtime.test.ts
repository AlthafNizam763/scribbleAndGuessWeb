import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as socketConfig from '@/config/socket';
import { TIMING } from '@/constants/game.constants';
import { CONNECTION, INVITATION_STATUS } from '@/constants/room.constants';
import { ROOM_EVENTS } from '@/constants/socket.constants';
import { blockRepository } from '@/repositories/block.repository';
import { friendRepository } from '@/repositories/friend.repository';
import { invitationRepository } from '@/repositories/invitation.repository';
import { roomRepository } from '@/repositories/room.repository';
import { userRepository } from '@/repositories/user.repository';
import { chatService } from '@/services/chat.service';
import { gameService } from '@/services/game.service';
import { invitationService } from '@/services/invitation.service';
import { notificationService } from '@/services/notification.service';
import { presenceService } from '@/services/presence.service';
import { roomService } from '@/services/room.service';
import type { AuthenticatedUser } from '@/types/auth.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { makePlayer, makeRoom } from './helpers';

/**
 * The two halves of the invite feature that are about *time* rather than about
 * rules: a push that has to land while the player is looking at something
 * else, and a seat that has to survive a connection that does not.
 *
 * `invitation.test.ts` covers the decisions — who may invite whom, what
 * refuses an accept. Neither of these is a decision, which is why they live
 * apart from it:
 *
 *   - **Case 2, delivered in real time.** The service's job is done when it
 *     has written the row; whether the invitee *sees* it without refreshing
 *     depends entirely on an emit that no rule test would notice the absence
 *     of. A silently dropped `notifyUserRoomEvent` would leave every existing
 *     test green and the feature broken.
 *
 *   - **Case 15, disconnect and reconnect.** The brief requires a dropped
 *     player's state to be preserved "temporarily" and removed "after the
 *     configured timeout". Both halves are the same code path observed at two
 *     different times, so the only way to test either is to control the clock.
 *
 * `@/config/socket` is mocked at the emit functions only — the rest of the
 * module is real — so what is asserted is that the service reached for the
 * transport, not that a socket server exists.
 */

vi.mock('@/config/socket', async (importOriginal) => {
  const actual = await importOriginal<typeof socketConfig>();
  return { ...actual, emitToUser: vi.fn(), emitToRoom: vi.fn() };
});

const HOST_ID = '507f1f77bcf86cd799439011';
const FRIEND_ID = '507f1f77bcf86cd799439012';
const ROOM_ID = '507f1f77bcf86cd799439013';
const INVITATION_ID = '507f1f77bcf86cd7994390ff';

const HOST: AuthenticatedUser = {
  id: HOST_ID,
  username: 'Ana',
  avatarId: 1,
  avatarColorIndex: 2,
} as AuthenticatedUser;

const FRIEND: AuthenticatedUser = {
  id: FRIEND_ID,
  username: 'Bo',
  avatarId: 3,
  avatarColorIndex: 4,
} as AuthenticatedUser;

/** The mocked emitter, typed so assertions read without casts. */
const emitToUser = vi.mocked(socketConfig.emitToUser);

function lobbyRoom(overrides: Partial<Omit<RuntimeRoom, 'players'>> = {}): RuntimeRoom {
  return makeRoom({
    roomId: ROOM_ID,
    code: 'A7K9P',
    hostId: HOST_ID,
    players: [makePlayer({ userId: HOST_ID, username: 'Ana' })],
    ...overrides,
  });
}

function userRow(id: string, username: string) {
  return {
    _id: id,
    username,
    avatarId: 0,
    avatarColorIndex: 0,
    totalScore: 0,
    gamesPlayed: 0,
    gamesWon: 0,
    bestRoundScore: 0,
    lastSeenAt: new Date(),
  };
}

function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: INVITATION_ID,
    roomId: ROOM_ID,
    inviterId: HOST_ID,
    inviteeId: FRIEND_ID,
    roomCode: 'A7K9P',
    status: INVITATION_STATUS.pending,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
}

/** Every event sent to one user, as `[event, payload]` pairs. */
function eventsTo(userId: string): Array<[string, Record<string, unknown>]> {
  return emitToUser.mock.calls
    .filter((call) => call[0] === userId)
    .map((call) => [call[1], call[2] as Record<string, unknown>]);
}

/**
 * The payload of the first event sent to one user, failing the test if there
 * was none. A plain index would type as possibly-undefined and, worse, turn
 * "nothing was delivered" into a confusing destructuring error rather than the
 * assertion that actually describes the bug.
 */
function firstPayloadTo(userId: string): Record<string, unknown> {
  const delivered = eventsTo(userId);
  expect(delivered.length).toBeGreaterThan(0);
  return delivered[0]![1];
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.spyOn(friendRepository, 'areFriends').mockResolvedValue(true);
  vi.spyOn(friendRepository, 'friendIdsOf').mockResolvedValue([FRIEND_ID]);
  vi.spyOn(blockRepository, 'existsBetween').mockResolvedValue(false);
  vi.spyOn(invitationRepository, 'findPending').mockResolvedValue(null);
  vi.spyOn(invitationRepository, 'countSentByInviter').mockResolvedValue(0);
  vi.spyOn(invitationRepository, 'resolve').mockResolvedValue(true);
  vi.spyOn(invitationRepository, 'create').mockResolvedValue({ _id: INVITATION_ID } as never);
  vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);
  vi.spyOn(userRepository, 'findById').mockResolvedValue(userRow(FRIEND_ID, 'Bo') as never);
  vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([
    userRow(HOST_ID, 'Ana'),
    userRow(FRIEND_ID, 'Bo'),
  ] as never);
  vi.spyOn(userRepository, 'touch').mockResolvedValue(undefined);
  vi.spyOn(roomRepository, 'persistRuntime').mockResolvedValue(undefined);
  vi.spyOn(roomService, 'liveRoomOf').mockReturnValue(null);

  // The durable notification an invitation also writes is a separate concern
  // with its own tests. Left real it would reach for Mongo, which nothing here
  // has, and stall each test on the driver's buffering timeout.
  vi.spyOn(notificationService, 'notify').mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Case 2: the invitation arrives without a refresh
// ---------------------------------------------------------------------------

describe('delivering an invitation in real time', () => {
  it('pushes the new invitation to the invitee as it is written', async () => {
    const room = lobbyRoom();

    const invitation = await invitationService.invite({
      room,
      inviter: HOST,
      inviteeId: FRIEND_ID,
    });

    // The payload is the same card the inbox would have been read for, which
    // is what lets the client show it without a follow-up fetch.
    const payload = firstPayloadTo(FRIEND_ID);
    expect(payload.invitation).toMatchObject({
      id: invitation.id,
      roomCode: 'A7K9P',
      maxPlayers: room.settings.maxPlayers,
    });
  });

  it('sends it under both the canonical name and the brief’s alias', async () => {
    await invitationService.invite({ room: lobbyRoom(), inviter: HOST, inviteeId: FRIEND_ID });

    // Two vocabularies, one payload: a client written against either spelling
    // hears it, and none is expected to listen for both.
    const names = eventsTo(FRIEND_ID).map(([name]) => name);
    expect(names).toContain(ROOM_EVENTS.invitationReceived.canonical);
    expect(names).toContain(ROOM_EVENTS.invitationReceived.alias);
  });

  it('addresses the invitee rather than the room', async () => {
    await invitationService.invite({ room: lobbyRoom(), inviter: HOST, inviteeId: FRIEND_ID });

    // The whole point of the feature: the invitee is by definition not in the
    // room yet, so a room broadcast would reach everybody except them.
    expect(emitToUser).toHaveBeenCalled();
    expect(vi.mocked(socketConfig.emitToRoom)).not.toHaveBeenCalled();
    expect(eventsTo(HOST_ID)).toHaveLength(0);
  });

  it('carries nothing beyond the card the invitee is allowed to see', async () => {
    await invitationService.invite({ room: lobbyRoom(), inviter: HOST, inviteeId: FRIEND_ID });

    const invitation = firstPayloadTo(FRIEND_ID).invitation as Record<string, unknown>;

    // A private room is invitable, so this payload reaches somebody with no
    // read access to the room itself. It must stay a display card.
    for (const forbidden of ['word', 'token', 'email', 'passwordHash', 'bannedIds', 'players']) {
      expect(invitation).not.toHaveProperty(forbidden);
    }
  });

  it('tells the inviter when their invitation is declined', async () => {
    // Rejecting closes a loop the inviter is waiting on, so it travels back to
    // them rather than only the acceptance doing so.
    await invitationService.reject(FRIEND, INVITATION_ID);

    const names = eventsTo(HOST_ID).map(([name]) => name);
    expect(names).toContain(ROOM_EVENTS.invitationRejected.canonical);
    expect(names).toContain(ROOM_EVENTS.invitationRejected.alias);
  });

  it('does not fail the invitation when the push cannot be delivered', async () => {
    // A player with no socket open is the normal case, not an error: the row
    // is written, and their inbox will show it when they next look.
    emitToUser.mockImplementation(() => {
      throw new Error('no socket server');
    });

    const invitation = await invitationService.invite({
      room: lobbyRoom(),
      inviter: HOST,
      inviteeId: FRIEND_ID,
    });

    expect(invitation.id).toBe(INVITATION_ID);
    expect(invitationRepository.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case 15: a disconnect is not a departure
// ---------------------------------------------------------------------------

describe('surviving a disconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(chatService, 'presence').mockResolvedValue(undefined);
    vi.spyOn(gameService, 'onPlayerLeft').mockResolvedValue(undefined);
    vi.spyOn(gameService, 'broadcastState').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A room with the host and one other player, both connected. */
  function seatedRoom(): RuntimeRoom {
    return makeRoom({
      roomId: ROOM_ID,
      hostId: HOST_ID,
      players: [
        makePlayer({ userId: HOST_ID, username: 'Ana', socketIds: new Set(['sock-a']) }),
        makePlayer({
          userId: FRIEND_ID,
          username: 'Bo',
          score: 120,
          hasGuessed: true,
          socketIds: new Set(['sock-b']),
        }),
      ],
    });
  }

  it('keeps the seat, the score and the guess when the socket drops', () => {
    const room = seatedRoom();

    const { wentOffline } = presenceService.detach(room, FRIEND_ID, 'sock-b');

    expect(wentOffline).toBe(true);

    // Still seated. This is the difference between a blip and a departure,
    // and what the reconnect path depends on finding.
    const player = room.players.get(FRIEND_ID);
    expect(player).toBeDefined();
    expect(player?.score).toBe(120);
    expect(player?.hasGuessed).toBe(true);
    expect(player?.connection).toBe(CONNECTION.reconnecting);
    expect(player?.disconnectDeadline).toBeGreaterThan(Date.now());
  });

  it('stays online while another device is still connected', () => {
    const room = seatedRoom();
    room.players.get(FRIEND_ID)?.socketIds.add('sock-b2');

    const { wentOffline } = presenceService.detach(room, FRIEND_ID, 'sock-b');

    // A phone locking while the tablet is open is not going offline.
    expect(wentOffline).toBe(false);
    expect(room.players.get(FRIEND_ID)?.connection).toBe(CONNECTION.connected);
    expect(room.players.get(FRIEND_ID)?.disconnectDeadline).toBeNull();
  });

  it('restores the player, and cancels the removal, when they come back in time', async () => {
    const room = seatedRoom();
    const removePlayer = vi.spyOn(roomService, 'removePlayer');

    presenceService.detach(room, FRIEND_ID, 'sock-b');

    // Back with a new socket id, which is what a reconnect actually looks
    // like — the old one is gone for good.
    vi.advanceTimersByTime(TIMING.reconnectGraceMs / 2);
    const { reconnected } = presenceService.attach(room, FRIEND_ID, 'sock-b-new');

    expect(reconnected).toBe(true);

    const player = room.players.get(FRIEND_ID);
    expect(player?.connection).toBe(CONNECTION.connected);
    expect(player?.disconnectDeadline).toBeNull();
    expect(player?.score).toBe(120);

    // The grace timer must be dead, not merely ignored: letting it fire would
    // evict a player who is sitting there connected.
    await vi.advanceTimersByTimeAsync(TIMING.reconnectGraceMs * 2);
    expect(removePlayer).not.toHaveBeenCalled();
  });

  it('removes the player once the grace period runs out', async () => {
    const room = seatedRoom();
    const removePlayer = vi
      .spyOn(roomService, 'removePlayer')
      .mockResolvedValue({ roomEmpty: false });

    presenceService.detach(room, FRIEND_ID, 'sock-b');
    expect(removePlayer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TIMING.reconnectGraceMs + 1_000);

    expect(removePlayer).toHaveBeenCalledWith(room, FRIEND_ID);
  });

  it('marks the room empty only when the last player has gone dark', () => {
    const room = seatedRoom();

    presenceService.detach(room, FRIEND_ID, 'sock-b');
    expect(room.emptySince).toBeNull();

    presenceService.detach(room, HOST_ID, 'sock-a');
    expect(room.emptySince).not.toBeNull();
  });

  it('clears the empty mark as soon as somebody reconnects', () => {
    const room = seatedRoom();

    presenceService.detach(room, FRIEND_ID, 'sock-b');
    presenceService.detach(room, HOST_ID, 'sock-a');
    expect(room.emptySince).not.toBeNull();

    // The sweeper closes rooms by this mark, so a room somebody came back to
    // must stop looking abandoned immediately.
    presenceService.attach(room, HOST_ID, 'sock-a-new');
    expect(room.emptySince).toBeNull();
  });
});
