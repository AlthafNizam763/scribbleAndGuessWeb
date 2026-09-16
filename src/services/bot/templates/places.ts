import {
  BLUE,
  BROWN,
  GREEN,
  GREY,
  RED,
  YELLOW,
  arc,
  circle,
  closed,
  ellipse,
  ink,
  line,
  path,
  rect,
  tint,
  triangle,
  zigzag,
  type TemplateBuilder,
} from '@/services/bot/drawingShapes';

/**
 * Places and buildings.
 *
 * Every one of these is a box with a roof, so the roof is what has to carry
 * the word: a church gets a spire and a cross, a barn gets a gambrel and a
 * hayloft door, a castle gets crenellations. Where the roof cannot carry it —
 * a bridge, a cave — the profile does, and the building parts are dropped
 * entirely rather than added for familiarity.
 */
export const PLACE_TEMPLATES: Readonly<Record<string, TemplateBuilder>> = Object.freeze({
  /** House. Body, roof, door, windows, chimney — the brief's order. */
  house: () => [
    ink(rect(0.28, 0.48, 0.72, 0.78)),
    ink(path([[0.22, 0.48], [0.5, 0.26], [0.78, 0.48]])),
    ink(rect(0.44, 0.6, 0.56, 0.78)),
    ink(rect(0.32, 0.54, 0.4, 0.62)),
    ink(rect(0.6, 0.54, 0.68, 0.62)),
    ink(line(0.36, 0.54, 0.36, 0.62), 2),
    ink(line(0.32, 0.58, 0.4, 0.58), 2),
    ink(path([[0.62, 0.36], [0.62, 0.24], [0.68, 0.24], [0.68, 0.41]]), 3),
  ],

  /** School. A wide block with a bell tower and a row of windows. */
  school: () => [
    ink(rect(0.18, 0.5, 0.82, 0.8)),
    ink(path([[0.14, 0.5], [0.5, 0.34], [0.86, 0.5]])),
    ink(rect(0.44, 0.2, 0.56, 0.36)),
    ink(triangle(0.5, 0.13, 0.58, 0.2, 0.42, 0.2), 3),
    ink(circle(0.5, 0.28, 0.035, 12), 2),
    ink(rect(0.24, 0.56, 0.34, 0.64), ),
    ink(rect(0.66, 0.56, 0.76, 0.64), ),
    ink(rect(0.44, 0.62, 0.56, 0.8)),
  ],

  /** Castle. Three towers with crenellations and a portcullis gate. */
  castle: () => [
    ink(rect(0.34, 0.44, 0.66, 0.8)),
    ink(path([[0.2, 0.8], [0.2, 0.36], [0.34, 0.36], [0.34, 0.8]])),
    ink(path([[0.66, 0.8], [0.66, 0.36], [0.8, 0.36], [0.8, 0.8]])),
    ink(zigzag(0.2, 0.36, 0.34, 0.36, 3, 0.05), 3),
    ink(zigzag(0.66, 0.36, 0.8, 0.36, 3, 0.05), 3),
    ink(zigzag(0.34, 0.44, 0.66, 0.44, 5, 0.05), 3),
    ink(path([[0.44, 0.8], [0.44, 0.62], [0.5, 0.56], [0.56, 0.62], [0.56, 0.8]])),
    ink(line(0.5, 0.56, 0.5, 0.8), 2),
    ink(rect(0.24, 0.44, 0.3, 0.52), ),
    ink(rect(0.7, 0.44, 0.76, 0.52), ),
  ],

  /** Church. A nave, a steeple and a cross. */
  church: () => [
    ink(rect(0.3, 0.52, 0.7, 0.8)),
    ink(path([[0.26, 0.52], [0.5, 0.4], [0.74, 0.52]])),
    ink(path([[0.44, 0.4], [0.44, 0.26], [0.56, 0.26], [0.56, 0.4]])),
    ink(triangle(0.5, 0.14, 0.58, 0.26, 0.42, 0.26)),
    ink(line(0.5, 0.06, 0.5, 0.14), 3),
    ink(line(0.45, 0.1, 0.55, 0.1), 3),
    ink(path([[0.45, 0.8], [0.45, 0.66], [0.5, 0.62], [0.55, 0.66], [0.55, 0.8]])),
    ink(circle(0.36, 0.6, 0.035, 12), 2),
    ink(circle(0.64, 0.6, 0.035, 12), 2),
  ],

  /** Farm. A barn with a gambrel roof and a hayloft door. */
  farm: () => [
    tint(rect(0.26, 0.5, 0.74, 0.8), RED, 6),
    ink(path([[0.22, 0.5], [0.32, 0.38], [0.5, 0.32], [0.68, 0.38], [0.78, 0.5]])),
    ink(rect(0.44, 0.62, 0.56, 0.8)),
    ink(line(0.44, 0.62, 0.56, 0.8), 2),
    ink(line(0.56, 0.62, 0.44, 0.8), 2),
    ink(rect(0.46, 0.4, 0.54, 0.47), ),
    ink(line(0.22, 0.5, 0.78, 0.5), 2),
  ],

  /** Bridge. A deck on two arches, over water. */
  bridge: () => [
    ink(line(0.12, 0.46, 0.88, 0.46), 5),
    ink(arc(0.32, 0.46, 0.14, 0.16, 0, Math.PI, 12)),
    ink(arc(0.68, 0.46, 0.14, 0.16, 0, Math.PI, 12)),
    ink(line(0.16, 0.46, 0.16, 0.66), 3),
    ink(line(0.5, 0.46, 0.5, 0.62), 3),
    ink(line(0.84, 0.46, 0.84, 0.66), 3),
    ink(line(0.12, 0.38, 0.88, 0.38), 3),
    ink(line(0.2, 0.38, 0.2, 0.46), 2),
    ink(line(0.8, 0.38, 0.8, 0.46), 2),
    tint(path([[0.1, 0.74], [0.26, 0.72], [0.42, 0.74], [0.58, 0.72], [0.74, 0.74], [0.9, 0.72]]), BLUE, 4),
  ],

  /** Island. A mound with a palm, ringed by water. */
  island: () => [
    tint(arc(0.5, 0.68, 0.28, 0.16, Math.PI, Math.PI * 2, 16), YELLOW, 7),
    tint(line(0.14, 0.68, 0.86, 0.68), BLUE, 5),
    ink(path([[0.5, 0.68], [0.48, 0.44], [0.46, 0.36]]), 4),
    tint(path([[0.46, 0.36], [0.3, 0.3], [0.2, 0.36]]), GREEN, 5),
    tint(path([[0.46, 0.36], [0.34, 0.22], [0.26, 0.2]]), GREEN, 5),
    tint(path([[0.46, 0.36], [0.6, 0.24], [0.72, 0.26]]), GREEN, 5),
    tint(path([[0.46, 0.36], [0.64, 0.34], [0.76, 0.4]]), GREEN, 5),
  ],

  /** Mountain. Two peaks, a snow line and a sun behind. */
  mountain: () => [
    ink(path([[0.1, 0.78], [0.36, 0.3], [0.54, 0.6], [0.64, 0.46], [0.9, 0.78], [0.1, 0.78]])),
    ink(path([[0.28, 0.44], [0.33, 0.48], [0.36, 0.42], [0.4, 0.48], [0.44, 0.44]]), 2),
    ink(path([[0.6, 0.53], [0.64, 0.5], [0.68, 0.54]]), 2),
    ink(line(0.36, 0.3, 0.36, 0.42), 2),
  ],

  /** Tent. A triangle with a rolled-back flap and guy ropes. */
  tent: () => [
    ink(triangle(0.5, 0.28, 0.82, 0.74, 0.18, 0.74)),
    ink(path([[0.5, 0.28], [0.42, 0.74]]), 3),
    ink(path([[0.5, 0.28], [0.58, 0.74]]), 3),
    ink(line(0.18, 0.74, 0.82, 0.74), 3),
    ink(line(0.5, 0.28, 0.5, 0.2), 2),
    ink(line(0.5, 0.24, 0.12, 0.74), 2),
    ink(line(0.5, 0.24, 0.88, 0.74), 2),
  ],

  /** Cave. A dark mouth in a hillside, with stalactites. */
  cave: () => [
    ink(path([[0.1, 0.78], [0.2, 0.44], [0.5, 0.26], [0.8, 0.44], [0.9, 0.78]])),
    ink(arc(0.5, 0.78, 0.22, 0.26, Math.PI, Math.PI * 2, 16), 5),
    ink(line(0.1, 0.78, 0.9, 0.78), 4),
    ink(path([[0.36, 0.6], [0.39, 0.68], [0.42, 0.6]]), 2),
    ink(path([[0.52, 0.56], [0.55, 0.66], [0.58, 0.56]]), 2),
    ink(path([[0.62, 0.62], [0.64, 0.7], [0.66, 0.62]]), 2),
  ],

  /** Tower. A tall shaft with a conical cap and a flag. */
  tower: () => [
    ink(path([[0.38, 0.82], [0.4, 0.36], [0.6, 0.36], [0.62, 0.82]])),
    ink(triangle(0.5, 0.18, 0.66, 0.36, 0.34, 0.36)),
    ink(line(0.5, 0.18, 0.5, 0.1), 2),
    tint(closed([[0.5, 0.1], [0.66, 0.14], [0.5, 0.18]]), RED, 4),
    ink(rect(0.45, 0.44, 0.55, 0.54)),
    ink(line(0.45, 0.49, 0.55, 0.49), 2),
    ink(line(0.5, 0.44, 0.5, 0.54), 2),
    ink(line(0.36, 0.82, 0.64, 0.82), 4),
  ],

  /** Barn. Kept distinct from `farm` by the silo beside it. */
  barn: () => [
    tint(rect(0.24, 0.52, 0.66, 0.8), RED, 6),
    ink(path([[0.2, 0.52], [0.3, 0.4], [0.45, 0.34], [0.6, 0.4], [0.7, 0.52]])),
    ink(rect(0.38, 0.62, 0.52, 0.8)),
    ink(line(0.38, 0.62, 0.52, 0.8), 2),
    ink(line(0.52, 0.62, 0.38, 0.8), 2),
    ink(path([[0.72, 0.8], [0.72, 0.46], [0.86, 0.46], [0.86, 0.8]])),
    ink(arc(0.79, 0.46, 0.07, 0.06, Math.PI, Math.PI * 2, 10), 3),
  ],

  /** Park. A bench under a tree. */
  park: () => [
    ink(line(0.62, 0.74, 0.62, 0.5), 5),
    tint(circle(0.64, 0.36, 0.17), GREEN, 6),
    ink(line(0.18, 0.62, 0.5, 0.62), 4),
    ink(line(0.18, 0.56, 0.5, 0.56), 3),
    ink(line(0.22, 0.62, 0.22, 0.76), 3),
    ink(line(0.46, 0.62, 0.46, 0.76), 3),
    ink(line(0.22, 0.56, 0.22, 0.62), 3),
    ink(line(0.46, 0.56, 0.46, 0.62), 3),
    tint(line(0.1, 0.78, 0.9, 0.78), GREEN, 4),
  ],

  /** Beach. A sun over water, with a parasol in the sand. */
  beach: () => [
    tint(circle(0.78, 0.26, 0.1), YELLOW, 6),
    tint(path([[0.1, 0.5], [0.24, 0.48], [0.38, 0.5], [0.52, 0.48], [0.66, 0.5], [0.9, 0.48]]), BLUE, 4),
    tint(path([[0.1, 0.56], [0.26, 0.54], [0.42, 0.56], [0.58, 0.54], [0.74, 0.56], [0.9, 0.54]]), BLUE, 4),
    tint(arc(0.5, 0.74, 0.44, 0.12, Math.PI, Math.PI * 2, 16), YELLOW, 7),
    ink(line(0.34, 0.5, 0.34, 0.76), 3),
    ink(arc(0.34, 0.5, 0.16, 0.12, Math.PI, Math.PI * 2, 12), 3),
  ],

  /** Lighthouse. A banded tower with a lamp and light beams. */
  lighthouse: () => [
    ink(path([[0.36, 0.82], [0.42, 0.36], [0.58, 0.36], [0.64, 0.82]])),
    tint(path([[0.405, 0.5], [0.595, 0.5]]), RED, 7),
    tint(path([[0.39, 0.64], [0.61, 0.64]]), RED, 7),
    ink(rect(0.42, 0.26, 0.58, 0.36)),
    ink(triangle(0.5, 0.16, 0.6, 0.26, 0.4, 0.26)),
    tint(line(0.42, 0.29, 0.2, 0.22), YELLOW, 3),
    tint(line(0.58, 0.29, 0.8, 0.22), YELLOW, 3),
    ink(line(0.3, 0.82, 0.7, 0.82), 5),
  ],

  /** Windmill. A tapered tower with four sails. */
  windmill: () => [
    ink(path([[0.36, 0.82], [0.42, 0.4], [0.58, 0.4], [0.64, 0.82]])),
    ink(triangle(0.5, 0.28, 0.6, 0.4, 0.4, 0.4)),
    ink(line(0.5, 0.36, 0.5, 0.14), 4),
    ink(line(0.5, 0.36, 0.5, 0.58), 4),
    ink(line(0.5, 0.36, 0.28, 0.36), 4),
    ink(line(0.5, 0.36, 0.72, 0.36), 4),
    ink(rect(0.46, 0.6, 0.54, 0.72)),
  ],

  /** Igloo. A dome of blocks with an entrance tunnel. */
  igloo: () => [
    ink(arc(0.5, 0.72, 0.3, 0.3, Math.PI, Math.PI * 2, 20)),
    ink(line(0.2, 0.72, 0.8, 0.72), 4),
    ink(arc(0.5, 0.72, 0.2, 0.2, Math.PI, Math.PI * 2, 14), 2),
    ink(line(0.3, 0.6, 0.38, 0.52), 2),
    ink(line(0.7, 0.6, 0.62, 0.52), 2),
    ink(line(0.42, 0.44, 0.58, 0.44), 2),
    ink(arc(0.5, 0.72, 0.09, 0.11, Math.PI, Math.PI * 2, 10), 4),
  ],

  /** Pyramid. A stepped triangle with a sun and dune line. */
  pyramid: () => [
    tint(triangle(0.5, 0.24, 0.84, 0.72, 0.16, 0.72), YELLOW, 7),
    ink(line(0.5, 0.24, 0.6, 0.72), 3),
    ink(line(0.28, 0.56, 0.72, 0.56), 2),
    ink(line(0.36, 0.44, 0.64, 0.44), 2),
    ink(line(0.16, 0.72, 0.84, 0.72), 4),
    tint(circle(0.78, 0.24, 0.08), 0xffe07b39, 5),
  ],

  /** Treehouse. A hut in the branches, with a ladder. */
  treehouse: () => [
    ink(line(0.5, 0.82, 0.5, 0.36), 8),
    tint(circle(0.36, 0.28, 0.12), GREEN, 5),
    tint(circle(0.64, 0.28, 0.12), GREEN, 5),
    ink(rect(0.34, 0.46, 0.66, 0.66)),
    ink(path([[0.3, 0.46], [0.5, 0.34], [0.7, 0.46]])),
    ink(rect(0.42, 0.52, 0.52, 0.6), ),
    ink(line(0.6, 0.66, 0.62, 0.82), 3),
    ink(line(0.7, 0.66, 0.72, 0.82), 3),
    ink(line(0.61, 0.72, 0.71, 0.72), 2),
    ink(line(0.615, 0.78, 0.715, 0.78), 2),
  ],

  /** Zoo. A cage: bars and a padlocked gate. */
  zoo: () => [
    ink(rect(0.2, 0.32, 0.8, 0.8)),
    ...Array.from({ length: 5 }, (_, i) => ink(line(0.3 + i * 0.1, 0.32, 0.3 + i * 0.1, 0.8), 3)),
    ink(path([[0.2, 0.32], [0.5, 0.2], [0.8, 0.32]])),
    ink(circle(0.5, 0.56, 0.045, 12), 4),
    ink(arc(0.5, 0.52, 0.025, 0.03, Math.PI, Math.PI * 2, 8), 3),
  ],

  /** Garden. A fence, flowers and a watering line. */
  garden: () => [
    ink(line(0.12, 0.66, 0.88, 0.66), 4),
    ...Array.from({ length: 6 }, (_, i) =>
      ink(path([[0.16 + i * 0.14, 0.78], [0.16 + i * 0.14, 0.6], [0.14 + i * 0.14, 0.58]]), 3),
    ),
    tint(circle(0.3, 0.46, 0.06), RED, 5),
    tint(circle(0.52, 0.4, 0.06), YELLOW, 5),
    tint(circle(0.72, 0.48, 0.06), RED, 5),
    tint(line(0.3, 0.52, 0.3, 0.66), GREEN, 4),
    tint(line(0.52, 0.46, 0.52, 0.66), GREEN, 4),
    tint(line(0.72, 0.54, 0.72, 0.66), GREEN, 4),
  ],

  /** Skyscraper. A tall grid of windows with an aerial. */
  skyscraper: () => [
    ink(rect(0.36, 0.2, 0.64, 0.84)),
    ...Array.from({ length: 6 }, (_, i) => ink(line(0.36, 0.3 + i * 0.09, 0.64, 0.3 + i * 0.09), 2)),
    ink(line(0.45, 0.2, 0.45, 0.84), 2),
    ink(line(0.55, 0.2, 0.55, 0.84), 2),
    ink(line(0.5, 0.2, 0.5, 0.1), 3),
    tint(rect(0.24, 0.5, 0.36, 0.84), GREY, 4),
  ],

  /** Ferris wheel. A rim, spokes, gondolas and an A-frame. */
  'ferris wheel': () => [
    ink(circle(0.5, 0.42, 0.28)),
    ink(circle(0.5, 0.42, 0.04, 12), 3),
    ...Array.from({ length: 8 }, (_, i) => {
      const angle = (i / 8) * Math.PI * 2;
      return ink(
        path([
          [0.5, 0.42],
          [0.5 + Math.cos(angle) * 0.28, 0.42 + Math.sin(angle) * 0.28],
        ]),
        2,
      );
    }),
    ink(line(0.5, 0.42, 0.36, 0.82), 4),
    ink(line(0.5, 0.42, 0.64, 0.82), 4),
    ink(line(0.3, 0.82, 0.7, 0.82), 4),
  ],
});
