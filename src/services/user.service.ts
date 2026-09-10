import { INPUT_LIMITS } from '@/constants/game.constants';
import { userRepository } from '@/repositories/user.repository';
import { sanitizeUsername } from '@/services/auth.service';
import { errors } from '@/utils/errors';

/**
 * Profiles (brief section 8).
 *
 * The whole point of this service is the shape of `updateProfile`: it accepts
 * a name and an avatar and *nothing else*. Score, wins, games played and the
 * auth provider are not parameters, so there is no code path by which a
 * request body could reach them however it is spelled. Refusing them in a
 * validator would work too, but a validator can be bypassed by a future
 * caller; a function that cannot express the write cannot be.
 */

export interface PublicUser {
  id: string;
  username: string;
  avatarId: number;
  avatarColorIndex: number;
  authProvider: string;
  gamesPlayed: number;
  gamesWon: number;
  totalScore: number;
  bestRoundScore: number;
  createdAt: string;
  lastSeenAt: string;
}

export class UserService {
  async me(userId: string): Promise<PublicUser> {
    const user = await userRepository.findById(userId);
    if (!user) throw errors.auth('That account no longer exists.');

    return {
      id: String(user._id),
      username: user.username,
      avatarId: user.avatarId,
      avatarColorIndex: user.avatarColorIndex,
      authProvider: user.authProvider,
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon,
      totalScore: user.totalScore,
      bestRoundScore: user.bestRoundScore,
      createdAt: new Date(user.createdAt ?? Date.now()).toISOString(),
      lastSeenAt: new Date(user.lastSeenAt ?? Date.now()).toISOString(),
    };
  }

  /** Updates the two fields a player owns. */
  async updateProfile(
    userId: string,
    patch: { username?: string; avatarId?: number; avatarColorIndex?: number },
  ): Promise<PublicUser> {
    const update: { username?: string; avatarId?: number; avatarColorIndex?: number } = {};

    if (patch.username !== undefined) update.username = sanitizeUsername(patch.username);

    if (patch.avatarId !== undefined) {
      update.avatarId = clamp(patch.avatarId, INPUT_LIMITS.avatarCount);
    }
    if (patch.avatarColorIndex !== undefined) {
      update.avatarColorIndex = clamp(patch.avatarColorIndex, INPUT_LIMITS.avatarColorCount);
    }

    if (Object.keys(update).length === 0) throw errors.validation('Nothing to update.');

    const updated = await userRepository.updateProfile(userId, update);
    if (!updated) throw errors.auth('That account no longer exists.');

    return this.me(userId);
  }
}

/** Keeps an index inside the range the client can draw. */
function clamp(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0;
  const index = Math.floor(value);
  return index < 0 ? 0 : index >= count ? count - 1 : index;
}

export const userService = new UserService();
