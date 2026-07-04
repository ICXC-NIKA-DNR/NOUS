// The plot surface: owns the viewport, handles pan (drag), zoom (wheel),
// pinch (two pointers), and redraws on changes.
//
// Dirty tracking (M3): sampled segments are cached per curve and reused
// unless that curve's inputs changed — viewport, compiled closure identity,
// or the values of the sliders it depends on (the fingerprint). A slider
// drag therefore resamples only dependent curves; the rest just repaint,
// which is ~50× cheaper than resampling.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompiledFn, Env } from '../core/compile.ts';
import { contour, regionMask, type RegionMask } from '../plot/implicit.ts';
import { drawArrow, drawVectorField, drawWorldPoint } from '../plot/marks.ts';
import { sampleParametric } from '../plot/parametric.ts';
import { collectPois, type Poi, type PoiCurve } from '../plot/poi.ts';
import { drawCurve, drawGrid, drawRegion, type Theme } from '../plot/render.ts';
import { sampleCurve, type Segment } from '../plot/sampler.ts';
import {
  defaultViewport,
  pan,
  pxToX,
  pxToY,
  resize,
  xToPx,
  yToPx,
  zoomAt,
  type Viewport,
} from '../plot/viewport.ts';
import { formatValue, type PlotSpec } from './analyze.ts';

export interface PlottedCurve {
  id: number;
  spec: PlotSpec;
  /** Slider values this item reads, joined — the dirty-tracking key. */
  fingerprint: string;
  color: string;
  /** Compiled symbolic derivative for explicit curves (POI detection). */
  fPrime?: (x: number, env: Env) => number;
}

/** A point row bound to exactly one slider — draggable along its path. */
export interface DragPoint {
  id: number;
  /** The slider it drives. */
  name: string;
  min: number;
  max: number;
  step: number;
  fx: CompiledFn;
  fy: CompiledFn;
}

/** Cached geometry per item — everything derivable from (spec, vp, env). */
type Artifact =
  | { kind: 'segments'; segments: Segment[] }
  | {
      kind: 'region';
      mask: RegionMask;
      boundaries: Array<{ segments: Segment[]; dashed: boolean }>;
    }
  | { kind: 'points'; pts: Array<[number, number]> }
  | { kind: 'vector'; from: [number, number]; to: [number, number] }
  | { kind: 'field' } // sampled cheaply at draw time
  | { kind: 'nothing' };

function buildArtifact(spec: PlotSpec, vp: Viewport, env: Env): Artifact {
  switch (spec.type) {
    case 'explicit':
      return { kind: 'segments', segments: sampleCurve((x) => spec.f(x, env), vp) };
    case 'parametric': {
      const t0 = spec.t0(env);
      const t1 = spec.t1(env);
      if (!(t1 > t0)) return { kind: 'nothing' };
      return {
        kind: 'segments',
        segments: sampleParametric((t) => spec.fx(t, env), (t) => spec.fy(t, env), t0, t1, vp),
      };
    }
    case 'polar': {
      const th0 = spec.th0(env);
      const th1 = spec.th1(env);
      if (!(th1 > th0)) return { kind: 'nothing' };
      const k = spec.toRad;
      return {
        kind: 'segments',
        segments: sampleParametric(
          (th) => spec.fr(th, env) * Math.cos(th * k),
          (th) => spec.fr(th, env) * Math.sin(th * k),
          th0,
          th1,
          vp,
        ),
      };
    }
    case 'implicit':
      return { kind: 'segments', segments: contour((x, y) => spec.F(x, y, env), vp) };
    case 'region':
      return {
        kind: 'region',
        mask: regionMask((x, y) => spec.inside(x, y, env), vp),
        boundaries: spec.boundaries.map((b) => ({
          segments: contour((x, y) => b.F(x, y, env), vp),
          dashed: b.strict,
        })),
      };
    case 'points': {
      if (!spec.gate(env)) return { kind: 'nothing' };
      const pts: Array<[number, number]> = [];
      for (const p of spec.pts) {
        const wx = p.fx(env);
        const wy = p.fy(env);
        if (Number.isFinite(wx) && Number.isFinite(wy)) pts.push([wx, wy]);
      }
      return { kind: 'points', pts };
    }
    case 'vector': {
      if (!spec.gate(env)) return { kind: 'nothing' };
      const from: [number, number] = [spec.from.fx(env), spec.from.fy(env)];
      const to: [number, number] = [spec.to.fx(env), spec.to.fy(env)];
      if (!from.every(Number.isFinite) || !to.every(Number.isFinite)) {
        return { kind: 'nothing' };
      }
      return { kind: 'vector', from, to };
    }
    case 'field':
      return { kind: 'field' };
  }
}

