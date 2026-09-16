import type { PointTuple } from '@/types/drawing.types';

/**
 * What a bot draws, and how it is described.
 *
 * ## Why templates and not a generative model
 *
 * A drawing has to be recognisable within eighty seconds by somebody who is
 * also typing. That is a very low bar for a human and a surprisingly high one
 * for anything procedural: a generated sketch of "umbrella" is a shape nobody
 * guesses, and a bot that draws unguessable pictures makes every match it
 * drawers in a dead round for the humans in it.
 *
 * So each word has a hand-specified path, in the same normalised 0..1
 * coordinate space the client draws in, and the bot's difficulty decides how
 * much of it gets drawn, how fast, and how shaky the line is. That is where the
 * variation belongs — a HARD bot draws the same apple as an EASY one, more
 * completely and more steadily.
 *
 * ## Why coordinates are normalised and slightly tall
 *
 * The canvas is 4:3 and the client normalises to it, so `[0.5, 0.5]` is the
 * centre on every device. Templates are drawn to sit inside roughly
 * `0.15..0.85` on both axes, which leaves a margin so a jittered point cannot
 * be clamped against an edge and flatten a curve.
 *
 * ## The fallback
 *
 * A word with no template is not an error. `templateFor` returns a generic
 * shape and the caller logs the miss, because the alternative — a bot that
 * stands still for eighty seconds, or worse throws inside a turn — costs a
 * real player a real round. The list below covers the common pool; anything
 * else draws something and the log says which word to add next.
 */

/** One stroke of a template, in the shape the drawing relay already speaks. */
export interface TemplateStroke {
  points: PointTuple[];
  /** ARGB, matching Dart's `Color.value`. */
  color: number;
  width: number;
  tool: 'pen' | 'marker' | 'brush';
}

/** Ink, and the two accents the templates use. */
const INK = 0xff222222;
const RED = 0xffd7443e;
const GREEN = 0xff3f8e4f;
const YELLOW = 0xffe8b33c;
const BLUE = 0xff3a6ea5;
const BROWN = 0xff8b5a2b;

/** A closed polygon: the points, with the first repeated to shut the outline. */
function closed(points: readonly [number, number][]): PointTuple[] {
  const first = points[0];
  if (!first) return [];
  return [...points, first].map(([x, y]) => [x, y] as PointTuple);
}

/** An open path. */
function path(points: readonly [number, number][]): PointTuple[] {
  return points.map(([x, y]) => [x, y] as PointTuple);
}

/**
 * An ellipse as a polyline.
 *
 * Sampled at 24 points, which is smooth enough that the client's curve
 * smoothing makes it look drawn rather than plotted, and few enough that a
 * circle is one modest batch rather than several.
 */
function ellipse(cx: number, cy: number, rx: number, ry: number, steps = 24): PointTuple[] {
  const points: PointTuple[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    points.push([cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]);
  }
  return points;
}

/** A partial arc, for smiles, hulls and handles. */
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fromRad: number,
  toRad: number,
  steps = 14,
): PointTuple[] {
  const points: PointTuple[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = fromRad + ((toRad - fromRad) * i) / steps;
    points.push([cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]);
  }
  return points;
}

/** Shorthand for a stroke in the default nib. */
function ink(points: PointTuple[], width = 4): TemplateStroke {
  return { points, color: INK, width, tool: 'pen' };
}

/** Shorthand for a coloured stroke. */
function tint(points: PointTuple[], color: number, width = 5): TemplateStroke {
  return { points, color, width, tool: 'marker' };
}

/**
 * The templates, keyed by the normalised word.
 *
 * Ordered roughly as a person would draw: outline first, then the detail that
 * identifies it. That order is preserved on the wire, so a guesser watching a
 * bot draw sees a shape resolve rather than details appear around nothing.
 */
