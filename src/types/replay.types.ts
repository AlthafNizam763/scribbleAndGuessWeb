import type { StrokeDto } from '@/types/drawing.types';

/**
 * What the replay endpoints put on the wire.
 *
 * ## The word is the reason these are separate types
 *
 * A replay carries the drawing *and* the answer, so it is only ever built for
 * a turn that has ended — `replayService` refuses anything else. That check is
 * the whole security story of this feature, and keeping these shapes distinct
 * from the live `RoundResultDto` is what stops a future caller reaching for
 * the wrong one on a live round.
 */

/** One turn's replay, without the strokes. */
export interface ReplaySummaryDto {
  /** Which turn of the match, 1-based and always increasing. */
  turnNumber: number;
  /** Which pass around the table. */
  roundNumber: number;
  drawerId: string;
  drawerName: string;
  /** The answer. Only ever populated for a turn that has ended. */
  word: string;
  /** How long the turn ran, in milliseconds. */
  durationMs: number;
  /** How many people got it. */
  correctGuessers: number;
  /** How many strokes the replay will play back. */
  strokeCount: number;
  /**
   * Whether the stored drawing was thinned to fit the storage budget.
   *
   * Surfaced rather than hidden so a client can say so: a replay that is
   * visibly coarser than the original should be explainable, not mysterious.
   */
  compacted: boolean;
  endedAtMs: number;
}

/** One turn's replay, with everything needed to play it back. */
export interface ReplayDto extends ReplaySummaryDto {
  /**
   * The strokes, in the order they were drawn.
   *
   * The same `StrokeDto` the live board uses, so a replay renderer and a live
   * renderer are the same code on every client. Timing comes from each
   * stroke's `ts` — there are no per-point timestamps, because adding one
   * would inflate the highest-frequency payload in the game to serve a screen
   * nobody looks at during play.
   */
  strokes: StrokeDto[];
}

/** The list of a match's replays. */
export interface ReplayListDto {
  gameId: string;
  items: ReplaySummaryDto[];
}
