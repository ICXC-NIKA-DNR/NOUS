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
import {
  analyzeCurves,
  type AnalyzedCurve,
  type Coincidence,
  type ExactOrApprox,
  type Feature,
} from '../plot/analysis.ts';
import { contour, regionMask, type RegionMask } from '../plot/implicit.ts';
import { buildSvg, type SvgElement } from '../plot/exportSvg.ts';
import { exportBaseName } from './exportName.ts';
import { drawArrow, drawVectorField, drawWorldPoint, sampleFieldArrows } from '../plot/marks.ts';
import { filePlatform } from '../platform/files.ts';
import { sampleParametric } from '../plot/parametric.ts';
import { drawCurve, drawGrid, drawRegion, type Theme } from '../plot/render.ts';
import { toSource } from './toSource.ts';
import { sampleCurve, type Segment } from '../plot/sampler.ts';
import { numericSlope, traceAt, type TracePoint } from '../plot/trace.ts';
import {
  defaultViewport,
  pan,
  pxToX,
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
const CURVE_PICK_PX = 14; // trace snaps to a curve within this vertical distance

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

/** A multi-line tooltip anchored near (px, py), kept on-screen. Used for the
 * trace readout (coordinates + slope, or a discontinuity label). */
function drawTooltip(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  px: number,
  py: number,
  vp: Viewport,
): void {
  ctx.font = `${OVERLAY.fontPx}px ${OVERLAY.fontFamily}`;
  const padX = 6;
  const padY = 4;
  const lineH = OVERLAY.fontPx + 3;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const h = lines.length * lineH + padY * 2 - 3;
  let bx = px + 10;
  let by = py - h - 8;
  if (bx + w > vp.width) bx = px - w - 10;
  if (by < 0) by = py + 10;
  bx = Math.max(2, Math.min(bx, vp.width - w - 2));
  by = Math.max(2, Math.min(by, vp.height - h - 2));
  ctx.fillStyle = OVERLAY.labelBg;
  const r = 5;
  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.arcTo(bx + w, by, bx + w, by + h, r);
  ctx.arcTo(bx + w, by + h, bx, by + h, r);
  ctx.arcTo(bx, by + h, bx, by, r);
  ctx.arcTo(bx, by, bx + w, by, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = OVERLAY.label;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, bx + padX, by + padY + i * lineH));
}

/** Human-readable tooltip lines for a traced point. */
function traceTooltipLines(tp: TracePoint, precision: number): string[] {
  switch (tp.kind) {
    case 'point':
      return [
        fmtCoord(tp.x, tp.y, precision),
        `slope ${formatValue(tp.slope, precision)}`,
      ];
    case 'hole':
      return [
        `x = ${formatValue(tp.x, precision)}`,
        'removable hole',
        tp.limit !== undefined ? `limit → ${formatValue(tp.limit, precision)}` : 'no limit',
      ];
    case 'jump':
      return [`x = ${formatValue(tp.x, precision)}`, 'jump discontinuity'];
    case 'asymptote':
      return [`x = ${formatValue(tp.x, precision)}`, 'vertical asymptote'];
    case 'boundary':
      return [`x = ${formatValue(tp.x, precision)}`, 'domain boundary'];
    case 'none':
      return [`x = ${formatValue(tp.x, precision)}`, 'undefined'];
  }
}

/** Draw a trace: a marker appropriate to the point's kind plus its tooltip.
 * `pinned` fills the marker (persisted) vs a hollow ring (live). */
