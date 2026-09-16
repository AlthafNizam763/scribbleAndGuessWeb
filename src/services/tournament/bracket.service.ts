import { Types } from 'mongoose';

import {
  AUTO_TOURNAMENT_LIMITS,
  MATCH_OUTCOME,
  MATCH_STATUS,
  REGISTRATION_STATUS,
} from '@/constants/autoTournament.constants';
import { TournamentRegistration, type TournamentRegistrationDocument } from '@/models/AutoTournament';
import { TournamentMatch, TournamentRound } from '@/models/TournamentMatch';
import { logger } from '@/utils/logger';
import { shuffled } from '@/utils/random';

/**
 * Drawing the knockout bracket.
 *
 * ## The shape
 *
 * A knockout needs a power of two. With `n` checked-in players the bracket is
 * sized to the next power of two at or above `n`, and the `2^k - n` shortfall
 * becomes byes in round one. A player with a bye is not given a match to play
 * — their round-one match is completed at seeding with outcome `BYE` and they
 * appear in round two.
 *
 * ## Why byes go to the top seeds
 *
 * Because somebody has to have them, and every other rule is worse. Random
 * byes make the draw feel arbitrary; bottom-seed byes reward turning up late.
 * Top seeds here means "registered earliest", which is the only ordering this
 * tournament actually has — there are no ratings — so a bye is a small reward
 * for being first through the door.
 *
 * ## Why generation is idempotent and how
 *
 * The unique index on `{tournamentId, roundNumber, matchNumber}` means the
 * whole bracket is written by one unordered bulk insert whose duplicates are
 * tolerated. Two schedulers racing to seed the same tournament both build the
 * identical set of positions — the seeding order is written to the
 * registrations *first*, so both read the same order — and the second insert
 * collides on every row instead of producing a second bracket beside the
 * first.
 */

/** A bracket position, before it is written. */
interface PlannedMatch {
  roundNumber: number;
  matchNumber: number;
  slotA: string | null;
  slotB: string | null;
  nextMatchNumber: number | null;
  nextMatchSlot: 'A' | 'B' | null;
}

export class TournamentBracketService {
  /**
   * Seeds a tournament and writes its rounds and matches.
   *
   * Returns the number of rounds, or zero when there were not enough players
   * to draw anything — which the caller treats as a cancellation rather than
   * an error, because "nobody turned up" is a normal outcome for an event
   * nobody had to opt into.
   */
  async generate(input: {
    tournamentId: string;
    /** Everybody who is actually playing: checked-in humans, plus the bots. */
    participants: TournamentRegistrationDocument[];
  }): Promise<{ totalRounds: number; firstRoundMatches: number }> {
    const { tournamentId } = input;

    const field = input.participants.slice(0, AUTO_TOURNAMENT_LIMITS.maxBracketSize);
    if (field.length < 2) return { totalRounds: 0, firstRoundMatches: 0 };

    // The seeding order.
    //
    // Registration order decides the seeds — earliest first — and everything
    // downstream (which pairing you land in, whether you get a bye) follows
    // from it. Two schedulers racing therefore compute the same draw from the
    // same rows, which is what makes the duplicate-tolerant insert below
    // produce one bracket rather than a merge of two different ones.
    //
    // Bots are pushed to the end regardless of when they were added, so a
    // human is never denied a bye in favour of a robot.
    const seeded = [...field].sort((a, b) => {
      if (a.isBot !== b.isBot) return a.isBot ? 1 : -1;
      return new Date(a.joinedAt ?? 0).getTime() - new Date(b.joinedAt ?? 0).getTime();
    });

    const size = nextPowerOfTwo(seeded.length);
    const totalRounds = Math.log2(size);

    await this.writeSeeds(tournamentId, seeded);

    const planned = this.planMatches(seeded, size, totalRounds);

    await this.writeRounds(tournamentId, totalRounds, size);
    await this.writeMatches(tournamentId, planned);

    logger.info('bracket generated', {
      tournamentId,
      players: seeded.length,
      bracketSize: size,
      totalRounds,
      byes: size - seeded.length,
    });

    return {
      totalRounds,
      firstRoundMatches: planned.filter((match) => match.roundNumber === 1).length,
    };
  }

