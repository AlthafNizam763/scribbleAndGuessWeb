import {
  CLIENT_GAME_PLAY_AGAIN,
  CLIENT_GAME_SELECT_WORD,
  CLIENT_GAME_START,
} from '@/constants/socket.constants';
import { parsePayload } from '@/middleware/validation.middleware';
import { gameService } from '@/services/game.service';
import { on } from '@/socket/handler';
import type { GameSocket } from '@/types/socket.types';
import { selectWordSchema } from '@/validators/game.validator';

/**
 * Game flow over the socket (brief sections 17, 18, 22 and 48).
 *
 * Three verbs, all of them permission-checked inside the game service rather
 * than here: start and play-again are host-only, word selection is drawer-only.
 * Keeping the checks in the service means the REST `POST /api/games/start`
 * enforces exactly the same rule with the same code.
 */
export function registerGameHandlers(socket: GameSocket): void {
  on(
    socket,
    CLIENT_GAME_START,
    async ({ room, userId }) => {
      await gameService.startGame(room, userId);
    },
    { limit: 'action', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_GAME_SELECT_WORD,
    async ({ room, userId }, payload) => {
      const { index } = parsePayload(payload, selectWordSchema);
      await gameService.selectWord(room, userId, index);
    },
    { limit: 'action', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_GAME_PLAY_AGAIN,
    async ({ room, userId }) => {
      await gameService.playAgain(room, userId);
    },
    { limit: 'action', requiresRoom: true },
  );
}
