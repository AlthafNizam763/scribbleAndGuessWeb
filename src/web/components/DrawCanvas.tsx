'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useGame } from '@/web/GameProvider';
import type { DrawToolWire, PointTuple, StrokeDto } from '@/web/types';

/**
 * The shared board.
 *
 * ## Coordinates
 *
 * Points are normalised to 0..1 against a 4:3 box, which is the contract the
 * Flutter client already uses. That is what lets a stroke drawn on a phone land
 * in the same place on a desktop canvas — neither end ever sends a pixel.
 *
 * ## Colour
 *
 * `c` is a 32-bit ARGB integer because that is what Dart's `Color.value` is.
 * A CSS string here would not survive the trip to the app, so the conversion
 * happens at the edges and the wire stays as it was.
 *
 * ## Batching
 *
 * A pointer emits far more moves than anyone needs to see. Points are
 * collected and flushed on a fixed interval, matching the app's own ~60ms
 * cadence: it keeps the line smooth while sending a fraction of the frames,
 * and it stays under the server's per-batch point cap.
 */

/** How often buffered points are sent. Matches the Flutter client. */
const FLUSH_MS = 60;

/** The reference width the stored stroke widths are in logical pixels of. */
const REFERENCE_WIDTH = 800;

/** Opaque black, and the pen this client starts on. */
const DEFAULT_COLOR = 0xff000000;
const DEFAULT_WIDTH = 6;

const PALETTE: number[] = [
  DEFAULT_COLOR, 0xffffffff, 0xffe53935, 0xfffb8c00, 0xfffdd835, 0xff43a047,
  0xff1e88e5, 0xff8e24aa, 0xff6d4c41, 0xff9e9e9e,
];

const WIDTHS: number[] = [3, DEFAULT_WIDTH, 12, 24];

