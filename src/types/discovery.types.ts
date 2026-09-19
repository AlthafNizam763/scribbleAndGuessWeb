import type { GameId } from '@/games/game.types';

/**
 * How a client must join a discovered room.
 *
 * Not cosmetic, and not inferable from the game id by anyone but this server:
 * the platform runs two room engines, and a join sent to the wrong one is
 * rejected. Tagging each row with its route means the client never has to hold
 * a mapping of its own that can drift out of date the moment a game moves
 * between engines.
 *
 * - `ROOM` — the Scribble & Guess engine: `POST /api/rooms/:roomId/join`.
 * - `GAME_PLATFORM` — the generic engine: `POST /api/games/:gameId/rooms/:roomId/join`.
 */
export type RoomJoinRoute = 'ROOM' | 'GAME_PLATFORM';

/** One joinable public room, whatever game it belongs to. */
export interface DiscoverableRoomDto {
  gameId: GameId;
  /** The game's display name, so a client need not carry its own catalogue. */
  gameName: string;
  roomId: string;
  code: string;
  name: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  status: string;
  createdAtMs: number;
  joinVia: RoomJoinRoute;
}

/** A page of Quick Match results. */
export interface RoomDiscoveryPageDto {
  items: DiscoverableRoomDto[];
  total: number;
  /** The room the caller already holds a seat in, if any. */
  currentRoomId: string | null;
  currentRoomCode: string | null;
}