function drawTrace(
  ctx: CanvasRenderingContext2D,
  trace: TraceState,
  vp: Viewport,
  precision: number,
  pinned: boolean,
): void {
  const tp = trace.point;
  const px = xToPx(vp, tp.x);
  const lines = traceTooltipLines(tp, precision);

  if (tp.kind === 'point') {
    const py = yToPx(vp, tp.y);
    ctx.fillStyle = pinned ? trace.color : OVERLAY.poiDim;
    ctx.strokeStyle = trace.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, 2 * Math.PI);
    ctx.fill();
    if (!pinned) ctx.stroke();
    drawTooltip(ctx, lines, px, py, vp);
    return;
  }

  // A break in the curve: draw a distinct indicator rather than a value point.
  if (tp.kind === 'asymptote') {
    ctx.strokeStyle = trace.color;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, vp.height);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (tp.kind === 'hole' && tp.limit !== undefined) {
    // Hollow ring at the missing value — the classic "open dot".
    const py = yToPx(vp, tp.limit);
    ctx.strokeStyle = trace.color;
    ctx.fillStyle = OVERLAY.poiDim;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  } else {
    // jump / boundary / none: an × at the cursor height.
    ctx.strokeStyle = trace.color;
    ctx.lineWidth = 2;
    const s = 5;
    ctx.beginPath();
    ctx.moveTo(px - s, trace.sy - s);
    ctx.lineTo(px + s, trace.sy + s);
    ctx.moveTo(px + s, trace.sy - s);
    ctx.lineTo(px - s, trace.sy + s);
    ctx.stroke();
  }
  drawTooltip(ctx, lines, px, trace.sy, vp);
}

/** Plain numeric coordinate, e.g. hover/trace readouts where the value is a
 * numeric evaluation. The caller decides whether to prefix ≈. */
function fmtCoord(x: number, y: number, precision: number): string {
  return `(${formatValue(x, precision)}, ${formatValue(y, precision)})`;
}

/** Light prettify for compact symbolic labels on the canvas. */
function prettySymbol(src: string): string {
  return src.replace(/sqrt\(/g, '√(').replace(/\bpi\b/g, 'π').replace(/\*/g, '·');
}

/** One coordinate of a feature: its compact symbolic form when exact and
 * short, else its decimal. Never adds ≈ — the point formatter does that. */
function fmtScalar(v: ExactOrApprox, precision: number): string {
  if (v.exact) {
    const sym = prettySymbol(toSource(v.expr));
    return sym.length <= 12 ? sym : formatValue(v.value, precision);
  }
  return formatValue(v.value, precision);
}

/** A feature's coordinate label. Exact points render clean (0, 0); a point
 * with any approximate coordinate wears the ≈ it earned. */
function fmtFeature(f: Feature, precision: number): string {
  const inner = `(${fmtScalar(f.x, precision)}, ${fmtScalar(f.y, precision)})`;
  return f.x.exact && f.y.exact ? inner : `≈ ${inner}`;
}

const FEATURE_LABEL_NEAR_PX = 34;

/**
 * Mathematically-detected features as subtle dots; a coordinate label only
 * where it won't clutter — intersections (few, meaningful) always; roots and
 * extrema reveal theirs on cursor proximity, so a busy curve like sin(x)
 * isn't buried in permanent labels.
 */
function drawFeatures(
  ctx: CanvasRenderingContext2D,
  features: Feature[],
  vp: Viewport,
  precision: number,
  hoverScreen: readonly [number, number] | null,
): void {
  for (const feature of features) {
    const px = xToPx(vp, feature.x.value);
    const py = yToPx(vp, feature.y.value);
    if (px < -4 || px > vp.width + 4 || py < -4 || py > vp.height + 4) continue;
    const intersection = feature.kind === 'intersection';
    ctx.fillStyle = OVERLAY.poiDim;
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = intersection ? OVERLAY.poiIntersection : OVERLAY.poi;
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, 2 * Math.PI);
    ctx.fill();
    const near =
      hoverScreen !== null &&
      Math.hypot(hoverScreen[0] - px, hoverScreen[1] - py) <= FEATURE_LABEL_NEAR_PX;
    if (intersection || near) {
      const tag = feature.kind === 'min' ? 'min ' : feature.kind === 'max' ? 'max ' : '';
      drawLabel(ctx, `${tag}${fmtFeature(feature, precision)}`, px, py, vp);
    }
  }
}

