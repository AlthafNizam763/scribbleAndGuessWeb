import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GAME_PHASE, INVITATION_STATUS } from '@/constants/room.constants';
import { blockRepository } from '@/repositories/block.repository';
import { friendRepository } from '@/repositories/friend.repository';
import { invitationRepository } from '@/repositories/invitation.repository';
import { roomRepository } from '@/repositories/room.repository';
import { userRepository } from '@/repositories/user.repository';
import { invitationService } from '@/services/invitation.service';
import { matchmakingService } from '@/services/matchmaking.service';
import { roomService } from '@/services/room.service';
import type { AuthenticatedUser } from '@/types/auth.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { AppError, ErrorCode } from '@/utils/errors';
import { roomDisplayName, sanitizeName } from '@/utils/sanitize';
import {
  inviteToRoomSchema,
  invitationTargetSchema,
  publicRoomsQuerySchema,
} from '@/validators/room.validator';
import { makePlayer, makeRoom } from './helpers';

/**
 * Invitations, the public room list and the membership rules (brief section 11
 * of the invite feature).
 *
 * ## Why the repositories are spied rather than the modules mocked
 *
 * Every rule under test is a decision made in `invitation.service.ts` about
 * state it read from somewhere. What matters is the decision, not the read, so
 * each repository method the path touches is replaced with a stub returning
 * the situation the test is about — room full, friend already invited, block
 * in place — and the assertion is on what the service did with it.
 *
 * Spying on the object literals rather than mocking the modules keeps the
 * *real* modules loaded, which matters more than it looks: `isObjectId` is
 * imported across repository files, and a module mock that forgot to re-export
 * it would fail somewhere unrelated to the test that caused it. Nothing here
 * opens a database connection, because every method that would is stubbed.
 */

const OBJECT_ID_A = '507f1f77bcf86cd799439011';
const OBJECT_ID_B = '507f1f77bcf86cd799439012';
const OBJECT_ID_C = '507f1f77bcf86cd799439013';
const INVITATION_ID = '507f1f77bcf86cd7994390ff';

/** The host, as an authenticated caller. */
const HOST: AuthenticatedUser = {
  id: OBJECT_ID_A,
  username: 'Ana',
  avatarId: 1,
  avatarColorIndex: 2,
} as AuthenticatedUser;

/** The friend being invited. */
const FRIEND: AuthenticatedUser = {
  id: OBJECT_ID_B,
  username: 'Bo',
  avatarId: 3,
  avatarColorIndex: 4,
} as AuthenticatedUser;

/** A lobby with just the host in it, ready to invite into. */
function lobbyRoom(overrides: Partial<Omit<RuntimeRoom, 'players'>> = {}): RuntimeRoom {
  return makeRoom({
    roomId: OBJECT_ID_C,
    code: 'A7K9P',
    hostId: HOST.id,
    players: [makePlayer({ userId: HOST.id, username: 'Ana' })],
    ...overrides,
  });
}

/** A user row, in the shape the repositories hand back. */
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

/** A stored invitation row, pending and well within its deadline. */
function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: INVITATION_ID,
    roomId: OBJECT_ID_C,
    inviterId: HOST.id,
    inviteeId: FRIEND.id,
    roomCode: 'A7K9P',
    status: INVITATION_STATUS.pending,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
}

/** The `ErrorCode` a thrown `AppError` carries, for a readable assertion. */
async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return AppError.isAppError(error) ? error.code : 'NOT_AN_APP_ERROR';
  }
  return 'NO_ERROR';
}

/** The message a thrown `AppError` carries. */
async function messageOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'NO_ERROR';
}

