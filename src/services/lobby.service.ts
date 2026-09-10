import { MIN_PLAYERS_TO_START } from '@/constants/game.constants';
import { GAME_PHASE } from '@/constants/room.constants';
import type { RuntimeRoom } from '@/types/socket.types';

/**
 * The lobby's own questions (brief section 4's "Lobby" box).
 *
 * Membership belongs to `room.service.ts` and the match belongs to
 * `game.service.ts`. What is left over is the handful of derived facts the
 * lobby screen needs — how many are ready, whether the host may start yet, and
 * why not — and they live here so both the REST handler and the socket handler
 * answer them identically.
 *
 * Nothing here mutates. These are queries over a room.
 */

export interface LobbySnapshot {
  playerCount: number;
  connectedCount: number;
  readyCount: number;
  minPlayers: number;
  canStart: boolean;
  /** Why `canStart` is false, ready to show the host. Null when it is true. */
  blockedReason: string | null;
}

export class LobbyService {
  snapshot(room: RuntimeRoom): LobbySnapshot {
    const players = [...room.players.values()];
    const connected = players.filter((player) => player.connection !== 'disconnected');
    const ready = connected.filter((player) => player.isReady);

    const inLobby = room.phase === GAME_PHASE.lobby || room.phase === GAME_PHASE.gameEnd;

    let blockedReason: string | null = null;
    if (!inLobby) blockedReason = 'A game is already in progress.';
    else if (connected.length < MIN_PLAYERS_TO_START) {
      blockedReason = `Waiting for ${MIN_PLAYERS_TO_START - connected.length} more player(s).`;
    }

    return {
      playerCount: players.length,
      connectedCount: connected.length,
      readyCount: ready.length,
      minPlayers: MIN_PLAYERS_TO_START,
      canStart: blockedReason === null,
      blockedReason,
    };
  }

  /**
   * Whether everybody present has pressed ready.
   *
   * Readiness is advisory here rather than a gate: the host can start a game
   * with somebody not ready, because otherwise one player who wandered off
   * could hold the whole room hostage. The client uses this to nudge, not to
   * block.
   */
  allReady(room: RuntimeRoom): boolean {
    const connected = [...room.players.values()].filter((p) => p.connection !== 'disconnected');
    return connected.length >= MIN_PLAYERS_TO_START && connected.every((p) => p.isReady);
  }
}

export const lobbyService = new LobbyService();
