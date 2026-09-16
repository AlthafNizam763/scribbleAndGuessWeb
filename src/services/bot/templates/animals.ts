import {
  BROWN,
  GREEN,
  GREY,
  ORANGE,
  PINK,
  PURPLE,
  RED,
  YELLOW,
  arc,
  circle,
  closed,
  dot,
  ellipse,
  eyes,
  ink,
  line,
  path,
  scallop,
  tint,
  triangle,
  zigzag,
  type TemplateBuilder,
} from '@/services/bot/drawingShapes';

/**
 * Animals.
 *
 * ## The rule every one of these follows
 *
 * The silhouette carries the word, and the face does not. A circle with two
 * eyes and a mouth is a *face* — it is the shape a guesser reads when the
 * drawer has given them nothing, and it is exactly what this library used to
 * put on the board for nine words in ten. So each animal here leads with the
 * thing only that animal has: the lion's mane, the fish's tail, the elephant's
 * trunk, the giraffe's neck. Eyes go on last and small, because they are the
 * least informative marks on the canvas.
 *
 * Strokes are ordered as a person would draw them — outline, then the
 * identifying feature, then detail — because that order is preserved on the
 * wire, and a guesser watching a bot draw should see the animal resolve rather
 * than see details appear around nothing.
 */
export const ANIMAL_TEMPLATES: Readonly<Record<string, TemplateBuilder>> = Object.freeze({
  /**
   * Lion.
   *
   * The mane first and largest: it is the whole word. A lion drawn face-first
   * is a cat until the mane lands, and on a small canvas the mane is the only
   * thing separating the two — so it is stroke one, and it is scalloped rather
   * than round.
   */
  lion: () => [
    tint(scallop(0.5, 0.46, 0.2, 0.28, 14), ORANGE, 6),
    ink(circle(0.5, 0.46, 0.155)),
    ink(arc(0.4, 0.34, 0.05, 0.05, Math.PI * 0.9, Math.PI * 2.1, 10), 3),
    ink(arc(0.6, 0.34, 0.05, 0.05, Math.PI * 0.9, Math.PI * 2.1, 10), 3),
    ...eyes(0.44, 0.56, 0.43, 0.016),
    ink(triangle(0.5, 0.52, 0.465, 0.485, 0.535, 0.485), 3),
    ink(path([[0.5, 0.52], [0.5, 0.555]]), 2),
    ink(arc(0.465, 0.55, 0.035, 0.03, 0, Math.PI, 8), 2),
    ink(arc(0.535, 0.55, 0.035, 0.03, 0, Math.PI, 8), 2),
    ink(line(0.36, 0.5, 0.42, 0.52), 2),
    ink(line(0.36, 0.56, 0.42, 0.55), 2),
    ink(line(0.64, 0.5, 0.58, 0.52), 2),
    ink(line(0.64, 0.56, 0.58, 0.55), 2),
  ],

  /**
   * Fish.
   *
   * A pointed body and a forked tail, drawn side-on. Deliberately not an
   * ellipse with a face on it: the tail is what makes the shape read as a fish
   * before anything else is on the board, so it lands second.
   */
  fish: () => [
    ink(
      path([
        [0.24, 0.5],
        [0.34, 0.38],
        [0.5, 0.35],
        [0.63, 0.42],
        [0.68, 0.5],
        [0.63, 0.58],
        [0.5, 0.65],
        [0.34, 0.62],
        [0.24, 0.5],
      ]),
    ),
    ink(path([[0.68, 0.5], [0.83, 0.37], [0.79, 0.5], [0.83, 0.63], [0.68, 0.5]])),
    ink(triangle(0.45, 0.36, 0.52, 0.24, 0.57, 0.38), 3),
    ink(path([[0.42, 0.63], [0.46, 0.73], [0.53, 0.62]]), 3),
    ink(arc(0.36, 0.5, 0.07, 0.12, Math.PI * 1.55, Math.PI * 2.45, 10), 2),
    dot(0.31, 0.47, 0.018),
    ink(arc(0.25, 0.53, 0.03, 0.025, Math.PI * 1.1, Math.PI * 1.9, 8), 2),
    tint(circle(0.2, 0.34, 0.022, 10), BROWN, 3),
    tint(circle(0.15, 0.25, 0.014, 8), BROWN, 3),
  ],

  /** Cat. Triangular ears and whiskers; the body sits behind the head. */
  cat: () => [
    ink(ellipse(0.5, 0.44, 0.16, 0.14)),
    ink(path([[0.38, 0.34], [0.35, 0.21], [0.47, 0.3]])),
    ink(path([[0.62, 0.34], [0.65, 0.21], [0.53, 0.3]])),
    ...eyes(0.44, 0.56, 0.42, 0.018),
    ink(triangle(0.5, 0.5, 0.475, 0.475, 0.525, 0.475), 2),
    ink(path([[0.44, 0.52], [0.5, 0.56], [0.56, 0.52]]), 2),
    ink(line(0.34, 0.47, 0.23, 0.45), 2),
    ink(line(0.34, 0.51, 0.23, 0.53), 2),
    ink(line(0.66, 0.47, 0.77, 0.45), 2),
    ink(line(0.66, 0.51, 0.77, 0.53), 2),
    ink(ellipse(0.5, 0.68, 0.13, 0.12)),
    ink(arc(0.7, 0.7, 0.11, 0.13, Math.PI * 1.4, Math.PI * 2.35, 12)),
  ],

  /** Dog. Floppy ears, a snout and a tail — the three things a cat has not. */
  dog: () => [
    ink(ellipse(0.46, 0.44, 0.15, 0.13)),
    ink(arc(0.31, 0.45, 0.07, 0.13, Math.PI * 0.35, Math.PI * 1.65, 12)),
    ink(arc(0.61, 0.45, 0.07, 0.13, Math.PI * 1.35, Math.PI * 2.65, 12)),
    ink(ellipse(0.46, 0.53, 0.07, 0.05, 16)),
    ...eyes(0.41, 0.52, 0.42, 0.016),
    ink(ellipse(0.46, 0.51, 0.028, 0.02, 12), 3),
    ink(path([[0.46, 0.53], [0.46, 0.57]]), 2),
    ink(ellipse(0.57, 0.7, 0.16, 0.12)),
    ink(path([[0.72, 0.66], [0.8, 0.56], [0.76, 0.66]]), 3),
  ],

  /** Bird. A teardrop body, a wing, a beak and two twig legs. */
  bird: () => [
    ink(
      path([
        [0.36, 0.52],
        [0.42, 0.36],
        [0.56, 0.32],
        [0.66, 0.42],
        [0.62, 0.58],
        [0.46, 0.62],
        [0.36, 0.52],
      ]),
    ),
    ink(circle(0.36, 0.4, 0.09)),
    ink(triangle(0.28, 0.4, 0.17, 0.44, 0.28, 0.46), 3),
    dot(0.35, 0.37, 0.014),
    ink(arc(0.52, 0.47, 0.09, 0.07, Math.PI * 0.9, Math.PI * 2.0, 10), 3),
    ink(path([[0.66, 0.44], [0.8, 0.36], [0.72, 0.5]]), 3),
    ink(line(0.48, 0.62, 0.46, 0.72), 2),
    ink(line(0.56, 0.61, 0.58, 0.71), 2),
  ],

  /** Elephant. The trunk is the word; everything else is a big grey mass. */
  elephant: () => [
    ink(ellipse(0.55, 0.5, 0.22, 0.18)),
    tint(circle(0.31, 0.46, 0.14), GREY, 6),
    ink(path([[0.24, 0.54], [0.2, 0.66], [0.24, 0.76], [0.33, 0.78], [0.35, 0.7]])),
    ink(arc(0.36, 0.42, 0.12, 0.14, Math.PI * 1.3, Math.PI * 2.7, 14), 3),
    dot(0.27, 0.42, 0.015),
    ink(line(0.44, 0.68, 0.44, 0.78), 4),
    ink(line(0.58, 0.68, 0.58, 0.78), 4),
    ink(line(0.7, 0.66, 0.71, 0.78), 4),
    ink(path([[0.77, 0.44], [0.84, 0.38], [0.82, 0.5]]), 2),
  ],

  /** Tiger. A cat's head with stripes — the stripes are drawn big and early. */
  tiger: () => [
    tint(ellipse(0.5, 0.48, 0.21, 0.19), ORANGE, 6),
    ink(arc(0.36, 0.33, 0.055, 0.055, Math.PI * 0.85, Math.PI * 2.15, 10), 3),
    ink(arc(0.64, 0.33, 0.055, 0.055, Math.PI * 0.85, Math.PI * 2.15, 10), 3),
    ink(path([[0.5, 0.29], [0.5, 0.36]]), 5),
    ink(path([[0.36, 0.36], [0.39, 0.43]]), 5),
    ink(path([[0.64, 0.36], [0.61, 0.43]]), 5),
    ink(path([[0.3, 0.52], [0.38, 0.53]]), 5),
    ink(path([[0.7, 0.52], [0.62, 0.53]]), 5),
    ...eyes(0.43, 0.57, 0.46, 0.018),
    ink(triangle(0.5, 0.56, 0.47, 0.52, 0.53, 0.52), 3),
    ink(path([[0.44, 0.59], [0.5, 0.63], [0.56, 0.59]]), 2),
  ],

  /** Monkey. The pale face ring inside a round head, plus a curling tail. */
  monkey: () => [
    tint(circle(0.46, 0.42, 0.16), BROWN, 6),
    ink(ellipse(0.46, 0.46, 0.1, 0.11, 18)),
    ink(circle(0.28, 0.42, 0.055, 12), 3),
    ink(circle(0.64, 0.42, 0.055, 12), 3),
    ...eyes(0.42, 0.5, 0.42, 0.015),
    ink(ellipse(0.46, 0.5, 0.025, 0.018, 10), 2),
    ink(arc(0.46, 0.5, 0.05, 0.04, Math.PI * 0.1, Math.PI * 0.9, 10), 2),
    ink(ellipse(0.52, 0.68, 0.12, 0.13)),
    ink(arc(0.68, 0.72, 0.1, 0.09, Math.PI * 1.1, Math.PI * 2.6, 14), 3),
  ],

  /** Cow. Patches first — an unpatched cow is a horse. */
  cow: () => [
    ink(ellipse(0.5, 0.56, 0.24, 0.16)),
    ink(circle(0.5, 0.35, 0.11)),
    ink(ellipse(0.5, 0.39, 0.07, 0.045, 14), 2),
    ink(arc(0.38, 0.3, 0.05, 0.05, Math.PI * 0.6, Math.PI * 1.8, 8), 3),
    ink(arc(0.62, 0.3, 0.05, 0.05, Math.PI * 1.2, Math.PI * 2.4, 8), 3),
    ...eyes(0.46, 0.54, 0.32, 0.014),
    ink(ellipse(0.38, 0.52, 0.06, 0.045, 14), 3),
    ink(ellipse(0.62, 0.6, 0.05, 0.04, 14), 3),
    ink(line(0.36, 0.7, 0.36, 0.8), 4),
    ink(line(0.64, 0.7, 0.64, 0.8), 4),
  ],

  /** Pig. Snout, curly tail, triangular ears. */
  pig: () => [
    tint(ellipse(0.5, 0.52, 0.22, 0.17), PINK, 6),
    ink(ellipse(0.5, 0.56, 0.08, 0.06, 16)),
    ink(line(0.475, 0.54, 0.475, 0.58), 3),
    ink(line(0.525, 0.54, 0.525, 0.58), 3),
    ink(triangle(0.34, 0.4, 0.33, 0.28, 0.44, 0.35), 3),
    ink(triangle(0.66, 0.4, 0.67, 0.28, 0.56, 0.35), 3),
    ...eyes(0.43, 0.57, 0.44, 0.015),
    ink(arc(0.76, 0.56, 0.05, 0.05, Math.PI * 1.2, Math.PI * 3.2, 14), 3),
    ink(line(0.4, 0.68, 0.4, 0.78), 4),
    ink(line(0.6, 0.68, 0.6, 0.78), 4),
  ],

  /** Duck. The flat bill and the water line do the work. */
  duck: () => [
    ink(ellipse(0.52, 0.56, 0.2, 0.13)),
    ink(circle(0.34, 0.38, 0.1)),
    ink(path([[0.25, 0.38], [0.14, 0.41], [0.25, 0.45]])),
    dot(0.33, 0.35, 0.014),
    ink(arc(0.56, 0.52, 0.1, 0.08, Math.PI * 0.95, Math.PI * 2.05, 10), 3),
    ink(path([[0.72, 0.5], [0.8, 0.42], [0.76, 0.54]]), 3),
    tint(
      path([[0.18, 0.72], [0.32, 0.7], [0.46, 0.72], [0.6, 0.7], [0.74, 0.72], [0.86, 0.7]]),
      0xff3a6ea5,
      4,
    ),
  ],

  /** Frog. Eyes on top of the head, wide mouth, splayed legs. */
  frog: () => [
    tint(ellipse(0.5, 0.56, 0.2, 0.16), GREEN, 6),
    ink(circle(0.41, 0.36, 0.07)),
    ink(circle(0.59, 0.36, 0.07)),
    dot(0.41, 0.37, 0.018),
    dot(0.59, 0.37, 0.018),
    ink(arc(0.5, 0.52, 0.12, 0.09, Math.PI * 0.1, Math.PI * 0.9, 12), 3),
    ink(path([[0.3, 0.62], [0.22, 0.72], [0.32, 0.74]]), 3),
    ink(path([[0.7, 0.62], [0.78, 0.72], [0.68, 0.74]]), 3),
  ],

  /** Bear. Round ears set wide, a heavy muzzle. */
  bear: () => [
    tint(circle(0.5, 0.44, 0.19), BROWN, 6),
    ink(circle(0.32, 0.29, 0.06, 14), 3),
    ink(circle(0.68, 0.29, 0.06, 14), 3),
    ink(ellipse(0.5, 0.52, 0.09, 0.07, 16)),
    ink(ellipse(0.5, 0.48, 0.03, 0.022, 10), 3),
    ink(path([[0.5, 0.5], [0.5, 0.55]]), 2),
    ...eyes(0.43, 0.57, 0.4, 0.016),
    ink(ellipse(0.5, 0.73, 0.16, 0.11)),
  ],

  /** Snake. One long curve and a forked tongue. */
  snake: () => [
    ink(
      path([
        [0.16, 0.7],
        [0.3, 0.62],
        [0.3, 0.5],
        [0.18, 0.42],
        [0.24, 0.3],
        [0.4, 0.26],
        [0.56, 0.3],
        [0.66, 0.4],
        [0.78, 0.42],
      ]),
      6,
    ),
    ink(ellipse(0.8, 0.42, 0.06, 0.045, 16)),
    dot(0.81, 0.4, 0.012),
    ink(path([[0.86, 0.43], [0.92, 0.4]]), 2),
    ink(path([[0.86, 0.43], [0.92, 0.47]]), 2),
    ink(circle(0.3, 0.56, 0.02, 8), 2),
    ink(circle(0.42, 0.3, 0.02, 8), 2),
  ],

  /** Mouse. Enormous round ears and a thin tail. */
  mouse: () => [
    ink(ellipse(0.5, 0.56, 0.16, 0.13)),
    ink(circle(0.37, 0.36, 0.09)),
    ink(circle(0.63, 0.36, 0.09)),
    ...eyes(0.45, 0.55, 0.53, 0.014),
    ink(ellipse(0.5, 0.63, 0.022, 0.016, 10), 3),
    ink(line(0.42, 0.62, 0.32, 0.6), 2),
    ink(line(0.58, 0.62, 0.68, 0.6), 2),
    ink(arc(0.74, 0.62, 0.1, 0.1, Math.PI * 1.05, Math.PI * 2.4, 12), 3),
  ],

  /** Horse. The long head and the mane, seen side-on. */
  horse: () => [
    ink(ellipse(0.55, 0.56, 0.22, 0.14)),
    ink(path([[0.38, 0.5], [0.3, 0.32], [0.22, 0.28], [0.18, 0.36], [0.26, 0.44], [0.34, 0.56]])),
    ink(triangle(0.28, 0.3, 0.29, 0.22, 0.34, 0.3), 2),
    dot(0.24, 0.33, 0.012),
    tint(path([[0.3, 0.3], [0.38, 0.38], [0.36, 0.46], [0.44, 0.5]]), BROWN, 5),
    ink(line(0.44, 0.68, 0.43, 0.8), 4),
    ink(line(0.56, 0.69, 0.56, 0.8), 4),
    ink(line(0.7, 0.68, 0.71, 0.8), 4),
    ink(path([[0.77, 0.48], [0.85, 0.56], [0.82, 0.68]]), 3),
  ],

  /** Sheep. A cloud of fleece with a dark face and thin legs. */
  sheep: () => [
    ink(scallop(0.52, 0.5, 0.16, 0.21, 11)),
    ink(ellipse(0.3, 0.48, 0.08, 0.07, 16)),
    ink(arc(0.24, 0.42, 0.04, 0.04, Math.PI * 0.7, Math.PI * 1.9, 8), 2),
    dot(0.28, 0.46, 0.012),
    ink(line(0.42, 0.68, 0.42, 0.79), 3),
    ink(line(0.52, 0.69, 0.52, 0.79), 3),
    ink(line(0.62, 0.68, 0.62, 0.79), 3),
  ],

  /** Rabbit. Two tall ears, which is the entire silhouette. */
  rabbit: () => [
    ink(ellipse(0.45, 0.35, 0.05, 0.13, 18)),
    ink(ellipse(0.57, 0.34, 0.05, 0.13, 18)),
    ink(circle(0.51, 0.52, 0.12)),
    ...eyes(0.46, 0.56, 0.5, 0.015),
    ink(ellipse(0.51, 0.57, 0.02, 0.015, 10), 3),
    ink(line(0.44, 0.58, 0.34, 0.56), 2),
    ink(line(0.58, 0.58, 0.68, 0.56), 2),
    ink(ellipse(0.55, 0.72, 0.12, 0.09)),
    ink(circle(0.7, 0.75, 0.04, 12), 3),
  ],

  /** Giraffe. Neck first: nothing else in the bank is that shape. */
  giraffe: () => [
    tint(path([[0.42, 0.72], [0.44, 0.38], [0.5, 0.26]]), YELLOW, 10),
    tint(path([[0.56, 0.72], [0.56, 0.4], [0.62, 0.28]]), YELLOW, 10),
    ink(ellipse(0.58, 0.24, 0.08, 0.055, 16)),
    ink(line(0.55, 0.2, 0.53, 0.13), 2),
    ink(line(0.62, 0.2, 0.64, 0.13), 2),
    dot(0.6, 0.22, 0.012),
    ink(ellipse(0.42, 0.76, 0.16, 0.1)),
    ink(circle(0.47, 0.44, 0.025, 10), 2),
    ink(circle(0.52, 0.56, 0.025, 10), 2),
    ink(circle(0.36, 0.75, 0.03, 10), 2),
  ],

  /** Turtle. A domed shell with a panel pattern, four stubby legs. */
  turtle: () => [
    ink(arc(0.5, 0.6, 0.24, 0.22, Math.PI, Math.PI * 2, 18)),
    ink(line(0.26, 0.6, 0.74, 0.6)),
    ink(path([[0.38, 0.6], [0.42, 0.46], [0.58, 0.46], [0.62, 0.6]]), 2),
    ink(line(0.5, 0.46, 0.5, 0.38), 2),
    ink(ellipse(0.8, 0.58, 0.07, 0.05, 16)),
    dot(0.83, 0.56, 0.011),
    ink(path([[0.3, 0.6], [0.24, 0.7], [0.32, 0.68]]), 3),
    ink(path([[0.66, 0.6], [0.72, 0.7], [0.64, 0.68]]), 3),
  ],

  /** Penguin. The white belly panel is what makes it not a generic bird. */
  penguin: () => [
    ink(
      path([
        [0.5, 0.24],
        [0.66, 0.4],
        [0.68, 0.7],
        [0.5, 0.78],
        [0.32, 0.7],
        [0.34, 0.4],
        [0.5, 0.24],
      ]),
    ),
    ink(arc(0.5, 0.52, 0.13, 0.22, Math.PI * 1.25, Math.PI * 2.75, 16), 3),
    ...eyes(0.45, 0.55, 0.34, 0.013),
    ink(triangle(0.5, 0.4, 0.46, 0.37, 0.54, 0.37), 3),
    ink(path([[0.34, 0.46], [0.24, 0.62], [0.33, 0.62]]), 3),
    ink(path([[0.66, 0.46], [0.76, 0.62], [0.67, 0.62]]), 3),
    tint(path([[0.42, 0.78], [0.36, 0.83], [0.46, 0.82]]), YELLOW, 4),
    tint(path([[0.58, 0.78], [0.64, 0.83], [0.54, 0.82]]), YELLOW, 4),
  ],

  /** Owl. Two huge eye rings on a rounded body. */
  owl: () => [
    ink(
      path([
        [0.5, 0.24],
        [0.68, 0.38],
        [0.7, 0.66],
        [0.5, 0.78],
        [0.3, 0.66],
        [0.32, 0.38],
        [0.5, 0.24],
      ]),
    ),
    ink(circle(0.42, 0.42, 0.08)),
    ink(circle(0.58, 0.42, 0.08)),
    dot(0.42, 0.42, 0.022),
    dot(0.58, 0.42, 0.022),
    ink(triangle(0.5, 0.52, 0.47, 0.47, 0.53, 0.47), 3),
    ink(path([[0.34, 0.31], [0.38, 0.24], [0.43, 0.3]]), 2),
    ink(path([[0.66, 0.31], [0.62, 0.24], [0.57, 0.3]]), 2),
    ink(arc(0.5, 0.6, 0.14, 0.1, Math.PI * 0.15, Math.PI * 0.85, 10), 2),
    ink(line(0.44, 0.79, 0.42, 0.85), 3),
    ink(line(0.56, 0.79, 0.58, 0.85), 3),
  ],

  /** Bee. Stripes and wings; the stripes go on before anything else. */
  bee: () => [
    tint(ellipse(0.5, 0.56, 0.18, 0.13), YELLOW, 6),
    ink(line(0.44, 0.44, 0.44, 0.68), 5),
    ink(line(0.54, 0.44, 0.54, 0.69), 5),
    ink(line(0.63, 0.48, 0.63, 0.65), 5),
    ink(ellipse(0.5, 0.56, 0.18, 0.13), 3),
    ink(ellipse(0.42, 0.36, 0.1, 0.06, 16)),
    ink(ellipse(0.6, 0.36, 0.1, 0.06, 16)),
    ink(path([[0.68, 0.56], [0.78, 0.6]]), 3),
    ink(line(0.34, 0.46, 0.28, 0.34), 2),
    dot(0.28, 0.32, 0.012),
  ],

  /** Spider. A round body and eight legs, drawn in pairs. */
  spider: () => [
    ink(circle(0.5, 0.5, 0.11)),
    ink(circle(0.5, 0.37, 0.05, 12), 3),
    ink(path([[0.4, 0.44], [0.24, 0.34], [0.18, 0.4]]), 3),
    ink(path([[0.39, 0.5], [0.22, 0.5], [0.16, 0.56]]), 3),
    ink(path([[0.4, 0.56], [0.24, 0.64], [0.2, 0.72]]), 3),
    ink(path([[0.44, 0.6], [0.36, 0.72], [0.3, 0.8]]), 3),
    ink(path([[0.6, 0.44], [0.76, 0.34], [0.82, 0.4]]), 3),
    ink(path([[0.61, 0.5], [0.78, 0.5], [0.84, 0.56]]), 3),
    ink(path([[0.6, 0.56], [0.76, 0.64], [0.8, 0.72]]), 3),
    ink(path([[0.56, 0.6], [0.64, 0.72], [0.7, 0.8]]), 3),
  ],

  /** Crab. A wide shell, two claws held up, legs down the sides. */
  crab: () => [
    tint(ellipse(0.5, 0.56, 0.2, 0.13), RED, 6),
    ink(path([[0.32, 0.48], [0.22, 0.36], [0.14, 0.32]]), 3),
    ink(path([[0.14, 0.32], [0.09, 0.26], [0.16, 0.24], [0.2, 0.3]]), 3),
    ink(path([[0.68, 0.48], [0.78, 0.36], [0.86, 0.32]]), 3),
    ink(path([[0.86, 0.32], [0.91, 0.26], [0.84, 0.24], [0.8, 0.3]]), 3),
    ...eyes(0.44, 0.56, 0.47, 0.014),
    ink(line(0.44, 0.47, 0.44, 0.42), 2),
    ink(line(0.56, 0.47, 0.56, 0.42), 2),
    ink(path([[0.34, 0.64], [0.26, 0.74]]), 3),
    ink(path([[0.44, 0.68], [0.4, 0.78]]), 3),
    ink(path([[0.56, 0.68], [0.6, 0.78]]), 3),
    ink(path([[0.66, 0.64], [0.74, 0.74]]), 3),
  ],

  /** Whale. The spout is the give-away, so it is drawn early and big. */
  whale: () => [
    ink(
      path([
        [0.2, 0.56],
        [0.3, 0.42],
        [0.52, 0.4],
        [0.68, 0.5],
        [0.72, 0.62],
        [0.5, 0.7],
        [0.28, 0.66],
        [0.2, 0.56],
      ]),
    ),
    ink(path([[0.72, 0.62], [0.86, 0.5], [0.83, 0.64], [0.88, 0.72], [0.72, 0.62]])),
    ink(path([[0.34, 0.4], [0.32, 0.26]]), 3),
    ink(path([[0.34, 0.4], [0.4, 0.27]]), 3),
    ink(path([[0.34, 0.4], [0.27, 0.28]]), 3),
    dot(0.28, 0.52, 0.015),
    ink(arc(0.24, 0.58, 0.04, 0.03, Math.PI * 1.1, Math.PI * 1.9, 8), 2),
    ink(arc(0.5, 0.56, 0.1, 0.08, Math.PI * 0.9, Math.PI * 2.1, 10), 2),
  ],

  /** Shark. The dorsal fin and the pointed nose, plus a row of teeth. */
  shark: () => [
    ink(
      path([
        [0.18, 0.56],
        [0.36, 0.44],
        [0.6, 0.44],
        [0.74, 0.52],
        [0.62, 0.66],
        [0.34, 0.66],
        [0.18, 0.56],
      ]),
    ),
    ink(triangle(0.44, 0.44, 0.5, 0.26, 0.58, 0.44)),
    ink(path([[0.74, 0.52], [0.88, 0.4], [0.85, 0.54], [0.89, 0.66], [0.74, 0.52]])),
    ink(zigzag(0.22, 0.58, 0.38, 0.58, 4, 0.03), 2),
    dot(0.3, 0.51, 0.014),
    ink(path([[0.46, 0.66], [0.42, 0.76], [0.54, 0.68]]), 3),
    ink(line(0.52, 0.48, 0.54, 0.56), 2),
  ],

  /** Chicken. Comb, wattle and a fat body. */
  chicken: () => [
    ink(ellipse(0.52, 0.6, 0.18, 0.15)),
    ink(circle(0.4, 0.4, 0.1)),
    tint(path([[0.34, 0.31], [0.36, 0.24], [0.4, 0.29], [0.44, 0.23], [0.46, 0.31]]), RED, 4),
    ink(triangle(0.31, 0.42, 0.21, 0.45, 0.31, 0.48), 3),
    tint(path([[0.33, 0.48], [0.32, 0.55], [0.38, 0.5]]), RED, 3),
    dot(0.39, 0.38, 0.012),
    ink(arc(0.56, 0.58, 0.09, 0.07, Math.PI * 0.9, Math.PI * 2.1, 10), 3),
    ink(path([[0.7, 0.52], [0.8, 0.42], [0.78, 0.56]]), 3),
    ink(line(0.46, 0.75, 0.46, 0.83), 3),
    ink(line(0.58, 0.75, 0.58, 0.83), 3),
  ],

  /** Goat. Swept-back horns and a beard. */
  goat: () => [
    ink(ellipse(0.54, 0.58, 0.2, 0.14)),
    ink(ellipse(0.34, 0.42, 0.1, 0.09, 18)),
    ink(arc(0.32, 0.34, 0.09, 0.1, Math.PI * 1.1, Math.PI * 1.95, 10), 3),
    ink(arc(0.4, 0.33, 0.09, 0.1, Math.PI * 1.15, Math.PI * 2.0, 10), 3),
    dot(0.31, 0.41, 0.012),
    ink(path([[0.32, 0.51], [0.31, 0.6], [0.37, 0.54]]), 3),
    ink(line(0.44, 0.71, 0.44, 0.8), 3),
    ink(line(0.56, 0.72, 0.56, 0.8), 3),
    ink(line(0.68, 0.71, 0.68, 0.8), 3),
  ],

  /** Fox. Sharp ears, a pointed snout and a heavy tail. */
  fox: () => [
    tint(path([[0.5, 0.36], [0.64, 0.46], [0.5, 0.62], [0.36, 0.46], [0.5, 0.36]]), ORANGE, 6),
    ink(triangle(0.38, 0.42, 0.33, 0.24, 0.48, 0.36), 3),
    ink(triangle(0.62, 0.42, 0.67, 0.24, 0.52, 0.36), 3),
    ...eyes(0.45, 0.55, 0.45, 0.014),
    ink(ellipse(0.5, 0.58, 0.022, 0.017, 10), 3),
    ink(ellipse(0.55, 0.72, 0.14, 0.1)),
    ink(arc(0.74, 0.72, 0.12, 0.12, Math.PI * 1.25, Math.PI * 2.5, 14)),
  ],

  /** Worm. A segmented curve with a face at one end. */
  worm: () => [
    ink(path([[0.16, 0.66], [0.26, 0.56], [0.38, 0.66], [0.5, 0.56], [0.62, 0.66], [0.72, 0.56]]), 8),
    ink(circle(0.76, 0.48, 0.08)),
    ...eyes(0.74, 0.8, 0.46, 0.012),
    ink(arc(0.77, 0.5, 0.035, 0.03, Math.PI * 0.1, Math.PI * 0.9, 8), 2),
    ink(line(0.72, 0.4, 0.7, 0.33), 2),
    ink(line(0.8, 0.4, 0.82, 0.33), 2),
  ],

  /** Butterfly. Four wings around a thin body. */
  butterfly: () => [
    ink(ellipse(0.5, 0.5, 0.022, 0.16, 16)),
    tint(path([[0.48, 0.4], [0.28, 0.26], [0.2, 0.42], [0.34, 0.5], [0.48, 0.48]]), PURPLE, 5),
    tint(path([[0.52, 0.4], [0.72, 0.26], [0.8, 0.42], [0.66, 0.5], [0.52, 0.48]]), PURPLE, 5),
    tint(path([[0.48, 0.52], [0.3, 0.62], [0.36, 0.74], [0.48, 0.62]]), ORANGE, 5),
    tint(path([[0.52, 0.52], [0.7, 0.62], [0.64, 0.74], [0.52, 0.62]]), ORANGE, 5),
    ink(path([[0.48, 0.35], [0.42, 0.26]]), 2),
    ink(path([[0.52, 0.35], [0.58, 0.26]]), 2),
  ],

  /** Snail. The spiral shell is the word. */
  snail: () => [
    ink(
      path(
        Array.from({ length: 46 }, (_, i) => {
          const t = (i / 45) * Math.PI * 4.2;
          const r = 0.03 + (t / (Math.PI * 4.2)) * 0.17;
          return [0.56 + Math.cos(t) * r, 0.46 + Math.sin(t) * r] as const;
        }),
      ),
    ),
    ink(path([[0.36, 0.62], [0.2, 0.64], [0.16, 0.72], [0.62, 0.72], [0.68, 0.64]])),
    ink(line(0.2, 0.62, 0.18, 0.5), 2),
    ink(line(0.26, 0.62, 0.24, 0.5), 2),
    dot(0.18, 0.48, 0.011),
    dot(0.24, 0.48, 0.011),
  ],

  /** Octopus. A dome and eight curling arms. */
  octopus: () => [
    ink(arc(0.5, 0.46, 0.2, 0.2, Math.PI, Math.PI * 2, 18)),
    ink(line(0.3, 0.46, 0.7, 0.46), 3),
    ...eyes(0.43, 0.57, 0.42, 0.02),
    ink(arc(0.5, 0.48, 0.06, 0.04, Math.PI * 0.15, Math.PI * 0.85, 8), 2),
    ink(path([[0.32, 0.47], [0.22, 0.6], [0.28, 0.72]]), 3),
    ink(path([[0.4, 0.47], [0.34, 0.62], [0.4, 0.74]]), 3),
    ink(path([[0.48, 0.47], [0.46, 0.64], [0.52, 0.76]]), 3),
    ink(path([[0.56, 0.47], [0.58, 0.64], [0.52, 0.74]]), 3),
    ink(path([[0.64, 0.47], [0.7, 0.62], [0.64, 0.74]]), 3),
    ink(path([[0.7, 0.47], [0.8, 0.6], [0.74, 0.7]]), 3),
  ],

  /** Panda. Black patches on a white head — the patches carry it. */
  panda: () => [
    ink(circle(0.5, 0.5, 0.2)),
    ink(circle(0.33, 0.33, 0.065, 14), 6),
    ink(circle(0.67, 0.33, 0.065, 14), 6),
    ink(ellipse(0.42, 0.46, 0.05, 0.06, 14), 5),
    ink(ellipse(0.58, 0.46, 0.05, 0.06, 14), 5),
    dot(0.42, 0.46, 0.012, 2),
    dot(0.58, 0.46, 0.012, 2),
    ink(ellipse(0.5, 0.58, 0.03, 0.022, 10), 3),
    ink(path([[0.44, 0.63], [0.5, 0.67], [0.56, 0.63]]), 2),
  ],

  /** Zebra. Stripes across a horse body; the stripes come first. */
  zebra: () => [
    ink(ellipse(0.54, 0.56, 0.22, 0.14)),
    ink(path([[0.36, 0.5], [0.28, 0.32], [0.2, 0.28], [0.17, 0.36], [0.26, 0.44], [0.33, 0.56]])),
    ink(triangle(0.26, 0.3, 0.27, 0.22, 0.32, 0.3), 2),
    ink(line(0.44, 0.44, 0.44, 0.68), 5),
    ink(line(0.54, 0.43, 0.54, 0.69), 5),
    ink(line(0.64, 0.45, 0.64, 0.67), 5),
    ink(line(0.72, 0.48, 0.72, 0.64), 5),
    ink(line(0.44, 0.68, 0.43, 0.8), 3),
    ink(line(0.64, 0.68, 0.65, 0.8), 3),
  ],

  /** Camel. Two humps, which nothing else in the bank has. */
  camel: () => [
    ink(path([[0.24, 0.66], [0.3, 0.5], [0.4, 0.42], [0.5, 0.52], [0.6, 0.42], [0.7, 0.5], [0.74, 0.66]])),
    ink(line(0.24, 0.66, 0.74, 0.66)),
    ink(path([[0.28, 0.56], [0.22, 0.38], [0.16, 0.3]])),
    ink(ellipse(0.14, 0.27, 0.06, 0.045, 14)),
    dot(0.13, 0.25, 0.011),
    ink(line(0.32, 0.66, 0.32, 0.8), 3),
    ink(line(0.44, 0.66, 0.44, 0.8), 3),
    ink(line(0.62, 0.66, 0.62, 0.8), 3),
    ink(line(0.72, 0.66, 0.72, 0.8), 3),
  ],

  /** Dolphin. A curved body with a hooked dorsal fin. */
  dolphin: () => [
    ink(
      path([
        [0.16, 0.6],
        [0.3, 0.46],
        [0.5, 0.4],
        [0.68, 0.46],
        [0.76, 0.58],
        [0.56, 0.66],
        [0.32, 0.66],
        [0.16, 0.6],
      ]),
    ),
    ink(path([[0.46, 0.4], [0.56, 0.26], [0.58, 0.42]])),
    ink(path([[0.76, 0.58], [0.88, 0.48], [0.86, 0.6], [0.9, 0.7], [0.76, 0.58]])),
    ink(path([[0.44, 0.65], [0.42, 0.76], [0.54, 0.66]]), 3),
    dot(0.26, 0.55, 0.013),
    ink(path([[0.16, 0.6], [0.22, 0.63]]), 2),
  ],

  /** Starfish. Five thick arms. */
  starfish: () => [
    tint(
      closed(
        Array.from({ length: 10 }, (_, i) => {
          const angle = -Math.PI / 2 + (i / 10) * Math.PI * 2;
          const r = i % 2 === 0 ? 0.28 : 0.11;
          return [0.5 + Math.cos(angle) * r, 0.52 + Math.sin(angle) * r] as const;
        }),
      ),
      ORANGE,
      6,
    ),
    ink(circle(0.5, 0.52, 0.028, 10), 2),
    ink(circle(0.44, 0.45, 0.018, 8), 2),
    ink(circle(0.57, 0.47, 0.018, 8), 2),
    ink(circle(0.5, 0.62, 0.018, 8), 2),
  ],

  /** Ladybug. A red dome, a black head and spots. */
  ladybug: () => [
    tint(ellipse(0.5, 0.56, 0.2, 0.18), RED, 6),
    ink(line(0.5, 0.38, 0.5, 0.74), 4),
    ink(arc(0.5, 0.42, 0.09, 0.08, Math.PI, Math.PI * 2, 10), 6),
    ink(circle(0.4, 0.52, 0.03, 10), 4),
    ink(circle(0.6, 0.52, 0.03, 10), 4),
    ink(circle(0.42, 0.65, 0.03, 10), 4),
    ink(circle(0.59, 0.65, 0.03, 10), 4),
    ink(line(0.44, 0.35, 0.4, 0.26), 2),
    ink(line(0.56, 0.35, 0.6, 0.26), 2),
  ],

  /** Bat. Scalloped wings spread wide. */
  bat: () => [
    ink(ellipse(0.5, 0.5, 0.07, 0.11, 16)),
    ink(path([[0.44, 0.42], [0.3, 0.32], [0.32, 0.44], [0.18, 0.4], [0.22, 0.54], [0.36, 0.56], [0.44, 0.58]])),
    ink(path([[0.56, 0.42], [0.7, 0.32], [0.68, 0.44], [0.82, 0.4], [0.78, 0.54], [0.64, 0.56], [0.56, 0.58]])),
    ink(triangle(0.45, 0.4, 0.42, 0.3, 0.5, 0.36), 2),
    ink(triangle(0.55, 0.4, 0.58, 0.3, 0.5, 0.36), 2),
    ...eyes(0.47, 0.53, 0.47, 0.012),
  ],
});
