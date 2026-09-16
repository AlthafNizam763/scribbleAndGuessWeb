import {
  BOT_BEHAVIOUR,
  BOT_LIMITS,
  type BotDifficultyWire,
} from '@/constants/autoTournament.constants';
import { templateFor } from '@/services/bot/drawingTemplates';
import type { PointTuple, StrokeDto } from '@/types/drawing.types';
import { logger } from '@/utils/logger';
import { normalizeGuess } from '@/utils/normalizeGuess';
import { newId, randomBelow } from '@/utils/random';

/**
 * How a bot draws.
 *
 * ## What this produces, and what it deliberately does not
 *
 * A *plan*: a flat list of steps — start a stroke, add these points, end it —
 * each with the delay that should precede it. It does not send anything. The
 * sending is done by `botPlayer.service.ts`, through the same
 * `drawingService` calls and the same `s:draw:*` broadcasts a human drawer's
 * packets go through.
 *
 * Splitting it this way is what makes the drawing testable without a socket,
 * and it is why there is no second drawing path in this codebase: a bot's
 * stroke is validated, stored on `room.board` and relayed by exactly the code
 * that handles a person's.
 *
 * ## Why it is a stream of batches and not one finished picture
 *
 * Because a drawing that appears all at once is not a drawing, it is a reveal
 * — nobody can guess from it *while it happens*, which is the entire game. The
 * plan paces the strokes across the turn so guessers watch a shape form, and
 * the batches are small for the same reason the client's are: a stroke arrives
 * as it is drawn.
 *
 * ## The three things difficulty changes
 *
 * How fast the batches go out, how much of the template is drawn at all, and
 * how much the hand shakes. An EASY bot draws seven tenths of a wobbly apple
 * slowly; a HARD bot draws all of a steady one quickly. None of them draws a
 * *different* apple, because the drawing is not where a match should be won.
 */

/** One step of a drawing plan. */
export type DrawStep =
  | { kind: 'begin'; delayMs: number; stroke: StrokeDto }
  | { kind: 'append'; delayMs: number; strokeId: string; points: PointTuple[] }
  | { kind: 'end'; delayMs: number; strokeId: string };

export interface DrawPlan {
  steps: DrawStep[];
  /** Whether a real template was found, so the caller can log a miss once. */
  matchedTemplate: boolean;
  /** How long the whole plan takes, for the log and for the tests. */
  totalMs: number;
}

