import { describe, expect, it } from 'vitest';

import { INPUT_LIMITS } from '@/constants/game.constants';
import { DRAW_TOOL, DRAW_TOOLS } from '@/constants/room.constants';
import { drawingService } from '@/services/drawing.service';
import type { PointTuple, StrokeDto } from '@/types/drawing.types';
import { makePlayer, makeRoom } from './helpers';

/**
 * The drawing tools and what the server will accept from a drawer.
 *
 * ## What is worth asserting
 *
 * A stroke is the one payload a client sends dozens of times a second, so it
 * is the easiest thing in the game to abuse — and the tools added in this
 * phase widened the surface. The interesting cases are the ones where a client
 * sends something the *renderer* would then have to make sense of: a rectangle
 * with four hundred points, a fill with a width, a tool name from a release
 * that does not exist yet.
 *
 * The rule throughout is the same one the service already followed for
 * coordinates: repair what is merely wrong, refuse only what is unbounded. A
 * mark drawn with the wrong nib is better than a drawer whose strokes silently
 * vanish for everybody.
 */

const AUTHOR = 'drawer-1';

/** A stroke header as a client puts it on the wire. */
function wireStroke(overrides: Partial<StrokeDto> = {}): unknown {
  return {
    id: 'stroke-1',
    a: 'ignored-by-the-server',
    p: [
      [0.1, 0.1],
      [0.2, 0.2],
    ],
    c: 0xff1a1a1a,
    w: 4,
    t: DRAW_TOOL.pen,
    ts: 1700000000000,
    ...overrides,
  };
}

describe('tool validation', () => {
  it('accepts every tool in the catalogue', () => {
    for (const tool of DRAW_TOOLS) {
      const stroke = drawingService.sanitizeStroke(wireStroke({ t: tool }), AUTHOR);
      expect(stroke.t).toBe(tool);
    }
  });

  /**
   * Forward compatibility. A client from a later release naming a tool this
   * server has never heard of should still put a mark on the board.
   */
  it('falls back to a pen for an unknown tool rather than refusing the stroke', () => {
    const stroke = drawingService.sanitizeStroke(
      wireStroke({ t: 'airbrush' as never }),
      AUTHOR,
    );

    expect(stroke.t).toBe(DRAW_TOOL.pen);
    expect(stroke.p).toHaveLength(2);
  });

  it('still takes the author from the socket and never from the payload', () => {
    const stroke = drawingService.sanitizeStroke(
      wireStroke({ a: 'somebody-else' }),
      AUTHOR,
    );

    expect(stroke.a).toBe(AUTHOR);
  });
});

describe('shape and fill geometry', () => {
  it('trims a shape to the two points that define it', () => {
    const streamed: PointTuple[] = Array.from(
      { length: 200 },
      (_, index) => [index / 200, index / 200] as PointTuple,
    );

    for (const tool of [DRAW_TOOL.line, DRAW_TOOL.rectangle, DRAW_TOOL.circle]) {
      const stroke = drawingService.sanitizeStroke(
        wireStroke({ t: tool, p: streamed }),
        AUTHOR,
      );
      expect(stroke.p).toHaveLength(2);
    }
  });

  it('keeps exactly one point for a fill, which has no geometry', () => {
    const stroke = drawingService.sanitizeStroke(
      wireStroke({
        t: DRAW_TOOL.fill,
        p: [
          [0.5, 0.5],
          [0.6, 0.6],
          [0.7, 0.7],
        ],
      }),
      AUTHOR,
    );

    // One rather than none, so a renderer does not skip it as an empty stroke.
    expect(stroke.p).toHaveLength(1);
  });

  it('leaves a freehand stroke untouched', () => {
    const points: PointTuple[] = Array.from(
      { length: 40 },
      (_, index) => [index / 40, 0.5] as PointTuple,
    );

    const stroke = drawingService.sanitizeStroke(
      wireStroke({ t: DRAW_TOOL.brush, p: points }),
      AUTHOR,
    );

    expect(stroke.p).toHaveLength(40);
  });
});

