import { INPUT_LIMITS } from '@/constants/game.constants';
import {
  DRAW_TOOL,
  DRAW_TOOLS,
  FILL_TOOLS,
  GAME_PHASE,
  SHAPE_TOOLS,
  type DrawToolWire,
} from '@/constants/room.constants';
import type { PointTuple, StrokeDto } from '@/types/drawing.types';
import type { RuntimeRoom } from '@/types/socket.types';
import { errors } from '@/utils/errors';

/**
 * The drawing relay (brief sections 23 to 26).
 *
 * ## Memory, not Mongo
 *
 * A stroke is a batch of points every 60ms while a finger is down. Writing
 * that to a database would be both far too slow to relay and absurdly
 * expensive, so the live board is an array in memory and the only durable
 * artefact is a single snapshot written when the turn ends (brief section 24).
 *
 * ## What is validated, and why
 *
 * Everything, because a stroke is the one payload a client sends dozens of
 * times a second and the easiest thing to abuse. Coordinates are clamped to
 * 0..1 rather than rejected — a point a hair outside the box is a rounding
 * artefact from the client's own normalisation, not an attack, and dropping
 * the whole batch over it would make lines flicker. Counts and sizes *are*
 * hard limits: those are the ones that would exhaust memory.
 */

export class DrawingService {
  /**
   * Confirms the caller may draw right now (brief section 25).
   *
   * Three things have to hold: there is a live turn, it is in the drawing
   * phase, and this user is the drawer. Nothing about this is taken from the
   * client — `room.round.drawerId` was decided by the server.
   */
  assertCanDraw(room: RuntimeRoom, userId: string): void {
    const round = room.round;
    if (!round || round.ended) throw errors.roundEnded();
    if (room.phase !== GAME_PHASE.drawing) throw errors.invalidAction('Nobody is drawing yet.');
    if (round.drawerId !== userId) throw errors.notDrawer();
  }

  /** Clamps a coordinate into the unit square. */
  private clamp(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  /**
   * Validates and normalises a batch of points.
   *
   * Anything that is not a pair of finite numbers is dropped rather than
   * throwing: one malformed point in a batch of eighty should cost that point,
   * not the whole stroke.
   *
   * A third element is pressure, and it is preserved only when it is actually
   * there — see `PointTuple`. Echoing a default back on every point would
   * inflate the board snapshot with a number that carries no information.
   */
  sanitizePoints(raw: unknown): PointTuple[] {
    if (!Array.isArray(raw)) return [];

    const points: PointTuple[] = [];
    for (const entry of raw.slice(0, INPUT_LIMITS.maxPointsPerBatch)) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [x, y, pressure] = entry;
      if (typeof x !== 'number' || typeof y !== 'number') continue;

      if (typeof pressure === 'number' && Number.isFinite(pressure)) {
        points.push([this.clamp(x), this.clamp(y), this.clamp(pressure)]);
      } else {
        points.push([this.clamp(x), this.clamp(y)]);
      }
    }

    return points;
  }

  /**
   * Trims a shape's points to the two that define it.
   *
   * A rectangle needs a start and an end; anything past that is noise from a
   * client that streamed a drag it should have sent once. Trimming rather than
   * refusing keeps a mildly wrong client drawing instead of silently failing,
   * and bounds what the board can be made to hold either way.
   */
  private trimForTool(tool: DrawToolWire, points: PointTuple[]): PointTuple[] {
    if (FILL_TOOLS.includes(tool)) {
      // A fill has no geometry: it covers everything. One point is kept so the
      // stroke is not mistaken for an empty one and skipped by a renderer.
      return points.slice(0, 1);
    }
    if (SHAPE_TOOLS.includes(tool)) return points.slice(0, 2);
    return points;
  }

