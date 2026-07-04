// Graph analysis layer (docs/dev/Addition_M6_checkpoint_info.md).
//
// GUIDING PRINCIPLE: the graph is not the mathematics. This layer decides
// what mathematically exists — roots, extrema, intersections, coincidence —
// by asking the symbolic/numeric engines about the *expressions*, never by
// inspecting sampled points or rendered pixels. The renderer (overlay in
// GraphCanvas) only draws what this layer returns.
//
// Symbolic-first, numeric-fallback (per the spec's layer ordering):
//   1. Symbolic Analysis — CAS solve/simplify/differentiate. If it yields an
//      exact answer (or proves coincidence), that answer is authoritative.
//   2. Numeric Solver — only when the symbolic layer declines (transcendental
//      roots, non-differentiable pieces). Results are tagged 'approx' so the
//      UI can show the ≈ it deserves and nothing exact ever wears one.
//
// Every produced value is an ExactOrApprox that carries its own provenance,
// so `y = x` ∩ `y = -x` reports the point (0, 0) exactly — not ≈(0, 0) — and
// `y = x` plotted twice reports InfiniteIntersections, not thousands of dots.

import type { Expr, Relation, Span } from '../core/ast.ts';
import { engine } from '../cas/engine.ts';
import { GcalcError } from '../core/errors.ts';
import { asRational, substitute } from '../cas/simplify.ts';
import { findExtrema, findRoots } from './poi.ts';

const SPAN: Span = { start: 0, end: 0 };

/** A number that knows whether it is mathematically exact (with the symbolic
 * form that produced it) or a numerical approximation. */
export type ExactOrApprox =
  | { exact: true; expr: Expr; value: number }
  | { exact: false; value: number };

export type FeatureKind = 'root' | 'min' | 'max' | 'intersection';

/** A mathematical feature the analysis layer found — not a sampled pixel. */
export interface Feature {
  kind: FeatureKind;
  x: ExactOrApprox;
  y: ExactOrApprox;
  /** Owning curve id(s); two for an intersection. */
  curveIds: number[];
}

/** Two curves proven identical over their shared domain — infinitely many
 * shared points rather than a list of intersection dots. */
export interface Coincidence {
  curveIds: [number, number];
}

export interface AnalysisResult {
  features: Feature[];
  coincidences: Coincidence[];
}

/** An explicit curve as the analysis layer needs it: the AST body drives the
 * symbolic path; the compiled closures drive the numeric fallback. */
export interface AnalyzedCurve {
  id: number;
  body: Expr;
  f: (x: number) => number;
  fPrime?: (x: number) => number;
}

// A single view holds a bounded number of features; beyond this the labels
// would be noise anyway (e.g. sin(x) has unboundedly many roots).
const FEATURE_CAP = 60;

const relation = (left: Expr, right: Expr): Relation => ({
  kind: 'relation',
  operands: [left, right],
  ops: ['='],
  span: SPAN,
});

const approx = (value: number): ExactOrApprox => ({ exact: false, value });

/** Wrap an exact symbolic result, carrying both the form and its decimal. */
function exact(expr: Expr): ExactOrApprox {
  return { exact: true, expr, value: engine.approximate(expr) };
}

const NUM_ZERO: Expr = { kind: 'num', value: 0, span: SPAN };

/** Exact y = f(x) at an exact x, or null if it doesn't evaluate cleanly. */
function exactYAt(body: Expr, xExpr: Expr): ExactOrApprox | null {
  const yExpr = engine.simplify(substitute(body, 'x', xExpr));
  const value = engine.approximate(yExpr);
  return Number.isFinite(value) ? exact(yExpr) : null;
}

const inRange = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi;

/**
 * Roots of one curve: symbolic solve(body = 0) when the CAS can; otherwise
 * viewport-scoped numeric root finding. Exact roots keep their symbolic x and
 * an exact y of 0.
 */
function rootsOf(curve: AnalyzedCurve, lo: number, hi: number): Feature[] {
  const out: Feature[] = [];
  let symbolic: ReturnType<typeof engine.solve> | null = null;
  try {
    symbolic = engine.solve(relation(curve.body, NUM_ZERO), 'x');
  } catch (e) {
    if (!(e instanceof GcalcError)) throw e;
  }

  if (symbolic?.kind === 'exact') {
    for (const sol of symbolic.solutions) {
      const value = engine.approximate(sol);
      if (Number.isFinite(value) && inRange(value, lo, hi)) {
        out.push({ kind: 'root', x: exact(sol), y: exact(NUM_ZERO), curveIds: [curve.id] });
      }
    }
    return out;
  }

  // 'all-reals' (e.g. `0 = 0`) or a numeric/declined solve → numeric roots in
  // view. Numeric roots are honestly approximate.
  for (const x of findRoots(curve.f, lo, hi, curve.fPrime ?? null)) {
    out.push({ kind: 'root', x: approx(x), y: approx(0), curveIds: [curve.id] });
  }
  return out;
}

/**
 * Local extrema: symbolic solve(f' = 0) for exact critical x's, classified by
 * the sign of the numeric second difference; numeric fallback when the
 * derivative isn't symbolically available (e.g. floor) or the solve declines.
 */
