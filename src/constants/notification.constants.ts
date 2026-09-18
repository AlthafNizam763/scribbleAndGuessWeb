/**
 * The notification vocabulary (brief section: Notifications Center).
 *
 * As with `social.constants.ts`, every string here travels on the wire: the
 * Flutter client parses `type` to pick an icon and a tap destination, so a
 * value changed here is a protocol change rather than a rename.
 */

/**
 * What a notification is about.
 *
 * ## Why the type is a closed set and the payload is open
 *
 * The client has to branch on the type — a friend request opens the requests
 * screen, a room invitation opens the invitation dialog — so the set has to be
 * one both sides agree on. What a given type *carries* differs wildly between
 * them, which is why `data` below is a free-form sub-document rather than a
 * union of schemas: the alternative is eleven near-identical collections.
 *
 * A client that meets a type it does not know renders the stored title and
 * body and does nothing on tap. That is what lets the server start sending a
 * new type before every installed client can act on it.
 */
export const NOTIFICATION_TYPE = {
  friendRequest: 'friend_request',
  friendRequestAccepted: 'friend_request_accepted',
  roomInvitation: 'room_invitation',
  friendStartedPlaying: 'friend_started_playing',
  friendJoinedRoom: 'friend_joined_room',
  userJoinedRoom: 'user_joined_room',
  gameResult: 'game_result',
  achievementUnlocked: 'achievement_unlocked',
  dailyChallengeCompleted: 'daily_challenge_completed',
  tournamentAnnouncement: 'tournament_announcement',
  /**
   * A tournament this player registered for has opened check-in.
   *
   * Its own type rather than another `tournament_announcement`, because the
   * two differ in the way that matters most: an announcement is news, and this
   * is a deadline. The client routes it straight to the tournament rather than
   * to the listing, and it is the only notification type this codebase also
   * delivers as a push.
   */
  tournamentCheckInOpen: 'tournament_checkin_open',
  systemAnnouncement: 'system_announcement',
} as const;

export type NotificationTypeWire = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

export const NOTIFICATION_TYPES = Object.values(NOTIFICATION_TYPE) as NotificationTypeWire[];

/**
 * Bounds on the collection and on one row.
 *
 * ## Why there is a retention window at all
 *
 * A notification is a nudge, not a record. Everything it points at — the
 * friend request, the invitation, the game — is stored authoritatively
 * somewhere else and outlives the nudge. So rows expire, and the TTL index on
 * the model is what enforces it; nothing in the application has to remember to
 * sweep. Thirty days is long enough that "notification history" means
 * something and short enough that the collection stays proportional to active
 * players rather than to all players who ever existed.
 */
export const NOTIFICATION_LIMITS = {
  defaultLimit: 25,
  maxLimit: 50,
  /** How long a row survives after it is created. */
  retentionDays: 30,
  /**
   * The ceiling the unread badge counts to.
   *
   * `countDocuments` on an unbounded unread set is `O(unread)`, and a player
   * who has not opened the app in a month can have thousands. The badge says
   * "99+" past this, so counting further would be work whose result is
   * discarded.
   */
  maxUnreadCount: 99,
  maxTitleLength: 80,
  maxBodyLength: 200,
} as const;

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

/**
 * The devices a token can belong to.
 *
 * `web` is here because the browser client can hold an FCM token too, and a
 * platform column that could not express that would push the distinction into
 * a comment somewhere. Nothing sends to `web` today.
 */
export const DEVICE_PLATFORM = {
  android: 'android',
  ios: 'ios',
  web: 'web',
} as const;

export type DevicePlatformWire = (typeof DEVICE_PLATFORM)[keyof typeof DEVICE_PLATFORM];

export const DEVICE_PLATFORMS = Object.values(DEVICE_PLATFORM) as DevicePlatformWire[];

/**
 * Bounds on a device registration.
 *
 * The token length bounds are a sanity check rather than a format check: FCM
 * registration tokens are opaque and have grown longer across SDK versions, so
 * anything that pins an exact shape would start rejecting valid devices on
 * some future release. The floor rejects obvious junk — an empty string, a
 * word — and the ceiling stops somebody posting a megabyte.
 */
