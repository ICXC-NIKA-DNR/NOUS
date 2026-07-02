// Adaptive curve sampling for y = f(x). Produces screen-space polylines,
// subdividing where the curve deviates from its chord (high curvature) and
// breaking segments at discontinuities (NaN gaps and asymptotic jumps) so
// y = 1/x never draws a fake vertical line through the pole.
//
// f is evaluated in world coordinates and may return NaN/±Infinity freely —
// the core evaluator maps failed domain restrictions to NaN on purpose.

import type { Viewport } from './viewport.ts';
import { xToPx, yToPx, pxToX } from './viewport.ts';

/** One connected polyline, flat-packed as [x0, y0, x1, y1, …] in CSS px. */
export type Segment = number[];

export interface SampleOptions {
  /** Coarse intervals before refinement. */
  coarse?: number;
  /** Max bisection depth per coarse interval. */
  maxDepth?: number;
  /** Screen-space flatness tolerance in px. */
  tolPx?: number;
}

// Clamp offscreen y so asymptotic branches keep their direction without
// feeding the canvas absurd coordinates.
const CLAMP_MARGIN = 4;

export function sampleCurve(
  f: (x: number) => number,
  vp: Viewport,
  opts: SampleOptions = {},
): Segment[] {
  const coarse = opts.coarse ?? 96;
  const maxDepth = opts.maxDepth ?? 11;
  const tolPx = opts.tolPx ?? 0.2;

  const clampLo = -CLAMP_MARGIN * vp.height;
  const clampHi = (1 + CLAMP_MARGIN) * vp.height;
  // A jump taller than the whole (margin-padded) band that survives max-depth
  // refinement is an asymptote, not a steep-but-continuous stretch.
  const jumpPx = (CLAMP_MARGIN + 1) * vp.height;

  const segments: Segment[] = [];
  let current: Segment = [];

  const py = (y: number): number => {
    const p = yToPx(vp, y);
    return p < clampLo ? clampLo : p > clampHi ? clampHi : p;
  };

  const emit = (x: number, y: number): void => {
    const sx = xToPx(vp, x);
    const sy = py(y);
    const n = current.length;
    if (n >= 2 && current[n - 2] === sx && current[n - 1] === sy) return;
    current.push(sx, sy);
  };

  const breakSegment = (): void => {
    if (current.length >= 4) segments.push(current);
    current = [];
  };

  /** Locate the finite/NaN boundary between xa (finite) and xb (NaN) — or the
   * mirrored orientation — and return the last finite point found. */
  const findEdge = (
    xFinite: number,
    yFinite: number,
    xNaN: number,
  ): [number, number] => {
    let xf = xFinite;
    let yf = yFinite;
    let xn = xNaN;
    for (let i = 0; i < 24; i++) {
      const xm = (xf + xn) / 2;
      const ym = f(xm);
      if (Number.isFinite(ym) || ym === Infinity || ym === -Infinity) {
        if (Number.isFinite(ym)) {
          xf = xm;
          yf = ym;
        } else {
          xn = xm; // ±Infinity: treat as outside, keep last truly finite point
        }
      } else {
        xn = xm;
      }
    }
    return [xf, yf];
  };

  /**
   * Refine the interval (xa, ya)–(xb, yb). Precondition: the caller has
   * already emitted (xa, ya) when it is finite. Emits interior + right points.
   */
  const refine = (xa: number, ya: number, xb: number, yb: number, depth: number): void => {
    const aFin = Number.isFinite(ya);
    const bFin = Number.isFinite(yb);
    const xm = (xa + xb) / 2;
    const ym = f(xm);
    const mFin = Number.isFinite(ym);

    if (!aFin && !bFin) {
      if (!mFin || depth >= maxDepth) return; // whole interval is a gap
      // A finite island inside a gap — recurse to find its edges.
      refine(xa, ya, xm, ym, depth + 1);
      refine(xm, ym, xb, yb, depth + 1);
      return;
    }

    if (aFin !== bFin) {
      // A gap starts or ends inside this interval: keep narrowing it — the
      // finite half gets its curvature detail from the sibling recursion.
      if (depth < maxDepth) {
        refine(xa, ya, xm, ym, depth + 1);
        refine(xm, ym, xb, yb, depth + 1);
        return;
      }
      // Sub-pixel now: bisect for the exact edge and break the polyline there.
      if (aFin) {
        const [xe, ye] = findEdge(xa, ya, xb);
        emit(xa, ya);
        emit(xe, ye);
        breakSegment();
      } else {
        const [xe, ye] = findEdge(xb, yb, xa);
        breakSegment();
        emit(xe, ye);
        emit(xb, yb);
      }
      return;
    }

    // Both endpoints finite: flat enough in screen space?
    const pax = xToPx(vp, xa);
    const pay = py(ya);
    const pbx = xToPx(vp, xb);
    const pby = py(yb);
    const pmy = py(ym);
    const chordMidY = (pay + pby) / 2;
    const flat = mFin && Math.abs(pmy - chordMidY) <= tolPx;

    if (!flat && depth < maxDepth) {
      refine(xa, ya, xm, ym, depth + 1);
      refine(xm, ym, xb, yb, depth + 1);
      return;
    }

    if (!mFin) {
      // Pinhole gap narrower than resolution — treat as a break.
      emit(xa, ya);
      breakSegment();
      emit(xb, yb);
      return;
    }

    // At the depth limit a still-huge jump is an asymptote: break the line.
    if (Math.abs(pby - pay) >= jumpPx && Math.abs(pbx - pax) < 1) {
      emit(xa, ya);
      breakSegment();
      emit(xb, yb);
      return;
    }

    emit(xa, ya);
    emit(xm, ym);
    emit(xb, yb);
  };

  let xPrev = vp.xMin;
  let yPrev = f(xPrev);
  for (let i = 1; i <= coarse; i++) {
    const x = pxToX(vp, (i / coarse) * vp.width);
    const y = f(x);
    refine(xPrev, yPrev, x, y, 0);
    xPrev = x;
    yPrev = y;
  }
  breakSegment();

  return segments;
}
