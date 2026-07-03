// Integration (CAS_SPEC.md M5.4).
//
// integrate(): pattern-table indefinite integration. The strategy stack, in
// order of application per term after linearity splits constants and sums:
//
//   1. base table lookup in the bare variable (sin x, x^n, 1/(1+x²), …)
//   2. the same table through a LINEAR inner function: ∫f(ax+b) = F(ax+b)/a
//   3. u-substitution for recognizable f′(x)·g(f(x)) products
//   4. fixed integration-by-parts patterns (x·sin x, x·eˣ, x²·eˣ, ln x, …)
//
// When nothing matches, integrate() returns null — "we don't know a closed
// form" is an honest answer (general symbolic integration is explicitly out
// of scope; see CAS_SPEC.md / README known limitations).
//
// integrateDefinite(): FTC via integrate() when a closed form exists AND the
// integrand looks well-behaved on [a, b] (sampled); otherwise adaptive
// Simpson quadrature — definite integrals are always answerable barring
// divergence, which reports as NaN.
//
// The correctness contract (tested): every base-table entry differentiates
// back to its integrand, and integrate() results are spot-checked the same
// way; definite results match quadrature.

import type { Expr } from '../core/ast.ts';
import { compile } from '../core/compile.ts';
import { GcalcError } from '../core/errors.ts';
import { evaluate, makeContext } from '../core/evaluator.ts';
import { differentiate } from './differentiate.ts';
import { Rational } from './rational.ts';
import {
  add,
  asRational,
  call,
  div,
  equal,
  ident,
  mul,
  neg,
  num,
  pow,
  simplify,
  sub,
  substitute,
} from './simplify.ts';
import { containsVar, polyCoeffs } from './solve.ts';

/** Internal placeholder variable for table entries (exported for tests). */
export const U = '@u';

const uvar = (): Expr => ident(U);

/* ------------------------------------------------------------------ */
/* Base table: antiderivatives F(u) with ∫f(u)du = F(u), in placeholder u */
/* ------------------------------------------------------------------ */

export interface BasePattern {
  /** Human label for tests/reporting. */
  label: string;
  /** The integrand shape f(u). */
  integrand: Expr;
  /** Its antiderivative F(u). */
  anti: Expr;
}

const lnAbs = (e: Expr): Expr => call('ln', call('abs', e));

