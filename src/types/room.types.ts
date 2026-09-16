import type {
  ConnectionWire,
  InvitationStatusWire,
  LanguageWire,
  RoomStatusWire,
  WordCategoryWire,
  WordModeWire,
} from '@/constants/room.constants';
import type { UserSummaryDto } from '@/types/social.types';

/**
 * The room payloads exactly as the Flutter client parses them.
 *
 * Each interface here is the JSON counterpart of a Dart model in
 * `lib/models/`. Field names are the Dart `toJson` keys, not the Mongo field
 * names — `Player.id`, not `RoomPlayer.userId` — because these types describe
 * the wire, and the wire is what the client already knows how to read.
 *
 * The client's `fromJson` is defensive and substitutes a default for anything
 * missing, so a wrong key here does not crash the app; it silently shows a
 * zero. Getting these right is therefore worth more than usual.
 */

/** `lib/models/player.dart`. */
export interface PlayerDto {
  id: string;
  name: string;
  avatarId: number;
  avatarColorIndex: number;
  score: number;
  roundScore: number;
  isHost: boolean;
  isReady: boolean;
  /** Whether this player holds the pen this turn. */
  isDrawing: boolean;
  hasGuessed: boolean;
  /** Position in the correct-guess order, or null before they get it. */
  guessOrder: number | null;
  isMuted: boolean;
  connection: ConnectionWire;

  /** Which side this player is on. `none` outside a team mode. */
  team: string;

  /**
   * Whether this seat is an AI player.
   *
   * Sent on every player in every room snapshot, not only in tournament
   * matches, so a client renders the badge from what it was given rather than
   * from context it has to work out. False for everybody in an ordinary room.
   *
   * This is the "do not show AI bots as real humans" rule at the protocol
   * level: a client that ignores it is choosing to, rather than lacking the
   * information.
   */
  isBot: boolean;

  /** `EASY`, `NORMAL` or `HARD` for a bot; null for a person. */
  botDifficulty: string | null;
}

/** `lib/models/room_settings.dart`. */
export interface RoomSettingsDto {
  maxPlayers: number;
  rounds: number;
  drawTimeSeconds: number;
  wordChoiceCount: number;
  hintCount: number;
  wordSelectSeconds: number;
  wordMode: WordModeWire;
  language: LanguageWire;
  categories: WordCategoryWire[];
  customWords: string[];
  allowVoteKick: boolean;
  /** Whether guessers may talk to each other. The drawer never can. */
  voiceEnabled: boolean;
  /** Whether the text channel is open. Guessing is never affected. */
  chatEnabled: boolean;
  /** Which rule set the match runs under. */
  gameMode: string;
  /** Whether people may watch once the seats are full. */
  allowSpectators: boolean;
  /** Whether only the host's friends may join by code. */
  friendsOnly: boolean;
  /** Narrows the word pool, or null to let the mode decide. */
  wordDifficulty: string | null;
  isPrivate: boolean;
}

/** `lib/models/room.dart`, as broadcast on `s:room:state`. */
export interface RoomDto {
  id: string;
  code: string;
  hostId: string;
  players: PlayerDto[];
  settings: RoomSettingsDto;
  status: RoomStatusWire;
  createdAtMs: number;
  bannedIds: string[];

  /**
   * Who is watching without a seat.
   *
   * A separate list from `players` on the wire because it is a separate list
   * in the engine — a spectator is not a player with a flag, they are absent
   * from the turn order entirely.
   */
  spectators: SpectatorDto[];

  /** Whether the host has locked the room against new arrivals. */
  locked: boolean;
}

/** `lib/models/player_profile.dart`, sent by the client on handshake. */
export interface PlayerProfileDto {
  id: string;
  name: string;
  avatarId: number;
  avatarColorIndex: number;
}

// ---------------------------------------------------------------------------
// Invitations, the public room list and membership
// ---------------------------------------------------------------------------

/**
 * One room invitation, as both clients render it.
 *
 * ## Why the room facts are copied onto the invitation
 *
 * The invitee is not in the room and may not be allowed to read it — a private
 * room refuses `GET /api/rooms/:id` to anybody not seated in it. So everything
 * the brief says the invitation must show is stamped on the invitation itself:
 * the inviter, the code, the occupancy, the cap, whether it is public.
 *
 * These are a *snapshot taken when the list was read*, not a live feed. The
 * room can fill between the read and the tap, which is exactly why accepting
 * re-validates on the server rather than trusting what is on screen.
 */
export interface RoomInvitationDto {
  id: string;
  roomId: string;
  /** The code, so the client can join without a second lookup. */
  roomCode: string;
  status: InvitationStatusWire;
  /** Who sent it. Null only when that account has since been deleted. */
  inviter: UserSummaryDto | null;
  /** Who it is for. Present so an inviter's own view can name the target. */
  invitee: UserSummaryDto | null;
  /** Seats taken right now, or null when the room is no longer live. */
  playerCount: number | null;
  maxPlayers: number;
  /** False for a code-only room. Both are invitable; only one is listed. */
  isPublic: boolean;
  /** The coarse room status, or `closed` when the room is gone. */
  roomStatus: RoomStatusWire;
  createdAtMs: number;
  expiresAtMs: number;
}

/**
 * One friend as the invite sheet draws them.
 *
 * The three booleans are decided by the server and are the whole reason this
 * shape exists rather than reusing `FriendDto`: whether somebody is seated,
 * already asked, or reachable at all are facts about the *room*, and a client
 * that worked them out for itself would be deciding who it may invite.
 */
export interface InviteCandidateDto extends UserSummaryDto {
  /** Whether this friend currently holds a live socket. */
  isOnline: boolean;
  /** Whether they are already seated in this room. */
  isMember: boolean;
  /** Whether an unanswered invitation to this room already exists. */
  isInvited: boolean;
  /** Whether Invite may be offered at all, and why not when it may not. */
  canInvite: boolean;
  /** A short reason for `canInvite: false`, written for a player to read. */
  blockedReason: string | null;
  lastSeenAtMs: number;
}

/** One row of the public room list. Carries nothing a stranger may not see. */
export interface PublicRoomDto {
  id: string;
  code: string;
  /** The room's display name: the host's name possessive, e.g. `Ana's room`. */
  name: string;
  hostId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  status: RoomStatusWire;
  rounds: number;
  drawTimeSeconds: number;
  language: LanguageWire;
  createdAtMs: number;
}

/** The membership of one room, for `GET /api/rooms/:roomId/members`. */
export interface RoomMembersDto {
  roomId: string;
  roomCode: string;
  hostId: string;
  playerCount: number;
  maxPlayers: number;
  status: RoomStatusWire;
  members: PlayerDto[];
}

/**
 * Somebody watching a room.
 *
 * Deliberately smaller than `PlayerDto`: no score, no ready flag, no team, no
 * guess state. There is nothing here a scoreboard could render, which is the
 * point — a spectator has none of those things.
 */
export interface SpectatorDto {
  userId: string;
  username: string;
  avatarId: number;
  avatarColorIndex: number;
}
