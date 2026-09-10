import { describe, expect, it } from 'vitest';

import { ROOM_CODE, ROOM_LIMITS } from '@/constants/game.constants';
import { drawingService } from '@/services/drawing.service';
import { lobbyService } from '@/services/lobby.service';
import { TimerService } from '@/services/timer.service';
import {
  generateRoomCode,
  generateUniqueRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from '@/utils/generateRoomCode';
import { roomSettingsSchema } from '@/validators/room.validator';
import { makeRoom, makePlayer } from './helpers';

/**
 * Room codes, settings validation, the lobby summary, the timer and the
 * drawing board — the parts that need no database (brief section 65).
 */

describe('room codes', () => {
  it('generates codes of the right shape', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE.length);
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it('never generates an ambiguous glyph', () => {
    // 0/O and 1/I are the pairs people get wrong reading a code aloud.
    for (let i = 0; i < 200; i++) {
      expect(generateRoomCode()).not.toMatch(/[01OI]/);
    }
  });

  it('generates varied codes', () => {
    const codes = new Set(Array.from({ length: 200 }, generateRoomCode));
    // A generator stuck on one value would be a serious bug.
    expect(codes.size).toBeGreaterThan(150);
  });

  it('normalises case and separators', () => {
    expect(normalizeRoomCode(' a7k9p ')).toBe('A7K9P');
    expect(normalizeRoomCode('A7K 9P')).toBe('A7K9P');
    expect(normalizeRoomCode('a7k-9p')).toBe('A7K9P');
  });

  it('does not fold look-alike glyphs onto real ones', () => {
    // Folding O -> Q would send a typo into somebody else's room.
    expect(normalizeRoomCode('OOOOO')).toBe('OOOOO');
    expect(isValidRoomCode(normalizeRoomCode('OOOOO'))).toBe(false);
  });

  it('rejects codes of the wrong length or alphabet', () => {
    expect(isValidRoomCode('ABC')).toBe(false);
    expect(isValidRoomCode('ABCDEF')).toBe(false);
    expect(isValidRoomCode('ABCD0')).toBe(false);
  });

  it('retries until it finds a free code', () => {
    let calls = 0;
    return generateUniqueRoomCode(async () => {
      calls += 1;
      return calls < 3;
    }).then((code) => {
      expect(calls).toBe(3);
      expect(code).not.toBeNull();
    });
  });

  it('gives up rather than spinning forever', async () => {
    expect(await generateUniqueRoomCode(async () => true, 4)).toBeNull();
  });
});

describe('room settings validation', () => {
  it('fills in defaults for an empty payload', () => {
    const settings = roomSettingsSchema.parse({});

    expect(settings.maxPlayers).toBe(8);
    expect(settings.rounds).toBe(3);
    expect(settings.drawTimeSeconds).toBe(80);
    expect(settings.wordMode).toBe('normal');
    expect(settings.language).toBe('en');
  });

  it('clamps out-of-range numbers instead of rejecting them', () => {
    const settings = roomSettingsSchema.parse({
      maxPlayers: 999,
      rounds: -4,
      drawTimeSeconds: 5,
    });

    expect(settings.maxPlayers).toBe(ROOM_LIMITS.maxPlayers.max);
    expect(settings.rounds).toBe(ROOM_LIMITS.rounds.min);
    expect(settings.drawTimeSeconds).toBe(ROOM_LIMITS.drawTimeSeconds.min);
  });

  it('falls back on an unknown enum value', () => {
    const settings = roomSettingsSchema.parse({ wordMode: 'nonsense', language: 'xx' });

    expect(settings.wordMode).toBe('normal');
    expect(settings.language).toBe('en');
  });

  it('drops unknown categories but keeps known ones', () => {
    const settings = roomSettingsSchema.parse({
      categories: ['animals', 'not-a-category', 'music'],
    });

    expect(settings.categories).toEqual(['animals', 'music']);
  });

  it('discards custom words that are too short or too long', () => {
    const settings = roomSettingsSchema.parse({
      customWords: ['a', 'cat', '  dog  ', 'x'.repeat(99)],
    });

    expect(settings.customWords).toEqual(['cat', 'dog']);
  });
});

describe('lobby summary', () => {
  it('blocks a start below the minimum player count', () => {
    const room = makeRoom({ players: [makePlayer({ userId: 'a' })] });
    const snapshot = lobbyService.snapshot(room);

    expect(snapshot.canStart).toBe(false);
    expect(snapshot.blockedReason).toContain('Waiting');
  });

  it('allows a start with enough players', () => {
    const room = makeRoom({
      players: [makePlayer({ userId: 'a' }), makePlayer({ userId: 'b' })],
    });

    expect(lobbyService.snapshot(room).canStart).toBe(true);
  });

  it('blocks a start while a game is running', () => {
    const room = makeRoom({
      phase: 'drawing',
      players: [makePlayer({ userId: 'a' }), makePlayer({ userId: 'b' })],
    });

    const snapshot = lobbyService.snapshot(room);
    expect(snapshot.canStart).toBe(false);
    expect(snapshot.blockedReason).toContain('in progress');
  });

  it('does not count disconnected players towards the minimum', () => {
    const room = makeRoom({
      players: [
        makePlayer({ userId: 'a' }),
        makePlayer({ userId: 'b', connection: 'disconnected' }),
      ],
    });

    expect(lobbyService.snapshot(room).canStart).toBe(false);
  });
});

describe('timers', () => {
  const timers = new TimerService();

  it('replaces a timer registered under the same name', async () => {
    const room = makeRoom({});
    const fired: string[] = [];

    timers.schedule(room, 'test', 5, () => fired.push('first'));
    timers.schedule(room, 'test', 5, () => fired.push('second'));

    await new Promise((resolve) => setTimeout(resolve, 40));

    // Re-scheduling must not leave two timers firing.
    expect(fired).toEqual(['second']);
  });

  it('cancels every timer at once', async () => {
    const room = makeRoom({});
    let fired = false;

    timers.schedule(room, 'a', 5, () => {
      fired = true;
    });
    timers.cancelAll(room);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fired).toBe(false);
  });

  it('does not schedule anything on a closed room', async () => {
    const room = makeRoom({});
    room.closed = true;
    let fired = false;

    timers.schedule(room, 'a', 5, () => {
      fired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fired).toBe(false);
  });

  it('survives a callback that throws', async () => {
    const room = makeRoom({});

    timers.schedule(room, 'boom', 5, () => {
      throw new Error('boom');
    });

    // A throwing timer has no request to attach to; it must not take the
    // process down.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(room.timers.has('boom')).toBe(false);
  });

  it('reports remaining time and progress', () => {
    const now = 1_000_000;

    expect(timers.remaining(now + 5_000, now)).toBe(5_000);
    expect(timers.remaining(now - 5_000, now)).toBe(0);

    expect(timers.progress(now, now + 10_000, now + 5_000)).toBe(0.5);
    expect(timers.progress(now, now + 10_000, now - 1)).toBe(0);
    expect(timers.progress(now, now + 10_000, now + 99_999)).toBe(1);
  });
});

describe('drawing board', () => {
  it('clamps coordinates into the unit square', () => {
    const points = drawingService.sanitizePoints([
      [0.5, 0.5],
      [-3, 9],
    ]);

    expect(points).toEqual([
      [0.5, 0.5],
      [0, 1],
    ]);
  });

  it('drops malformed points without dropping the batch', () => {
    const points = drawingService.sanitizePoints([[0.1, 0.2], 'nope', [0.3], [0.4, 0.5]]);

    expect(points).toEqual([
      [0.1, 0.2],
      [0.4, 0.5],
    ]);
  });

  it('takes the author from the socket, not the payload', () => {
    const stroke = drawingService.sanitizeStroke(
      { id: 's1', a: 'somebody-else', p: [], c: 1, w: 4, t: 'pen', ts: 0 },
      'real-user',
    );

    // Otherwise a guesser could attribute strokes to the drawer.
    expect(stroke.a).toBe('real-user');
  });

  it('undo returns a stroke to the redo stack, and redo puts it back', () => {
    const room = makeRoom({});
    const stroke = drawingService.sanitizeStroke({ id: 's1', p: [], c: 1, w: 4 }, 'drawer');

    drawingService.begin(room, stroke);
    expect(room.board.strokes).toHaveLength(1);

    drawingService.undo(room, 'drawer');
    expect(room.board.strokes).toHaveLength(0);
    expect(room.board.redoStack).toHaveLength(1);

    drawingService.redo(room);
    expect(room.board.strokes).toHaveLength(1);
  });

  it('will not undo somebody else’s stroke', () => {
    const room = makeRoom({});
    drawingService.begin(
      room,
      drawingService.sanitizeStroke({ id: 's1', p: [], c: 1, w: 4 }, 'drawer'),
    );

    expect(drawingService.undo(room, 'a-guesser')).toBeNull();
    expect(room.board.strokes).toHaveLength(1);
  });

  it('drops the redo stack once something new is drawn', () => {
    const room = makeRoom({});
    const first = drawingService.sanitizeStroke({ id: 's1', p: [], c: 1, w: 4 }, 'drawer');
    const second = drawingService.sanitizeStroke({ id: 's2', p: [], c: 1, w: 4 }, 'drawer');

    drawingService.begin(room, first);
    drawingService.undo(room, 'drawer');
    drawingService.begin(room, second);

    // As in any editor: draw something new and the undone thing is gone.
    expect(room.board.redoStack).toHaveLength(0);
  });

  it('ignores points for a stroke it never saw begin', () => {
    const room = makeRoom({});
    expect(drawingService.append(room, 'unknown', [[0.1, 0.1]])).toBe(false);
  });

  it('clears both the board and the redo stack', () => {
    const room = makeRoom({});
    drawingService.begin(
      room,
      drawingService.sanitizeStroke({ id: 's1', p: [], c: 1, w: 4 }, 'drawer'),
    );
    drawingService.clear(room);

    expect(room.board.strokes).toHaveLength(0);
    expect(room.board.redoStack).toHaveLength(0);
  });
});
