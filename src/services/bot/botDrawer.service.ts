import {
  BOT_BEHAVIOUR,
  BOT_LIMITS,
  type BotDifficultyWire,
} from '@/constants/autoTournament.constants';
import { hasTemplate, resolveTemplate, strokesFor } from '@/services/bot/drawingTemplates';
import type { PointTuple, StrokeDto } from '@/types/drawing.types';
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
 *
 * ## Why a plan can come back as a miss
 *
 * Because the honest answer to "draw a platypus" is that this library cannot,
 * and the alternative that used to be here — a generic face for every word it
 * did not know — was worse than silence: a guesser cannot tell a bot with
 * nothing to say from one that is confidently drawing the wrong thing. A miss
 * is returned, the caller logs which word to add, and the bot sits the turn
 * out. See the note in `drawingTemplates.ts`.
 */

/** One step of a drawing plan. */
export type DrawStep =
  | { kind: 'begin'; delayMs: number; stroke: StrokeDto }
  | { kind: 'append'; delayMs: number; strokeId: string; points: PointTuple[] }
  | { kind: 'end'; delayMs: number; strokeId: string };

/** A plan that will be drawn. */
export interface DrawPlan {
  ok: true;
  steps: DrawStep[];
  /** The word after normalisation, for the development log. */
  normalizedWord: string;
  /** The template this plan was built from. Always equal to `normalizedWord`. */
  templateKey: string;
  /** Strokes in the plan, after the difficulty cut. */
  strokeCount: number;
  /** The session this plan belongs to. Nothing else may replay it. */
  drawingSessionId: string;
  /** How long the whole plan takes, for the log and for the tests. */
  totalMs: number;
}

/** A turn this bot will sit out, and why. */
export interface NoDrawPlan {
  ok: false;
  normalizedWord: string;
  reason: 'no-template' | 'empty-template' | 'invalid-points' | 'key-mismatch';
}

export type PlanResult = DrawPlan | NoDrawPlan;

/** What binds a plan to one turn. Every field is server state. */
export interface DrawSession {
  /** `room.gameId`, or the room id before a game has an id. */
  gameId: string;
  roundId: string;
  /** The bot's roster id — `scribbler`, `doodler` — not its user id. */
  botId: string;
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
   *
   * ## Why it validates its own output
   *
   * Because every one of these checks is a bug that actually reached a canvas
   * once: a word drawing another word's picture, a template that built an
   * empty stroke list, a coordinate outside the unit square that the client
   * clamped into a straight line through the middle of a curve. They are cheap
   * — one pass over a few hundred points, once per turn — and each one turns a
   * silent wrong drawing into a logged skip.
   */
  plan(input: {
    word: string;
    difficulty: BotDifficultyWire;
    authorId: string;
    /** How long the turn runs, so the plan can be made to fit inside it. */
    turnMs: number;
    session: DrawSession;
  }): PlanResult {
    const { word, difficulty, authorId, turnMs, session } = input;

    const { normalizedWord, templateKey } = resolveTemplate(word);

    // Nothing draws this word. The caller logs it and the bot sits out; it
    // does not draw something else, which is what used to happen.
    if (templateKey === null) {
      return { ok: false, normalizedWord, reason: 'no-template' };
    }

    // The invariant the whole lookup exists to hold. It cannot fail through
    // `resolveTemplate` — both halves come from the one call — but it is the
    // thing that went wrong, so it is asserted rather than assumed.
    if (templateKey !== normalizedWord && !isAliasOf(templateKey, normalizedWord)) {
      return { ok: false, normalizedWord, reason: 'key-mismatch' };
    }

    const template = strokesFor(templateKey);
    if (template.length === 0 || template.some((stroke) => stroke.points.length === 0)) {
      return { ok: false, normalizedWord, reason: 'empty-template' };
    }
    if (!template.every((stroke) => stroke.points.every(isUnitPoint))) {
      return { ok: false, normalizedWord, reason: 'invalid-points' };
    }

    const behaviour = BOT_BEHAVIOUR[difficulty];

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

    return {
      ok: true,
      steps,
      normalizedWord,
      templateKey,
      strokeCount: chosen.length,
      drawingSessionId: drawingSessionId(session, normalizedWord),
      totalMs,
    };
  }

  /**
   * Which of the offered words a bot drawer takes.
   *
   * Prefers one it has a template for, which is the honest version of a player
   * picking the word they can draw — and which is now the main thing keeping
   * bots drawing at all, since a word with no template is a turn the bot sits
   * out. Falling back to a random index rather than always the first keeps two
   * bots offered the same three words from consistently choosing the same one.
   */
  chooseWordIndex(choices: readonly { text: string }[]): number {
    if (choices.length === 0) return 0;

    const drawable: number[] = [];
    choices.forEach((choice, index) => {
      if (hasTemplate(choice.text)) drawable.push(index);
    });

    if (drawable.length > 0) {
      return drawable[randomBelow(drawable.length)] ?? 0;
    }
    return randomBelow(choices.length);
  }
}

/**
 * The key a plan is bound to.
 *
 * ## Why this never goes on the wire
 *
 * It contains the answer. Its whole job is to let this process recognise its
 * own stale work — a timer from the previous round, a second plan for a turn
 * already being drawn — and that is a server-side question with a server-side
 * answer. Putting it in a `s:draw:*` payload would hand the word to every
 * guesser in the room, which is the one thing the engine may never do, so the
 * wire protocol is unchanged and drawing packets are authorised the way they
 * always were: against `round.drawerId`, by `drawingService.assertCanDraw`.
 *
 * It is logged only in development, where the log already prints the word.
 */
export function drawingSessionId(session: DrawSession, normalizedWord: string): string {
  return `${session.gameId}:${session.roundId}:${session.botId}:${normalizedWord}`;
}

/** Whether a normalised word reaches this key through the alias table. */
function isAliasOf(templateKey: string, normalizedWord: string): boolean {
  return resolveTemplate(normalizedWord).templateKey === templateKey;
}

/** A finite coordinate inside the unit square, pressure included. */
function isUnitPoint(point: PointTuple): boolean {
  return point.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
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
