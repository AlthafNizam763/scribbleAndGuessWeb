import type {
  ConnectionWire,
  LanguageWire,
  RoomStatusWire,
  WordCategoryWire,
  WordModeWire,
} from '@/constants/room.constants';

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
}

/** `lib/models/player_profile.dart`, sent by the client on handshake. */
export interface PlayerProfileDto {
  id: string;
  name: string;
  avatarId: number;
  avatarColorIndex: number;
}
