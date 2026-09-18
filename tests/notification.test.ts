import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOTIFICATION_LIMITS,
  NOTIFICATION_TYPE,
  PUSH_INVITE_ANDROID_CHANNEL,
  PUSH_NOTIFICATION_TYPE,
} from '@/constants/notification.constants';
import { notificationRepository } from '@/repositories/notification.repository';
import { userRepository } from '@/repositories/user.repository';
import { notificationPaging, notificationService } from '@/services/notification.service';
import { pushService } from '@/services/push.service';
import { AppError, ErrorCode } from '@/utils/errors';
import { notificationQuerySchema } from '@/validators/notification.validator';

/**
 * The notification centre.
 *
 * ## What is worth asserting here, and what is not
 *
 * The interesting behaviour is not "a row was written" — Mongoose does that —
 * it is the set of decisions the service makes around the write: that a failed
 * notification never propagates into the action that caused it, that an id
 * belonging to somebody else is indistinguishable from an id that never
 * existed, and that the badge count always comes from the server rather than
 * from arithmetic on the client's last value.
 *
 * As in `invitation.test.ts`, the repositories are spied rather than the
 * modules mocked, so nothing here opens a database connection and the real
 * modules stay loaded.
 */

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439012';
const NOTIFICATION_ID = '507f1f77bcf86cd7994390aa';

/** A stored row, as the repository hands one back. */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: NOTIFICATION_ID,
    userId: USER_A,
    type: NOTIFICATION_TYPE.friendRequest,
    title: 'New friend request',
    body: 'Bo wants to be your friend.',
    actorId: USER_B,
    data: { requestId: 'req-1' },
    readAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-31T00:00:00Z'),
    ...overrides,
  };
}

