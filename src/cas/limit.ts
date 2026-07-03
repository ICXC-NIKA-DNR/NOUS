// Limits (CAS_SPEC.md M5.5): direct substitution, L'Hôpital for 0/0 and
// ∞/∞ quotients (recursion-capped — repeated L'Hôpital can loop on
// pathological input), one-sided limits, and numeric probing as the
// fallback and as the cross-check for the symbolic path.
//
// Result vocabulary (a documented superset of the spec's signature, in the
// spirit of solve()'s honesty):
//   number      — finite limit, or ±Infinity for a signed infinite limit
//   'diverges'  — unbounded without a consistent sign
//   'dne'       — the limit does not exist (sides disagree, or oscillation)

import type { Expr } from '../core/ast.ts';
import { compile } from '../core/compile.ts';
import { GcalcError } from '../core/errors.ts';
import { differentiate } from './differentiate.ts';
import { div, simplify } from './simplify.ts';

export type Approach = number | 'inf' | '-inf';
export type Side = 'left' | 'right';
export type LimitResult = number | 'diverges' | 'dne';

const MAX_LHOPITAL = 6;

export function limit(
  expr: Expr,
  wrt: string,
  approaching: Approach,
  side?: Side,
): LimitResult {
  return limitInner(simplify(expr), wrt, approaching, side, 0);
}

function limitInner(
  e: Expr,
  x: string,
  a: Approach,
  side: Side | undefined,
  depth: number,
): LimitResult {
  const f = compileFn(e, x);
  if (f === null) return 'dne';

  // Direct substitution at a finite point: continuous case ends here.
  if (typeof a === 'number') {
    const direct = f(a);
    if (Number.isFinite(direct)) {
      // Confirm continuity from the approached side(s) — piecewise jumps
      // make the raw substitution misleading.
      const probe = probeSides(f, a, side);
      if (probe.kind === 'value' && Math.abs(probe.value - direct) <= tolFor(direct)) {
        return direct;
      }
      return probe.kind === 'value' ? probe.value : probe.kind === 'signed' ? probe.value : probe.kind;
    }
  }

  // L'Hôpital for quotients in 0/0 or ∞/∞ form.
  if (e.kind === 'binary' && e.op === '/' && depth < MAX_LHOPITAL) {
    const top = compileFn(e.left, x);
    const bottom = compileFn(e.right, x);
    if (top !== null && bottom !== null) {
      const tProbe = probeSides(top, a, side);
      const bProbe = probeSides(bottom, a, side);
      // Threshold reflects the probe's resolution: the closest sample sits
      // 1e-8 from the point, so an O(h) numerator bottoms out near 1e-8.
      const zeroZero =
        tProbe.kind === 'value' &&
        Math.abs(tProbe.value) < 1e-6 &&
        bProbe.kind === 'value' &&
        Math.abs(bProbe.value) < 1e-6;
      const infInf =
        (tProbe.kind === 'signed' || tProbe.kind === 'diverges') &&
        (bProbe.kind === 'signed' || bProbe.kind === 'diverges');
      if (zeroZero || infInf) {
        try {
          const ratio = simplify(div(differentiate(e.left, x), differentiate(e.right, x)));
          const inner = limitInner(ratio, x, a, side, depth + 1);
          if (inner !== 'dne' && inner !== 'diverges') return inner;
          // fall through to numeric probing when L'Hôpital is inconclusive
        } catch (err) {
          if (!(err instanceof GcalcError)) throw err;
          // not differentiable — numeric probing below
        }
      }
    }
  }

  const probe = probeSides(f, a, side);
  switch (probe.kind) {
    case 'value':
    case 'signed':
      return probe.value;
    default:
      return probe.kind;
  }
}

function compileFn(e: Expr, x: string): ((v: number) => number) | null {
  try {
    const compiled = compile(e, { angleMode: 'radians' });
    const env: Record<string, number> = {};
    return (v: number): number => {
      env[x] = v;
      return compiled(env);
    };
  } catch (err) {
    if (err instanceof GcalcError) return null;
    throw err;
  }
}

type Probe =
  | { kind: 'value'; value: number }
  | { kind: 'signed'; value: number } // ±Infinity
  | { kind: 'diverges' }
  | { kind: 'dne' };

/** Probe the requested side(s) and reconcile them. */
function probeSides(f: (v: number) => number, a: Approach, side: Side | undefined): Probe {
  if (a === 'inf') return probeSequence(f, powersOf(1));
  if (a === '-inf') return probeSequence(f, powersOf(-1));
  const scale = Math.max(1, Math.abs(a));
  const left = (): Probe => probeSequence(f, approachFrom(a, -scale));
  const right = (): Probe => probeSequence(f, approachFrom(a, scale));
  if (side === 'left') return left();
  if (side === 'right') return right();
  const l = left();
  const r = right();
  if (l.kind === 'value' && r.kind === 'value') {
    return Math.abs(l.value - r.value) <= tolFor(l.value) ? l : { kind: 'dne' };
  }
  if (l.kind === 'signed' && r.kind === 'signed') {
    return l.value === r.value ? l : { kind: 'dne' };
  }
  if (l.kind === r.kind) return l;
  return { kind: 'dne' };
}

const powersOf = (sign: number): number[] =>
  [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9].map((p) => sign * p);

const approachFrom = (a: number, dir: number): number[] =>
  [1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8].map((h) => a + dir * h);

const tolFor = (v: number): number => 1e-5 * Math.max(1, Math.abs(v));

/** Read a convergence verdict off a sample sequence. */
function probeSequence(f: (v: number) => number, points: number[]): Probe {
  const values = points.map(f).filter((v) => !Number.isNaN(v));
  if (values.length < 3) return { kind: 'dne' };

  const tail = values.slice(-3);
  const [v1, v2, v3] = tail;

  // Convergence: the tail has settled within tolerance.
  const d23 = Math.abs(v3 - v2);
  if (Number.isFinite(v3) && d23 <= tolFor(v3)) {
    return { kind: 'value', value: v3 };
  }

  // Fast blow-up: growing magnitude with one sign (or non-finite samples).
  const mags = tail.map(Math.abs);
  if (mags[2] >= 1e6 || tail.some((v) => !Number.isFinite(v))) {
    const signs = tail.map(Math.sign);
    if (mags[0] < mags[1] && mags[1] <= mags[2] && signs[0] === signs[1] && signs[1] === signs[2]) {
      return { kind: 'signed', value: signs[2] * Infinity };
    }
    return { kind: 'diverges' };
  }

  // Slow unbounded drift (ln-like): every step moves the same direction and
  // the steps aren't shrinking — the Cauchy criterion is being violated
  // with persistent drift, so the sequence is marching off to ±∞.
  const deltas = [];
  for (let i = 1; i < values.length; i++) deltas.push(values[i] - values[i - 1]);
  const driftSign = Math.sign(deltas[deltas.length - 1]);
  const monotone = deltas.every((d) => Math.sign(d) === driftSign && d !== 0);
  const shrinking =
    Math.abs(deltas[deltas.length - 1]) < 0.25 * Math.abs(deltas[0]);
  if (monotone && !shrinking && Math.abs(values[values.length - 1]) > Math.abs(values[0])) {
    return { kind: 'signed', value: driftSign * Infinity };
  }

  // Bounded but not settling → oscillation.
  return { kind: 'dne' };
}
