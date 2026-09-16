import { CHAT_TYPE } from '@/constants/room.constants';
import {
  CLIENT_CHAT_DELETE,
  CLIENT_CHAT_REACT,
  CLIENT_CHAT_REPORT,
  CLIENT_CHAT_SEND,
  CLIENT_CHAT_TYPING,
  SERVER_CHAT_REACTION,
} from '@/constants/socket.constants';
import { emitToRoom } from '@/config/socket';
import { parsePayload } from '@/middleware/validation.middleware';
import { chatExtrasService, chatService } from '@/services/chat.service';
import { moderationService } from '@/services/moderation.service';
import { maskProfanity } from '@/utils/wordFilter';
import { gameService } from '@/services/game.service';
import { on } from '@/socket/handler';
import type { GameSocket } from '@/types/socket.types';
import {
  chatMessageTargetSchema,
  chatReactSchema,
  chatReportSchema,
  chatSendSchema,
  chatTypingSchema,
  messageFrom,
} from '@/validators/guess.validator';
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

      // The filter runs *after* the engine has judged the text, and this
      // ordering is the whole reason the feature is safe. The word list is
      // seeded data and the profanity list is code; they can overlap. Masking
      // first would make a round whose answer is on the list unwinnable, and
      // the player would have no way to know why.
      const { text: clean } = maskProfanity(text);

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
          text: clean,
          type: CHAT_TYPE.guess,
        });
        chatService.closeGuess(userId, player.username, `"${clean}" is very close!`);
        return { verdict };
      }

      // Outside a live turn this is lobby chat; during one it is a wrong
      // guess. The client styles the two differently, so the type says which.
      const inTurn = room.round !== null && !room.round.ended && room.phase === 'drawing';

      // Chat can be switched off; guessing cannot. A wrong guess during a turn
      // is still evaluated above and still costs its rate-limit token — it
      // simply is not relayed to the room. Refusing it outright would make a
      // chat-off room unplayable for anybody who guesses wrong.
      if (!room.settings.chatEnabled && !inTurn) {
        throw errors.invalidAction('Chat is off in this room.');
      }
      if (!room.settings.chatEnabled) return { verdict };

      await chatService.broadcast({
        room,
        senderId: userId,
        senderName: player.username,
        text: clean,
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

/**
 * Typing, reactions, deletion and message reports.
 *
 * ## Why these are separate handlers and separate buckets
 *
 * They are not guesses. Sharing the `guess` bucket — which the send handler
 * above does deliberately — would mean reacting to a message spent a token the
 * player needs to guess with, and a room reacting to a funny line would find
 * itself unable to play. So each gets a limit sized for what it is: typing is
 * the chattiest and the cheapest, reporting the rarest and the most expensive.
 */
export function registerChatExtrasHandlers(socket: GameSocket): void {
  on(
    socket,
    CLIENT_CHAT_TYPING,
    ({ room, userId }, payload) => {
      const { typing } = parsePayload(payload, chatTypingSchema);

      const player = room.players.get(userId);
      if (!player) throw errors.notMember();

      // A muted player's keystrokes are nobody's business: showing them as
      // typing would advertise a message that can never arrive.
      if (player.isMuted || !room.settings.chatEnabled) return {};

      chatExtrasService.typing(room, userId, player.username, typing);
      return {};
    },
    { limit: 'typing', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_CHAT_REACT,
    ({ room, userId }, payload) => {
      const { messageId, emoji } = parsePayload(payload, chatReactSchema);

      const player = room.players.get(userId);
      if (!player) throw errors.notMember();
      if (player.isMuted) throw errors.muted();

      const reactions = chatExtrasService.react(room, messageId, userId, emoji);
      if (reactions === null) {
        throw errors.notFound('That message is no longer available.');
      }

      emitToRoom(room.roomId, SERVER_CHAT_REACTION, { messageId, reactions });
      return { reactions };
    },
    { limit: 'chatAction', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_CHAT_DELETE,
    async ({ room, userId }, payload) => {
      const { messageId } = parsePayload(payload, chatMessageTargetSchema);

      await chatExtrasService.remove(room, messageId, userId);
      return {};
    },
    { limit: 'chatAction', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_CHAT_REPORT,
    async ({ room, userId }, payload) => {
      const { messageId, reason } = parsePayload(payload, chatReportSchema);

      const message = room.chat.recent.get(messageId);
      if (!message) throw errors.notFound('That message is no longer available.');

      // Reporting a message is reporting its author, so it goes through the
      // same service — and inherits its rules: no reporting yourself, one
      // report per pair, and nothing ever told to the person reported.
      await moderationService.report({
        room,
        reporterId: userId,
        targetId: message.senderId,
        reason: reason.length > 0 ? reason : 'Reported a chat message.',
      });

      return {};
    },
    { limit: 'report', requiresRoom: true },
  );
}
