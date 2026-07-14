// Slider animation (Slider-Anim-M1): ▶ playback math for slider rows.
// Pure TypeScript — no DOM, no React — the rAF loop in App.tsx calls in here
// each frame and node:test covers the math in isolation.
//
// Semantics: one cycle = one full min → max → min sweep, a triangle wave in
// phase ∈ [0, 1): position rises to max at phase 0.5 and returns to min at 1,
// where the phase wraps and the next upward sweep begins (position is
// continuous through the wrap). Speed is a unitless multiplier on the base
// cycle rate; phase advances by Euler integration each frame so a variable
// multiplier (Slider-Anim-M2 speed curves) integrates correctly over real
// elapsed time — position over time is NOT a closed form once speed varies.

/** Full min→max→min cycle duration at 1× speed. */
export const BASE_CYCLE_MS = 8000;

/** Speed multiplier bounds. The range is log-centered on 1× (√(0.25·4) = 1),
 * which is also why the M2 curve editor's y-axis is log-scaled. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/** Per-frame delta cap: a tab suspend or GC stall pauses the animation for
 * the excess time instead of teleporting the phase in one giant Euler step. */
export const MAX_FRAME_DELTA_MS = 100;

export function clampSpeed(v: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
}

/** Triangle wave: phase ∈ [0, 1) → position fraction ∈ [0, 1]. */
export function trianglePosition(phase: number): number {
  const p = phase - Math.floor(phase);
  return p < 0.5 ? 2 * p : 2 - 2 * p;
}

export function sliderValueAt(phase: number, min: number, max: number): number {
  if (!(max > min)) return min;
  return min + (max - min) * trianglePosition(phase);
}

/** Inverse of sliderValueAt on the ascending branch: the phase to resume from
 * so pressing ▶ continues from the slider's current position. */
export function phaseFromValue(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  const f = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return f / 2;
}

/** One Euler step: advance phase by elapsed real time × the instantaneous
 * multiplier at the current phase, wrapping at 1. `multiplierAt` is a
 * constant for flat speed or the M2 spline; its result is clamped to the
 * legal speed range either way. */
export function advancePhase(
  phase: number,
  deltaMs: number,
  multiplierAt: (phase: number) => number,
): number {
  const dt = Math.min(Math.max(deltaMs, 0), MAX_FRAME_DELTA_MS);
  const next = phase + (dt / BASE_CYCLE_MS) * clampSpeed(multiplierAt(phase));
  return next - Math.floor(next);
}

/** Format a slider value with just enough decimals for its step. */
export function formatSliderValue(value: number, step: number): string {
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
  const s = value.toFixed(decimals);
  return s === '-0' ? '0' : s;
}

/* ------------------------------------------------------------------ */
/* Speed curves (Slider-Anim-M2)                                       */
/* ------------------------------------------------------------------ */
//
// A per-slider speed ramp: up to MAX_CURVE_NODES control points over one
// cycle (phase 0–1), interpolated with a monotone cubic Hermite spline
// (Fritsch–Carlson / PCHIP) in log₂(multiplier) space. Log space matches the
// editor's log-scaled y-axis (1× is the log-midpoint of 0.25×–4×) and
// guarantees positivity; the monotone tangents guarantee the curve never
// overshoots outside the band its own nodes span — no post-clamp kinks.
//
// The seam (phase 1 wrapping to 0) is a per-slider choice:
//   'smooth' — periodic: the segment after the last node lands on node 0's
//              value at phase 1 with matching tangents, so instantaneous
//              speed is continuous across cycles.
//   'hard'   — the last node's value holds flat to phase 1, then speed jumps
//              to node 0's value as the next cycle starts (video-editor
//              speed-ramp behavior; position is continuous either way).

export interface CurveNode {
  /** 0–1 through one min→max→min cycle. curveNodes[0].phase is always 0. */
  phase: number;
  /** Instantaneous speed multiplier, SPEED_MIN–SPEED_MAX. */
  multiplier: number;
}

export type LoopSeam = 'smooth' | 'hard';

export const MAX_CURVE_NODES = 5;

/** Minimum phase gap enforced between neighboring nodes (and the cycle end),
 * so drags can't create zero-width spline segments. */
export const MIN_NODE_GAP = 0.02;

/** Fritsch–Carlson tangent at a knot between two segments. Zero when the
 * slopes disagree in sign (or either is flat); otherwise the weighted
 * harmonic mean, which keeps every Hermite segment monotone. */
function fcTangent(dLeft: number, dRight: number, hLeft: number, hRight: number): number {
  if (dLeft * dRight <= 0) return 0;
  const w1 = 2 * hRight + hLeft;
  const w2 = hRight + 2 * hLeft;
  return (w1 + w2) / (w1 / dLeft + w2 / dRight);
}

/**
 * Build an evaluator for the spline: phase ∈ [0, 1) → multiplier. Prepared
 * once per frame (or per redraw) and evaluated at any phase; defensive about
 * malformed node lists (unsorted input is handled by the editor/parser —
 * here zero-width segments are simply skipped).
 */
