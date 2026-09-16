import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Three tournaments a day, and the rules that keep it three.
 *
 * ## Why this file is separate from `autoTournament.test.ts`
 *
 * That one is about what happens *inside* a tournament — the bracket, the
 * matches, the bots, the results table — and builds its tournaments by hand
 * because the scheduling is not what it is asking about. This one is about the
 * scheduling itself: which tournaments exist, when, under what names, and what
 * happens when two schedulers, a restart and a retry all arrive at once.
 *
 * ## Why it needs a real database
 *
 * Because the product rule *is* an index. "Never a fourth tournament in a day"
 * is `unique: {tournamentDate, dailySlot, isAutomatic}`, and the only way to
 * demonstrate it is to try the fourth write against a database that has the
 * index built. A mock would assert that the code called the query it was
 * written to call, which was never in doubt.
 *
 * ## Why the clock is passed in rather than faked
 *
 * Every method that needs to know the time takes it as an argument. Freezing
 * the global clock would also freeze it for the driver underneath, and the
 * tests read better for saying which moment they mean: "at half past six on
 * the morning of the fifth" is the fixture, not a side effect of when the
 * suite happens to run.
 */

let mongo: MongoMemoryServer;

vi.mock('@/config/database', async () => ({
  connectToDatabase: async () => mongoose,
  disconnectFromDatabase: async () => undefined,
  watchDatabaseEvents: () => undefined,
}));

const {
  AUTO_TOURNAMENT_STATUS,
  DAILY_SLOT,
  DAILY_SLOTS,
  REGISTRATION_STATUS,
  TOURNAMENTS_PER_DAY,
  TOURNAMENT_NAME_POOL,
} = await import('@/constants/autoTournament.constants');
const { AutoTournament, TournamentRegistration } = await import('@/models/AutoTournament');
const { TournamentMatch, TournamentRound } = await import('@/models/TournamentMatch');
const { TournamentBotProfile, TournamentSchedulerLock } = await import(
  '@/models/TournamentBotProfile'
);
const { tournamentDailyPlanner } = await import('@/services/tournament/dailyPlanner.service');
const { tournamentNameService } = await import('@/services/tournament/name.service');
const { tournamentLifecycleService } = await import('@/services/tournament/lifecycle.service');
const { tournamentScheduler } = await import('@/services/tournament/scheduler.service');
const { autoTournamentService } = await import('@/services/tournament/auto.service');
const { env } = await import('@/config/env');
const { addDays, dayKeyOf, dayIndexOf, todayKey, zonedInstant } = await import(
  '@/utils/dayKey'
);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'daily_tournament_test' });

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
});

/**
 * A moment on a day, in the configured zone.
 *
 * `atIst('2026-03-05', 6, 30)` is half past six that morning where the
 * tournaments happen — before the 10:00 slot, so all three of the day's
 * windows are still ahead.
 */
function at(day: string, hour: number, minute = 0): Date {
  return zonedInstant(day, hour * 60 + minute, env.tournament.timeZone);
}

/** A fresh user id. Real users are not needed: only the id is ever stored. */
function userId(): string {
  return new mongoose.Types.ObjectId().toString();
}

/** Registers somebody, as the API would. */
async function join(tournamentId: string, name: string): Promise<string> {
  const id = userId();

  await autoTournamentService.register(tournamentId, {
    id,
    username: name,
    avatarId: 1,
    avatarColorIndex: 2,
  } as Parameters<typeof autoTournamentService.register>[1]);

  return id;
}

const DAY = '2026-03-05';
/** Early on `DAY`, before any of its three slots. */
const EARLY = at(DAY, 6, 30);

// ---------------------------------------------------------------------------
// Three a day
// ---------------------------------------------------------------------------

