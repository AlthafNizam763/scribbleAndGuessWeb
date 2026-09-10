import { randomBelow } from '@/utils/random';

/**
 * The hint engine (brief section 34), mirroring `lib/core/rules/hint_engine.dart`.
 *
 * ## What counts as maskable
 *
 * Spaces and hyphens are always visible and never count as a hint. Revealing
 * "the word has a space in it" is free information the shape of the blanks
 * already gives away, and spending a hint on one would be a wasted hint.
 *
 * ## Why hints are spread out rather than random
 *
 * Picking uniformly at random tends to clump: two adjacent letters in an
 * eight-letter word tell you much less than two letters at opposite ends. Each
 * hint therefore goes to the position *furthest* from everything already
 * revealed, with ties broken randomly so the same word does not always reveal
 * in the same order.
 *
 * At most half the letters are ever revealed, no matter how many hints the
 * host configured — past that the round stops being a drawing game.
 */

const BLANK = '_';

/** Whether a character occupies a blank rather than being shown for free. */
function isMaskable(char: string): boolean {
  return char !== ' ' && char !== '-';
}

/** Positions in `word` that a hint could reveal. */
function maskablePositions(word: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < word.length; i++) {
    if (isMaskable(word[i]!)) positions.push(i);
  }
  return positions;
}

/**
 * Renders the word as spaced blanks with the revealed letters filled in.
 *
 * Space-separated — `_ _ E _ _` — because that is what the client's
 * `WordDisplay` widget lays out, and it is how the brief's example reads.
 */
export function maskWord(word: string, revealedIndices: readonly number[]): string {
  const revealed = new Set(revealedIndices);
  const parts: string[] = [];

  for (let i = 0; i < word.length; i++) {
    const char = word[i]!;
    parts.push(!isMaskable(char) || revealed.has(i) ? char : BLANK);
  }

  return parts.join(' ');
}

/** How many blanks the word has. This is the `wordLength` clients display. */
export function letterCount(word: string): number {
  return maskablePositions(word).length;
}

/** Picks the position furthest from every already-revealed letter. */
function mostIsolated(candidates: readonly number[], revealed: ReadonlySet<number>): number {
  let bestScore = -1;
  let best: number[] = [];

  for (const candidate of candidates) {
    // With nothing revealed yet every position is equally good, so the
    // distance starts at "infinitely far" and ties resolve randomly.
    let score = Number.MAX_SAFE_INTEGER;
    for (const index of revealed) {
      const distance = Math.abs(candidate - index);
      if (distance < score) score = distance;
    }

    if (score > bestScore) {
      bestScore = score;
      best = [candidate];
    } else if (score === bestScore) {
      best.push(candidate);
    }
  }

  return best[randomBelow(best.length)] ?? candidates[0] ?? 0;
}

/**
 * Returns the revealed positions after `hintNumber` hints.
 *
 * Cumulative rather than incremental: it takes what is already revealed and
 * returns the full set. That makes it idempotent, so a retried or duplicated
 * timer tick cannot reveal more of the word than it should.
 */
export function nextHintIndices(input: {
  word: string;
  current: readonly number[];
  totalHints: number;
  hintNumber: number;
}): number[] {
  const maskable = maskablePositions(input.word);
  const allowed = new Set(maskable);

  // Drop anything stale — a position from a previous, longer word.
  const revealed = new Set([...input.current].filter((index) => allowed.has(index)));

  const cap = Math.floor(maskable.length / 2);
  const wanted = Math.max(0, input.hintNumber);
  const allowedHints = Math.max(0, input.totalHints);
  const target = Math.min(Math.min(wanted, allowedHints), cap);

  if (revealed.size < target) {
    const candidates = maskable.filter((index) => !revealed.has(index));
    while (revealed.size < target && candidates.length > 0) {
      const chosen = mostIsolated(candidates, revealed);
      revealed.add(chosen);
      candidates.splice(candidates.indexOf(chosen), 1);
    }
  }

  return [...revealed].sort((a, b) => a - b);
}

/**
 * When each hint should land, as absolute epoch milliseconds.
 *
 * Hints are spread evenly across the middle of the turn: the first at
 * `firstHintAtFraction`, the last at `lastHintAtFraction`. Nothing is revealed
 * in the opening seconds — that is when guessing is worth the most points, and
 * a hint would undercut the players who were fastest.
 */
export function hintSchedule(input: {
  turnStartMs: number;
  turnEndMs: number;
  hintCount: number;
  firstAtFraction: number;
  lastAtFraction: number;
}): number[] {
  const { turnStartMs, turnEndMs, hintCount } = input;
  if (hintCount <= 0 || turnEndMs <= turnStartMs) return [];

  const duration = turnEndMs - turnStartMs;
  const first = turnStartMs + duration * input.firstAtFraction;
  const last = turnStartMs + duration * input.lastAtFraction;

  if (hintCount === 1) return [Math.round(first)];

  const step = (last - first) / (hintCount - 1);
  return Array.from({ length: hintCount }, (_, i) => Math.round(first + step * i));
}
