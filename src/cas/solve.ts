// Equation solving (CAS_SPEC.md M5.3).
//
// Exact tier: linear and quadratic equations. Rational coefficients get
// fully exact roots (√ kept symbolic when irrational — solve(x² = 2) is
// ±√2, not ±1.4142…). Linear equations with symbolic coefficients (sliders)
// solve symbolically too: a·x + b = 0 → x = −b/a.
//
// Numeric tier: everything else. The function is sampled across a range,
// sign changes are bracketed, then Newton's method (using the *symbolic*
// derivative from M5.1 — one clean reuse) polishes each bracket with
// bisection as the safety net.
//
// Complex numbers are scoped out of v1 (nothing else in gcalc evaluates
// complex values): a negative discriminant returns kind 'exact' with zero
// real solutions and an honest note — distinguishable from
// 'no-solution-found', which means the solver gave up.

import type { Expr, Relation } from '../core/ast.ts';
import { compile, type CompiledFn } from '../core/compile.ts';
import { GcalcError, fail } from '../core/errors.ts';
import { differentiate } from './differentiate.ts';
import { Rational } from './rational.ts';
import { asRational, add, call, div, equal, mul, neg, num, pow, simplify, sub } from './simplify.ts';

export type SolveResult =
  | { kind: 'exact'; solutions: Expr[]; note?: string }
  | { kind: 'numeric'; solutions: number[]; note?: string }
  | { kind: 'all-reals' }
  | { kind: 'no-solution-found'; note?: string };

/* ------------------------------------------------------------------ */
/* Polynomial coefficient extraction                                    */
/* ------------------------------------------------------------------ */

const MAX_POLY_DEGREE = 12;

/** Coefficients (index = degree) as Exprs, or null when non-polynomial in x. */
export function polyCoeffs(e: Expr, x: string): Expr[] | null {
  switch (e.kind) {
    case 'num':
      return [e];
    case 'ident':
      return e.name === x ? [num(0), num(1)] : [e];
    case 'unary': {
      const inner = polyCoeffs(e.operand, x);
      if (inner === null) return null;
      return e.op === '-' ? inner.map(neg) : inner;
    }
    case 'binary': {
      switch (e.op) {
        case '+':
        case '-': {
          const l = polyCoeffs(e.left, x);
          const r = polyCoeffs(e.right, x);
          if (l === null || r === null) return null;
          const out: Expr[] = [];
          for (let i = 0; i < Math.max(l.length, r.length); i++) {
            const a = l[i] ?? num(0);
            const b = r[i] ?? num(0);
            out.push(e.op === '+' ? add(a, b) : sub(a, b));
          }
          return out;
        }
        case '*': {
          const l = polyCoeffs(e.left, x);
          const r = polyCoeffs(e.right, x);
          if (l === null || r === null) return null;
          if (l.length + r.length - 2 > MAX_POLY_DEGREE) return null;
          const out: Expr[] = Array.from({ length: l.length + r.length - 1 }, () => num(0));
          for (let i = 0; i < l.length; i++) {
            for (let j = 0; j < r.length; j++) {
              out[i + j] = add(out[i + j], mul(l[i], r[j]));
            }
          }
          return out;
        }
        case '/': {
          if (containsVar(e.right, x)) return null;
          const l = polyCoeffs(e.left, x);
          if (l === null) return null;
          return l.map((c) => div(c, e.right));
        }
        case '^': {
          const exp = asRational(e.right);
          if (exp === null || !exp.isInteger || exp.sign < 0) {
            return containsVar(e, x) ? null : [e];
          }
          const k = Number(exp.n);
          if (k > MAX_POLY_DEGREE) return containsVar(e.left, x) ? null : [e];
          const base = polyCoeffs(e.left, x);
          if (base === null) return null;
          if ((base.length - 1) * k > MAX_POLY_DEGREE) return null;
          let acc: Expr[] = [num(1)];
          for (let i = 0; i < k; i++) {
            const out: Expr[] = Array.from({ length: acc.length + base.length - 1 }, () => num(0));
            for (let a = 0; a < acc.length; a++) {
              for (let b = 0; b < base.length; b++) {
                out[a + b] = add(out[a + b], mul(acc[a], base[b]));
              }
            }
            acc = out;
          }
          return acc;
        }
      }
      break;
    }
    default:
      return containsVar(e, x) ? null : [e];
  }
  return null;
}

