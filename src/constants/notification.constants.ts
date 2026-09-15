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
