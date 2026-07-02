// The plot surface: owns the viewport, handles pan (drag), zoom (wheel),
// pinch (two pointers), and redraws sampled curves each animation frame a
// change occurs.

import { useCallback, useEffect, useRef, useState } from 'react';
import { drawCurve, drawGrid, type Theme } from '../plot/render.ts';
import { sampleCurve } from '../plot/sampler.ts';
import { defaultViewport, pan, resize, zoomAt, type Viewport } from '../plot/viewport.ts';

export interface PlottedCurve {
  id: number;
  f: (x: number) => number;
  color: string;
}

const THEME: Theme = {
  grid: '#34373d',
  gridMinor: '#26282d',
  axis: '#5a5e66',
  label: '#9a9da5',
  fontPx: 11,
  fontFamily: 'Inter, system-ui, sans-serif',
};

interface PointerState {
  /** Active pointers, id → last position in CSS px. */
  pointers: Map<number, { x: number; y: number }>;
  /** Distance between the two pinch pointers at the last event. */
  pinchDist: number;
}

export function GraphCanvas({ curves }: { curves: PlottedCurve[] }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const pointerState = useRef<PointerState>({ pointers: new Map(), pinchDist: 0 });

  // Size the canvas to its container: measure synchronously on mount (don't
  // wait for the observer's first tick), then track resizes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.parentElement) return;
    const measure = (): void => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      setViewport((vp) => (vp === null ? defaultViewport(w, h) : resize(vp, w, h)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, []);

  // Redraw whenever the viewport or the curve set changes. Drawing happens
  // synchronously in the effect: React already batches state updates per
  // input event, so this runs at most once per frame's worth of events.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport) return;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.round(viewport.width * dpr);
    const pxH = Math.round(viewport.height * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    if (showGrid) drawGrid(ctx, viewport, THEME);
    for (const curve of curves) {
      drawCurve(ctx, sampleCurve(curve.f, viewport), { color: curve.color, widthPx: 2.25 });
    }
  }, [viewport, curves, showGrid]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const st = pointerState.current;
    st.pointers.set(e.pointerId, { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY });
    if (st.pointers.size === 2) {
      const [a, b] = [...st.pointers.values()];
      st.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = pointerState.current;
    const prev = st.pointers.get(e.pointerId);
    if (!prev) return;
    const pos = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    st.pointers.set(e.pointerId, pos);

    if (st.pointers.size === 1) {
      setViewport((vp) => (vp ? pan(vp, pos.x - prev.x, pos.y - prev.y) : vp));
    } else if (st.pointers.size === 2) {
      const [a, b] = [...st.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (st.pinchDist > 0 && dist > 0) {
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const factor = st.pinchDist / dist;
        setViewport((vp) => (vp ? zoomAt(vp, midX, midY, factor) : vp));
      }
      st.pinchDist = dist;
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    pointerState.current.pointers.delete(e.pointerId);
    pointerState.current.pinchDist = 0;
  }, []);

  // Wheel zoom, centered on the cursor. Native listener: React's onWheel is
  // passive, so preventDefault (needed to stop page scroll) wouldn't work.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.0015);
      setViewport((vp) => (vp ? zoomAt(vp, e.offsetX, e.offsetY, factor) : vp));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const resetView = useCallback(() => {
    setViewport((vp) => (vp ? defaultViewport(vp.width, vp.height) : vp));
  }, []);

  return (
    <div className="graph-container">
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="graph-controls">
        <button
          type="button"
          title={showGrid ? 'Hide grid' : 'Show grid'}
          aria-pressed={showGrid}
          onClick={() => setShowGrid((g) => !g)}
        >
          ⌗
        </button>
        <button type="button" title="Reset view" onClick={resetView}>
          ⌂
        </button>
      </div>
    </div>
  );
}
