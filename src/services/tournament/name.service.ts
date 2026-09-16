import { DAILY_SLOTS, TOURNAMENT_NAME_POOL, type DailySlotWire } from '@/constants/autoTournament.constants';
import { dayIndexOf } from '@/utils/dayKey';

/**
 * Naming the day's three tournaments.
 *
 * ## Why the names are a function of the date
 *
 * Because two processes must be able to create the same tournament without
 * talking to each other. The scheduler holds a lock, but a lock that expired
 * mid-tick, a second instance coming up, and a retry after a failed insert all
 * end with somebody asking "what is the afternoon tournament called?" — and if
 * the answer involved a counter, a shuffle or a random draw, the two answers
 * would differ and the same slot would be created twice under two names.
 *
 * Here the answer is arithmetic on the date. Every instance, every retry and
 * every restart computes the same three names for the same day, for ever, with
 * no state to keep and nothing to read.
 *
 * ## Why it is a rotation and not a shuffle
 *
 * A shuffle repeats. Drawing three names at random from twenty gives the same
 * name two days running about a third of the time, and the same *set* often
 * enough to notice — which reads as a bug ("didn't I already play Ink
 * Royale?") rather than as variety.
 *
 * Walking the pool three at a time gives none of that. Day *n* takes positions
 * `3n, 3n+1, 3n+2` (mod 20), so:
 *
 * - the three names on a day are always different;
 * - consecutive days never share a name, because the positions differ by 3, 4
 *   or 5 and the sets are only two wide — proved by the arithmetic rather than
 *   checked at runtime;
 * - the pool takes twenty days to come round, since twenty and three share no
 *   factor, so a name is three weeks old before it returns.
 *
 * ## What a name is not
 *
 * It is not the winner, it is not the date, and it never changes. The name is
 * written once when the tournament is created and no code path writes it
 * again — which is what makes "do not rename a tournament people have joined"
 * a property of the system rather than a rule somebody has to remember.
 */

export class TournamentNameService {
  /** The pool, in case a caller wants to show or test it. */
  get pool(): readonly string[] {
    return TOURNAMENT_NAME_POOL;
  }

  /**
   * The three names for one day, in slot order.
   *
   * Pure: same day key in, same three names out, on any instance at any time.
   */
  namesForDay(tournamentDate: string): Record<DailySlotWire, string> {
    const dayIndex = dayIndexOf(tournamentDate);
    const pool = TOURNAMENT_NAME_POOL;

    const names = {} as Record<DailySlotWire, string>;

    DAILY_SLOTS.forEach((slot, position) => {
      // `dayIndex` can be negative for a date before 1970 — which nothing will
      // ever ask for, but a negative modulo in JavaScript is negative and
      // would index off the front of the array. The double modulo costs
      // nothing and removes the class of bug.
      const index = ((dayIndex * DAILY_SLOTS.length + position) % pool.length + pool.length) %
        pool.length;

      names[slot] = pool[index]!;
    });

    return names;
  }

  /**
   * The name for one slot on one day.
   *
   * @param taken Names already used on this day, which this call must avoid.
   *
   * ## Why `taken` exists when the rotation cannot collide
   *
   * It cannot collide *with itself*. It can collide with history: a row
   * created under an older version of the pool, a day whose tournaments were
   * created before somebody reordered the list, or a deployment that changed
   * `DAILY_SLOTS`. In any of those the day already contains a tournament
   * called what this one is about to be called, and two cards with the same
   * name on one screen is exactly the confusion the pool exists to prevent.
   *
   * So the caller passes what the day already has, and this walks forward to
   * the next free name. Still deterministic — the walk starts from the same
   * place and moves the same way — and still silent, because a name being
   * taken is not an error.
   */
  nameFor(
    tournamentDate: string,
    slot: DailySlotWire,
    taken: readonly string[] = [],
  ): string {
    const first = this.namesForDay(tournamentDate)[slot];
    if (!taken.includes(first)) return first;

    const pool = TOURNAMENT_NAME_POOL;
    const start = pool.indexOf(first);

    for (let step = 1; step < pool.length; step++) {
      const candidate = pool[(start + step) % pool.length]!;
      if (!taken.includes(candidate)) return candidate;
    }

    // Every name in the pool is in use on one day, which needs a pool smaller
    // than three. Returning the rotation's own answer is the least surprising
    // thing left, and the unique index on the slot is what actually keeps the
    // day to three tournaments — the name was never the constraint.
    return first;
  }
}

export const tournamentNameService = new TournamentNameService();
