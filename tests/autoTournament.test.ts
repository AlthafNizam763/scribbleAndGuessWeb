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
const { tournamentSlotManager } = await import('@/services/tournament/slotManager.service');
const { autoTournamentService } = await import('@/services/tournament/auto.service');

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

/** The live tournament in a slot, or null. */
async function liveInSlot(slotNumber: number) {
  return AutoTournament.findOne({
    slotNumber,
    status: {
      $in: [
        AUTO_TOURNAMENT_STATUS.upcoming,
        AUTO_TOURNAMENT_STATUS.registration,
        AUTO_TOURNAMENT_STATUS.checkIn,
        AUTO_TOURNAMENT_STATUS.running,
      ],
    },
  })
    .lean()
    .exec();
}

// ---------------------------------------------------------------------------
// The three-slot invariant
// ---------------------------------------------------------------------------

describe('keeping exactly three tournaments', () => {
  it('creates one per slot on the first tick', async () => {
    const created = await tournamentSlotManager.fillVacantSlots();

    expect(created).toHaveLength(3);
    expect(created.map((row) => row.slotNumber).sort()).toEqual([1, 2, 3]);
  });

  it('creates nothing on a second tick', async () => {
    await tournamentSlotManager.fillVacantSlots();
    const again = await tournamentSlotManager.fillVacantSlots();

    expect(again).toHaveLength(0);
    expect(await AutoTournament.countDocuments({})).toBe(3);
  });

  /**
   * The race this design exists for. Two processes scanning at the same
   * instant both see three vacant slots; the unique index decides.
   */
  it('never produces a fourth when two schedulers fill at once', async () => {
    await Promise.all([
      tournamentSlotManager.fillVacantSlots(),
      tournamentSlotManager.fillVacantSlots(),
      tournamentSlotManager.fillVacantSlots(),
    ]);

    expect(await AutoTournament.countDocuments({})).toBe(3);
  });

  it('refuses a second tournament in an occupied slot outright', async () => {
    await tournamentSlotManager.createInSlot(1);
    const second = await tournamentSlotManager.createInSlot(1);

    expect(second).toBeNull();
    expect(await AutoTournament.countDocuments({ slotNumber: 1 })).toBe(1);
  });

  it('refills a slot once its tournament is cancelled', async () => {
    const [first] = await tournamentSlotManager.fillVacantSlots();
    expect(first).toBeDefined();

    await tournamentLifecycleService.cancel(first!, 'nobody came');

    expect(await liveInSlot(first!.slotNumber)).toBeNull();

    const replacement = await tournamentSlotManager.fillVacantSlots();
    expect(replacement).toHaveLength(1);
    expect(replacement[0]?.slotNumber).toBe(first!.slotNumber);
    // A new identity, not the old one coming back.
    expect(replacement[0]?.tournamentNumber).toBeGreaterThan(first!.tournamentNumber);
  });

  it('gives every tournament a distinct display number', async () => {
    await tournamentSlotManager.fillVacantSlots();
    const rows = await AutoTournament.find({}).lean().exec();

    const numbers = rows.map((row) => row.tournamentNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

// ---------------------------------------------------------------------------
// The scheduler lock
// ---------------------------------------------------------------------------

describe('the scheduler lock', () => {
  it('lets exactly one of two concurrent ticks run', async () => {
    const [a, b] = await Promise.all([
      tournamentScheduler.runOnce(),
      tournamentScheduler.runOnce(),
    ]);

    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
    expect(await AutoTournament.countDocuments({})).toBe(3);
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
    expect(await AutoTournament.countDocuments({})).toBe(3);
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
    expect(await AutoTournament.countDocuments({})).toBe(0);
  });

  it('runs a full tick end to end and opens registration', async () => {
    const tick = await tournamentScheduler.runOnce();

    expect(tick.created).toBe(3);
    expect(tick.opened).toBe(3);
    expect(tick.errors).toBe(0);

    const open = await AutoTournament.countDocuments({
      status: AUTO_TOURNAMENT_STATUS.registration,
    });
    expect(open).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registering', () => {
  it('admits a player and counts them', async () => {
    await tournamentScheduler.runOnce();
    const tournament = (await liveInSlot(1))!;
    const id = String(tournament._id);

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
    await tournamentScheduler.runOnce();
    const tournament = (await liveInSlot(1))!;
    const id = String(tournament._id);

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

  /** The product rule: one tournament at a time. */
  it('refuses a player who is already in another tournament', async () => {
    await tournamentScheduler.runOnce();
    const first = String((await liveInSlot(1))!._id);
    const second = String((await liveInSlot(2))!._id);

    const user = {
      id: userId(),
      username: 'cy',
      avatarId: 0,
      avatarColorIndex: 0,
    } as Parameters<typeof autoTournamentService.register>[1];

    await autoTournamentService.register(first, user);

    await expect(autoTournamentService.register(second, user)).rejects.toThrow(
      /already in/i,
    );
  });

  it('lets them in again once the first tournament is over', async () => {
    await tournamentScheduler.runOnce();
    const first = (await liveInSlot(1))!;
    const second = String((await liveInSlot(2))!._id);

    const user = {
      id: userId(),
      username: 'di',
      avatarId: 0,
      avatarColorIndex: 0,
    } as Parameters<typeof autoTournamentService.register>[1];

    await autoTournamentService.register(String(first._id), user);
    await tournamentLifecycleService.cancel(first, 'called off');

    const joined = await autoTournamentService.register(second, user);
    expect(joined.viewer.isRegistered).toBe(true);
  });

  it('tells a blocked player which tournament is holding them', async () => {
    await tournamentScheduler.runOnce();
    const first = String((await liveInSlot(1))!._id);

    const user = {
      id: userId(),
      username: 'el',
      avatarId: 0,
      avatarColorIndex: 0,
    } as Parameters<typeof autoTournamentService.register>[1];

    await autoTournamentService.register(first, user);

    const { slots } = await autoTournamentService.listSlots(user.id);
    const other = slots.find((slot) => slot.slotNumber === 2)?.tournament;

    expect(other?.viewer.canRegister).toBe(false);
    expect(other?.viewer.blockedReason).toMatch(/already in/i);
  });

  it('refuses once the tournament is full', async () => {
    const tournament = await AutoTournament.create({
      slotNumber: 1,
      tournamentNumber: 900,
      name: 'Tiny Cup',
      status: AUTO_TOURNAMENT_STATUS.registration,
      minPlayers: 2,
      maxPlayers: 2,
      registrationOpenAt: new Date(),
      registrationCloseAt: new Date(Date.now() + 60_000),
      checkInOpenAt: new Date(Date.now() + 60_000),
      checkInCloseAt: new Date(Date.now() + 120_000),
      startAt: new Date(Date.now() + 120_000),
    });

    const id = String(tournament._id);
    await registerPlayer(id, 'one');
    await registerPlayer(id, 'two');

    await expect(registerPlayer(id, 'three')).rejects.toThrow(/full/i);
  });

  it('refuses a registration once check-in has opened', async () => {
    await tournamentScheduler.runOnce();
    const tournament = (await liveInSlot(1))!;

    await registerPlayer(String(tournament._id), 'early');
    await AutoTournament.updateOne(
      { _id: tournament._id },
      { $set: { status: AUTO_TOURNAMENT_STATUS.checkIn } },
    );

    await expect(registerPlayer(String(tournament._id), 'late')).rejects.toThrow(
      /closed/i,
    );
  });

  it('lets a player withdraw while registration is open', async () => {
    await tournamentScheduler.runOnce();
    const id = String((await liveInSlot(1))!._id);

    const player = await registerPlayer(id, 'fi');
    const after = await autoTournamentService.withdraw(id, player);

    expect(after.humanPlayerCount).toBe(0);
    expect(after.viewer.isRegistered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Check-in, bot fill and seeding
// ---------------------------------------------------------------------------

/** Moves a tournament to check-in with `humans` players registered. */
async function tournamentAtCheckIn(humans: number) {
  await tournamentScheduler.runOnce();
  const tournament = (await liveInSlot(1))!;
  const id = String(tournament._id);

  const players: string[] = [];
  for (let i = 0; i < humans; i++) players.push(await registerPlayer(id, `p${i}`));

  await AutoTournament.updateOne(
    { _id: tournament._id },
    { $set: { registrationCloseAt: new Date(Date.now() - 1000) } },
  );

  const fresh = (await AutoTournament.findById(id).lean().exec())!;
  await tournamentLifecycleService.closeRegistration(fresh);

  return { id, players };
}

describe('check-in and the bracket', () => {
  it('cancels a tournament nobody registered for', async () => {
    await tournamentScheduler.runOnce();
    const tournament = (await liveInSlot(1))!;

    await tournamentLifecycleService.closeRegistration(tournament);

    const after = await AutoTournament.findById(tournament._id).lean().exec();
    expect(after?.status).toBe(AUTO_TOURNAMENT_STATUS.cancelled);
    expect(after?.cancelReason).toMatch(/nobody registered/i);
  });

  it('cancels when nobody who registered actually checks in', async () => {
    const { id } = await tournamentAtCheckIn(2);

    // Nobody confirms.
    const row = (await AutoTournament.findById(id).lean().exec())!;
    await tournamentLifecycleService.closeCheckIn(row);

    const after = await AutoTournament.findById(id).lean().exec();
    expect(after?.status).toBe(AUTO_TOURNAMENT_STATUS.cancelled);
    expect(await TournamentMatch.countDocuments({ tournamentId: id })).toBe(0);
  });

  it('fills one human up to four with three bots and draws a bracket', async () => {
    const { id, players } = await tournamentAtCheckIn(1);

    await autoTournamentService.checkIn(id, players[0]!);

    const row = (await AutoTournament.findById(id).lean().exec())!;
    await tournamentLifecycleService.closeCheckIn(row);

    const after = (await AutoTournament.findById(id).lean().exec())!;
    expect(after.status).toBe(AUTO_TOURNAMENT_STATUS.running);
    expect(after.humanPlayerCount).toBe(1);
    expect(after.botPlayerCount).toBe(3);
    // Four players is a two-round bracket.
    expect(after.totalRounds).toBe(2);

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

  it('adds no bots when four people checked in', async () => {
    const { id, players } = await tournamentAtCheckIn(4);
    for (const player of players) await autoTournamentService.checkIn(id, player);

    const row = (await AutoTournament.findById(id).lean().exec())!;
    await tournamentLifecycleService.closeCheckIn(row);

    const after = (await AutoTournament.findById(id).lean().exec())!;
    expect(after.humanPlayerCount).toBe(4);
    expect(after.botPlayerCount).toBe(0);
  });

  it('writes off the people who never confirmed', async () => {
    const { id, players } = await tournamentAtCheckIn(4);
    // Only two of the four confirm.
    await autoTournamentService.checkIn(id, players[0]!);
    await autoTournamentService.checkIn(id, players[1]!);

    const row = (await AutoTournament.findById(id).lean().exec())!;
    await tournamentLifecycleService.closeCheckIn(row);

    const noShows = await TournamentRegistration.countDocuments({
      tournamentId: id,
      status: REGISTRATION_STATUS.noShow,
    });
    expect(noShows).toBe(2);

    // Two present, so two bots make it up to four.
    const after = (await AutoTournament.findById(id).lean().exec())!;
    expect(after.botPlayerCount).toBe(2);
  });

  it('refuses a second check-in from somebody already written off', async () => {
    const { id, players } = await tournamentAtCheckIn(2);

    const row = (await AutoTournament.findById(id).lean().exec())!;
    await tournamentLifecycleService.closeCheckIn(row);

    await expect(autoTournamentService.checkIn(id, players[0]!)).rejects.toThrow();
  });

  it('refuses a duplicate bot registration at the index', async () => {
    const { id } = await tournamentAtCheckIn(1);

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
    slotNumber: 1,
    tournamentNumber: 900 + count,
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
  it('records the winner and releases the slot', async () => {
    const { id, players } = await tournamentAtCheckIn(1);
    await autoTournamentService.checkIn(id, players[0]!);

    const row = (await AutoTournament.findById(id).lean().exec())!;
    await tournamentLifecycleService.closeCheckIn(row);

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

    const winner = await TournamentRegistration.findById(after.winnerRegistrationId)
      .lean()
      .exec();
    expect(winner?.status).toBe(REGISTRATION_STATUS.winner);

    // The slot is free, and the next tick fills it.
    expect(await liveInSlot(after.slotNumber)).toBeNull();
    const replacement = await tournamentSlotManager.fillVacantSlots();
    expect(replacement.map((entry) => entry.slotNumber)).toContain(after.slotNumber);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('what a client is shown', () => {
  it('returns a row for every slot, including the empty ones', async () => {
    const { slots } = await autoTournamentService.listSlots(null);

    expect(slots).toHaveLength(3);
    expect(slots.every((slot) => slot.tournament === null)).toBe(true);
  });

  it('reports humans and bots separately', async () => {
    const { id, players } = await tournamentAtCheckIn(1);
    await autoTournamentService.checkIn(id, players[0]!);

    const row = (await AutoTournament.findById(id).lean().exec())!;
    await tournamentLifecycleService.closeCheckIn(row);

    const dto = await autoTournamentService.get(id, players[0]!);

    expect(dto.humanPlayerCount).toBe(1);
    expect(dto.botPlayerCount).toBe(3);
    expect(dto.totalPlayers).toBe(4);
  });

  it('flags every AI entrant as a bot and nobody else', async () => {
    const { id, players } = await tournamentAtCheckIn(1);
    await autoTournamentService.checkIn(id, players[0]!);

    const row = (await AutoTournament.findById(id).lean().exec())!;
    await tournamentLifecycleService.closeCheckIn(row);

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
