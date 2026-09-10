import { randomInt, randomUUID } from 'node:crypto';

/**
 * Randomness helpers.
 *
 * `crypto.randomInt` is used rather than `Math.random` throughout. For room
 * codes that matters for real: `Math.random` is a predictable PRNG, so a
 * player who watched a few codes go by could enumerate the next ones and walk
 * into private rooms. For shuffling turn order it matters less, but sharing
 * one source keeps the reasoning simple.
 */

/** A uniformly distributed integer in `[0, maxExclusive)`. */
export function randomBelow(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  return randomInt(maxExclusive);
}

/** Picks one element, or `undefined` from an empty list. */
export function pickOne<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[randomBelow(items.length)];
}

/**
 * Returns a shuffled copy, using Fisher-Yates.
 *
 * A copy rather than an in-place shuffle: callers routinely shuffle a word
 * pool or the player list, and mutating either would corrupt the room state
 * they were read from.
 */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    // Non-null assertions are safe: both indices are inside the array.
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** Takes up to `count` distinct elements at random. */
export function sample<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= items.length) return shuffled(items);
  return shuffled(items).slice(0, count);
}

/** A random identifier for strokes, messages and rounds. */
export function newId(): string {
  return randomUUID();
}