const ACTOR = {
  _id: USER_B,
  username: 'Bo',
  avatarId: 3,
  avatarColorIndex: 4,
  totalScore: 0,
  gamesPlayed: 0,
  gamesWon: 0,
  bestRoundScore: 0,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('writing a notification', () => {
  it('stores the row, resolves the actor and reports the server-side count', async () => {
    vi.spyOn(notificationRepository, 'create').mockResolvedValue(makeRow() as never);
    vi.spyOn(notificationRepository, 'unreadCount').mockResolvedValue(7);
    vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([ACTOR] as never);

    const dto = await notificationService.notify({
      userId: USER_A,
      type: NOTIFICATION_TYPE.friendRequest,
      title: 'New friend request',
      body: 'Bo wants to be your friend.',
      actorId: USER_B,
      data: { requestId: 'req-1' },
    });

    expect(dto).not.toBeNull();
    expect(dto?.actor).toEqual({
      id: USER_B,
      username: 'Bo',
      avatarId: 3,
      avatarColorIndex: 4,
    });
    expect(dto?.isRead).toBe(false);
    expect(dto?.data).toEqual({ requestId: 'req-1' });
  });

  it('sets an expiry inside the retention window rather than leaving the row forever', async () => {
    const create = vi
      .spyOn(notificationRepository, 'create')
      .mockResolvedValue(makeRow() as never);
    vi.spyOn(notificationRepository, 'unreadCount').mockResolvedValue(1);
    vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([] as never);

    const before = Date.now();
    await notificationService.notify({
      userId: USER_A,
      type: NOTIFICATION_TYPE.systemAnnouncement,
      title: 'Hello',
      body: 'Welcome.',
    });

    const written = create.mock.calls[0]?.[0];
    const windowMs = NOTIFICATION_LIMITS.retentionDays * 24 * 60 * 60 * 1000;

    expect(written?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + windowMs - 5_000);
    expect(written?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + windowMs + 5_000);
  });

  it('clamps server-authored text to what the schema will accept', async () => {
    const create = vi
      .spyOn(notificationRepository, 'create')
      .mockResolvedValue(makeRow() as never);
    vi.spyOn(notificationRepository, 'unreadCount').mockResolvedValue(0);
    vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([] as never);

    await notificationService.notify({
      userId: USER_A,
      type: NOTIFICATION_TYPE.systemAnnouncement,
      title: 'x'.repeat(NOTIFICATION_LIMITS.maxTitleLength + 50),
      body: 'y'.repeat(NOTIFICATION_LIMITS.maxBodyLength + 50),
    });

    const written = create.mock.calls[0]?.[0];
    expect(written?.title.length).toBeLessThanOrEqual(NOTIFICATION_LIMITS.maxTitleLength);
    expect(written?.body.length).toBeLessThanOrEqual(NOTIFICATION_LIMITS.maxBodyLength);
  });

  /**
   * The rule the whole feature depends on: producers call `notify` from inside
   * flows that have already committed. A throw here would turn a missing nudge
   * into a failed friend request.
   */
  it('never propagates a write failure to the caller', async () => {
    vi.spyOn(notificationRepository, 'create').mockRejectedValue(new Error('mongo is down'));

    await expect(
      notificationService.notify({
        userId: USER_A,
        type: NOTIFICATION_TYPE.friendRequest,
        title: 'New friend request',
        body: 'Bo wants to be your friend.',
      }),
    ).resolves.toBeNull();
  });
});

describe('fan-out', () => {
  it('de-duplicates recipients and writes them in one insert', async () => {
    const createMany = vi.spyOn(notificationRepository, 'createMany').mockResolvedValue(2);
    vi.spyOn(notificationRepository, 'unreadCount').mockResolvedValue(1);

    const written = await notificationService.notifyMany([USER_A, USER_B, USER_A], {
      type: NOTIFICATION_TYPE.friendStartedPlaying,
      title: 'Ana is playing',
      body: 'Jump in.',
    });

    expect(written).toBe(2);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('does nothing at all for an empty recipient list', async () => {
    const createMany = vi.spyOn(notificationRepository, 'createMany').mockResolvedValue(0);

    expect(
      await notificationService.notifyMany([], {
        type: NOTIFICATION_TYPE.tournamentAnnouncement,
        title: 'Weekend cup',
        body: 'Sign up now.',
      }),
    ).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('reading the inbox', () => {
  it('reports hasMore from the total rather than from the page size', async () => {
    vi.spyOn(notificationRepository, 'list').mockResolvedValue([makeRow()] as never);
    vi.spyOn(notificationRepository, 'count').mockResolvedValue(9);
    vi.spyOn(notificationRepository, 'unreadCount').mockResolvedValue(4);
    vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([ACTOR] as never);

    const page = await notificationService.list(USER_A, 1, 1, false);

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(9);
    expect(page.unreadCount).toBe(4);
    expect(page.hasMore).toBe(true);
  });

  it('resolves every actor in one query rather than one per row', async () => {
    const findMany = vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([ACTOR] as never);
    vi.spyOn(notificationRepository, 'list').mockResolvedValue([
      makeRow(),
      makeRow({ _id: 'other' }),
      makeRow({ _id: 'third' }),
    ] as never);
    vi.spyOn(notificationRepository, 'count').mockResolvedValue(3);
    vi.spyOn(notificationRepository, 'unreadCount').mockResolvedValue(3);

    await notificationService.list(USER_A, 1, 25, false);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]).toEqual([USER_B]);
  });

  it('leaves the actor null on a system notification', async () => {
    vi.spyOn(notificationRepository, 'list').mockResolvedValue([
      makeRow({ actorId: null, type: NOTIFICATION_TYPE.systemAnnouncement }),
    ] as never);
    vi.spyOn(notificationRepository, 'count').mockResolvedValue(1);
    vi.spyOn(notificationRepository, 'unreadCount').mockResolvedValue(0);
    const findMany = vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([] as never);

    const page = await notificationService.list(USER_A, 1, 25, false);

    expect(page.items[0]?.actor).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('acting on one row', () => {
  it('reports a stranger id and a missing id identically', async () => {
    vi.spyOn(notificationRepository, 'markRead').mockResolvedValue(null);
    vi.spyOn(notificationRepository, 'findOwned').mockResolvedValue(null);

    await expect(notificationService.markRead(USER_A, NOTIFICATION_ID)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  /**
   * Marking an already-read row read is a no-op, not an error. The client
   * taps a notification it has already opened all the time.
   */
  it('accepts a row that was already read', async () => {
    vi.spyOn(notificationRepository, 'markRead').mockResolvedValue(null);
    vi.spyOn(notificationRepository, 'findOwned').mockResolvedValue(
      makeRow({ readAt: new Date() }) as never,
    );
    vi.spyOn(notificationRepository, 'unreadCount').mockResolvedValue(2);

    await expect(notificationService.markRead(USER_A, NOTIFICATION_ID)).resolves.toEqual({
      unreadCount: 2,
    });
  });

  it('refuses to delete a row that is not the callers', async () => {
    vi.spyOn(notificationRepository, 'remove').mockResolvedValue(false);

    const error = await notificationService
      .remove(USER_A, NOTIFICATION_ID)
      .catch((thrown: unknown) => thrown);

    expect(AppError.isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('reports a zero badge after marking everything read', async () => {
    vi.spyOn(notificationRepository, 'markAllRead').mockResolvedValue(12);

    expect(await notificationService.markAllRead(USER_A)).toEqual({
      updated: 12,
      unreadCount: 0,
    });
  });
});

describe('paging and query parsing', () => {
  it('clamps an optimistic limit instead of refusing it', () => {
    expect(notificationPaging({ page: 1, limit: 5000 }).limit).toBe(NOTIFICATION_LIMITS.maxLimit);
    expect(notificationPaging({ page: 0, limit: 0 }).page).toBe(1);
  });

  it('reads the unread filter from its string form', () => {
    expect(notificationQuerySchema.parse({ unreadOnly: 'true' }).unreadOnly).toBe(true);
    expect(notificationQuerySchema.parse({ unreadOnly: '1' }).unreadOnly).toBe(true);
    expect(notificationQuerySchema.parse({ unreadOnly: 'no' }).unreadOnly).toBe(false);
    expect(notificationQuerySchema.parse({}).unreadOnly).toBe(false);
  });

  it('defaults paging when the client sends nothing', () => {
    const parsed = notificationQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.limit).toBe(NOTIFICATION_LIMITS.defaultLimit);
  });
});

// ---------------------------------------------------------------------------
// The push half
// ---------------------------------------------------------------------------

describe('delivering a notification as a push', () => {
  /** Puts a stub behind the write so only the push decision is under test. */
  function stubWrite(): void {
    vi.spyOn(notificationRepository, 'create').mockResolvedValue(makeRow() as never);
    vi.spyOn(notificationRepository, 'unreadCount').mockResolvedValue(1);
    vi.spyOn(userRepository, 'findManyByIds').mockResolvedValue([] as never);
  }

  it('sends nothing when the caller did not ask for a push', async () => {
    stubWrite();
    const send = vi.spyOn(pushService, 'sendToUser');

    await notificationService.notify({
      userId: USER_A,
      type: NOTIFICATION_TYPE.friendRequest,
      title: 'New friend request',
      body: 'Bo wants to be your friend.',
    });

    // Push is opt-in per call site. Adding a notification type must never
    // silently start interrupting people whose phone is in their pocket.
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the row own title and body, so the two cannot disagree', async () => {
    stubWrite();
    const send = vi
      .spyOn(pushService, 'sendToUser')
      .mockResolvedValue({ sent: 1, failed: 0, pruned: 0, noRecipients: false, notConfigured: false });

    await notificationService.notify({
      userId: USER_A,
      type: NOTIFICATION_TYPE.roomInvitation,
      title: 'Room invitation',
      body: 'Ana invited you to room A7K9P.',
      push: {
        type: PUSH_NOTIFICATION_TYPE.roomInvitation,
        androidChannelId: PUSH_INVITE_ANDROID_CHANNEL.id,
        data: { invitationId: 'inv-1', roomCode: 'A7K9P' },
      },
    });

    expect(send).toHaveBeenCalledWith(USER_A, {
      title: 'Room invitation',
      body: 'Ana invited you to room A7K9P.',
      data: {
        type: PUSH_NOTIFICATION_TYPE.roomInvitation,
        invitationId: 'inv-1',
        roomCode: 'A7K9P',
      },
      androidChannelId: PUSH_INVITE_ANDROID_CHANNEL.id,
    });
  });

  it('still returns the row when the push itself fails', async () => {
    stubWrite();
    vi.spyOn(pushService, 'sendToUser').mockRejectedValue(new Error('FCM is down'));

    const dto = await notificationService.notify({
      userId: USER_A,
      type: NOTIFICATION_TYPE.roomInvitation,
      title: 'Room invitation',
      body: 'Ana invited you to room A7K9P.',
      push: { type: PUSH_NOTIFICATION_TYPE.roomInvitation },
    });

    // The inbox row is the durable half and does not depend on the nudge
    // landing. A caller — an invite that has already been written to Mongo —
    // must never be failed by a notification it did not wait for.
    expect(dto).not.toBeNull();
  });
});
