import { REPLAY_LIMITS } from '@/constants/game.constants';
import type { PointTuple, StrokeDto } from '@/types/drawing.types';

/**
 * Thins a finished drawing to fit the replay storage budget.
 *
 * ## Why this is a util and not part of the replay service
 *
 * It is enforced on the *write*, in `roundRepository.finish`, because a
 * document that was never allowed to grow cannot later be too big to load —
 * whereas thinning on read would mean the oversized document already exists
 * and has already been paid for. Repositories may not import services, and
 * this is a pure data transform with no rules in it, so it lives here with the
 * other pure helpers the data layer uses.
 *
 * ## Points first, strokes last
 *
 * Dropping a stroke removes something the drawer drew. Dropping every other
 * *point within* a stroke removes only smoothness, and the renderer's
 * curve-smoothing puts most of that back. So this thins long strokes, then
 * thins all strokes proportionally if the drawing is still over budget, and
 * only discards strokes outright past a ceiling no human drawing reaches.
 *
 * Shapes and fills survive untouched: the floor of two points per stroke is
 * exactly what a line, rectangle or ellipse is defined by, so proportional
 * thinning can never reduce one below its own geometry.
 */
export function compactSnapshot(strokes: StrokeDto[]): {
  strokes: StrokeDto[];
  compacted: boolean;
} {
  if (strokes.length === 0) return { strokes, compacted: false };

  let compacted = false;

  // 1. The stroke ceiling. Earliest kept rather than a random slice, so what
  //    survives is still a drawing in progress rather than a scatter of marks.
  let working = strokes;
  if (working.length > REPLAY_LIMITS.maxStrokesPerSnapshot) {
    working = working.slice(0, REPLAY_LIMITS.maxStrokesPerSnapshot);
    compacted = true;
  }

  // 2. Per-stroke thinning, for the one stroke somebody scribbled for a minute.
  //
  // Only rebuilt when something actually needs thinning. This runs at the end
  // of every turn, and the overwhelmingly common case is a drawing that is
  // nowhere near the budget — which should cost a scan, not a copy of every
  // stroke in it.
  if (working.some((stroke) => stroke.p.length > REPLAY_LIMITS.maxPointsPerStroke)) {
    compacted = true;
    working = working.map((stroke) =>
      stroke.p.length <= REPLAY_LIMITS.maxPointsPerStroke
        ? stroke
        : { ...stroke, p: thin(stroke.p, REPLAY_LIMITS.maxPointsPerStroke) },
    );
  }

  // 3. The global budget, applied proportionally so every stroke keeps its
  //    shape rather than the last few being dropped entirely.
  const total = working.reduce((sum, stroke) => sum + stroke.p.length, 0);
  if (total > REPLAY_LIMITS.maxPointsPerSnapshot) {
    const ratio = REPLAY_LIMITS.maxPointsPerSnapshot / total;
    compacted = true;

    working = working.map((stroke) => {
      // Two is the floor for anything with a direction, and it is also exactly
      // what a shape needs — so this both protects shapes and stops a freehand
      // stroke collapsing to a dot.
      const target = Math.max(2, Math.floor(stroke.p.length * ratio));
      return stroke.p.length <= target ? stroke : { ...stroke, p: thin(stroke.p, target) };
    });
  }

  return { strokes: working, compacted };
}

/**
 * Whether a stored drawing shows the marks of compaction.
 *
 * A heuristic, and deliberately a conservative one: it reports true only when
 * the snapshot sits exactly at a limit, which a drawing that was never thinned
 * essentially never does. A false negative costs a missing note in the UI; a
 * false positive would call an untouched drawing degraded.
 */
export function wasCompacted(strokes: StrokeDto[]): boolean {
  if (strokes.length >= REPLAY_LIMITS.maxStrokesPerSnapshot) return true;
  return strokes.some((stroke) => stroke.p.length === REPLAY_LIMITS.maxPointsPerStroke);
}

/**
 * Reduces [points] to at most [target], keeping the first and the last.
 *
 * Evenly spaced rather than "every Nth from the start", so the thinning is
 * uniform along the stroke instead of leaving a dense head and a sparse tail.
 * The endpoints are pinned because they are where a stroke visibly begins and
 * ends — losing either moves the line.
 */
function thin(points: PointTuple[], target: number): PointTuple[] {
  if (points.length <= target || target < 2) return points;

  const kept: PointTuple[] = [];
  const step = (points.length - 1) / (target - 1);

  for (let i = 0; i < target; i += 1) {
    const point = points[Math.round(i * step)];
    if (point) kept.push(point);
  }

  return kept;
}