export function prepareCurve(nodes: CurveNode[], seam: LoopSeam): (phase: number) => number {
  if (nodes.length === 0) return () => 1;
  const xs: number[] = [];
  const ys: number[] = []; // log₂(multiplier)
  for (const n of nodes) {
    const x = Math.min(1, Math.max(0, n.phase));
    if (xs.length > 0 && x - xs[xs.length - 1] < 1e-9) continue; // zero-width
    xs.push(x);
    ys.push(Math.log2(clampSpeed(n.multiplier)));
  }
  // End knot at phase 1: node 0's value (smooth seam) or a flat hold (hard).
  const periodic = seam === 'smooth' && 1 - xs[xs.length - 1] >= 1e-9;
  if (1 - xs[xs.length - 1] >= 1e-9) {
    xs.push(1);
    ys.push(periodic ? ys[0] : ys[ys.length - 1]);
  }
  const n = xs.length;
  if (n === 1) {
    const constant = 2 ** ys[0];
    return () => constant;
  }
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m: number[] = new Array(n);
  for (let i = 1; i < n - 1; i++) m[i] = fcTangent(d[i - 1], d[i], h[i - 1], h[i]);
  if (periodic) {
    // The seam segment (last → end knot) is node 0's left neighbor one cycle
    // earlier; the end knot IS node 0, so both share the periodic tangent.
    m[0] = fcTangent(d[n - 2], d[0], h[n - 2], h[0]);
    m[n - 1] = m[0];
  } else {
    m[0] = d[0];
    m[n - 1] = d[n - 2];
  }
  return (phase: number): number => {
    const p = Math.min(1, Math.max(0, phase - Math.floor(phase)));
    let i = 0;
    while (i < n - 2 && p > xs[i + 1]) i++;
    const t = (p - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h[i] * m[i + 1];
    return clampSpeed(2 ** y);
  };
}

/** Default curve: one anchor node — equivalent to the flat speed. */
export function defaultCurveNodes(speed = 1): CurveNode[] {
  return [{ phase: 0, multiplier: clampSpeed(speed) }];
}

/** Add a node at the midpoint of the widest phase gap (the span from the
 * last node to 1.0 counts), at the curve's current value there — so adding
 * a node barely changes the shape. Capped at MAX_CURVE_NODES. */
export function addCurveNode(nodes: CurveNode[], seam: LoopSeam): CurveNode[] {
  if (nodes.length === 0) return defaultCurveNodes();
  if (nodes.length >= MAX_CURVE_NODES) return nodes;
  let gapStart = 0;
  let gapWidth = -1;
  for (let i = 0; i < nodes.length; i++) {
    const end = i + 1 < nodes.length ? nodes[i + 1].phase : 1;
    if (end - nodes[i].phase > gapWidth) {
      gapWidth = end - nodes[i].phase;
      gapStart = nodes[i].phase;
    }
  }
  const phase = gapStart + gapWidth / 2;
  const multiplier = prepareCurve(nodes, seam)(phase);
  const out = nodes.slice();
  const at = out.findIndex((node) => node.phase > phase);
  out.splice(at === -1 ? out.length : at, 0, { phase, multiplier });
  return out;
}

/** Remove the highest-phase node. Node 0 (the anchor) is never removed. */
export function removeCurveNode(nodes: CurveNode[]): CurveNode[] {
  return nodes.length > 1 ? nodes.slice(0, -1) : nodes;
}

/** Move a node: multiplier clamps to the speed range; phase clamps between
 * its neighbors (with MIN_NODE_GAP) so nodes stay sorted and never cross.
 * Node 0's phase is pinned at 0 — it only moves vertically. */
export function moveCurveNode(
  nodes: CurveNode[],
  index: number,
  phase: number,
  multiplier: number,
): CurveNode[] {
  if (index < 0 || index >= nodes.length) return nodes;
  const out = nodes.slice();
  const m = clampSpeed(multiplier);
  if (index === 0) {
    out[0] = { phase: 0, multiplier: m };
    return out;
  }
  const lo = out[index - 1].phase + MIN_NODE_GAP;
  const hi = (index + 1 < out.length ? out[index + 1].phase : 1) - MIN_NODE_GAP;
  const p = Math.min(Math.max(phase, lo), Math.max(lo, hi));
  out[index] = { phase: p, multiplier: m };
  return out;
}

/** The per-frame multiplier source for a slider: its curve when speedMode is
 * 'curve' (defaulting the seam to 'smooth'), else the flat speed. */
export function metaMultiplier(meta: {
  speed?: number;
  speedMode?: 'flat' | 'curve';
  curveNodes?: CurveNode[];
  loopSeam?: LoopSeam;
}): (phase: number) => number {
  if (meta.speedMode === 'curve' && meta.curveNodes !== undefined && meta.curveNodes.length > 0) {
    return prepareCurve(meta.curveNodes, meta.loopSeam ?? 'smooth');
  }
  const s = clampSpeed(meta.speed ?? 1);
  return () => s;
}