  /**
   * Writes each participant's seed number and marks them active.
   *
   * Done before the matches so a racing seeder reads the same numbers. Each
   * write is conditional on the row not already having a seed, so the second
   * pass changes nothing.
   */
  private async writeSeeds(
    tournamentId: string,
    seeded: TournamentRegistrationDocument[],
  ): Promise<void> {
    await TournamentRegistration.bulkWrite(
      seeded.map((row, index) => ({
        updateOne: {
          filter: { _id: row._id, seed: null },
          update: { $set: { seed: index + 1, status: REGISTRATION_STATUS.active } },
        },
      })),
      { ordered: false },
    );

    // Re-read so the plan uses the seeds that were actually stored. Without
    // this, a seeder that lost the race would build its bracket from the
    // numbers it *wanted* rather than the ones in the database.
    const stored = await TournamentRegistration.find({
      _id: { $in: seeded.map((row) => row._id) },
    })
      .select({ _id: 1, seed: 1 })
      .lean()
      .exec();

    const bySeed = new Map(stored.map((row) => [String(row._id), row.seed ?? 0]));
    seeded.sort(
      (a, b) => (bySeed.get(String(a._id)) ?? 0) - (bySeed.get(String(b._id)) ?? 0),
    );
  }

  /**
   * Builds every position in the bracket.
   *
   * Round one is laid out by the standard seeding pairs — 1 plays the lowest
   * seed, 2 plays the second lowest, and so on — so the two strongest seeds
   * can only meet in the final. A slot with no player is a bye.
   */
  private planMatches(
    seeded: TournamentRegistrationDocument[],
    size: number,
    totalRounds: number,
  ): PlannedMatch[] {
    const planned: PlannedMatch[] = [];
    const firstRoundMatches = size / 2;

    for (let matchNumber = 1; matchNumber <= firstRoundMatches; matchNumber++) {
      const high = seeded[matchNumber - 1] ?? null;
      const low = seeded[size - matchNumber] ?? null;

      planned.push({
        roundNumber: 1,
        matchNumber,
        slotA: high ? String(high._id) : null,
        slotB: low ? String(low._id) : null,
        ...feedsInto(matchNumber, 1, totalRounds),
      });
    }

    for (let round = 2; round <= totalRounds; round++) {
      const matches = size / 2 ** round;
      for (let matchNumber = 1; matchNumber <= matches; matchNumber++) {
        planned.push({
          roundNumber: round,
          matchNumber,
          slotA: null,
          slotB: null,
          ...feedsInto(matchNumber, round, totalRounds),
        });
      }
    }

    return planned;
  }