beforeEach(() => {
  vi.restoreAllMocks();

  // The permissive defaults: they are friends, nobody is blocked, nothing is
  // outstanding, and every write succeeds. Each test overrides only the one
  // fact it is about, so a failure names the rule that broke.
  vi.spyOn(friendRepository, 'areFriends').mockResolvedValue(true);
  vi.spyOn(friendRepository, 'friendIdsOf').mockResolvedValue([FRIEND.id]);
  vi.spyOn(blockRepository, 'existsBetween').mockResolvedValue(false);
  vi.spyOn(blockRepository, 'relatedIds').mockResolvedValue([]);
  vi.spyOn(invitationRepository, 'findPending').mockResolvedValue(null);
  vi.spyOn(invitationRepository, 'listPendingForRoom').mockResolvedValue([]);
  vi.spyOn(invitationRepository, 'countSentByInviter').mockResolvedValue(0);
  vi.spyOn(invitationRepository, 'resolve').mockResolvedValue(true);
  vi.spyOn(invitationRepository, 'create').mockResolvedValue({
    _id: INVITATION_ID,
  } as never);
  vi.spyOn(userRepository, 'findById').mockResolvedValue(
    userRow(FRIEND.id, 'Bo') as never,
  );
  vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([
    userRow(FRIEND.id, 'Bo'),
  ] as never);
  vi.spyOn(userRepository, 'touch').mockResolvedValue(undefined);
  vi.spyOn(roomRepository, 'persistRuntime').mockResolvedValue(undefined);
  vi.spyOn(roomRepository, 'findManyByIds').mockResolvedValue([] as never);
  vi.spyOn(roomService, 'liveRoomOf').mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// 1, 2, 13, 14: sending an invitation
// ---------------------------------------------------------------------------

describe('inviting a friend', () => {
  it('invites a friend into a lobby and describes the room on the invitation', async () => {
    const room = lobbyRoom();

    const invitation = await invitationService.invite({
      room,
      inviter: HOST,
      inviteeId: FRIEND.id,
    });

    expect(invitation.id).toBe(INVITATION_ID);
    expect(invitation.roomCode).toBe('A7K9P');
    expect(invitation.status).toBe(INVITATION_STATUS.pending);
    expect(invitation.inviter?.username).toBe('Ana');
    expect(invitation.invitee?.username).toBe('Bo');

    // Everything the brief says the invitee must be shown, stamped on the row
    // rather than left to a read of a room they are not in.
    expect(invitation.playerCount).toBe(1);
    expect(invitation.maxPlayers).toBe(room.settings.maxPlayers);
    expect(invitation.isPublic).toBe(true);
    expect(invitation.roomStatus).toBe('waiting');
    expect(invitation.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('refuses a second invitation to the same friend', async () => {
    vi.spyOn(invitationRepository, 'findPending').mockResolvedValue(
      invitationRow() as never,
    );

    expect(
      await messageOf(() =>
        invitationService.invite({ room: lobbyRoom(), inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe('Already invited.');
  });

  it('re-invites once the previous invitation has lapsed', async () => {
    // A lapsed row still occupies the unique slot, so it has to be retired
    // before the new insert rather than colliding with it.
    vi.spyOn(invitationRepository, 'findPending').mockResolvedValue(
      invitationRow({ expiresAt: new Date(Date.now() - 1000) }) as never,
    );

    await invitationService.invite({
      room: lobbyRoom(),
      inviter: HOST,
      inviteeId: FRIEND.id,
    });

    expect(invitationRepository.resolve).toHaveBeenCalledWith(
      INVITATION_ID,
      INVITATION_STATUS.expired,
    );
    expect(invitationRepository.create).toHaveBeenCalled();
  });

  it('turns a duplicate-key race into the same refusal as the pre-check', async () => {
    // The read saw nothing, the index disagreed: a second device got there
    // first. The player must not see a database error for that.
    vi.spyOn(invitationRepository, 'create').mockRejectedValue(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
    );

    expect(
      await messageOf(() =>
        invitationService.invite({ room: lobbyRoom(), inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe('Already invited.');
  });

  it('refuses when a block stands between the two, in either direction', async () => {
    vi.spyOn(blockRepository, 'existsBetween').mockResolvedValue(true);

    // Deliberately says nothing about who blocked whom.
    expect(
      await messageOf(() =>
        invitationService.invite({ room: lobbyRoom(), inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe('You cannot invite that player.');
  });

  it('refuses somebody who is not a friend', async () => {
    vi.spyOn(friendRepository, 'areFriends').mockResolvedValue(false);

    expect(
      await messageOf(() =>
        invitationService.invite({ room: lobbyRoom(), inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe('You can only invite friends.');
  });

  it('refuses inviting the owner, or anybody already seated', async () => {
    const room = lobbyRoom({});
    room.players.set(FRIEND.id, makePlayer({ userId: FRIEND.id, username: 'Bo' }));

    expect(
      await messageOf(() =>
        invitationService.invite({ room, inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe('Already in this room.');

    // And the host, who is a member by definition.
    expect(
      await messageOf(() =>
        invitationService.invite({ room, inviter: HOST, inviteeId: HOST.id }),
      ),
    ).toBe('That is you.');
  });

  it('refuses inviting somebody banned from the room', async () => {
    const room = lobbyRoom();
    room.bannedIds.add(FRIEND.id);

    expect(
      await codeOf(() =>
        invitationService.invite({ room, inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe(ErrorCode.PLAYER_BANNED);
  });

  it('refuses when the room is full', async () => {
    const room = lobbyRoom();
    room.settings = { ...room.settings, maxPlayers: 1 };

    expect(
      await messageOf(() =>
        invitationService.invite({ room, inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe('Room is full.');
  });

  it('refuses once the game has started', async () => {
    const room = lobbyRoom({ phase: GAME_PHASE.drawing });

    expect(
      await messageOf(() =>
        invitationService.invite({ room, inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe('Game already started.');
  });

  it('refuses once the room is closed', async () => {
    const room = lobbyRoom({ closed: true });

    expect(
      await messageOf(() =>
        invitationService.invite({ room, inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe('Room is closed.');
  });

  it('refuses an inviter who is not seated in the room', async () => {
    const stranger = { ...HOST, id: OBJECT_ID_B } as AuthenticatedUser;

    expect(
      await codeOf(() =>
        invitationService.invite({
          room: lobbyRoom(),
          inviter: stranger,
          inviteeId: OBJECT_ID_A,
        }),
      ),
    ).toBe(ErrorCode.NOT_ROOM_MEMBER);
  });

  it('caps how many invitations one player may have outstanding to one room', async () => {
    vi.spyOn(invitationRepository, 'countSentByInviter').mockResolvedValue(16);

    expect(
      await codeOf(() =>
        invitationService.invite({ room: lobbyRoom(), inviter: HOST, inviteeId: FRIEND.id }),
      ),
    ).toBe(ErrorCode.RATE_LIMITED);
  });

  // 7: a private room is invitable. It is only un-*browsable*.
  it('allows inviting into a private room, and says so on the invitation', async () => {
    const room = lobbyRoom();
    room.settings = { ...room.settings, isPrivate: true };

    const invitation = await invitationService.invite({
      room,
      inviter: HOST,
      inviteeId: FRIEND.id,
    });

    expect(invitation.isPublic).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3, 4, 5, 6: answering an invitation
// ---------------------------------------------------------------------------

describe('accepting an invitation', () => {
  it('seats the invitee and hands back the room', async () => {
    const room = lobbyRoom();
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);
    vi.spyOn(roomService, 'hydrate').mockResolvedValue(room);

    const outcome = await invitationService.accept(FRIEND, INVITATION_ID);

    expect(outcome.room.roomId).toBe(room.roomId);
    expect(outcome.rejoined).toBe(false);
    expect(room.players.has(FRIEND.id)).toBe(true);
    expect(invitationRepository.resolve).toHaveBeenCalledWith(
      INVITATION_ID,
      INVITATION_STATUS.accepted,
    );
  });

  it('refuses an invitation addressed to somebody else', async () => {
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);
    vi.spyOn(roomService, 'hydrate').mockResolvedValue(lobbyRoom());

    const stranger = { ...FRIEND, id: OBJECT_ID_C } as AuthenticatedUser;

    // An invitation id is not a capability: guessing one gets a refusal.
    expect(await codeOf(() => invitationService.accept(stranger, INVITATION_ID))).toBe(
      ErrorCode.NOT_ROOM_MEMBER,
    );
  });

  it('refuses when the room filled up while the invitation was out', async () => {
    const room = lobbyRoom();
    room.settings = { ...room.settings, maxPlayers: 1 };

    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);
    vi.spyOn(roomService, 'hydrate').mockResolvedValue(room);

    expect(await messageOf(() => invitationService.accept(FRIEND, INVITATION_ID))).toBe(
      'Room is full.',
    );
    expect(room.players.has(FRIEND.id)).toBe(false);
  });

  it('refuses when the game started while the invitation was out', async () => {
    const room = lobbyRoom({ phase: GAME_PHASE.drawing });

    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);
    vi.spyOn(roomService, 'hydrate').mockResolvedValue(room);

    expect(await messageOf(() => invitationService.accept(FRIEND, INVITATION_ID))).toBe(
      'Game already started.',
    );
  });

  it('refuses, and retires the row, when the room is gone', async () => {
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);
    vi.spyOn(roomService, 'hydrate').mockResolvedValue(null);

    expect(await messageOf(() => invitationService.accept(FRIEND, INVITATION_ID))).toBe(
      'Room is closed.',
    );
    expect(invitationRepository.resolve).toHaveBeenCalledWith(
      INVITATION_ID,
      INVITATION_STATUS.expired,
    );
  });

  it('refuses an invitation whose deadline has passed, whatever its status says', async () => {
    // Still `pending` in the row: the sweeper has not reached it. The date is
    // what decides, so this must be refused anyway.
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(
      invitationRow({ expiresAt: new Date(Date.now() - 1) }) as never,
    );

    expect(await messageOf(() => invitationService.accept(FRIEND, INVITATION_ID))).toBe(
      'Invitation expired.',
    );
  });

  it('refuses an invitation that was already answered', async () => {
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(
      invitationRow({ status: INVITATION_STATUS.rejected }) as never,
    );

    expect(await messageOf(() => invitationService.accept(FRIEND, INVITATION_ID))).toBe(
      'That invitation has already been handled.',
    );
  });

  it('refuses when a block was placed after the invitation was sent', async () => {
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);
    vi.spyOn(roomService, 'hydrate').mockResolvedValue(lobbyRoom());
    vi.spyOn(blockRepository, 'existsBetween').mockResolvedValue(true);

    expect(await messageOf(() => invitationService.accept(FRIEND, INVITATION_ID))).toBe(
      'That invitation is no longer available.',
    );
  });

  it('does not seat anybody when another tap already answered the invitation', async () => {
    const room = lobbyRoom();
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);
    vi.spyOn(roomService, 'hydrate').mockResolvedValue(room);
    // The guarded update matched nothing: somebody else resolved it first.
    vi.spyOn(invitationRepository, 'resolve').mockResolvedValue(false);

    expect(await messageOf(() => invitationService.accept(FRIEND, INVITATION_ID))).toBe(
      'That invitation has already been handled.',
    );
    expect(room.players.has(FRIEND.id)).toBe(false);
  });
});

describe('rejecting an invitation', () => {
  it('marks the invitation rejected and keeps the player out of the room', async () => {
    const room = lobbyRoom();
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);

    await invitationService.reject(FRIEND, INVITATION_ID);

    expect(invitationRepository.resolve).toHaveBeenCalledWith(
      INVITATION_ID,
      INVITATION_STATUS.rejected,
    );
    expect(room.players.has(FRIEND.id)).toBe(false);
  });

  it('refuses to reject an invitation addressed to somebody else', async () => {
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);

    const stranger = { ...FRIEND, id: OBJECT_ID_C } as AuthenticatedUser;

    expect(await codeOf(() => invitationService.reject(stranger, INVITATION_ID))).toBe(
      ErrorCode.NOT_ROOM_MEMBER,
    );
  });
});

// ---------------------------------------------------------------------------
// The invite sheet
// ---------------------------------------------------------------------------

describe('the invite candidate list', () => {
  it('marks a friend who is already seated as un-invitable', async () => {
    const room = lobbyRoom();
    room.players.set(FRIEND.id, makePlayer({ userId: FRIEND.id, username: 'Bo' }));

    const candidate = (await invitationService.listCandidates(room, HOST.id, 25))[0]!;

    expect(candidate.isMember).toBe(true);
    expect(candidate.canInvite).toBe(false);
    expect(candidate.blockedReason).toBe('Already in this room.');
  });

  it('marks a friend with an invitation outstanding as already invited', async () => {
    vi.spyOn(invitationRepository, 'listPendingForRoom').mockResolvedValue([
      invitationRow(),
    ] as never);

    const candidate = (await invitationService.listCandidates(lobbyRoom(), HOST.id, 25))[0]!;

    expect(candidate.isInvited).toBe(true);
    expect(candidate.canInvite).toBe(false);
  });

  it('gives the same reason the invite itself would refuse with', async () => {
    // The whole point of the flags: a greyed-out button and a refused request
    // must never disagree, because they are the same predicate.
    const room = lobbyRoom({ phase: GAME_PHASE.drawing });

    const candidate = (await invitationService.listCandidates(room, HOST.id, 25))[0]!;
    const refusal = await messageOf(() =>
      invitationService.invite({ room, inviter: HOST, inviteeId: FRIEND.id }),
    );

    expect(candidate.canInvite).toBe(false);
    expect(candidate.blockedReason).toBe(refusal);
  });

  it('drops blocked friends from the list entirely', async () => {
    // Not shown as un-invitable: a row saying "you cannot invite this person"
    // is the disclosure a block exists to prevent.
    vi.spyOn(blockRepository, 'relatedIds').mockResolvedValue([FRIEND.id]);

    expect(await invitationService.listCandidates(lobbyRoom(), HOST.id, 25)).toEqual([]);
  });

  it('returns nothing when the player has no friends yet', async () => {
    vi.spyOn(friendRepository, 'friendIdsOf').mockResolvedValue([]);

    expect(await invitationService.listCandidates(lobbyRoom(), HOST.id, 25)).toEqual([]);
  });

  it('reports a friend seen moments ago as online when no socket server is attached', async () => {
    // The REST-only process cannot see sockets; `lastSeenAt` inside the
    // reconnect grace window is the honest approximation there.
    const candidate = (await invitationService.listCandidates(lobbyRoom(), HOST.id, 25))[0]!;

    expect(candidate.isOnline).toBe(true);
  });

  it('reports a friend last seen long ago as offline', async () => {
    vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([
      { ...userRow(FRIEND.id, 'Bo'), lastSeenAt: new Date(Date.now() - 3_600_000) },
    ] as never);

    const candidate = (await invitationService.listCandidates(lobbyRoom(), HOST.id, 25))[0]!;

    expect(candidate.isOnline).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The invitations inbox
// ---------------------------------------------------------------------------

describe('the invitations inbox', () => {
  beforeEach(() => {
    vi.spyOn(invitationRepository, 'countForInvitee').mockResolvedValue(1);
  });

  it('hides a lapsed invitation and retires it rather than drawing a dead button', async () => {
    vi.spyOn(invitationRepository, 'listForInvitee').mockResolvedValue([
      invitationRow({ expiresAt: new Date(Date.now() - 1) }),
    ] as never);

    const page = await invitationService.listInvitations(FRIEND.id, 1, 25);

    expect(page.items).toEqual([]);
    expect(invitationRepository.resolve).toHaveBeenCalledWith(
      INVITATION_ID,
      INVITATION_STATUS.expired,
    );
  });

  it('hides an invitation whose room has gone', async () => {
    vi.spyOn(invitationRepository, 'listForInvitee').mockResolvedValue([
      invitationRow(),
    ] as never);
    // Not in the registry, and not in storage either.
    vi.spyOn(roomRepository, 'findManyByIds').mockResolvedValue([] as never);

    const page = await invitationService.listInvitations(FRIEND.id, 1, 25);

    expect(page.items).toEqual([]);
  });

  it('describes a live room from the registry rather than from the last write', async () => {
    const room = lobbyRoom();
    room.players.set(OBJECT_ID_A + '1', makePlayer({ userId: OBJECT_ID_A + '1' }));

    vi.spyOn(invitationRepository, 'listForInvitee').mockResolvedValue([
      invitationRow(),
    ] as never);
    vi.spyOn(roomService, 'get').mockReturnValue(room);
    vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([
      userRow(HOST.id, 'Ana'),
    ] as never);

    const page = await invitationService.listInvitations(FRIEND.id, 1, 25);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.playerCount).toBe(2);
    expect(page.items[0]!.inviter?.username).toBe('Ana');
    expect(page.items[0]!.roomCode).toBe('A7K9P');
  });
});

// ---------------------------------------------------------------------------
// 9, 10, 11, 12, 15: the membership rules
// ---------------------------------------------------------------------------

describe('room membership rules', () => {
  it('admits a new player to a waiting room with space', () => {
    expect(() =>
      invitationService.assertRoomAcceptsJoins(lobbyRoom(), FRIEND.id),
    ).not.toThrow();
  });

  it('refuses a full room', async () => {
    const room = lobbyRoom();
    room.settings = { ...room.settings, maxPlayers: 1 };

    expect(await messageOf(async () =>
      invitationService.assertRoomAcceptsJoins(room, FRIEND.id),
    )).toBe('Room is full.');
  });

  it('refuses a started room', async () => {
    expect(await messageOf(async () =>
      invitationService.assertRoomAcceptsJoins(lobbyRoom({ phase: GAME_PHASE.drawing }), FRIEND.id),
    )).toBe('Game already started.');
  });

  it('refuses a closed room', async () => {
    expect(await messageOf(async () =>
      invitationService.assertRoomAcceptsJoins(lobbyRoom({ closed: true }), FRIEND.id),
    )).toBe('Room is closed.');
  });

  it('refuses somebody banned from the room', async () => {
    const room = lobbyRoom();
    room.bannedIds.add(FRIEND.id);

    expect(await codeOf(async () =>
      invitationService.assertRoomAcceptsJoins(room, FRIEND.id),
    )).toBe(ErrorCode.PLAYER_BANNED);
  });

  it('always lets an existing member back in, full or mid-game', () => {
    // A reconnect must never be punished with the loss of a match: the player
    // already holds the seat, so neither the cap nor the phase applies.
    const room = lobbyRoom({ phase: GAME_PHASE.drawing });
    room.settings = { ...room.settings, maxPlayers: 1 };

    expect(() => invitationService.assertRoomAcceptsJoins(room, HOST.id)).not.toThrow();
  });

  it('refuses a player who is connected in another room right now', async () => {
    // A live socket in the other room is somebody actually playing there, and
    // the refusal is something they can act on: leave, then come back.
    const elsewhere = makeRoom({
      roomId: 'another-room',
      players: [makePlayer({ userId: FRIEND.id, socketIds: new Set(['socket-1']) })],
    });
    vi.spyOn(roomService, 'liveRoomOf').mockReturnValue(elsewhere);

    expect(
      await messageOf(async () =>
        invitationService.assertNotSeatedElsewhere(FRIEND.id, OBJECT_ID_C),
      ),
    ).toBe('You are already in another room. Leave that room first.');
  });

  it('vacates an abandoned seat instead of refusing the join', async () => {
    // The reported bug: the app was backgrounded or killed rather than left
    // through the Leave button, so the seat stands for the length of the
    // reconnect grace. Nobody is connected to it, so it is given up rather
    // than used to refuse an invitation the player just accepted.
    const elsewhere = makeRoom({
      roomId: 'another-room',
      players: [makePlayer({ userId: FRIEND.id, socketIds: new Set<string>() })],
    });
    vi.spyOn(roomService, 'liveRoomOf').mockReturnValue(elsewhere);

    const remove = vi
      .spyOn(roomService, 'removePlayer')
      .mockResolvedValue({ roomEmpty: false });

    await expect(
      invitationService.assertNotSeatedElsewhere(FRIEND.id, OBJECT_ID_C),
    ).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledWith(elsewhere, FRIEND.id);
  });

  it('closes the room it vacated when that seat was the last one', async () => {
    const elsewhere = makeRoom({
      roomId: 'another-room',
      players: [makePlayer({ userId: FRIEND.id, socketIds: new Set<string>() })],
    });
    vi.spyOn(roomService, 'liveRoomOf').mockReturnValue(elsewhere);
    vi.spyOn(roomService, 'removePlayer').mockResolvedValue({ roomEmpty: true });
    const close = vi.spyOn(roomService, 'close').mockResolvedValue();

    await invitationService.assertNotSeatedElsewhere(FRIEND.id, OBJECT_ID_C);

    expect(close).toHaveBeenCalledWith(elsewhere, 'last player left');
  });

  it('allows re-entering the room the player is already in', async () => {
    const room = lobbyRoom();
    vi.spyOn(roomService, 'liveRoomOf').mockReturnValue(room);
    const remove = vi.spyOn(roomService, 'removePlayer');

    await expect(
      invitationService.assertNotSeatedElsewhere(HOST.id, room.roomId),
    ).resolves.toBeUndefined();

    // And emphatically does not vacate the seat it is about to re-enter.
    expect(remove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8: the public room list
// ---------------------------------------------------------------------------

describe('the public room list', () => {
  /** Puts a set of rooms behind `roomService.all()` for the filter to scan. */
  function registry(rooms: RuntimeRoom[]): void {
    vi.spyOn(roomService, 'all').mockReturnValue(rooms);
  }

  it('describes a room with everything a stranger needs and nothing else', () => {
    const room = lobbyRoom();
    registry([room]);

    const listed = matchmakingService.listPublic(FRIEND.id, new Set(), 25)[0]!;

    expect(listed.code).toBe('A7K9P');
    expect(listed.name).toBe("Ana's room");
    expect(listed.hostName).toBe('Ana');
    expect(listed.playerCount).toBe(1);
    expect(listed.maxPlayers).toBe(room.settings.maxPlayers);
    expect(listed.status).toBe('waiting');

    // No player list, no ban list, no custom words: a browser row is not a
    // window into a room you have not joined.
    expect(Object.keys(listed)).not.toContain('players');
    expect(Object.keys(listed)).not.toContain('bannedIds');
    expect(Object.keys(listed)).not.toContain('customWords');
  });

  it('never lists a private room', () => {
    const room = lobbyRoom();
    room.settings = { ...room.settings, isPrivate: true };
    registry([room]);

    expect(matchmakingService.listPublic(FRIEND.id, new Set(), 25)).toEqual([]);
  });

  it('never lists a full, started or closed room', () => {
    const full = lobbyRoom({ roomId: 'full' });
    full.settings = { ...full.settings, maxPlayers: 1 };

    registry([
      full,
      lobbyRoom({ roomId: 'started', phase: GAME_PHASE.drawing }),
      lobbyRoom({ roomId: 'closed', closed: true }),
    ]);

    expect(matchmakingService.listPublic(FRIEND.id, new Set(), 25)).toEqual([]);
  });

  it('never lists a room the caller is banned from', () => {
    const room = lobbyRoom();
    room.bannedIds.add(FRIEND.id);
    registry([room]);

    expect(matchmakingService.listPublic(FRIEND.id, new Set(), 25)).toEqual([]);
  });

  it('never lists a room shared with somebody the caller has blocked', () => {
    registry([lobbyRoom()]);

    expect(matchmakingService.listPublic(FRIEND.id, new Set([HOST.id]), 25)).toEqual([]);
  });

  it('never lists the room the caller is already sitting in', () => {
    registry([lobbyRoom()]);

    expect(matchmakingService.listPublic(HOST.id, new Set(), 25)).toEqual([]);
  });

  it('lists a paused room, which is waiting for exactly this player', () => {
    registry([lobbyRoom({ phase: GAME_PHASE.paused })]);

    expect(matchmakingService.listPublic(FRIEND.id, new Set(), 25)).toHaveLength(1);
  });

  it('puts the fullest room first, so players converge instead of scattering', () => {
    const quiet = lobbyRoom({ roomId: 'quiet', code: 'QUIET' });
    const busy = lobbyRoom({ roomId: 'busy', code: 'BUSYY' });
    busy.players.set('extra', makePlayer({ userId: 'extra' }));

    registry([quiet, busy]);

    expect(
      matchmakingService.listPublic(FRIEND.id, new Set(), 25).map((row) => row.code),
    ).toEqual(['BUSYY', 'QUIET']);
  });

  it('honours the limit', () => {
    registry([
      lobbyRoom({ roomId: 'a', code: 'AAAAA' }),
      lobbyRoom({ roomId: 'b', code: 'BBBBB' }),
      lobbyRoom({ roomId: 'c', code: 'CCCCC' }),
    ]);

    expect(matchmakingService.listPublic(FRIEND.id, new Set(), 2)).toHaveLength(2);
  });

  it('agrees with what the join path will allow', () => {
    // The listing filter and the join guard are different functions asking the
    // same question, and a row that is listed but not joinable is the bug this
    // pins down.
    const room = lobbyRoom();
    registry([room]);

    expect(matchmakingService.listPublic(FRIEND.id, new Set(), 25)).toHaveLength(1);
    expect(() =>
      invitationService.assertRoomAcceptsJoins(room, FRIEND.id),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 16: two clients, one room
// ---------------------------------------------------------------------------

describe('two clients in one room', () => {
  it('serialises both members from one room snapshot', async () => {
    // The Flutter app and the web app read the same `s:room:state` payload, so
    // "both clients see each other" is this snapshot carrying both seats with
    // one host between them.
    const room = lobbyRoom();
    vi.spyOn(invitationRepository, 'findById').mockResolvedValue(invitationRow() as never);
    vi.spyOn(roomService, 'hydrate').mockResolvedValue(room);

    await invitationService.accept(FRIEND, INVITATION_ID);

    const snapshot = roomService.serializeRoom(room);

    expect(snapshot.players.map((player) => player.name).sort()).toEqual(['Ana', 'Bo']);
    expect(snapshot.players.filter((player) => player.isHost)).toHaveLength(1);
    expect(snapshot.code).toBe('A7K9P');
  });
});

// ---------------------------------------------------------------------------
// Validation and display
// ---------------------------------------------------------------------------

describe('invitation validation', () => {
  it('accepts any of the three spellings for the invitee', () => {
    for (const body of [
      { inviteeId: OBJECT_ID_B },
      { friendId: OBJECT_ID_B },
      { userId: OBJECT_ID_B },
    ]) {
      expect(inviteToRoomSchema.parse(body)).toEqual({ inviteeId: OBJECT_ID_B });
    }
  });

  it('refuses a body with no player id, and one with a malformed id', () => {
    expect(() => inviteToRoomSchema.parse({})).toThrow();
    expect(() => inviteToRoomSchema.parse({ inviteeId: 'not-an-id' })).toThrow();
  });

  it('has no field for an inviter or a room', () => {
    // The structural refusal: a body that cannot express "invite as somebody
    // else" cannot be used to do it, whatever the caller sends.
    const parsed = inviteToRoomSchema.parse({
      inviteeId: OBJECT_ID_B,
      inviterId: OBJECT_ID_A,
      roomId: OBJECT_ID_C,
    } as never);

    expect(parsed).toEqual({ inviteeId: OBJECT_ID_B });
  });

  it('refuses a malformed invitation id on the socket path', () => {
    expect(() => invitationTargetSchema.parse({ invitationId: 'nope' })).toThrow();
    expect(invitationTargetSchema.parse({ invitationId: INVITATION_ID })).toEqual({
      invitationId: INVITATION_ID,
    });
  });

  it('clamps an optimistic public-room page size rather than refusing it', () => {
    expect(publicRoomsQuerySchema.parse({ limit: '5000' }).limit).toBe(50);
    expect(publicRoomsQuerySchema.parse({ limit: '0' }).limit).toBe(1);
    expect(publicRoomsQuerySchema.parse({}).limit).toBe(25);
  });
});

describe('name sanitising', () => {
  it('strips the characters that break a layout', () => {
    const bidi = String.fromCharCode(0x202e);
    const zeroWidth = String.fromCharCode(0x200b);

    expect(sanitizeName(`An${bidi}a${zeroWidth}`)).toBe('Ana');
  });

  it('collapses whitespace and clamps the length', () => {
    expect(sanitizeName('  Ana   Lee  ')).toBe('Ana Lee');
    expect(sanitizeName('x'.repeat(200))).toHaveLength(16);
  });

  it('falls back to a placeholder rather than an empty row', () => {
    expect(sanitizeName('')).toBe('Player');
    expect(sanitizeName(null)).toBe('Player');
  });

  it('builds a readable room name, including for a name ending in s', () => {
    expect(roomDisplayName('Ana')).toBe("Ana's room");
    expect(roomDisplayName('Chris')).toBe("Chris' room");
    expect(roomDisplayName('')).toBe("Player's room");
  });
});
