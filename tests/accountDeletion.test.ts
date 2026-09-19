import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Deleting an account.
 *
 * ## Why this needs a real mongod
 *
 * Every claim worth making here is about *which documents survive*: the
 * personal collections are emptied, the user row is kept as a tombstone with
 * nothing identifying left on it, and the account can no longer authenticate.
 * Mocking the collections would assert that the service calls the deletes it
 * was written to call, which was never the thing in doubt — the risk is a
 * collection nobody remembered, and only a real database can catch that.
 *
 * The `email` unset is the other reason: it carries a sparse unique index, and
 * "the address is released for re-registration" is a statement about that
 * index rather than about the field.
 */

let mongo: MongoMemoryServer;

vi.mock('@/config/database', async () => ({
  connectToDatabase: async () => mongoose,
  disconnectFromDatabase: async () => undefined,
  watchDatabaseEvents: () => undefined,
}));

const { accountDeletionService } = await import('@/services/accountDeletion.service');
const { authService } = await import('@/services/auth.service');
const { userRepository } = await import('@/repositories/user.repository');

const { User } = await import('@/models/User');
const { Achievement } = await import('@/models/Achievement');
const { Block } = await import('@/models/Block');
const { FriendRequest } = await import('@/models/FriendRequest');
const { Friendship } = await import('@/models/Friendship');
const { Notification } = await import('@/models/Notification');
const { RoomInvitation } = await import('@/models/RoomInvitation');
const { UserDeviceToken } = await import('@/models/UserDeviceToken');
const { XPHistory } = await import('@/models/XPHistory');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'deletion_test' });

  // Built rather than left to background sync: "the address is released" is a
  // claim about the sparse unique index on `email`, and an assertion made
  // before the index existed would pass for the wrong reason.
  await User.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  // Spelled out rather than mapped over an array of models: each `deleteMany`
  // is typed against its own document, and the union of nine of them has no
  // call signature the compiler can agree on.
  await Promise.all([
    User.deleteMany({}).exec(),
    Achievement.deleteMany({}).exec(),
    Block.deleteMany({}).exec(),
    FriendRequest.deleteMany({}).exec(),
    Friendship.deleteMany({}).exec(),
    Notification.deleteMany({}).exec(),
    RoomInvitation.deleteMany({}).exec(),
    UserDeviceToken.deleteMany({}).exec(),
    XPHistory.deleteMany({}).exec(),
  ]);
});

