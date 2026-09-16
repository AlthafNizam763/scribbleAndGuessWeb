import {
  BROWN,
  GREEN,
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
 * Food.
 *
 * Fruit is the hard case here, because most fruit is a circle: an apple, an
 * orange, a tomato and a peach are all the same outline. So each one is
 * separated by the parts that are *not* the circle — the apple's stem and
 * leaf, the orange's segment lines, the tomato's star of sepals — and by
 * colour, which the wire format carries and the client renders.
 */
export const FOOD_TEMPLATES: Readonly<Record<string, TemplateBuilder>> = Object.freeze({
  /** Apple. Body, stem, leaf — in that order, as the brief asks. */
  apple: () => [
    tint(
      path([
        [0.5, 0.34],
        [0.34, 0.38],
        [0.28, 0.54],
        [0.36, 0.72],
        [0.5, 0.78],
        [0.64, 0.72],
        [0.72, 0.54],
        [0.66, 0.38],
        [0.5, 0.34],
      ]),
      RED,
      6,
    ),
    ink(path([[0.5, 0.36], [0.53, 0.26], [0.51, 0.2]]), 3),
    tint(closed([[0.53, 0.25], [0.66, 0.18], [0.62, 0.3], [0.53, 0.29]]), GREEN, 4),
    ink(arc(0.5, 0.36, 0.05, 0.03, Math.PI * 1.15, Math.PI * 1.85, 8), 2),
  ],

  /** Banana. Two arcs and a stem cap. */
  banana: () => [
    tint(arc(0.5, 0.32, 0.28, 0.32, 0.36 * Math.PI, 0.96 * Math.PI, 18), YELLOW, 7),
    tint(arc(0.5, 0.24, 0.33, 0.37, 0.4 * Math.PI, 0.92 * Math.PI, 18), YELLOW, 7),
    ink(path([[0.24, 0.66], [0.2, 0.74]]), 4),
    ink(path([[0.76, 0.6], [0.82, 0.66]]), 4),
  ],

  /** Orange. The cut face: segment spokes inside a ring. */
  orange: () => [
    tint(circle(0.5, 0.54, 0.24), ORANGE, 6),
    ink(circle(0.5, 0.54, 0.2, 20), 2),
    ...Array.from({ length: 8 }, (_, i) => {
      const angle = (i / 8) * Math.PI * 2;
      return ink(
        path([
          [0.5, 0.54],
          [0.5 + Math.cos(angle) * 0.19, 0.54 + Math.sin(angle) * 0.19],
        ]),
        2,
      );
    }),
    tint(path([[0.52, 0.3], [0.62, 0.24]]), GREEN, 4),
  ],

  /** Pizza. A slice, with a crust band and toppings. */
  pizza: () => [
    ink(triangle(0.5, 0.22, 0.76, 0.74, 0.24, 0.74)),
    tint(path([[0.26, 0.72], [0.74, 0.72]]), BROWN, 8),
    tint(circle(0.46, 0.5, 0.034, 10), RED, 4),
    tint(circle(0.58, 0.6, 0.034, 10), RED, 4),
    tint(circle(0.4, 0.63, 0.034, 10), RED, 4),
    tint(circle(0.53, 0.38, 0.028, 10), RED, 4),
  ],

  /** Cake. Two tiers, candles, and the frosting drips. */
  cake: () => [
    ink(rect(0.26, 0.5, 0.74, 0.76)),
    ink(zigzag(0.26, 0.56, 0.74, 0.56, 6, 0.04), 3),
    ink(line(0.26, 0.68, 0.74, 0.68), 2),
    ink(line(0.42, 0.5, 0.42, 0.36), 3),
    ink(line(0.5, 0.5, 0.5, 0.34), 3),
    ink(line(0.58, 0.5, 0.58, 0.36), 3),
    tint(path([[0.42, 0.36], [0.41, 0.31], [0.43, 0.31], [0.42, 0.36]]), ORANGE, 3),
    tint(path([[0.5, 0.34], [0.49, 0.29], [0.51, 0.29], [0.5, 0.34]]), ORANGE, 3),
    tint(path([[0.58, 0.36], [0.57, 0.31], [0.59, 0.31], [0.58, 0.36]]), ORANGE, 3),
  ],

  /** Egg. A fried egg: the white, then the yolk. */
  egg: () => [
    ink(
      path([
        [0.3, 0.5],
        [0.36, 0.36],
        [0.52, 0.32],
        [0.66, 0.4],
        [0.74, 0.54],
        [0.64, 0.68],
        [0.46, 0.72],
        [0.32, 0.64],
        [0.3, 0.5],
      ]),
    ),
    tint(circle(0.5, 0.52, 0.09), YELLOW, 6),
    ink(circle(0.5, 0.52, 0.09, 16), 2),
  ],

  /** Bread. A loaf with a domed top and score marks. */
  bread: () => [
    ink(path([[0.24, 0.72], [0.24, 0.52], [0.34, 0.4], [0.66, 0.4], [0.76, 0.52], [0.76, 0.72], [0.24, 0.72]])),
    ink(arc(0.5, 0.46, 0.21, 0.1, Math.PI, Math.PI * 2, 14), 2),
    ink(line(0.38, 0.46, 0.44, 0.4), 2),
    ink(line(0.5, 0.47, 0.56, 0.41), 2),
    ink(line(0.62, 0.46, 0.68, 0.42), 2),
  ],

  /** Cheese. A wedge with holes. */
  cheese: () => [
    tint(path([[0.22, 0.68], [0.22, 0.46], [0.74, 0.34], [0.74, 0.58], [0.22, 0.68]]), YELLOW, 6),
    ink(line(0.22, 0.46, 0.74, 0.34), 3),
    ink(circle(0.36, 0.56, 0.035, 10), 3),
    ink(circle(0.52, 0.5, 0.03, 10), 3),
    ink(circle(0.64, 0.46, 0.025, 10), 3),
  ],

  /** Carrot. A long orange cone with leafy fronds. */
  carrot: () => [
    tint(closed([[0.5, 0.82], [0.4, 0.42], [0.6, 0.42]]), ORANGE, 6),
    ink(line(0.44, 0.56, 0.54, 0.54), 2),
    ink(line(0.46, 0.66, 0.55, 0.64), 2),
    tint(path([[0.5, 0.42], [0.42, 0.28], [0.36, 0.22]]), GREEN, 5),
    tint(path([[0.5, 0.42], [0.5, 0.26], [0.48, 0.18]]), GREEN, 5),
    tint(path([[0.5, 0.42], [0.6, 0.28], [0.66, 0.22]]), GREEN, 5),
  ],

  /** Grapes. A triangular cluster of berries. */
  grapes: () => [
    ...[
      [0.5, 0.36],
      [0.42, 0.46],
      [0.58, 0.46],
      [0.34, 0.56],
      [0.5, 0.56],
      [0.66, 0.56],
      [0.42, 0.66],
      [0.58, 0.66],
      [0.5, 0.76],
    ].map(([x, y]) => tint(circle(x as number, y as number, 0.055, 12), PURPLE, 4)),
    ink(path([[0.5, 0.34], [0.52, 0.24]]), 3),
    tint(closed([[0.52, 0.26], [0.64, 0.2], [0.6, 0.3]]), GREEN, 4),
  ],

  /** Ice cream. A cone with two scoops and a waffle grid. */
  'ice cream': () => [
    ink(triangle(0.5, 0.84, 0.36, 0.5, 0.64, 0.5)),
    ink(line(0.4, 0.58, 0.58, 0.62), 2),
    ink(line(0.44, 0.7, 0.56, 0.72), 2),
    tint(circle(0.43, 0.42, 0.11), PINK, 5),
    tint(circle(0.58, 0.38, 0.11), BROWN, 5),
    tint(circle(0.5, 0.26, 0.09), RED, 5),
  ],

  /** Hot dog. A sausage inside a split bun, with a mustard zigzag. */
  'hot dog': () => [
    ink(path([[0.16, 0.6], [0.2, 0.5], [0.8, 0.5], [0.84, 0.6], [0.8, 0.7], [0.2, 0.7], [0.16, 0.6]])),
    tint(path([[0.22, 0.56], [0.78, 0.56]]), BROWN, 12),
    tint(zigzag(0.26, 0.55, 0.74, 0.55, 6, 0.04), YELLOW, 4),
    ink(line(0.2, 0.66, 0.8, 0.66), 2),
  ],

  /** Burger. Bun, patty, lettuce, bun — stacked. */
  burger: () => [
    ink(arc(0.5, 0.46, 0.26, 0.16, Math.PI, Math.PI * 2, 16)),
    ink(line(0.24, 0.46, 0.76, 0.46), 2),
    tint(zigzag(0.24, 0.52, 0.76, 0.52, 7, 0.035), GREEN, 4),
    tint(path([[0.24, 0.6], [0.76, 0.6]]), BROWN, 10),
    ink(arc(0.5, 0.66, 0.26, 0.12, 0, Math.PI, 14)),
    ink(circle(0.42, 0.38, 0.012, 8), 2),
    ink(circle(0.56, 0.36, 0.012, 8), 2),
  ],

  /** Donut. A ring with icing drips. */
  donut: () => [
    ink(circle(0.5, 0.52, 0.25)),
    ink(circle(0.5, 0.52, 0.09, 16)),
    tint(
      path([
        [0.26, 0.5],
        [0.32, 0.56],
        [0.4, 0.48],
        [0.5, 0.56],
        [0.6, 0.48],
        [0.68, 0.56],
        [0.74, 0.5],
      ]),
      PINK,
      5,
    ),
    ink(line(0.38, 0.34, 0.42, 0.32), 3),
    ink(line(0.58, 0.36, 0.62, 0.34), 3),
    ink(line(0.46, 0.7, 0.5, 0.72), 3),
  ],

  /** Cookie. A disc with chocolate chips. */
  cookie: () => [
    tint(circle(0.5, 0.52, 0.24), BROWN, 6),
    ink(circle(0.42, 0.42, 0.025, 10), 4),
    ink(circle(0.58, 0.46, 0.025, 10), 4),
    ink(circle(0.48, 0.58, 0.025, 10), 4),
    ink(circle(0.62, 0.64, 0.025, 10), 4),
    ink(circle(0.36, 0.6, 0.025, 10), 4),
  ],

  /** Lemon. A pointed oval with a pip mark at each end. */
  lemon: () => [
    tint(ellipse(0.5, 0.52, 0.24, 0.16), YELLOW, 6),
    ink(path([[0.26, 0.52], [0.2, 0.5]]), 3),
    ink(path([[0.74, 0.52], [0.8, 0.5]]), 3),
    ink(arc(0.5, 0.52, 0.16, 0.1, Math.PI * 1.1, Math.PI * 1.9, 10), 2),
  ],

  /** Cherry. Two fruits on a shared stem, with a leaf. */
  cherry: () => [
    tint(circle(0.38, 0.66, 0.1), RED, 5),
    tint(circle(0.62, 0.7, 0.1), RED, 5),
    ink(path([[0.38, 0.56], [0.46, 0.36], [0.5, 0.28]]), 3),
    ink(path([[0.62, 0.6], [0.56, 0.4], [0.5, 0.28]]), 3),
    tint(closed([[0.5, 0.28], [0.64, 0.22], [0.58, 0.32]]), GREEN, 4),
  ],

  /** Strawberry. A heart-shaped body with seeds and a crown. */
  strawberry: () => [
    tint(path([[0.5, 0.8], [0.3, 0.58], [0.34, 0.42], [0.5, 0.4], [0.66, 0.42], [0.7, 0.58], [0.5, 0.8]]), RED, 6),
    tint(path([[0.36, 0.42], [0.3, 0.32], [0.44, 0.36], [0.5, 0.26], [0.56, 0.36], [0.7, 0.32], [0.64, 0.42]]), GREEN, 4),
    ink(circle(0.44, 0.52, 0.012, 8), 2),
    ink(circle(0.56, 0.54, 0.012, 8), 2),
    ink(circle(0.5, 0.64, 0.012, 8), 2),
  ],

  /** Watermelon. A wedge: rind, pith line, pips. */
  watermelon: () => [
    tint(arc(0.5, 0.3, 0.3, 0.42, 0, Math.PI, 18), GREEN, 7),
    ink(line(0.2, 0.3, 0.8, 0.3), 3),
    ink(arc(0.5, 0.3, 0.26, 0.36, 0, Math.PI, 16), 2),
    ink(circle(0.42, 0.46, 0.014, 8), 3),
    ink(circle(0.56, 0.44, 0.014, 8), 3),
    ink(circle(0.5, 0.58, 0.014, 8), 3),
  ],

  /** Pineapple. A cross-hatched body under a spiky crown. */
  pineapple: () => [
    tint(ellipse(0.5, 0.6, 0.18, 0.22), YELLOW, 6),
    ink(line(0.34, 0.5, 0.66, 0.66), 2),
    ink(line(0.34, 0.62, 0.66, 0.76), 2),
    ink(line(0.66, 0.5, 0.34, 0.66), 2),
    ink(line(0.66, 0.62, 0.34, 0.76), 2),
    tint(path([[0.5, 0.38], [0.4, 0.22], [0.46, 0.34]]), GREEN, 4),
    tint(path([[0.5, 0.38], [0.5, 0.18]]), GREEN, 4),
    tint(path([[0.5, 0.38], [0.6, 0.22], [0.54, 0.34]]), GREEN, 4),
  ],

  /** Mushroom. A domed cap with spots on a stubby stem. */
  mushroom: () => [
    tint(arc(0.5, 0.52, 0.26, 0.22, Math.PI, Math.PI * 2, 18), RED, 6),
    ink(line(0.24, 0.52, 0.76, 0.52), 3),
    ink(circle(0.4, 0.42, 0.035, 10), 3),
    ink(circle(0.58, 0.38, 0.03, 10), 3),
    ink(path([[0.4, 0.52], [0.42, 0.76], [0.58, 0.76], [0.6, 0.52]])),
  ],

  /** Tomato. A round fruit under a star of sepals. */
  tomato: () => [
    tint(circle(0.5, 0.58, 0.22), RED, 6),
    tint(path([[0.5, 0.36], [0.38, 0.3], [0.48, 0.34], [0.5, 0.26], [0.52, 0.34], [0.62, 0.3], [0.5, 0.36]]), GREEN, 4),
    ink(path([[0.5, 0.36], [0.5, 0.3]]), 3),
    ink(arc(0.5, 0.58, 0.14, 0.12, Math.PI * 1.15, Math.PI * 1.75, 8), 2),
  ],

  /** Onion. A bulb with vertical seams and shoots. */
  onion: () => [
    ink(path([[0.5, 0.38], [0.3, 0.5], [0.32, 0.7], [0.5, 0.8], [0.68, 0.7], [0.7, 0.5], [0.5, 0.38]])),
    ink(path([[0.5, 0.4], [0.44, 0.6], [0.5, 0.79]]), 2),
    ink(path([[0.5, 0.4], [0.58, 0.6], [0.5, 0.79]]), 2),
    tint(path([[0.5, 0.38], [0.42, 0.24]]), GREEN, 4),
    tint(path([[0.5, 0.38], [0.56, 0.22]]), GREEN, 4),
  ],

  /** Corn. A cob with kernel rows and two husk leaves. */
  corn: () => [
    tint(ellipse(0.5, 0.5, 0.11, 0.26), YELLOW, 6),
    ink(line(0.4, 0.38, 0.6, 0.38), 2),
    ink(line(0.39, 0.5, 0.61, 0.5), 2),
    ink(line(0.4, 0.62, 0.6, 0.62), 2),
    ink(line(0.5, 0.26, 0.5, 0.74), 2),
    tint(path([[0.4, 0.62], [0.24, 0.74], [0.38, 0.72]]), GREEN, 5),
    tint(path([[0.6, 0.62], [0.76, 0.74], [0.62, 0.72]]), GREEN, 5),
  ],

  /** Popcorn. A striped tub overflowing with puffs. */
  popcorn: () => [
    ink(path([[0.32, 0.46], [0.38, 0.8], [0.62, 0.8], [0.68, 0.46], [0.32, 0.46]])),
    tint(line(0.42, 0.46, 0.44, 0.8), RED, 4),
    tint(line(0.56, 0.46, 0.58, 0.8), RED, 4),
    ink(circle(0.4, 0.38, 0.06, 12), 3),
    ink(circle(0.52, 0.32, 0.06, 12), 3),
    ink(circle(0.63, 0.4, 0.055, 12), 3),
    ink(circle(0.3, 0.32, 0.045, 10), 3),
  ],

  /** Sandwich. A triangular half, cut corner up. */
  sandwich: () => [
    ink(triangle(0.5, 0.28, 0.8, 0.72, 0.2, 0.72)),
    ink(line(0.29, 0.58, 0.71, 0.58), 2),
    tint(zigzag(0.3, 0.6, 0.7, 0.6, 6, 0.03), GREEN, 4),
    tint(line(0.33, 0.66, 0.67, 0.66), RED, 5),
    ink(line(0.24, 0.66, 0.76, 0.66), 2),
  ],

  /** Pear. A narrow top over a round base. */
  pear: () => [
    tint(path([[0.5, 0.3], [0.42, 0.42], [0.36, 0.56], [0.4, 0.74], [0.56, 0.78], [0.66, 0.64], [0.6, 0.46], [0.5, 0.3]]), GREEN, 6),
    ink(path([[0.5, 0.3], [0.52, 0.2]]), 3),
    tint(closed([[0.52, 0.22], [0.64, 0.16], [0.6, 0.26]]), GREEN, 4),
  ],

  /** Taco. A folded shell with filling spilling out. */
  taco: () => [
    ink(arc(0.5, 0.64, 0.3, 0.3, Math.PI, Math.PI * 2, 18)),
    ink(line(0.2, 0.64, 0.8, 0.64), 3),
    tint(zigzag(0.24, 0.5, 0.76, 0.5, 8, 0.05), GREEN, 4),
    tint(circle(0.4, 0.52, 0.03, 10), RED, 4),
    tint(circle(0.58, 0.5, 0.03, 10), RED, 4),
    tint(line(0.3, 0.58, 0.7, 0.58), YELLOW, 5),
  ],

  /** Cupcake. A fluted case under a swirl of icing. */
  cupcake: () => [
    ink(path([[0.32, 0.52], [0.38, 0.8], [0.62, 0.8], [0.68, 0.52], [0.32, 0.52]])),
    ink(line(0.4, 0.52, 0.42, 0.8), 2),
    ink(line(0.5, 0.52, 0.5, 0.8), 2),
    ink(line(0.6, 0.52, 0.58, 0.8), 2),
    tint(
      path([
        [0.3, 0.52],
        [0.36, 0.4],
        [0.48, 0.44],
        [0.52, 0.32],
        [0.62, 0.38],
        [0.7, 0.52],
      ]),
      PINK,
      6,
    ),
    tint(circle(0.52, 0.28, 0.03, 10), RED, 4),
  ],

  /** Avocado. A halved fruit with a round stone. */
  avocado: () => [
    tint(path([[0.5, 0.26], [0.36, 0.42], [0.32, 0.62], [0.5, 0.78], [0.68, 0.62], [0.64, 0.42], [0.5, 0.26]]), GREEN, 6),
    ink(path([[0.5, 0.3], [0.39, 0.44], [0.36, 0.61], [0.5, 0.74], [0.64, 0.61], [0.61, 0.44], [0.5, 0.3]]), 2),
    tint(circle(0.5, 0.56, 0.1), BROWN, 6),
  ],

  /** Pumpkin. Ribbed lobes and a squat stem. */
  pumpkin: () => [
    tint(ellipse(0.5, 0.58, 0.26, 0.2), ORANGE, 6),
    ink(arc(0.5, 0.58, 0.1, 0.2, 0, Math.PI * 2, 18), 2),
    ink(arc(0.5, 0.58, 0.19, 0.2, 0, Math.PI * 2, 18), 2),
    ink(path([[0.5, 0.38], [0.5, 0.28], [0.58, 0.26]]), 4),
    tint(path([[0.5, 0.3], [0.42, 0.24]]), GREEN, 3),
  ],

  /** Peanut. A shell pinched in the middle, with a cross-hatch. */
  peanut: () => [
    ink(
      path([
        [0.3, 0.4],
        [0.44, 0.36],
        [0.52, 0.48],
        [0.66, 0.5],
        [0.72, 0.62],
        [0.6, 0.74],
        [0.46, 0.68],
        [0.38, 0.56],
        [0.26, 0.52],
        [0.3, 0.4],
      ]),
    ),
    ink(line(0.34, 0.44, 0.44, 0.5), 2),
    ink(line(0.56, 0.56, 0.66, 0.62), 2),
    ink(line(0.4, 0.42, 0.36, 0.5), 2),
  ],

  /** Lollipop. A spiral disc on a stick. */
  lollipop: () => [
    ink(
      path(
        Array.from({ length: 40 }, (_, i) => {
          const t = (i / 39) * Math.PI * 4;
          const r = 0.015 + (t / (Math.PI * 4)) * 0.17;
          return [0.5 + Math.cos(t) * r, 0.42 + Math.sin(t) * r] as const;
        }),
      ),
      4,
    ),
    ink(circle(0.5, 0.42, 0.19, 20), 3),
    ink(line(0.5, 0.61, 0.5, 0.84), 5),
    dot(0.5, 0.42, 0.01, 2),
  ],
});
