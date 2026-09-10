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
