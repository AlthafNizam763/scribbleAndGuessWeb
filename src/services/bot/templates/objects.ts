import {
  BLUE,
  BROWN,
  GREEN,
  PINK,
  ORANGE,
  RED,
  YELLOW,
  arc,
  circle,
  closed,
  dot,
  ellipse,
  ink,
  line,
  path,
  rect,
  starPoly,
  tint,
  triangle,
  zigzag,
  type TemplateBuilder,
} from '@/services/bot/drawingShapes';

/**
 * Everyday objects.
 *
 * These are the easiest words in the bank to draw and the easiest to draw
 * *wrongly*: a cup, a bucket and a lamp are all a trapezium, and what tells
 * them apart is the handle, the rim and the flex. So the distinguishing part
 * is never optional here — it is an early stroke, before the difficulty cut
 * can drop it.
 */
export const OBJECT_TEMPLATES: Readonly<Record<string, TemplateBuilder>> = Object.freeze({
  /** Book. An open book, spine down, with lines of text. */
  book: () => [
    ink(closed([[0.26, 0.34], [0.5, 0.4], [0.74, 0.34], [0.74, 0.68], [0.5, 0.74], [0.26, 0.68]])),
    ink(line(0.5, 0.4, 0.5, 0.74)),
    ink(line(0.32, 0.44, 0.46, 0.48), 2),
    ink(line(0.32, 0.52, 0.46, 0.56), 2),
    ink(line(0.54, 0.48, 0.68, 0.44), 2),
    ink(line(0.54, 0.56, 0.68, 0.52), 2),
  ],

  /** Chair. Seen from the side: back, seat, four legs. */
  chair: () => [
    ink(line(0.36, 0.22, 0.36, 0.56)),
    ink(line(0.62, 0.36, 0.62, 0.56)),
    ink(line(0.36, 0.56, 0.68, 0.56)),
    ink(line(0.36, 0.3, 0.62, 0.38), 2),
    ink(line(0.36, 0.4, 0.62, 0.46), 2),
    ink(line(0.38, 0.56, 0.38, 0.78)),
    ink(line(0.66, 0.56, 0.68, 0.78)),
    ink(line(0.36, 0.5, 0.68, 0.56)),
  ],

  /** Table. A top on four legs, seen slightly from above. */
  table: () => [
    ink(closed([[0.2, 0.44], [0.8, 0.44], [0.72, 0.52], [0.28, 0.52]])),
    ink(line(0.3, 0.52, 0.3, 0.78), 4),
    ink(line(0.7, 0.52, 0.7, 0.78), 4),
    ink(line(0.38, 0.52, 0.38, 0.72), 3),
    ink(line(0.62, 0.52, 0.62, 0.72), 3),
  ],

  /** Cup. A tapered mug with an ear handle and steam. */
  cup: () => [
    ink(path([[0.34, 0.42], [0.38, 0.74], [0.62, 0.74], [0.66, 0.42], [0.34, 0.42]])),
    ink(ellipse(0.5, 0.42, 0.16, 0.05, 16), 2),
    ink(arc(0.68, 0.54, 0.09, 0.08, Math.PI * 1.55, Math.PI * 2.45, 12), 3),
    ink(arc(0.44, 0.3, 0.04, 0.06, Math.PI * 1.4, Math.PI * 2.6, 8), 2),
    ink(arc(0.56, 0.28, 0.04, 0.06, Math.PI * 1.4, Math.PI * 2.6, 8), 2),
  ],

  /** Spoon. A bowl on a long handle. */
  spoon: () => [
    ink(ellipse(0.5, 0.34, 0.09, 0.13, 20)),
    ink(line(0.5, 0.47, 0.5, 0.8), 5),
  ],

  /** Fork. Four tines on a handle. */
  fork: () => [
    ink(line(0.38, 0.22, 0.38, 0.4), 3),
    ink(line(0.46, 0.22, 0.46, 0.4), 3),
    ink(line(0.54, 0.22, 0.54, 0.4), 3),
    ink(line(0.62, 0.22, 0.62, 0.4), 3),
    ink(arc(0.5, 0.4, 0.12, 0.1, 0, Math.PI, 12)),
    ink(line(0.5, 0.5, 0.5, 0.82), 5),
  ],

  /** Key. A bow, a shaft and two teeth. */
  key: () => [
    ink(circle(0.3, 0.42, 0.11)),
    ink(circle(0.3, 0.42, 0.045, 12), 2),
    ink(line(0.41, 0.42, 0.78, 0.42), 5),
    ink(line(0.66, 0.42, 0.66, 0.54), 4),
    ink(line(0.76, 0.42, 0.76, 0.52), 4),
  ],

  /** Clock. A dial, a rim, two hands and a pair of bells. */
  clock: () => [
    ink(circle(0.5, 0.54, 0.24)),
    ink(circle(0.5, 0.54, 0.2, 20), 2),
    ink(line(0.5, 0.54, 0.5, 0.4), 4),
    ink(line(0.5, 0.54, 0.62, 0.6), 3),
    ink(line(0.5, 0.34, 0.5, 0.38), 2),
    ink(line(0.7, 0.54, 0.66, 0.54), 2),
    ink(arc(0.34, 0.3, 0.06, 0.06, Math.PI * 1.1, Math.PI * 2.1, 8), 3),
    ink(arc(0.66, 0.3, 0.06, 0.06, Math.PI * 0.9, Math.PI * 1.9, 8), 3),
  ],

  /** Hat. A top hat: crown, brim, band. */
  hat: () => [
    ink(path([[0.34, 0.6], [0.36, 0.26], [0.64, 0.26], [0.66, 0.6]])),
    ink(ellipse(0.5, 0.26, 0.14, 0.04, 14), 2),
    ink(ellipse(0.5, 0.6, 0.28, 0.06, 20)),
    tint(path([[0.34, 0.54], [0.66, 0.54]]), RED, 6),
  ],

  /** Shoe. A sole, an upper and laces. */
  shoe: () => [
    ink(path([[0.2, 0.7], [0.22, 0.54], [0.4, 0.5], [0.52, 0.58], [0.74, 0.6], [0.8, 0.7], [0.2, 0.7]])),
    ink(line(0.2, 0.7, 0.8, 0.7), 5),
    ink(line(0.3, 0.55, 0.38, 0.6), 2),
    ink(line(0.36, 0.53, 0.44, 0.58), 2),
    ink(arc(0.42, 0.52, 0.05, 0.04, Math.PI, Math.PI * 2, 8), 2),
  ],

  /** Ball. A football: a hexagon panel and seams. */
  ball: () => [
    ink(circle(0.5, 0.52, 0.24)),
    ink(
      closed([
        [0.5, 0.4],
        [0.6, 0.47],
        [0.56, 0.6],
        [0.44, 0.6],
        [0.4, 0.47],
      ]),
      3,
    ),
    ink(line(0.5, 0.4, 0.5, 0.28), 2),
    ink(line(0.6, 0.47, 0.72, 0.42), 2),
    ink(line(0.56, 0.6, 0.64, 0.72), 2),
    ink(line(0.44, 0.6, 0.36, 0.72), 2),
    ink(line(0.4, 0.47, 0.28, 0.42), 2),
  ],

  /** Umbrella. Canopy, scalloped hem, shaft and a hooked handle. */
  umbrella: () => [
    ink(arc(0.5, 0.52, 0.28, 0.26, Math.PI, Math.PI * 2, 22)),
    ink(
      path([
        [0.22, 0.52],
        [0.3, 0.58],
        [0.36, 0.52],
        [0.43, 0.58],
        [0.5, 0.52],
        [0.57, 0.58],
        [0.64, 0.52],
        [0.7, 0.58],
        [0.78, 0.52],
      ]),
    ),
    ink(line(0.5, 0.52, 0.5, 0.76)),
    ink(arc(0.44, 0.76, 0.06, 0.06, 0, Math.PI, 10)),
    ink(line(0.5, 0.3, 0.5, 0.26), 2),
  ],

  /** Pencil. A barrel, a sharpened tip and an eraser ferrule. */
  pencil: () => [
    ink(closed([[0.24, 0.66], [0.66, 0.3], [0.74, 0.4], [0.32, 0.76]])),
    ink(path([[0.24, 0.66], [0.18, 0.82], [0.32, 0.76]])),
    ink(line(0.21, 0.74, 0.27, 0.79), 2),
    ink(line(0.66, 0.3, 0.74, 0.4), 3),
    tint(path([[0.68, 0.28], [0.78, 0.36]]), PINK, 8),
  ],

  /** Scissors. Two blades crossed over two finger loops. */
  scissors: () => [
    ink(line(0.34, 0.24, 0.6, 0.6), 4),
    ink(line(0.66, 0.24, 0.4, 0.6), 4),
    ink(circle(0.36, 0.7, 0.08)),
    ink(circle(0.64, 0.7, 0.08)),
    dot(0.5, 0.48, 0.014),
  ],

  /** Hammer. A head and a handle. */
  hammer: () => [
    ink(rect(0.3, 0.26, 0.7, 0.38)),
    ink(path([[0.3, 0.32], [0.24, 0.28], [0.24, 0.38], [0.3, 0.36]]), 3),
    ink(rect(0.46, 0.38, 0.55, 0.8)),
    ink(line(0.46, 0.7, 0.55, 0.7), 2),
  ],

  /** Candle. A body, a wick, a flame and a drip. */
  candle: () => [
    ink(rect(0.42, 0.4, 0.58, 0.8)),
    ink(ellipse(0.5, 0.4, 0.08, 0.025, 12), 2),
    ink(line(0.5, 0.4, 0.5, 0.34), 2),
    tint(path([[0.5, 0.34], [0.45, 0.26], [0.5, 0.16], [0.55, 0.26], [0.5, 0.34]]), ORANGE, 5),
    ink(path([[0.44, 0.42], [0.43, 0.52]]), 2),
  ],

  /** Balloon. A bulb, a knot and a curling string. */
  balloon: () => [
    tint(ellipse(0.5, 0.4, 0.17, 0.2), RED, 6),
    ink(triangle(0.5, 0.6, 0.47, 0.65, 0.53, 0.65), 3),
    ink(
      path([
        [0.5, 0.65],
        [0.56, 0.7],
        [0.46, 0.75],
        [0.56, 0.8],
        [0.48, 0.85],
      ]),
      2,
    ),
  ],

  /** Kite. A diamond with cross-spars and a bow tail. */
  kite: () => [
    ink(closed([[0.5, 0.18], [0.7, 0.44], [0.5, 0.72], [0.3, 0.44]])),
    ink(line(0.5, 0.18, 0.5, 0.72), 2),
    ink(line(0.3, 0.44, 0.7, 0.44), 2),
    ink(path([[0.5, 0.72], [0.56, 0.8], [0.46, 0.86]]), 2),
    ink(line(0.52, 0.78, 0.6, 0.76), 3),
    ink(line(0.48, 0.84, 0.4, 0.84), 3),
  ],

  /** Drum. A barrel with tension ropes and two sticks. */
  drum: () => [
    ink(ellipse(0.5, 0.42, 0.24, 0.07, 20)),
    ink(line(0.26, 0.42, 0.3, 0.68)),
    ink(line(0.74, 0.42, 0.7, 0.68)),
    ink(arc(0.5, 0.68, 0.2, 0.06, 0, Math.PI, 14)),
    ink(line(0.34, 0.44, 0.42, 0.68), 2),
    ink(line(0.5, 0.45, 0.58, 0.68), 2),
    ink(line(0.66, 0.44, 0.58, 0.68), 2),
    ink(line(0.28, 0.3, 0.42, 0.4), 3),
    ink(line(0.72, 0.3, 0.58, 0.4), 3),
  ],

  /** Guitar. A figure-eight body, a neck and strings. */
  guitar: () => [
    ink(
      path([
        [0.5, 0.42],
        [0.36, 0.46],
        [0.32, 0.6],
        [0.4, 0.74],
        [0.6, 0.74],
        [0.68, 0.6],
        [0.64, 0.46],
        [0.5, 0.42],
      ]),
    ),
    ink(circle(0.5, 0.58, 0.06, 14), 2),
    ink(rect(0.46, 0.18, 0.54, 0.44)),
    ink(rect(0.44, 0.13, 0.56, 0.2)),
    ink(line(0.48, 0.2, 0.48, 0.58), 2),
    ink(line(0.52, 0.2, 0.52, 0.58), 2),
  ],

  /** Ladder. Two rails and four rungs. */
  ladder: () => [
    ink(line(0.36, 0.18, 0.32, 0.82), 4),
    ink(line(0.64, 0.18, 0.68, 0.82), 4),
    ink(line(0.355, 0.32, 0.645, 0.32), 3),
    ink(line(0.347, 0.46, 0.653, 0.46), 3),
    ink(line(0.339, 0.6, 0.661, 0.6), 3),
    ink(line(0.331, 0.74, 0.669, 0.74), 3),
  ],

  /** Bucket. A tapered tub with an arched handle. */
  bucket: () => [
    ink(path([[0.32, 0.44], [0.38, 0.78], [0.62, 0.78], [0.68, 0.44], [0.32, 0.44]])),
    ink(ellipse(0.5, 0.44, 0.18, 0.05, 16), 2),
    ink(arc(0.5, 0.44, 0.19, 0.18, Math.PI, Math.PI * 2, 14), 3),
  ],

  /** Broom. A handle and a fanned head. */
  broom: () => [
    ink(line(0.56, 0.16, 0.44, 0.58), 5),
    ink(closed([[0.44, 0.58], [0.3, 0.8], [0.54, 0.84], [0.52, 0.6]])),
    ink(line(0.38, 0.66, 0.36, 0.82), 2),
    ink(line(0.45, 0.63, 0.44, 0.83), 2),
    ink(line(0.5, 0.62, 0.5, 0.84), 2),
  ],

  /** Mirror. An oval glass in a stand. */
  mirror: () => [
    ink(ellipse(0.5, 0.42, 0.18, 0.24)),
    ink(ellipse(0.5, 0.42, 0.14, 0.2, 20), 2),
    ink(line(0.42, 0.34, 0.48, 0.28), 2),
    ink(line(0.46, 0.38, 0.52, 0.32), 2),
    ink(path([[0.44, 0.66], [0.42, 0.78], [0.58, 0.78], [0.56, 0.66]])),
    ink(line(0.34, 0.8, 0.66, 0.8), 4),
  ],

  /** Lamp. A shade, a stem and a base. */
  lamp: () => [
    ink(closed([[0.36, 0.44], [0.44, 0.24], [0.56, 0.24], [0.64, 0.44]])),
    ink(line(0.5, 0.44, 0.5, 0.74), 4),
    ink(path([[0.36, 0.78], [0.4, 0.74], [0.6, 0.74], [0.64, 0.78]]), 4),
    ink(line(0.34, 0.78, 0.66, 0.78), 4),
    tint(line(0.42, 0.5, 0.36, 0.58), YELLOW, 3),
    tint(line(0.58, 0.5, 0.64, 0.58), YELLOW, 3),
  ],

  /** Box. An open carton, drawn in three-quarter view. */
  box: () => [
    ink(closed([[0.28, 0.46], [0.5, 0.36], [0.72, 0.46], [0.5, 0.56]])),
    ink(line(0.28, 0.46, 0.28, 0.66), 3),
    ink(line(0.72, 0.46, 0.72, 0.66), 3),
    ink(path([[0.28, 0.66], [0.5, 0.76], [0.72, 0.66]])),
    ink(line(0.5, 0.56, 0.5, 0.76), 2),
  ],

  /** Bell. A dome, a lip and a clapper. */
  bell: () => [
    ink(path([[0.32, 0.66], [0.34, 0.48], [0.5, 0.32], [0.66, 0.48], [0.68, 0.66]])),
    ink(line(0.28, 0.66, 0.72, 0.66), 4),
    ink(circle(0.5, 0.72, 0.045, 12), 3),
    ink(line(0.5, 0.32, 0.5, 0.26), 3),
    ink(circle(0.5, 0.24, 0.025, 10), 2),
  ],

  /** Comb. A spine and a row of teeth. */
  comb: () => [
    ink(rect(0.2, 0.38, 0.8, 0.48)),
    ...Array.from({ length: 11 }, (_, i) =>
      ink(line(0.23 + i * 0.054, 0.48, 0.23 + i * 0.054, 0.66), 3),
    ),
  ],

  /** Sock. An L-shaped tube with a ribbed cuff. */
  sock: () => [
    ink(path([[0.4, 0.24], [0.4, 0.6], [0.28, 0.7], [0.3, 0.8], [0.62, 0.78], [0.6, 0.6], [0.6, 0.24], [0.4, 0.24]])),
    ink(line(0.4, 0.32, 0.6, 0.32), 3),
    ink(line(0.4, 0.38, 0.6, 0.38), 3),
    tint(line(0.34, 0.72, 0.6, 0.7), RED, 4),
  ],

  /** Backpack. A body, a flap, a pocket and two straps. */
  backpack: () => [
    ink(rect(0.32, 0.36, 0.68, 0.78)),
    ink(path([[0.32, 0.36], [0.36, 0.28], [0.64, 0.28], [0.68, 0.36]])),
    ink(path([[0.32, 0.5], [0.5, 0.56], [0.68, 0.5]]), 3),
    ink(rect(0.4, 0.6, 0.6, 0.72)),
    ink(arc(0.28, 0.5, 0.06, 0.14, Math.PI * 0.5, Math.PI * 1.5, 10), 3),
    ink(arc(0.72, 0.5, 0.06, 0.14, Math.PI * 1.5, Math.PI * 2.5, 10), 3),
  ],

  /** Anchor. A ring, a shank, a stock and two flukes. */
  anchor: () => [
    ink(circle(0.5, 0.26, 0.06, 14), 3),
    ink(line(0.5, 0.32, 0.5, 0.76), 5),
    ink(line(0.36, 0.4, 0.64, 0.4), 4),
    ink(path([[0.26, 0.58], [0.28, 0.72], [0.5, 0.8], [0.72, 0.72], [0.74, 0.58]])),
    ink(line(0.26, 0.58, 0.2, 0.62), 3),
    ink(line(0.74, 0.58, 0.8, 0.62), 3),
  ],

  /** Wallet. A folded billfold with a card sticking out. */
  wallet: () => [
    ink(rect(0.24, 0.4, 0.76, 0.7)),
    ink(line(0.24, 0.55, 0.76, 0.55), 2),
    ink(rect(0.46, 0.34, 0.68, 0.44)),
    ink(circle(0.7, 0.55, 0.035, 10), 3),
  ],

  /** Sunglasses. Two lenses, a bridge and two arms. */
  sunglasses: () => [
    ink(ellipse(0.35, 0.5, 0.13, 0.1, 18)),
    ink(ellipse(0.65, 0.5, 0.13, 0.1, 18)),
    ink(arc(0.5, 0.48, 0.09, 0.05, Math.PI, Math.PI * 2, 10), 3),
    ink(line(0.22, 0.47, 0.13, 0.42), 3),
    ink(line(0.78, 0.47, 0.87, 0.42), 3),
  ],

  /** Headphones. A band and two cups. */
  headphones: () => [
    ink(arc(0.5, 0.5, 0.26, 0.24, Math.PI, Math.PI * 2, 18), 5),
    ink(rect(0.18, 0.5, 0.31, 0.68)),
    ink(rect(0.69, 0.5, 0.82, 0.68)),
    ink(line(0.24, 0.5, 0.24, 0.68), 2),
    ink(line(0.76, 0.5, 0.76, 0.68), 2),
  ],

  /** Trophy. A cup with handles on a plinth, with a star. */
  trophy: () => [
    ink(path([[0.36, 0.28], [0.38, 0.5], [0.5, 0.58], [0.62, 0.5], [0.64, 0.28], [0.36, 0.28]])),
    ink(arc(0.3, 0.36, 0.07, 0.07, Math.PI * 0.5, Math.PI * 1.5, 10), 3),
    ink(arc(0.7, 0.36, 0.07, 0.07, Math.PI * 1.5, Math.PI * 2.5, 10), 3),
    ink(line(0.5, 0.58, 0.5, 0.68), 5),
    ink(rect(0.36, 0.68, 0.64, 0.78)),
    tint(starPoly(0.5, 0.39, 0.07, 0.03), YELLOW, 3),
  ],

  /** Candle-lit lantern is not in the bank; a medal is. */
  medal: () => [
    ink(path([[0.38, 0.2], [0.46, 0.44]]), 4),
    ink(path([[0.62, 0.2], [0.54, 0.44]]), 4),
    ink(line(0.38, 0.2, 0.62, 0.2), 4),
    tint(circle(0.5, 0.6, 0.17), YELLOW, 6),
    ink(circle(0.5, 0.6, 0.17, 20), 2),
    tint(starPoly(0.5, 0.6, 0.08, 0.035), ORANGE, 3),
  ],

  /** Whistle. A body, a mouthpiece and a lanyard ring. */
  whistle: () => [
    ink(path([[0.3, 0.44], [0.62, 0.44], [0.66, 0.54], [0.62, 0.64], [0.3, 0.64], [0.26, 0.54], [0.3, 0.44]])),
    ink(rect(0.62, 0.5, 0.78, 0.58)),
    ink(circle(0.34, 0.42, 0.035, 10), 3),
    ink(arc(0.34, 0.36, 0.05, 0.05, Math.PI, Math.PI * 2, 8), 2),
    ink(line(0.44, 0.44, 0.44, 0.64), 2),
  ],

  /** Helmet. A dome with a strap and a ventilation line. */
  helmet: () => [
    ink(arc(0.5, 0.58, 0.26, 0.26, Math.PI, Math.PI * 2, 18)),
    ink(line(0.24, 0.58, 0.76, 0.58), 4),
    ink(line(0.5, 0.32, 0.5, 0.58), 2),
    ink(arc(0.5, 0.58, 0.14, 0.14, Math.PI, Math.PI * 2, 12), 2),
    ink(path([[0.3, 0.6], [0.34, 0.74], [0.5, 0.76], [0.66, 0.74], [0.7, 0.6]]), 2),
  ],

  /** Teddy bear. A stuffed toy, seated, with stitched limbs. */
  'teddy bear': () => [
    tint(circle(0.5, 0.36, 0.14), BROWN, 6),
    ink(circle(0.37, 0.25, 0.055, 12), 3),
    ink(circle(0.63, 0.25, 0.055, 12), 3),
    ...[
      [0.45, 0.34],
      [0.55, 0.34],
    ].map(([x, y]) => dot(x as number, y as number, 0.014)),
    ink(ellipse(0.5, 0.4, 0.04, 0.03, 10), 2),
    tint(ellipse(0.5, 0.62, 0.15, 0.16), BROWN, 6),
    ink(ellipse(0.3, 0.6, 0.07, 0.05, 14), 3),
    ink(ellipse(0.7, 0.6, 0.07, 0.05, 14), 3),
    ink(ellipse(0.4, 0.8, 0.07, 0.05, 14), 3),
    ink(ellipse(0.6, 0.8, 0.07, 0.05, 14), 3),
  ],

  /** Hourglass. Two bulbs, a frame and falling sand. */
  hourglass: () => [
    ink(line(0.3, 0.22, 0.7, 0.22), 5),
    ink(line(0.3, 0.8, 0.7, 0.8), 5),
    ink(path([[0.34, 0.22], [0.5, 0.51], [0.34, 0.8]])),
    ink(path([[0.66, 0.22], [0.5, 0.51], [0.66, 0.8]])),
    tint(path([[0.38, 0.28], [0.5, 0.47], [0.62, 0.28]]), YELLOW, 4),
    tint(line(0.5, 0.52, 0.5, 0.74), YELLOW, 3),
    tint(path([[0.42, 0.78], [0.5, 0.7], [0.58, 0.78]]), YELLOW, 4),
  ],

  /** Suitcase. A case with a handle, a latch and a travel sticker. */
  suitcase: () => [
    ink(rect(0.24, 0.4, 0.76, 0.74)),
    ink(arc(0.5, 0.4, 0.09, 0.08, Math.PI, Math.PI * 2, 10), 4),
    ink(line(0.24, 0.52, 0.76, 0.52), 2),
    ink(rect(0.46, 0.49, 0.54, 0.55)),
    tint(rect(0.6, 0.6, 0.72, 0.68), BLUE, 3),
  ],

  /** Mailbox. A domed box on a post, with the flag up. */
  mailbox: () => [
    ink(arc(0.5, 0.5, 0.22, 0.16, Math.PI, Math.PI * 2, 16)),
    ink(rect(0.28, 0.5, 0.72, 0.64)),
    ink(line(0.62, 0.5, 0.62, 0.64), 2),
    tint(path([[0.72, 0.52], [0.84, 0.44], [0.84, 0.56], [0.72, 0.56]]), RED, 4),
    ink(line(0.5, 0.64, 0.5, 0.82), 5),
  ],

  /** Toolbox. A tray with a handle and two clasps. */
  toolbox: () => [
    ink(rect(0.24, 0.48, 0.76, 0.74)),
    ink(arc(0.5, 0.48, 0.12, 0.12, Math.PI, Math.PI * 2, 12), 4),
    ink(line(0.24, 0.58, 0.76, 0.58), 2),
    ink(rect(0.34, 0.54, 0.4, 0.62)),
    ink(rect(0.6, 0.54, 0.66, 0.62)),
  ],

  /** Piggy bank. A round pig with a coin slot. */
  'piggy bank': () => [
    tint(ellipse(0.5, 0.54, 0.24, 0.18), PINK, 6),
    ink(line(0.44, 0.38, 0.58, 0.38), 5),
    ink(ellipse(0.26, 0.56, 0.06, 0.05, 14)),
    dot(0.35, 0.5, 0.014),
    ink(triangle(0.36, 0.4, 0.34, 0.3, 0.46, 0.38), 3),
    ink(line(0.36, 0.72, 0.36, 0.8), 4),
    ink(line(0.62, 0.72, 0.62, 0.8), 4),
    ink(arc(0.76, 0.52, 0.05, 0.05, Math.PI * 1.2, Math.PI * 3.2, 12), 3),
  ],

  /** Telescope. A tube on a tripod, pointed up. */
  telescope: () => [
    ink(closed([[0.26, 0.5], [0.66, 0.24], [0.74, 0.34], [0.34, 0.6]])),
    ink(line(0.26, 0.5, 0.34, 0.6), 3),
    ink(line(0.66, 0.24, 0.74, 0.34), 3),
    ink(line(0.44, 0.52, 0.36, 0.82), 4),
    ink(line(0.5, 0.48, 0.6, 0.82), 4),
    ink(line(0.46, 0.5, 0.48, 0.82), 3),
  ],

  /** Compass. A dial with a needle and the cardinal ticks. */
  compass: () => [
    ink(circle(0.5, 0.52, 0.25)),
    ink(circle(0.5, 0.52, 0.2, 20), 2),
    tint(path([[0.5, 0.52], [0.6, 0.34], [0.5, 0.52]]), RED, 5),
    ink(path([[0.5, 0.52], [0.4, 0.7], [0.5, 0.52]]), 4),
    dot(0.5, 0.52, 0.015),
    ink(line(0.5, 0.29, 0.5, 0.33), 2),
    ink(line(0.5, 0.71, 0.5, 0.75), 2),
    ink(line(0.27, 0.52, 0.31, 0.52), 2),
    ink(line(0.69, 0.52, 0.73, 0.52), 2),
  ],

  /** Crown. A band with points and jewels. */
  crown: () => [
    ink(
      closed([
        [0.24, 0.66],
        [0.24, 0.38],
        [0.36, 0.5],
        [0.5, 0.32],
        [0.64, 0.5],
        [0.76, 0.38],
        [0.76, 0.66],
      ]),
    ),
    ink(line(0.24, 0.58, 0.76, 0.58), 3),
    tint(circle(0.36, 0.44, 0.02, 8), RED, 3),
    tint(circle(0.5, 0.4, 0.024, 8), BLUE, 3),
    tint(circle(0.64, 0.44, 0.02, 8), GREEN, 3),
  ],

  /** Watering can. A body, a spout with a rose, and a handle. */
  'watering can': () => [
    ink(path([[0.3, 0.44], [0.34, 0.76], [0.64, 0.76], [0.66, 0.44], [0.3, 0.44]])),
    ink(line(0.28, 0.44, 0.68, 0.44), 3),
    ink(path([[0.66, 0.52], [0.82, 0.38], [0.88, 0.44]]), 4),
    ink(line(0.8, 0.34, 0.9, 0.48), 4),
    ink(arc(0.48, 0.42, 0.1, 0.12, Math.PI * 1.05, Math.PI * 1.95, 10), 3),
    tint(line(0.86, 0.5, 0.84, 0.62), BLUE, 3),
    tint(line(0.9, 0.5, 0.92, 0.6), BLUE, 3),
  ],

  /** Skateboard. A deck with a kicktail and two trucks. */
  skateboard: () => [
    ink(path([[0.18, 0.56], [0.22, 0.5], [0.78, 0.5], [0.82, 0.56], [0.78, 0.6], [0.22, 0.6], [0.18, 0.56]])),
    ink(line(0.34, 0.6, 0.34, 0.66), 3),
    ink(line(0.66, 0.6, 0.66, 0.66), 3),
    ink(circle(0.32, 0.68, 0.04, 12), 3),
    ink(circle(0.68, 0.68, 0.04, 12), 3),
    tint(zigzag(0.28, 0.55, 0.72, 0.55, 5, 0.02), ORANGE, 2),
  ],
});

