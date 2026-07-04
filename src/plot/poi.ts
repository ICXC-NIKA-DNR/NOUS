// Points of interest for explicit curves (M6): roots, extrema, and pairwise
// intersections, found numerically inside the visible x-range. Extrema use
// the CAS's compiled symbolic derivative when the caller can provide one;
// otherwise a central-difference fallback keeps everything working.
//
// Pure module: closures in, world-coordinate POIs out. The overlay layer
// projects and draws them.

import { newtonBisect } from '../cas/solve.ts';

export type PoiKind = 'root' | 'min' | 'max' | 'intersection';

export interface Poi {
  kind: PoiKind;
  x: number;
  y: number;
  /** Owning curve id, plus the second curve for intersections. */
  curveIds: number[];
}

export interface PoiCurve {
  id: number;
  f: (x: number) => number;
  /** Compiled symbolic derivative when available (CAS reuse). */
  fPrime?: (x: number) => number;
}

const SAMPLES = 240;

/** Bracketed sign-change roots of f on [lo, hi], asymptote flips rejected. */
export function findRoots(
  f: (x: number) => number,
  lo: number,
  hi: number,
  fp: ((x: number) => number) | null = null,
): number[] {
  const roots: number[] = [];
  const push = (r: number): void => {
    const tol = 1e-7 * Math.max(1, Math.abs(r));
    if (!roots.some((existing) => Math.abs(existing - r) <= tol)) roots.push(r);
  };
  let prevX = lo;
  let prevF = f(lo);
  for (let i = 1; i <= SAMPLES; i++) {
    const x = lo + ((hi - lo) * i) / SAMPLES;
    const fx = f(x);
    if (Number.isFinite(prevF) && Math.abs(prevF) < 1e-12) push(prevX);
    if (Number.isFinite(prevF) && Number.isFinite(fx) && prevF * fx < 0) {
      // A genuine crossing stays bounded at the midpoint; a pole doesn't.
      const mid = f((prevX + x) / 2);
      if (Number.isFinite(mid) && Math.abs(mid) <= 4 * Math.max(Math.abs(prevF), Math.abs(fx))) {
        const r = newtonBisect(f, fp, prevX, x);
        if (r !== null) push(r);
      }
    }
    prevX = x;
    prevF = fx;
  }
  roots.sort((a, b) => a - b);
  return roots;
}

/** Local extrema of f on [lo, hi]: roots of f′, classified by curvature. */
export function findExtrema(
  curve: PoiCurve,
  lo: number,
  hi: number,
): Array<{ x: number; y: number; kind: 'min' | 'max' }> {
  const h = (hi - lo) / (SAMPLES * 4);
  const fPrime =
    curve.fPrime ?? ((x: number) => (curve.f(x + h) - curve.f(x - h)) / (2 * h));
  const out: Array<{ x: number; y: number; kind: 'min' | 'max' }> = [];
  for (const x of findRoots(fPrime, lo, hi)) {
    const y = curve.f(x);
    if (!Number.isFinite(y)) continue;
    const left = curve.f(x - h);
    const right = curve.f(x + h);
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
    // Strict local comparison — plateaus and saddle-ish flats are skipped.
    if (left > y && right > y) out.push({ x, y, kind: 'min' });
    else if (left < y && right < y) out.push({ x, y, kind: 'max' });
  }
  return out;
}

/** All POIs for a set of explicit curves over the visible x-range. */
export function collectPois(curves: PoiCurve[], lo: number, hi: number, cap = 60): Poi[] {
  const pois: Poi[] = [];

  for (const curve of curves) {
    for (const x of findRoots(curve.f, lo, hi, curve.fPrime ?? null)) {
      pois.push({ kind: 'root', x, y: 0, curveIds: [curve.id] });
      if (pois.length >= cap) return pois;
    }
    for (const e of findExtrema(curve, lo, hi)) {
      pois.push({ kind: e.kind, x: e.x, y: e.y, curveIds: [curve.id] });
      if (pois.length >= cap) return pois;
    }
  }

  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const a = curves[i];
      const b = curves[j];
      const diff = (x: number): number => a.f(x) - b.f(x);
      const diffPrime =
        a.fPrime && b.fPrime
          ? (x: number): number => a.fPrime!(x) - b.fPrime!(x)
          : null;
      for (const x of findRoots(diff, lo, hi, diffPrime)) {
        const y = a.f(x);
        if (!Number.isFinite(y)) continue;
        pois.push({ kind: 'intersection', x, y, curveIds: [a.id, b.id] });
        if (pois.length >= cap) return pois;
      }
    }
  }

  return pois;
}