export function containsVar(e: Expr, x: string): boolean {
  switch (e.kind) {
    case 'num':
      return false;
    case 'ident':
      return e.name === x;
    case 'unary':
      return containsVar(e.operand, x);
    case 'binary':
      return containsVar(e.left, x) || containsVar(e.right, x);
    case 'postfix':
      return containsVar(e.operand, x);
    case 'call':
      return e.args.some((a) => containsVar(a, x));
    case 'relation':
      return e.operands.some((o) => containsVar(o, x));
    case 'restriction':
      return containsVar(e.body, x) || e.conditions.some((c) => containsVar(c, x));
    case 'piecewise':
      return (
        e.branches.some((b) => containsVar(b.condition, x) || containsVar(b.value, x)) ||
        (e.fallback !== undefined && containsVar(e.fallback, x))
      );
    case 'point':
      return containsVar(e.x, x) || containsVar(e.y, x);
    case 'list':
      return e.items.some((i) => containsVar(i, x));
  }
}

/** Trim trailing (numerically) zero coefficients after simplification. */
function trimmed(coeffs: Expr[]): Expr[] {
  const out = coeffs.map(simplify);
  while (out.length > 1 && (asRational(out[out.length - 1])?.isZero ?? false)) out.pop();
  return out;
}

/* ------------------------------------------------------------------ */
/* Exact solving                                                        */
/* ------------------------------------------------------------------ */

/** √ of a rational as a simplified Expr — exact when a perfect square. */
function sqrtExpr(r: Rational): Expr {
  return simplify(call('sqrt', r.toExpr()));
}

