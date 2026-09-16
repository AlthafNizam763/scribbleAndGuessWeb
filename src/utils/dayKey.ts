/**
 * Calendar days, in a timezone that is not the server's.
 *
 * ## Why a string is the key and not a `Date`
 *
 * "Three tournaments per calendar day" needs a *day* to be a thing the
 * database can hold one unique value of. A `Date` cannot be that: every
 * instant is midnight somewhere, so two processes rounding "today" to a `Date`
 * in different regions would disagree about which day a tournament belonged
 * to, and the unique index would happily let both of them create it.
 *
 * `'2026-09-16'` has no such ambiguity. It is computed once, from a configured
 * timezone, and every process that asks on the same wall-clock day gets the
 * same ten characters — which is what makes
 * `{tournamentDate, dailySlot, isAutomatic}` a constraint rather than a hope.
 *
 * It also sorts. Lexicographic order on this format is chronological order, so
 * "today's tournaments" and "the next day to prepare" are ordinary indexed
 * queries rather than arithmetic.
 *
 * ## Why the offset is measured rather than stored
 *
 * Because it changes. A deployment configured for `Europe/London` is UTC in
 * January and UTC+1 in July, and a stored offset would put the evening
 * tournament an hour out for half the year. Everything here goes through
 * `Intl`, which carries the real rules for the zone and is the only thing in
 * the runtime that does.
 */

/** `YYYY-MM-DD`. The shape every key in this module has. */
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

const MS_PER_DAY = 86_400_000;

/**
 * One `Intl.DateTimeFormat` per timezone, kept.
 *
 * Constructing one is expensive — it builds a locale and a zone table — and
 * the scheduler asks for the current day key on every tick. The set of zones a
 * process uses is one, so this map never grows.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;

  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // Midnight is hour 0 rather than hour 24, which the 12-hour cycle would
    // render as "24" and break every comparison below.
    hourCycle: 'h23',
  });

  formatters.set(timeZone, made);
  return made;
}

/** The wall-clock fields an instant has in a zone. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(at: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(at);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * How far ahead of UTC a zone is at a given instant, in milliseconds.
 *
 * Measured by asking what the wall clock reads there and subtracting the
 * instant it actually is. Positive east of Greenwich, negative west, and
 * correct across a daylight-saving change because the question is asked about
 * one specific moment rather than about the zone in general.
 */
function offsetMsAt(at: Date, timeZone: string): number {
  const parts = partsIn(at, timeZone);

  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  // The formatter has no milliseconds, so they are taken off the instant
  // rather than left to round the offset to the nearest second.
  return asUtc - (at.getTime() - at.getMilliseconds());
}

/** Whether a string is a well-formed day key. */
export function isDayKey(value: string): boolean {
  return DAY_KEY.test(value);
}

/** Whether a string names a timezone this runtime knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar day an instant falls on, in a zone.
 *
 * This is the whole definition of "today" for the tournament system. Called
 * with the deployment's configured zone it is the same answer on every
 * instance, which is the property the daily uniqueness rule is built on.
 */
export function dayKeyOf(at: Date, timeZone: string): string {
  const parts = partsIn(at, timeZone);

  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/** Today's key, in a zone. */
export function todayKey(timeZone: string, now: Date = new Date()): string {
  return dayKeyOf(now, timeZone);
}

/**
 * The key `days` after — or, negative, before — another key.
 *
 * Done as arithmetic on the date parts rather than by adding 24 hours to an
 * instant, because a day in a zone that shifts its clocks is not always 24
 * hours long and "tomorrow" must mean the next calendar date regardless.
 */
export function addDays(dayKey: string, days: number): string {
  const [year, month, day] = splitKey(dayKey);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);

  return dayKeyOf(shifted, 'UTC');
}

/**
 * How many days a key is after 1970-01-01.
 *
 * The rotation counter. The name service turns this into a position in the
 * name pool, so the three names for a date are a pure function of the date and
 * every instance computes the same three without consulting anything.
 */
export function dayIndexOf(dayKey: string): number {
  const [year, month, day] = splitKey(dayKey);
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/**
 * The instant at which a wall-clock time occurs on a given day in a zone.
 *
 * ## Why this takes two passes
 *
 * The offset to apply depends on the instant, and the instant is what is being
 * computed. The first pass guesses by reading the offset at the same wall time
 * treated as UTC, which is right except within a few hours of a
 * daylight-saving change; the second reads the offset at the instant the first
 * pass produced, which is the offset actually in force.
 *
 * On a spring-forward day a time that does not exist — 01:30 where the clocks
 * jump 01:00 to 02:00 — resolves to the instant the clock reaches 02:30, and
 * on a fall-back day an ambiguous time resolves to its first occurrence. Both
 * are the conventional readings, and neither can arise in a zone without
 * daylight saving, which the default is.
 *
 * @param minutesOfDay Minutes after local midnight. `600` is 10:00.
 */
export function zonedInstant(
  dayKey: string,
  minutesOfDay: number,
  timeZone: string,
): Date {
  const [year, month, day] = splitKey(dayKey);

  // The wall-clock reading, as though the zone were UTC. Minutes beyond 1439
  // roll into the next day on their own, which is what `Date.UTC` does with
  // out-of-range fields and is the right behaviour for a slot configured past
  // midnight.
  const wall = Date.UTC(year, month - 1, day, 0, minutesOfDay);

  const firstGuess = wall - offsetMsAt(new Date(wall), timeZone);
  const corrected = wall - offsetMsAt(new Date(firstGuess), timeZone);

  return new Date(corrected);
}

/** Splits a key into numbers, or throws if it is not one. */
function splitKey(dayKey: string): [number, number, number] {
  const match = DAY_KEY.exec(dayKey);
  if (!match) throw new Error(`not a day key: ${dayKey}`);

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