function drawArtifact(
  ctx: CanvasRenderingContext2D,
  artifact: Artifact,
  item: PlottedCurve,
  vp: Viewport,
  env: Env,
): void {
  switch (artifact.kind) {
    case 'segments':
      drawCurve(ctx, artifact.segments, { color: item.color, widthPx: 2 });
      break;
    case 'region':
      drawRegion(ctx, artifact.mask, vp, item.color);
      for (const b of artifact.boundaries) {
        drawCurve(ctx, b.segments, {
          color: item.color,
          widthPx: 1.75,
          dash: b.dashed ? [6, 5] : undefined,
        });
      }
      break;
    case 'points':
      for (const [wx, wy] of artifact.pts) drawWorldPoint(ctx, vp, wx, wy, item.color);
      break;
    case 'vector':
      drawArrow(
        ctx,
        xToPx(vp, artifact.from[0]),
        yToPx(vp, artifact.from[1]),
        xToPx(vp, artifact.to[0]),
        yToPx(vp, artifact.to[1]),
        item.color,
        2,
      );
      break;
    case 'field': {
      const spec = item.spec as Extract<PlotSpec, { type: 'field' }>;
      drawVectorField(ctx, (x, y) => spec.P(x, y, env), (x, y) => spec.Q(x, y, env), vp, item.color);
      break;
    }
    case 'nothing':
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Overlay: POI markers/labels, click-inspect, drag handles            */
/* ------------------------------------------------------------------ */

const OVERLAY = {
  poi: '#e6e6ea',
  poiIntersection: '#f5e08a',
  poiDim: '#1b1d21',
  label: '#e6e6ea',
  labelBg: 'rgba(27, 29, 33, 0.82)',
  handle: '#8ab4f8',
  fontPx: 11,
  fontFamily: 'Inter, system-ui, sans-serif',
};

// Interaction thresholds (CSS px).
const HANDLE_HIT_PX = 12; // grab radius for a drag handle
const CLICK_TRAVEL_PX = 5; // max pointer travel still counted as a click
const SNAP_PX = 16; // click snaps to a POI within this
const CURVE_PICK_PX = 14; // else inspects a curve within this

function colorForCurve(curves: PlottedCurve[], id: number): string {
  return curves.find((c) => c.id === id)?.color ?? OVERLAY.poi;
}

/** Screen position of a drag point given the current slider env, or null. */
function dragPointScreen(point: DragPoint, env: Env, vp: Viewport): [number, number] | null {
  const wx = point.fx(env);
  const wy = point.fy(env);
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
  return [xToPx(vp, wx), yToPx(vp, wy)];
}

/** A coordinate label with a rounded translucent background, kept on-screen. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  px: number,
  py: number,
  vp: Viewport,
): void {
  ctx.font = `${OVERLAY.fontPx}px ${OVERLAY.fontFamily}`;
  const padX = 5;
  const padY = 3;
  const w = ctx.measureText(text).width + padX * 2;
  const h = OVERLAY.fontPx + padY * 2;
  // Prefer up-right of the marker; flip when it would clip the edge.
  let bx = px + 8;
  let by = py - h - 6;
  if (bx + w > vp.width) bx = px - w - 8;
  if (by < 0) by = py + 8;
  bx = Math.max(2, Math.min(bx, vp.width - w - 2));
  by = Math.max(2, Math.min(by, vp.height - h - 2));
  ctx.fillStyle = OVERLAY.labelBg;
  ctx.beginPath();
  const r = 4;
  ctx.moveTo(bx + r, by);
  ctx.arcTo(bx + w, by, bx + w, by + h, r);
  ctx.arcTo(bx + w, by + h, bx, by + h, r);
  ctx.arcTo(bx, by + h, bx, by, r);
  ctx.arcTo(bx, by, bx + w, by, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = OVERLAY.label;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + padX, by + h / 2 + 0.5);
}

function fmtCoord(x: number, y: number, precision: number): string {
  return `(${formatValue(x, precision)}, ${formatValue(y, precision)})`;
}

const POI_LABEL_NEAR_PX = 34;

/**
 * Special points as subtle dots always; a coordinate label only when it
 * won't clutter — intersections (few, meaningful) get one always; roots and
 * extrema reveal theirs when the cursor is near (Desmos-style), so a busy
 * curve like sin(x) isn't buried in permanent labels.
 */
function drawPois(
  ctx: CanvasRenderingContext2D,
  pois: Poi[],
  vp: Viewport,
  precision: number,
  hover: HoverState | null,
): void {
  for (const poi of pois) {
    const px = xToPx(vp, poi.x);
    const py = yToPx(vp, poi.y);
    if (px < -4 || px > vp.width + 4 || py < -4 || py > vp.height + 4) continue;
    const intersection = poi.kind === 'intersection';
    ctx.fillStyle = OVERLAY.poiDim;
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = intersection ? OVERLAY.poiIntersection : OVERLAY.poi;
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, 2 * Math.PI);
    ctx.fill();
    const near = hover !== null && Math.hypot(hover.sx - px, hover.sy - py) <= POI_LABEL_NEAR_PX;
    if (intersection || near) {
      const tag = poi.kind === 'min' ? 'min ' : poi.kind === 'max' ? 'max ' : '';
      drawLabel(ctx, `${tag}${fmtCoord(poi.x, poi.y, precision)}`, px, py, vp);
    }
  }
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
  spec: PlotSpec;
  artifact: Artifact;
}

interface PointerState {
  pointers: Map<number, { x: number; y: number }>;
  pinchDist: number;
  /** What the primary pointer is doing. */
  mode: 'pan' | 'dragPoint';
  dragTarget: DragPoint | null;
  /** Where the primary pointer went down + total travel, for click detection. */
  downX: number;
  downY: number;
  travel: number;
}

/** Pinned inspect marker (set by a click). */
interface InspectState {
  wx: number;
  wy: number;
  color: string;
}

/** Live hover readout: the snapped curve point plus the raw cursor position
 * (used to reveal nearby POI labels). */
interface HoverState {
  wx: number;
  wy: number;
  color: string;
  sx: number;
  sy: number;
}

/** Numerically invert fx(slider) = targetX by bisection over [min, max].
 * Falls back to nearest endpoint when the target is out of reach. */
function invertToSlider(point: DragPoint, env: Env, targetX: number): number | null {
  const at = (v: number): number => {
    const saved = env[point.name];
    env[point.name] = v;
    const out = point.fx(env);
    if (saved === undefined) delete env[point.name];
    else env[point.name] = saved;
    return out;
  };
  let lo = point.min;
  let hi = point.max;
  let flo = at(lo) - targetX;
  const fhi = at(hi) - targetX;
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return null;
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (flo * fhi > 0) {
    // Target beyond the path's reach: clamp to whichever end is closer.
    return Math.abs(flo) < Math.abs(fhi) ? lo : hi;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const fmid = at(mid) - targetX;
    if (!Number.isFinite(fmid)) return null;
    if (Math.abs(fmid) < 1e-12) return mid;
    if (flo * fmid <= 0) hi = mid;
    else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
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
  dragPoints: DragPoint[];
  precision: number;
  onDragSlider: (name: string, value: number, step: number) => void;
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

export function GraphCanvas({
  curves,
  env,
  dragPoints,
  precision,
  onDragSlider,
  onFrame,
}: Props): JSX.Element {
  // Four stacked canvases. The grid only changes on pan/zoom. Curves split
  // by what changed in this commit: curves that resampled draw on the
  // dynamic layer; unchanged curves stay rendered on the static layer, which
  // is only re-stroked when its membership changes. During a slider drag the
  // dependent curves cycle on the dynamic layer while everything else costs
  // nothing — that skip is what holds the M3 gate on software rasterizers.
  // The overlay (top) draws POI markers, inspect labels, and drag handles,
  // and owns the pointer events.
  const gridRef = useRef<HTMLCanvasElement | null>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const dynamicRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [pois, setPois] = useState<Poi[] | null>(null);
  const [inspect, setInspect] = useState<InspectState | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const pointerState = useRef<PointerState>({
    pointers: new Map(),
    pinchDist: 0,
    mode: 'pan',
    dragTarget: null,
    downX: 0,
    downY: 0,
    travel: 0,
  });
  const cacheRef = useRef<Map<number, CacheEntry>>(new Map());
  // Static layer contents as of its last redraw: ordered [id, artifact] pairs.
  const staticDrawnRef = useRef<Array<[number, Artifact]>>([]);

  // Fresh values for pointer handlers without re-binding them.
  const liveRef = useRef({ curves, env, dragPoints, viewport, pois });
  liveRef.current = { curves, env, dragPoints, viewport, pois };

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

    // Pass 1: resolve the artifact per item, partition changed vs unchanged.
    const cache = cacheRef.current;
    const seen = new Set<number>();
    const changed: Array<[PlottedCurve, Artifact]> = [];
    const unchanged: Array<[PlottedCurve, Artifact]> = [];
    for (const curve of curves) {
      seen.add(curve.id);
      const hit = cache.get(curve.id);
      if (
        hit !== undefined &&
        hit.vp === viewport &&
        hit.fingerprint === curve.fingerprint &&
        hit.spec === curve.spec
      ) {
        unchanged.push([curve, hit.artifact]);
      } else {
        const artifact = buildArtifact(curve.spec, viewport, env);
        cache.set(curve.id, { vp: viewport, fingerprint: curve.fingerprint, spec: curve.spec, artifact });
        changed.push([curve, artifact]);
      }
    }
    for (const id of cache.keys()) {
      if (!seen.has(id)) cache.delete(id);
    }

    // Pass 2: static layer — redraw only when its membership changed.
    const prev = staticDrawnRef.current;
    const sameStatic =
      prev.length === unchanged.length &&
      prev.every(([id, art], i) => unchanged[i][0].id === id && unchanged[i][1] === art);
    if (!sameStatic) {
      fitCanvas(staticCanvas, viewport, dpr);
      const sctx = staticCanvas.getContext('2d');
      if (sctx) {
        sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        sctx.clearRect(0, 0, viewport.width, viewport.height);
        for (const [curve, artifact] of unchanged) {
          drawArtifact(sctx, artifact, curve, viewport, env);
        }
      }
      staticDrawnRef.current = unchanged.map(([curve, art]) => [curve.id, art]);
    }

    // Pass 3: dynamic layer — the items that changed this commit.
    fitCanvas(dynamicCanvas, viewport, dpr);
    const dctx = dynamicCanvas.getContext('2d');
    if (dctx) {
      dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dctx.clearRect(0, 0, viewport.width, viewport.height);
      for (const [curve, artifact] of changed) {
        drawArtifact(dctx, artifact, curve, viewport, env);
      }
    }

    onFrame?.({
      frameMs: performance.now() - t0,
      resampled: changed.length,
      cached: unchanged.length,
    });
  }, [viewport, curves, env, onFrame]);

  // POI detection: debounced so a pan/zoom/slider-drag flurry recomputes
  // once things settle rather than every frame. Explicit curves only.
  useEffect(() => {
    if (!viewport) return;
    const handle = setTimeout(() => {
      const poiCurves: PoiCurve[] = [];
      for (const c of curves) {
        if (c.spec.type !== 'explicit') continue;
        const f = c.spec.f;
        poiCurves.push({
          id: c.id,
          f: (x) => f(x, env),
          fPrime: c.fPrime ? (x) => c.fPrime!(x, env) : undefined,
        });
      }
      setPois(poiCurves.length === 0 ? null : collectPois(poiCurves, viewport.xMin, viewport.xMax));
    }, 200);
    return () => clearTimeout(handle);
  }, [viewport, curves, env]);

  // Overlay layer: POI markers/labels, the inspect marker, and drag handles.
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !viewport) return;
    const dpr = window.devicePixelRatio || 1;
    fitCanvas(canvas, viewport, dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    if (pois) drawPois(ctx, pois, viewport, precision, hover);

    for (const point of dragPoints) {
      const screen = dragPointScreen(point, env, viewport);
      if (screen === null) continue;
      ctx.fillStyle = OVERLAY.poiDim;
      ctx.beginPath();
      ctx.arc(screen[0], screen[1], 7, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = OVERLAY.handle;
      ctx.beginPath();
      ctx.arc(screen[0], screen[1], 5, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Hover readout: a hollow ring tracking the curve under the cursor.
    if (hover && (!inspect || hover.wx !== inspect.wx || hover.wy !== inspect.wy)) {
      const px = xToPx(viewport, hover.wx);
      const py = yToPx(viewport, hover.wy);
      ctx.strokeStyle = hover.color;
      ctx.fillStyle = OVERLAY.poiDim;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
      drawLabel(ctx, fmtCoord(hover.wx, hover.wy, precision), px, py, viewport);
    }

    // Pinned inspect marker (filled).
    if (inspect) {
      const px = xToPx(viewport, inspect.wx);
      const py = yToPx(viewport, inspect.wy);
      ctx.fillStyle = inspect.color;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, 2 * Math.PI);
      ctx.fill();
      drawLabel(ctx, fmtCoord(inspect.wx, inspect.wy, precision), px, py, viewport);
    }
  }, [viewport, pois, dragPoints, env, inspect, hover, precision]);

  // Nearest curve point (snapping to a POI) under a screen position, or null.
  const pickNearest = useCallback((sx: number, sy: number): HoverState | null => {
    const { curves: liveCurves, env: liveEnv, viewport: vp, pois: livePois } = liveRef.current;
    if (!vp) return null;
    let best: HoverState | null = null;
    let bestDist = SNAP_PX;
    for (const poi of livePois ?? []) {
      const d = Math.hypot(xToPx(vp, poi.x) - sx, yToPx(vp, poi.y) - sy);
      if (d < bestDist) {
        best = { wx: poi.x, wy: poi.y, color: colorForCurve(liveCurves, poi.curveIds[0]), sx, sy };
        bestDist = d;
      }
    }
    if (best === null) {
      bestDist = CURVE_PICK_PX;
      const wx = pxToX(vp, sx);
      for (const c of liveCurves) {
        if (c.spec.type !== 'explicit') continue;
        const wy = c.spec.f(wx, liveEnv);
        if (!Number.isFinite(wy)) continue;
        const d = Math.abs(yToPx(vp, wy) - sy);
        if (d < bestDist) {
          best = { wx, wy, color: c.color, sx, sy };
          bestDist = d;
        }
      }
    }
    return best;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // A synthetic/uncaptured pointer id throws here; don't let that abort the
    // handler (breaks click + drag).
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer to capture — fine */
    }
    setHover(null); // hide the hover readout while interacting
    const st = pointerState.current;
    const pos = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    st.pointers.set(e.pointerId, pos);
    if (st.pointers.size === 2) {
      const [a, b] = [...st.pointers.values()];
      st.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      return;
    }
    // Primary pointer down: decide drag-a-point vs pan by hit-testing handles.
    st.downX = pos.x;
    st.downY = pos.y;
    st.travel = 0;
    st.mode = 'pan';
    st.dragTarget = null;
    const { dragPoints: dps, env: liveEnv, viewport: vp } = liveRef.current;
    if (vp) {
      for (const point of dps) {
        const screen = dragPointScreen(point, liveEnv, vp);
        if (screen && Math.hypot(screen[0] - pos.x, screen[1] - pos.y) <= HANDLE_HIT_PX) {
          st.mode = 'dragPoint';
          st.dragTarget = point;
          break;
        }
      }
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = pointerState.current;
    const prev = st.pointers.get(e.pointerId);
    const pos = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };

    // No button down → hover: show the live value readout under the cursor.
    if (!prev) {
      if (st.pointers.size === 0) setHover(pickNearest(pos.x, pos.y));
      return;
    }
    st.pointers.set(e.pointerId, pos);

    if (st.pointers.size === 2) {
      const [a, b] = [...st.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (st.pinchDist > 0 && dist > 0) {
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const factor = st.pinchDist / dist;
        setViewport((vp) => (vp ? zoomAt(vp, midX, midY, factor) : vp));
      }
      st.pinchDist = dist;
      return;
    }

    st.travel += Math.hypot(pos.x - prev.x, pos.y - prev.y);

    if (st.mode === 'dragPoint' && st.dragTarget) {
      const { env: liveEnv, viewport: vp } = liveRef.current;
      if (!vp) return;
      const targetX = pxToX(vp, pos.x);
      const raw = invertToSlider(st.dragTarget, liveEnv, targetX);
      if (raw !== null) {
        const step = st.dragTarget.step || 0.001;
        const snapped = Math.min(
          st.dragTarget.max,
          Math.max(st.dragTarget.min, Math.round(raw / step) * step),
        );
        onDragSlider(st.dragTarget.name, snapped, step);
      }
      return;
    }

    setViewport((vp) => (vp ? pan(vp, pos.x - prev.x, pos.y - prev.y) : vp));
  }, [onDragSlider, pickNearest]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = pointerState.current;
    const wasPrimary = st.pointers.has(e.pointerId) && st.pointers.size === 1;
    st.pointers.delete(e.pointerId);
    st.pinchDist = 0;
    if (!wasPrimary || st.mode !== 'pan' || st.travel > CLICK_TRAVEL_PX) return;

    // A click (not a drag) pins the nearest curve point as an inspect marker.
    const near = pickNearest(st.downX, st.downY);
    setInspect(near ? { wx: near.wx, wy: near.wy, color: near.color } : null);
  }, [pickNearest]);

  const onPointerLeave = useCallback(() => {
    if (pointerState.current.pointers.size === 0) setHover(null);
  }, []);

  // Wheel zoom, centered on the cursor. Native listener: React's onWheel is
  // passive, so preventDefault (needed to stop page scroll) wouldn't work.
  useEffect(() => {
    const canvas = overlayRef.current;
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
      <canvas ref={dynamicRef} className="graph-canvas graph-grid-layer" />
      <canvas
        ref={overlayRef}
        className="graph-canvas graph-curves-layer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
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
