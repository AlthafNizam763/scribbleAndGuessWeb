import type { PointTuple } from '@/types/drawing.types';

/**
 * The geometry a bot drawing is made of.
 *
 * Split out of `drawingTemplates.ts` because the template library is now a few
 * hundred hand-drawn shapes across several files, and every one of them wants
 * the same dozen primitives. Keeping them here means a template file reads as
 * a description of an object — `mane`, `body`, `tail` — rather than as
 * trigonometry.
 *
 * ## The coordinate contract
 *
 * Everything is in the normalised 0..1 space the drawing relay already speaks,
 * against a 4:3 canvas, so `[0.5, 0.5]` is the centre on every device.
 * Templates are drawn to sit inside roughly `0.12..0.88` on both axes, which
 * leaves room for the per-difficulty jitter to push a point outward without it
 * being clamped against an edge and flattening a curve.
 */

/** One stroke of a template, in the shape the drawing relay already speaks. */
export interface TemplateStroke {
  points: PointTuple[];
  /** ARGB, matching Dart's `Color.value`. */
  color: number;
  width: number;
  tool: 'pen' | 'marker' | 'brush';
}

/** A template is a function so the registry holds no shared mutable arrays. */
export type TemplateBuilder = () => TemplateStroke[];

/** Ink, and the accents the templates use. */
export const INK = 0xff222222;
export const RED = 0xffd7443e;
export const GREEN = 0xff3f8e4f;
export const YELLOW = 0xffe8b33c;
export const BLUE = 0xff3a6ea5;
export const BROWN = 0xff8b5a2b;
export const ORANGE = 0xffe07b39;
export const PINK = 0xffe08fa8;
export const PURPLE = 0xff7a5aa8;
export const GREY = 0xff8a8f98;

/** An open path through the given points. */
export function path(points: readonly (readonly [number, number])[]): PointTuple[] {
  return points.map(([x, y]) => [x, y] as PointTuple);
}

/** A closed polygon: the points, with the first repeated to shut the outline. */
export function closed(points: readonly (readonly [number, number])[]): PointTuple[] {
  const first = points[0];
  if (!first) return [];
  return [...points, first].map(([x, y]) => [x, y] as PointTuple);
}

/** An axis-aligned rectangle from two opposite corners. */
export function rect(x0: number, y0: number, x1: number, y1: number): PointTuple[] {
  return closed([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
}

/** A straight segment. */
export function line(x0: number, y0: number, x1: number, y1: number): PointTuple[] {
  return path([
    [x0, y0],
    [x1, y1],
  ]);
}

/**
 * An ellipse as a polyline.
 *
 * Sampled at 24 points by default, which is smooth enough that the client's
 * curve smoothing makes it look drawn rather than plotted, and few enough that
 * a circle is one modest batch rather than several.
 */
export function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  steps = 24,
): PointTuple[] {
  const points: PointTuple[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    points.push([cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]);
  }
  return points;
}

/** A circle. Radii are equal in normalised space, which is what the eye reads. */
export function circle(cx: number, cy: number, r: number, steps = 24): PointTuple[] {
  return ellipse(cx, cy, r, r, steps);
}

/** A partial arc, for smiles, hulls and handles. */
export function arc(
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

/**
 * A ring whose radius alternates between two values.
 *
 * What makes a lion's mane a mane and a cloud a cloud: a circle that is not
 * smooth reads as texture rather than as an outline.
 */
export function scallop(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  teeth = 12,
): PointTuple[] {
  const points: PointTuple[] = [];
  const steps = teeth * 2;
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const r = i % 2 === 0 ? outer : inner;
    points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return points;
}

/** A run of teeth along a line, for saws, scales, grass and roof tiles. */
export function zigzag(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  teeth: number,
  amplitude: number,
): PointTuple[] {
  const points: PointTuple[] = [];
  const steps = teeth * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t + (i % 2 === 0 ? 0 : -amplitude);
    points.push([x, y]);
  }
  return points;
}

/** A triangle. */
export function triangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): PointTuple[] {
  return closed([
    [ax, ay],
    [bx, by],
    [cx, cy],
  ]);
}

/** Shorthand for a stroke in the default nib. */
export function ink(points: PointTuple[], width = 4): TemplateStroke {
  return { points, color: INK, width, tool: 'pen' };
}

/** Shorthand for a coloured stroke. */
export function tint(points: PointTuple[], color: number, width = 5): TemplateStroke {
  return { points, color, width, tool: 'marker' };
}

/** A small filled-looking blob, for eyes, berries and bolts. */
export function dot(cx: number, cy: number, r = 0.016, width = 3): TemplateStroke {
  return ink(circle(cx, cy, r, 10), width);
}

/** A pair of eyes at the same height. */
export function eyes(leftX: number, rightX: number, y: number, r = 0.018): TemplateStroke[] {
  return [dot(leftX, y, r), dot(rightX, y, r)];
}

/** Spokes radiating from a centre, for suns, stars and wheels. */
export function rays(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  count: number,
  color: number,
  width = 5,
  offsetRad = 0,
): TemplateStroke[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = offsetRad + (i / count) * Math.PI * 2;
    return tint(
      path([
        [cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner],
        [cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer],
      ]),
      color,
      width,
    );
  });
}

/** A five-pointed star outline centred on `cx, cy`. */
export function starPoly(cx: number, cy: number, outer: number, inner: number): PointTuple[] {
  const points: (readonly [number, number])[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    const r = i % 2 === 0 ? outer : inner;
    points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r] as const);
  }
  return closed(points);
}
