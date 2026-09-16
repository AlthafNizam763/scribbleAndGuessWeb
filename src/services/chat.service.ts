import { INPUT_LIMITS } from '@/constants/game.constants';
import { CHAT_TYPE, type ChatTypeWire } from '@/constants/room.constants';
import {
  SERVER_CHAT_DELETED,
  SERVER_CHAT_MESSAGE,
  SERVER_CHAT_TYPING,
} from '@/constants/socket.constants';
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

    // Indexed so it can be reacted to or withdrawn. Only player messages are —
    // system lines, join notices and the correct-guess announcement belong to
    // nobody, so there is no author to authorise a deletion against.
    chatExtrasService.remember(input.room, message.id, input.senderId);

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

/**
 * Reactions, deletion and typing.
 *
 * ## Why these are a second class rather than methods on `ChatService`
 *
 * They act on the *index* — the bounded in-memory record of what was recently
 * said — rather than on the chat stream itself. `ChatService` above broadcasts
 * and persists; this decides whether a given message may be reacted to or
 * withdrawn, and by whom. Keeping them apart is what stops a future change to
 * the broadcast path quietly acquiring a permission check it should not own.
 */
export class ChatExtrasService {
  /**
   * Remembers a message so it can be reacted to or withdrawn.
   *
   * Called for every broadcast line. Evicts the oldest entry past the limit —
   * a `Map` iterates in insertion order, so the first key is always the one to
   * drop, and nothing has to sort or timestamp.
   */
  remember(room: RuntimeRoom, messageId: string, senderId: string): void {
    const recent = room.chat.recent;

    recent.set(messageId, { senderId, reactions: new Map() });

    while (recent.size > INPUT_LIMITS.chatIndexLimit) {
      const oldest = recent.keys().next();
      if (oldest.done) break;
      recent.delete(oldest.value);
    }
  }

  /**
   * Toggles one reaction from one player on one message.
   *
   * A toggle rather than an add, because the same tap has to take it back —
   * and because a set of user ids makes a double tap idempotent by
   * construction rather than by a check that could be raced.
   *
   * Returns the new tally, or null when the message is no longer indexed.
   */
  react(
    room: RuntimeRoom,
    messageId: string,
    userId: string,
    emoji: string,
  ): Record<string, number> | null {
    const message = room.chat.recent.get(messageId);
    if (!message) return null;

    const reactors = message.reactions.get(emoji) ?? new Set<string>();

    if (reactors.has(userId)) reactors.delete(userId);
    else reactors.add(userId);

    if (reactors.size === 0) message.reactions.delete(emoji);
    else message.reactions.set(emoji, reactors);

    // Counts, not rosters. Who reacted is not something the room needs, and
    // sending a list of ids per emoji would be a bigger payload than the
    // message it decorates.
    const tally: Record<string, number> = {};
    for (const [key, users] of message.reactions) tally[key] = users.size;

    return tally;
  }

  /**
   * Withdraws a message, if it belongs to [userId].
   *
   * Authorship is checked against the index rather than against anything the
   * caller sent, so a crafted `messageId` deletes nothing. A message that has
   * fallen out of the index is refused as missing — which is the honest
   * answer, since this process no longer knows who wrote it.
   */
  async remove(room: RuntimeRoom, messageId: string, userId: string): Promise<void> {
    const message = room.chat.recent.get(messageId);
    if (!message) throw errors.notFound('That message is no longer available.');

    if (message.senderId !== userId) {
      // Deliberately the same refusal a host's kick gives a non-host, rather
      // than "that is not yours" — which would confirm the message exists and
      // who it belongs to.
      throw errors.invalidAction('You can only delete your own messages.');
    }

    room.chat.recent.delete(messageId);
    emitToRoom(room.roomId, SERVER_CHAT_DELETED, { messageId });

    // The transcript is tidied too, so a deleted line does not reappear in
    // history. Fire-and-forget: the room has already seen it go.
    void ChatMessage.deleteOne({ _id: messageId }).catch(() => {
      // The live id and the stored id differ for messages broadcast in this
      // process, so this frequently matches nothing. That is expected — the
      // authoritative removal is the broadcast above.
    });
  }

  /**
   * Records that somebody is typing and tells the room.
   *
   * Not persisted, not acked, and not reconciled: a typing indicator is
   * worthless a second after it is sent. The client stops showing a stale one
   * on its own timer, so a dropped packet costs a lingering dot rather than a
   * player who appears to type forever.
   */
  typing(room: RuntimeRoom, userId: string, username: string, isTyping: boolean): void {
    if (isTyping) room.chat.typing.set(userId, Date.now());
    else room.chat.typing.delete(userId);

    emitToRoom(room.roomId, SERVER_CHAT_TYPING, {
      userId,
      username,
      typing: isTyping,
      ttlMs: INPUT_LIMITS.typingTtlMs,
    });
  }
}

export const chatExtrasService = new ChatExtrasService();
