import { ROOM_CODE } from '@/constants/game.constants';
import { randomBelow } from '@/utils/random';

/**
 * Room code generation and normalisation.
 *
 * The alphabet leaves out `0`, `O`, `1` and `I`: codes get read aloud and
 * typed from a photo of somebody's screen, and those four are the pairs people
 * actually get wrong. Leaving them out means a mistyped code fails validation
 * instead of landing the player in somebody else's room.
 */

/** Generates one candidate code. Uniqueness is the caller's problem. */
export function generateRoomCode(): string {
  const { length, alphabet } = ROOM_CODE;
  let code = '';
  for (let i = 0; i < length; i++) {
    code += alphabet.charAt(randomBelow(alphabet.length));
  }
  return code;
}

/**
 * Upper-cases and strips separators.
 *
 * Mirrors `Validators.normalizeRoomCode` on the Flutter side (`trim` +
 * `toUpperCase`) so both ends agree on what a typed code means. Interior
 * spaces and hyphens are dropped as well, which the client's own validator
 * would reject — a paste of "A7K 9P" should still work rather than being a
 * server error the player cannot explain.
 *
 * It deliberately does NOT fold `O`->`0` or `I`->`1`: those glyphs are not in
 * the alphabet, so folding them would map a typo onto a *different real room*
 * instead of failing cleanly.
 */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '');
}

/** Whether a normalised code has the right shape. */
export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE.length) return false;
  for (const char of code) {
    if (!ROOM_CODE.alphabet.includes(char)) return false;
  }
  return true;
}

/**
 * Generates a code that `isTaken` says is free.
 *
 * With a 32-glyph alphabet and 5 places there are ~33.5M codes, so a collision
 * needs thousands of live rooms before it is even likely; the retry loop is
 * cheap insurance rather than a hot path. After `attempts` tries it gives up
 * rather than spinning, and the caller surfaces a real error.
 */
export async function generateUniqueRoomCode(
  isTaken: (code: string) => Promise<boolean>,
  attempts = 12,
): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const code = generateRoomCode();
    if (!(await isTaken(code))) return code;
  }
  return null;
}