/** Every entry is verified by tests: differentiate(anti) ≈ integrand. */
export const BASE_PATTERNS: BasePattern[] = [
  { label: 'sin', integrand: call('sin', uvar()), anti: neg(call('cos', uvar())) },
  { label: 'cos', integrand: call('cos', uvar()), anti: call('sin', uvar()) },
  { label: 'tan', integrand: call('tan', uvar()), anti: neg(lnAbs(call('cos', uvar()))) },
  { label: 'cot', integrand: call('cot', uvar()), anti: lnAbs(call('sin', uvar())) },
  {
    label: 'sec',
    integrand: call('sec', uvar()),
    anti: lnAbs(add(call('sec', uvar()), call('tan', uvar()))),
  },
  {
    label: 'csc',
    integrand: call('csc', uvar()),
    anti: neg(lnAbs(add(call('csc', uvar()), call('cot', uvar())))),
  },
  { label: 'exp', integrand: call('exp', uvar()), anti: call('exp', uvar()) },
  { label: 'sinh', integrand: call('sinh', uvar()), anti: call('cosh', uvar()) },
  { label: 'cosh', integrand: call('cosh', uvar()), anti: call('sinh', uvar()) },
  { label: 'tanh', integrand: call('tanh', uvar()), anti: call('ln', call('cosh', uvar())) },
  { label: 'sec^2', integrand: pow(call('sec', uvar()), num(2)), anti: call('tan', uvar()) },
  { label: 'csc^2', integrand: pow(call('csc', uvar()), num(2)), anti: neg(call('cot', uvar())) },
  {
    label: 'sin^2',
    integrand: pow(call('sin', uvar()), num(2)),
    anti: sub(div(uvar(), num(2)), div(mul(call('sin', uvar()), call('cos', uvar())), num(2))),
  },
  {
    label: 'cos^2',
    integrand: pow(call('cos', uvar()), num(2)),
    anti: add(div(uvar(), num(2)), div(mul(call('sin', uvar()), call('cos', uvar())), num(2))),
  },
  {
    label: '1/(1+u^2) → atan',
    integrand: div(num(1), add(num(1), pow(uvar(), num(2)))),
    anti: call('atan', uvar()),
  },
  {
    label: '1/(1-u^2) → atanh',
    integrand: div(num(1), sub(num(1), pow(uvar(), num(2)))),
    anti: call('atanh', uvar()),
  },
  {
    label: '1/sqrt(1-u^2) → asin',
    integrand: div(num(1), call('sqrt', sub(num(1), pow(uvar(), num(2))))),
    anti: call('asin', uvar()),
  },
  {
    label: '1/sqrt(u^2+1) → asinh',
    integrand: div(num(1), call('sqrt', add(pow(uvar(), num(2)), num(1)))),
    anti: call('asinh', uvar()),
  },
  { label: 'ln', integrand: call('ln', uvar()), anti: sub(mul(uvar(), call('ln', uvar())), uvar()) },
  {
    label: 'log10',
    integrand: call('log', uvar()),
    anti: div(sub(mul(uvar(), call('ln', uvar())), uvar()), call('ln', num(10))),
  },
  {
    label: 'u·sin u (by parts)',
    integrand: mul(uvar(), call('sin', uvar())),
    anti: sub(call('sin', uvar()), mul(uvar(), call('cos', uvar()))),
  },
  {
    label: 'u·cos u (by parts)',
    integrand: mul(uvar(), call('cos', uvar())),
    anti: add(call('cos', uvar()), mul(uvar(), call('sin', uvar()))),
  },
  {
    label: 'u·e^u (by parts)',
    integrand: mul(uvar(), call('exp', uvar())),
    anti: mul(sub(uvar(), num(1)), call('exp', uvar())),
  },
  {
    label: 'u^2·e^u (by parts twice)',
    integrand: mul(pow(uvar(), num(2)), call('exp', uvar())),
    anti: mul(add(sub(pow(uvar(), num(2)), mul(num(2), uvar())), num(2)), call('exp', uvar())),
  },
  {
    label: 'u·ln u (by parts)',
    integrand: mul(uvar(), call('ln', uvar())),
    anti: sub(mul(div(pow(uvar(), num(2)), num(2)), call('ln', uvar())), div(pow(uvar(), num(2)), num(4))),
  },
  {
    label: 'u^2·sin u',
    integrand: mul(pow(uvar(), num(2)), call('sin', uvar())),
    anti: add(
      sub(mul(num(2), mul(uvar(), call('sin', uvar()))), mul(pow(uvar(), num(2)), call('cos', uvar()))),
      mul(num(2), call('cos', uvar())),
    ),
  },
  {
    label: 'u^2·cos u',
    integrand: mul(pow(uvar(), num(2)), call('cos', uvar())),
    anti: sub(
      add(mul(pow(uvar(), num(2)), call('sin', uvar())), mul(num(2), mul(uvar(), call('cos', uvar())))),
      mul(num(2), call('sin', uvar())),
    ),
  },
  {
    label: 'sin u · cos u',
    integrand: mul(call('sin', uvar()), call('cos', uvar())),
    anti: div(pow(call('sin', uvar()), num(2)), num(2)),
  },
  {
    label: 'sec u · tan u',
    integrand: mul(call('sec', uvar()), call('tan', uvar())),
    anti: call('sec', uvar()),
  },
  {
    label: 'e^u · sin u',
    integrand: mul(call('exp', uvar()), call('sin', uvar())),
    anti: div(mul(call('exp', uvar()), sub(call('sin', uvar()), call('cos', uvar()))), num(2)),
  },
  {
    label: 'e^u · cos u',
    integrand: mul(call('exp', uvar()), call('cos', uvar())),
    anti: div(mul(call('exp', uvar()), add(call('sin', uvar()), call('cos', uvar()))), num(2)),
  },
  { label: 'abs', integrand: call('abs', uvar()), anti: div(mul(uvar(), call('abs', uvar())), num(2)) },
];

/** Table keyed by canonical shape for O(1) lookup. */
const tableByKey = new Map<string, BasePattern>();
for (const p of BASE_PATTERNS) {
  tableByKey.set(canonKey(simplify(p.integrand)), p);
}

function canonKey(e: Expr): string {
  return JSON.stringify(stripKey(e));
}

