// Curve tracing for the Desmos-style click-drag readout (M6 checkpoint).
//
// Given a numeric f and a world x, classify the local behaviour so the
// tooltip can show a value + slope on a continuous stretch and an honest
// label (hole / jump / asymptote / domain boundary) at a break — never a
// number that implies the function is defined where it isn't.
//
// This is a *display* helper: it works entirely from the compiled numeric
// closure via multi-scale finite differences, so it's fast enough to run on
// every pointermove and needs no symbolic input. The slope can optionally be
// upgraded to the exact CAS derivative by the caller (see slopeExact usage in
// GraphCanvas); by default it's the central difference computed here.
//
// Numeric discontinuity classification is inherently heuristic — there is no
// finite sampling that distinguishes every pathological case. The thresholds
// below are tuned for the functions a graphing calculator actually meets
// (rational poles, removable factors like sin(x)/x, √ domain edges, step
// functions) and degrade to a conservative "point" when unsure rather than
// crying discontinuity on a merely steep curve.

export type TraceKind =
  | 'point' // continuous here: value + slope are meaningful
  | 'hole' // removable discontinuity; two-sided limit exists (`limit`)
  | 'jump' // finite one-sided limits that disagree
  | 'asymptote' // diverges to ±∞
  | 'boundary' // defined on one side only (domain edge)
  | 'none'; // undefined in a whole neighbourhood

export interface TracePoint {
  kind: TraceKind;
  x: number;
  /** Finite only when kind === 'point'. */
  y: number;
  /** Central-difference slope; NaN unless kind === 'point'. */
  slope: number;
  /** The two-sided limit for a 'hole'. */
  limit?: number;
}

const DIVERGE_MAG = 1e5; // a limit this large AND still growing is divergence

/** One-sided limit estimate from samples marching toward x. Returns the
 * settled value, 'diverge' (magnitude blows up), or 'undef' (no domain). */
function sideLimit(f: (x: number) => number, x: number, dir: 1 | -1): number | 'diverge' | 'undef' {
  // Down to 1e-8 so a pole like 1/x reaches ~1e8 and reads as divergent, not
  // as a huge-but-finite settled value.
  const hs = [1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8];
  const vals: number[] = [];
  for (const h of hs) {
    const v = f(x + dir * h);
    if (Number.isFinite(v)) vals.push(v);
    else if (Number.isNaN(v) && vals.length === 0) {
      return 'undef'; // NaN right up against x with no finite samples yet
    }
  }
  if (vals.length === 0) return 'undef';

  const last = vals[vals.length - 1];
  const prev = vals.length >= 2 ? vals[vals.length - 2] : last;
  // Divergence: closest sample is large and its magnitude is still climbing as
  // we approach x (a genuine pole), not merely a big-but-flat value like e^12.
  if (Math.abs(last) > DIVERGE_MAG && Math.abs(last) > Math.abs(prev) * 1.5) {
    return 'diverge';
  }
  // Settled if the two closest samples agree.
  if (Math.abs(last - prev) <= 1e-4 * Math.max(1, Math.abs(last))) return last;
  return last; // best available estimate
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Classify f at world x. `scale` is a characteristic x-width (e.g. the
 * viewport span) used to size the slope step so it reads well at any zoom.
 */
export function traceAt(f: (x: number) => number, x: number, scale = 1): TracePoint {
  const yc = f(x);
  const left = sideLimit(f, x, -1);
  const right = sideLimit(f, x, 1);

  // Divergence on either side → vertical asymptote.
  if (left === 'diverge' || right === 'diverge') {
    return { kind: 'asymptote', x, y: NaN, slope: NaN };
  }

  const leftDef = left !== 'undef';
  const rightDef = right !== 'undef';

  // Defined on exactly one side → domain boundary (e.g. √x at 0).
  if (leftDef !== rightDef) {
    return { kind: 'boundary', x, y: Number.isFinite(yc) ? yc : NaN, slope: NaN };
  }

  // Undefined on both sides → genuinely nothing here.
  if (!leftDef && !rightDef) {
    if (Number.isFinite(yc)) return pointAt(f, x, yc, scale); // isolated defined point
    return { kind: 'none', x, y: NaN, slope: NaN };
  }

  const L = left as number;
  const R = right as number;

  // Two-sided limits disagree → jump discontinuity.
  if (!near(L, R)) {
    return { kind: 'jump', x, y: NaN, slope: NaN };
  }

  const limit = (L + R) / 2;

  // Two-sided limit exists but f(x) is undefined or elsewhere → removable hole.
  if (!Number.isFinite(yc) || !near(yc, limit)) {
    return { kind: 'hole', x, y: NaN, slope: NaN, limit };
  }

  // Continuous here.
  return pointAt(f, x, yc, scale);
}

function pointAt(f: (x: number) => number, x: number, y: number, scale: number): TracePoint {
  return { kind: 'point', x, y, slope: numericSlope(f, x, scale) };
}

/** Central-difference derivative, step sized to the view so it stays stable
 * across zoom levels. Display-only; the caller may replace it with the exact
 * CAS derivative. */
export function numericSlope(f: (x: number) => number, x: number, scale = 1): number {
  const h = Math.max(1e-7, scale * 1e-5);
  const a = f(x - h);
  const b = f(x + h);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    // Near an edge, fall back to a one-sided difference.
    const c = f(x);
    if (!Number.isFinite(c)) return NaN;
    if (Number.isFinite(b)) return (b - c) / h;
    if (Number.isFinite(a)) return (c - a) / h;
    return NaN;
  }
  return (b - a) / (2 * h);
}
