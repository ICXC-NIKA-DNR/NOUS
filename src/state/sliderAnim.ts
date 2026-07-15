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
// cycle (phase 0–1). Two fixed anchors — node 0 at phase 0 and the last node
// at phase 1, both vertical-drag only — plus up to 3 free middle nodes.
// Interpolation is a per-slider choice (Slider-Anim-M3; this replaced the
// separate scalar flat-speed field — "flat" is now the same node graph with
// straight segments):
//   'flat'  — linear segments between nodes (linear in log₂ space, so they
//             draw as straight lines on the log-scaled editor).
//   'curve' — monotone cubic Hermite spline (Fritsch–Carlson / PCHIP).
// Both interpolate in log₂(multiplier) space: it matches the editor's
// log-scaled y-axis (1× is the log-midpoint of 0.25×–4×), guarantees
// positivity, and PCHIP's monotone tangents never overshoot the band the
// nodes span — no post-clamp kinks.
//
// The seam (phase 1 wrapping to 0) is a per-slider choice governing the end
// anchor:
//   'smooth' — the end anchor's y is LOCKED equal to node 0's y (matching
//              tangents under PCHIP), so instantaneous speed is continuous
//              across cycles.
//   'hard'   — the end anchor is independently draggable; the gap between
//              its y and node 0's y is the speed pop at the cycle restart
//              (position is continuous either way).

export interface CurveNode {
  /** 0–1 through one min→max→min cycle. curveNodes[0].phase is always 0 and
   * the last node's phase is always 1 — the two anchors. */
  phase: number;
  /** Instantaneous speed multiplier, SPEED_MIN–SPEED_MAX. */
  multiplier: number;
}

export type LoopSeam = 'smooth' | 'hard';

/** Interpolation between nodes: straight segments ('flat') or PCHIP ('curve'). */
export type SpeedMode = 'flat' | 'curve';

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
 * Build an evaluator: phase ∈ [0, 1) → multiplier. Prepared once per frame
 * (or per redraw) and evaluated at any phase. Defensive about malformed node
 * lists (zero-width segments skipped, legacy lists without an end anchor get
 * one appended by the old M2 rules) — the editor and parser normalize before
 * data gets here, but direct callers may not.
 */
