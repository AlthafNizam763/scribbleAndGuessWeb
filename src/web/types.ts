/**
 * The wire shapes, as the browser client sees them.
 *
 * These are re-exported from the server's own type modules rather than
 * redeclared. Those files are the definition of the contract the Flutter app
 * already speaks, and a second hand-written copy here would be free to drift
 * from it — silently, because the client parses defensively and a wrong key
 * shows a default instead of throwing.
 *
 * The imports are type-only, so nothing server-side is pulled into the bundle.
 */
export type { PlayerDto, RoomSettingsDto, RoomDto, PlayerProfileDto } from '@/types/room.types';
export type {
  ChatMessageDto,
  GameResultDto,
  GameStateDto,
  HintDto,
  PlayerScoreDto,
  RoundResultDto,
  WordItemDto,
} from '@/types/game.types';
export type { PointTuple, StrokeAppendDto, StrokeDto } from '@/types/drawing.types';
export type {
  ChatTypeWire,
  ConnectionWire,
  DrawToolWire,
  GamePhaseWire,
  LanguageWire,
  RoomStatusWire,
  WordCategoryWire,
  WordModeWire,
} from '@/constants/room.constants';

/**
 * The invitation, browser and membership shapes.
 *
 * Re-exported for the same reason as everything above: the server defines the
 * contract, and a hand-written copy here would be free to drift from it.
 */
export type {
  InviteCandidateDto,
  PublicRoomDto,
  RoomInvitationDto,
  RoomMembersDto,
} from '@/types/room.types';
export type { InvitationStatusWire } from '@/constants/room.constants';
export type { FriendDto, UserSummaryDto } from '@/types/social.types';

/** The account the API hands back with a token. */
export interface AuthUserDto {
  id: string;
  username: string;
  avatarId: number;
  avatarColorIndex: number;
}

/** A signed-in session as this client holds it. */
export interface Session {
  token: string;
  user: AuthUserDto;
}
