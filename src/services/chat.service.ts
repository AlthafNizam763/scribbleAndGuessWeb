import { INPUT_LIMITS } from '@/constants/game.constants';
import { CHAT_TYPE, type ChatTypeWire } from '@/constants/room.constants';
import { SERVER_CHAT_MESSAGE } from '@/constants/socket.constants';
import { emitToRoom, emitToUser } from '@/config/socket';
import { ChatMessage } from '@/models/ChatMessage';
import type { ChatMessageDto } from '@/types/game.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { errors } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { newId } from '@/utils/random';

/**
 * Chat, and the guess channel that shares it (brief sections 35 and 36).
 *
 * ## Why guesses and chat are one channel
 *
 * That is how the client is built: `ChatPanel` is the only text input on the
 * game screen, and a player typing "guitar" during a turn is guessing, while
 * the same word typed in the lobby is chat. The distinction is made here,
 * server-side, by asking the game engine — never by the client labelling its
 * own message.
 *
 * ## What is never broadcast
 *
 * The text of a correct guess. It is replaced by an announcement carrying only
 * the guesser's name (brief section 31). Broadcasting the raw text would hand
 * the answer to everyone still guessing, which is the one thing the whole
 * word-privacy design exists to prevent. It is not persisted either, for the
 * same reason.
 */

export class ChatService {
  /** Builds a wire message. */
  private message(input: {
    senderId: string;
    senderName: string;
    text: string;
    type: ChatTypeWire;
  }): ChatMessageDto {
    return {
      id: newId(),
      senderId: input.senderId,
      senderName: input.senderName,
      text: input.text,
      type: input.type,
      timestampMs: Date.now(),
    };
  }

  /**
   * Writes a line to `chatMessages`.
   *
   * Fire-and-forget by design: chat is delivered over the socket, and the
   * document is history. A failed write should never delay or drop a message
   * that every player is already looking at.
   */
  private persist(room: RuntimeRoom, message: ChatMessageDto): void {
    void ChatMessage.create({
      roomId: room.roomId,
      gameId: room.gameId,
      roundId: room.round?.roundId ?? null,
      userId: message.senderId || null,
      username: message.senderName,
      message: message.text,
      type: message.type,
    }).catch((error: unknown) => {
      logger.exception('failed to persist a chat message', error, { roomId: room.roomId });
    });
  }

  /** Broadcasts a system line: joins, leaves, hints, phase announcements. */
  async system(room: RuntimeRoom, text: string): Promise<void> {
    const message = this.message({
      senderId: '',
      senderName: 'System',
      text,
      type: CHAT_TYPE.system,
    });

    emitToRoom(room.roomId, SERVER_CHAT_MESSAGE, { message });
    this.persist(room, message);
  }

  /** Broadcasts a join or leave notice. */
  async presence(room: RuntimeRoom, text: string, joined: boolean): Promise<void> {
    const message = this.message({
      senderId: '',
      senderName: 'System',
      text,
      type: joined ? CHAT_TYPE.playerJoined : CHAT_TYPE.playerLeft,
    });

    emitToRoom(room.roomId, SERVER_CHAT_MESSAGE, { message });
    this.persist(room, message);
  }

  /**
   * Announces that somebody got it, without saying what "it" was.
   *
   * Everyone sees the name; nobody sees the word. The guesser separately gets
   * their own points through the game state broadcast.
   */
  async correctGuess(room: RuntimeRoom, playerName: string, playerId: string): Promise<void> {
    const message = this.message({
      senderId: playerId,
      senderName: playerName,
      text: `${playerName} guessed correctly!`,
      type: CHAT_TYPE.correctGuess,
    });

    emitToRoom(room.roomId, SERVER_CHAT_MESSAGE, { message });
    this.persist(room, message);
  }

  /**
   * Tells one player privately that they were one letter off.
   *
   * Sent only to the guesser. Broadcasting "close!" to the room would narrow
   * the answer for everybody else, turning a near-miss into a shared hint.
   */
  closeGuess(playerId: string, playerName: string, text: string): void {
    const message = this.message({
      senderId: playerId,
      senderName: playerName,
      text,
      type: CHAT_TYPE.closeGuess,
    });

    emitToUser(playerId, SERVER_CHAT_MESSAGE, { message });
  }

  /**
   * Broadcasts an ordinary message or a wrong guess.
   *
   * Players who have already guessed correctly are not filtered out here — the
   * client shows their messages to everyone. Keeping them visible is
   * deliberate: a silenced half of the room feels like a bug.
   */
  async broadcast(input: {
    room: RuntimeRoom;
    senderId: string;
    senderName: string;
    text: string;
    type: ChatTypeWire;
  }): Promise<ChatMessageDto> {
    const message = this.message({
      senderId: input.senderId,
      senderName: input.senderName,
      text: input.text,
      type: input.type,
    });

    emitToRoom(input.room.roomId, SERVER_CHAT_MESSAGE, { message });
    this.persist(input.room, message);
    return message;
  }

  /**
   * Validates an incoming message (brief section 35).
   *
   * Length is counted in code points so an emoji is one character, matching
   * how the client's own validator counts and so agreeing on where the limit
   * falls. Control characters are stripped: a newline in a chat line would
   * break the row layout the client draws.
   */
  sanitize(raw: string): string {
    const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();

    if (cleaned.length === 0) throw errors.validation('Say something first.');

    const points = [...cleaned];
    if (points.length > INPUT_LIMITS.maxChatLength) {
      throw errors.validation(`Messages are limited to ${INPUT_LIMITS.maxChatLength} characters.`);
    }

    return cleaned;
  }

  /** The last `limit` lines of a room, oldest first. */
  async history(roomId: string, limit = INPUT_LIMITS.chatHistoryLimit) {
    const documents = await ChatMessage.find({ roomId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    return documents.reverse().map<ChatMessageDto>((doc) => ({
      id: String(doc._id),
      senderId: doc.userId ? String(doc.userId) : '',
      senderName: doc.username ?? '',
      text: doc.message,
      type: doc.type as ChatTypeWire,
      timestampMs: new Date(doc.createdAt ?? Date.now()).getTime(),
    }));
  }
}

export const chatService = new ChatService();
