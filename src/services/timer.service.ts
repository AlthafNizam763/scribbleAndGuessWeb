import type { RuntimeRoom } from '@/types/socket.types';
import { logger } from '@/utils/logger';

/**
 * Server-authoritative timing (brief sections 27 and 28).
 *
 * ## The client never ends anything
 *
 * A round ends when *this* process says so. Clients receive `turnStartMs` and
 * `turnEndMs` as absolute timestamps on the server clock and render a
 * countdown from them, corrected by the offset they measured with `c:time:ping`.
 * A device with a wrong clock, a paused app or a tampered build therefore sees
 * the wrong seconds but cannot change when the round actually ends.
 *
 * ## Why timers are owned by the room
 *
 * Every handle is registered in `room.timers` under a name. That gives two
 * things worth having: a later call under the same name replaces the earlier
 * one (so re-scheduling a hint cannot leave two firing), and closing a room
 * cancels everything it owns in one pass, which is what stops a finished game
 * from waking up thirty seconds later and broadcasting into an empty room.
 */

/** Names used for the timers a room owns, so callers cannot typo them apart. */
export const TIMER = {
  /** The countdown between "start" and the first word choice. */
  startCountdown: 'startCountdown',
  /** The drawer's word-selection deadline. */
  wordSelection: 'wordSelection',
  /** The drawing turn itself. */
  turn: 'turn',
  /** One entry per scheduled hint. */
  hint: (index: number) => `hint:${index}`,
  /** The pause on the round scoreboard. */
  roundResult: 'roundResult',
  /** The pause on the final standings. */
  gameEnd: 'gameEnd',
  /** The grace period after everyone has guessed. */
  allGuessed: 'allGuessed',
  /** A disconnected drawer's grace period. */
  drawerGrace: 'drawerGrace',
  /** An open vote-kick poll. */
  voteKick: 'voteKick',
} as const;

export class TimerService {
  /**
   * Runs `callback` after `delayMs`, replacing any timer of the same name.
   *
   * A non-positive delay still goes through `setTimeout` rather than running
   * inline: callers schedule from inside event handlers, and running the
   * callback synchronously would re-enter the game engine part-way through a
   * state change it had not finished making.
   */
  schedule(room: RuntimeRoom, name: string, delayMs: number, callback: () => void): void {
    this.cancel(room, name);
    if (room.closed) return;

    const handle = setTimeout(() => {
      room.timers.delete(name);
      try {
        callback();
      } catch (error) {
        // A throwing timer would otherwise take the process down, since there
        // is no request to attach it to.
        logger.exception('timer callback failed', error, { roomId: room.roomId, timer: name });
      }
    }, Math.max(0, delayMs));

    // Do not hold the event loop open just for a game timer: a server with an
    // idle room should still be able to shut down.
    handle.unref?.();

    room.timers.set(name, handle);
  }

  /** Schedules against an absolute deadline on the server clock. */
  scheduleAt(room: RuntimeRoom, name: string, atMs: number, callback: () => void): void {
    this.schedule(room, name, atMs - Date.now(), callback);
  }

  cancel(room: RuntimeRoom, name: string): void {
    const handle = room.timers.get(name);
    if (handle) {
      clearTimeout(handle);
      room.timers.delete(name);
    }
  }

  /** Cancels every timer the room owns. Called on close and on phase change. */
  cancelAll(room: RuntimeRoom): void {
    for (const handle of room.timers.values()) clearTimeout(handle);
    room.timers.clear();
  }

  /** Cancels every timer belonging to the current turn, leaving room-level ones. */
  cancelTurnTimers(room: RuntimeRoom): void {
    this.cancel(room, TIMER.wordSelection);
    this.cancel(room, TIMER.turn);
    this.cancel(room, TIMER.allGuessed);
    this.cancel(room, TIMER.drawerGrace);
    for (const name of [...room.timers.keys()]) {
      if (name.startsWith('hint:')) this.cancel(room, name);
    }
  }

  /** Milliseconds left before `endMs`, never negative. */
  remaining(endMs: number, nowMs: number = Date.now()): number {
    return Math.max(0, endMs - nowMs);
  }

  /** Fraction of a window already elapsed, clamped to 0..1. */
  progress(startMs: number, endMs: number, nowMs: number = Date.now()): number {
    if (endMs <= startMs) return 1;
    const ratio = (nowMs - startMs) / (endMs - startMs);
    return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  }
}

export const timerService = new TimerService();
