import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REPLAY_LIMITS } from '@/constants/game.constants';
import { DRAW_TOOL } from '@/constants/room.constants';
import { roundRepository } from '@/repositories/round.repository';
import { replayService } from '@/services/replay.service';
import type { PointTuple, StrokeDto } from '@/types/drawing.types';
import { compactSnapshot, wasCompacted } from '@/utils/compactSnapshot';
import { ErrorCode } from '@/utils/errors';

/**
 * Drawing replays: the storage budget, and the rule protecting the word.
 *
 * ## The two things worth asserting
 *
 * **Compaction thins, it does not delete.** A replay is the only lasting
 * artefact of a turn, and the temptation when a drawing is over budget is to
 * drop strokes — which silently removes something somebody drew. These tests
 * pin the opposite behaviour: points go, strokes stay, and a shape's two
 * defining points survive any amount of thinning.
 *
 * **A live turn is never returned.** The replay carries the drawing *and* the
 * answer, so the only thing standing between a guesser and the word is that
 * `endedAt` check. It is asserted here rather than trusted.
 */

const GAME_ID = '507f1f77bcf86cd799439011';

/** A freehand stroke of [count] points. */
function freehand(id: string, count: number, tool: string = DRAW_TOOL.pen): StrokeDto {
  return {
    id,
    a: 'drawer-1',
    p: Array.from({ length: count }, (_, i) => [i / count, 0.5] as PointTuple),
    c: 0xff1a1a1a,
    w: 4,
    t: tool as StrokeDto['t'],
    ts: 1700000000000 + count,
  };
}