describe('three tournaments a day, and never four', () => {
  it('publishes exactly three for a day', async () => {
    const created = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    expect(created).toHaveLength(TOURNAMENTS_PER_DAY);
    expect(created.map((row) => row.dailySlot)).toEqual([
      DAILY_SLOT.morning,
      DAILY_SLOT.afternoon,
      DAILY_SLOT.evening,
    ]);
    expect(await AutoTournament.countDocuments({ tournamentDate: DAY })).toBe(3);
  });

  it('creates nothing on a second pass over the same day', async () => {
    await tournamentDailyPlanner.ensureDay(DAY, EARLY);
    const again = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    expect(again).toHaveLength(0);
    expect(await AutoTournament.countDocuments({ tournamentDate: DAY })).toBe(3);
  });

  /**
   * The race the whole design exists for. Two instances scanning at the same
   * instant both find the day empty; the unique index decides, not the scan.
   */
  it('never produces a fourth when several schedulers run at once', async () => {
    await Promise.all([
      tournamentDailyPlanner.ensureDay(DAY, EARLY),
      tournamentDailyPlanner.ensureDay(DAY, EARLY),
      tournamentDailyPlanner.ensureDay(DAY, EARLY),
      tournamentDailyPlanner.ensureDay(DAY, EARLY),
    ]);

    expect(await AutoTournament.countDocuments({ tournamentDate: DAY })).toBe(3);
  });

  it('refuses a second tournament in a slot that already has one', async () => {
    await tournamentDailyPlanner.createSlot(DAY, DAILY_SLOT.evening);
    const second = await tournamentDailyPlanner.createSlot(DAY, DAILY_SLOT.evening);

    expect(second).toBeNull();
    expect(
      await AutoTournament.countDocuments({
        tournamentDate: DAY,
        dailySlot: DAILY_SLOT.evening,
      }),
    ).toBe(1);
  });

  /**
   * The index, stated on its own.
   *
   * Everything above goes through the planner, which catches the duplicate and
   * carries on — so this is the one place that shows the write itself being
   * refused, which is where the guarantee actually lives.
   */
  it('refuses a duplicate slot at the index, whatever writes it', async () => {
    await tournamentDailyPlanner.createSlot(DAY, DAILY_SLOT.morning);

    await expect(
      AutoTournament.create({
        tournamentDate: DAY,
        dailySlot: DAILY_SLOT.morning,
        slotNumber: 1,
        name: 'A Second Morning Cup',
        registrationOpenAt: new Date(),
        registrationCloseAt: new Date(),
        checkInOpenAt: new Date(),
        checkInCloseAt: new Date(),
        startAt: new Date(),
        isAutomatic: true,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  /**
   * The constraint holds after the tournament is over, which is the difference
   * from the rolling slots this replaced. A finished morning tournament still
   * owns that morning.
   */
  it('refuses a replacement for a completed tournament', async () => {
    const [morning] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    await AutoTournament.updateOne(
      { _id: morning!._id },
      { $set: { status: AUTO_TOURNAMENT_STATUS.completed, completedAt: new Date() } },
    );

    const again = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    expect(again).toHaveLength(0);
    expect(await AutoTournament.countDocuments({ tournamentDate: DAY })).toBe(3);
  });

  /**
   * A cancelled tournament is not replaced either. Creating one would be a
   * fourth tournament on that day, and the player's next tournament is the
   * next slot — which has been on the schedule since midnight.
   */
  it('creates nothing extra when a tournament is cancelled', async () => {
    const [morning] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    await tournamentLifecycleService.cancel(morning!, 'nobody joined');

    const after = await tournamentDailyPlanner.ensureDay(DAY, EARLY);
    expect(after).toHaveLength(0);

    const rows = await AutoTournament.find({ tournamentDate: DAY }).lean().exec();
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.status === AUTO_TOURNAMENT_STATUS.cancelled)).toHaveLength(
      1,
    );
  });

  /**
   * A restart is a second pass with an empty memory, which is exactly what
   * every other pass is: nothing is carried between ticks, so recovery is not
   * a code path.
   */
  it('creates nothing extra after a restart', async () => {
    await tournamentDailyPlanner.ensureScheduled(EARLY);
    const before = await AutoTournament.countDocuments({});

    // A new process comes up and does what it always does.
    await tournamentDailyPlanner.ensureScheduled(EARLY);
    await tournamentDailyPlanner.ensureScheduled(EARLY);

    expect(await AutoTournament.countDocuments({})).toBe(before);
  });

  /**
   * A slot whose registration window has already closed is not created at all.
   * A tournament nobody could ever have joined is not worth a cancelled card.
   */
  it('skips a slot whose window has already passed', async () => {
    // Ten in the evening: the morning and afternoon are long gone, and the
    // evening tournament has already started.
    const created = await tournamentDailyPlanner.ensureDay(DAY, at(DAY, 22));

    expect(created).toHaveLength(0);
    expect(await AutoTournament.countDocuments({ tournamentDate: DAY })).toBe(0);
  });

  it('still publishes the slots that are ahead', async () => {
    // Midday: the morning has gone, the afternoon and evening have not.
    const created = await tournamentDailyPlanner.ensureDay(DAY, at(DAY, 12));

    expect(created.map((row) => row.dailySlot)).toEqual([
      DAILY_SLOT.afternoon,
      DAILY_SLOT.evening,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tomorrow
// ---------------------------------------------------------------------------

describe('preparing the next day', () => {
  it('publishes today and tomorrow', async () => {
    await tournamentDailyPlanner.ensureScheduled(EARLY);

    const today = todayKey(env.tournament.timeZone, EARLY);
    const tomorrow = addDays(today, 1);

    expect(await AutoTournament.countDocuments({ tournamentDate: today })).toBe(3);
    expect(await AutoTournament.countDocuments({ tournamentDate: tomorrow })).toBe(3);
  });

  /**
   * The point of publishing ahead: a player opening the app a minute after
   * midnight sees a schedule rather than an empty screen while a scheduler
   * catches up.
   */
  it('has tomorrow ready before midnight', async () => {
    // Late on the fifth, after the evening tournament has begun.
    const lateAt = at(DAY, 23, 50);
    await tournamentDailyPlanner.ensureScheduled(lateAt);

    const tomorrow = addDays(DAY, 1);
    const rows = await AutoTournament.find({ tournamentDate: tomorrow }).lean().exec();

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === AUTO_TOURNAMENT_STATUS.upcoming)).toBe(true);
  });

  it('never publishes further than it was told to', async () => {
    await tournamentDailyPlanner.ensureScheduled(EARLY);

    const dayAfter = addDays(todayKey(env.tournament.timeZone, EARLY), 2);
    expect(await AutoTournament.countDocuments({ tournamentDate: dayAfter })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe('naming the day tournaments', () => {
  it('gives a day three different names', async () => {
    await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    const rows = await AutoTournament.find({ tournamentDate: DAY }).lean().exec();
    const names = rows.map((row) => row.name);

    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(TOURNAMENT_NAME_POOL).toContain(name);
  });

  it('never repeats a name on consecutive days', () => {
    // A full turn of the pool and then some, so the wrap is included.
    let previous = new Set<string>();

    for (let offset = 0; offset < 60; offset++) {
      const day = addDays('2026-01-01', offset);
      const names = Object.values(tournamentNameService.namesForDay(day));

      expect(new Set(names).size).toBe(3);

      for (const name of names) expect(previous.has(name)).toBe(false);
      previous = new Set(names);
    }
  });

  it('works through the whole pool before coming back to a name', () => {
    const seen: string[] = [];

    // Twenty names, three a day: the rotation closes after twenty days.
    for (let offset = 0; offset < TOURNAMENT_NAME_POOL.length; offset++) {
      seen.push(...Object.values(tournamentNameService.namesForDay(addDays(DAY, offset))));
    }

    // Every name used, and each used exactly three times across the cycle.
    expect(new Set(seen).size).toBe(TOURNAMENT_NAME_POOL.length);
    for (const name of TOURNAMENT_NAME_POOL) {
      expect(seen.filter((entry) => entry === name)).toHaveLength(3);
    }
  });

  it('gives the same answer on every instance, for ever', () => {
    const first = tournamentNameService.namesForDay(DAY);
    const second = tournamentNameService.namesForDay(DAY);

    expect(second).toEqual(first);
  });

  it('walks past a name the day has already used', () => {
    const rotation = tournamentNameService.namesForDay(DAY);
    const wanted = rotation[DAILY_SLOT.evening];

    const given = tournamentNameService.nameFor(DAY, DAILY_SLOT.evening, [wanted]);

    expect(given).not.toBe(wanted);
    expect(TOURNAMENT_NAME_POOL).toContain(given);
  });

  /**
   * A name is chosen once and never written again, so a tournament cannot be
   * renamed under the people who joined it.
   */
  it('keeps a name after players have joined', async () => {
    const [morning] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);
    const id = String(morning!._id);
    const named = morning!.name;

    await AutoTournament.updateOne(
      { _id: id },
      { $set: { status: AUTO_TOURNAMENT_STATUS.registration } },
    );
    await join(id, 'early-bird');

    // Everything the organiser would do to it in a day.
    await tournamentDailyPlanner.ensureDay(DAY, EARLY);
    await tournamentLifecycleService.openRegistration(morning!);

    expect((await AutoTournament.findById(id).lean().exec())!.name).toBe(named);
  });

  it('never puts a winner in a name', async () => {
    const [morning] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);
    const id = String(morning!._id);

    await AutoTournament.updateOne(
      { _id: id },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.completed,
          winnerDisplayName: 'Althaf',
          completedAt: new Date(),
        },
      },
    );

    const after = (await AutoTournament.findById(id).lean().exec())!;
    expect(after.name).toBe(morning!.name);
    expect(after.name).not.toMatch(/althaf/i);
  });
});

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

describe('when a daily tournament happens', () => {
  it('starts at the configured time, in the configured zone', () => {
    const schedule = tournamentDailyPlanner.scheduleFor(DAY, DAILY_SLOT.evening);

    expect(schedule.startAt.getTime()).toBe(
      at(DAY, Math.floor(env.tournament.slotMinutes.EVENING / 60)).getTime(),
    );
    expect(dayKeyOf(schedule.startAt, env.tournament.timeZone)).toBe(DAY);
  });

  it('measures every window backwards from the start', () => {
    const schedule = tournamentDailyPlanner.scheduleFor(DAY, DAILY_SLOT.afternoon);
    const start = schedule.startAt.getTime();

    expect(start - schedule.registrationOpenAt.getTime()).toBe(
      env.tournament.registrationLeadMs,
    );
    expect(start - schedule.registrationCloseAt.getTime()).toBe(env.tournament.checkInLeadMs);
    // Check-in fills exactly the gap between them.
    expect(schedule.checkInOpenAt.getTime()).toBe(schedule.registrationCloseAt.getTime());
    expect(schedule.checkInCloseAt.getTime()).toBe(start);
  });

  it('puts the three slots in order, hours apart', () => {
    const times = DAILY_SLOTS.map((slot) =>
      tournamentDailyPlanner.scheduleFor(DAY, slot).startAt.getTime(),
    );

    expect(times[0]).toBeLessThan(times[1]!);
    expect(times[1]).toBeLessThan(times[2]!);
    // Far enough apart that one cannot run into the next.
    expect(times[1]! - times[0]!).toBeGreaterThan(env.tournament.registrationLeadMs);
  });

  it('writes the schedule onto the row rather than recomputing it', async () => {
    const [, afternoon] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);
    const expected = tournamentDailyPlanner.scheduleFor(DAY, DAILY_SLOT.afternoon);

    expect(afternoon!.startAt.getTime()).toBe(expected.startAt.getTime());
    expect(afternoon!.registrationOpenAt.getTime()).toBe(
      expected.registrationOpenAt.getTime(),
    );
  });

  /**
   * Opening registration must not move the start. A player has been looking at
   * "starts 20:00" for an hour, and the only correct thing to do with that
   * time is leave it alone.
   */
  it('does not move the start when registration opens', async () => {
    const [, , evening] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);
    const id = String(evening!._id);
    const published = evening!.startAt.getTime();

    await tournamentLifecycleService.openRegistration(evening!);

    const after = (await AutoTournament.findById(id).lean().exec())!;
    expect(after.status).toBe(AUTO_TOURNAMENT_STATUS.registration);
    expect(after.startAt.getTime()).toBe(published);
    expect(after.registrationCloseAt.getTime()).toBe(evening!.registrationCloseAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// The scheduler, over a day
// ---------------------------------------------------------------------------

describe('the scheduler over a day', () => {
  it('opens only the tournament whose window has arrived', async () => {
    await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    // Nine in the morning: the 10:00 tournament opened at 08:30, the others
    // have not.
    const rows = await AutoTournament.find({ tournamentDate: DAY }).lean().exec();
    const due = rows.filter((row) => row.registrationOpenAt <= at(DAY, 9));

    expect(due).toHaveLength(1);
    expect(due[0]?.dailySlot).toBe(DAILY_SLOT.morning);
  });

  it('leaves the rest of the day upcoming', async () => {
    await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    const rows = await AutoTournament.find({ tournamentDate: DAY }).lean().exec();
    expect(rows.every((row) => row.status === AUTO_TOURNAMENT_STATUS.upcoming)).toBe(true);
  });

  /**
   * The three lifecycles are independent. One finished tournament does not
   * hold up, hide or block the two after it.
   */
  it('runs the three tournaments as independent events', async () => {
    const [morning, afternoon, evening] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    await AutoTournament.updateOne(
      { _id: morning!._id },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.completed,
          completedAt: new Date(),
          winnerDisplayName: 'Althaf',
        },
      },
    );
    await AutoTournament.updateOne(
      { _id: afternoon!._id },
      { $set: { status: AUTO_TOURNAMENT_STATUS.registration } },
    );

    const day = await autoTournamentService.listDay(DAY, null);

    expect(day.tournaments.map((row) => row.status)).toEqual([
      'COMPLETED',
      'REGISTRATION',
      'UPCOMING',
    ]);

    // The afternoon is joinable despite the morning being over.
    expect(day.tournaments[1]?.viewer.canRegister).toBe(true);
    expect(String(evening!._id)).toBe(day.tournaments[2]?.id);
  });

  it('writes off a tournament that was never opened before its start', async () => {
    const [morning] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    // The organiser was down all morning; it comes back after the start time.
    await AutoTournament.updateOne(
      { _id: morning!._id },
      {
        $set: {
          registrationOpenAt: new Date(Date.now() - 7_200_000),
          registrationCloseAt: new Date(Date.now() - 3_600_000),
          checkInCloseAt: new Date(Date.now() - 60_000),
          startAt: new Date(Date.now() - 60_000),
        },
      },
    );

    await tournamentScheduler.runOnce();

    const after = (await AutoTournament.findById(morning!._id).lean().exec())!;
    expect(after.status).toBe(AUTO_TOURNAMENT_STATUS.cancelled);
  });
});

// ---------------------------------------------------------------------------
// The winner belongs to one tournament
// ---------------------------------------------------------------------------

describe('showing a winner', () => {
  it('shows a winner only on the tournament that was won', async () => {
    const [morning] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    await AutoTournament.updateOne(
      { _id: morning!._id },
      {
        $set: {
          status: AUTO_TOURNAMENT_STATUS.completed,
          completedAt: new Date(),
          winnerUserId: new mongoose.Types.ObjectId(),
          winnerDisplayName: 'Althaf',
          winnerAvatarId: 4,
          winnerAvatarColorIndex: 1,
          winnerIsBot: false,
        },
      },
    );

    const day = await autoTournamentService.listDay(DAY, null);

    expect(day.tournaments[0]?.winner?.displayName).toBe('Althaf');
    expect(day.tournaments[0]?.winner?.avatarId).toBe(4);
    expect(day.tournaments[0]?.completedAtMs).toBeGreaterThan(0);

    // And on neither of the others.
    expect(day.tournaments[1]?.winner).toBeNull();
    expect(day.tournaments[2]?.winner).toBeNull();
    expect(day.tournaments[1]?.completedAtMs).toBeNull();
  });

  it('shows no winner for a tournament still being played', async () => {
    const [morning] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    await AutoTournament.updateOne(
      { _id: morning!._id },
      { $set: { status: AUTO_TOURNAMENT_STATUS.running, currentRound: 2 } },
    );

    const dto = await autoTournamentService.get(String(morning!._id), null);

    // A leader is not a winner.
    expect(dto.winner).toBeNull();
    expect(dto.completedAtMs).toBeNull();
  });

  it('refuses to let anybody join a completed tournament', async () => {
    const [morning] = await tournamentDailyPlanner.ensureDay(DAY, EARLY);

    await AutoTournament.updateOne(
      { _id: morning!._id },
      { $set: { status: AUTO_TOURNAMENT_STATUS.completed, completedAt: new Date() } },
    );

    await expect(join(String(morning!._id), 'too-late')).rejects.toThrow(/finished/i);
  });
});

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

describe('a day under load', () => {
  /** The day's three, each able to hold `maxPlayers`. */
  async function threeOpen(day: string, maxPlayers: number): Promise<string[]> {
    const rows = await Promise.all(
      DAILY_SLOTS.map((slot, index) =>
        AutoTournament.create({
          tournamentDate: day,
          dailySlot: slot,
          slotNumber: index + 1,
          name: `Load Cup ${slot}`,
          status: AUTO_TOURNAMENT_STATUS.registration,
          minPlayers: 4,
          maxPlayers,
          registrationOpenAt: new Date(Date.now() - 1_000),
          registrationCloseAt: new Date(Date.now() + 3_600_000),
          checkInOpenAt: new Date(Date.now() + 3_600_000),
          checkInCloseAt: new Date(Date.now() + 7_200_000),
          startAt: new Date(Date.now() + 7_200_000),
          isAutomatic: true,
        }),
      ),
    );

    return rows.map((row) => String(row._id));
  }

  /**
   * A hundred people, arriving across the day's three tournaments.
   *
   * Sixteen is the largest bracket the seeder will draw, so three tournaments
   * seat forty-eight and the rest are turned away — and what matters is *how*:
   * every refusal says the tournament is full, none of them says anything
   * about another tournament, and nobody is refused because of where else
   * they are.
   */
  it('seats a hundred players across the three tournaments', async () => {
    const day = addDays(DAY, 3);
    const ids = await threeOpen(day, 16);

    const outcomes: ('in' | string)[] = [];

    for (let index = 0; index < 100; index++) {
      try {
        await join(ids[index % 3]!, `player${index}`);
        outcomes.push('in');
      } catch (error) {
        outcomes.push((error as { message?: string }).message ?? 'unknown');
      }
    }

    expect(outcomes.filter((entry) => entry === 'in')).toHaveLength(48);

    for (const id of ids) {
      expect(
        await TournamentRegistration.countDocuments({
          tournamentId: id,
          status: { $ne: REGISTRATION_STATUS.withdrawn },
        }),
      ).toBe(16);
    }

    // Everybody who was turned away was turned away for the one reason a full
    // tournament has — never "you are already in another tournament", which is
    // a refusal this system no longer makes.
    for (const outcome of outcomes.filter((entry) => entry !== 'in')) {
      expect(outcome).toMatch(/full/i);
      expect(outcome).not.toMatch(/already in/i);
    }

    const listed = await autoTournamentService.listDay(day, null);
    expect(listed.tournaments.map((row) => row.humanPlayerCount)).toEqual([16, 16, 16]);
  }, 120_000);

  /**
   * One person joining all three, a hundred times over.
   *
   * The interesting number is the registration count per person per
   * tournament: one. The unique index is what makes a double tap — or a client
   * retrying a request it never saw the answer to — a no-op rather than a
   * second seat.
   */
  it('gives one player one seat per tournament however often they ask', async () => {
    const day = addDays(DAY, 4);
    const ids = await threeOpen(day, 16);

    const user = {
      id: userId(),
      username: 'insistent',
      avatarId: 0,
      avatarColorIndex: 0,
    } as Parameters<typeof autoTournamentService.register>[1];

    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        autoTournamentService.register(ids[index % 3]!, user),
      ),
    );

    expect(await TournamentRegistration.countDocuments({ userId: user.id })).toBe(3);

    for (const id of ids) {
      expect(
        await TournamentRegistration.countDocuments({ tournamentId: id, userId: user.id }),
      ).toBe(1);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Calendar days in a timezone
// ---------------------------------------------------------------------------

describe('what day it is', () => {
  it('rolls over at local midnight, not UTC midnight', () => {
    // 20:00 UTC on the fourth is half past one in the morning on the fifth in
    // Kolkata. A server reading its own clock would call this the fourth.
    const instant = new Date('2026-03-04T20:00:00Z');

    expect(dayKeyOf(instant, 'Asia/Kolkata')).toBe('2026-03-05');
    expect(dayKeyOf(instant, 'UTC')).toBe('2026-03-04');
  });

  it('turns a wall-clock time into the right instant', () => {
    // 20:00 IST is 14:30 UTC.
    expect(zonedInstant('2026-03-05', 20 * 60, 'Asia/Kolkata').toISOString()).toBe(
      '2026-03-05T14:30:00.000Z',
    );
  });

  it('survives a daylight-saving change in a zone that has one', () => {
    // London springs forward on 2026-03-29. A tournament at 20:00 is 19:00 UTC
    // the day before and 19:00 UTC after — the offset changed, the wall clock
    // did not.
    const before = zonedInstant('2026-03-28', 20 * 60, 'Europe/London');
    const after = zonedInstant('2026-03-30', 20 * 60, 'Europe/London');

    expect(before.toISOString()).toBe('2026-03-28T20:00:00.000Z');
    expect(after.toISOString()).toBe('2026-03-30T19:00:00.000Z');
  });

  it('counts days forwards and backwards across a month end', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(dayIndexOf('2026-03-02') - dayIndexOf('2026-03-01')).toBe(1);
  });
});