  /** Validates an incoming stroke header, returning a safe copy. */
  sanitizeStroke(raw: unknown, authorId: string): StrokeDto {
    if (typeof raw !== 'object' || raw === null) {
      throw errors.validation('That stroke is not valid.');
    }

    const stroke = raw as Partial<StrokeDto>;
    const id = typeof stroke.id === 'string' ? stroke.id.slice(0, 64) : '';
    if (id.length === 0) throw errors.validation('That stroke has no id.');

    // An unrecognised tool becomes a pen rather than a refusal. A client from
    // a future release naming a tool this server has not heard of should still
    // put a mark on the board — the alternative is a drawer whose strokes
    // silently vanish for everybody, which is far worse than a mark drawn with
    // the wrong nib.
    const tool: DrawToolWire = DRAW_TOOLS.includes(stroke.t as DrawToolWire)
      ? (stroke.t as DrawToolWire)
      : DRAW_TOOL.pen;

    return {
      id,
      // The author is taken from the authenticated socket, never from the
      // payload: otherwise a guesser could attribute strokes to the drawer.
      a: authorId,
      p: this.trimForTool(tool, this.sanitizePoints(stroke.p)),
      c: Number.isFinite(stroke.c) ? Number(stroke.c) : 0xff000000,
      w: Number.isFinite(stroke.w) ? Math.min(Math.max(Number(stroke.w), 0.5), 80) : 4,
      t: tool,
      ts: Number.isFinite(stroke.ts) ? Number(stroke.ts) : Date.now(),
    };
  }

  /**
   * Starts a stroke on the board.
   *
   * A new stroke invalidates the redo stack, exactly as it does in any editor:
   * once you draw something new, the thing you undid is gone for good.
   */
  begin(room: RuntimeRoom, stroke: StrokeDto): boolean {
    if (room.board.strokes.length >= INPUT_LIMITS.maxStrokesPerBoard) return false;

    room.board.strokes.push(stroke);
    room.board.redoStack = [];
    return true;
  }

  /**
   * Appends points to a live stroke.
   *
   * Returns false when the stroke is unknown — a batch that arrived after its
   * own `begin` was dropped, or after a clear. Silently ignoring it is right:
   * there is nothing to attach the points to, and the drawer's next stroke
   * will work normally.
   */
  append(room: RuntimeRoom, strokeId: string, points: PointTuple[]): boolean {
    const stroke = room.board.strokes.find((candidate) => candidate.id === strokeId);
    if (!stroke) return false;

    // A shape is its two points and a fill is none; neither has anything to
    // append to. Enforced here as well as in `sanitizeStroke` because the two
    // are separate entry points: trimming only on `begin` would leave a client
    // free to stream four hundred points into a "rectangle" afterwards, which
    // is both a way past the shape cap and a way to make every other client
    // render something the geometry does not describe.
    if (SHAPE_TOOLS.includes(stroke.t) || FILL_TOOLS.includes(stroke.t)) return false;

    if (stroke.p.length + points.length > INPUT_LIMITS.maxPointsPerStroke) {
      // A stroke this long is a client that never sent `end`. Take what fits
      // and drop the rest rather than letting one stroke grow without bound.
      const capacity = INPUT_LIMITS.maxPointsPerStroke - stroke.p.length;
      if (capacity <= 0) return false;
      stroke.p.push(...points.slice(0, capacity));
      return true;
    }

    stroke.p.push(...points);
    return true;
  }

  /** Removes the drawer's most recent stroke and remembers it for redo. */
  undo(room: RuntimeRoom, userId: string): StrokeDto | null {
    for (let i = room.board.strokes.length - 1; i >= 0; i--) {
      const stroke = room.board.strokes[i]!;
      if (stroke.a !== userId) continue;

      room.board.strokes.splice(i, 1);
      room.board.redoStack.push(stroke);
      return stroke;
    }
    return null;
  }

  /** Puts back the last undone stroke. */
  redo(room: RuntimeRoom): StrokeDto | null {
    const stroke = room.board.redoStack.pop();
    if (!stroke) return null;

    room.board.strokes.push(stroke);
    return stroke;
  }

  /** Wipes the board. */
  clear(room: RuntimeRoom): void {
    room.board.strokes = [];
    room.board.redoStack = [];
  }

  /**
   * The whole board, for a late joiner or a reconnecting player.
   *
   * This is what makes a reconnect seamless (brief section 38): the returning
   * client redraws from the snapshot instead of seeing an empty canvas until
   * the drawer happens to draw again.
   */
  snapshot(room: RuntimeRoom): StrokeDto[] {
    return room.board.strokes;
  }
}

export const drawingService = new DrawingService();