function stripKey(e: Expr): unknown {
  switch (e.kind) {
    case 'num':
      return e.value;
    case 'ident':
      return e.name;
    case 'unary':
      return [e.op, stripKey(e.operand)];
    case 'binary':
      return [e.op, stripKey(e.left), stripKey(e.right)];
    case 'call':
      return [e.callee, ...e.args.map(stripKey)];
    default:
      return ['?']; // non-scalar nodes never appear in table shapes
  }
}

/* ------------------------------------------------------------------ */
/* Indefinite integration                                              */
/* ------------------------------------------------------------------ */

export function integrate(expr: Expr, wrt: string): Expr | null {
  const result = integrateExpr(normalizeExp(simplify(expr)), wrt);
  return result === null ? null : simplify(result);
}

/**
 * Canonicalize exponentials for matching: e^g → exp(g), and a^g (a a
 * positive constant) → exp(g·ln a). The parser and simplifier keep the
 * user-visible pow forms; this rewrite is local to integration.
 */
function normalizeExp(e: Expr): Expr {
  const walked = mapChildren(e, normalizeExp);
  if (walked.kind === 'binary' && walked.op === '^') {
    if (walked.left.kind === 'ident' && walked.left.name === 'e') {
      return call('exp', walked.right);
    }
    const base = asRational(walked.left);
    const expIsConst = asRational(walked.right) !== null;
    if (base !== null && base.sign > 0 && !base.isOne && !expIsConst) {
      return call('exp', mul(walked.right, call('ln', walked.left)));
    }
  }
  return walked;
}

function mapChildren(e: Expr, f: (c: Expr) => Expr): Expr {
  switch (e.kind) {
    case 'num':
    case 'ident':
      return e;
    case 'unary':
      return { ...e, operand: f(e.operand) };
    case 'binary':
      return { ...e, left: f(e.left), right: f(e.right) };
    case 'postfix':
      return { ...e, operand: f(e.operand) };
    case 'call':
      return { ...e, args: e.args.map(f) };
    default:
      return e; // relations/points/lists never reach the integrator's core
  }
}

function integrateExpr(e: Expr, x: string): Expr | null {
  // Linearity over sums.
  if (e.kind === 'binary' && (e.op === '+' || e.op === '-')) {
    const l = integrateExpr(e.left, x);
    if (l === null) return null;
    const r = integrateExpr(e.right, x);
    if (r === null) return null;
    return e.op === '+' ? add(l, r) : sub(l, r);
  }
  if (e.kind === 'unary' && e.op === '-') {
    const inner = integrateExpr(e.operand, x);
    return inner === null ? null : neg(inner);
  }

  // Constants: ∫c dx = c·x.
  if (!containsVar(e, x)) return mul(e, ident(x));

  // Pull constant factors out of products/quotients.
  const pulled = pullConstantFactor(e, x);
  if (pulled !== null) {
    const inner = integrateExpr(pulled.rest, x);
    return inner === null ? null : mul(pulled.constant, inner);
  }

  // Pure powers of a linear inner: (ax+b)^n, 1/(ax+b), sqrt(ax+b), …
  const powerResult = integratePower(e, x);
  if (powerResult !== null) return powerResult;

  // Base table in x directly or through a linear substitution.
  const viaTable = tableLookup(e, x);
  if (viaTable !== null) return viaTable;

  // u-substitution: f′(x)·g(f(x)).
  const viaU = uSubstitution(e, x);
  if (viaU !== null) return viaU;

  return null;
}

/** c·f (c free of x) → {constant: c, rest: f}, else null. */
function pullConstantFactor(e: Expr, x: string): { constant: Expr; rest: Expr } | null {
  if (e.kind === 'binary' && e.op === '*') {
    if (!containsVar(e.left, x)) return { constant: e.left, rest: e.right };
    if (!containsVar(e.right, x)) return { constant: e.right, rest: e.left };
  }
  if (e.kind === 'binary' && e.op === '/') {
    if (!containsVar(e.right, x) && containsVar(e.left, x)) {
      return { constant: div(num(1), e.right), rest: e.left };
    }
    if (!containsVar(e.left, x) && !equal(e.left, num(1))) {
      return { constant: e.left, rest: div(num(1), e.right) };
    }
  }
  return null;
}

/** The inner expression when e is linear in x with constant coefficients:
 * returns {inner: ax+b as Expr, a: slope Expr} — identity counts (a = 1). */
