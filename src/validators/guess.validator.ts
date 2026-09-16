import { z } from 'zod';

import { INPUT_LIMITS } from '@/constants/game.constants';

/**
 * Guess and chat validation (brief sections 29, 35 and 50).
 *
 * Length is measured in code points, matching the client's own validator,
 * which counts `runes`. Measuring in UTF-16 units instead would cut an emoji
 * in half and disagree with the counter the player is watching.
 */

const messageText = z
  .string()
  .transform((text) => text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim())
  .refine((text) => text.length > 0, { message: 'Say something first.' })
  .refine((text) => [...text].length <= INPUT_LIMITS.maxChatLength, {
    message: `Messages are limited to ${INPUT_LIMITS.maxChatLength} characters.`,
  });

/** `c:chat:send`, which doubles as the guess channel. */
export const chatSendSchema = z.object({
  text: messageText.optional(),
  // The brief's `guess:submit` names the field `guess`; the client sends
  // `text`. Both are accepted so either vocabulary works.
  guess: messageText.optional(),
  message: messageText.optional(),
}).refine((body) => (body.text ?? body.guess ?? body.message) !== undefined, {
  message: 'Say something first.',
});

/** Pulls the message out of whichever key the caller used. */
export function messageFrom(body: z.infer<typeof chatSendSchema>): string {
  return body.text ?? body.guess ?? body.message ?? '';
}

/**
 * The emoji a message may be reacted with.
 *
 * A closed set rather than "any single emoji". An open field would be a second
 * text channel — one that skips the length limit, the profanity mask and the
 * rate limiter — because a string of emoji is still a message. Six is enough
 * to say what a reaction says.
 */
export const CHAT_REACTIONS = ['👍', '😂', '🔥', '😮', '❤️', '👏'] as const;
export type ChatReaction = (typeof CHAT_REACTIONS)[number];

/** `c:chat:typing`. Carries nothing: the sender is the socket. */
export const chatTypingSchema = z.object({
  /** False when the player cleared their input without sending. */
  typing: z.boolean().catch(true).default(true),
});

/** `c:chat:react`. */
export const chatReactSchema = z.object({
  messageId: z.string().trim().min(1).max(64),
  emoji: z.enum(CHAT_REACTIONS),
});

/** `c:chat:delete` and `c:chat:report`. */
export const chatMessageTargetSchema = z.object({
  messageId: z.string().trim().min(1).max(64),
});

/** `c:chat:report`, which adds a reason. */
export const chatReportSchema = z.object({
  messageId: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(120).catch('').default(''),
});