describe('appending', () => {
  function boardWith(stroke: StrokeDto) {
    const room = makeRoom({ players: [makePlayer({ userId: AUTHOR })] });
    room.board.strokes.push(stroke);
    return room;
  }

  it('appends to a freehand stroke', () => {
    const room = boardWith(drawingService.sanitizeStroke(wireStroke(), AUTHOR));

    expect(drawingService.append(room, 'stroke-1', [[0.3, 0.3]])).toBe(true);
    expect(room.board.strokes[0]?.p).toHaveLength(3);
  });

  /**
   * The hole this closes: trimming only on `begin` would leave a client free
   * to stream four hundred points into a "rectangle" afterwards — past the
   * shape cap, and into a geometry no renderer could make sense of.
   */
  it('refuses to append to a shape, which is already complete', () => {
    for (const tool of [DRAW_TOOL.line, DRAW_TOOL.rectangle, DRAW_TOOL.circle]) {
      const room = boardWith(
        drawingService.sanitizeStroke(wireStroke({ t: tool }), AUTHOR),
      );

      expect(drawingService.append(room, 'stroke-1', [[0.9, 0.9]])).toBe(false);
      expect(room.board.strokes[0]?.p).toHaveLength(2);
    }
  });

  it('refuses to append to a fill', () => {
    const room = boardWith(
      drawingService.sanitizeStroke(wireStroke({ t: DRAW_TOOL.fill }), AUTHOR),
    );

    expect(drawingService.append(room, 'stroke-1', [[0.9, 0.9]])).toBe(false);
    expect(room.board.strokes[0]?.p).toHaveLength(1);
  });

  it('still caps a freehand stroke that never ends', () => {
    const room = boardWith(drawingService.sanitizeStroke(wireStroke(), AUTHOR));

    const flood: PointTuple[] = Array.from(
      { length: INPUT_LIMITS.maxPointsPerStroke + 500 },
      () => [0.5, 0.5] as PointTuple,
    );

    drawingService.append(room, 'stroke-1', flood);

    expect(room.board.strokes[0]?.p.length).toBeLessThanOrEqual(
      INPUT_LIMITS.maxPointsPerStroke,
    );
  });
});

describe('pressure', () => {
  it('keeps a third element when a device reported one', () => {
    const points = drawingService.sanitizePoints([
      [0.1, 0.2, 0.75],
      [0.3, 0.4, 0.25],
    ]);

    expect(points[0]).toEqual([0.1, 0.2, 0.75]);
    expect(points[1]).toEqual([0.3, 0.4, 0.25]);
  });

  /**
   * Pressure is only sent by the one tool that uses it. Echoing a default onto
   * every other point would inflate the board snapshot with a number carrying
   * no information.
   */
  it('leaves a two-element point as two elements', () => {
    const points = drawingService.sanitizePoints([[0.1, 0.2]]);

    expect(points[0]).toEqual([0.1, 0.2]);
    expect(points[0]).toHaveLength(2);
  });

  it('clamps pressure into the unit range like any other coordinate', () => {
    const points = drawingService.sanitizePoints([
      [0.1, 0.2, 40],
      [0.1, 0.2, -3],
    ]);

    expect(points[0]?.[2]).toBe(1);
    expect(points[1]?.[2]).toBe(0);
  });

  it('drops a non-numeric pressure rather than the whole point', () => {
    const points = drawingService.sanitizePoints([[0.1, 0.2, 'hard']]);

    expect(points).toHaveLength(1);
    expect(points[0]).toEqual([0.1, 0.2]);
  });
});

describe('undo and redo across tools', () => {
  /**
   * Every tool is a stroke in one append-only array, which is the whole reason
   * one undo stack serves all of them. This is the test that would fail if a
   * tool were ever given its own transport.
   */
  it('undoes a shape and a fill exactly as it undoes a scribble', () => {
    const room = makeRoom({ players: [makePlayer({ userId: AUTHOR })] });

    for (const [index, tool] of [
      DRAW_TOOL.pen,
      DRAW_TOOL.rectangle,
      DRAW_TOOL.fill,
    ].entries()) {
      room.board.strokes.push(
        drawingService.sanitizeStroke(
          wireStroke({ id: `s-${index}`, t: tool }),
          AUTHOR,
        ),
      );
    }

    expect(drawingService.undo(room, AUTHOR)?.t).toBe(DRAW_TOOL.fill);
    expect(drawingService.undo(room, AUTHOR)?.t).toBe(DRAW_TOOL.rectangle);
    expect(drawingService.redo(room)?.t).toBe(DRAW_TOOL.rectangle);
    expect(room.board.strokes).toHaveLength(2);
  });

  it('keeps drawing order when a fill is redone', () => {
    const room = makeRoom({ players: [makePlayer({ userId: AUTHOR })] });

    room.board.strokes.push(
      drawingService.sanitizeStroke(wireStroke({ id: 'a', t: DRAW_TOOL.fill }), AUTHOR),
      drawingService.sanitizeStroke(wireStroke({ id: 'b', t: DRAW_TOOL.pen }), AUTHOR),
    );

    drawingService.undo(room, AUTHOR);
    drawingService.redo(room);

    // A fill covers the canvas, so whether it lands before or after the pen
    // stroke decides whether that stroke is visible at all.
    expect(room.board.strokes.map((stroke) => stroke.id)).toEqual(['a', 'b']);
  });
});