function linearInner(e: Expr, x: string): { a: Expr } | null {
  const coeffs = polyCoeffs(e, x);
  if (coeffs === null) return null;
  const trimmedLen = coeffs.length;
  if (trimmedLen > 2) return null;
  const a = coeffs[1] ?? num(0);
  if (containsVar(a, x) || (asRational(simplify(a))?.isZero ?? false)) return null;
  return { a };
}

/** Power-rule family with a linear inner: (ax+b)^n including n = −1, ±1/2. */
function integratePower(e: Expr, x: string): Expr | null {
  // 1/(ax+b) and 1/(ax+b)^n arrive as division.
  if (e.kind === 'binary' && e.op === '/' && !containsVar(e.left, x)) {
    const den = e.right;
    if (den.kind === 'binary' && den.op === '^') {
      const inner = integratePower(pow(den.left, neg(den.right)), x);
      return inner === null ? null : mul(e.left, inner);
    }
    const lin = linearInner(den, x);
    if (lin !== null) {
      return mul(e.left, div(lnAbs(den), lin.a)); // ∫ 1/(ax+b) = ln|ax+b|/a
    }
    return null;
  }

  let base: Expr;
  let exponent: Rational;
  if (e.kind === 'binary' && e.op === '^') {
    const r = asRational(simplify(e.right));
    if (r === null) return null;
    base = e.left;
    exponent = r;
  } else if (e.kind === 'call' && e.callee === 'sqrt' && e.args.length === 1) {
    base = e.args[0];
    exponent = Rational.of(1n, 2n);
  } else if (e.kind === 'ident' && e.name === x) {
    base = e;
    exponent = Rational.ONE;
  } else {
    return null;
  }

  const lin = linearInner(base, x);
  if (lin === null) return null;

  if (exponent.eq(Rational.of(-1n))) {
    return div(lnAbs(base), lin.a);
  }
  const n1 = exponent.add(Rational.ONE);
  // ∫(ax+b)^n = (ax+b)^(n+1) / (a·(n+1))
  return div(pow(base, n1.toExpr()), mul(lin.a, n1.toExpr()));
}

/** Direct table hit in x, or through a linear inner function. */
function tableLookup(e: Expr, x: string): Expr | null {
  // Direct: the integrand written in the bare variable (covers compound
  // shapes like 1/√(1−x²) or x·sin x, where the "inner" is x itself).
  const directKey = canonKey(simplify(substitute(e, x, uvar())));
  const direct = tableByKey.get(directKey);
  if (direct !== undefined) return substitute(direct.anti, U, ident(x));

  // Linear inner: all calls share one argument f = ax+b and no bare x
  // remains outside the calls → ∫g(f) dx = G(f)/a.
  const inner = extractInner(e, x);
  if (inner === null || (inner.kind === 'ident' && inner.name === x)) return null;
  const lin = linearInner(inner, x);
  if (lin === null) return null;
  const replaced = substituteInner(e, inner);
  if (containsVar(replaced, x)) return null; // mixed shape — not this path
  const hit = tableByKey.get(canonKey(simplify(replaced)));
  if (hit === undefined) return null;
  const anti = substitute(hit.anti, U, inner);
  return div(anti, lin.a); // chain-rule correction for the linear inner
}

/** The common argument of all calls in e (must agree), else null. */
function extractInner(e: Expr, x: string): Expr | null {
  let inner: Expr | null = null;
  let failed = false;
  const visit = (node: Expr): void => {
    if (failed) return;
    if (node.kind === 'call') {
      if (node.args.length !== 1) {
        failed = true;
        return;
      }
      const arg = node.args[0];
      if (inner === null) inner = arg;
      else if (!equal(inner, arg)) failed = true;
      return; // don't descend into call args
    }
    switch (node.kind) {
      case 'unary':
        visit(node.operand);
        break;
      case 'binary':
        visit(node.left);
        visit(node.right);
        break;
      case 'ident':
        if (node.name === x) {
          // a bare x outside any call: inner must be x itself
          if (inner === null) inner = node;
          else if (!(inner.kind === 'ident' && inner.name === x)) failed = true;
        }
        break;
      default:
        break;
    }
  };
  visit(e);
  return failed ? null : inner;
}

