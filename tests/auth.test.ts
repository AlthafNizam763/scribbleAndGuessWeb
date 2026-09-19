import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Email registration and sign-in.
 *
 * ## Why this needs a real mongod
 *
 * The claim worth testing is not "register writes a row" — it is that a guest
 * who registers is *upgraded in place*, keeping the id every score, friendship
 * and achievement they earned is keyed by. That is a statement about which
 * document was written, enforced partly by a sparse unique index on `email`.
 * Mocking the collection would assert that the code calls the query it was
 * written to call, which was never the thing in doubt.
 *
 * The pure half — what the validators accept — is tested below without a
 * database, in the style of `social.test.ts`.
 */

let mongo: MongoMemoryServer;

vi.mock('@/config/database', async () => ({
  connectToDatabase: async () => mongoose,
  disconnectFromDatabase: async () => undefined,
  watchDatabaseEvents: () => undefined,
}));

const { authService } = await import('@/services/auth.service');
const { User } = await import('@/models/User');
const { loginSchema, registerSchema } = await import('@/validators/auth.validator');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'auth_test' });

  // Built rather than left to background sync: "one account per email" is the
  // partial unique index, and a duplicate-registration assertion would
  // otherwise pass because the index was not there yet.
  await User.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
});

describe('registering a new account', () => {
  it('creates an email account and issues a token for it', async () => {
    const { token, user, upgraded } = await authService.register({
      username: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery',
    });

    expect(upgraded).toBe(false);
    expect(user.username).toBe('Ada');
    expect(user.provider).toBe('email');
    // The token must resolve to the row that was just written, not merely parse.
    await expect(authService.authenticate(token)).resolves.toMatchObject({ id: user.id });
  });

  it('stores the address lowercased, so sign-in matches whatever was typed', async () => {
    await authService.register({
      username: 'Ada',
      email: 'Ada@Example.COM',
      password: 'correct horse battery',
    });

    const signedIn = await authService.login('ada@example.com', 'correct horse battery');
    expect(signedIn.user.username).toBe('Ada');
  });

  it('refuses an address that is already registered', async () => {
    await authService.register({ username: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });

    await expect(
      authService.register({ username: 'Bob', email: 'ada@example.com', password: 'a different one' }),
    ).rejects.toThrow(/already registered/i);

    expect(await User.countDocuments({})).toBe(1);
  });

  it('refuses a registration with no display name and nobody signed in', async () => {
    await expect(
      authService.register({ email: 'nameless@example.com', password: 'correct horse battery' }),
    ).rejects.toThrow(/display name/i);
  });
});

describe('upgrading a guest', () => {
  it('keeps the same account, so the guest’s history follows them', async () => {
    const guest = await authService.createGuest({ username: 'Ada', avatarId: 3, avatarColorIndex: 5 });

    // Stand in for everything a guest accumulates before signing up.
    await User.updateOne({ _id: guest.user.id }, { $set: { totalScore: 420, gamesWon: 7 } });

    const upgraded = await authService.register({
      existingUserId: guest.user.id,
      existingProvider: 'guest',
      email: 'ada@example.com',
      password: 'correct horse battery',
    });

    expect(upgraded.upgraded).toBe(true);
    // The whole point: same id, so every row keyed by it still belongs to them.
    expect(upgraded.user.id).toBe(guest.user.id);
    expect(await User.countDocuments({})).toBe(1);

    const row = await User.findById(guest.user.id).lean();
    expect(row?.totalScore).toBe(420);
    expect(row?.gamesWon).toBe(7);
    expect(row?.authProvider).toBe('email');
  });

  it('keeps the name and avatar the guest already chose', async () => {
    const guest = await authService.createGuest({ username: 'Ada', avatarId: 3, avatarColorIndex: 5 });

    const upgraded = await authService.register({
      existingUserId: guest.user.id,
      existingProvider: 'guest',
      // A client that sends a name here must not be able to overwrite theirs.
      username: 'Somebody Else',
      email: 'ada@example.com',
      password: 'correct horse battery',
    });

    expect(upgraded.user.username).toBe('Ada');
    expect(upgraded.user.avatarId).toBe(3);
    expect(upgraded.user.avatarColorIndex).toBe(5);
  });

  it('lets the upgraded account sign in with its new password', async () => {
    const guest = await authService.createGuest({ username: 'Ada', avatarId: 0, avatarColorIndex: 0 });
    await authService.register({
      existingUserId: guest.user.id,
      existingProvider: 'guest',
      email: 'ada@example.com',
      password: 'correct horse battery',
    });

    const signedIn = await authService.login('ada@example.com', 'correct horse battery');
    expect(signedIn.user.id).toBe(guest.user.id);
  });

  it('refuses to re-credential an account that already has a sign-in', async () => {
    const first = await authService.register({
      username: 'Ada',
      email: 'ada@example.com',
      password: 'correct horse battery',
    });

    await expect(
      authService.register({
        existingUserId: first.user.id,
        existingProvider: 'email',
        email: 'ada-again@example.com',
        password: 'correct horse battery',
      }),
    ).rejects.toThrow(/already has a sign-in/i);
  });

  it('refuses to take an address another account already holds', async () => {
    await authService.register({ username: 'Bob', email: 'bob@example.com', password: 'correct horse battery' });
    const guest = await authService.createGuest({ username: 'Ada', avatarId: 0, avatarColorIndex: 0 });

    await expect(
      authService.register({
        existingUserId: guest.user.id,
        existingProvider: 'guest',
        email: 'bob@example.com',
        password: 'correct horse battery',
      }),
    ).rejects.toThrow(/already registered/i);
  });
});

