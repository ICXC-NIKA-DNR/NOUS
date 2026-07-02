// The plot surface: owns the viewport, handles pan (drag), zoom (wheel),
// pinch (two pointers), and redraws on changes.
//
// Dirty tracking (M3): sampled segments are cached per curve and reused
// unless that curve's inputs changed — viewport, compiled closure identity,
// or the values of the sliders it depends on (the fingerprint). A slider
// drag therefore resamples only dependent curves; the rest just repaint,
// which is ~50× cheaper than resampling.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Env } from '../core/compile.ts';
import { drawCurve, drawGrid, type Theme } from '../plot/render.ts';
import { sampleCurve, type Segment } from '../plot/sampler.ts';
import { defaultViewport, pan, resize, zoomAt, type Viewport } from '../plot/viewport.ts';

export interface PlottedCurve {
  id: number;
  f: (x: number, env: Env) => number;
  /** Slider values this curve reads, joined — the dirty-tracking key. */
  fingerprint: string;
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

interface CacheEntry {
  vp: Viewport;
  fingerprint: string;
  f: PlottedCurve['f'];
  segments: Segment[];
}

interface PointerState {
  pointers: Map<number, { x: number; y: number }>;
  pinchDist: number;
}

export interface FrameStats {
  /** ms spent sampling + drawing this frame. */
  frameMs: number;
  /** curves resampled vs served from cache. */
  resampled: number;
  cached: number;
}

interface Props {
  curves: PlottedCurve[];
  env: Env;
  /** Called after each redraw with timing — the perf harness's hook. */
  onFrame?: (stats: FrameStats) => void;
}

/** Size a canvas's backing store to the viewport; true if it changed. */
function fitCanvas(canvas: HTMLCanvasElement, vp: Viewport, dpr: number): void {
  const pxW = Math.round(vp.width * dpr);
  const pxH = Math.round(vp.height * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
  }
}

export function GraphCanvas({ curves, env, onFrame }: Props): JSX.Element {
  // Three stacked canvases. The grid only changes on pan/zoom. Curves split
  // by what changed in this commit: curves that resampled draw on the
  // dynamic layer; unchanged curves stay rendered on the static layer, which
  // is only re-stroked when its membership changes. During a slider drag the
  // dependent curves cycle on the dynamic layer while everything else costs
  // nothing — that skip is what holds the M3 gate on software rasterizers.
  const gridRef = useRef<HTMLCanvasElement | null>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const dynamicRef = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const pointerState = useRef<PointerState>({ pointers: new Map(), pinchDist: 0 });
  const cacheRef = useRef<Map<number, CacheEntry>>(new Map());
  // Static layer contents as of its last redraw: ordered [id, segments] pairs.
  const staticDrawnRef = useRef<Array<[number, Segment[]]>>([]);

  // Size to the container: measure synchronously on mount (don't wait for
  // the observer's first tick), then track resizes.
  useEffect(() => {
    const container = dynamicRef.current?.parentElement;
    if (!container) return;
    const measure = (): void => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      setViewport((vp) => (vp === null ? defaultViewport(w, h) : resize(vp, w, h)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Grid layer: viewport / toggle changes only.
  useEffect(() => {
    const canvas = gridRef.current;
    if (!canvas || !viewport) return;
    const dpr = window.devicePixelRatio || 1;
    fitCanvas(canvas, viewport, dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    if (showGrid) drawGrid(ctx, viewport, THEME);
  }, [viewport, showGrid]);

  // Curve layers: run when anything plottable changes. Drawing happens
  // synchronously in the effect: React already batches state updates per
  // input event, so this runs at most once per frame's worth of events.
  useEffect(() => {
    const staticCanvas = staticRef.current;
    const dynamicCanvas = dynamicRef.current;
    if (!staticCanvas || !dynamicCanvas || !viewport) return;
    const t0 = performance.now();
    const dpr = window.devicePixelRatio || 1;

    // Pass 1: resolve segments per curve, partition changed vs unchanged.
    const cache = cacheRef.current;
    const seen = new Set<number>();
    const changed: Array<[PlottedCurve, Segment[]]> = [];
    const unchanged: Array<[number, Segment[], string]> = []; // id, segs, color
    for (const curve of curves) {
      seen.add(curve.id);
      const hit = cache.get(curve.id);
      if (
        hit !== undefined &&
        hit.vp === viewport &&
        hit.fingerprint === curve.fingerprint &&
        hit.f === curve.f
      ) {
        unchanged.push([curve.id, hit.segments, curve.color]);
      } else {
        const segments = sampleCurve((x) => curve.f(x, env), viewport);
        cache.set(curve.id, { vp: viewport, fingerprint: curve.fingerprint, f: curve.f, segments });
        changed.push([curve, segments]);
      }
    }
    for (const id of cache.keys()) {
      if (!seen.has(id)) cache.delete(id);
    }

    // Pass 2: static layer — re-stroke only when its membership changed.
    const prev = staticDrawnRef.current;
    const sameStatic =
      prev.length === unchanged.length &&
      prev.every(([id, segs], i) => unchanged[i][0] === id && unchanged[i][1] === segs);
    if (!sameStatic) {
      fitCanvas(staticCanvas, viewport, dpr);
      const sctx = staticCanvas.getContext('2d');
      if (sctx) {
        sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        sctx.clearRect(0, 0, viewport.width, viewport.height);
        for (const [, segments, color] of unchanged) {
          drawCurve(sctx, segments, { color, widthPx: 2 });
        }
      }
      staticDrawnRef.current = unchanged.map(([id, segs]) => [id, segs]);
    }

    // Pass 3: dynamic layer — the curves that changed this commit.
    fitCanvas(dynamicCanvas, viewport, dpr);
    const dctx = dynamicCanvas.getContext('2d');
    if (dctx) {
      dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dctx.clearRect(0, 0, viewport.width, viewport.height);
      for (const [curve, segments] of changed) {
        drawCurve(dctx, segments, { color: curve.color, widthPx: 2 });
      }
    }

    onFrame?.({
      frameMs: performance.now() - t0,
      resampled: changed.length,
      cached: unchanged.length,
    });
  }, [viewport, curves, env, onFrame]);

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
    const canvas = dynamicRef.current;
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
      <canvas ref={gridRef} className="graph-canvas graph-grid-layer" />
      <canvas ref={staticRef} className="graph-canvas graph-grid-layer" />
      <canvas
        ref={dynamicRef}
        className="graph-canvas graph-curves-layer"
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