/** Rewrite e with the inner argument replaced by the placeholder u. */
function substituteInner(e: Expr, inner: Expr): Expr {
  if (equal(e, inner)) return uvar();
  switch (e.kind) {
    case 'num':
    case 'ident':
      return e;
    case 'unary':
      return { ...e, operand: substituteInner(e.operand, inner) };
    case 'binary':
      return {
        ...e,
        left: substituteInner(e.left, inner),
        right: substituteInner(e.right, inner),
      };
    case 'call':
      return { ...e, args: e.args.map((a) => (equal(a, inner) ? uvar() : substituteInner(a, inner))) };
    default:
      return e;
  }
}

/** u-substitution: match rest·g(f) where rest/f′ is constant. */
function uSubstitution(e: Expr, x: string): Expr | null {
  // h/f is h·f⁻¹ — the power branch below handles g(u) = u^(−1) via ln|u|.
  if (e.kind === 'binary' && e.op === '/' && containsVar(e.right, x)) {
    return uSubstitution(mul(e.left, pow(e.right, num(-1))), x);
  }
  if (e.kind !== 'binary' || e.op !== '*') return null;
  const candidates: Array<[Expr, Expr]> = [
    [e.left, e.right],
    [e.right, e.left],
  ];
  for (const [gPart, hPart] of candidates) {
    // g(f(x)) where g is table-known (or a power of f).
    let f: Expr | null = null;
    let gOfU: Expr | null = null;
    if (gPart.kind === 'call' && gPart.args.length === 1 && containsVar(gPart.args[0], x)) {
      f = gPart.args[0];
      gOfU = { ...gPart, args: [uvar()] };
    } else if (
      gPart.kind === 'binary' &&
      gPart.op === '^' &&
      containsVar(gPart.left, x) &&
      asRational(gPart.right) !== null
    ) {
      f = gPart.left;
      gOfU = pow(uvar(), gPart.right);
    }
    if (f === null || gOfU === null) continue;
    if (f.kind === 'ident') continue; // that's the plain table path
    let fPrime: Expr;
    try {
      fPrime = differentiate(f, x);
    } catch (err) {
      if (err instanceof GcalcError) continue;
      throw err;
    }
    const ratio = simplify(div(hPart, fPrime));
    if (containsVar(ratio, x)) continue;
    // ∫ h·g(f) dx = ratio · G(f)
    const gAnti = integrateExpr(gOfU, U);
    if (gAnti === null) continue;
    return mul(ratio, substitute(gAnti, U, f));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Definite integration                                                */
/* ------------------------------------------------------------------ */

export function integrateDefinite(expr: Expr, wrt: string, a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  if (a === b) return 0;

  const compiled = compile(simplify(expr), { angleMode: 'radians' });
  const env: Record<string, number> = {};
  const f = (v: number): number => {
    env[wrt] = v;
    return compiled(env);
  };

  // Probe the integrand: FTC is only trusted on well-behaved intervals.
  let behaved = true;
  for (let i = 0; i <= 64; i++) {
    const v = f(a + ((b - a) * i) / 64);
    if (!Number.isFinite(v)) {
      behaved = false;
      break;
    }
  }

  if (behaved) {
    const anti = integrate(expr, wrt);
    if (anti !== null) {
      const evalAt = (v: number): number =>
        evaluate(anti, makeContext({ variables: new Map([[wrt, v]]) }));
      try {
        const hi = evalAt(b);
        const lo = evalAt(a);
        if (Number.isFinite(hi) && Number.isFinite(lo)) return hi - lo;
      } catch {
        // fall through to quadrature
      }
    }
  }

  return adaptiveSimpson(f, a, b);
}

function simpson(f: (x: number) => number, a: number, b: number): number {
  const m = (a + b) / 2;
  return ((b - a) / 6) * (f(a) + 4 * f(m) + f(b));
}

function adaptiveSimpson(f: (x: number) => number, a: number, b: number): number {
  const whole = simpson(f, a, b);
  const result = adaptStep(f, a, b, whole, 1e-10 * Math.max(1, Math.abs(whole)), 24);
  return result;
}

function adaptStep(
  f: (x: number) => number,
  a: number,
  b: number,
  whole: number,
  tol: number,
  depth: number,
): number {
  const m = (a + b) / 2;
  const left = simpson(f, a, m);
  const right = simpson(f, m, b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN; // divergence
  if (depth <= 0 || Math.abs(left + right - whole) <= 15 * tol) {
    return left + right + (left + right - whole) / 15;
  }
  const l = adaptStep(f, a, m, left, tol / 2, depth - 1);
  const r = adaptStep(f, m, b, right, tol / 2, depth - 1);
  return l + r;
}