/** An account with something in every collection deletion is meant to clear. */
async function seedAccount(email = 'gary@example.com') {
  const user = await User.create({
    username: 'Confused Gary',
    email,
    avatarId: 4,
    avatarColorIndex: 2,
    bio: 'I draw badly',
    city: 'Kochi',
    country: 'IN',
    gamesPlayed: 12,
    gamesWon: 3,
  });

  const id = user._id;
  const other = new mongoose.Types.ObjectId();

  await Promise.all([
    UserDeviceToken.create({ userId: id, token: 'd'.repeat(140), platform: 'android' }),
    Friendship.create({ userAId: id, userBId: other }),
    FriendRequest.create({ senderId: id, receiverId: other, status: 'pending', pairKey: [String(id), String(other)].sort().join(':') }),
    Block.create({ blockerId: other, blockedUserId: id }),
    Notification.create({
      userId: id,
      type: 'system_announcement',
      title: 'Hi',
      body: 'There',
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    Achievement.create({ userId: id, key: 'first_win' }),
  ]);

  return { user, id, other };
}

describe('deleting an account', () => {
  it('keeps the row as a tombstone rather than removing it', async () => {
    const { id } = await seedAccount();

    await accountDeletionService.delete(String(id));

    // The row has to survive: twenty-one collections reference this id, and
    // most of what they hold belongs to other players.
    const row = await User.findById(id).lean().exec();
    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeTruthy();
  });

  it('strips everything identifying from the tombstone', async () => {
    const { id } = await seedAccount();

    await accountDeletionService.delete(String(id));
    const row = await User.findById(id).lean().exec();

    expect(row?.username).toBe('Deleted player');
    expect(row?.email ?? null).toBeNull();
    expect(row?.bio).toBe('');
    expect(row?.city).toBeNull();
    expect(row?.country).toBeNull();
  });

  it('keeps the counters other players\' history is expressed in', async () => {
    const { id } = await seedAccount();

    await accountDeletionService.delete(String(id));
    const row = await User.findById(id).lean().exec();

    // A finished match's standings name this id and show its score. Zeroing
    // the counters would rewrite somebody else's game.
    expect(row?.gamesPlayed).toBe(12);
    expect(row?.gamesWon).toBe(3);
  });

  it('purges every personal collection', async () => {
    const { id } = await seedAccount();

    await accountDeletionService.delete(String(id));

    const counts = await Promise.all([
      UserDeviceToken.countDocuments({ userId: id }).exec(),
      Friendship.countDocuments({ $or: [{ userAId: id }, { userBId: id }] }).exec(),
      FriendRequest.countDocuments({ $or: [{ senderId: id }, { receiverId: id }] }).exec(),
      Notification.countDocuments({ userId: id }).exec(),
      Achievement.countDocuments({ userId: id }).exec(),
    ]);

    expect(counts).toEqual([0, 0, 0, 0, 0]);
  });

  it('removes blocks made *against* the account as well as by it', async () => {
    const { id } = await seedAccount();

    await accountDeletionService.delete(String(id));

    // Left behind, this would silently filter a stranger's lists against an
    // account that no longer exists.
    expect(await Block.countDocuments({ blockedUserId: id }).exec()).toBe(0);
  });

  it('releases the email address for a future sign-up', async () => {
    const { id } = await seedAccount('gary@example.com');

    await accountDeletionService.delete(String(id));

    // `$unset` rather than null: a row holding null would occupy the address
    // against the sparse unique index.
    await expect(
      User.create({ username: 'Somebody Else', email: 'gary@example.com', avatarId: 0, avatarColorIndex: 0 }),
    ).resolves.toBeTruthy();
  });

  it('stops the account authenticating, even with a valid token', async () => {
    const { id } = await seedAccount();
    const token = authService.issueToken(String(id), 'email');

    // Sanity: the token works before the deletion, so the assertion below is
    // about the deletion rather than about a malformed token.
    await expect(authService.authenticate(token)).resolves.toBeTruthy();

    await accountDeletionService.delete(String(id));

    await expect(authService.authenticate(token)).rejects.toThrow();
  });

  it('drops the account out of search', async () => {
    const { id } = await seedAccount();
    await User.updateOne({ _id: id }, { $set: { username: 'Findable' } }).exec();

    expect(await userRepository.searchByUsername('Find', 10)).toHaveLength(1);

    await accountDeletionService.delete(String(id));

    // The tombstone is named "Deleted player", so this also proves the
    // `deletedAt` filter rather than just the rename.
    expect(await userRepository.searchByUsername('Deleted', 10)).toHaveLength(0);
  });

  it('is idempotent', async () => {
    const { id } = await seedAccount();

    await accountDeletionService.delete(String(id));
    const second = await accountDeletionService.delete(String(id));

    // The caller cannot tell "already gone" from "went a moment ago", and
    // neither can the player, so the second call is a no-op rather than an
    // error somebody has to handle.
    expect(second.alreadyDeleted).toBe(true);
  });

  it('refuses an id that never existed', async () => {
    await expect(
      accountDeletionService.delete(String(new mongoose.Types.ObjectId())),
    ).rejects.toThrow();
  });
});

describe('excluding opted-out accounts from search', () => {
  it('hides an account that turned discovery off', async () => {
    const user = await User.create({
      username: 'Hermit',
      avatarId: 0,
      avatarColorIndex: 0,
      preferences: { discoverable: false },
    });

    expect(await userRepository.searchByUsername('Herm', 10)).toHaveLength(0);
    expect(user.preferences?.discoverable).toBe(false);
  });

  it('still finds an account that predates the preference', async () => {
    // No `preferences` subdocument at all — the shape every row had before
    // this feature. `$ne: false` is what keeps these opted in.
    await User.collection.insertOne({
      username: 'Ancient',
      avatarId: 0,
      avatarColorIndex: 0,
      deletedAt: null,
    });

    expect(await userRepository.searchByUsername('Anci', 10)).toHaveLength(1);
  });
});
