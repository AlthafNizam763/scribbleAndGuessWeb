import {
  BLUE,
  BROWN,
  GREEN,
  GREY,
  ORANGE,
  PINK,
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
  rays,
  rect,
  starPoly,
  tint,
  triangle,
  zigzag,
  type TemplateBuilder,
  type TemplateStroke,
} from '@/services/bot/drawingShapes';

/**
 * People, and the sports that are people doing something.
 *
 * ## Why these are drawable at all
 *
 * A job is not an object, and the obvious conclusion — that a bot should sit
 * every "doctor" turn out — is wrong: a person is drawn the same way every
 * time, and what makes them a doctor rather than a chef is one prop. That is
 * exactly how a human draws these under a clock, and it is why the shared
 * figure below is a helper rather than a template: `figure()` is never a
 * drawing on its own, so there is no word that resolves to "a person" and
 * nothing here can become the generic blob this library was built to remove.
 *
 * Each entry is the figure *plus* the thing that names it, and the prop is
 * always a stroke the difficulty cut cannot reach — it goes on before the
 * ornament, because a chef without a hat is a doctor without a stethoscope.
 */

/**
 * The shared body: head, torso, arms, legs.
 *
 * Deliberately not exported and deliberately not a template. Every caller adds
 * at least one prop before it reaches a canvas.
 */
function figure(): TemplateStroke[] {
  return [
    ink(circle(0.5, 0.26, 0.09)),
    ink(line(0.5, 0.35, 0.5, 0.62), 5),
    ink(path([[0.5, 0.42], [0.34, 0.52]]), 4),
    ink(path([[0.5, 0.42], [0.66, 0.52]]), 4),
    ink(path([[0.5, 0.62], [0.4, 0.82]]), 4),
    ink(path([[0.5, 0.62], [0.6, 0.82]]), 4),
  ];
}

/** The figure with a face, for the entries where the face is not covered. */
function facedFigure(): TemplateStroke[] {
  return [...figure(), ...eyes(0.47, 0.53, 0.24, 0.012)];
}