/** ARGB integer to a CSS colour. */
function cssColor(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** A stroke id that will not collide with the app's. */
function strokeId(): string {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function DrawCanvas({ canDraw }: { canDraw: boolean }) {
  const { strokes, beginStroke, appendStroke, endStroke, undo, redo, clearBoard } = useGame();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const [color, setColor] = useState<number>(DEFAULT_COLOR);
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [tool, setTool] = useState<DrawToolWire>('pen');

  /** The stroke currently under the pointer, and its unsent points. */
  const activeRef = useRef<{ id: string; buffer: PointTuple[] } | null>(null);

  // ------------------------------------------------------------------ render

  /**
   * Repaints the whole board.
   *
   * Every stroke, every frame. A room's board is capped well below the point
   * where that costs anything, and the alternative — painting only what
   * changed — cannot express undo, redo or clear without keeping a second
   * model of the canvas in sync with the first.
   */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const { width: w, height: h } = canvas;

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, w, h);
    context.lineCap = 'round';
    context.lineJoin = 'round';

    const scale = w / REFERENCE_WIDTH;

    for (const stroke of strokes) {
      if (stroke.p.length === 0) continue;

      // The eraser is white rather than a composite operation, because the
      // board it paints on is always white — and `destination-out` would punch
      // a hole showing the page behind it instead.
      const base = stroke.t === 'eraser' ? '#ffffff' : cssColor(stroke.c);

      // A fill covers the canvas and has neither geometry nor width. Not a
      // flood fill of an enclosed region — see `FILL_TOOLS` on the server for
      // why that could not replay identically across clients.
      if (stroke.t === 'fill') {
        context.fillStyle = base;
        context.fillRect(0, 0, w, h);
        continue;
      }

      // Translucency is applied here rather than baked into the stored colour,
      // so one swatch means one colour whichever tool picked it up.
      context.globalAlpha =
        stroke.t === 'marker' ? 0.45 : stroke.t === 'pencil' ? 0.75 : 1;
      context.lineCap = stroke.t === 'marker' ? 'square' : 'round';
      context.lineJoin = stroke.t === 'marker' ? 'miter' : 'round';

      context.strokeStyle = base;
      const nominalWidth = Math.max(1, stroke.w * scale);
      context.lineWidth = nominalWidth;

      const first = stroke.p[0];
      if (!first) continue;

      // Shapes are two points: the drag's start and end.
      if (stroke.t === 'line' || stroke.t === 'rectangle' || stroke.t === 'circle') {
        const second = stroke.p[1];
        if (!second) continue;

        const x0 = first[0] * w;
        const y0 = first[1] * h;
        const x1 = second[0] * w;
        const y1 = second[1] * h;

        context.beginPath();
        if (stroke.t === 'line') {
          context.moveTo(x0, y0);
          context.lineTo(x1, y1);
        } else if (stroke.t === 'rectangle') {
          context.rect(x0, y0, x1 - x0, y1 - y0);
        } else {
          context.ellipse(
            (x0 + x1) / 2,
            (y0 + y1) / 2,
            Math.abs(x1 - x0) / 2,
            Math.abs(y1 - y0) / 2,
            0,
            0,
            Math.PI * 2,
          );
        }
        context.stroke();
        context.globalAlpha = 1;
        continue;
      }

      // The brush varies its width with the pressure recorded per point, so it
      // is drawn as one segment per pair — a path carries a single width for
      // its whole length. Confined to the one tool that needs it.
      if (stroke.t === 'brush' && stroke.p.length > 1) {
        for (let i = 1; i < stroke.p.length; i += 1) {
          const from = stroke.p[i - 1];
          const to = stroke.p[i];
          if (!from || !to) continue;

          const pressure = ((from[2] ?? 0.5) + (to[2] ?? 0.5)) / 2;
          context.lineWidth = nominalWidth * (0.4 + pressure * 1.2);

          context.beginPath();
          context.moveTo(from[0] * w, from[1] * h);
          context.lineTo(to[0] * w, to[1] * h);
          context.stroke();
        }
        context.globalAlpha = 1;
        continue;
      }

      context.beginPath();
      context.moveTo(first[0] * w, first[1] * h);

      if (stroke.p.length === 1) {
        // A tap is a dot. Without this it would draw nothing at all.
        context.lineTo(first[0] * w + 0.01, first[1] * h);
      } else {
        for (let i = 1; i < stroke.p.length; i += 1) {
          const point = stroke.p[i];
          if (point) context.lineTo(point[0] * w, point[1] * h);
        }
      }

      context.stroke();
      context.globalAlpha = 1;
    }
  }, [strokes]);

  /** Sizes the backing store to the display size, accounting for retina. */
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return undefined;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = box.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      paint();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(box);
    return () => observer.disconnect();
  }, [paint]);

  useEffect(() => {
    paint();
  }, [paint]);

  // ------------------------------------------------------------------- input

  /** Flushes buffered points on a fixed cadence while a stroke is live. */
  useEffect(() => {
    if (!canDraw) return undefined;

    const timer = setInterval(() => {
      const active = activeRef.current;
      if (!active || active.buffer.length === 0) return;

      const points = active.buffer;
      active.buffer = [];
      appendStroke(active.id, points);
    }, FLUSH_MS);

    return () => clearInterval(timer);
  }, [canDraw, appendStroke]);

  /** Pointer position as a 0..1 pair, clamped to the box. */
  const pointAt = useCallback((event: React.PointerEvent): PointTuple => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    if (!canDraw) return;
    event.currentTarget.setPointerCapture(event.pointerId);

    const id = strokeId();
    const stroke: StrokeDto = {
      id,
      a: '',
      p: [pointAt(event)],
      c: color,
      w: width,
      t: tool,
      ts: Date.now(),
    };

    activeRef.current = { id, buffer: [] };
    beginStroke(stroke);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!canDraw || !activeRef.current) return;
    activeRef.current.buffer.push(pointAt(event));
  };

  const finish = () => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;

    // Whatever is still buffered has to go before the end, or the last few
    // millimetres of the line never reach anybody else.
    if (active.buffer.length > 0) appendStroke(active.id, active.buffer);
    endStroke(active.id);
  };

  return (
    <div>
      <div
        ref={boxRef}
        className="board"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={finish}
        style={{ cursor: canDraw ? 'crosshair' : 'default' }}
      >
        <canvas ref={canvasRef} />
      </div>

      {canDraw ? (
        <div className="toolbar">
          {PALETTE.map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`Colour ${cssColor(value)}`}
              className={`swatch${value === color && tool === 'pen' ? ' swatch--active' : ''}`}
              style={{ background: cssColor(value) }}
              onClick={() => {
                setColor(value);
                setTool('pen');
              }}
            />
          ))}

          <span style={{ width: '0.5rem' }} />

          {WIDTHS.map((value) => (
            <button
              key={value}
              type="button"
              className={value === width ? 'btn--primary' : ''}
              onClick={() => setWidth(value)}
            >
              {value}
            </button>
          ))}

          <span className="spacer" />

          <button
            type="button"
            className={tool === 'eraser' ? 'btn--primary' : ''}
            onClick={() => setTool(tool === 'eraser' ? 'pen' : 'eraser')}
          >
            Eraser
          </button>
          <button type="button" onClick={undo}>
            Undo
          </button>
          <button type="button" onClick={redo}>
            Redo
          </button>
          <button type="button" className="btn--danger" onClick={clearBoard}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}