const TEMPLATES: Readonly<Record<string, TemplateStroke[]>> = Object.freeze({
  apple: [
    ink(ellipse(0.5, 0.56, 0.2, 0.22)),
    ink(path([[0.5, 0.34], [0.52, 0.24], [0.5, 0.2]]), 3),
    tint(path([[0.52, 0.26], [0.64, 0.2], [0.58, 0.3], [0.52, 0.28]]), GREEN, 4),
  ],
  banana: [
    ink(arc(0.5, 0.35, 0.27, 0.3, 0.35 * Math.PI, 0.95 * Math.PI, 18)),
    ink(arc(0.5, 0.29, 0.31, 0.34, 0.38 * Math.PI, 0.92 * Math.PI, 18)),
    tint(path([[0.27, 0.62], [0.24, 0.68]]), YELLOW, 6),
  ],
  orange: [
    ink(ellipse(0.5, 0.54, 0.21, 0.21)),
    ink(path([[0.5, 0.33], [0.5, 0.27]]), 3),
    ink(arc(0.5, 0.54, 0.13, 0.13, 0, Math.PI * 2, 16), 2),
    tint(path([[0.52, 0.3], [0.62, 0.26]]), GREEN, 4),
  ],
  house: [
    ink(closed([[0.3, 0.75], [0.3, 0.48], [0.7, 0.48], [0.7, 0.75]])),
    ink(path([[0.26, 0.48], [0.5, 0.28], [0.74, 0.48]])),
    ink(closed([[0.44, 0.75], [0.44, 0.6], [0.56, 0.6], [0.56, 0.75]]), 3),
    ink(closed([[0.34, 0.56], [0.34, 0.52], [0.4, 0.52], [0.4, 0.56]]), 2),
  ],
  car: [
    ink(path([[0.22, 0.62], [0.24, 0.5], [0.36, 0.5], [0.44, 0.38], [0.62, 0.38], [0.68, 0.5], [0.8, 0.52], [0.8, 0.62]])),
    ink(path([[0.22, 0.62], [0.8, 0.62]])),
    ink(ellipse(0.34, 0.64, 0.055, 0.055, 16)),
    ink(ellipse(0.68, 0.64, 0.055, 0.055, 16)),
    ink(path([[0.46, 0.4], [0.46, 0.5]]), 2),
  ],
  tree: [
    ink(closed([[0.46, 0.76], [0.46, 0.56], [0.54, 0.56], [0.54, 0.76]])),
    tint(closed([[0.5, 0.24], [0.68, 0.46], [0.58, 0.46], [0.72, 0.58], [0.28, 0.58], [0.42, 0.46], [0.32, 0.46]]), GREEN, 5),
  ],
  cat: [
    ink(ellipse(0.5, 0.46, 0.16, 0.14)),
    ink(path([[0.38, 0.36], [0.35, 0.24], [0.46, 0.32]])),
    ink(path([[0.62, 0.36], [0.65, 0.24], [0.54, 0.32]])),
    ink(ellipse(0.44, 0.44, 0.017, 0.022, 10), 3),
    ink(ellipse(0.56, 0.44, 0.017, 0.022, 10), 3),
    ink(path([[0.44, 0.52], [0.5, 0.56], [0.56, 0.52]]), 2),
    ink(path([[0.34, 0.5], [0.24, 0.48]]), 2),
    ink(path([[0.34, 0.53], [0.24, 0.55]]), 2),
    ink(path([[0.66, 0.5], [0.76, 0.48]]), 2),
    ink(path([[0.66, 0.53], [0.76, 0.55]]), 2),
    ink(ellipse(0.5, 0.68, 0.13, 0.12)),
    ink(arc(0.68, 0.7, 0.1, 0.12, Math.PI * 1.4, Math.PI * 2.3, 12)),
  ],
  dog: [
    ink(ellipse(0.46, 0.46, 0.15, 0.13)),
    ink(arc(0.32, 0.46, 0.06, 0.12, Math.PI * 0.4, Math.PI * 1.6, 12)),
    ink(arc(0.6, 0.46, 0.06, 0.12, Math.PI * 1.4, Math.PI * 2.6, 12)),
    ink(ellipse(0.42, 0.44, 0.016, 0.018, 10), 3),
    ink(ellipse(0.52, 0.44, 0.016, 0.018, 10), 3),
    ink(ellipse(0.47, 0.53, 0.028, 0.02, 12), 3),
    ink(path([[0.47, 0.55], [0.47, 0.59]]), 2),
    ink(ellipse(0.55, 0.7, 0.16, 0.12)),
    ink(path([[0.7, 0.66], [0.78, 0.58]]), 3),
  ],
  book: [
    ink(closed([[0.26, 0.34], [0.5, 0.4], [0.74, 0.34], [0.74, 0.68], [0.5, 0.74], [0.26, 0.68]])),
    ink(path([[0.5, 0.4], [0.5, 0.74]])),
    ink(path([[0.32, 0.44], [0.46, 0.48]]), 2),
    ink(path([[0.32, 0.52], [0.46, 0.56]]), 2),
    ink(path([[0.54, 0.48], [0.68, 0.44]]), 2),
    ink(path([[0.54, 0.56], [0.68, 0.52]]), 2),
  ],
  phone: [
    ink(closed([[0.4, 0.24], [0.6, 0.24], [0.6, 0.78], [0.4, 0.78]])),
    ink(closed([[0.43, 0.3], [0.57, 0.3], [0.57, 0.7], [0.43, 0.7]]), 2),
    ink(ellipse(0.5, 0.745, 0.016, 0.016, 10), 2),
    ink(path([[0.46, 0.27], [0.54, 0.27]]), 2),
  ],
  flower: [
    tint(ellipse(0.5, 0.36, 0.06, 0.06, 14), RED, 5),
    tint(ellipse(0.38, 0.36, 0.06, 0.06, 14), RED, 5),
    tint(ellipse(0.62, 0.36, 0.06, 0.06, 14), RED, 5),
    tint(ellipse(0.5, 0.24, 0.06, 0.06, 14), RED, 5),
    tint(ellipse(0.5, 0.48, 0.06, 0.06, 14), RED, 5),
    tint(ellipse(0.5, 0.36, 0.045, 0.045, 12), YELLOW, 5),
    tint(path([[0.5, 0.54], [0.5, 0.78]]), GREEN, 4),
    tint(path([[0.5, 0.64], [0.62, 0.58], [0.5, 0.68]]), GREEN, 4),
  ],
  boat: [
    ink(path([[0.24, 0.62], [0.76, 0.62], [0.66, 0.74], [0.34, 0.74], [0.24, 0.62]])),
    ink(path([[0.5, 0.62], [0.5, 0.24]])),
    tint(closed([[0.52, 0.26], [0.72, 0.46], [0.52, 0.52]]), RED, 5),
    tint(closed([[0.48, 0.3], [0.3, 0.48], [0.48, 0.52]]), BLUE, 5),
    tint(path([[0.18, 0.8], [0.3, 0.78], [0.42, 0.8], [0.54, 0.78], [0.66, 0.8], [0.82, 0.78]]), BLUE, 4),
  ],
  sun: [
    tint(ellipse(0.5, 0.46, 0.14, 0.14), YELLOW, 6),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const angle = (i / 8) * Math.PI * 2;
      return tint(
        path([
          [0.5 + Math.cos(angle) * 0.19, 0.46 + Math.sin(angle) * 0.19],
          [0.5 + Math.cos(angle) * 0.28, 0.46 + Math.sin(angle) * 0.28],
        ]),
        YELLOW,
        5,
      );
    }),
  ],
  moon: [
    ink(arc(0.5, 0.5, 0.24, 0.26, Math.PI * 0.35, Math.PI * 1.65, 20)),
    ink(arc(0.38, 0.5, 0.3, 0.3, Math.PI * 1.72, Math.PI * 2.28, 16)),
    ink(ellipse(0.78, 0.26, 0.012, 0.012, 8), 2),
    ink(ellipse(0.84, 0.4, 0.01, 0.01, 8), 2),
  ],
  star: [
    ink(
      closed([
        [0.5, 0.22],
        [0.58, 0.44],
        [0.8, 0.44],
        [0.62, 0.57],
        [0.69, 0.78],
        [0.5, 0.65],
        [0.31, 0.78],
        [0.38, 0.57],
        [0.2, 0.44],
        [0.42, 0.44],
      ]),
      5,
    ),
  ],
  umbrella: [
    ink(arc(0.5, 0.52, 0.28, 0.26, Math.PI, Math.PI * 2, 22)),
    ink(path([[0.22, 0.52], [0.3, 0.58], [0.36, 0.52], [0.43, 0.58], [0.5, 0.52], [0.57, 0.58], [0.64, 0.52], [0.7, 0.58], [0.78, 0.52]])),
    ink(path([[0.5, 0.52], [0.5, 0.76]])),
    ink(arc(0.44, 0.76, 0.06, 0.06, 0, Math.PI, 10)),
  ],
  bicycle: [
    ink(ellipse(0.3, 0.62, 0.13, 0.13, 22)),
    ink(ellipse(0.7, 0.62, 0.13, 0.13, 22)),
    ink(path([[0.3, 0.62], [0.44, 0.62], [0.52, 0.42], [0.7, 0.62]])),
    ink(path([[0.44, 0.62], [0.52, 0.42]])),
    ink(path([[0.52, 0.42], [0.62, 0.42]])),
    ink(path([[0.4, 0.48], [0.5, 0.48]]), 3),
    ink(ellipse(0.44, 0.62, 0.03, 0.03, 10), 2),
  ],
  computer: [
    ink(closed([[0.24, 0.26], [0.76, 0.26], [0.76, 0.6], [0.24, 0.6]])),
    ink(closed([[0.28, 0.3], [0.72, 0.3], [0.72, 0.56], [0.28, 0.56]]), 2),
    ink(path([[0.44, 0.6], [0.44, 0.68], [0.56, 0.68], [0.56, 0.6]])),
    ink(path([[0.32, 0.72], [0.68, 0.72]]), 5),
  ],
  chair: [
    ink(path([[0.36, 0.24], [0.36, 0.56]])),
    ink(path([[0.62, 0.36], [0.62, 0.56]])),
    ink(path([[0.36, 0.56], [0.68, 0.56]])),
    ink(path([[0.36, 0.3], [0.62, 0.38]]), 2),
    ink(path([[0.36, 0.4], [0.62, 0.46]]), 2),
    ink(path([[0.38, 0.56], [0.38, 0.78]])),
    ink(path([[0.66, 0.56], [0.68, 0.78]])),
    ink(path([[0.36, 0.5], [0.68, 0.56]])),
  ],
  pizza: [
    ink(closed([[0.5, 0.24], [0.74, 0.72], [0.26, 0.72]])),
    tint(path([[0.28, 0.7], [0.72, 0.7]]), BROWN, 7),
    tint(ellipse(0.46, 0.5, 0.032, 0.032, 10), RED, 4),
    tint(ellipse(0.58, 0.6, 0.032, 0.032, 10), RED, 4),
    tint(ellipse(0.4, 0.63, 0.032, 0.032, 10), RED, 4),
    tint(ellipse(0.53, 0.38, 0.026, 0.026, 10), RED, 4),
  ],
});