export const PEOPLE_TEMPLATES: Readonly<Record<string, TemplateBuilder>> = Object.freeze({
  /** Doctor. The stethoscope, then the coat. */
  doctor: () => [
    ...facedFigure(),
    ink(path([[0.44, 0.36], [0.44, 0.5], [0.5, 0.54], [0.56, 0.5], [0.56, 0.36]]), 3),
    ink(circle(0.5, 0.57, 0.03, 10), 3),
    ink(path([[0.42, 0.4], [0.42, 0.66]]), 2),
    ink(path([[0.58, 0.4], [0.58, 0.66]]), 2),
  ],

  /** Nurse. The cap with a cross. */
  nurse: () => [
    ...facedFigure(),
    ink(rect(0.42, 0.14, 0.58, 0.2)),
    tint(line(0.5, 0.15, 0.5, 0.19), RED, 3),
    tint(line(0.46, 0.17, 0.54, 0.17), RED, 3),
    ink(path([[0.4, 0.46], [0.6, 0.46]]), 3),
  ],

  /** Chef. The toque, then the apron. */
  chef: () => [
    ...facedFigure(),
    ink(arc(0.5, 0.17, 0.13, 0.11, Math.PI, Math.PI * 2, 14)),
    ink(rect(0.39, 0.15, 0.61, 0.19)),
    ink(path([[0.42, 0.44], [0.4, 0.66], [0.6, 0.66], [0.58, 0.44]]), 3),
  ],

  /** Teacher. The board and the pointer. */
  teacher: () => [
    ...facedFigure(),
    ink(rect(0.62, 0.24, 0.92, 0.5)),
    ink(line(0.66, 0.32, 0.88, 0.32), 2),
    ink(line(0.66, 0.4, 0.82, 0.4), 2),
    ink(path([[0.66, 0.52], [0.76, 0.42]]), 3),
  ],

  /** Farmer. The straw hat and the pitchfork. */
  farmer: () => [
    ...facedFigure(),
    tint(ellipse(0.5, 0.18, 0.18, 0.04, 14), YELLOW, 5),
    tint(arc(0.5, 0.18, 0.1, 0.08, Math.PI, Math.PI * 2, 10), YELLOW, 5),
    ink(line(0.7, 0.28, 0.7, 0.8), 3),
    ink(line(0.64, 0.28, 0.76, 0.28), 3),
    ink(line(0.64, 0.28, 0.64, 0.2), 3),
    ink(line(0.7, 0.28, 0.7, 0.2), 3),
    ink(line(0.76, 0.28, 0.76, 0.2), 3),
  ],

  /** Firefighter. The helmet and the hose. */
  firefighter: () => [
    ...facedFigure(),
    tint(arc(0.5, 0.2, 0.12, 0.1, Math.PI, Math.PI * 2, 12), RED, 6),
    tint(path([[0.36, 0.2], [0.64, 0.2], [0.68, 0.24], [0.32, 0.24]]), RED, 4),
    ink(path([[0.66, 0.52], [0.8, 0.6], [0.86, 0.5]]), 4),
    tint(path([[0.86, 0.5], [0.92, 0.42]]), BLUE, 4),
  ],

  /** Police officer. The peaked cap with a badge. */
  'police officer': () => [
    ...facedFigure(),
    tint(rect(0.4, 0.13, 0.6, 0.19), BLUE, 5),
    ink(path([[0.36, 0.19], [0.64, 0.19]]), 4),
    tint(starPoly(0.5, 0.155, 0.022, 0.01), YELLOW, 2),
    ink(path([[0.42, 0.46], [0.58, 0.46]]), 3),
  ],

  /** Pilot. The cap and the wings badge. */
  pilot: () => [
    ...facedFigure(),
    ink(rect(0.4, 0.13, 0.6, 0.19)),
    ink(path([[0.36, 0.19], [0.64, 0.19]]), 4),
    ink(path([[0.4, 0.46], [0.5, 0.44], [0.6, 0.46]]), 3),
    ink(circle(0.5, 0.45, 0.018, 8), 2),
  ],

  /** Painter. The beret, the palette and the brush. */
  painter: () => [
    ...facedFigure(),
    tint(ellipse(0.5, 0.17, 0.11, 0.05, 12), RED, 5),
    ink(ellipse(0.32, 0.56, 0.1, 0.07, 16)),
    ink(circle(0.34, 0.57, 0.025, 8), 2),
    tint(circle(0.28, 0.53, 0.018, 8), RED, 3),
    tint(circle(0.33, 0.51, 0.018, 8), BLUE, 3),
    ink(path([[0.66, 0.52], [0.78, 0.44]]), 3),
    tint(circle(0.79, 0.43, 0.02, 8), YELLOW, 3),
  ],

  /** Clown. The red nose and the ruff — nothing else reads as a clown. */
  clown: () => [
    ...figure(),
    tint(circle(0.5, 0.29, 0.03), RED, 5),
    ...eyes(0.46, 0.54, 0.24, 0.012),
    ink(arc(0.5, 0.3, 0.05, 0.04, Math.PI * 0.1, Math.PI * 0.9, 8), 2),
    tint(circle(0.38, 0.24, 0.05, 12), ORANGE, 4),
    tint(circle(0.62, 0.24, 0.05, 12), ORANGE, 4),
    ink(zigzag(0.38, 0.37, 0.62, 0.37, 4, 0.03), 3),
    tint(circle(0.5, 0.5, 0.025, 8), RED, 3),
  ],

  /** King. The crown. */
  king: () => [
    ...facedFigure(),
    tint(closed([[0.38, 0.17], [0.38, 0.09], [0.44, 0.14], [0.5, 0.06], [0.56, 0.14], [0.62, 0.09], [0.62, 0.17]]), YELLOW, 5),
    ink(path([[0.42, 0.46], [0.5, 0.52], [0.58, 0.46]]), 3),
  ],

  /** Queen. A smaller crown and a gown. */
  queen: () => [
    ...facedFigure(),
    tint(closed([[0.4, 0.16], [0.42, 0.1], [0.5, 0.14], [0.58, 0.1], [0.6, 0.16]]), YELLOW, 5),
    ink(path([[0.5, 0.62], [0.34, 0.82], [0.66, 0.82], [0.5, 0.62]])),
  ],

  /** Astronaut. The bubble helmet. */
  astronaut: () => [
    ...figure(),
    ink(circle(0.5, 0.26, 0.14)),
    ...eyes(0.47, 0.53, 0.25, 0.012),
    ink(rect(0.4, 0.42, 0.6, 0.56)),
    ink(line(0.44, 0.46, 0.56, 0.46), 2),
    ink(line(0.44, 0.52, 0.52, 0.52), 2),
  ],

  /** Baker. The toque and a tray of loaves. */
  baker: () => [
    ...facedFigure(),
    ink(arc(0.5, 0.18, 0.12, 0.1, Math.PI, Math.PI * 2, 12)),
    ink(rect(0.4, 0.16, 0.6, 0.2)),
    ink(rect(0.6, 0.54, 0.9, 0.6)),
    tint(arc(0.68, 0.54, 0.05, 0.05, Math.PI, Math.PI * 2, 8), BROWN, 5),
    tint(arc(0.82, 0.54, 0.05, 0.05, Math.PI, Math.PI * 2, 8), BROWN, 5),
  ],

  /** Dancer. A skirt and a raised arm — the pose is the word. */
  dancer: () => [
    ink(circle(0.46, 0.22, 0.08)),
    ink(path([[0.46, 0.3], [0.5, 0.52]]), 5),
    ink(path([[0.48, 0.36], [0.66, 0.2]]), 4),
    ink(path([[0.48, 0.38], [0.3, 0.46]]), 4),
    tint(closed([[0.5, 0.52], [0.34, 0.66], [0.66, 0.66]]), PINK, 5),
    ink(path([[0.46, 0.66], [0.38, 0.84]]), 4),
    ink(path([[0.54, 0.66], [0.68, 0.76]]), 4),
  ],

  /** Singer. A microphone held to the mouth, and notes. */
  singer: () => [
    ...facedFigure(),
    ink(path([[0.66, 0.52], [0.6, 0.34]]), 3),
    ink(ellipse(0.59, 0.31, 0.035, 0.045, 12), 3),
    ink(path([[0.72, 0.24], [0.72, 0.14]]), 3),
    ink(circle(0.7, 0.25, 0.022, 8), 3),
    ink(path([[0.82, 0.32], [0.82, 0.22]]), 3),
    ink(circle(0.8, 0.33, 0.02, 8), 3),
  ],

  /** Judge. The gavel and the wig. */
  judge: () => [
    ...facedFigure(),
    ink(arc(0.5, 0.2, 0.13, 0.11, Math.PI, Math.PI * 2, 12), 3),
    ink(circle(0.36, 0.22, 0.04, 10), 2),
    ink(circle(0.64, 0.22, 0.04, 10), 2),
    ink(rect(0.68, 0.44, 0.84, 0.5)),
    ink(path([[0.66, 0.52], [0.76, 0.5]]), 3),
  ],

  /** Magician. The top hat and the wand. */
  magician: () => [
    ...facedFigure(),
    ink(path([[0.4, 0.17], [0.41, 0.05], [0.59, 0.05], [0.6, 0.17]])),
    ink(line(0.34, 0.17, 0.66, 0.17), 4),
    tint(line(0.4, 0.12, 0.6, 0.12), RED, 4),
    ink(line(0.66, 0.52, 0.84, 0.42), 3),
    tint(starPoly(0.86, 0.4, 0.04, 0.017), YELLOW, 2),
  ],

  /** Sailor. The cap and an anchor on the chest. */
  sailor: () => [
    ...facedFigure(),
    ink(arc(0.5, 0.17, 0.11, 0.06, Math.PI, Math.PI * 2, 12)),
    ink(line(0.39, 0.17, 0.61, 0.17), 3),
    ink(line(0.5, 0.46, 0.5, 0.56), 3),
    ink(line(0.44, 0.49, 0.56, 0.49), 2),
    ink(arc(0.5, 0.53, 0.05, 0.04, 0, Math.PI, 8), 2),
  ],

  /** Scientist. Goggles and a flask. */
  scientist: () => [
    ...figure(),
    ink(circle(0.46, 0.25, 0.035, 10), 2),
    ink(circle(0.55, 0.25, 0.035, 10), 2),
    ink(line(0.49, 0.25, 0.52, 0.25), 2),
    ink(path([[0.72, 0.42], [0.72, 0.5], [0.66, 0.62], [0.84, 0.62], [0.78, 0.5], [0.78, 0.42]])),
    tint(path([[0.69, 0.56], [0.81, 0.56]]), GREEN, 5),
    ink(line(0.7, 0.42, 0.8, 0.42), 3),
  ],

  /** Builder. The hard hat and a hammer. */
  builder: () => [
    ...facedFigure(),
    tint(arc(0.5, 0.19, 0.12, 0.1, Math.PI, Math.PI * 2, 12), YELLOW, 6),
    tint(line(0.36, 0.19, 0.64, 0.19), YELLOW, 5),
    ink(line(0.66, 0.52, 0.8, 0.4), 3),
    ink(rect(0.76, 0.32, 0.88, 0.38)),
  ],

  /** Gardener. A watering can and a plant. */
  gardener: () => [
    ...facedFigure(),
    tint(ellipse(0.5, 0.18, 0.16, 0.04, 14), YELLOW, 5),
    ink(path([[0.66, 0.52], [0.72, 0.6]]), 3),
    ink(rect(0.7, 0.6, 0.86, 0.74)),
    ink(path([[0.86, 0.64], [0.92, 0.58]]), 3),
    tint(path([[0.3, 0.8], [0.3, 0.66]]), GREEN, 4),
    tint(circle(0.3, 0.62, 0.05, 12), RED, 4),
  ],

  /** Photographer. A camera held to the eye. */
  photographer: () => [
    ...figure(),
    ink(rect(0.38, 0.2, 0.62, 0.32)),
    ink(circle(0.5, 0.26, 0.05, 14), 3),
    ink(path([[0.34, 0.5], [0.4, 0.32]]), 3),
    ink(path([[0.66, 0.5], [0.6, 0.32]]), 3),
    ink(circle(0.58, 0.22, 0.018, 8), 2),
  ],

  /** Ballerina. A tutu and arms held overhead. */
  ballerina: () => [
    ink(circle(0.5, 0.2, 0.075)),
    ink(line(0.5, 0.28, 0.5, 0.52), 4),
    ink(path([[0.5, 0.34], [0.38, 0.18], [0.46, 0.1]]), 3),
    ink(path([[0.5, 0.34], [0.62, 0.18], [0.54, 0.1]]), 3),
    tint(ellipse(0.5, 0.54, 0.17, 0.06, 16), PINK, 5),
    ink(path([[0.5, 0.58], [0.42, 0.82]]), 4),
    ink(path([[0.5, 0.58], [0.66, 0.74]]), 4),
  ],

  /** Waiter. A tray held flat on one hand. */
  waiter: () => [
    ...facedFigure(),
    ink(path([[0.5, 0.42], [0.68, 0.34]]), 4),
    ink(ellipse(0.74, 0.32, 0.14, 0.035, 16)),
    ink(path([[0.7, 0.3], [0.7, 0.24], [0.76, 0.24], [0.76, 0.3]]), 2),
    ink(path([[0.44, 0.38], [0.5, 0.46], [0.56, 0.38]]), 2),
  ],

  // ---------------------------------------------------------------- sports

  /** Football. The pitch ball, with a boot beside it. */
  football: () => [
    ink(circle(0.42, 0.52, 0.2)),
    ink(closed([[0.42, 0.42], [0.51, 0.48], [0.47, 0.6], [0.37, 0.6], [0.33, 0.48]]), 3),
    ink(line(0.42, 0.42, 0.42, 0.32), 2),
    ink(line(0.51, 0.48, 0.61, 0.44), 2),
    ink(line(0.47, 0.6, 0.54, 0.7), 2),
    ink(line(0.37, 0.6, 0.3, 0.7), 2),
    ink(line(0.33, 0.48, 0.23, 0.44), 2),
    ink(path([[0.68, 0.72], [0.7, 0.6], [0.82, 0.62], [0.88, 0.72], [0.68, 0.72]]), 3),
  ],

  /** Basketball. The ball's seams are the word, not the round shape. */
  basketball: () => [
    tint(circle(0.5, 0.52, 0.24), ORANGE, 6),
    ink(line(0.26, 0.52, 0.74, 0.52), 3),
    ink(line(0.5, 0.28, 0.5, 0.76), 3),
    ink(arc(0.5, 0.52, 0.34, 0.24, Math.PI * 1.65, Math.PI * 2.35, 12), 3),
    ink(arc(0.5, 0.52, 0.34, 0.24, Math.PI * 0.65, Math.PI * 1.35, 12), 3),
  ],

  /** Tennis. A racket and a ball. */
  tennis: () => [
    ink(ellipse(0.42, 0.36, 0.17, 0.21, 22)),
    ...Array.from({ length: 4 }, (_, i) => ink(line(0.29 + i * 0.09, 0.2, 0.29 + i * 0.09, 0.52), 2)),
    ...Array.from({ length: 4 }, (_, i) => ink(line(0.26, 0.24 + i * 0.09, 0.58, 0.24 + i * 0.09), 2)),
    ink(line(0.42, 0.57, 0.5, 0.82), 6),
    tint(circle(0.76, 0.62, 0.07), GREEN, 5),
    ink(arc(0.76, 0.62, 0.07, 0.07, Math.PI * 1.2, Math.PI * 1.8, 8), 2),
  ],

  /** Baseball. A bat crossed with a stitched ball. */
  baseball: () => [
    ink(path([[0.2, 0.76], [0.28, 0.7], [0.66, 0.3], [0.74, 0.24], [0.8, 0.3], [0.72, 0.36], [0.34, 0.76], [0.28, 0.8], [0.2, 0.76]])),
    ink(line(0.26, 0.72, 0.32, 0.78), 2),
    ink(circle(0.68, 0.66, 0.12)),
    tint(arc(0.62, 0.66, 0.1, 0.12, Math.PI * 1.6, Math.PI * 2.4, 10), RED, 3),
    tint(arc(0.74, 0.66, 0.1, 0.12, Math.PI * 0.6, Math.PI * 1.4, 10), RED, 3),
  ],

  /** Golf. A flag in a hole, and a ball. */
  golf: () => [
    ink(line(0.6, 0.72, 0.6, 0.2), 4),
    tint(closed([[0.6, 0.22], [0.84, 0.3], [0.6, 0.38]]), RED, 5),
    ink(ellipse(0.6, 0.73, 0.07, 0.025, 14), 3),
    ink(circle(0.34, 0.7, 0.045, 14), 3),
    tint(line(0.14, 0.78, 0.86, 0.78), GREEN, 4),
  ],

  /** Racket. Kept distinct from `tennis` by having no ball. */
  racket: () => [
    ink(ellipse(0.5, 0.36, 0.18, 0.22, 22)),
    ...Array.from({ length: 4 }, (_, i) => ink(line(0.37 + i * 0.09, 0.2, 0.37 + i * 0.09, 0.52), 2)),
    ...Array.from({ length: 4 }, (_, i) => ink(line(0.33, 0.24 + i * 0.09, 0.67, 0.24 + i * 0.09), 2)),
    ink(line(0.5, 0.58, 0.5, 0.84), 6),
    ink(line(0.46, 0.7, 0.54, 0.7), 3),
  ],

  /** Net. A goal net, which is the word rather than a mesh. */
  net: () => [
    ink(rect(0.16, 0.34, 0.84, 0.74)),
    ...Array.from({ length: 6 }, (_, i) => ink(line(0.24 + i * 0.1, 0.34, 0.24 + i * 0.1, 0.74), 2)),
    ...Array.from({ length: 3 }, (_, i) => ink(line(0.16, 0.44 + i * 0.1, 0.84, 0.44 + i * 0.1), 2)),
    ink(line(0.16, 0.34, 0.84, 0.34), 5),
  ],

  /** Goalpost. Two uprights and a crossbar, with the net behind. */
  goalpost: () => [
    ink(line(0.18, 0.32, 0.18, 0.76), 6),
    ink(line(0.82, 0.32, 0.82, 0.76), 6),
    ink(line(0.18, 0.32, 0.82, 0.32), 6),
    ...Array.from({ length: 5 }, (_, i) => ink(line(0.28 + i * 0.11, 0.32, 0.28 + i * 0.11, 0.76), 2)),
    ink(line(0.18, 0.47, 0.82, 0.47), 2),
    ink(line(0.18, 0.62, 0.82, 0.62), 2),
  ],

  /** Swimming. A figure in the water with a stroke arm raised. */
  swimming: () => [
    ink(circle(0.42, 0.42, 0.07)),
    ink(path([[0.48, 0.46], [0.66, 0.5], [0.8, 0.46]]), 5),
    ink(path([[0.48, 0.44], [0.36, 0.26], [0.26, 0.22]]), 4),
    tint(path([[0.1, 0.58], [0.26, 0.56], [0.42, 0.58], [0.58, 0.56], [0.74, 0.58], [0.9, 0.56]]), BLUE, 5),
    tint(path([[0.1, 0.68], [0.26, 0.66], [0.42, 0.68], [0.58, 0.66], [0.74, 0.68], [0.9, 0.66]]), BLUE, 5),
  ],

  /** Skiing. A figure on two skis with poles. */
  skiing: () => [
    ink(circle(0.44, 0.24, 0.07)),
    ink(path([[0.44, 0.31], [0.5, 0.52]]), 5),
    ink(path([[0.46, 0.38], [0.62, 0.34]]), 3),
    ink(path([[0.46, 0.4], [0.32, 0.44]]), 3),
    ink(path([[0.5, 0.52], [0.46, 0.7]]), 4),
    ink(path([[0.5, 0.52], [0.58, 0.7]]), 4),
    ink(line(0.3, 0.74, 0.62, 0.7), 4),
    ink(line(0.44, 0.78, 0.76, 0.74), 4),
    ink(line(0.62, 0.34, 0.68, 0.66), 2),
    ink(line(0.32, 0.44, 0.26, 0.7), 2),
  ],

  /** Fishing. A rod, a line and a fish on the hook. */
  fishing: () => [
    ink(line(0.18, 0.7, 0.62, 0.22), 4),
    ink(path([[0.62, 0.22], [0.66, 0.4], [0.64, 0.56]]), 2),
    ink(path([[0.64, 0.56], [0.58, 0.62], [0.64, 0.66], [0.7, 0.62]]), 2),
    ink(ellipse(0.74, 0.66, 0.09, 0.05, 16)),
    ink(path([[0.83, 0.66], [0.9, 0.6], [0.88, 0.66], [0.9, 0.72], [0.83, 0.66]]), 2),
    dot(0.7, 0.64, 0.01),
    tint(line(0.1, 0.8, 0.9, 0.8), BLUE, 4),
  ],

  /** Boxing. A glove, laced. */
  boxing: () => [
    tint(path([[0.3, 0.7], [0.26, 0.48], [0.36, 0.3], [0.58, 0.28], [0.7, 0.42], [0.7, 0.62], [0.6, 0.72], [0.3, 0.7]]), RED, 6),
    tint(path([[0.7, 0.44], [0.82, 0.42], [0.84, 0.54], [0.72, 0.58]]), RED, 5),
    ink(rect(0.28, 0.7, 0.62, 0.8)),
    ink(line(0.36, 0.7, 0.4, 0.8), 2),
    ink(line(0.46, 0.7, 0.5, 0.8), 2),
  ],
});
