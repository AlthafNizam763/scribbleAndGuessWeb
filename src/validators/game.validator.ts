import { z } from 'zod';

import { INPUT_LIMITS, ROOM_LIMITS } from '@/constants/game.constants';

/**
 * Game and drawing validation (brief sections 22, 23 and 50).
 */

/** `c:game:selectWord`. The index is bounds-checked against the real offer. */
export const selectWordSchema = z.object({
  index: z.coerce.number().int().min(0).max(ROOM_LIMITS.wordChoiceCount.max - 1),
});

/** `POST /api/games/start`. */
export const startGameSchema = z.object({
  roomId: z.string().trim().min(1).optional(),
  roomCode: z.string().trim().optional(),
});

/**
 * One drawing point: a two-element `[x, y]` array in the unit square.
 *
 * Out-of-range values are clamped rather than refused. A client normalises
 * against its own canvas box, and a value a fraction outside 0..1 is a
 * rounding artefact at the edge of a stroke — dropping the batch over it would
 * make lines visibly stutter at the canvas border.
 */
const pointSchema = z
  .tuple([z.number(), z.number()])
  .transform(([x, y]): [number, number] => [clampUnit(x), clampUnit(y)]);

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** `c:draw:begin`. */
export const strokeSchema = z.object({
  id: z.string().trim().min(1).max(64),
  // The author is overwritten from the authenticated socket; it is accepted
  // here only so a client's own payload shape validates.
  a: z.string().optional(),
  p: z.array(pointSchema).max(INPUT_LIMITS.maxPointsPerBatch).default([]),
  c: z.coerce.number().int().catch(0xff000000),
  w: z.coerce.number().min(0.5).max(80).catch(4),
  t: z.enum(['pen', 'eraser']).catch('pen'),
  ts: z.coerce.number().int().catch(0),
});

/** `c:draw:append`. */
export const strokeAppendSchema = z.object({
  strokeId: z.string().trim().min(1).max(64),
  points: z.array(pointSchema).max(INPUT_LIMITS.maxPointsPerBatch).default([]),
});

/** `c:draw:end`. */
export const strokeEndSchema = z.object({
  strokeId: z.string().trim().min(1).max(64),
});

/** `c:time:ping`. */
export const timePingSchema = z.object({
  t0: z.coerce.number().int().catch(0),
});
