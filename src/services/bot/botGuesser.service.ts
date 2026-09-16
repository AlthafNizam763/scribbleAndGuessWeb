import {
  BOT_BEHAVIOUR,
  type BotDifficultyWire,
} from '@/constants/autoTournament.constants';
import { strokesFor, TEMPLATE_KEYS, type TemplateStroke } from '@/services/bot/drawingTemplates';
import type { PointTuple, StrokeDto } from '@/types/drawing.types';
import { normalizeGuess } from '@/utils/normalizeGuess';
import { randomBelow, shuffled } from '@/utils/random';

/**
 * How a bot decides what to guess.
 *
 * ## The rule this file exists to obey
 *
 * **The guesser never sees the word.** Not as an argument, not through a
 * service it can call, not in a field it could reach. Everything below is
 * computed from exactly what a human guesser has on screen: the masked word,
 * its length, which letters have been revealed, and the strokes on the board.
 * `round.word` is not imported, passed, or reachable from here — which is a
 * stronger statement than a check would be, because there is nothing to check.
 *
 * ## So how does it ever guess right?
 *
 * The same two ways a person does.
 *
 * **It reads the blanks.** `_ _ E _ _` with five letters excludes most of the
 * pool immediately, and each hint excludes more. Late in a turn on a short
 * word this alone often leaves a handful of candidates.
 *
 * **It looks at the drawing — coarsely.** Not with a recogniser; with a
 * handful of statistics anybody watching could describe. How many strokes are
 * on the board, how much of the canvas they cover, whether they sit high or
 * low, whether the ink is one colour or several, and which colours. A picture
 * that is mostly yellow radiating lines is a different *shape of drawing* from
 * one that is a single dark outline, and the bot has profiles of the same
 * statistics for every word it can draw. Matching one against the other is a
 * weak signal — deliberately weak — but it is real, it is derived only from
 * what is on the shared canvas, and it is why a HARD bot beats an EASY one at
 * the same masked word.
 *
 * ## Why difficulty is a rate and not a switch
 *
 * `accuracy` is the chance that one attempt is drawn from the *best-matching*
 * candidates rather than from all of them. A bot at 0.78 still guesses wrong
 * when its reading of the drawing is wrong, and a bot at 0.35 still gets there
 * when the blanks have narrowed things to two words. Neither ever short-
 * circuits to the answer, because neither has it.
 */

/** Everything the bot is allowed to know about the turn it is guessing in. */
export interface GuesserView {
  /** `_ _ E _ _`, exactly as every guesser's client renders it. */
  maskedWord: string;
  /** Letters in the word, or 0 while a `hidden`-mode turn withholds it. */
  wordLength: number;
  /** Which positions have been revealed. */
  hintIndices: readonly number[];
  /** The strokes on the shared board. The same array every client has. */
  strokes: readonly StrokeDto[];
  /** How far through the turn we are, 0..1. Drives how bold the bot is. */
  progress: number;
}

/** A word the bot may try. Comes from the room's own pool. */
export interface Candidate {
  text: string;
}

/**
 * The coarse description of a drawing, as anybody watching could give it.
 *
 * Every field is derived from stroke geometry and colour — nothing here knows
 * what the drawing depicts, and there is no path from a profile back to a word
 * except by comparing it with another profile.
 */
interface BoardProfile {
  strokeCount: number;
  /** How many distinct ink colours are on the board. */
  colourCount: number;
  /** Whether any non-black ink is present, and roughly which. */
  colours: Set<number>;
  /** Fraction of ink above the middle of the canvas. */
  topHeaviness: number;
  /** Width and height of the drawing's bounding box, 0..1 each. */
  spreadX: number;
  spreadY: number;
  /** Mean points per stroke: long flowing lines versus short marks. */
  meanStrokeLength: number;
}

/**
 * Template profiles, computed once.
 *
 * These describe the bot's *own* drawings, which is the only reason it has any
 * basis for comparison at all — it knows what its library looks like, and it
 * is looking at a canvas. Computed lazily and cached for the process, because
 * the templates never change.
 */