/** App background (styles.css --bg) — canvas/SVG can't read CSS variables. */
const BACKGROUND = '#1b1d21';

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
  mode: 'pan' | 'dragPoint' | 'trace';
  dragTarget: DragPoint | null;
  /** The curve id being traced in 'trace' mode. */
  traceCurveId: number | null;
  /** Where the primary pointer went down + total travel, for click detection. */
  downX: number;
  downY: number;
  travel: number;
}

export type SlopeMode = 'numeric' | 'exact';

/**
 * A trace readout on a curve: the classified point (value/slope, or a
 * hole/asymptote/boundary break) plus the owning curve's identity. Used both
 * for the live trace under the cursor and the pinned one after release.
 */
interface TraceState {
  curveId: number;
  color: string;
  point: TracePoint;
  /** Raw cursor screen position — anchors the tooltip and feature proximity. */
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
  /** Seed viewport (document tabs restore their own view on remount); the
   * mount-time measure() re-fits it to the current container size. */
  initialViewport?: Viewport | null;
  /** Populated with imperative view controls (keyboard shortcuts, M9.3). */
  apiRef?: React.MutableRefObject<GraphApi | null>;
  /** Reports every viewport change. NOTE: fires per pan/zoom frame — store in
   * a ref, not state, or the whole app re-renders at pointer rate. */
  onViewportChange?: (viewport: Viewport) => void;
  /** Current active-tab name, read at export time to name PNG/SVG files. */
  getExportName?: () => string;
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

/** Imperative view controls exposed to the app-level keyboard handler —
 * same zoom/reset code paths the wheel and buttons use. */
export interface GraphApi {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
}

export function GraphCanvas({
  curves,
  env,
  dragPoints,
  precision,
  onDragSlider,
  onFrame,
  initialViewport,
  onViewportChange,
  apiRef,
  getExportName,
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
  const [viewport, setViewport] = useState<Viewport | null>(initialViewport ?? null);

  // Report viewport changes upward (per-tab view persistence). The unmount
  // flush covers a change made in the same commit as a tab switch, where the
  // per-change effect would never get to run.
  const reportRef = useRef({ viewport, onViewportChange });
  reportRef.current = { viewport, onViewportChange };
  useEffect(() => {
    if (viewport && onViewportChange) onViewportChange(viewport);
  }, [viewport, onViewportChange]);
  useEffect(
    () => () => {
      const { viewport: vp, onViewportChange: report } = reportRef.current;
      if (vp && report) report(vp);
    },
    [],
  );
  const [showGrid, setShowGrid] = useState(true);
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [coincidences, setCoincidences] = useState<Coincidence[]>([]);
  // The live trace under the cursor, and the one pinned after release.
  const [activeTrace, setActiveTrace] = useState<TraceState | null>(null);
  const [pinnedTrace, setPinnedTrace] = useState<TraceState | null>(null);
  const [slopeMode, setSlopeMode] = useState<SlopeMode>('numeric');
  const pointerState = useRef<PointerState>({
    pointers: new Map(),
    pinchDist: 0,
    mode: 'pan',
    dragTarget: null,
    traceCurveId: null,
    downX: 0,
    downY: 0,
    travel: 0,
  });
  const cacheRef = useRef<Map<number, CacheEntry>>(new Map());
  // Static layer contents as of its last redraw: ordered [id, artifact] pairs.
  const staticDrawnRef = useRef<Array<[number, Artifact]>>([]);

  // Fresh values for pointer handlers without re-binding them.
  const liveRef = useRef({ curves, env, viewport, dragPoints, slopeMode });
  liveRef.current = { curves, env, viewport, dragPoints, slopeMode };

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

  // Feature detection runs through the graph analysis layer (symbolic-first),
  // debounced so a pan/zoom/slider-drag flurry recomputes once things settle
  // rather than every frame. Explicit curves only.
  useEffect(() => {
    if (!viewport) return;
    const handle = setTimeout(() => {
      const analyzed: AnalyzedCurve[] = [];
      for (const c of curves) {
        if (c.spec.type !== 'explicit') continue;
        const f = c.spec.f;
        analyzed.push({
          id: c.id,
          body: c.spec.body,
          f: (x) => f(x, env),
          fPrime: c.fPrime ? (x) => c.fPrime!(x, env) : undefined,
        });
      }
      if (analyzed.length === 0) {
        setFeatures(null);
        setCoincidences([]);
        return;
      }
      const result = analyzeCurves(analyzed, viewport.xMin, viewport.xMax);
      setFeatures(result.features.length === 0 ? null : result.features);
      setCoincidences(result.coincidences);
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

    const hoverScreen: [number, number] | null = activeTrace
      ? [activeTrace.sx, activeTrace.sy]
      : null;
    if (features) drawFeatures(ctx, features, viewport, precision, hoverScreen);

    // Coincident curves get a badge, not a field of false intersection dots.
    if (coincidences.length > 0) {
      ctx.font = `12px ${OVERLAY.fontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      coincidences.forEach((c, i) => {
        const y = 10 + i * 18;
        ctx.fillStyle = colorForCurve(curves, c.curveIds[0]);
        ctx.beginPath();
        ctx.arc(16, y + 6, 4, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = OVERLAY.label;
        ctx.fillText('identical graphs — infinitely many shared points', 26, y);
      });
    }

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

    // The pinned trace draws underneath the live one.
    if (pinnedTrace) drawTrace(ctx, pinnedTrace, viewport, precision, true);
    if (activeTrace) drawTrace(ctx, activeTrace, viewport, precision, false);
  }, [viewport, features, coincidences, curves, dragPoints, env, pinnedTrace, activeTrace, precision]);

  // Trace a curve at a screen position and classify the point (value/slope,
  // or a break) with the current slope mode. When `lockedId` is given, that
  // curve is traced at the cursor's x regardless of proximity — so a drag
  // across an asymptote or domain gap keeps reporting the SAME curve (and its
  // 'asymptote'/'hole' label) rather than silently dropping the trace. With
  // no lock, the nearest curve within the pick threshold is chosen (hover /
  // initial press). Returns null when nothing applies.
  const traceCurveAt = useCallback(
    (sx: number, sy: number, lockedId?: number): TraceState | null => {
      const { curves: liveCurves, env: liveEnv, viewport: vp, slopeMode: mode } = liveRef.current;
      if (!vp) return null;
      const wx = pxToX(vp, sx);

      type Picked = {
        id: number;
        color: string;
        f: (x: number) => number;
        fPrime?: (x: number) => number;
      };
      const asPicked = (c: PlottedCurve): Picked | null => {
        if (c.spec.type !== 'explicit') return null;
        const f = c.spec.f;
        return {
          id: c.id,
          color: c.color,
          f: (x) => f(x, liveEnv),
          fPrime: c.fPrime ? (x) => c.fPrime!(x, liveEnv) : undefined,
        };
      };

      let picked: Picked | null = null;
      if (lockedId !== undefined) {
        const c = liveCurves.find((cur) => cur.id === lockedId);
        picked = c ? asPicked(c) : null;
      } else {
        let bestDist = CURVE_PICK_PX;
        for (const c of liveCurves) {
          if (c.spec.type !== 'explicit') continue;
          const wy = c.spec.f(wx, liveEnv);
          if (!Number.isFinite(wy)) continue;
          const d = Math.abs(yToPx(vp, wy) - sy);
          if (d < bestDist) {
            bestDist = d;
            picked = asPicked(c);
          }
        }
      }
      if (picked === null) return null;

      const point = traceAt(picked.f, wx, vp.xMax - vp.xMin);
      if (point.kind === 'point') {
        // Exact slope on request when the CAS derivative is available, else
        // the fast numeric central difference.
        point.slope =
          mode === 'exact' && picked.fPrime && Number.isFinite(picked.fPrime(wx))
            ? picked.fPrime(wx)
            : numericSlope(picked.f, wx, vp.xMax - vp.xMin);
      }
      return { curveId: picked.id, color: picked.color, point, sx, sy };
    },
    [],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // A synthetic/uncaptured pointer id throws here; don't let that abort the
    // handler (breaks click + drag).
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer to capture — fine */
    }
    const st = pointerState.current;
    const pos = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    st.pointers.set(e.pointerId, pos);
    if (st.pointers.size === 2) {
      const [a, b] = [...st.pointers.values()];
      st.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      return;
    }
    // Primary pointer down: drag-a-point, trace-a-curve, or pan — in that
    // priority. Handles win over curves so a point on its curve stays draggable.
    st.downX = pos.x;
    st.downY = pos.y;
    st.travel = 0;
    st.mode = 'pan';
    st.dragTarget = null;
    st.traceCurveId = null;
    const { dragPoints: dps, env: liveEnv, viewport: vp } = liveRef.current;
    if (vp) {
      for (const point of dps) {
        const screen = dragPointScreen(point, liveEnv, vp);
        if (screen && Math.hypot(screen[0] - pos.x, screen[1] - pos.y) <= HANDLE_HIT_PX) {
          st.mode = 'dragPoint';
          st.dragTarget = point;
          return;
        }
      }
    }
    const trace = traceCurveAt(pos.x, pos.y);
    if (trace) {
      st.mode = 'trace';
      st.traceCurveId = trace.curveId;
      setActiveTrace(trace);
    } else {
      setActiveTrace(null);
    }
  }, [traceCurveAt]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = pointerState.current;
    const prev = st.pointers.get(e.pointerId);
    const pos = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };

    // No button down → hover: show the live trace readout under the cursor.
    if (!prev) {
      if (st.pointers.size === 0) setActiveTrace(traceCurveAt(pos.x, pos.y));
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

    if (st.mode === 'trace') {
      // Stay locked to the grabbed curve and evaluate at the cursor's x, so
      // moving across a gap (asymptote/domain edge) shows that break's label
      // and the point jumps cleanly to the next valid section past it.
      setActiveTrace(traceCurveAt(pos.x, pos.y, st.traceCurveId ?? undefined));
      return;
    }

    setViewport((vp) => (vp ? pan(vp, pos.x - prev.x, pos.y - prev.y) : vp));
  }, [onDragSlider, traceCurveAt]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = pointerState.current;
    const wasPrimary = st.pointers.has(e.pointerId) && st.pointers.size === 1;
    st.pointers.delete(e.pointerId);
    st.pinchDist = 0;
    if (!wasPrimary) return;
    const pos = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };

    if (st.mode === 'trace') {
      // Release pins the trace where the pointer let go; the live readout
      // clears until the next hover.
      setPinnedTrace(traceCurveAt(pos.x, pos.y, st.traceCurveId ?? undefined));
      setActiveTrace(null);
      return;
    }

    // A pan that didn't move is a click: on a curve it pins a trace, on empty
    // canvas it clears the pinned one.
    if (st.mode === 'pan' && st.travel <= CLICK_TRAVEL_PX) {
      const trace = traceCurveAt(st.downX, st.downY);
      setPinnedTrace(trace); // null when clicking empty space → clears
    }
  }, [traceCurveAt]);

  const onPointerLeave = useCallback(() => {
    if (pointerState.current.pointers.size === 0) setActiveTrace(null);
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

  // Keyboard zoom (M9.3): centered, same zoomAt the wheel uses.
  const zoomCentered = useCallback((factor: number): void => {
    setViewport((vp) => (vp ? zoomAt(vp, vp.width / 2, vp.height / 2, factor) : vp));
  }, []);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      zoomIn: () => zoomCentered(1 / 1.25),
      zoomOut: () => zoomCentered(1.25),
      resetView,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, zoomCentered, resetView]);

  /* ---- export (M8.4) ---- */

  // PNG: composite the already-rendered layers (grid, static, dynamic,
  // overlay — so pinned trace labels export too) over the app background.
  const exportPng = useCallback((): void => {
    const layers = [gridRef.current, staticRef.current, dynamicRef.current, overlayRef.current];
    const base = layers[0];
    if (!base || layers.some((c) => !c)) return;
    const out = document.createElement('canvas');
    out.width = base.width;
    out.height = base.height;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, out.width, out.height);
    for (const layer of layers) ctx.drawImage(layer!, 0, 0);
    const filename = `${exportBaseName(getExportName?.() ?? '')}.png`;
    out.toBlob((blob) => {
      if (!blob) return;
      blob.arrayBuffer().then((buf) => {
        filePlatform.saveExport(new Uint8Array(buf), filename, 'png', 'image/png').catch(() => {});
      });
    }, 'image/png');
  }, [getExportName]);

  // SVG: re-drive the same sampling engines into vector paths.
  const exportSvg = useCallback((): void => {
    const { curves: cs, env: e, viewport: vp } = liveRef.current;
    if (!vp) return;
    const elements: SvgElement[] = [];
    for (const curve of cs) {
      const artifact = buildArtifact(curve.spec, vp, e);
      switch (artifact.kind) {
        case 'segments':
          elements.push({ kind: 'path', color: curve.color, widthPx: 2, segments: artifact.segments });
          break;
        case 'region':
          // Region fills are raster-only (see exportSvg.ts); boundaries export.
          for (const b of artifact.boundaries) {
            elements.push({
              kind: 'path',
              color: curve.color,
              widthPx: 1.75,
              dash: b.dashed ? [6, 5] : undefined,
              segments: b.segments,
            });
          }
          break;
        case 'points':
          for (const [wx, wy] of artifact.pts) {
            elements.push({ kind: 'point', color: curve.color, px: xToPx(vp, wx), py: yToPx(vp, wy) });
          }
          break;
        case 'vector':
          elements.push({
            kind: 'arrow',
            color: curve.color,
            x0: xToPx(vp, artifact.from[0]),
            y0: yToPx(vp, artifact.from[1]),
            x1: xToPx(vp, artifact.to[0]),
            y1: yToPx(vp, artifact.to[1]),
            widthPx: 2,
          });
          break;
        case 'field': {
          const spec = curve.spec as Extract<PlotSpec, { type: 'field' }>;
          for (const a of sampleFieldArrows((x, y) => spec.P(x, y, e), (x, y) => spec.Q(x, y, e), vp)) {
            elements.push({ kind: 'arrow', color: curve.color, ...a, widthPx: 1.5 });
          }
          break;
        }
        case 'nothing':
          break;
      }
    }
    const svg = buildSvg(vp, THEME, BACKGROUND, elements, { grid: showGrid });
    const filename = `${exportBaseName(getExportName?.() ?? '')}.svg`;
    filePlatform.saveExport(svg, filename, 'svg', 'image/svg+xml').catch(() => {});
  }, [showGrid, getExportName]);

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
        <button
          type="button"
          className="slope-toggle"
          title={
            slopeMode === 'exact'
              ? 'Trace slope: exact (CAS derivative). Click for numeric.'
              : 'Trace slope: numeric. Click for exact (CAS derivative).'
          }
          aria-pressed={slopeMode === 'exact'}
          onClick={() => setSlopeMode((m) => (m === 'numeric' ? 'exact' : 'numeric'))}
        >
          {slopeMode === 'exact' ? 'd/dx' : 'Δ'}
        </button>
        <button type="button" title="Reset view" onClick={resetView}>
          ⌂
        </button>
        <button type="button" title="Export view as PNG" onClick={exportPng}>
          PNG
        </button>
        <button type="button" title="Export view as SVG (vector)" onClick={exportSvg}>
          SVG
        </button>
      </div>
    </div>
  );
}
