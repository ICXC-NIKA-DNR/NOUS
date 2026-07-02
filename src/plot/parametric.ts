// Adaptive sampling for parametric curves (x(t), y(t)) — polar curves ride
// on this with x = r·cos θ, y = r·sin θ. Same contract as sampler.ts:
// screen-space polylines, NaN gaps split segments, asymptotic jumps break
// rather than draw a connector.

import type { Segment } from './sampler.ts';
import { xToPx, yToPx, type Viewport } from './viewport.ts';

export interface ParametricOptions {
  coarse?: number;
  maxDepth?: number;
  tolPx?: number;
}

const CLAMP_MARGIN = 4;

export function sampleParametric(
  fx: (t: number) => number,
  fy: (t: number) => number,
  t0: number,
  t1: number,
  vp: Viewport,
  opts: ParametricOptions = {},
): Segment[] {
  const coarse = opts.coarse ?? 64;
  const maxDepth = opts.maxDepth ?? 10;
  const tolPx = opts.tolPx ?? 0.25;

  const xLo = -CLAMP_MARGIN * vp.width;
  const xHi = (1 + CLAMP_MARGIN) * vp.width;
  const yLo = -CLAMP_MARGIN * vp.height;
  const yHi = (1 + CLAMP_MARGIN) * vp.height;
  const jumpPx = 2 * (vp.width + vp.height);

  const segments: Segment[] = [];
  let current: Segment = [];

  const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

  /** Screen point for parameter t, or null when either coordinate is not finite. */
  const sample = (t: number): [number, number] | null => {
    const wx = fx(t);
    const wy = fy(t);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
    return [clamp(xToPx(vp, wx), xLo, xHi), clamp(yToPx(vp, wy), yLo, yHi)];
  };

  const emit = (p: [number, number]): void => {
    const n = current.length;
    if (n >= 2 && current[n - 2] === p[0] && current[n - 1] === p[1]) return;
    current.push(p[0], p[1]);
  };

  const breakSegment = (): void => {
    if (current.length >= 4) segments.push(current);
    current = [];
  };

  /** Bisect between a defined t and an undefined t; return last defined point. */
  const findEdge = (tDef: number, pDef: [number, number], tNaN: number): [number, number] => {
    let td = tDef;
    let pd = pDef;
    let tn = tNaN;
    for (let i = 0; i < 22; i++) {
      const tm = (td + tn) / 2;
      const pm = sample(tm);
      if (pm !== null) {
        td = tm;
        pd = pm;
      } else {
        tn = tm;
      }
    }
    return pd;
  };

  const refine = (
    ta: number,
    pa: [number, number] | null,
    tb: number,
    pb: [number, number] | null,
    depth: number,
  ): void => {
    const tm = (ta + tb) / 2;
    const pm = sample(tm);

    if (pa === null && pb === null) {
      if (pm === null || depth >= maxDepth) return;
      refine(ta, pa, tm, pm, depth + 1);
      refine(tm, pm, tb, pb, depth + 1);
      return;
    }

    if (pa === null || pb === null) {
      if (depth < maxDepth) {
        refine(ta, pa, tm, pm, depth + 1);
        refine(tm, pm, tb, pb, depth + 1);
        return;
      }
      if (pa !== null) {
        emit(pa);
        emit(findEdge(ta, pa, tb));
        breakSegment();
      } else {
        breakSegment();
        emit(findEdge(tb, pb!, ta));
        emit(pb!);
      }
      return;
    }

    // Flatness: midpoint's distance from the chord midpoint, in px.
    const flat =
      pm !== null &&
      Math.abs(pm[0] - (pa[0] + pb[0]) / 2) <= tolPx &&
      Math.abs(pm[1] - (pa[1] + pb[1]) / 2) <= tolPx;

    if (!flat && depth < maxDepth) {
      refine(ta, pa, tm, pm, depth + 1);
      refine(tm, pm, tb, pb, depth + 1);
      return;
    }

    if (pm === null) {
      emit(pa);
      breakSegment();
      emit(pb);
      return;
    }

    // Still a huge jump at the depth limit → asymptote, not a fast curve.
    const jump = Math.abs(pb[0] - pa[0]) + Math.abs(pb[1] - pa[1]);
    if (jump >= jumpPx) {
      emit(pa);
      breakSegment();
      emit(pb);
      return;
    }

    emit(pa);
    emit(pm);
    emit(pb);
  };

  let tPrev = t0;
  let pPrev = sample(t0);
  for (let i = 1; i <= coarse; i++) {
    const t = t0 + ((t1 - t0) * i) / coarse;
    const p = sample(t);
    refine(tPrev, pPrev, t, p, 0);
    tPrev = t;
    pPrev = p;
  }
  breakSegment();

  return segments;
}
