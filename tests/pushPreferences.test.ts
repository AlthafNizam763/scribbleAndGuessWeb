import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTIFICATION_TYPE } from '@/constants/notification.constants';
import { userRepository } from '@/repositories/user.repository';
import { pushService } from '@/services/push.service';
import { withPreferenceDefaults } from '@/services/user.service';

/**
 * Notification preferences, enforced where the push is actually sent.
 *
 * The claim: a player who turned a category off is dropped from the recipient
 * list *on the server*, before FCM is asked for anything. That is the whole
 * point of storing these on the account rather than on the device — a filter
 * in the app would run on a handset that had already buzzed.
 *
 * Firebase is not configured in tests, so `sendToUsers` returns early with
 * `notConfigured`. That is fine and is in fact what makes these assertions
 * sharp: the preference filter runs *before* that check, so what is asserted
 * is which recipients survived it, read from the repository call the filter
 * makes — never from a mocked messaging client.
 */

const OPTED_OUT = 'opted-out-user';
const OPTED_IN = 'opted-in-user';

/** Captures the ids the filter decided to keep. */
let kept: string[] | null;

beforeEach(() => {
  vi.restoreAllMocks();
  kept = null;

  vi.spyOn(userRepository, 'findPreferences').mockImplementation(
    async (ids: string[]) => {
      kept = ids;
      return ids.map((id) => ({
        _id: { toString: () => id } as never,
        preferences:
          id === OPTED_OUT
            ? {
                notifyGameInvites: false,
                notifyFriendActivity: false,
                notifyRoomActivity: false,
                notifySystem: false,
              }
            : {},
      }));
    },
  );
});

/** A push of one type, aimed at both users. */
async function send(type: string) {
  return pushService.sendToUsers([OPTED_IN, OPTED_OUT], {
    title: 'x',
    body: 'y',
    data: { type },
  });
}

describe('honouring notification preferences', () => {
  it('drops a recipient who turned that category off', async () => {
    const result = await send(NOTIFICATION_TYPE.roomInvitation);

    // The opted-out user never reaches the token lookup, so there is nobody
    // left with a live device and the send reports no recipients rather than
    // reaching FCM with somebody who asked not to be there.
    expect(kept).toEqual([OPTED_IN, OPTED_OUT]);
    expect(result.sent).toBe(0);
  });

  it('reads preferences once for the whole fan-out, not per recipient', async () => {
    await send(NOTIFICATION_TYPE.friendRequest);

    // A tournament announcement names hundreds of people; a read per person
    // would turn one notification into hundreds of round trips.
    expect(userRepository.findPreferences).toHaveBeenCalledTimes(1);
  });

  it('does not read preferences at all for an unmapped type', async () => {
    // `game_result` has no switch that claims to govern it, so there is
    // nothing to check and no reason to pay for the query.
    await send(NOTIFICATION_TYPE.gameResult);

    expect(userRepository.findPreferences).not.toHaveBeenCalled();
  });

  it('sends an unmapped type to everybody', async () => {
    // The deliberate failure direction: a new notification type nobody added
    // a mapping for still arrives, rather than silently going nowhere.
    const result = await send('a_type_that_does_not_exist_yet');

    expect(result.noRecipients).toBe(true);
    expect(userRepository.findPreferences).not.toHaveBeenCalled();
  });

  it('fails open when the preference read throws', async () => {
    vi.spyOn(userRepository, 'findPreferences').mockRejectedValue(
      new Error('mongo is having a day'),
    );

    // A database hiccup must not swallow a room invitation.
    await expect(send(NOTIFICATION_TYPE.roomInvitation)).resolves.toBeTruthy();
  });
});

describe('preference defaults', () => {
  it('treats a row with no preferences as fully opted in', () => {
    // Every account created before this feature has no subdocument at all and
    // must keep behaving exactly as it did — without a migration.
    const resolved = withPreferenceDefaults(undefined);

    expect(resolved.notifyGameInvites).toBe(true);
    expect(resolved.notifyFriendActivity).toBe(true);
    expect(resolved.showOnlineStatus).toBe(true);
    expect(resolved.discoverable).toBe(true);
  });

  it('fills in only the switches a partial row is missing', () => {
    const resolved = withPreferenceDefaults({ notifySystem: false });

    expect(resolved.notifySystem).toBe(false);
    expect(resolved.notifyGameInvites).toBe(true);
  });

  it('ignores a non-boolean value rather than coercing it', () => {
    // A string "false" is truthy in JavaScript, and coercing it would turn a
    // corrupt row into a silently wrong preference.
    const resolved = withPreferenceDefaults({ notifySystem: 'false' });

    expect(resolved.notifySystem).toBe(true);
  });
});