/** A round document as `.lean()` hands one back. */
function round(overrides: Record<string, unknown> = {}) {
  return {
    turnNumber: 1,
    roundNumber: 1,
    drawerId: 'drawer-1',
    drawerName: 'Ana',
    word: 'guitar',
    turnStartMs: 1_000,
    turnEndMs: 81_000,
    correctGuesses: [{ order: 1 }, { order: 2 }],
    snapshot: [freehand('s-1', 10)],
    endedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('compaction', () => {
  it('leaves an ordinary drawing completely untouched', () => {
    const strokes = [freehand('a', 80), freehand('b', 120)];
    const result = compactSnapshot(strokes);

    expect(result.compacted).toBe(false);
    expect(result.strokes).toBe(strokes);
  });

  it('thins one over-long stroke without touching its neighbours', () => {
    const long = freehand('long', REPLAY_LIMITS.maxPointsPerStroke + 400);
    const short = freehand('short', 50);

    const result = compactSnapshot([long, short]);

    expect(result.compacted).toBe(true);
    expect(result.strokes[0]?.p).toHaveLength(REPLAY_LIMITS.maxPointsPerStroke);
    expect(result.strokes[1]?.p).toHaveLength(50);
  });

  /**
   * The rule the whole helper exists for: a drawing over budget loses
   * smoothness, never content.
   */
  it('keeps every stroke when the whole drawing is over budget', () => {
    const strokes = Array.from({ length: 60 }, (_, i) => freehand(`s-${i}`, 500));
    const before = strokes.length;

    const result = compactSnapshot(strokes);

    expect(result.compacted).toBe(true);
    expect(result.strokes).toHaveLength(before);

    const total = result.strokes.reduce((sum, stroke) => sum + stroke.p.length, 0);
    expect(total).toBeLessThanOrEqual(REPLAY_LIMITS.maxPointsPerSnapshot);
  });

  it('pins the first and last point of a thinned stroke', () => {
    const stroke = freehand('a', 2000);
    const first = stroke.p[0];
    const last = stroke.p[stroke.p.length - 1];

    const result = compactSnapshot([stroke]);
    const thinned = result.strokes[0]!;

    // A stroke whose endpoints moved is a line that visibly starts or ends
    // somewhere else.
    expect(thinned.p[0]).toEqual(first);
    expect(thinned.p[thinned.p.length - 1]).toEqual(last);
  });

  /**
   * A rectangle is its two corners. Proportional thinning must never reduce a
   * shape below its own geometry, or it stops being a rectangle.
   */
  it('never thins a shape below its two defining points', () => {
    const shapes = [
      { ...freehand('line', 2, DRAW_TOOL.line) },
      { ...freehand('rect', 2, DRAW_TOOL.rectangle) },
      { ...freehand('circle', 2, DRAW_TOOL.circle) },
    ];
    const bulk = Array.from({ length: 60 }, (_, i) => freehand(`s-${i}`, 500));

    const result = compactSnapshot([...shapes, ...bulk]);

    for (const shape of result.strokes.slice(0, 3)) {
      expect(shape.p).toHaveLength(2);
    }
  });

  it('caps the stroke count, keeping the earliest so it is still a drawing', () => {
    const strokes = Array.from(
      { length: REPLAY_LIMITS.maxStrokesPerSnapshot + 200 },
      (_, i) => freehand(`s-${i}`, 4),
    );

    const result = compactSnapshot(strokes);

    expect(result.strokes).toHaveLength(REPLAY_LIMITS.maxStrokesPerSnapshot);
    expect(result.strokes[0]?.id).toBe('s-0');
  });

  it('handles an empty drawing without reporting compaction', () => {
    expect(compactSnapshot([])).toEqual({ strokes: [], compacted: false });
  });
});

describe('the compaction heuristic', () => {
  it('reports an untouched drawing as untouched', () => {
    expect(wasCompacted([freehand('a', 80)])).toBe(false);
  });

  it('reports a drawing sitting exactly at a limit', () => {
    expect(wasCompacted([freehand('a', REPLAY_LIMITS.maxPointsPerStroke)])).toBe(true);
  });
});

describe('reading a replay', () => {
  it('returns a finished turn with its strokes and word', async () => {
    vi.spyOn(roundRepository, 'findByGameTurn').mockResolvedValue(round() as never);

    const replay = await replayService.get(GAME_ID, 1);

    expect(replay.word).toBe('guitar');
    expect(replay.drawerName).toBe('Ana');
    expect(replay.strokes).toHaveLength(1);
    expect(replay.durationMs).toBe(80_000);
    expect(replay.correctGuessers).toBe(2);
  });

  /**
   * The check the whole feature's security rests on. A live turn's word must
   * not be readable, and the refusal must be indistinguishable from a turn
   * that never existed — otherwise this endpoint confirms which turn is live
   * to whoever is probing for exactly that.
   */
  it('refuses a turn that has not ended, as if it did not exist', async () => {
    vi.spyOn(roundRepository, 'findByGameTurn').mockResolvedValue(
      round({ endedAt: null }) as never,
    );

    const live = await replayService.get(GAME_ID, 1).catch((error: unknown) => error);

    vi.spyOn(roundRepository, 'findByGameTurn').mockResolvedValue(null);
    const missing = await replayService.get(GAME_ID, 99).catch((error: unknown) => error);

    expect((live as { code: string }).code).toBe(ErrorCode.NOT_FOUND);
    expect((missing as { code: string }).code).toBe(ErrorCode.NOT_FOUND);
    expect((live as Error).message).toBe((missing as Error).message);
  });

  it('omits live turns from the list', async () => {
    vi.spyOn(roundRepository, 'findByGame').mockResolvedValue([
      round({ turnNumber: 1 }),
      round({ turnNumber: 2, endedAt: null, word: 'secret' }),
    ] as never);

    const page = await replayService.list(GAME_ID);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.turnNumber).toBe(1);
  });

  /** The list is a menu, not a download. */
  it('carries no strokes in the list', async () => {
    vi.spyOn(roundRepository, 'findByGame').mockResolvedValue([
      round({ snapshot: [freehand('a', 500), freehand('b', 500)] }),
    ] as never);

    const page = await replayService.list(GAME_ID);

    expect(page.items[0]?.strokeCount).toBe(2);
    expect(page.items[0]).not.toHaveProperty('strokes');
  });

  it('reports an empty drawing rather than failing on it', async () => {
    vi.spyOn(roundRepository, 'findByGameTurn').mockResolvedValue(
      round({ snapshot: [] }) as never,
    );

    const replay = await replayService.get(GAME_ID, 1);

    // The fallback the client renders: a replay that exists but has nothing to
    // play, which is what a turn nobody drew in produces.
    expect(replay.strokes).toEqual([]);
    expect(replay.strokeCount).toBe(0);
  });
});
