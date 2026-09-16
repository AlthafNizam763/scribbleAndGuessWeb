import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The automatic tournament system, against a real database.
 *
 * ## Why this suite needs a database when the rest of the suite does not
 *
 * Because everything it is here to prove *is* the database. "Never a fourth
 * tournament" is a partial unique index. "Two schedulers cannot both advance a
 * tournament" is a conditional update's `modifiedCount`. "A winner is never
 * advanced twice" is a filter on a slot still being null. None of those can be
 * demonstrated against a mock — a mock would assert that the code calls the
 * query it was written to call, which is the one thing that was never in
 * doubt.
 *
 * So this runs against a real mongod, in memory, with the real indexes built.
 * It is the slowest file in the suite and the only one that would catch an
 * index that was declared but never synced.
 */

let mongo: MongoMemoryServer;

// The services call `connectToDatabase` on their own. The connection is made
// here instead, against the throwaway server, so nothing reaches for the
// configured URI.
vi.mock('@/config/database', async () => ({
  connectToDatabase: async () => mongoose,
  disconnectFromDatabase: async () => undefined,
  watchDatabaseEvents: () => undefined,
}));

// Imported after the mock is registered.
const {
  AUTO_TOURNAMENT_STATUS,
  MATCH_OUTCOME,
  MATCH_STATUS,
  PLAYER_TYPE,
  REGISTRATION_STATUS,
  SCHEDULER_TIMING,
} = await import('@/constants/autoTournament.constants');
const { AutoTournament, TournamentRegistration } = await import('@/models/AutoTournament');
const { TournamentMatch, TournamentRound } = await import('@/models/TournamentMatch');
const { TournamentBotProfile, TournamentSchedulerLock } = await import(
  '@/models/TournamentBotProfile'
);
const { botProfileService } = await import('@/services/bot/botProfile.service');
const { tournamentBracketService } = await import('@/services/tournament/bracket.service');
const { tournamentLifecycleService } = await import('@/services/tournament/lifecycle.service');
const { tournamentMatchService } = await import('@/services/tournament/match.service');
const { tournamentScheduler } = await import('@/services/tournament/scheduler.service');
const { tournamentDailyPlanner } = await import('@/services/tournament/dailyPlanner.service');
const { env } = await import('@/config/env');
const { DAILY_SLOT, DAILY_SLOT_ORDER } = await import('@/constants/autoTournament.constants');
const { autoTournamentService } = await import('@/services/tournament/auto.service');
const { tournamentStandInService } = await import('@/services/tournament/standIn.service');
const { TIMING } = await import('@/constants/game.constants');
const { addDays } = await import('@/utils/dayKey');
const { makeRoom } = await import('./helpers');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'tournament_test' });

  // The indexes are the subject of half these tests, so they are built rather
  // than left to Mongoose's background sync — which would otherwise let an
  // assertion about uniqueness pass because the index was not there yet.
  await Promise.all([
    AutoTournament.syncIndexes(),
    TournamentRegistration.syncIndexes(),
    TournamentMatch.syncIndexes(),
    TournamentRound.syncIndexes(),
    TournamentBotProfile.syncIndexes(),
    TournamentSchedulerLock.syncIndexes(),
  ]);
}, 120_000);

afterAll(async () => {
  tournamentScheduler.stop();
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await Promise.all([
    AutoTournament.deleteMany({}),
    TournamentRegistration.deleteMany({}),
    TournamentMatch.deleteMany({}),
    TournamentRound.deleteMany({}),
    TournamentSchedulerLock.deleteMany({}),
  ]);
  botProfileService.refresh();
});

/** A fresh user id. Real users are not needed: only the id is ever stored. */
function userId(): string {
  return new mongoose.Types.ObjectId().toString();
}

/** A registered player, as `register` would have created. */
async function registerPlayer(tournamentId: string, name = 'player') {
  const id = userId();
  await autoTournamentService.register(tournamentId, {
    id,
    username: name,
    avatarId: 1,
    avatarColorIndex: 2,
  } as Parameters<typeof autoTournamentService.register>[1]);
  return id;
}

/**
 * Days are handed out one per fixture rather than shared.
 *
 * `{tournamentDate, dailySlot}` is unique, so two fixtures asking for "the
 * morning tournament" in the same test would collide on the index — which is
 * the constraint working, but not what the test was trying to say. A counter
 * walks the calendar forward instead, so every fixture gets a slot of its own
 * and the ones that *do* mean to collide say so by naming the same day.
 */
let dayCounter = 0;

function nextDay(): string {
  dayCounter += 1;
  return addDays('2026-01-01', dayCounter);
}

/**
 * One tournament, in whatever state the test needs.
 *
 * Built directly rather than through the planner because almost every test
 * below is about what happens *after* a tournament exists — the bracket, the
 * matches, the results table — and driving the real clock to get there would
 * make each of them a scheduling test with a bracket assertion at the end.
 * The scheduling itself is proved in `dailyTournament.test.ts`.
 */
async function makeTournament(
  overrides: Record<string, unknown> = {},
): Promise<AutoTournamentDocumentLike> {
  const now = Date.now();
  const slot = (overrides.dailySlot as string) ?? DAILY_SLOT.morning;

  const row = await AutoTournament.create({
    tournamentDate: nextDay(),
    dailySlot: slot,
    slotNumber: DAILY_SLOT_ORDER[slot as keyof typeof DAILY_SLOT_ORDER],
    name: `Test Cup ${dayCounter}`,
    status: AUTO_TOURNAMENT_STATUS.registration,
    minPlayers: 4,
    maxPlayers: 16,
    minHumanPlayers: 1,
    maxBots: 3,
    allowBots: true,
    // Wide open by default: a fixture that wants a deadline to have passed
    // says so with `expire`.
    registrationOpenAt: new Date(now - 60_000),
    registrationCloseAt: new Date(now + 3_600_000),
    botFillAt: new Date(now + 3_600_000),
    checkInOpenAt: new Date(now + 3_600_000),
    checkInCloseAt: new Date(now + 7_200_000),
    startAt: new Date(now + 7_200_000),
    isAutomatic: true,
    ...overrides,
  });

  return row as unknown as AutoTournamentDocumentLike;
}

type AutoTournamentDocumentLike = Awaited<ReturnType<typeof reload>>;

/** Drags a deadline into the past, so the next tick sees it as due. */
async function expire(
  id: string,
  field:
    | 'registrationOpenAt'
    | 'registrationCloseAt'
    | 'botFillAt'
    | 'countdownEndsAt'
    | 'checkInCloseAt'
    | 'startAt',
): Promise<void> {
  await AutoTournament.updateOne({ _id: id }, { $set: { [field]: new Date(Date.now() - 1_000) } });
}