export function prepareCurve(
  nodes: CurveNode[],
  seam: LoopSeam,
  mode: SpeedMode = 'curve',
): (phase: number) => number {
  if (nodes.length === 0) return () => 1;
  const xs: number[] = [];
  const ys: number[] = []; // log₂(multiplier)
  for (const node of nodes) {
    const x = Math.min(1, Math.max(0, node.phase));
    if (xs.length > 0 && x - xs[xs.length - 1] < 1e-9) continue; // zero-width
    xs.push(x);
    ys.push(Math.log2(clampSpeed(node.multiplier)));
  }
  // Defensive path for un-normalized lists: append the end anchor (smooth →
  // node 0's value, hard → hold the last value, matching legacy behavior).
  if (1 - xs[xs.length - 1] >= 1e-9) {
    xs.push(1);
    ys.push(seam === 'smooth' ? ys[0] : ys[ys.length - 1]);
  }
  // The seam lock: under 'smooth' the end anchor's y IS node 0's y, whatever
  // the stored value says (the editor keeps them synced; this guards data
  // that arrived by other routes, e.g. a seam toggle on a hard-edited file).
  if (seam === 'smooth') ys[ys.length - 1] = ys[0];
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
  const m: number[] = new Array(n).fill(0);
  if (mode === 'curve') {
    for (let i = 1; i < n - 1; i++) m[i] = fcTangent(d[i - 1], d[i], h[i - 1], h[i]);
    if (seam === 'smooth') {
      // Periodic: the seam segment (last → end anchor ≡ node 0) is node 0's
      // left neighbor one cycle earlier, so both anchors share the tangent.
      m[0] = fcTangent(d[n - 2], d[0], h[n - 2], h[0]);
      m[n - 1] = m[0];
    } else {
      m[0] = d[0];
      m[n - 1] = d[n - 2];
    }
  }
  return (phase: number): number => {
    const p = Math.min(1, Math.max(0, phase - Math.floor(phase)));
    let i = 0;
    while (i < n - 2 && p > xs[i + 1]) i++;
    const t = (p - xs[i]) / h[i];
    if (mode === 'flat') {
      // Straight segment in log space — a straight line on the log-scaled
      // editor, and two equal anchors reproduce the old constant flat speed.
      return clampSpeed(2 ** (ys[i] + t * (ys[i + 1] - ys[i])));
    }
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

/** Default curve: the two anchors at the same height — a constant speed. */
export function defaultCurveNodes(speed = 1): CurveNode[] {
  const m = clampSpeed(speed);
  return [
    { phase: 0, multiplier: m },
    { phase: 1, multiplier: m },
  ];
}

/**
 * Canonical node list for a meta: always ≥ 2 nodes with anchors at phase 0
 * and 1. Seeds a constant curve when nodes are absent, and upgrades legacy
 * M2 lists (which had no end anchor) by the rules that reproduce their old
 * playback exactly: hard seam → end anchor at the held last value, smooth →
 * at node 0's value. A full 5-node legacy list has no room to append, so its
 * last free node becomes the end anchor (the one case that can shift shape;
 * realistically unreachable). Used by the parser on load and the editor on
 * first edit — playback tolerates un-normalized data via prepareCurve's
 * defensive path either way.
 */
export function normalizedCurveNodes(meta: {
  curveNodes?: CurveNode[];
  loopSeam?: LoopSeam;
}): CurveNode[] {
  const nodes = meta.curveNodes;
  if (nodes === undefined || nodes.length === 0) return defaultCurveNodes();
  const last = nodes[nodes.length - 1];
  if (last.phase >= 1 - 1e-9) return nodes;
  const seam = meta.loopSeam ?? 'smooth';
  const endMultiplier = seam === 'smooth' ? nodes[0].multiplier : last.multiplier;
  if (nodes.length >= MAX_CURVE_NODES) {
    return [...nodes.slice(0, -1), { phase: 1, multiplier: endMultiplier }];
  }
  return [...nodes, { phase: 1, multiplier: endMultiplier }];
}

/** Add a middle node at the midpoint of the widest phase gap, at the curve's
 * current value there — so adding a node barely changes the shape. Capped at
 * MAX_CURVE_NODES (2 anchors + 3 middles). Expects normalized nodes. */
export function addCurveNode(nodes: CurveNode[], seam: LoopSeam, mode: SpeedMode): CurveNode[] {
  if (nodes.length < 2) return normalizedCurveNodes({ curveNodes: nodes, loopSeam: seam });
  if (nodes.length >= MAX_CURVE_NODES) return nodes;
  let gapStart = 0;
  let gapWidth = -1;
  for (let i = 0; i < nodes.length - 1; i++) {
    if (nodes[i + 1].phase - nodes[i].phase > gapWidth) {
      gapWidth = nodes[i + 1].phase - nodes[i].phase;
      gapStart = nodes[i].phase;
    }
  }
  const phase = gapStart + gapWidth / 2;
  const multiplier = prepareCurve(nodes, seam, mode)(phase);
  const out = nodes.slice();
  const at = out.findIndex((node) => node.phase > phase);
  out.splice(at === -1 ? out.length - 1 : at, 0, { phase, multiplier });
  return out;
}

/** Remove the highest-phase MIDDLE node. The two anchors are never removed,
 * so the floor is 2 (a constant-speed line between the anchors). */
export function removeCurveNode(nodes: CurveNode[]): CurveNode[] {
  if (nodes.length <= 2) return nodes;
  return [...nodes.slice(0, -2), nodes[nodes.length - 1]];
}

/** Move a node: multiplier clamps to the speed range; a middle node's phase
 * clamps between its neighbors (with MIN_NODE_GAP) so nodes stay sorted and
 * never cross. The anchors (node 0 at phase 0, the last node at phase 1)
 * only move vertically — and under a 'smooth' seam their y's are locked
 * together, so dragging either one moves both. */
export function moveCurveNode(
  nodes: CurveNode[],
  index: number,
  phase: number,
  multiplier: number,
  seam: LoopSeam,
): CurveNode[] {
  if (index < 0 || index >= nodes.length) return nodes;
  const out = nodes.slice();
  const m = clampSpeed(multiplier);
  const lastIndex = out.length - 1;
  const isEndAnchor = index === lastIndex && out[index].phase >= 1 - 1e-9;
  if (index === 0 || isEndAnchor) {
    out[index] = { phase: index === 0 ? 0 : 1, multiplier: m };
    if (seam === 'smooth' && out.length >= 2 && out[lastIndex].phase >= 1 - 1e-9) {
      out[0] = { phase: 0, multiplier: m };
      out[lastIndex] = { phase: 1, multiplier: m };
    }
    return out;
  }
  const lo = out[index - 1].phase + MIN_NODE_GAP;
  const hi = (index + 1 < out.length ? out[index + 1].phase : 1) - MIN_NODE_GAP;
  const p = Math.min(Math.max(phase, lo), Math.max(lo, hi));
  out[index] = { phase: p, multiplier: m };
  return out;
}

/** The per-frame multiplier source for a slider: its node graph, linear or
 * PCHIP per speedMode. Metas with no nodes (fresh sliders) run at 1×. */
export function metaMultiplier(meta: {
  speedMode?: SpeedMode;
  curveNodes?: CurveNode[];
  loopSeam?: LoopSeam;
}): (phase: number) => number {
  if (meta.curveNodes === undefined || meta.curveNodes.length === 0) return () => 1;
  return prepareCurve(meta.curveNodes, meta.loopSeam ?? 'smooth', meta.speedMode ?? 'flat');
}
