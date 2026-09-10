import { CHAT_TYPE } from '@/constants/room.constants';
import { CLIENT_CHAT_SEND } from '@/constants/socket.constants';
import { parsePayload } from '@/middleware/validation.middleware';
import { chatService } from '@/services/chat.service';
import { gameService } from '@/services/game.service';
import { on } from '@/socket/handler';
import type { GameSocket } from '@/types/socket.types';
import { chatSendSchema, messageFrom } from '@/validators/guess.validator';
import { errors } from '@/utils/errors';

/**
 * Chat and guessing (brief sections 29 to 31, 35).
 *
 * ## One channel, three outcomes
 *
 * The client has a single text input. What happens to a message depends on
 * state only the server knows:
 *
 * - **Correct** — the text is swallowed and replaced by an announcement
 *   carrying only the guesser's name. Broadcasting the text would hand the
 *   answer to everyone still guessing.
 * - **Close** — a private note back to the guesser alone. Telling the room
 *   would narrow the answer for everybody.
 * - **Anything else** — ordinary chat, broadcast as-is.
 *
 * A player who has already guessed correctly can still chat, and the drawer's
 * messages are never evaluated as guesses, so neither can leak the word by
 * typing it.
 */
export function registerChatHandlers(socket: GameSocket): void {
  on(
    socket,
    CLIENT_CHAT_SEND,
    async ({ room, userId }, payload) => {
      const body = parsePayload(payload, chatSendSchema);
      const text = chatService.sanitize(messageFrom(body));

      const player = room.players.get(userId);
      if (!player) throw errors.notMember();

      // A muted player is refused before the guess is even evaluated, so mute
      // cannot be used to probe the word (brief section 43).
      if (player.isMuted) throw errors.muted();

      const { verdict } = await gameService.submitGuess({ room, userId, text });

      if (verdict === 'correct') {
        await chatService.correctGuess(room, player.username, userId);
        return { verdict };
      }

      if (verdict === 'close') {
        // Broadcast the guess as ordinary chat — it was wrong, after all — and
        // whisper the "so close" hint to its author.
        await chatService.broadcast({
          room,
          senderId: userId,
          senderName: player.username,
          text,
          type: CHAT_TYPE.guess,
        });
        chatService.closeGuess(userId, player.username, `"${text}" is very close!`);
        return { verdict };
      }

      // Outside a live turn this is lobby chat; during one it is a wrong
      // guess. The client styles the two differently, so the type says which.
      const inTurn = room.round !== null && !room.round.ended && room.phase === 'drawing';
      await chatService.broadcast({
        room,
        senderId: userId,
        senderName: player.username,
        text,
        type: inTurn && room.round?.drawerId !== userId ? CHAT_TYPE.guess : CHAT_TYPE.chat,
      });

      return { verdict };
    },
    // Shares the guess bucket: during a turn every message is a guess attempt,
    // and a separate chat limit would just be a second way to spend the same
    // budget.
    { limit: 'guess', requiresRoom: true },
  );
}