/**
 * Runs a block with check-in switched off — the fast-start configuration.
 *
 * The daily deployment runs with it on: a tournament published for eight in
 * the evening seals its roster at ten to eight and starts at eight, and none
 * of the bot-fill timers or the fifteen-second countdown are reached. The
 * fast-start path is still supported for a deployment that wants tournaments
 * back to back, so it is still tested — under the configuration that actually
 * has it.
 *
 * `env` is a plain object behind its `as const`, so this is a write and an
 * undo rather than a mock. Restoring in a `finally` matters: leaking `false`
 * into the rest of the file would quietly turn every check-in test into a
 * fast-start test that happened to pass.
 */
async function withFastStart(body: () => Promise<void>): Promise<void> {
  const mutable = env.tournament as { checkInEnabled: boolean };
  const previous = mutable.checkInEnabled;
  mutable.checkInEnabled = false;

  try {
    await body();
  } finally {
    mutable.checkInEnabled = previous;
  }
}

/** The tournament row as it is right now. */
async function reload(id: string) {
  return (await AutoTournament.findById(id).lean().exec())!;
}

// ---------------------------------------------------------------------------
// The three-slot invariant
// ---------------------------------------------------------------------------

describe('the scheduler lock', () => {
  it('lets exactly one of two concurrent ticks run', async () => {
    const [a, b] = await Promise.all([
      tournamentScheduler.runOnce(),
      tournamentScheduler.runOnce(),
    ]);

    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
  });

  it('releases the lock so the next tick can run', async () => {
    await tournamentScheduler.runOnce();
    const second = await tournamentScheduler.runOnce();

    expect(second.ran).toBe(true);
  });

  /**
   * The recovery path. A process that died mid-tick leaves a held lock, and
   * without expiry every tournament would stall for ever.
   */
  it('takes over a lock whose lease has expired', async () => {
    await TournamentSchedulerLock.create({
      key: SCHEDULER_TIMING.lockKey,
      owner: 'a-process-that-died',
      expiresAt: new Date(Date.now() - 60_000),
      acquiredAt: new Date(Date.now() - 120_000),
    });

    const tick = await tournamentScheduler.runOnce();

    expect(tick.ran).toBe(true);
  });

  it('waits out a lock whose lease is still good', async () => {
    await TournamentSchedulerLock.create({
      key: SCHEDULER_TIMING.lockKey,
      owner: 'a-busy-process',
      expiresAt: new Date(Date.now() + 60_000),
      acquiredAt: new Date(),
    });

    const tick = await tournamentScheduler.runOnce();

    expect(tick.ran).toBe(false);
    // Nothing was created, which is the thing worth checking: a tick that did
    // not run must not have had side effects.
    expect(await AutoTournament.countDocuments({})).toBe(0);
  });

  it('publishes a schedule and reports what it did', async () => {
    const tick = await tournamentScheduler.runOnce();

    expect(tick.ran).toBe(true);
    expect(tick.errors).toBe(0);
    // How many depends on the wall-clock hour the suite runs at — a slot whose
    // window has already closed today is skipped. What must always hold is
    // that tomorrow is published in full, which `dailyTournament.test.ts`
    // pins down against a frozen clock.
    expect(tick.created).toBeGreaterThan(0);
    expect(await AutoTournament.countDocuments({})).toBe(tick.created);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registering', () => {
  it('admits a player and counts them', async () => {
    const id = String((await makeTournament())._id);

    const after = await autoTournamentService.register(id, {
      id: userId(),
      username: 'ana',
      avatarId: 0,
      avatarColorIndex: 0,
    } as Parameters<typeof autoTournamentService.register>[1]);

    expect(after.humanPlayerCount).toBe(1);
    expect(after.botPlayerCount).toBe(0);
    expect(after.viewer.isRegistered).toBe(true);
  });

  it('treats a second registration as a no-op rather than an error', async () => {
    const id = String((await makeTournament())._id);

    const user = {
      id: userId(),
      username: 'bo',
      avatarId: 0,
      avatarColorIndex: 0,
    } as Parameters<typeof autoTournamentService.register>[1];

    await autoTournamentService.register(id, user);
    const second = await autoTournamentService.register(id, user);

    expect(second.humanPlayerCount).toBe(1);
    expect(await TournamentRegistration.countDocuments({ tournamentId: id })).toBe(1);
  });

  it('refuses a registration once check-in has opened', async () => {
    const tournament = await makeTournament();

    await registerPlayer(String(tournament._id), 'early');
    await AutoTournament.updateOne(
      { _id: tournament._id },
      { $set: { status: AUTO_TOURNAMENT_STATUS.checkIn } },
    );

    await expect(registerPlayer(String(tournament._id), 'late')).rejects.toThrow(
      /closed/i,
    );
  });

  it('refuses a registration for a tournament that has not opened yet', async () => {
    const tournament = await makeTournament({
      status: AUTO_TOURNAMENT_STATUS.upcoming,
    });

    await expect(registerPlayer(String(tournament._id), 'keen')).rejects.toThrow(
      /not opened yet/i,
    );
  });

  it('refuses a registration for a finished tournament', async () => {
    const tournament = await makeTournament({
      status: AUTO_TOURNAMENT_STATUS.completed,
    });

    await expect(registerPlayer(String(tournament._id), 'late')).rejects.toThrow(
      /finished/i,
    );
  });

  it('refuses a registration for a running tournament', async () => {
    const tournament = await makeTournament({
      status: AUTO_TOURNAMENT_STATUS.running,
    });

    await expect(registerPlayer(String(tournament._id), 'late')).rejects.toThrow(
      /already started/i,
    );
  });

  it('refuses once the tournament is full', async () => {
    const id = String((await makeTournament({ minPlayers: 2, maxPlayers: 2 }))._id);

    await registerPlayer(id, 'one');
    await registerPlayer(id, 'two');

    await expect(registerPlayer(id, 'three')).rejects.toThrow(/full/i);
  });

  it('leaves a player registered but not yet confirmed', async () => {
    const id = String((await makeTournament())._id);

    const player = await registerPlayer(id, 'eager');
    const dto = await autoTournamentService.get(id, player);

    expect(dto.viewer.isRegistered).toBe(true);
    // Check-in is on: joining says "I intend to play", not "I am here".
    expect(dto.viewer.isCheckedIn).toBe(false);
    expect(dto.checkInRequired).toBe(true);
    // The button is not offered until the window opens.
    expect(dto.viewer.canCheckIn).toBe(false);
  });

  it('confirms a player once check-in is open, and only then', async () => {
    const tournament = await makeTournament();
    const id = String(tournament._id);
    const player = await registerPlayer(id, 'punctual');

    await expect(autoTournamentService.checkIn(id, player)).rejects.toThrow(
      /not opened yet/i,
    );

    await AutoTournament.updateOne(
      { _id: id },
      { $set: { status: AUTO_TOURNAMENT_STATUS.checkIn } },
    );

    const before = await autoTournamentService.get(id, player);
    expect(before.viewer.canCheckIn).toBe(true);

    const after = await autoTournamentService.checkIn(id, player);
    expect(after.viewer.isCheckedIn).toBe(true);
    expect(after.viewer.canCheckIn).toBe(false);
  });

  it('marks a player ready simply for joining when check-in is off', async () => {
    await withFastStart(async () => {
      const id = String((await makeTournament())._id);

      const player = await registerPlayer(id, 'eager');
      const dto = await autoTournamentService.get(id, player);

      expect(dto.viewer.isRegistered).toBe(true);
      expect(dto.viewer.isCheckedIn).toBe(true);
      // There is nothing left to confirm, so no button is offered.
      expect(dto.viewer.canCheckIn).toBe(false);
      expect(dto.checkInRequired).toBe(false);
    });
  });

  it('accepts a check-in call as a no-op rather than failing the screen', async () => {
    await withFastStart(async () => {
      const id = String((await makeTournament())._id);
      const player = await registerPlayer(id, 'legacyclient');

      const dto = await autoTournamentService.checkIn(id, player);
      expect(dto.viewer.isCheckedIn).toBe(true);
    });
  });

  it('lets a player withdraw while registration is open', async () => {
    const id = String((await makeTournament())._id);

    const player = await registerPlayer(id, 'fi');
    const after = await autoTournamentService.withdraw(id, player);

    expect(after.humanPlayerCount).toBe(0);
    expect(after.viewer.isRegistered).toBe(false);
  });

  /**
   * Withdrawing marks the row rather than deleting it, so re-joining has to
   * re-take the seat the player already has. An insert would be refused by the
   * unique index as a duplicate of the place they gave back.
   */
  it('lets a player re-join after withdrawing', async () => {
    const id = String((await makeTournament())._id);

    const player = await registerPlayer(id, 'unsure');
    await autoTournamentService.withdraw(id, player);

    const again = await autoTournamentService.register(id, {
      id: player,
      username: 'unsure',
      avatarId: 1,
      avatarColorIndex: 2,
    } as Parameters<typeof autoTournamentService.register>[1]);

    expect(again.viewer.isRegistered).toBe(true);
    expect(again.humanPlayerCount).toBe(1);
    // One row, re-used. Not two.
    expect(await TournamentRegistration.countDocuments({ tournamentId: id })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// More than one tournament a day
// ---------------------------------------------------------------------------

/**
 * The rule that reversed when tournaments became daily.
 *
 * Three tournaments hours apart are not three tournaments at once, so being in
 * one is no reason to be refused another. Winning the morning must not lock
 * somebody out of the evening, and missing the morning must not either.
 */
describe('a player in more than one of the day tournaments', () => {
  /** The day's three, all taking entries: morning, afternoon, evening. */
  async function threeOpenTournaments(): Promise<[string, string, string]> {
    const day = nextDay();

    const rows = await Promise.all(
      [DAILY_SLOT.morning, DAILY_SLOT.afternoon, DAILY_SLOT.evening].map((slot) =>
        makeTournament({ tournamentDate: day, dailySlot: slot }),
      ),
    );

    return rows.map((row) => String(row._id)) as [string, string, string];
  }

  const player = (name: string) =>
    ({
      id: userId(),
      username: name,
      avatarId: 0,
      avatarColorIndex: 0,
    }) as Parameters<typeof autoTournamentService.register>[1];

  it('lets one player join all three', async () => {
    const [morning, afternoon, evening] = await threeOpenTournaments();
    const user = player('keen');

    await autoTournamentService.register(morning, user);
    await autoTournamentService.register(afternoon, user);
    const third = await autoTournamentService.register(evening, user);

    expect(third.viewer.isRegistered).toBe(true);
    expect(await TournamentRegistration.countDocuments({ userId: user.id })).toBe(3);
  });

  it('does not register anybody for a tournament they did not ask for', async () => {
    const [morning, afternoon, evening] = await threeOpenTournaments();
    const user = player('careful');

    await autoTournamentService.register(morning, user);

    for (const other of [afternoon, evening]) {
      const dto = await autoTournamentService.get(other, user.id);
      expect(dto.viewer.isRegistered).toBe(false);
      // And is still perfectly able to join it.
      expect(dto.viewer.canRegister).toBe(true);
      expect(dto.viewer.blockedReason).toBeNull();
    }
  });

  it('lets the winner of one join the next', async () => {
    const [morning, afternoon] = await threeOpenTournaments();
    const user = player('champion');

    const seat = await autoTournamentService.register(morning, user);
    expect(seat.viewer.isRegistered).toBe(true);

    // They won the morning: the registration is marked, the tournament closed.
    await TournamentRegistration.updateOne(
      { tournamentId: morning, userId: user.id },
      { $set: { status: REGISTRATION_STATUS.winner } },
    );
    await AutoTournament.updateOne(
      { _id: morning },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.completed,
          completedAt: new Date(),
          winnerDisplayName: 'champion',
        },
      },
    );

    const next = await autoTournamentService.register(afternoon, user);
    expect(next.viewer.isRegistered).toBe(true);
  });

  it('lets somebody who missed the first join the second', async () => {
    const [morning, afternoon] = await threeOpenTournaments();

    await AutoTournament.updateOne(
      { _id: morning },
      { $set: { status: AUTO_TOURNAMENT_STATUS.completed, completedAt: new Date() } },
    );

    const latecomer = player('missed-it');
    const joined = await autoTournamentService.register(afternoon, latecomer);

    expect(joined.viewer.isRegistered).toBe(true);
  });

  it('gives each tournament its own registration state in the listing', async () => {
    const day = nextDay();

    const rows = await Promise.all(
      [DAILY_SLOT.morning, DAILY_SLOT.afternoon, DAILY_SLOT.evening].map((slot) =>
        makeTournament({ tournamentDate: day, dailySlot: slot }),
      ),
    );

    const user = player('selective');
    await autoTournamentService.register(String(rows[1]!._id), user);

    const { tournaments } = await autoTournamentService.listDay(day, user.id);

    expect(tournaments).toHaveLength(3);
    expect(tournaments.map((row) => row.viewer.isRegistered)).toEqual([
      false,
      true,
      false,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Check-in, bot fill and seeding
// ---------------------------------------------------------------------------

/**
 * A tournament with `humans` people in it, sealed and counting down.
 *
 * Registers them, then forces whichever door they have not already gone
 * through: a roster that reached `minPlayers` sealed itself on the last
 * registration, and a short one is pushed through the bot-fill deadline.
 */
async function tournamentAtCountdown(humans: number) {
  const id = String((await makeTournament())._id);

  const players: string[] = [];
  for (let i = 0; i < humans; i++) players.push(await registerPlayer(id, `p${i}`));

  // Confirm everybody and seal the window, which is what the last ten minutes
  // before a daily tournament actually do. With check-in off the confirmation
  // is a no-op, because joining already was one — so this fixture builds the
  // same state under either configuration.
  await AutoTournament.updateOne(
    { _id: id },
    { $set: { status: AUTO_TOURNAMENT_STATUS.checkIn } },
  );

  for (const player of players) await autoTournamentService.checkIn(id, player);

  // The lifecycle service directly rather than a whole tick. A tick would also
  // publish two days of tournaments and sweep every deadline in the world,
  // which is a lot of database work to arrange one fixture — and the tests
  // that care about the scheduler *choosing* a transition drive it through
  // `runOnce` themselves.
  await tournamentLifecycleService.topUpWithBots(await reload(id));

  return { id, players };
}

/** Closes the last window and draws the bracket. */
async function finishCountdown(id: string): Promise<void> {
  await tournamentLifecycleService.closeCheckIn(await reload(id));
}

/** The schedule the planner would build for a slot, under the current config. */
async function withPlannerSchedule() {
  return tournamentDailyPlanner.scheduleFor(nextDay(), DAILY_SLOT.evening);
}

/**
 * The fast-start path, under the configuration that has one.
 *
 * A deployment with check-in off runs tournaments back to back: the roster
 * seals on a bot-fill timer or on reaching `minPlayers`, and a fifteen-second
 * countdown runs before the bracket. None of that is reached by a daily
 * tournament, which seals at check-in and starts at its published time — so
 * the flag is flipped for this block and put back afterwards.
 */
describe('the fast start', () => {
  const configuration = env.tournament as { checkInEnabled: boolean };
  let wasEnabled = true;

  beforeAll(() => {
    wasEnabled = configuration.checkInEnabled;
    configuration.checkInEnabled = false;
  });

  afterAll(() => {
    configuration.checkInEnabled = wasEnabled;
  });

  it('cancels a tournament nobody joined', async () => {
    const tournament = await makeTournament();

    await tournamentLifecycleService.closeRegistration(tournament);

    const after = await reload(String(tournament._id));
    expect(after.status).toBe(AUTO_TOURNAMENT_STATUS.cancelled);
    expect(after.cancelReason).toMatch(/nobody joined/i);
  });

  it('starts the countdown the moment enough people are in', async () => {
    const tournament = await makeTournament();
    const id = String(tournament._id);

    // One short of the minimum: still open, still waiting.
    for (let i = 0; i < tournament.minPlayers - 1; i++) {
      await registerPlayer(id, `early${i}`);
    }
    expect((await reload(id)).status).toBe(AUTO_TOURNAMENT_STATUS.registration);

    // The one that completes the roster seals it, without a tick.
    await registerPlayer(id, 'last');

    const sealed = await reload(id);
    expect(sealed.status).toBe(AUTO_TOURNAMENT_STATUS.starting);
    expect(sealed.countdownEndsAt).toBeTruthy();
    expect(sealed.countdownEndsAt!.getTime()).toBeGreaterThan(Date.now());
    // Nobody was made up to the minimum, because nobody needed to be.
    expect(sealed.botPlayerCount).toBe(0);
  });

  it('refuses a registration once the roster has sealed', async () => {
    const id = String((await makeTournament({ minPlayers: 2, maxPlayers: 2 }))._id);

    await registerPlayer(id, 'one');
    await registerPlayer(id, 'two');

    expect((await reload(id)).status).toBe(AUTO_TOURNAMENT_STATUS.starting);
    await expect(registerPlayer(id, 'three')).rejects.toThrow(/closed/i);
  });

  /**
   * The rule the whole feature is built around: bots make a tournament
   * *playable*, never a tournament on their own.
   */
  it('never fills an empty tournament with bots', async () => {
    const id = String((await makeTournament())._id);

    // The fill deadline passes with nobody waiting.
    await expire(id, 'botFillAt');
    await tournamentScheduler.runOnce();

    const after = await reload(id);
    expect(after.botPlayerCount).toBe(0);
    // Still open: the rest of the window is somebody's chance to arrive.
    expect(after.status).toBe(AUTO_TOURNAMENT_STATUS.registration);

    // And when the window does close with nobody in it, it is cancelled.
    await expire(id, 'registrationCloseAt');
    await tournamentScheduler.runOnce();

    expect((await reload(id)).status).toBe(AUTO_TOURNAMENT_STATUS.cancelled);
    expect(await TournamentMatch.countDocuments({ tournamentId: id })).toBe(0);
  });

  it('fills one human up to four with three bots and counts down', async () => {
    const id = String((await makeTournament())._id);
    await registerPlayer(id, 'lonely');

    // Forty-five seconds pass.
    await expire(id, 'botFillAt');
    await tournamentScheduler.runOnce();

    const counting = await reload(id);
    expect(counting.status).toBe(AUTO_TOURNAMENT_STATUS.starting);
    expect(counting.humanPlayerCount).toBe(1);
    expect(counting.botPlayerCount).toBe(3);

    // Fifteen more, and the bracket exists. The countdown is the fast-start
    // path's own door into the bracket; the daily path goes through check-in.
    await tournamentLifecycleService.startCountedDownTournament(await reload(id));

    const after = await reload(id);
    expect(after.status).toBe(AUTO_TOURNAMENT_STATUS.running);
    expect(after.totalRounds).toBe(2);
    expect(after.countdownEndsAt).toBeNull();

    const bots = await TournamentRegistration.countDocuments({
      tournamentId: id,
      playerType: PLAYER_TYPE.aiBot,
    });
    expect(bots).toBe(3);

    // Two first-round matches, four seats.
    const firstRound = await TournamentMatch.find({ tournamentId: id, roundNumber: 1 })
      .lean()
      .exec();
    expect(firstRound).toHaveLength(2);
    expect(firstRound.every((match) => match.slotA && match.slotB)).toBe(true);
  });

  it('adds no bots when four people joined', async () => {
    const { id } = await tournamentAtCountdown(4);
    await finishCountdown(id);

    const after = await reload(id);
    expect(after.humanPlayerCount).toBe(4);
    expect(after.botPlayerCount).toBe(0);
    expect(after.status).toBe(AUTO_TOURNAMENT_STATUS.running);
  });

  it('tops two people up to four rather than pairing them alone', async () => {
    const { id } = await tournamentAtCountdown(2);

    const after = await reload(id);
    expect(after.humanPlayerCount).toBe(2);
    expect(after.botPlayerCount).toBe(2);
  });

  /**
   * The fill delay is measured from when registration opened, not from the
   * row being written.
   *
   * With check-in off, the planner puts `botFillAt` a fixed delay after the
   * window opens, so "bots take the empty seats forty-five seconds after you
   * could first join" is true by construction rather than approximately.
   */
  it('schedules the bot fill inside the registration window', async () => {
    const schedule = await withPlannerSchedule();

    const opened = schedule.registrationOpenAt.getTime();

    expect(schedule.botFillAt.getTime() - opened).toBe(env.tournament.botFillDelayMs);
    expect(schedule.botFillAt.getTime()).toBeLessThan(
      schedule.registrationCloseAt.getTime(),
    );
  });

  it('runs a short countdown once the seats are filled', async () => {
    const id = String((await makeTournament())._id);

    await registerPlayer(id, 'first');
    await expire(id, 'botFillAt');
    await tournamentScheduler.runOnce();

    const counting = await reload(id);
    expect(counting.status).toBe(AUTO_TOURNAMENT_STATUS.starting);

    const countdownMs = counting.countdownEndsAt!.getTime() - Date.now();
    expect(countdownMs).toBeGreaterThan(0);
    expect(countdownMs).toBeLessThanOrEqual(env.tournament.startCountdownMs);
  });

  it('seals the roster once the countdown starts', async () => {
    const { id } = await tournamentAtCountdown(1);

    await expect(registerPlayer(id, 'latecomer')).rejects.toThrow(/closed/i);

    const after = await reload(id);
    expect(after.humanPlayerCount).toBe(1);
  });

  it('starts a tournament somebody joined in the last seconds of the window', async () => {
    const id = String((await makeTournament())._id);

    // Past the fill deadline with nobody in it, then somebody arrives.
    await expire(id, 'botFillAt');
    await tournamentScheduler.runOnce();
    await registerPlayer(id, 'lastsecond');

    await expire(id, 'registrationCloseAt');
    await tournamentScheduler.runOnce();

    const after = await reload(id);
    expect(after.status).toBe(AUTO_TOURNAMENT_STATUS.starting);
    expect(after.humanPlayerCount).toBe(1);
    expect(after.botPlayerCount).toBe(3);
  });

  it('advertises the deadline it is actually counting down to', async () => {
    const id = String((await makeTournament())._id);

    const open = await autoTournamentService.get(id, null);
    expect(open.phaseEndsAtMs).toBe(open.botFillAtMs);
    expect(open.countdownEndsAtMs).toBeNull();

    await registerPlayer(id, 'watcher');
    await expire(id, 'botFillAt');
    await tournamentScheduler.runOnce();

    const counting = await autoTournamentService.get(id, null);
    expect(counting.phaseEndsAtMs).toBe(counting.countdownEndsAtMs);
    expect(counting.countdownEndsAtMs).toBeGreaterThan(Date.now());
    // The live counts a lobby renders beside the clock.
    expect(counting.humanPlayerCount).toBe(1);
    expect(counting.botPlayerCount).toBe(3);
    expect(counting.totalPlayers).toBe(4);
  });

  it('refuses a duplicate bot registration at the index', async () => {
    // Deliberately a tournament that has *not* filled yet, so the bot this
    // inserts twice is not one the fill has already seated.
    const id = String((await makeTournament())._id);

    const insert = () =>
      TournamentRegistration.create({
        tournamentId: id,
        botId: 'scribbler',
        displayName: 'Scribbler',
        playerType: PLAYER_TYPE.aiBot,
        isBot: true,
        status: REGISTRATION_STATUS.checkedIn,
      });

    await insert();
    await expect(insert()).rejects.toMatchObject({ code: 11000 });
  });
});

// ---------------------------------------------------------------------------
// Bracket shape and advancement
// ---------------------------------------------------------------------------

/**
 * Seeds a bracket from `count` synthetic participants.
 *
 * The tournament row is created too, even though the bracket service never
 * reads it: the *read* paths do, and a bracket belonging to no tournament is a
 * state the system cannot actually reach.
 */
async function seedBracket(count: number) {
  const tournamentId = new mongoose.Types.ObjectId().toString();

  await AutoTournament.create({
    _id: tournamentId,
    tournamentDate: nextDay(),
    dailySlot: DAILY_SLOT.morning,
    slotNumber: DAILY_SLOT_ORDER[DAILY_SLOT.morning],
    name: `Bracket Cup ${count}`,
    status: AUTO_TOURNAMENT_STATUS.running,
    currentRound: 1,
    registrationOpenAt: new Date(),
    registrationCloseAt: new Date(),
    checkInOpenAt: new Date(),
    checkInCloseAt: new Date(),
    startAt: new Date(),
  });

  const participants = [];
  for (let i = 0; i < count; i++) {
    participants.push(
      await TournamentRegistration.create({
        tournamentId,
        userId: userId(),
        displayName: `p${i}`,
        playerType: PLAYER_TYPE.human,
        isBot: false,
        status: REGISTRATION_STATUS.checkedIn,
        joinedAt: new Date(Date.now() + i),
      }),
    );
  }

  const result = await tournamentBracketService.generate({
    tournamentId,
    participants: participants as never,
  });

  return { tournamentId, participants, ...result };
}

describe('drawing the bracket', () => {
  it('sizes four players into two rounds', async () => {
    const { tournamentId, totalRounds } = await seedBracket(4);

    expect(totalRounds).toBe(2);
    expect(await TournamentMatch.countDocuments({ tournamentId })).toBe(3);
    expect(await TournamentRound.countDocuments({ tournamentId })).toBe(2);
  });

  it('names the last round the final', async () => {
    const { tournamentId } = await seedBracket(8);

    const rounds = await TournamentRound.find({ tournamentId })
      .sort({ roundNumber: 1 })
      .lean()
      .exec();

    expect(rounds.map((round) => round.name)).toEqual([
      'Quarter-final',
      'Semi-final',
      'Final',
    ]);
  });

  it('gives the top seeds the byes in an odd field', async () => {
    const { tournamentId } = await seedBracket(5);

    // Five players fits an eight-bracket: three byes.
    await tournamentBracketService.resolveByes(tournamentId);

    const byes = await TournamentMatch.find({
      tournamentId,
      outcome: MATCH_OUTCOME.bye,
    })
      .lean()
      .exec();

    expect(byes).toHaveLength(3);

    // Every bye's winner is a seed in the top half of the draw.
    const winners = await TournamentRegistration.find({
      _id: { $in: byes.map((match) => match.winnerRegistrationId) },
    })
      .lean()
      .exec();

    for (const winner of winners) expect(winner.seed).toBeLessThanOrEqual(3);
  });

  it('seeds everybody exactly once', async () => {
    const { tournamentId, participants } = await seedBracket(6);

    const seeded = await TournamentRegistration.find({ tournamentId }).lean().exec();
    const seeds = seeded.map((row) => row.seed);

    expect(seeds).toHaveLength(participants.length);
    expect(new Set(seeds).size).toBe(participants.length);
  });

  /**
   * Two schedulers reaching check-in close together. The unique index on the
   * bracket position means the second insert collides on every row rather than
   * producing a second bracket beside the first.
   */
  it('produces one bracket when seeded twice', async () => {
    const tournamentId = new mongoose.Types.ObjectId().toString();

    const participants = [];
    for (let i = 0; i < 4; i++) {
      participants.push(
        await TournamentRegistration.create({
          tournamentId,
          userId: userId(),
          displayName: `p${i}`,
          playerType: PLAYER_TYPE.human,
          isBot: false,
          status: REGISTRATION_STATUS.checkedIn,
          joinedAt: new Date(Date.now() + i),
        }),
      );
    }

    await Promise.all([
      tournamentBracketService.generate({ tournamentId, participants: participants as never }),
      tournamentBracketService.generate({ tournamentId, participants: participants as never }),
    ]);

    expect(await TournamentMatch.countDocuments({ tournamentId })).toBe(3);
    expect(await TournamentRound.countDocuments({ tournamentId })).toBe(2);
  });

  it('refuses to draw anything for fewer than two players', async () => {
    const { totalRounds } = await seedBracket(1);
    expect(totalRounds).toBe(0);
  });
});

describe('advancing a winner', () => {
  it('puts the winner into the next round and eliminates the loser', async () => {
    const { tournamentId } = await seedBracket(4);

    const match = (await TournamentMatch.findOne({ tournamentId, roundNumber: 1, matchNumber: 1 })
      .lean()
      .exec())!;

    await tournamentMatchService.completeMatch({
      matchId: String(match._id),
      winnerRegistrationId: String(match.slotA),
      loserRegistrationId: String(match.slotB),
      outcome: MATCH_OUTCOME.played,
      scoreA: 120,
      scoreB: 80,
    });

    const final = (await TournamentMatch.findOne({ tournamentId, roundNumber: 2 })
      .lean()
      .exec())!;
    expect(String(final.slotA)).toBe(String(match.slotA));

    const loser = await TournamentRegistration.findById(match.slotB).lean().exec();
    expect(loser?.status).toBe(REGISTRATION_STATUS.eliminated);
    expect(loser?.eliminatedInRound).toBe(1);
  });

  it('completes a match exactly once, however many times it is reported', async () => {
    const { tournamentId } = await seedBracket(4);

    const match = (await TournamentMatch.findOne({ tournamentId, roundNumber: 1, matchNumber: 1 })
      .lean()
      .exec())!;

    const report = () =>
      tournamentMatchService.completeMatch({
        matchId: String(match._id),
        winnerRegistrationId: String(match.slotA),
        loserRegistrationId: String(match.slotB),
        outcome: MATCH_OUTCOME.played,
        scoreA: 120,
        scoreB: 80,
      });

    const [first, second, third] = await Promise.all([report(), report(), report()]);

    expect([first, second, third].filter(Boolean)).toHaveLength(1);
  });

  /**
   * The specific failure a naive advance would produce: the second report
   * overwrites the slot the first winner is already in, and a player who won
   * their match vanishes from the bracket.
   */
  it('never overwrites a next-round slot that is already filled', async () => {
    const { tournamentId } = await seedBracket(4);

    const [one, two] = await TournamentMatch.find({ tournamentId, roundNumber: 1 })
      .sort({ matchNumber: 1 })
      .lean()
      .exec();

    await tournamentMatchService.completeMatch({
      matchId: String(one!._id),
      winnerRegistrationId: String(one!.slotA),
      loserRegistrationId: String(one!.slotB),
      outcome: MATCH_OUTCOME.played,
      scoreA: 1,
      scoreB: 0,
    });
    await tournamentMatchService.completeMatch({
      matchId: String(two!._id),
      winnerRegistrationId: String(two!.slotA),
      loserRegistrationId: String(two!.slotB),
      outcome: MATCH_OUTCOME.played,
      scoreA: 1,
      scoreB: 0,
    });

    const final = (await TournamentMatch.findOne({ tournamentId, roundNumber: 2 })
      .lean()
      .exec())!;

    expect(String(final.slotA)).toBe(String(one!.slotA));
    expect(String(final.slotB)).toBe(String(two!.slotA));
  });
});

describe('finishing a tournament', () => {
  it('records the winner as a snapshot and leaves the day alone', async () => {
    const { id, players } = await tournamentAtCountdown(1);
    await finishCountdown(id);

    // Play the whole thing out, deciding every match for its first slot.
    for (let round = 1; round <= 2; round++) {
      const matches = await TournamentMatch.find({
        tournamentId: id,
        roundNumber: round,
        status: { $nin: [MATCH_STATUS.completed, MATCH_STATUS.cancelled] },
      })
        .lean()
        .exec();

      for (const match of matches) {
        await tournamentMatchService.completeMatch({
          matchId: String(match._id),
          winnerRegistrationId: String(match.slotA),
          loserRegistrationId: match.slotB ? String(match.slotB) : null,
          outcome: MATCH_OUTCOME.played,
          scoreA: 100,
          scoreB: 50,
        });
      }

      await tournamentMatchService.progressRounds(id);
    }

    const after = (await AutoTournament.findById(id).lean().exec())!;
    expect(after.status).toBe(AUTO_TOURNAMENT_STATUS.completed);
    expect(after.winnerRegistrationId).not.toBeNull();
    expect(after.completedAt).toBeTruthy();

    const winner = await TournamentRegistration.findById(after.winnerRegistrationId)
      .lean()
      .exec();
    expect(winner?.status).toBe(REGISTRATION_STATUS.winner);

    // The name is copied onto the tournament, not left to a join.
    expect(after.winnerDisplayName).toBe(winner?.displayName);
    expect(String(after.winnerUserId ?? '')).toBe(String(winner?.userId ?? ''));
    expect(after.winnerIsBot).toBe(Boolean(winner?.isBot));

    // And the whole placement table with it.
    expect(after.finalRankings.length).toBeGreaterThan(0);
    expect(after.finalRankings[0]?.placement).toBe(1);
    expect(String(after.finalRankings[0]?.registrationId)).toBe(
      String(after.winnerRegistrationId),
    );

    // Nothing replaced it. The day still has exactly the tournaments it had.
    expect(
      await AutoTournament.countDocuments({ tournamentDate: after.tournamentDate }),
    ).toBe(1);
  });

  /**
   * The snapshot is what makes a result a record.
   *
   * A player renaming themselves must not retroactively rewrite a tournament
   * they won last week, which a card that re-read the profile would do.
   */
  it('keeps the winner name it was won under after a rename', async () => {
    const { id } = await tournamentAtCountdown(1);
    await finishCountdown(id);

    for (let round = 1; round <= 2; round++) {
      const matches = await TournamentMatch.find({
        tournamentId: id,
        roundNumber: round,
        status: { $nin: [MATCH_STATUS.completed, MATCH_STATUS.cancelled] },
      })
        .lean()
        .exec();

      for (const match of matches) {
        await tournamentMatchService.completeMatch({
          matchId: String(match._id),
          winnerRegistrationId: String(match.slotA),
          loserRegistrationId: match.slotB ? String(match.slotB) : null,
          outcome: MATCH_OUTCOME.played,
          scoreA: 100,
          scoreB: 50,
        });
      }

      await tournamentMatchService.progressRounds(id);
    }

    const finished = await reload(id);
    const wonAs = finished.winnerDisplayName;
    expect(wonAs).toBeTruthy();

    // They rename themselves afterwards.
    await TournamentRegistration.updateOne(
      { _id: finished.winnerRegistrationId },
      { $set: { displayName: 'somebody else entirely' } },
    );

    const dto = await autoTournamentService.get(id, null);
    expect(dto.winner?.displayName).toBe(wonAs);
  });

  /**
   * A result landing twice must not produce two winners — which is what a
   * read-then-write close would do under a retry or a duplicate report.
   */
  it('completes a tournament exactly once', async () => {
    const { id } = await tournamentAtCountdown(1);
    await finishCountdown(id);

    for (let round = 1; round <= 2; round++) {
      const matches = await TournamentMatch.find({
        tournamentId: id,
        roundNumber: round,
        status: { $nin: [MATCH_STATUS.completed, MATCH_STATUS.cancelled] },
      })
        .lean()
        .exec();

      for (const match of matches) {
        await tournamentMatchService.completeMatch({
          matchId: String(match._id),
          winnerRegistrationId: String(match.slotA),
          loserRegistrationId: match.slotB ? String(match.slotB) : null,
          outcome: MATCH_OUTCOME.played,
          scoreA: 100,
          scoreB: 50,
        });
      }

      await tournamentMatchService.progressRounds(id);
    }

    const first = await reload(id);

    // The same result reported again, and the round swept again.
    await tournamentMatchService.progressRounds(id);
    await tournamentMatchService.progressRounds(id);

    const second = await reload(id);

    expect(String(second.winnerRegistrationId)).toBe(String(first.winnerRegistrationId));
    expect(second.completedAt?.getTime()).toBe(first.completedAt?.getTime());
    expect(
      await TournamentRegistration.countDocuments({
        tournamentId: id,
        status: REGISTRATION_STATUS.winner,
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('what a client is shown', () => {
  it('returns an empty day rather than an error when nothing is scheduled', async () => {
    const day = await autoTournamentService.listDay('2020-01-01', null);

    expect(day.tournamentDate).toBe('2020-01-01');
    expect(day.tournaments).toEqual([]);
    expect(day.timeZone).toBe(env.tournament.timeZone);
  });

  it('returns the day in the order the tournaments happen', async () => {
    const day = nextDay();

    // Created out of order on purpose: the listing must sort, not echo.
    await makeTournament({ tournamentDate: day, dailySlot: DAILY_SLOT.evening });
    await makeTournament({ tournamentDate: day, dailySlot: DAILY_SLOT.morning });
    await makeTournament({ tournamentDate: day, dailySlot: DAILY_SLOT.afternoon });

    const listed = await autoTournamentService.listDay(day, null);

    expect(listed.tournaments.map((row) => row.dailySlot)).toEqual([
      'MORNING',
      'AFTERNOON',
      'EVENING',
    ]);
  });

  it('reports humans and bots separately', async () => {
    const { id, players } = await tournamentAtCountdown(1);
    await finishCountdown(id);

    const dto = await autoTournamentService.get(id, players[0]!);

    expect(dto.humanPlayerCount).toBe(1);
    expect(dto.botPlayerCount).toBe(3);
    expect(dto.totalPlayers).toBe(4);
  });

  it('flags every AI entrant as a bot and nobody else', async () => {
    const { id, players } = await tournamentAtCountdown(1);
    await finishCountdown(id);

    const roster = await autoTournamentService.participants(id, players[0]!);

    expect(roster.filter((entry) => entry.isBot)).toHaveLength(3);
    expect(roster.filter((entry) => entry.isBot).every((entry) => entry.botDifficulty)).toBe(
      true,
    );
    // The one person is marked as the reader, and no bot ever is.
    expect(roster.filter((entry) => entry.isSelf)).toHaveLength(1);
    expect(roster.some((entry) => entry.isBot && entry.isSelf)).toBe(false);
  });

  it('hides a match room code from everybody but its two players', async () => {
    const { tournamentId } = await seedBracket(4);

    await TournamentMatch.updateMany(
      { tournamentId, roundNumber: 1 },
      { $set: { status: MATCH_STATUS.ready, roomCode: 'AB12C' } },
    );

    const outsider = await autoTournamentService.bracket(tournamentId, userId());
    const codes = outsider.rounds.flatMap((round) =>
      round.matches.map((match) => match.roomCode),
    );

    expect(codes.every((code) => code === null)).toBe(true);
  });

  it('shows the code to a player who is in that match', async () => {
    const { tournamentId, participants } = await seedBracket(4);

    await TournamentMatch.updateMany(
      { tournamentId, roundNumber: 1 },
      { $set: { status: MATCH_STATUS.ready, roomCode: 'AB12C' } },
    );

    const seat = participants[0]!;
    const bracket = await autoTournamentService.bracket(tournamentId, String(seat.userId));

    const mine = bracket.rounds
      .flatMap((round) => round.matches)
      .filter((match) => match.roomCode !== null);

    expect(mine).toHaveLength(1);
    expect(mine[0]?.roomCode).toBe('AB12C');
  });

  it('refuses to hand a match code to somebody not in the match', async () => {
    const { tournamentId } = await seedBracket(4);

    const match = (await TournamentMatch.findOne({ tournamentId, roundNumber: 1 })
      .lean()
      .exec())!;
    await TournamentMatch.updateOne(
      { _id: match._id },
      { $set: { status: MATCH_STATUS.ready, roomId: new mongoose.Types.ObjectId(), roomCode: 'AB12C' } },
    );

    await expect(
      tournamentMatchService.enter({
        tournamentId,
        matchId: String(match._id),
        userId: userId(),
      }),
    ).rejects.toThrow(/does not exist/i);
  });

  it('ranks the results table by how far each player got', async () => {
    const { tournamentId } = await seedBracket(4);

    const [one] = await TournamentMatch.find({ tournamentId, roundNumber: 1 })
      .sort({ matchNumber: 1 })
      .lean()
      .exec();

    await tournamentMatchService.completeMatch({
      matchId: String(one!._id),
      winnerRegistrationId: String(one!.slotA),
      loserRegistrationId: String(one!.slotB),
      outcome: MATCH_OUTCOME.played,
      scoreA: 1,
      scoreB: 0,
    });

    const board = await autoTournamentService.leaderboard(tournamentId, null);

    // The eliminated player is last; everybody still alive is above them.
    expect(board.items[board.items.length - 1]?.status).toBe(
      REGISTRATION_STATUS.eliminated,
    );
    expect(board.items[0]?.placement).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A player who drops out of a bracket match
// ---------------------------------------------------------------------------

/**
 * Taking over an abandoned seat.
 *
 * ## What is worth asserting here
 *
 * Not "does a bot appear" — that is the easy half. The half that matters is
 * that the bot **cannot win the bracket**: it plays the match properly, its
 * score is recorded, and the round still goes to the player who stayed. A
 * stand-in that could advance would mean somebody knocked out of a tournament
 * by a robot substituting for their opponent, which is worse than the walkover
 * this replaced.
 */
describe('replacing a disconnected player', () => {
  /** A one-match bracket with two humans, and the room binding for it. */
  async function matchInProgress() {
    const { tournamentId, participants } = await seedBracket(2);

    const match = (await TournamentMatch.findOne({ tournamentId, roundNumber: 1 })
      .lean()
      .exec())!;

    const leaver = participants[0]!;
    const stayer = participants[1]!;

    const room = makeRoom({
      roomId: 'bracket-room',
      tournament: {
        tournamentId,
        matchId: String(match._id),
        roundNumber: 1,
        matchNumber: 1,
        registrationIdByPlayerId: {
          [String(leaver.userId)]: String(leaver._id),
          [String(stayer.userId)]: String(stayer._id),
        },
      },
    });

    return { tournamentId, match, leaver, stayer, room };
  }

  it('seats a bot in the empty chair and marks the seat forfeited', async () => {
    const { match, leaver, room } = await matchInProgress();
    const seated: { playerId: string; botId: string }[] = [];

    const replaced = await tournamentStandInService.replace({
      room,
      userId: String(leaver.userId),
      username: 'quitter',
      seatBot: (_target, bot) => seated.push({ playerId: bot.playerId, botId: bot.botId }),
    });

    expect(replaced).toBe(true);
    // The same seat id, so every map already pointing at it still resolves.
    expect(seated).toHaveLength(1);
    expect(seated[0]!.playerId).toBe(String(leaver.userId));

    const after = (await TournamentMatch.findById(match._id).lean().exec())!;
    expect(String(after.forfeitedRegistrationId)).toBe(String(leaver._id));
  });

  it('eliminates the player who left, with a reason that is not "lost"', async () => {
    const { leaver, room } = await matchInProgress();

    await tournamentStandInService.replace({
      room,
      userId: String(leaver.userId),
      username: 'quitter',
      seatBot: () => undefined,
    });

    const row = (await TournamentRegistration.findById(leaver._id).lean().exec())!;
    expect(row.status).toBe(REGISTRATION_STATUS.eliminated);
    expect(row.eliminatedReason).toBe('disconnected');
  });

  /** The rule the whole design turns on. */
  it('hands the match to the player who stayed, whatever the bot scores', async () => {
    const { match, leaver, stayer, room } = await matchInProgress();

    await tournamentStandInService.replace({
      room,
      userId: String(leaver.userId),
      username: 'quitter',
      seatBot: () => undefined,
    });

    const verdict = await tournamentStandInService.winnerByForfeit(String(match._id));

    expect(verdict).not.toBeNull();
    expect(verdict!.winnerRegistrationId).toBe(String(stayer._id));
    expect(verdict!.loserRegistrationId).toBe(String(leaver._id));
  });

  it('reports no forfeit on an ordinary match', async () => {
    const { match } = await matchInProgress();

    expect(await tournamentStandInService.winnerByForfeit(String(match._id))).toBeNull();
  });

  it('takes over a seat only once', async () => {
    const { leaver, room } = await matchInProgress();

    const attempt = () =>
      tournamentStandInService.replace({
        room,
        userId: String(leaver.userId),
        username: 'quitter',
        seatBot: () => undefined,
      });

    expect(await attempt()).toBe(true);
    // A second grace timer, or a restart mid-takeover. One stand-in per seat.
    expect(await attempt()).toBe(false);
  });

  it('leaves a decided match alone', async () => {
    const { match, leaver, room } = await matchInProgress();

    await TournamentMatch.updateOne(
      { _id: match._id },
      { $set: { completedAt: new Date(), status: MATCH_STATUS.completed } },
    );

    expect(
      await tournamentStandInService.replace({
        room,
        userId: String(leaver.userId),
        username: 'quitter',
        seatBot: () => undefined,
      }),
    ).toBe(false);
  });

  it('does nothing where bots are not allowed', async () => {
    const { tournamentId, leaver, room } = await matchInProgress();

    await AutoTournament.updateOne({ _id: tournamentId }, { $set: { allowBots: false } });

    expect(
      await tournamentStandInService.replace({
        room,
        userId: String(leaver.userId),
        username: 'quitter',
        seatBot: () => undefined,
      }),
    ).toBe(false);
  });

  it('does nothing in an ordinary room', async () => {
    const room = makeRoom({ roomId: 'casual' });

    expect(
      await tournamentStandInService.replace({
        room,
        userId: 'somebody',
        username: 'somebody',
        seatBot: () => undefined,
      }),
    ).toBe(false);
  });

  it('gives a bracket match a much shorter reconnect grace than a casual room', () => {
    expect(TIMING.tournamentReconnectGraceMs).toBe(15_000);
    expect(TIMING.tournamentReconnectGraceMs).toBeLessThan(TIMING.reconnectGraceMs);
  });
});
