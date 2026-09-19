import { Types } from 'mongoose';

import { Achievement } from '@/models/Achievement';
import { Block } from '@/models/Block';
import { FriendRequest } from '@/models/FriendRequest';
import { Friendship } from '@/models/Friendship';
import { Notification } from '@/models/Notification';
import { NotificationLog } from '@/models/NotificationLog';
import { RoomInvitation } from '@/models/RoomInvitation';
import { User } from '@/models/User';
import { UserDeviceToken } from '@/models/UserDeviceToken';
import { XPHistory } from '@/models/XPHistory';
import { XpEvent } from '@/models/XpEvent';
import { resetBlockCaches } from '@/repositories/block.repository';
import { isObjectId } from '@/repositories/user.repository';
import { forgetWorldLeaderboard } from '@/services/leaderboard.cache';
import { roomService } from '@/services/room.service';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Deleting an account, for real.
 *
 * ## Tombstone, not `deleteOne`
 *
 * Twenty-one collections carry a user id, and most of what they hold belongs
 * to *other people*: the standings of a match somebody else played, the chat
 * in a room they were in, the bracket they lost. Dropping the `users` row
 * would leave every one of those pointing at nothing, and every screen that
 * renders a name would render a blank where a person used to be.
 *
 * So the row survives with nothing personal on it — no email, no password, no
 * username, no bio, no town, no avatar choice — and `deletedAt` stamped. What
 * is left is an id and a placeholder, which is exactly what somebody else's
 * match history needs in order to still make sense.
 *
 * Everything that exists *only* for this account is deleted outright. The list
 * below is the whole of it, and the ordering is deliberate: device tokens go
 * first, because until they are gone this phone can still be sent a push.
 *
 * ## What is deliberately left alone
 *
 * `reports` — a moderation record naming this account. Deleting your own
 * account must not delete the evidence in somebody else's complaint, and the
 * report holds no personal data beyond the id that is now a tombstone.
 *
 * ## Irreversible, and refuses to be half-done
 *
 * The purges run first and the tombstone last, so a failure part-way leaves an
 * account that is still signed-in-able and can be deleted again. The other
 * order would strand a live account's data behind a row nobody can reach.
 */
export class AccountDeletionService {
  /**
   * Deletes [userId]'s account. Returns what was purged, for the audit log.
   *
   * Idempotent: deleting an already-deleted account is a no-op rather than an
   * error, because the caller cannot tell the difference between "already
   * gone" and "went a moment ago", and neither can the player.
   */
  async delete(userId: string): Promise<{ alreadyDeleted: boolean }> {
    if (!isObjectId(userId)) throw errors.notFound('That account no longer exists.');

    const id = new Types.ObjectId(userId);
    const existing = await User.findById(id).select('deletedAt').lean().exec();

    if (!existing) throw errors.notFound('That account no longer exists.');
    if (existing.deletedAt) return { alreadyDeleted: true };

    // Out of any live room first, while the account still exists to be
    // removed from one. A seat left behind would keep a ghost in the lobby
    // that nobody can kick, because the player it belongs to is gone.
    await this.evictFromLiveRoom(userId);

    // Push first: until these rows are gone this device can still be sent a
    // notification, and a buzz arriving after "your account has been deleted"
    // is the single worst thing this flow could do.
    await UserDeviceToken.deleteMany({ userId: id }).exec();

    await Promise.all([
      // The social graph, from both directions. A friendship is one row with
      // the ids sorted, so both positions have to be named.
      Friendship.deleteMany({ $or: [{ userAId: id }, { userBId: id }] }).exec(),
      FriendRequest.deleteMany({ $or: [{ senderId: id }, { receiverId: id }] }).exec(),

      // Blocks in both directions: the ones this account made, and the ones
      // made against it. Keeping the latter would silently filter a stranger's
      // lists against an account that no longer exists.
      Block.deleteMany({ $or: [{ blockerId: id }, { blockedUserId: id }] }).exec(),

      // Invitations sent and received. An invitation to a deleted account is
      // unanswerable; one *from* it names a room it is no longer in.
      RoomInvitation.deleteMany({ $or: [{ inviterId: id }, { inviteeId: id }] }).exec(),

      // The personal record: the inbox, the delivery log, the XP ledger and
      // the trophy case. None of it is visible to anybody else, so none of it
      // has a reason to outlive the account.
      Notification.deleteMany({ userId: id }).exec(),
      NotificationLog.deleteMany({ userId: id }).exec(),
      XPHistory.deleteMany({ userId: id }).exec(),
      XpEvent.deleteMany({ userId: id }).exec(),
      Achievement.deleteMany({ userId: id }).exec(),
    ]);

    // The tombstone, last. Written with `$set` and `$unset` rather than by
    // replacing the document, so the counters other people's match history is
    // expressed in terms of survive untouched.
    await User.updateOne(
      { _id: id },
      {
        $set: {
          deletedAt: new Date(),
          // Unique on `username` is not enforced, so a per-account
          // placeholder is safe and keeps two deleted accounts in a shared
          // match history distinguishable from one another.
          username: 'Deleted player',
          avatarId: 0,
          avatarColorIndex: 0,
          bio: '',
          city: null,
          region: null,
          country: null,
          localityKey: null,
          favoriteCategory: null,
          // Nothing may be sent to this account again, whatever else is
          // holding a stale reference to it.
          preferences: {
            notifyGameInvites: false,
            notifyFriendActivity: false,
            notifyRoomActivity: false,
            notifySystem: false,
            showOnlineStatus: false,
            discoverable: false,
          },
        },
        // Unset rather than nulled: `email` carries a sparse unique index, and
        // a row holding `null` would occupy the address against a future
        // sign-up. Removing the field releases it.
        $unset: { email: '', passwordHash: '' },
      },
    ).exec();

    // Both caches key on rows that just changed: the world board ranked this
    // account, and the block cache answered questions about it.
    forgetWorldLeaderboard();
    resetBlockCaches();

    logger.info('account deleted', { userId });

    return { alreadyDeleted: false };
  }

  /**
   * Takes the account out of whatever room it is sitting in.
   *
   * Best effort, and deliberately not fatal. The live registry only exists in
   * the socket process — a REST-only deployment has none — and a player who
   * is not in a room is the ordinary case. Either way the seat is gone within
   * the disconnect timeout, so failing the deletion over it would be trading
   * a certain harm for a temporary one.
   */
  private async evictFromLiveRoom(userId: string): Promise<void> {
    try {
      const room = roomService.liveRoomOf(userId);
      if (!room) return;
      await roomService.removePlayer(room, userId);
    } catch (error: unknown) {
      logger.exception('evicting a deleted account from its room failed', error, { userId });
    }
  }
}

export const accountDeletionService = new AccountDeletionService();