function solveExact(coeffs: Expr[], x: string): SolveResult | null {
  const degree = coeffs.length - 1;

  if (degree === 0) {
    const c = asRational(coeffs[0]);
    if (c !== null) return c.isZero ? { kind: 'all-reals' } : { kind: 'exact', solutions: [] };
    return {
      kind: 'no-solution-found',
      note: `The equation does not involve ${x}.`,
    };
  }

  if (degree === 1) {
    // c1·x + c0 = 0 → x = −c0/c1 (works symbolically for slider coefficients).
    const root = simplify(neg(div(coeffs[0], coeffs[1])));
    return { kind: 'exact', solutions: [root] };
  }

  if (degree === 2) {
    const a = asRational(coeffs[2]);
    const b = asRational(coeffs[1]);
    const c = asRational(coeffs[0]);
    if (a === null || b === null || c === null) return null; // symbolic quadratic → numeric tier
    const disc = b.mul(b).sub(Rational.of(4n).mul(a).mul(c));
    if (disc.sign < 0) {
      return {
        kind: 'exact',
        solutions: [],
        note: 'Two complex roots — complex results are not displayed in v1.',
      };
    }
    const twoA = a.mul(Rational.of(2n));
    if (disc.isZero) {
      return { kind: 'exact', solutions: [b.neg().div(twoA).toExpr()] };
    }
    const root = sqrtExpr(disc); // exact rational when disc is a perfect square
    const minusB = b.neg().toExpr();
    const plus = simplify(div(add(minusB, root), twoA.toExpr()));
    const minus = simplify(div(sub(minusB, root), twoA.toExpr()));
    return { kind: 'exact', solutions: [minus, plus] };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Numeric solving: bracket sign changes, Newton + bisection            */
/* ------------------------------------------------------------------ */

const SAMPLE_RANGES: Array<[number, number, number]> = [
  [-50, 50, 4000],
  [-1000, 1000, 8000],
];

function newtonBisect(
  f: (x: number) => number,
  fp: ((x: number) => number) | null,
  lo: number,
  hi: number,
): number | null {
  let flo = f(lo);
  let x = (lo + hi) / 2;
  for (let i = 0; i < 80; i++) {
    const fx = f(x);
    if (!Number.isFinite(fx)) return null;
    if (Math.abs(fx) < 1e-13 * Math.max(1, Math.abs(x))) return x;
    // Newton step when the derivative cooperates and stays in the bracket.
    let next = NaN;
    if (fp !== null) {
      const d = fp(x);
      if (Number.isFinite(d) && d !== 0) next = x - fx / d;
    }
    if (!(next > lo && next < hi)) {
      // bisection fallback
      if (flo * fx <= 0) hi = x;
      else {
        lo = x;
        flo = fx;
      }
      next = (lo + hi) / 2;
    } else if (flo * fx <= 0) hi = x;
    else {
      lo = x;
      flo = fx;
    }
    if (Math.abs(next - x) < 1e-15 * Math.max(1, Math.abs(next))) return next;
    x = next;
  }
  return Math.abs(f(x)) < 1e-8 ? x : null;
}

function solveNumeric(F: Expr, x: string): SolveResult {
  let f: (v: number) => number;
  let fp: ((v: number) => number) | null = null;
  try {
    const compiled: CompiledFn = compile(F, { angleMode: 'radians' });
    const env: Record<string, number> = {};
    f = (v) => {
      env[x] = v;
      return compiled(env);
    };
  } catch (e) {
    if (e instanceof GcalcError) return { kind: 'no-solution-found', note: e.info.message };
    throw e;
  }
  try {
    const dCompiled = compile(differentiate(F, x), { angleMode: 'radians' });
    const denv: Record<string, number> = {};
    fp = (v) => {
      denv[x] = v;
      return dCompiled(denv);
    };
  } catch {
    fp = null; // not differentiable — Newton disabled, bisection still works
  }

  const roots: number[] = [];
  const pushRoot = (r: number): void => {
    const tol = 1e-7 * Math.max(1, Math.abs(r));
    if (!roots.some((existing) => Math.abs(existing - r) <= tol)) roots.push(r);
  };

  for (const [lo, hi, steps] of SAMPLE_RANGES) {
    let prevX = lo;
    let prevF = f(lo);
    for (let i = 1; i <= steps; i++) {
      const cx = lo + ((hi - lo) * i) / steps;
      const cf = f(cx);
      if (Number.isFinite(prevF) && Math.abs(prevF) < 1e-13) pushRoot(prevX);
      if (Number.isFinite(prevF) && Number.isFinite(cf) && prevF * cf < 0) {
        // Reject asymptote sign flips (1/x at 0): the bracket midpoint of a
        // true root has magnitude no larger than the endpoints' scale.
        const mid = f((prevX + cx) / 2);
        if (Number.isFinite(mid) && Math.abs(mid) <= 4 * Math.max(Math.abs(prevF), Math.abs(cf))) {
          const r = newtonBisect(f, fp, prevX, cx);
          if (r !== null) pushRoot(r);
        }
      }
      prevX = cx;
      prevF = cf;
    }
    if (roots.length > 0) break; // found roots in the tight range — done
  }

  roots.sort((a, b) => a - b);
  return roots.length > 0
    ? { kind: 'numeric', solutions: roots }
    : { kind: 'no-solution-found', note: 'No sign changes found in the search range (|x| ≤ 1000).' };
}

/* ------------------------------------------------------------------ */
/* Entry                                                                */
/* ------------------------------------------------------------------ */

export function solve(equation: Relation, wrt: string): SolveResult {
  if (equation.ops.length !== 1 || equation.ops[0] !== '=') {
    fail({
      kind: 'cas-unsupported',
      message: 'solve needs a single equation (one "=").',
      span: equation.span,
    });
  }
  const F = simplify(sub(equation.operands[0], equation.operands[1]));

  const coeffs = polyCoeffs(F, wrt);
  if (coeffs !== null) {
    const exact = solveExact(trimmed(coeffs), wrt);
    if (exact !== null) return exact;
  }

  // Numeric tier needs a concrete function: any leftover free identifiers
  // (other than the unknown) make it unsolvable here — the engine
  // substitutes slider values before calling when it wants numerics.
  if (hasOtherFreeVars(F, wrt)) {
    return {
      kind: 'no-solution-found',
      note: 'Equation contains other variables — substitute their values first.',
    };
  }
  return solveNumeric(F, wrt);
}

function hasOtherFreeVars(e: Expr, x: string): boolean {
  let found = false;
  const walk = (node: Expr): void => {
    if (found) return;
    if (node.kind === 'ident') {
      if (node.name !== x && !['pi', 'tau', 'e', 'phi'].includes(node.name)) found = true;
      return;
    }
    switch (node.kind) {
      case 'unary':
        walk(node.operand);
        break;
      case 'binary':
        walk(node.left);
        walk(node.right);
        break;
      case 'postfix':
        walk(node.operand);
        break;
      case 'call':
        node.args.forEach(walk);
        break;
      case 'relation':
        node.operands.forEach(walk);
        break;
      case 'restriction':
        walk(node.body);
        node.conditions.forEach(walk);
        break;
      case 'piecewise':
        node.branches.forEach((b) => {
          walk(b.condition);
          walk(b.value);
        });
        if (node.fallback) walk(node.fallback);
        break;
      case 'point':
        walk(node.x);
        walk(node.y);
        break;
      case 'list':
        node.items.forEach(walk);
        break;
      default:
        break;
    }
  };
  walk(e);
  return found;
}

/* ------------------------------------------------------------------ */
/* Basic factoring (CAS_SPEC scope item 1; lives here because it shares */
/* polyCoeffs with the solver)                                          */
/* ------------------------------------------------------------------ */

/**
 * factor(expr, x): common rational factor, difference of squares, and
 * quadratics with rational roots. Returns the input (simplified) when no
 * pattern applies — factoring never fails, it just declines.
 */
export function factor(expr: Expr, x: string): Expr {
  const simplified = simplify(expr);
  const coeffs = polyCoeffs(simplified, x);
  if (coeffs === null) return simplified;
  const rats = trimmed(coeffs).map(asRational);
  if (rats.some((r) => r === null)) return simplified;
  const poly = rats as Rational[];
  const degree = poly.length - 1;
  if (degree < 2) return simplified;

  // Pull out x^k when low coefficients vanish.
  let shift = 0;
  while (shift < poly.length - 1 && poly[shift].isZero) shift++;
  const reduced = poly.slice(shift);

  // Common rational factor of the remaining coefficients (by numerator gcd
  // over denominator lcm) — keep it simple: divide by the leading coeff last.
  const inner = factorMonic(reduced, x);
  if (inner === null) return simplified;

  let result = inner;
  if (shift === 1) result = mul(pow(ident2(x), num(1)), result);
  else if (shift > 1) result = mul(pow(ident2(x), num(shift)), result);
  const out = simplify(result);
  return equal(out, simplified) ? simplified : out;
}

const ident2 = (name: string): Expr => ({ kind: 'ident', name, span: { start: 0, end: 0 } });

function factorMonic(poly: Rational[], x: string): Expr | null {
  const degree = poly.length - 1;
  const X = ident2(x);
  if (degree === 2) {
    const [c, b, a] = poly;
    const disc = b.mul(b).sub(Rational.of(4n).mul(a).mul(c));
    if (disc.sign < 0) return null;
    // Rational roots only — irrational factoring isn't "basic".
    const num2 = disc.n;
    const den2 = disc.d;
    const sn = isqrtLocal(num2);
    const sd = isqrtLocal(den2);
    if (sn === null || sd === null) {
      // difference of squares special case: b = 0, a > 0, c < 0 handled above
      return null;
    }
    const sqrtDisc = Rational.of(sn, sd);
    const twoA = a.mul(Rational.of(2n));
    const r1 = b.neg().sub(sqrtDisc).div(twoA);
    const r2 = b.neg().add(sqrtDisc).div(twoA);
    const factor1 = sub(X, r1.toExpr());
    const factor2 = sub(X, r2.toExpr());
    const lead = a.isOne ? null : a.toExpr();
    const pair = r1.eq(r2) ? pow(factor1, num(2)) : mul(factor1, factor2);
    return lead === null ? pair : mul(lead, pair);
  }
  // Difference of squares for even degree 2k: a·x^2k − c with a,c > 0 squares.
  if (degree % 2 === 0 && poly.length >= 3) {
    const a = poly[degree];
    const c = poly[0];
    const middleZero = poly.slice(1, -1).every((r) => r.isZero);
    if (middleZero && a.sign > 0 && c.sign < 0) {
      const sa = ratSqrt(a);
      const sc = ratSqrt(c.neg());
      if (sa !== null && sc !== null) {
        const half = pow(X, num(degree / 2));
        return mul(sub(mul(sa.toExpr(), half), sc.toExpr()), add(mul(sa.toExpr(), half), sc.toExpr()));
      }
    }
  }
  return null;
}

function isqrtLocal(n: bigint): bigint | null {
  if (n < 0n) return null;
  if (n < 2n) return n;
  let a = n;
  let b = (a + 1n) / 2n;
  while (b < a) {
    a = b;
    b = (a + n / a) / 2n;
  }
  return a * a === n ? a : null;
}

function ratSqrt(r: Rational): Rational | null {
  const sn = isqrtLocal(r.n);
  const sd = isqrtLocal(r.d);
  return sn !== null && sd !== null ? Rational.of(sn, sd) : null;
}