/**
 * The generic shape used for a word nothing was drawn for.
 *
 * Deliberately a face rather than something evocative. A fallback that looked
 * like a specific object would send every guesser down one wrong path; a
 * neutral doodle says "no help here", the turn plays out on the hints, and the
 * round ends normally instead of ending badly.
 */
const FALLBACK: TemplateStroke[] = [
  ink(ellipse(0.5, 0.48, 0.2, 0.2)),
  ink(ellipse(0.43, 0.43, 0.018, 0.022, 10), 3),
  ink(ellipse(0.57, 0.43, 0.018, 0.022, 10), 3),
  ink(arc(0.5, 0.5, 0.1, 0.08, Math.PI * 0.15, Math.PI * 0.85, 12)),
];

/** Words a template exists for. Used by tests and by the coverage log. */
export const TEMPLATE_WORDS: readonly string[] = Object.freeze(Object.keys(TEMPLATES));

/**
 * The template for a word, and whether it was a real match.
 *
 * The key is the caller's already-normalised word, so "an Apple" and "apple"
 * find the same drawing. The `matched` flag is what lets the caller log a miss
 * exactly once per turn rather than guessing from the shape it got back.
 */
export function templateFor(normalizedWord: string): {
  strokes: TemplateStroke[];
  matched: boolean;
} {
  const direct = TEMPLATES[normalizedWord];
  if (direct) return { strokes: direct, matched: true };

  // A compound word usually contains one of these — "apple tree", "police
  // car", "full moon". Drawing the noun beats drawing nothing, and the caller
  // still records the miss so the word can get its own template later.
  for (const key of Object.keys(TEMPLATES)) {
    if (normalizedWord.includes(key)) {
      return { strokes: TEMPLATES[key] as TemplateStroke[], matched: false };
    }
  }

  return { strokes: FALLBACK, matched: false };
}
