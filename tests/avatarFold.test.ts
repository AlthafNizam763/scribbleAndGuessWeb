import { describe, expect, it } from 'vitest';

import { INPUT_LIMITS } from '@/constants/game.constants';
import { foldAvatarId } from '@/utils/avatar';

/**
 * Folding an avatar id onto one of the ten cats.
 *
 * ## The claim under test
 *
 * That this agrees, exactly, with the client's `AvatarCatalog.faceAt`, which
 * is `faces[id.abs() % faces.length]`. The two are written in different
 * languages in different repositories and nothing but this file connects them,
 * so the arithmetic is pinned on both sides.
 *
 * Why it matters: a stored id of 14 draws cat 4 on every device. If the server
 * clamped to 9 instead, then the moment that player saved their profile their
 * face would change under them, for a reason nothing on screen could explain.
 */
describe('folding an avatar id', () => {
  it('leaves an id already in range alone', () => {
    for (let id = 0; id < INPUT_LIMITS.avatarCount; id++) {
      expect(foldAvatarId(id)).toBe(id);
    }
  });

  it('wraps rather than clamping, matching the client', () => {
    // The whole point. A clamp would send all of these to 9.
    expect(foldAvatarId(10)).toBe(0);
    expect(foldAvatarId(14)).toBe(4);
    expect(foldAvatarId(17)).toBe(7);
  });

  it('carries every id the old catalogue could have written', () => {
    for (let legacy = 0; legacy < INPUT_LIMITS.legacyAvatarCount; legacy++) {
      const folded = foldAvatarId(legacy);
      expect(folded).toBeGreaterThanOrEqual(0);
      expect(folded).toBeLessThan(INPUT_LIMITS.avatarCount);
      // Deterministic: a player's face must not move between saves.
      expect(foldAvatarId(legacy)).toBe(folded);
    }
  });

  it('survives a negative, a fraction and a nonsense value', () => {
    // Ids arrive from older builds and, occasionally, from corrupt payloads.
    expect(foldAvatarId(-1)).toBe(1);
    expect(foldAvatarId(3.7)).toBe(3);
    expect(foldAvatarId(Number.NaN)).toBe(0);
    expect(foldAvatarId(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('keeps the stored bound wider than the catalogue', () => {
    // `updateProfile` saves with `runValidators`, so narrowing the schema to
    // the ten cats would make every pre-rebrand account unable to change its
    // own username until it happened to pick a new face.
    expect(INPUT_LIMITS.legacyAvatarCount).toBeGreaterThan(INPUT_LIMITS.avatarCount);
  });
});
