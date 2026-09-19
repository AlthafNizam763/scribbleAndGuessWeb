import { INPUT_LIMITS } from '@/constants/game.constants';

/**
 * Folds any avatar id onto a character in the current catalogue.
 *
 * ## Why fold and not clamp
 *
 * Because the client folds. `AvatarCatalog.faceAt` has always done
 * `id % faces.length` so a value from a newer build still draws something, and
 * that same fold is what silently carried every pre-rebrand account from the
 * old eighteen faces onto one of the ten cats.
 *
 * A server that *clamped* instead would disagree with it: a stored 14 draws
 * cat 4 on every device, but the moment that player saved their profile the
 * server would write 9 and their face would change under them for no reason
 * they could see. Folding in both places means the two never differ.
 */
export function foldAvatarId(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const index = Math.floor(Math.abs(value));
  return index % INPUT_LIMITS.avatarCount;
}