export class BotDrawerService {
  /**
   * Builds the plan for one turn.
   *
   * ## Why the word is an argument here and nowhere else in the bot code
   *
   * Because this bot *is the drawer*. The server tells the drawer the word —
   * that is the game — and this is the drawer's hand. The guessing side of the
   * bot lives in a different module which has no way to reach this one, and
   * takes no word: see the note at the top of `botGuesser.service.ts`.
   *
   * ## Why the plan is bounded by the turn and by a stroke cap
   *
   * A turn is `drawTimeSeconds` long and the picture has to be finished inside
   * it — a drawing still being drawn at the buzzer helped nobody. So the
   * interval is compressed when a template is long or a turn is short, and the
   * stroke count is capped outright, which is also what stops a template bug
   * from filling a board.
   */
  plan(input: {
    word: string;
    difficulty: BotDifficultyWire;
    authorId: string;
    /** How long the turn runs, so the plan can be made to fit inside it. */
    turnMs: number;
  }): DrawPlan {
    const { word, difficulty, authorId, turnMs } = input;

    const behaviour = BOT_BEHAVIOUR[difficulty];
    const { strokes: template, matched } = templateFor(normalizeGuess(word));

    // How much of the template this difficulty bothers with. Always at least
    // one stroke: a bot that drew nothing would be a blank canvas nobody can
    // guess from, which is worse than a rough one.
    const wanted = Math.max(
      1,
      Math.min(
        BOT_LIMITS.maxStrokesPerTurn,
        Math.round(template.length * behaviour.strokeCompleteness),
      ),
    );
    const chosen = template.slice(0, wanted);

    // Every batch of every stroke, so the pacing can be computed against the
    // real number of packets rather than the number of strokes.
    const batched = chosen.map((stroke) => ({
      stroke,
      batches: chunk(
        stroke.points.map((point) => jitter(point, behaviour.jitter)),
        BOT_LIMITS.pointsPerBatch,
      ),
    }));

    const packetCount = batched.reduce((total, entry) => total + entry.batches.length, 0);

    // Aim to finish with a quarter of the turn to spare, so guessers have time
    // to read a *finished* drawing rather than racing the last stroke.
    const budgetMs = Math.max(1_000, turnMs * 0.75);
    const intervalMs =
      packetCount === 0
        ? behaviour.strokeIntervalMs
        : Math.min(behaviour.strokeIntervalMs, Math.floor(budgetMs / packetCount));

    const steps: DrawStep[] = [];
    let totalMs = 0;

    for (const { stroke, batches } of batched) {
      const strokeId = newId();
      const first = batches[0] ?? [];

      // The header carries the first batch, exactly as the client's `begin`
      // does — a stroke that began with no points would render as nothing
      // until its first append landed.
      steps.push({
        kind: 'begin',
        delayMs: intervalMs,
        stroke: {
          id: strokeId,
          a: authorId,
          p: first,
          c: stroke.color,
          w: stroke.width,
          t: stroke.tool,
          ts: 0,
        },
      });
      totalMs += intervalMs;

      for (const batch of batches.slice(1)) {
        steps.push({ kind: 'append', delayMs: intervalMs, strokeId, points: batch });
        totalMs += intervalMs;
      }

      // A pen lift between strokes. Short, and free — it is the packet that
      // tells every client the line stopped rather than merely paused.
      steps.push({ kind: 'end', delayMs: 0, strokeId });
    }

    logger.debug('bot drawing planned', {
      strokes: chosen.length,
      packets: packetCount,
      intervalMs,
      matchedTemplate: matched,
    });

    return { steps, matchedTemplate: matched, totalMs };
  }

  /**
   * Which of the offered words a bot drawer takes.
   *
   * Prefers one it has a template for, which is the honest version of a player
   * picking the word they can draw. Falling back to a random index rather than
   * always the first keeps two bots offered the same three words from
   * consistently choosing the same one.
   */
  chooseWordIndex(choices: readonly { text: string }[]): number {
    if (choices.length === 0) return 0;

    const drawable: number[] = [];
    choices.forEach((choice, index) => {
      if (templateFor(normalizeGuess(choice.text)).matched) drawable.push(index);
    });

    if (drawable.length > 0) {
      return drawable[randomBelow(drawable.length)] ?? 0;
    }
    return randomBelow(choices.length);
  }
}

/** Splits a point list into batches of at most `size`. */
function chunk(points: readonly PointTuple[], size: number): PointTuple[][] {
  if (points.length === 0) return [[]];

  const out: PointTuple[][] = [];
  for (let i = 0; i < points.length; i += size) {
    out.push(points.slice(i, i + size) as PointTuple[]);
  }
  return out;
}

/**
 * Nudges a point off the template, so the line reads as drawn.
 *
 * Clamped into the unit square here rather than relying on the drawing
 * service's clamp — a point pushed past an edge and flattened against it would
 * put a visible straight segment in the middle of a curve, which looks far
 * more wrong than the wobble was meant to look right.
 */
function jitter(point: PointTuple, amount: number): PointTuple {
  if (amount <= 0) return point;

  const [x, y] = point;
  const offset = (): number => (randomBelow(2001) / 1000 - 1) * amount;
  const clamp = (value: number): number => (value < 0.02 ? 0.02 : value > 0.98 ? 0.98 : value);

  return point.length === 3
    ? [clamp(x + offset()), clamp(y + offset()), point[2]]
    : [clamp(x + offset()), clamp(y + offset())];
}

export const botDrawerService = new BotDrawerService();
