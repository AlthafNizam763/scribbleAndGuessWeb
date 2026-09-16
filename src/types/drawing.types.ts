import type { DrawToolWire } from '@/constants/room.constants';

/**
 * Drawing payloads (brief section 23).
 *
 * ## Why the keys are one letter long
 *
 * `lib/models/stroke.dart` serialises to `{id, a, p, c, w, t, ts}`. A stroke
 * is the highest-frequency message in the game — a batch every 60ms while a
 * finger is down — and on a mobile connection the difference between `{"a":...}`
 * and `{"authorId":...}` across a whole turn is real. The client already
 * encodes this way; the server matches it.
 *
 * Points are `[x, y]` pairs normalised to 0..1 against a 4:3 canvas, so a
 * stroke drawn on a tablet lands in the same place on a phone.
 */

/**
 * A single point: `[x, y]`, or `[x, y, pressure]` where a device reports it.
 *
 * ## Why pressure is optional rather than always present
 *
 * Points are the highest-frequency payload in the game, and a third number on
 * every one of them is a 50% increase on the thing sent most often. Only the
 * `brush` tool varies its width with pressure, so only `brush` strokes carry
 * it — every other tool sends the two-element form it always sent.
 *
 * That also makes the change backwards compatible in both directions: an older
 * client sends two elements and is read correctly, and a newer client's third
 * element is ignored by an older server. `pressure` is 0..1, where 0.5 is the
 * neutral value a device with no pressure sensor reports.
 */
export type PointTuple = [number, number] | [number, number, number];

/** `lib/models/stroke.dart`. */
export interface StrokeDto {
  id: string;
  /** Author id. */
  a: string;
  /** Points. */
  p: PointTuple[];
  /** Colour as a 32-bit ARGB integer, matching Dart's `Color.value`. */
  c: number;
  /** Width in logical pixels. */
  w: number;
  /** Tool. */
  t: DrawToolWire;
  /** Client timestamp in epoch milliseconds. */
  ts: number;
}

/** The `c:draw:append` / `s:draw:append` payload. */
export interface StrokeAppendDto {
  strokeId: string;
  points: PointTuple[];
}
