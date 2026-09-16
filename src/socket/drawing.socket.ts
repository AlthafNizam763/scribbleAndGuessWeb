import { emitToRoom, emitToRoomExcept } from '@/config/socket';
import {
  CLIENT_DRAW_APPEND,
  CLIENT_DRAW_BEGIN,
  CLIENT_DRAW_CLEAR,
  CLIENT_DRAW_END,
  CLIENT_DRAW_REDO,
  CLIENT_DRAW_UNDO,
  SERVER_DRAW_APPEND,
  SERVER_DRAW_BEGIN,
  SERVER_DRAW_CLEAR,
  SERVER_DRAW_END,
  SERVER_DRAW_REDO,
  SERVER_DRAW_UNDO,
} from '@/constants/socket.constants';
import { drawingService } from '@/services/drawing.service';
import { gameModeService } from '@/services/gameMode.service';
import { on } from '@/socket/handler';
import type { GameSocket } from '@/types/socket.types';

/**
 * The drawing relay (brief sections 24 to 26).
 *
 * ## The hot path
 *
 * `c:draw:append` runs roughly seventeen times a second per drawer. Everything
 * about these handlers is shaped by that: no acks, no database, no awaits, and
 * the permission check is a pair of string comparisons against state already
 * in memory.
 *
 * ## Why stroke broadcasts exclude the sender, and the rest do not
 *
 * The drawer already painted the stroke locally the moment their finger moved
 * — that is what makes drawing feel instant. Echoing `begin`, `append` and
 * `end` back would make them render it twice and, worse, would tie their own
 * line's smoothness to their network latency. The client mirrors those three
 * onto its own board instead (see `SocketDrawingRepository`).
 *
 * Undo, redo and clear go to the whole room, the sender included. Which stroke
 * each one moves is decided *here* — `undo` takes the last stroke this user
 * authored, `redo` pops the board's own stack — so a client that applied them
 * optimistically would be guessing, and would drift the moment it guessed
 * wrong. They are also one press each rather than seventeen messages a second,
 * so the round trip costs nothing worth saving.
 */
export function registerDrawingHandlers(socket: GameSocket): void {
  const roomId = (): string => socket.data.roomId ?? '';

  on(
    socket,
    CLIENT_DRAW_BEGIN,
    ({ room, userId, socket: sock }, payload) => {
      drawingService.assertCanDraw(room, userId);

      const body = (payload ?? {}) as { stroke?: unknown };
      const stroke = drawingService.sanitizeStroke(body.stroke ?? payload, userId);

      // One Colour, enforced on the stroke rather than in the toolbar. The
      // lock is the first colour the drawer actually used this turn — read
      // from the board, so it survives a reconnect — and a stroke in any other
      // colour is rewritten rather than refused: a drawer whose line silently
      // failed would think the canvas was broken, while one whose line comes
      // out the wrong colour can see the rule at work.
      const locked = gameModeService.lockedColor(room);
      if (locked !== null && stroke.t !== 'eraser') stroke.c = locked;

      if (!drawingService.begin(room, stroke)) return;

      emitToRoomExcept(sock, roomId(), SERVER_DRAW_BEGIN, { stroke });
    },
    { limit: 'drawing', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_DRAW_APPEND,
    ({ room, userId, socket: sock }, payload) => {
      drawingService.assertCanDraw(room, userId);

      const body = (payload ?? {}) as { strokeId?: unknown; points?: unknown };
      const strokeId = typeof body.strokeId === 'string' ? body.strokeId : '';
      if (!strokeId) return;

      const points = drawingService.sanitizePoints(body.points);
      if (points.length === 0) return;

      // A batch for a stroke the server never saw begin is dropped rather than
      // relayed: the receivers would have nothing to attach it to either.
      if (!drawingService.append(room, strokeId, points)) return;

      emitToRoomExcept(sock, roomId(), SERVER_DRAW_APPEND, { strokeId, points });
    },
    { limit: 'drawing', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_DRAW_END,
    ({ room, userId, socket: sock }, payload) => {
      drawingService.assertCanDraw(room, userId);

      const body = (payload ?? {}) as { strokeId?: unknown };
      const strokeId = typeof body.strokeId === 'string' ? body.strokeId : '';
      if (!strokeId) return;

      emitToRoomExcept(sock, roomId(), SERVER_DRAW_END, { strokeId });
    },
    { limit: 'drawing', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_DRAW_UNDO,
    ({ room, userId }) => {
      drawingService.assertCanDraw(room, userId);

      const stroke = drawingService.undo(room, userId);
      if (!stroke) return;

      emitToRoom(roomId(), SERVER_DRAW_UNDO, { strokeId: stroke.id });
    },
    { limit: 'drawing', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_DRAW_REDO,
    ({ room, userId }) => {
      drawingService.assertCanDraw(room, userId);

      const stroke = drawingService.redo(room);
      if (!stroke) return;

      emitToRoom(roomId(), SERVER_DRAW_REDO, { stroke });
    },
    { limit: 'drawing', requiresRoom: true },
  );

  on(
    socket,
    CLIENT_DRAW_CLEAR,
    ({ room, userId }) => {
      drawingService.assertCanDraw(room, userId);

      drawingService.clear(room);
      emitToRoom(roomId(), SERVER_DRAW_CLEAR, {});
    },
    { limit: 'drawing', requiresRoom: true },
  );
}
