import {
  BLUE,
  BROWN,
  GREEN,
  GREY,
  ORANGE,
  RED,
  YELLOW,
  arc,
  circle,
  closed,
  ellipse,
  ink,
  line,
  path,
  rays,
  rect,
  scallop,
  starPoly,
  tint,
  triangle,
  zigzag,
  type TemplateBuilder,
} from '@/services/bot/drawingShapes';

/**
 * Nature and weather.
 *
 * The sun, the moon and a star are the three words most likely to be confused
 * with one another on a small canvas, and they are separated here by shape
 * alone rather than by colour: a disc with rays, a crescent, a five-pointed
 * outline. A guesser on a monochrome screen still tells them apart.
 */
export const NATURE_TEMPLATES: Readonly<Record<string, TemplateBuilder>> = Object.freeze({
  /** Sun. A disc and eight rays. */
  sun: () => [
    tint(circle(0.5, 0.46, 0.15), YELLOW, 7),
    ...rays(0.5, 0.46, 0.2, 0.3, 8, YELLOW, 5),
  ],

  /** Moon. A crescent, with two stars so it reads as night. */
  moon: () => [
    ink(arc(0.5, 0.5, 0.24, 0.26, Math.PI * 0.35, Math.PI * 1.65, 20)),
    ink(arc(0.38, 0.5, 0.3, 0.3, Math.PI * 1.72, Math.PI * 2.28, 16)),
    tint(starPoly(0.78, 0.26, 0.04, 0.017), YELLOW, 3),
    tint(starPoly(0.84, 0.44, 0.03, 0.013), YELLOW, 3),
  ],

  /** Star. One five-pointed outline, drawn large. */
  star: () => [tint(starPoly(0.5, 0.5, 0.3, 0.13), YELLOW, 6)],

  /** Cloud. A scalloped hull on a flat base. */
  cloud: () => [
    ink(arc(0.38, 0.54, 0.14, 0.14, Math.PI, Math.PI * 2, 12)),
    ink(arc(0.54, 0.5, 0.18, 0.18, Math.PI, Math.PI * 2, 14)),
    ink(arc(0.68, 0.56, 0.12, 0.12, Math.PI, Math.PI * 2, 10)),
    ink(line(0.24, 0.54, 0.8, 0.56), 4),
  ],

  /** Rain. A cloud with falling drops. */
  rain: () => [
    ink(arc(0.4, 0.4, 0.14, 0.13, Math.PI, Math.PI * 2, 12)),
    ink(arc(0.56, 0.36, 0.17, 0.16, Math.PI, Math.PI * 2, 14)),
    ink(line(0.26, 0.4, 0.73, 0.42), 4),
    ...[0.32, 0.44, 0.56, 0.68].map((x, i) =>
      tint(line(x, 0.5 + i * 0.02, x - 0.03, 0.66 + i * 0.02), BLUE, 4),
    ),
    tint(line(0.38, 0.62, 0.35, 0.76), BLUE, 4),
    tint(line(0.62, 0.6, 0.59, 0.74), BLUE, 4),
  ],

  /** Snow. A cloud with flakes below it. */
  snow: () => [
    ink(arc(0.4, 0.38, 0.14, 0.13, Math.PI, Math.PI * 2, 12)),
    ink(arc(0.56, 0.34, 0.17, 0.16, Math.PI, Math.PI * 2, 14)),
    ink(line(0.26, 0.38, 0.73, 0.4), 4),
    ...[
      [0.34, 0.56],
      [0.5, 0.64],
      [0.66, 0.56],
      [0.42, 0.76],
      [0.6, 0.78],
    ].flatMap(([x, y]) => [
      ink(line((x as number) - 0.03, y as number, (x as number) + 0.03, y as number), 2),
      ink(line(x as number, (y as number) - 0.03, x as number, (y as number) + 0.03), 2),
    ]),
  ],

  /** Snowflake. One large six-armed crystal with barbs. */
  snowflake: () => [
    ...rays(0.5, 0.5, 0, 0.3, 6, BLUE, 4),
    ...Array.from({ length: 6 }, (_, i) => {
      const angle = (i / 6) * Math.PI * 2;
      const tipX = 0.5 + Math.cos(angle) * 0.2;
      const tipY = 0.5 + Math.sin(angle) * 0.2;
      return tint(
        path([
          [tipX + Math.cos(angle + 2.2) * 0.07, tipY + Math.sin(angle + 2.2) * 0.07],
          [tipX, tipY],
          [tipX + Math.cos(angle - 2.2) * 0.07, tipY + Math.sin(angle - 2.2) * 0.07],
        ]),
        BLUE,
        3,
      );
    }),
  ],

  /** Tree. A trunk and a lobed canopy. */
  tree: () => [
    tint(rect(0.46, 0.56, 0.54, 0.8), BROWN, 5),
    tint(scallop(0.5, 0.4, 0.18, 0.24, 9), GREEN, 6),
    ink(line(0.5, 0.6, 0.44, 0.52), 2),
    ink(line(0.5, 0.66, 0.57, 0.58), 2),
  ],

  /** Palm tree. A leaning trunk with fronds and coconuts. */
  'palm tree': () => [
    tint(path([[0.42, 0.84], [0.46, 0.6], [0.54, 0.38]]), BROWN, 8),
    tint(path([[0.54, 0.38], [0.36, 0.3], [0.22, 0.34]]), GREEN, 5),
    tint(path([[0.54, 0.38], [0.44, 0.22], [0.32, 0.18]]), GREEN, 5),
    tint(path([[0.54, 0.38], [0.66, 0.2], [0.78, 0.2]]), GREEN, 5),
    tint(path([[0.54, 0.38], [0.72, 0.36], [0.84, 0.44]]), GREEN, 5),
    ink(circle(0.5, 0.44, 0.025, 10), 3),
    ink(circle(0.58, 0.45, 0.025, 10), 3),
  ],

  /** Flower. Five petals, a centre, a stem and a leaf. */
  flower: () => [
    ...[
      [0.5, 0.24],
      [0.36, 0.34],
      [0.64, 0.34],
      [0.41, 0.5],
      [0.59, 0.5],
    ].map(([x, y]) => tint(circle(x as number, y as number, 0.08, 14), RED, 5)),
    tint(circle(0.5, 0.4, 0.05, 12), YELLOW, 5),
    tint(line(0.5, 0.56, 0.5, 0.84), GREEN, 4),
    tint(path([[0.5, 0.68], [0.64, 0.62], [0.5, 0.74]]), GREEN, 4),
    tint(path([[0.5, 0.74], [0.36, 0.7], [0.5, 0.8]]), GREEN, 4),
  ],

  /** Sunflower. A ring of pointed petals round a seeded disc. */
  sunflower: () => [
    ...Array.from({ length: 12 }, (_, i) => {
      const angle = (i / 12) * Math.PI * 2;
      return tint(
        closed([
          [0.5 + Math.cos(angle) * 0.1, 0.4 + Math.sin(angle) * 0.1],
          [0.5 + Math.cos(angle - 0.2) * 0.24, 0.4 + Math.sin(angle - 0.2) * 0.24],
          [0.5 + Math.cos(angle + 0.2) * 0.24, 0.4 + Math.sin(angle + 0.2) * 0.24],
        ]),
        YELLOW,
        4,
      );
    }),
    tint(circle(0.5, 0.4, 0.1), BROWN, 6),
    tint(line(0.5, 0.5, 0.5, 0.84), GREEN, 5),
  ],

  /** Leaf. A pointed blade with a midrib and veins. */
  leaf: () => [
    tint(path([[0.24, 0.72], [0.34, 0.4], [0.6, 0.24], [0.76, 0.38], [0.6, 0.66], [0.24, 0.72]]), GREEN, 6),
    ink(path([[0.24, 0.72], [0.48, 0.48], [0.7, 0.36]]), 3),
    ink(line(0.36, 0.6, 0.4, 0.44), 2),
    ink(line(0.48, 0.48, 0.52, 0.34), 2),
    ink(line(0.44, 0.66, 0.56, 0.6), 2),
  ],

  /** Grass. Blades from a ground line. */
  grass: () => [
    tint(line(0.1, 0.76, 0.9, 0.76), GREEN, 4),
    ...[0.18, 0.28, 0.38, 0.48, 0.58, 0.68, 0.78].map((x, i) =>
      tint(path([[x, 0.76], [x + (i % 2 === 0 ? 0.03 : -0.03), 0.56 + (i % 3) * 0.03]]), GREEN, 5),
    ),
  ],

  /** Rock. An angular boulder with facet lines. */
  rock: () => [
    tint(closed([[0.24, 0.72], [0.32, 0.46], [0.52, 0.36], [0.72, 0.44], [0.8, 0.72]]), GREY, 6),
    ink(line(0.52, 0.36, 0.46, 0.72), 2),
    ink(line(0.52, 0.36, 0.72, 0.56), 2),
    ink(line(0.32, 0.46, 0.46, 0.56), 2),
  ],

  /** River. Two banks winding, with a current line between them. */
  river: () => [
    tint(path([[0.18, 0.84], [0.3, 0.6], [0.22, 0.42], [0.34, 0.2]]), BLUE, 6),
    tint(path([[0.52, 0.84], [0.6, 0.6], [0.5, 0.42], [0.6, 0.2]]), BLUE, 6),
    tint(path([[0.36, 0.72], [0.44, 0.56], [0.36, 0.4]]), BLUE, 3),
    tint(line(0.42, 0.3, 0.48, 0.3), BLUE, 3),
  ],

  /** Fire. Overlapping tongues of flame over logs. */
  fire: () => [
    tint(path([[0.5, 0.18], [0.36, 0.42], [0.42, 0.5], [0.34, 0.62], [0.5, 0.72], [0.66, 0.62], [0.6, 0.48], [0.64, 0.4], [0.5, 0.18]]), ORANGE, 6),
    tint(path([[0.5, 0.4], [0.43, 0.56], [0.5, 0.66], [0.57, 0.56], [0.5, 0.4]]), YELLOW, 5),
    tint(line(0.28, 0.78, 0.7, 0.72), BROWN, 6),
    tint(line(0.3, 0.72, 0.72, 0.78), BROWN, 6),
  ],

  /** Rainbow. Concentric arcs with a cloud at one foot. */
  rainbow: () => [
    tint(arc(0.5, 0.74, 0.34, 0.34, Math.PI, Math.PI * 2, 18), RED, 7),
    tint(arc(0.5, 0.74, 0.26, 0.26, Math.PI, Math.PI * 2, 16), YELLOW, 7),
    tint(arc(0.5, 0.74, 0.18, 0.18, Math.PI, Math.PI * 2, 14), GREEN, 7),
    ink(arc(0.2, 0.74, 0.08, 0.07, Math.PI, Math.PI * 2, 10), 3),
    ink(arc(0.8, 0.74, 0.08, 0.07, Math.PI, Math.PI * 2, 10), 3),
  ],

  /** Lightning. A bolt from a cloud. */
  lightning: () => [
    ink(arc(0.42, 0.32, 0.14, 0.12, Math.PI, Math.PI * 2, 12)),
    ink(arc(0.58, 0.3, 0.15, 0.13, Math.PI, Math.PI * 2, 12)),
    ink(line(0.28, 0.32, 0.73, 0.32), 4),
    tint(closed([[0.54, 0.36], [0.38, 0.6], [0.5, 0.6], [0.4, 0.84], [0.66, 0.54], [0.53, 0.54]]), YELLOW, 5),
  ],

  /** Cactus. A barrel with two arms and spines. */
  cactus: () => [
    tint(path([[0.42, 0.8], [0.42, 0.3], [0.58, 0.3], [0.58, 0.8], [0.42, 0.8]]), GREEN, 6),
    tint(path([[0.42, 0.52], [0.28, 0.52], [0.28, 0.36]]), GREEN, 6),
    tint(path([[0.58, 0.6], [0.72, 0.6], [0.72, 0.44]]), GREEN, 6),
    ink(line(0.46, 0.4, 0.42, 0.38), 2),
    ink(line(0.54, 0.5, 0.58, 0.48), 2),
    ink(line(0.46, 0.66, 0.42, 0.64), 2),
    ink(line(0.3, 0.42, 0.26, 0.4), 2),
  ],

  /** Seashell. A fan of ribs from a hinge. */
  seashell: () => [
    ink(arc(0.5, 0.72, 0.3, 0.42, Math.PI, Math.PI * 2, 18)),
    ink(line(0.2, 0.72, 0.8, 0.72), 3),
    ...Array.from({ length: 5 }, (_, i) =>
      ink(path([[0.5, 0.72], [0.28 + i * 0.11, 0.36 + Math.abs(i - 2) * 0.05]]), 2),
    ),
  ],

  /** Feather. A shaft with barbs either side. */
  feather: () => [
    ink(path([[0.3, 0.8], [0.52, 0.42], [0.62, 0.22]]), 4),
    ink(path([[0.62, 0.22], [0.4, 0.34], [0.34, 0.56], [0.3, 0.8]]), 3),
    ink(path([[0.62, 0.22], [0.74, 0.38], [0.58, 0.58], [0.3, 0.8]]), 3),
    ink(line(0.46, 0.52, 0.55, 0.5), 2),
    ink(line(0.4, 0.64, 0.49, 0.62), 2),
  ],

  /** Volcano. A cone with a crater, smoke and lava. */
  volcano: () => [
    ink(path([[0.16, 0.8], [0.38, 0.38], [0.62, 0.38], [0.84, 0.8], [0.16, 0.8]])),
    tint(path([[0.38, 0.38], [0.44, 0.52], [0.5, 0.42], [0.56, 0.54], [0.62, 0.38]]), RED, 5),
    tint(path([[0.44, 0.38], [0.42, 0.24], [0.52, 0.16]]), GREY, 5),
    tint(circle(0.58, 0.14, 0.06), GREY, 4),
    tint(line(0.4, 0.52, 0.32, 0.72), RED, 4),
    tint(line(0.6, 0.5, 0.68, 0.7), RED, 4),
  ],

  /** Planet. A sphere with a tilted ring. */
  planet: () => [
    ink(circle(0.5, 0.5, 0.2)),
    ink(ellipse(0.5, 0.52, 0.34, 0.09, 24), 4),
    ink(circle(0.42, 0.42, 0.035, 10), 2),
    ink(circle(0.58, 0.58, 0.028, 10), 2),
  ],

  /** Comet. A bright head with a streaming tail. */
  comet: () => [
    tint(circle(0.66, 0.34, 0.09), YELLOW, 6),
    tint(path([[0.58, 0.38], [0.3, 0.56], [0.14, 0.7]]), ORANGE, 6),
    tint(path([[0.62, 0.42], [0.36, 0.66], [0.24, 0.78]]), ORANGE, 4),
    tint(path([[0.6, 0.3], [0.34, 0.42], [0.18, 0.5]]), ORANGE, 4),
  ],

  /** Waterfall. Water dropping from a ledge into a pool. */
  waterfall: () => [
    ink(path([[0.2, 0.24], [0.36, 0.24], [0.36, 0.7]])),
    ink(path([[0.8, 0.24], [0.64, 0.24], [0.64, 0.7]])),
    ...Array.from({ length: 4 }, (_, i) =>
      tint(line(0.41 + i * 0.06, 0.26, 0.41 + i * 0.06, 0.68), BLUE, 4),
    ),
    tint(path([[0.28, 0.76], [0.42, 0.72], [0.56, 0.76], [0.72, 0.72]]), BLUE, 5),
    tint(circle(0.46, 0.72, 0.03, 10), BLUE, 3),
  ],

  /** Iceberg. A peak above the water line and a mass below it. */
  iceberg: () => [
    tint(path([[0.3, 0.5], [0.46, 0.22], [0.62, 0.5]]), BLUE, 6),
    tint(line(0.12, 0.5, 0.88, 0.5), BLUE, 4),
    tint(path([[0.3, 0.5], [0.2, 0.68], [0.34, 0.82], [0.66, 0.8], [0.74, 0.6], [0.62, 0.5]]), BLUE, 5),
    ink(line(0.46, 0.22, 0.42, 0.5), 2),
  ],

  /** Tornado. A funnel of widening spirals. */
  tornado: () => [
    ink(path([[0.2, 0.2], [0.8, 0.2]]), 4),
    ink(arc(0.5, 0.26, 0.3, 0.07, 0, Math.PI * 2, 16), 3),
    ink(arc(0.5, 0.42, 0.22, 0.06, 0, Math.PI * 2, 14), 3),
    ink(arc(0.5, 0.56, 0.14, 0.05, 0, Math.PI * 2, 12), 3),
    ink(arc(0.5, 0.7, 0.07, 0.04, 0, Math.PI * 2, 10), 3),
    ink(path([[0.2, 0.26], [0.36, 0.56], [0.46, 0.78]]), 3),
    ink(path([[0.8, 0.26], [0.64, 0.56], [0.54, 0.78]]), 3),
  ],

  /** Spider web. Radial threads with connecting chords. */
  'spider web': () => [
    ...rays(0.5, 0.48, 0, 0.32, 8, 0xff222222, 3),
    ...[0.1, 0.18, 0.26, 0.32].map((r) =>
      ink(
        path(
          Array.from({ length: 9 }, (_, i) => {
            const angle = (i / 8) * Math.PI * 2;
            return [0.5 + Math.cos(angle) * r, 0.48 + Math.sin(angle) * r] as const;
          }),
        ),
        2,
      ),
    ),
  ],

  /** Beehive. Stacked skep bands with bees around it. */
  beehive: () => [
    ink(arc(0.5, 0.74, 0.28, 0.44, Math.PI, Math.PI * 2, 18)),
    ink(arc(0.5, 0.74, 0.25, 0.34, Math.PI, Math.PI * 2, 16), 3),
    ink(arc(0.5, 0.74, 0.2, 0.24, Math.PI, Math.PI * 2, 14), 3),
    ink(arc(0.5, 0.74, 0.12, 0.14, Math.PI, Math.PI * 2, 12), 3),
    ink(line(0.22, 0.74, 0.78, 0.74), 4),
    ink(arc(0.5, 0.74, 0.07, 0.08, Math.PI, Math.PI * 2, 10), 4),
    tint(circle(0.78, 0.36, 0.028, 10), YELLOW, 3),
    tint(circle(0.24, 0.3, 0.024, 10), YELLOW, 3),
  ],

  /** Bird nest. A woven bowl with eggs in it. */
  'bird nest': () => [
    ink(arc(0.5, 0.56, 0.3, 0.24, 0, Math.PI, 18)),
    ink(line(0.2, 0.56, 0.8, 0.56), 3),
    ink(arc(0.5, 0.58, 0.26, 0.18, 0, Math.PI, 14), 2),
    ink(line(0.26, 0.64, 0.5, 0.6), 2),
    ink(line(0.5, 0.68, 0.74, 0.62), 2),
    ink(ellipse(0.42, 0.52, 0.055, 0.04, 14), 3),
    ink(ellipse(0.56, 0.53, 0.055, 0.04, 14), 3),
  ],
});