  /** One row per round, naming it the way every client will show it. */
  private async writeRounds(
    tournamentId: string,
    totalRounds: number,
    size: number,
  ): Promise<void> {
    // The id has to be a real `ObjectId` here rather than the string every
    // other query in this file gets away with: Mongoose casts a *filter* for
    // you, but the `$setOnInsert` payload is the document it would create, and
    // a string in it would store a `tournamentId` that no `ref` lookup or
    // equality filter ever matches.
    const id = new Types.ObjectId(tournamentId);

    await TournamentRound.bulkWrite(
      Array.from({ length: totalRounds }, (_, index) => {
        const roundNumber = index + 1;
        return {
          updateOne: {
            filter: { tournamentId: id, roundNumber },
            update: {
              $setOnInsert: {
                tournamentId: id,
                roundNumber,
                name: roundName(roundNumber, totalRounds),
                matchCount: size / 2 ** roundNumber,
              },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
  }

  /**
   * Inserts the matches, tolerating a racing seeder.
   *
   * `ordered: false` so one duplicate does not abandon the rest of the batch,
   * and the duplicate-key errors are swallowed on purpose: every one of them
   * means "this position already exists", which is precisely the outcome being
   * aimed for. Anything else is rethrown.
   */
  private async writeMatches(tournamentId: string, planned: PlannedMatch[]): Promise<void> {
    const now = new Date();

    try {
      await TournamentMatch.insertMany(
        planned.map((match) => ({
          tournamentId,
          roundNumber: match.roundNumber,
          matchNumber: match.matchNumber,
          slotA: match.slotA,
          slotB: match.slotB,
          // A first-round pairing with both players known is ready to open.
          // Anything else waits for the round below, or is a bye — which the
          // caller resolves immediately after seeding.
          status: MATCH_STATUS.pending,
          nextMatchNumber: match.nextMatchNumber,
          nextMatchSlot: match.nextMatchSlot,
          createdAt: now,
        })),
        { ordered: false },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      logger.info('bracket already existed; seeding was a no-op', { tournamentId });
    }
  }

  /**
   * Completes every round-one match that is a bye.
   *
   * Run straight after seeding. A bye is a match with exactly one player, and
   * completing it here rather than letting the match runner discover it keeps
   * "a match with one player" out of every path downstream — there is no room
   * to open, no deadline to wait out and no result to report.
   */
  async resolveByes(tournamentId: string): Promise<number> {
    const byes = await TournamentMatch.find({
      tournamentId,
      roundNumber: 1,
      status: MATCH_STATUS.pending,
      $or: [
        { slotA: { $ne: null }, slotB: null },
        { slotA: null, slotB: { $ne: null } },
      ],
    })
      .lean()
      .exec();

    let resolved = 0;

    for (const match of byes) {
      const winner = match.slotA ?? match.slotB;
      if (!winner) continue;

      const updated = await TournamentMatch.updateOne(
        { _id: match._id, status: MATCH_STATUS.pending },
        {
          $set: {
            status: MATCH_STATUS.completed,
            winnerRegistrationId: winner,
            loserRegistrationId: null,
            outcome: MATCH_OUTCOME.bye,
            completedAt: new Date(),
          },
        },
      ).exec();

      if ((updated.modifiedCount ?? 0) > 0) resolved += 1;
    }

    // A round-one match with *neither* slot filled cannot happen for a bracket
    // sized to the field — but a bracket seeded twice by two racing schedulers
    // could in principle leave one, and a dangling PENDING match would stall
    // the round for ever. Cancelling it is the safe reading: nobody is in it.
    await TournamentMatch.updateMany(
      { tournamentId, roundNumber: 1, status: MATCH_STATUS.pending, slotA: null, slotB: null },
      { $set: { status: MATCH_STATUS.cancelled, completedAt: new Date() } },
    ).exec();

    return resolved;
  }
}

/**
 * Where a match's winner goes next.
 *
 * Match `n` of round `r` feeds slot A of match `ceil(n/2)` in round `r+1` when
 * `n` is odd, and slot B when it is even. The final feeds nowhere.
 */
function feedsInto(
  matchNumber: number,
  roundNumber: number,
  totalRounds: number,
): { nextMatchNumber: number | null; nextMatchSlot: 'A' | 'B' | null } {
  if (roundNumber >= totalRounds) return { nextMatchNumber: null, nextMatchSlot: null };

  return {
    nextMatchNumber: Math.ceil(matchNumber / 2),
    nextMatchSlot: matchNumber % 2 === 1 ? 'A' : 'B',
  };
}

/** The smallest power of two at or above `n`, with a floor of two. */
function nextPowerOfTwo(n: number): number {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

/** What a round is called, counting back from the final. */
function roundName(roundNumber: number, totalRounds: number): string {
  const fromEnd = totalRounds - roundNumber;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-final';
  if (fromEnd === 2) return 'Quarter-final';
  return `Round ${roundNumber}`;
}

/** Whether a thrown value is Mongo complaining about a unique index. */
function isDuplicateKeyError(error: unknown): boolean {
  const code = (error as { code?: number }).code;
  if (code === 11000) return true;

  // `insertMany` with `ordered: false` reports a batch of them.
  const writeErrors = (error as { writeErrors?: { err?: { code?: number } }[] }).writeErrors;
  if (!Array.isArray(writeErrors) || writeErrors.length === 0) return false;
  return writeErrors.every((entry) => entry.err?.code === 11000);
}

export const tournamentBracketService = new TournamentBracketService();