export const DEVICE_TOKEN_LIMITS = {
  minTokenLength: 64,
  maxTokenLength: 4096,
  maxDeviceIdLength: 128,
  /**
   * How long an unused device registration survives.
   *
   * A year from `lastUsedAt`, which every registration and every successful
   * send pushes forward. Long, deliberately: this row is an address, and a
   * player returning after a break should keep theirs.
   */
  retentionSeconds: 365 * 24 * 60 * 60,
  /**
   * How many devices one person may be registered on.
   *
   * Not enforced by an index — a cap that rejected the *newest* device would
   * be exactly backwards — but by the registration path retiring the least
   * recently used row once the count is exceeded. Generous, because a phone, a
   * tablet and a reinstall of each is already four.
   */
  maxDevicesPerUser: 10,
} as const;

/**
 * The notification types that are also delivered as a push.
 *
 * A closed and deliberately short list. Every entry here is something with a
 * deadline attached — a player who misses it loses their place — which is the
 * only justification for interrupting somebody whose phone is in their pocket.
 * Everything else in `NOTIFICATION_TYPE` stays in the inbox.
 *
 * ## Why a room invitation is on this list
 *
 * Because it has the same shape as a check-in: it expires (`TIMING.
 * invitationTtlMs`), and the person it is addressed to is by construction not
 * looking at the app — a friend invites somebody precisely *because* they are
 * not already in the room. The socket cannot reach them: the client opens a
 * connection when it enters a room and at no other time, so an invitation
 * delivered only over `s:room:invitationReceived` reaches a player who is
 * already playing and nobody else. That is the whole of the "my friend never
 * got the invite" report — it was never a delivery failure, there was no
 * delivery path at all for an idle app.
 */
export const PUSH_NOTIFICATION_TYPE = {
  tournamentCheckInOpen: 'TOURNAMENT_CHECKIN_OPEN',
  roomInvitation: 'ROOM_INVITATION',
} as const;

export type PushNotificationTypeWire =
  (typeof PUSH_NOTIFICATION_TYPE)[keyof typeof PUSH_NOTIFICATION_TYPE];

export const PUSH_NOTIFICATION_TYPES = Object.values(
  PUSH_NOTIFICATION_TYPE,
) as PushNotificationTypeWire[];

/** How one attempted push ended. */
export const NOTIFICATION_LOG_STATUS = {
  sent: 'SENT',
  failed: 'FAILED',
  /** Claimed, but there was nothing to send to — no active device. */
  skipped: 'SKIPPED',
} as const;

export type NotificationLogStatusWire =
  (typeof NOTIFICATION_LOG_STATUS)[keyof typeof NOTIFICATION_LOG_STATUS];

export const NOTIFICATION_LOG_STATUSES = Object.values(
  NOTIFICATION_LOG_STATUS,
) as NotificationLogStatusWire[];

/**
 * Builds the idempotency key for one push.
 *
 * The printed form of the `userId + tournamentId + type` unique index. Kept as
 * a function so the two can never drift: every writer and every log line goes
 * through here.
 */
export function notificationKeyFor(
  type: PushNotificationTypeWire,
  tournamentId: string,
  userId: string,
): string {
  return `${type}:${tournamentId}:${userId}`;
}

/**
 * The Android channel the client creates and the server names on every send.
 *
 * Android ignores a channel id it has never been told about and silently
 * delivers the notification at default importance — which on a locked phone
 * means no heads-up and no sound, and looks exactly like "the push never
 * arrived". So the id is a shared constant rather than a literal typed twice,
 * and the Flutter client creates a channel with this exact id at startup.
 */
export const PUSH_ANDROID_CHANNEL = {
  id: 'tournament_notifications',
  name: 'Tournament Notifications',
} as const;

/**
 * The channel room invitations are delivered on.
 *
 * Its own channel rather than the tournament one, because an Android channel
 * is the unit a player mutes: somebody who does not play tournaments should be
 * able to silence those without also silencing a friend asking them to play.
 * Same importance — an invitation expires, so it has to raise a heads-up
 * banner rather than sit silently in the shade — and the same contract as
 * above: the Flutter client creates a channel with this exact id at startup.
 */
export const PUSH_INVITE_ANDROID_CHANNEL = {
  id: 'room_invitations',
  name: 'Room Invitations',
} as const;

/**
 * What a check-in push says.
 *
 * Server-authored, like every other notification in this codebase: the client
 * renders what it is given rather than composing anything, so the copy can be
 * changed without shipping an app build.
 */
export const CHECK_IN_PUSH_COPY = {
  title: '\u{1F3C6} Tournament Check-in is Open',
  body: 'Your Scribble & Guess tournament is ready. Check in now to enter your match.',
  /** Where a tap lands. Matched by the Flutter router's own path constant. */
  route: '/tournaments',
} as const;