let templateProfiles: Map<string, BoardProfile> | null = null;

function profileOfTemplate(strokes: readonly TemplateStroke[]): BoardProfile {
  return profileOfPaths(
    strokes.map((stroke) => ({ points: stroke.points, colour: stroke.color })),
  );
}

function profileOfBoard(strokes: readonly StrokeDto[]): BoardProfile {
  return profileOfPaths(strokes.map((stroke) => ({ points: stroke.p, colour: stroke.c })));
}

/** The shared measurement, so a board and a template are described identically. */
function profileOfPaths(
  paths: readonly { points: readonly PointTuple[]; colour: number }[],
): BoardProfile {
  const colours = new Set<number>();
  let points = 0;
  let above = 0;
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;

  for (const path of paths) {
    colours.add(path.colour >>> 0);
    for (const [x, y] of path.points) {
      points += 1;
      if (y < 0.5) above += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return {
    strokeCount: paths.length,
    colourCount: colours.size,
    colours,
    topHeaviness: points === 0 ? 0.5 : above / points,
    spreadX: points === 0 ? 0 : Math.max(0, maxX - minX),
    spreadY: points === 0 ? 0 : Math.max(0, maxY - minY),
    meanStrokeLength: paths.length === 0 ? 0 : points / paths.length,
  };
}

function ensureTemplateProfiles(): Map<string, BoardProfile> {
  if (templateProfiles) return templateProfiles;

  templateProfiles = new Map();
  // Canonical keys only. Aliases resolve to the same drawing, so profiling
  // them too would weight a word more heavily for having more names.
  for (const key of TEMPLATE_KEYS) {
    templateProfiles.set(key, profileOfTemplate(strokesFor(key)));
  }
  return templateProfiles;
}

/**
 * How alike two drawings look, 0..1.
 *
 * Every term is bounded and the weights sum to one, so the result is directly
 * comparable between candidates and there is no term that can dominate because
 * of a scale mistake. The colour term is the heaviest because it is the most
 * discriminating thing visible without recognising anything: a drawing with
 * green in it is a plant or a tree, and one that is pure black outline is not.
 */
function similarity(board: BoardProfile, template: BoardProfile): number {
  const sharedColours = [...template.colours].filter((colour) => board.colours.has(colour)).length;
  const colourScore =
    template.colours.size === 0 ? 0 : sharedColours / template.colours.size;

  // A drawing in progress has fewer strokes than the finished template, so the
  // comparison is one-sided on purpose: having drawn *at least* a third of the
  // template's strokes counts as a match, and drawing more is not a penalty.
  const strokeRatio =
    template.strokeCount === 0
      ? 0
      : Math.min(1, board.strokeCount / Math.max(1, template.strokeCount * 0.6));

  const layoutScore = 1 - Math.min(1, Math.abs(board.topHeaviness - template.topHeaviness) * 2);
  const spreadScore =
    1 -
    Math.min(
      1,
      (Math.abs(board.spreadX - template.spreadX) + Math.abs(board.spreadY - template.spreadY)) /
        1.2,
    );
  const lengthScore =
    template.meanStrokeLength === 0
      ? 0
      : 1 -
        Math.min(
          1,
          Math.abs(board.meanStrokeLength - template.meanStrokeLength) /
            Math.max(8, template.meanStrokeLength),
        );

  return (
    colourScore * 0.4 +
    strokeRatio * 0.2 +
    layoutScore * 0.15 +
    spreadScore * 0.15 +
    lengthScore * 0.1
  );
}

/**
 * Whether a word could still be the answer, given the blanks.
 *
 * ## Why this is the strongest signal the bot has
 *
 * It is exact. A revealed letter at position three rules out every word
 * without that letter there, with no guessing involved — the server put it on
 * the screen. Length does the same from the moment the turn starts, except in
 * `hidden` mode where it is withheld and this check stands down.
 */
function fitsMask(word: string, view: GuesserView): boolean {
  const candidate = word.toLowerCase();

  // `maskedWord` is space-separated, one entry per position, `_` for hidden.
  const positions = view.maskedWord.split(' ').filter((entry) => entry.length > 0);

  if (view.wordLength > 0) {
    // Length is counted over maskable positions, so a word with a space or a
    // hyphen has fewer "letters" than characters. Comparing like for like.
    const letters = candidate.replace(/[^\p{L}\p{N}]/gu, '').length;
    if (letters !== view.wordLength) return false;
  }

  if (positions.length === 0) return true;

  // Walk the candidate's maskable characters against the revealed positions.
  const maskable = [...candidate].filter((char) => /[\p{L}\p{N}]/u.test(char));
  if (maskable.length !== positions.length) return true; // shapes disagree; length already checked

  for (let i = 0; i < positions.length; i++) {
    const shown = positions[i];
    if (!shown || shown === '_') continue;
    if (shown.toLowerCase() !== maskable[i]) return false;
  }

  return true;
}

export class BotGuesserService {
  /**
   * The next word this bot will try, or null when it has nothing to say.
   *
   * Null is a normal outcome: a bot with no plausible candidate stays quiet
   * rather than spamming the room, which is also what stops it burning its
   * guess rate limit on noise.
   */
  nextGuess(input: {
    view: GuesserView;
    pool: readonly Candidate[];
    /** Normalised words this bot has already tried this turn. */
    tried: ReadonlySet<string>;
    difficulty: BotDifficultyWire;
  }): string | null {
    const { view, pool, tried, difficulty } = input;

    const behaviour = BOT_BEHAVIOUR[difficulty];

    const eligible = pool.filter(
      (entry) => !tried.has(normalizeGuess(entry.text)) && fitsMask(entry.text, view),
    );

    if (eligible.length === 0) return null;

    // An early attempt is a shot in the dark for a person too — there is very
    // little on the canvas yet. Guessing from the whole eligible set here is
    // what makes a bot's first guess look like a first guess.
    const readingTheBoard = view.strokes.length >= 3 && view.progress > 0.15;

    // The difficulty roll. Losing it means this attempt ignores the drawing
    // and picks from everything the blanks allow — which is how a bot at any
    // difficulty still says something wrong sometimes.
    const usesBestMatch = readingTheBoard && Math.random() < behaviour.accuracy;

    if (!usesBestMatch) {
      const pick = eligible[randomBelow(eligible.length)];
      return pick ? pick.text : null;
    }

    const board = profileOfBoard(view.strokes);
    const profiles = ensureTemplateProfiles();

    let best: { text: string; score: number } | null = null;
    for (const entry of eligible) {
      const profile = profiles.get(normalizeGuess(entry.text));
      // A word the bot has never drawn has nothing to compare, so it scores
      // neutrally rather than zero — otherwise the bot would only ever name
      // words from its own drawing library, which would be conspicuous.
      const score = profile ? similarity(board, profile) : 0.35;
      if (!best || score > best.score) best = { text: entry.text, score };
    }

    return best?.text ?? null;
  }

  /**
   * How long to wait before the next attempt, in milliseconds.
   *
   * Re-rolled per attempt rather than fixed, so two bots in one match
   * interleave instead of guessing in lockstep every turn.
   */
  nextDelayMs(difficulty: BotDifficultyWire): number {
    const { min, max } = BOT_BEHAVIOUR[difficulty].guessDelayMs;
    return min + randomBelow(Math.max(1, max - min + 1));
  }

  /**
   * A handful of pool words to try, shuffled.
   *
   * Exposed so the caller can bound how much of a large pool the bot walks per
   * turn: a five-thousand-word pool filtered per attempt would be a scan per
   * guess per bot, which is real work on a busy server for a decision that
   * does not need the whole pool to be good.
   */
  narrowPool(pool: readonly Candidate[], limit = 400): Candidate[] {
    if (pool.length <= limit) return [...pool];
    return shuffled(pool).slice(0, limit);
  }
}

export const botGuesserService = new BotGuesserService();
