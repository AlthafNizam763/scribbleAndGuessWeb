import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Push notifications, against a real database.
 *
 * ## Why this needs a real mongod
 *
 * For the same reason `autoTournament.test.ts` does: every claim this file
 * makes *is* an index. "One row per device token" is a unique index. "The
 * scheduler running twice sends one notification" is a unique index on
 * `userId + tournamentId + type` and an `insertMany` that survives colliding
 * with it. A mock would assert that the code calls the query it was written to
 * call, which was never the thing in doubt.
 *
 * ## What is faked, and what deliberately is not
 *
 * Firebase is faked — there is no service account in CI and sending a real
 * push from a test would be a genuinely bad idea. The fake records what it was
 * asked to deliver and can be told to reject a token, which is enough to
 * exercise both the success path and the dead-token pruning.
 *
 * Everything else is real: the models, their indexes, the repository, the
 * claim, and the lifecycle transition that triggers the whole thing.
 */

let mongo: MongoMemoryServer;

vi.mock('@/config/database', async () => ({
  connectToDatabase: async () => mongoose,
  disconnectFromDatabase: async () => undefined,
  watchDatabaseEvents: () => undefined,
}));

/** One message the fake FCM was asked to deliver. */
interface SentMessage {
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
  channelId?: string;
}

const sent: SentMessage[] = [];

/** Tokens the fake rejects as dead, as FCM would for an uninstalled app. */
const deadTokens = new Set<string>();

/** Tokens the fake rejects transiently, to exercise the retry. */
const flakyTokens = new Set<string>();

let configured = true;

vi.mock('@/config/firebaseAdmin', () => ({
  isFirebaseConfigured: () => configured,
  maskToken: (token: string) => `***${token.slice(-6)}`,
  getPushMessaging: () =>
    configured
      ? {
          sendEachForMulticast: async (message: {
            tokens: string[];
            notification: { title: string; body: string };
            data: Record<string, string>;
            android?: { notification?: { channelId?: string } };
          }) => {
            sent.push({
              tokens: [...message.tokens],
              title: message.notification.title,
              body: message.notification.body,
              data: { ...message.data },
              channelId: message.android?.notification?.channelId,
            });

            return {
              responses: message.tokens.map((token) => {
                if (deadTokens.has(token)) {
                  return {
                    success: false,
                    error: { code: 'messaging/registration-token-not-registered' },
                  };
                }
                if (flakyTokens.has(token)) {
                  return { success: false, error: { code: 'messaging/server-unavailable' } };
                }
                return { success: true };
              }),
            };
          },
          send: async () => 'projects/test/messages/1',
        }
      : null,
}));

// The inbox is covered by `notification.test.ts`. Stubbed here so this file
// measures the *targeting* — who is told — rather than re-testing the write,
// and so nothing reaches for a user row that these fixtures never create.
const notifyMany = vi.fn(async () => 0);
vi.mock('@/services/notification.service', () => ({
  notificationService: { notifyMany, notify: vi.fn(async () => null) },
}));

const {
  AUTO_TOURNAMENT_STATUS,
  DAILY_SLOT,
  DAILY_SLOT_ORDER,
  PLAYER_TYPE,
  REGISTRATION_STATUS,
} = await import('@/constants/autoTournament.constants');
type DailySlotWire =
  (typeof import('@/constants/autoTournament.constants'))['DAILY_SLOT'][keyof (typeof import('@/constants/autoTournament.constants'))['DAILY_SLOT']];