function extremaOf(curve: AnalyzedCurve, lo: number, hi: number): Feature[] {
  const out: Feature[] = [];
  let derivative: Expr | null = null;
  try {
    derivative = engine.differentiate(curve.body, 'x');
  } catch (e) {
    if (!(e instanceof GcalcError)) throw e;
  }

  if (derivative !== null) {
    let critical: ReturnType<typeof engine.solve> | null = null;
    try {
      critical = engine.solve(relation(derivative, NUM_ZERO), 'x');
    } catch (e) {
      if (!(e instanceof GcalcError)) throw e;
    }
    if (critical?.kind === 'exact') {
      for (const sol of critical.solutions) {
        const x = engine.approximate(sol);
        if (!Number.isFinite(x) || !inRange(x, lo, hi)) continue;
        const kind = classifyExtremum(curve.f, x, hi - lo);
        if (kind === null) continue;
        const y = exactYAt(curve.body, sol);
        out.push({
          kind,
          x: exact(sol),
          y: y ?? approx(curve.f(x)),
          curveIds: [curve.id],
        });
      }
      return out;
    }
  }

  // Numeric fallback: viewport extrema, approximate.
  for (const e of findExtrema(curve, lo, hi)) {
    out.push({ kind: e.kind, x: approx(e.x), y: approx(e.y), curveIds: [curve.id] });
  }
  return out;
}

/** Second-difference sign test: 'min' | 'max' | null (inflection/flat). */
function classifyExtremum(
  f: (x: number) => number,
  x: number,
  span: number,
): 'min' | 'max' | null {
  const h = span / 2000;
  const left = f(x - h);
  const mid = f(x);
  const right = f(x + h);
  if (![left, mid, right].every(Number.isFinite)) return null;
  if (left > mid && right > mid) return 'min';
  if (left < mid && right < mid) return 'max';
  return null;
}

/**
 * Intersections of two explicit curves, symbolic-first:
 *   all-reals  → coincident (InfiniteIntersections)
 *   exact      → exact points (x symbolic, y = f(x) symbolic)
 *   numeric    → approximate points
 *   declined   → none
 */
function intersect(
  a: AnalyzedCurve,
  b: AnalyzedCurve,
  lo: number,
  hi: number,
): { features: Feature[]; coincident: boolean } {
  let result: ReturnType<typeof engine.solve> | null = null;
  try {
    result = engine.solve(relation(a.body, b.body), 'x');
  } catch (e) {
    if (!(e instanceof GcalcError)) throw e;
  }
  if (result === null) return { features: [], coincident: false };

  if (result.kind === 'all-reals') {
    return { features: [], coincident: true };
  }

  const features: Feature[] = [];
  if (result.kind === 'exact') {
    for (const sol of result.solutions) {
      const x = engine.approximate(sol);
      if (!Number.isFinite(x) || !inRange(x, lo, hi)) continue;
      const y = exactYAt(a.body, sol);
      features.push({
        kind: 'intersection',
        x: exact(sol),
        y: y ?? approx(a.f(x)),
        curveIds: [a.id, b.id],
      });
    }
  } else if (result.kind === 'numeric') {
    for (const x of result.solutions) {
      if (!inRange(x, lo, hi)) continue;
      const yv = a.f(x);
      if (!Number.isFinite(yv)) continue;
      features.push({ kind: 'intersection', x: approx(x), y: approx(yv), curveIds: [a.id, b.id] });
    }
  }
  return { features, coincident: false };
}

/** Are two curves structurally the same expression? Cheap pre-check so we can
 * flag coincidence even when solve is given non-polynomial bodies it would
 * otherwise punt on. simplify(a - b) == 0 is the general test. */
function coincidentBodies(a: Expr, b: Expr): boolean {
  const diff = engine.simplify({ kind: 'binary', op: '-', left: a, right: b, span: SPAN });
  return asRational(diff)?.isZero ?? false;
}

/**
 * Full analysis for the visible x-range. Returns exact-tagged features and any
 * coincident-curve pairs. Symbolic throughout, numeric only where the CAS
 * declines — so the results are the mathematics, independent of zoom or pixels.
 */
export function analyzeCurves(
  curves: AnalyzedCurve[],
  lo: number,
  hi: number,
  cap = FEATURE_CAP,
): AnalysisResult {
  const features: Feature[] = [];
  const coincidences: Coincidence[] = [];

  for (const curve of curves) {
    for (const r of rootsOf(curve, lo, hi)) {
      features.push(r);
      if (features.length >= cap) return { features, coincidences };
    }
    for (const e of extremaOf(curve, lo, hi)) {
      features.push(e);
      if (features.length >= cap) return { features, coincidences };
    }
  }

  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const a = curves[i];
      const b = curves[j];
      if (coincidentBodies(a.body, b.body)) {
        coincidences.push({ curveIds: [a.id, b.id] });
        continue; // identical curves have no discrete intersections
      }
      const { features: pts, coincident } = intersect(a, b, lo, hi);
      if (coincident) {
        coincidences.push({ curveIds: [a.id, b.id] });
        continue;
      }
      for (const p of pts) {
        features.push(p);
        if (features.length >= cap) return { features, coincidences };
      }
    }
  }

  return { features, coincidences };
}