describe('signing in', () => {
  beforeEach(async () => {
    await authService.register({ username: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });
  });

  it('rejects the wrong password', async () => {
    await expect(authService.login('ada@example.com', 'not it')).rejects.toThrow();
  });

  it('reports a missing account and a wrong password identically', async () => {
    // Otherwise the endpoint tells an attacker which addresses are registered.
    const missing = await authService.login('nobody@example.com', 'correct horse battery').catch((e: Error) => e.message);
    const wrong = await authService.login('ada@example.com', 'not it').catch((e: Error) => e.message);

    expect(missing).toBe(wrong);
  });

  it('refuses a guest account, which has no password to match', async () => {
    await authService.createGuest({ username: 'Guest', avatarId: 0, avatarColorIndex: 0 });
    await expect(authService.login('', 'anything')).rejects.toThrow();
  });
});

describe('what the register schema accepts', () => {
  const valid = { username: 'Ada', email: 'ada@example.com', password: 'correct horse battery' };

  it('normalises the address it hands downstream', () => {
    const parsed = registerSchema.parse({ ...valid, email: '  Ada@Example.COM  ' });
    expect(parsed.email).toBe('ada@example.com');
  });

  it('accepts credentials with no username, for the upgrade path', () => {
    const parsed = registerSchema.parse({ email: 'ada@example.com', password: 'correct horse battery' });
    expect(parsed.username).toBeUndefined();
  });

  it('refuses a password under eight characters', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'short1' }).success).toBe(false);
  });

  it('refuses a password over bcrypt’s 72-byte limit', () => {
    // Beyond 72 bytes bcrypt hashes only the prefix, so two different
    // passwords sharing one would open the same account.
    expect(registerSchema.safeParse({ ...valid, password: 'a'.repeat(73) }).success).toBe(false);
  });

  it('measures that limit in bytes, not characters', () => {
    // 24 three-byte characters is 72 bytes: the last length that is safe.
    expect(registerSchema.safeParse({ ...valid, password: '☂'.repeat(24) }).success).toBe(true);
    expect(registerSchema.safeParse({ ...valid, password: '☂'.repeat(25) }).success).toBe(false);
  });

  it('refuses something that is not an address', () => {
    expect(registerSchema.safeParse({ ...valid, email: 'ada-at-example' }).success).toBe(false);
  });
});

describe('what the login schema accepts', () => {
  it('does not impose today’s password rules on an existing password', () => {
    // An account made under older rules must still be able to sign in.
    expect(loginSchema.safeParse({ email: 'ada@example.com', password: 'old' }).success).toBe(true);
  });

  it('still refuses an empty password', () => {
    expect(loginSchema.safeParse({ email: 'ada@example.com', password: '' }).success).toBe(false);
  });
});