const {
  DEVICE_PLATFORM,
  DEVICE_TOKEN_LIMITS,
  NOTIFICATION_LOG_STATUS,
  PUSH_ANDROID_CHANNEL,
  PUSH_NOTIFICATION_TYPE,
  notificationKeyFor,
} = await import('@/constants/notification.constants');
const { AutoTournament, TournamentRegistration } = await import('@/models/AutoTournament');
const { NotificationLog } = await import('@/models/NotificationLog');
const { UserDeviceToken } = await import('@/models/UserDeviceToken');
const { deviceTokenRepository } = await import('@/repositories/deviceToken.repository');
const { deviceTokenService } = await import('@/services/deviceToken.service');
const { pushService } = await import('@/services/push.service');
const { tournamentCheckInNotifier } = await import(
  '@/services/tournament/checkInNotify.service'
);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'push_test' });

  // Built rather than left to background sync: the uniqueness these declare is
  // the subject of half this file, and an assertion about a duplicate would
  // otherwise pass because the index was not there yet.
  await Promise.all([
    UserDeviceToken.syncIndexes(),
    NotificationLog.syncIndexes(),
    AutoTournament.syncIndexes(),
    TournamentRegistration.syncIndexes(),
  ]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(() => {
  sent.length = 0;
  deadTokens.clear();
  flakyTokens.clear();
  notifyMany.mockClear();
  configured = true;
});

afterEach(async () => {
  await Promise.all([
    UserDeviceToken.deleteMany({}),
    NotificationLog.deleteMany({}),
    AutoTournament.deleteMany({}),
    TournamentRegistration.deleteMany({}),
  ]);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const userId = (): string => new mongoose.Types.ObjectId().toHexString();

/** A token long enough to pass the model's own bounds. */
const tokenFor = (label: string): string => label.padEnd(DEVICE_TOKEN_LIMITS.minTokenLength, 'x');

/**
 * One tournament sitting in check-in.
 *
 * Identified by `{tournamentDate, dailySlot}`, which is what the daily
 * scheduler keys on — so "three tournaments at once" here means the morning,
 * afternoon and evening of one day, exactly as it does in production.
 */
async function makeTournament(slot: DailySlotWire = DAILY_SLOT.morning): Promise<string> {
  const now = new Date();

  const row = await AutoTournament.create({
    tournamentDate: '2026-09-16',
    dailySlot: slot,
    slotNumber: DAILY_SLOT_ORDER[slot],
    name: `Test Cup ${slot}`,
    status: AUTO_TOURNAMENT_STATUS.checkIn,
    isAutomatic: true,
    minPlayers: 4,
    maxPlayers: 16,
    minHumanPlayers: 1,
    maxBots: 3,
    allowBots: true,
    registrationOpenAt: now,
    registrationCloseAt: now,
    checkInOpenAt: now,
    checkInCloseAt: new Date(now.getTime() + 120_000),
    startAt: new Date(now.getTime() + 120_000),
  });

  return String(row._id);
}

async function register(
  tournamentId: string,
  id: string,
  status: string = REGISTRATION_STATUS.registered,
  playerType: string = PLAYER_TYPE.human,
): Promise<void> {
  await TournamentRegistration.create({
    tournamentId,
    userId: playerType === PLAYER_TYPE.human ? id : null,
    botId: playerType === PLAYER_TYPE.human ? null : id,
    displayName: `Player ${id.slice(-4)}`,
    playerType,
    isBot: playerType !== PLAYER_TYPE.human,
    status,
    joinedAt: new Date(),
  });
}

async function giveDevice(id: string, token: string): Promise<void> {
  await deviceTokenRepository.upsert({
    userId: id,
    token,
    platform: DEVICE_PLATFORM.android,
    deviceId: null,
  });
}

// ---------------------------------------------------------------------------

describe('device token registration', () => {
  it('writes one row however many times the same device registers', async () => {
    const me = userId();
    const token = tokenFor('phone-a');

    await deviceTokenService.register({
      userId: me,
      token,
      platform: DEVICE_PLATFORM.android,
      deviceId: 'pixel',
    });
    await deviceTokenService.register({
      userId: me,
      token,
      platform: DEVICE_PLATFORM.android,
      deviceId: 'pixel',
    });
    await deviceTokenService.register({
      userId: me,
      token,
      platform: DEVICE_PLATFORM.android,
      deviceId: 'pixel',
    });

    // The client calls this on every launch, after every sign-in and on every
    // refresh. Three overlapping callers must not become three devices.
    expect(await UserDeviceToken.countDocuments({ token })).toBe(1);
  });

  it('moves a shared handset to whoever is signed in on it now', async () => {
    const first = userId();
    const second = userId();
    const token = tokenFor('shared');

    await giveDevice(first, token);
    await giveDevice(second, token);

    // A phone handed to a sibling who signs in as a guest keeps its FCM token.
    // If both rows survived, the first player's tournament notifications would
    // be delivered to a handset they no longer hold.
    const rows = await UserDeviceToken.find({ token }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.userId)).toBe(second);
  });

  it('brings a token FCM had rejected back when the device presents it again', async () => {
    const me = userId();
    const token = tokenFor('revived');

    await giveDevice(me, token);
    await deviceTokenRepository.deactivateTokens([token]);
    expect(await deviceTokenRepository.countActive(me)).toBe(0);

    await giveDevice(me, token);

    // A device presenting a token is the strongest possible evidence it is
    // alive, and outranks whatever FCM said about it earlier.
    expect(await deviceTokenRepository.countActive(me)).toBe(1);
  });

  it('retires the least recently used device past the cap', async () => {
    const me = userId();

    for (let index = 0; index < DEVICE_TOKEN_LIMITS.maxDevicesPerUser + 3; index += 1) {
      await deviceTokenService.register({
        userId: me,
        token: tokenFor(`device-${index}-`),
        platform: DEVICE_PLATFORM.android,
        deviceId: null,
      });
    }

    expect(await deviceTokenRepository.countActive(me)).toBe(
      DEVICE_TOKEN_LIMITS.maxDevicesPerUser,
    );

    // And the newest survived — a cap that dropped the phone somebody is
    // holding would be exactly backwards.
    const live = await deviceTokenRepository.activeForUser(me);
    expect(live.map((row) => row.token)).toContain(tokenFor('device-12-'));
  });

  it('refuses to silence a token the caller does not own', async () => {
    const mine = userId();
    const theirs = userId();
    const token = tokenFor('not-mine');

    await giveDevice(theirs, token);

    const outcome = await deviceTokenService.unregister(mine, token);

    expect(outcome.removed).toBe(false);
    expect(await deviceTokenRepository.countActive(theirs)).toBe(1);
  });
});

describe('sending a push', () => {
  it('reaches every live device one person has', async () => {
    const me = userId();
    await giveDevice(me, tokenFor('phone-'));
    await giveDevice(me, tokenFor('tablet-'));

    const result = await pushService.sendToUser(me, {
      title: 'Hello',
      body: 'There',
      data: { type: 'TEST' },
    });

    expect(result.sent).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.tokens).toHaveLength(2);
  });

  it('names the high-importance channel the client created', async () => {
    const me = userId();
    await giveDevice(me, tokenFor('phone-'));

    await pushService.sendToUser(me, { title: 'a', body: 'b', data: { type: 'TEST' } });

    // Android silently ignores a channel id it has never heard of and delivers
    // at default importance — no heads-up, no sound on a locked phone — which
    // is indistinguishable from the push never arriving.
    expect(sent[0]!.channelId).toBe(PUSH_ANDROID_CHANNEL.id);
  });

  it('retires a token FCM says is gone, and keeps one it merely failed on', async () => {
    const me = userId();
    const gone = tokenFor('uninstalled-');
    const flaky = tokenFor('flaky-');

    await giveDevice(me, gone);
    await giveDevice(me, flaky);
    deadTokens.add(gone);
    flakyTokens.add(flaky);

    const result = await pushService.sendToUser(me, {
      title: 'a',
      body: 'b',
      data: { type: 'TEST' },
    });

    expect(result.pruned).toBe(1);

    const live = await deviceTokenRepository.activeForUser(me);
    // A transient rejection must never unsubscribe a working device: that
    // failure is silent and permanent, which is the worst kind.
    expect(live.map((row) => row.token)).toEqual([flaky]);
  });

  it('reports no recipients rather than failing when nobody has a device', async () => {
    const result = await pushService.sendToUser(userId(), {
      title: 'a',
      body: 'b',
      data: { type: 'TEST' },
    });

    expect(result.noRecipients).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('is a no-op when no service account is configured', async () => {
    configured = false;

    const me = userId();
    await giveDevice(me, tokenFor('phone-'));

    const result = await pushService.sendToUser(me, {
      title: 'a',
      body: 'b',
      data: { type: 'TEST' },
    });

    // A deployment without Firebase is supported: everything else keeps
    // working and the send is a logged nothing.
    expect(result.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('the tournament check-in fan-out', () => {
  it('tells the registered humans of that tournament and nobody else', async () => {
    const tournamentId = await makeTournament();

    const registered = userId();
    const alsoRegistered = userId();
    const withdrawn = userId();
    const noShow = userId();
    const stranger = userId();

    await register(tournamentId, registered);
    await register(tournamentId, alsoRegistered, REGISTRATION_STATUS.checkedIn);
    await register(tournamentId, withdrawn, REGISTRATION_STATUS.withdrawn);
    await register(tournamentId, noShow, REGISTRATION_STATUS.noShow);
    await register(tournamentId, 'bot-1', REGISTRATION_STATUS.registered, PLAYER_TYPE.aiBot);

    for (const id of [registered, alsoRegistered, withdrawn, noShow, stranger]) {
      await giveDevice(id, tokenFor(`${id}-`));
    }

    const result = await tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Test Cup 1');

    expect(result.eligibleUsers).toBe(2);
    expect(result.notificationsSent).toBe(2);

    const reached = sent.flatMap((message) => message.tokens);
    expect(reached).toHaveLength(2);
    expect(reached).toContain(tokenFor(`${registered}-`));
    expect(reached).toContain(tokenFor(`${alsoRegistered}-`));
    // A cancelled registration, a written-off no-show and somebody who was
    // never in this tournament are all the same answer: not their business.
    expect(reached).not.toContain(tokenFor(`${withdrawn}-`));
    expect(reached).not.toContain(tokenFor(`${noShow}-`));
    expect(reached).not.toContain(tokenFor(`${stranger}-`));
  });

  it('carries the payload the client routes on', async () => {
    const tournamentId = await makeTournament();
    const me = userId();

    await register(tournamentId, me);
    await giveDevice(me, tokenFor('phone-'));

    await tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Test Cup 1');

    expect(sent[0]!.data).toEqual({
      type: PUSH_NOTIFICATION_TYPE.tournamentCheckInOpen,
      tournamentId,
      route: '/tournaments',
    });
    expect(sent[0]!.title).toContain('Check-in is Open');
  });

  it('sends once however many times the scheduler runs', async () => {
    const tournamentId = await makeTournament();
    const me = userId();

    await register(tournamentId, me);
    await giveDevice(me, tokenFor('phone-'));

    const first = await tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Cup');
    const second = await tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Cup');
    const third = await tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Cup');

    expect(first.claimed).toBe(1);
    expect(second.claimed).toBe(0);
    expect(third.claimed).toBe(0);

    // The whole point. An in-process loop and an external cron may both tick,
    // and either may be retried after a crash; a player woken twice at 2am has
    // been failed in a way they remember.
    expect(sent).toHaveLength(1);
    expect(await NotificationLog.countDocuments({ tournamentId })).toBe(1);
  });

  it('survives two schedulers arriving together, splitting the recipients', async () => {
    const tournamentId = await makeTournament();
    const players = [userId(), userId(), userId(), userId()];

    for (const id of players) {
      await register(tournamentId, id);
      await giveDevice(id, tokenFor(`${id}-`));
    }

    const [left, right] = await Promise.all([
      tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Cup'),
      tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Cup'),
    ]);

    // However the race falls out, every player is claimed exactly once —
    // Mongo's unique index is the arbiter, so the two runs partition the list
    // between them rather than both taking all of it.
    expect(left.claimed + right.claimed).toBe(players.length);
    expect(await NotificationLog.countDocuments({ tournamentId })).toBe(players.length);

    const reached = new Set(sent.flatMap((message) => message.tokens));
    expect(reached.size).toBe(players.length);
  });

  it('keeps the day’s three tournaments apart', async () => {
    const first = await makeTournament(DAILY_SLOT.morning);
    const second = await makeTournament(DAILY_SLOT.afternoon);
    const third = await makeTournament(DAILY_SLOT.evening);

    const alice = userId();
    const bob = userId();
    const carol = userId();

    await register(first, alice);
    await register(second, bob);
    await register(third, carol);

    await giveDevice(alice, tokenFor('alice-'));
    await giveDevice(bob, tokenFor('bob-'));
    await giveDevice(carol, tokenFor('carol-'));

    await tournamentCheckInNotifier.announceCheckIn(second, 'Cup 2');

    // Slot 2's check-in is slot 2's business. A broadcast would be both wrong
    // and, on a phone at 2am, genuinely unpleasant.
    expect(sent.flatMap((message) => message.tokens)).toEqual([tokenFor('bob-')]);

    await tournamentCheckInNotifier.announceCheckIn(first, 'Cup 1');
    await tournamentCheckInNotifier.announceCheckIn(third, 'Cup 3');

    expect(sent.flatMap((message) => message.tokens)).toEqual([
      tokenFor('bob-'),
      tokenFor('alice-'),
      tokenFor('carol-'),
    ]);
  });

  it('records a recipient with no device as skipped rather than sent', async () => {
    const tournamentId = await makeTournament();
    const withPhone = userId();
    const without = userId();

    await register(tournamentId, withPhone);
    await register(tournamentId, without);
    await giveDevice(withPhone, tokenFor('phone-'));

    const result = await tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Cup');

    expect(result.notificationsSent).toBe(1);
    expect(result.notificationsSkipped).toBe(1);

    const skipped = await NotificationLog.findOne({
      tournamentId,
      userId: without,
    }).lean();
    expect(skipped?.status).toBe(NOTIFICATION_LOG_STATUS.skipped);

    const delivered = await NotificationLog.findOne({
      tournamentId,
      userId: withPhone,
    }).lean();
    expect(delivered?.status).toBe(NOTIFICATION_LOG_STATUS.sent);
    expect(delivered?.notificationKey).toBe(
      notificationKeyFor(PUSH_NOTIFICATION_TYPE.tournamentCheckInOpen, tournamentId, withPhone),
    );
  });

  it('still writes the inbox row when push is unavailable', async () => {
    configured = false;

    const tournamentId = await makeTournament();
    const me = userId();
    await register(tournamentId, me);
    await giveDevice(me, tokenFor('phone-'));

    const result = await tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Cup');

    // A player who turned notifications off, or a deployment with no service
    // account, still finds out when they next open the app.
    expect(notifyMany).toHaveBeenCalledOnce();
    expect(notifyMany.mock.calls[0]).toBeDefined();
    // The recipient list, which is the argument this test is about. Read
    // through `unknown` because the mock is declared with no parameters — a
    // typed stub here would have to restate `NotifyInput`, and this file has
    // no business owning a second copy of that shape.
    const recipients = (notifyMany.mock.calls[0] as unknown as [string[]])[0];
    expect(recipients).toEqual([me]);
    expect(result.notificationsSkipped).toBe(1);
  });

  it('does nothing at all when nobody is registered', async () => {
    const tournamentId = await makeTournament();

    const result = await tournamentCheckInNotifier.announceCheckIn(tournamentId, 'Cup');

    expect(result.eligibleUsers).toBe(0);
    expect(notifyMany).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
