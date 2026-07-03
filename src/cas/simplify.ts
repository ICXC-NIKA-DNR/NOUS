// simplify(expr): rewrite rules applied bottom-up to a fixed point
// (CAS_SPEC.md M5.2; the engine and the constant-folding/identity core land
// with M5.1 so differentiate() output is readable).
//
// Correctness invariant (property-tested): for any expression e and any
// point, evaluate(simplify(e)) ≈ evaluate(e). Rules may only rewrite to
// numerically-equal forms — modulo measure-zero caveats like x/x → 1, which
// changes the value only where the original was undefined (0/0 → NaN).
// Desmos and every classroom CAS make the same trade; we note it here once.
//
// Constant folding is exact via Rational — 1/3 + 1/6 folds to 1/2, and
// literals that would NOT round-trip exactly through a double (e.g. huge
// numerators) are left unfolded rather than approximated.

import type { Expr, Span } from '../core/ast.ts';
import { Rational } from './rational.ts';

const SPAN: Span = { start: 0, end: 0 };

/* ------------------------------------------------------------------ */
/* Constructors (synthetic nodes carry a zero span)                    */
/* ------------------------------------------------------------------ */

export const num = (value: number): Expr =>
  value < 0
    ? { kind: 'unary', op: '-', operand: { kind: 'num', value: -value, span: SPAN }, span: SPAN }
    : { kind: 'num', value, span: SPAN };

export const ident = (name: string): Expr => ({ kind: 'ident', name, span: SPAN });

export const add = (left: Expr, right: Expr): Expr =>
  ({ kind: 'binary', op: '+', left, right, span: SPAN });

export const sub = (left: Expr, right: Expr): Expr =>
  ({ kind: 'binary', op: '-', left, right, span: SPAN });

export const mul = (left: Expr, right: Expr): Expr =>
  ({ kind: 'binary', op: '*', left, right, span: SPAN });

export const div = (left: Expr, right: Expr): Expr =>
  ({ kind: 'binary', op: '/', left, right, span: SPAN });

export const pow = (left: Expr, right: Expr): Expr =>
  ({ kind: 'binary', op: '^', left, right, span: SPAN });

export const neg = (operand: Expr): Expr => ({ kind: 'unary', op: '-', operand, span: SPAN });

export const call = (callee: string, ...args: Expr[]): Expr =>
  ({ kind: 'call', callee, args, parens: true, span: SPAN });

/* ------------------------------------------------------------------ */
/* Rational extraction                                                 */
/* ------------------------------------------------------------------ */

/** Constant subtrees (nums, ±, and ratios of them) as an exact Rational. */
export function asRational(e: Expr): Rational | null {
  switch (e.kind) {
    case 'num':
      return Rational.fromNumber(e.value);
    case 'unary': {
      const inner = asRational(e.operand);
      return inner === null ? null : e.op === '-' ? inner.neg() : inner;
    }
    case 'binary': {
      if (e.op !== '/') return null;
      const l = asRational(e.left);
      const r = asRational(e.right);
      return l === null || r === null || r.isZero ? null : l.div(r);
    }
    default:
      return null;
  }
}

const isZero = (e: Expr): boolean => asRational(e)?.isZero ?? false;
const isOne = (e: Expr): boolean => asRational(e)?.isOne ?? false;

/** Structural equality (spans ignored). */
export function equal(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'num':
      return a.value === (b as typeof a).value;
    case 'ident':
      return a.name === (b as typeof a).name;
    case 'unary': {
      const bb = b as typeof a;
      return a.op === bb.op && equal(a.operand, bb.operand);
    }
    case 'binary': {
      const bb = b as typeof a;
      return a.op === bb.op && equal(a.left, bb.left) && equal(a.right, bb.right);
    }
    case 'postfix':
      return equal(a.operand, (b as typeof a).operand);
    case 'call': {
      const bb = b as typeof a;
      return (
        a.callee === bb.callee &&
        a.args.length === bb.args.length &&
        a.args.every((arg, i) => equal(arg, bb.args[i]))
      );
    }
    case 'relation': {
      const bb = b as typeof a;
      return (
        a.ops.length === bb.ops.length &&
        a.ops.every((op, i) => op === bb.ops[i]) &&
        a.operands.every((o, i) => equal(o, bb.operands[i]))
      );
    }
    case 'restriction': {
      const bb = b as typeof a;
      return (
        equal(a.body, bb.body) &&
        a.conditions.length === bb.conditions.length &&
        a.conditions.every((c, i) => equal(c, bb.conditions[i]))
      );
    }
    case 'piecewise': {
      const bb = b as typeof a;
      return (
        a.branches.length === bb.branches.length &&
        a.branches.every(
          (br, i) => equal(br.condition, bb.branches[i].condition) && equal(br.value, bb.branches[i].value),
        ) &&
        (a.fallback === undefined) === (bb.fallback === undefined) &&
        (a.fallback === undefined || equal(a.fallback, bb.fallback!))
      );
    }
    case 'point': {
      const bb = b as typeof a;
      return equal(a.x, bb.x) && equal(a.y, bb.y);
    }
    case 'list': {
      const bb = b as typeof a;
      return a.items.length === bb.items.length && a.items.every((it, i) => equal(it, bb.items[i]));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

type Rule = (e: Expr) => Expr | null;

/** Fold constant binary/unary arithmetic exactly; null when not applicable
 * or the exact result would not survive the trip back into a literal. */
const foldConstants: Rule = (e) => {
  if (e.kind === 'unary' && e.op === '+') return e.operand;
  if (e.kind !== 'binary') return null;
  const l = asRational(e.left);
  const r = asRational(e.right);
  if (l === null || r === null) return null;
  let result: Rational;
  switch (e.op) {
    case '+':
      result = l.add(r);
      break;
    case '-':
      result = l.sub(r);
      break;
    case '*':
      result = l.mul(r);
      break;
    case '/':
      if (r.isZero) return null; // leave 1/0 to the numeric layer
      result = l.div(r);
      break;
    case '^': {
      if (!r.isInteger) return null; // fractional exponents stay symbolic
      const k = r.n;
      if (k > 64n || k < -64n) return null; // keep literals sane
      if (l.isZero && k < 0n) return null;
      result = l.pow(k);
      break;
    }
    default:
      return null;
  }
  const folded = result.toExpr();
  // A fold that reproduces the input shape (e.g. 1/3 → 1/3) is a no-op;
  // returning it would defeat the fixed-point check.
  return equal(folded, e) ? null : folded;
};

/** Identity elimination — the cleanup that makes derivatives readable. */
const identities: Rule = (e) => {
  if (e.kind === 'unary' && e.op === '-') {
    // -(-x) → x
    if (e.operand.kind === 'unary' && e.operand.op === '-') return e.operand.operand;
    // -(0) → 0
    if (isZero(e.operand)) return num(0);
    // -(a - b) → b - a
    if (e.operand.kind === 'binary' && e.operand.op === '-') {
      return sub(e.operand.right, e.operand.left);
    }
    return null;
  }
  if (e.kind !== 'binary') return null;
  const { op, left, right } = e;
  switch (op) {
    case '+':
      if (isZero(left)) return right;
      if (isZero(right)) return left;
      // x + (-y) → x - y
      if (right.kind === 'unary' && right.op === '-') return sub(left, right.operand);
      break;
    case '-':
      if (isZero(right)) return left;
      if (isZero(left)) return neg(right);
      // x - (-y) → x + y
      if (right.kind === 'unary' && right.op === '-') return add(left, right.operand);
      if (equal(left, right)) return num(0);
      break;
    case '*':
      if (isZero(left) || isZero(right)) return num(0);
      if (isOne(left)) return right;
      if (isOne(right)) return left;
      // (-x)·y → -(x·y);  x·(-y) → -(x·y)
      if (left.kind === 'unary' && left.op === '-') return neg(mul(left.operand, right));
      if (right.kind === 'unary' && right.op === '-') return neg(mul(left, right.operand));
      // constants to the left: x·c → c·x (canonical order for later rules)
      if (asRational(right) !== null && asRational(left) === null) return mul(right, left);
      break;
    case '/':
      if (isZero(left)) return num(0); // caveat: 0/0 was NaN; now 0 (a.e. convention)
      if (isOne(right)) return left;
      if (equal(left, right)) return num(1); // caveat: x/x at x=0
      // (-x)/y → -(x/y); x/(-y) → -(x/y)
      if (left.kind === 'unary' && left.op === '-') return neg(div(left.operand, right));
      if (right.kind === 'unary' && right.op === '-') return neg(div(left, right.operand));
      break;
    case '^':
      if (isOne(right)) return left;
      if (isZero(right)) return num(1); // 0^0 = 1 by convention (matches Math.pow)
      if (isOne(left)) return num(1);
      // (x^a)^b → x^(a·b) for constant a, b
      if (left.kind === 'binary' && left.op === '^') {
        const a = asRational(left.right);
        const b = asRational(right);
        if (a !== null && b !== null) return pow(left.left, a.mul(b).toExpr());
      }
      break;
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* Like-term and power collection (M5.2)                               */
/* ------------------------------------------------------------------ */

interface SumTerm {
  coeff: Rational;
  /** null = pure constant term. */
  core: Expr | null;
}

/** term → coeff · core, pulling rational factors out. */
function splitCoeff(e: Expr): SumTerm {
  const r = asRational(e);
  if (r !== null) return { coeff: r, core: null };
  if (e.kind === 'unary' && e.op === '-') {
    const inner = splitCoeff(e.operand);
    return { coeff: inner.coeff.neg(), core: inner.core };
  }
  if (e.kind === 'binary' && e.op === '*') {
    const lr = asRational(e.left);
    if (lr !== null) {
      const rest = splitCoeff(e.right);
      return { coeff: lr.mul(rest.coeff), core: rest.core };
    }
    const rr = asRational(e.right);
    if (rr !== null) {
      const rest = splitCoeff(e.left);
      return { coeff: rr.mul(rest.coeff), core: rest.core };
    }
  }
  if (e.kind === 'binary' && e.op === '/') {
    const rr = asRational(e.right);
    if (rr !== null && !rr.isZero) {
      const rest = splitCoeff(e.left);
      return { coeff: rest.coeff.div(rr), core: rest.core };
    }
    const lr = asRational(e.left);
    if (lr !== null) {
      // c/f → c · (1/f); keyed on 1/f so 2/x + 3/x collect.
      return { coeff: lr, core: div(num(1), e.right) };
    }
  }
  return { coeff: Rational.ONE, core: e };
}

function flattenSum(e: Expr, sign: Rational, out: SumTerm[]): void {
  if (e.kind === 'binary' && e.op === '+') {
    flattenSum(e.left, sign, out);
    flattenSum(e.right, sign, out);
    return;
  }
  if (e.kind === 'binary' && e.op === '-') {
    flattenSum(e.left, sign, out);
    flattenSum(e.right, sign.neg(), out);
    return;
  }
  if (e.kind === 'unary' && e.op === '-') {
    flattenSum(e.operand, sign.neg(), out);
    return;
  }
  const t = splitCoeff(e);
  out.push({ coeff: t.coeff.mul(sign), core: t.core });
}

/** `sin(u)^2` → u, else null (and the cos twin). */
function squaredTrigArg(e: Expr, fn: 'sin' | 'cos'): Expr | null {
  if (e.kind !== 'binary' || e.op !== '^') return null;
  const exp = asRational(e.right);
  if (exp === null || !exp.eq(Rational.of(2n))) return null;
  const base = e.left;
  if (base.kind !== 'call' || base.callee !== fn || base.args.length !== 1) return null;
  return base.args[0];
}

const collectSum: Rule = (e) => {
  if (e.kind !== 'binary' || (e.op !== '+' && e.op !== '-')) return null;
  const raw: SumTerm[] = [];
  flattenSum(e, Rational.ONE, raw);

  // Merge by canonical key, preserving first-seen order.
  const order: string[] = [];
  const merged = new Map<string, { coeff: Rational; core: Expr }>();
  let constant = Rational.ZERO;
  for (const t of raw) {
    if (t.core === null) {
      constant = constant.add(t.coeff);
      continue;
    }
    const key = sexprKey(t.core);
    const hit = merged.get(key);
    if (hit) hit.coeff = hit.coeff.add(t.coeff);
    else {
      merged.set(key, { coeff: t.coeff, core: t.core });
      order.push(key);
    }
  }

  // Pythagorean fold: c1·sin²(u) + c2·cos²(u) → c2 + (c1−c2)·sin²(u).
  for (const key of [...order]) {
    const entry = merged.get(key);
    if (!entry) continue;
    const u = squaredTrigArg(entry.core, 'sin');
    if (u === null) continue;
    const cosKey = sexprKey(pow(call('cos', u), num(2)));
    const twin = merged.get(cosKey);
    if (!twin) continue;
    constant = constant.add(twin.coeff);
    const residue = entry.coeff.sub(twin.coeff);
    merged.delete(cosKey);
    if (residue.isZero) merged.delete(key);
    else entry.coeff = residue;
  }

  // Rebuild, sign-stable: positive terms (first-seen order), then a positive
  // constant, then negative terms, then a negative constant. This keeps
  // shapes like `1 - 1/x` from churning into `-1/x + 1`.
  let result: Expr | null = null;
  const append = (term: Expr, negative: boolean): void => {
    if (result === null) result = negative ? neg(term) : term;
    else result = negative ? sub(result, term) : add(result, term);
  };
  const termExpr = (entry: { coeff: Rational; core: Expr }): Expr => {
    const c = entry.coeff.abs();
    return c.isOne ? entry.core : mul(c.toExpr(), entry.core);
  };
  for (const key of order) {
    const entry = merged.get(key);
    if (entry && entry.coeff.sign > 0) append(termExpr(entry), false);
  }
  if (constant.sign > 0) append(constant.toExpr(), false);
  for (const key of order) {
    const entry = merged.get(key);
    if (entry && entry.coeff.sign < 0) append(termExpr(entry), true);
  }
  if (constant.sign < 0) append(constant.neg().toExpr(), true);
  const rebuilt = result ?? num(0);
  return equal(rebuilt, e) ? null : rebuilt;
};

interface Factor {
  base: Expr;
  /** Rational part of the exponent. */
  expRat: Rational;
  /** Symbolic exponent addends (non-rational). */
  expSyms: Expr[];
}

function flattenProduct(e: Expr, invert: boolean, factors: Factor[], state: { coeff: Rational; sign: number }): void {
  const r = asRational(e);
  if (r !== null) {
    state.coeff = invert ? (r.isZero ? state.coeff : state.coeff.div(r)) : state.coeff.mul(r);
    if (invert && r.isZero) factors.push({ base: e, expRat: Rational.of(-1n), expSyms: [] });
    return;
  }
  if (e.kind === 'unary' && e.op === '-') {
    state.sign = -state.sign;
    flattenProduct(e.operand, invert, factors, state);
    return;
  }
  if (e.kind === 'binary' && e.op === '*') {
    flattenProduct(e.left, invert, factors, state);
    flattenProduct(e.right, invert, factors, state);
    return;
  }
  if (e.kind === 'binary' && e.op === '/') {
    flattenProduct(e.left, invert, factors, state);
    flattenProduct(e.right, !invert, factors, state);
    return;
  }
  let base = e;
  let expRat = Rational.ONE;
  let expSym: Expr | null = null;
  if (e.kind === 'binary' && e.op === '^') {
    const er = asRational(e.right);
    if (er !== null) {
      base = e.left;
      expRat = er;
    } else {
      base = e.left;
      expRat = Rational.ZERO;
      expSym = e.right;
    }
  }
  if (invert) {
    expRat = expRat.neg();
    if (expSym !== null) expSym = neg(expSym);
  }
  factors.push({ base, expRat, expSyms: expSym === null ? [] : [expSym] });
}

const collectProduct: Rule = (e) => {
  if (e.kind !== 'binary' || (e.op !== '*' && e.op !== '/')) return null;
  const flat: Factor[] = [];
  const state = { coeff: Rational.ONE, sign: 1 };
  flattenProduct(e, false, flat, state);
  if (state.coeff.isZero) return num(0);

  const order: string[] = [];
  const merged = new Map<string, Factor>();
  for (const f of flat) {
    const key = sexprKey(f.base);
    const hit = merged.get(key);
    if (hit) {
      hit.expRat = hit.expRat.add(f.expRat);
      hit.expSyms.push(...f.expSyms);
    } else {
      merged.set(key, { base: f.base, expRat: f.expRat, expSyms: [...f.expSyms] });
      order.push(key);
    }
  }

  const numerator: Expr[] = [];
  const denominator: Expr[] = [];
  for (const key of order) {
    const f = merged.get(key)!;
    if (f.expSyms.length > 0) {
      // Symbolic exponent: rebuild as base^(sym + … + rat) in the numerator.
      let exp: Expr = f.expSyms[0];
      for (let i = 1; i < f.expSyms.length; i++) exp = add(exp, f.expSyms[i]);
      if (!f.expRat.isZero) exp = add(exp, f.expRat.toExpr());
      numerator.push(pow(f.base, exp));
      continue;
    }
    if (f.expRat.isZero) continue; // x^0 → 1 (a.e. — same caveat as x/x)
    if (f.expRat.sign > 0) {
      numerator.push(f.expRat.isOne ? f.base : pow(f.base, f.expRat.toExpr()));
    } else {
      const p = f.expRat.neg();
      denominator.push(p.isOne ? f.base : pow(f.base, p.toExpr()));
    }
  }

  const coeff = state.sign < 0 ? state.coeff.neg() : state.coeff;
  const product = (parts: Expr[]): Expr | null =>
    parts.length === 0 ? null : parts.reduce((acc, p) => mul(acc, p));

  let top = product(numerator);
  const bottom = product(denominator);
  // Coefficient placement: numerator unless it's 1 (or -1, which negates).
  if (top === null) top = coeff.abs().isOne ? num(1) : coeff.abs().toExpr();
  else if (!coeff.abs().isOne) top = mul(coeff.abs().toExpr(), top);
  let rebuilt: Expr = bottom === null ? top : div(top, bottom);
  if (coeff.sign < 0) rebuilt = neg(rebuilt);
  return equal(rebuilt, e) ? null : rebuilt;
};

/* ------------------------------------------------------------------ */
/* Function-level rules: inverses and exact special values             */
/* ------------------------------------------------------------------ */

function isqrt(n: bigint): bigint | null {
  if (n < 0n) return null;
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x * x === n ? x : null;
}

/** Largest k with k² dividing n (n > 0). Trial division, fine at CAS scale. */
function largestSquareDivisor(n: bigint): bigint {
  let k = 1n;
  let m = n;
  for (let p = 2n; p * p <= m && p < 100000n; p++) {
    while (m % (p * p) === 0n) {
      m /= p * p;
      k *= p;
    }
  }
  return k;
}

function icbrt(n: bigint): bigint | null {
  const negative = n < 0n;
  let m = negative ? -n : n;
  if (m < 2n) return negative ? -m : m;
  let x = m;
  let y = (2n * x + m / (x * x)) / 3n;
  while (y < x) {
    x = y;
    y = (2n * x + m / (x * x)) / 3n;
  }
  return x * x * x === m ? (negative ? -x : x) : null;
}

const ZERO_AT_ZERO = new Set(['sin', 'tan', 'sinh', 'tanh', 'asin', 'atan', 'arcsin', 'arctan', 'asinh', 'atanh']);
const ONE_AT_ZERO = new Set(['cos', 'cosh', 'exp']);

const callRules: Rule = (e) => {
  if (e.kind === 'binary' && e.op === '^') {
    // abs(u)^even → u^even
    const exp = asRational(e.right);
    if (
      exp !== null &&
      exp.isInteger &&
      exp.n % 2n === 0n &&
      e.left.kind === 'call' &&
      e.left.callee === 'abs' &&
      e.left.args.length === 1
    ) {
      return pow(e.left.args[0], e.right);
    }
    return null;
  }
  if (e.kind !== 'call' || e.args.length !== 1) return null;
  const u = e.args[0];

  // Inverse compositions (a.e. domain caveats accepted, like x/x → 1).
  if (e.callee === 'ln') {
    if (u.kind === 'call' && u.callee === 'exp' && u.args.length === 1) return u.args[0];
    if (u.kind === 'ident' && u.name === 'e') return num(1);
    if (u.kind === 'binary' && u.op === '^' && u.left.kind === 'ident' && u.left.name === 'e') {
      return u.right;
    }
  }
  if (e.callee === 'exp' && u.kind === 'call' && u.callee === 'ln' && u.args.length === 1) {
    return u.args[0];
  }
  if (e.callee === 'sqrt' && u.kind === 'binary' && u.op === '^') {
    const exp = asRational(u.right);
    if (exp !== null && exp.eq(Rational.of(2n))) return call('abs', u.left);
  }

  // Exact special values on rational arguments.
  const r = asRational(u);
  if (r === null) return null;
  if (r.isZero && ZERO_AT_ZERO.has(e.callee)) return num(0);
  if (r.isZero && ONE_AT_ZERO.has(e.callee)) return num(1);
  if (r.isOne && e.callee === 'ln') return num(0);
  switch (e.callee) {
    case 'abs':
      return r.sign < 0 ? r.neg().toExpr() : null;
    case 'sign':
      return num(r.sign);
    case 'floor':
      return r.isInteger ? null : Rational.of(r.n >= 0n ? r.n / r.d : r.n / r.d - 1n).toExpr();
    case 'ceil':
      return r.isInteger ? null : Rational.of(r.n > 0n ? r.n / r.d + 1n : r.n / r.d).toExpr();
    case 'sqrt': {
      const sn = isqrt(r.n);
      const sd = isqrt(r.d);
      if (sn !== null && sd !== null) return Rational.of(sn, sd).toExpr();
      if (r.sign < 0) return null;
      // Radical simplification: √(p/q) = √(pq)/q; pull the largest square
      // factor k out of pq → (k/q)·√m. √8 → 2√2, √(1/2) → (1/2)·√2.
      const m = r.n * r.d;
      const k = largestSquareDivisor(m);
      if (k === 1n) return null;
      const coeff = Rational.of(k, r.d);
      const radicand = Rational.of(m / (k * k)).toExpr();
      const root = call('sqrt', radicand);
      return coeff.isOne ? root : mul(coeff.toExpr(), root);
    }
    case 'cbrt': {
      const cn = icbrt(r.n);
      const cd = icbrt(r.d);
      return cn !== null && cd !== null ? Rational.of(cn, cd).toExpr() : null;
    }
    default:
      return null;
  }
};

/** Replace every free occurrence of `name` with `replacement`. */
export function substitute(e: Expr, name: string, replacement: Expr): Expr {
  switch (e.kind) {
    case 'num':
      return e;
    case 'ident':
      return e.name === name ? replacement : e;
    case 'unary':
      return { ...e, operand: substitute(e.operand, name, replacement) };
    case 'binary':
      return {
        ...e,
        left: substitute(e.left, name, replacement),
        right: substitute(e.right, name, replacement),
      };
    case 'postfix':
      return { ...e, operand: substitute(e.operand, name, replacement) };
    case 'call':
      return { ...e, args: e.args.map((a) => substitute(a, name, replacement)) };
    case 'relation':
      return { ...e, operands: e.operands.map((o) => substitute(o, name, replacement)) };
    case 'restriction':
      return {
        ...e,
        body: substitute(e.body, name, replacement),
        conditions: e.conditions.map(
          (c) => substitute(c, name, replacement) as typeof c,
        ),
      };
    case 'piecewise':
      return {
        ...e,
        branches: e.branches.map((b) => ({
          condition: substitute(b.condition, name, replacement) as typeof b.condition,
          value: substitute(b.value, name, replacement),
        })),
        fallback: e.fallback ? substitute(e.fallback, name, replacement) : undefined,
      };
    case 'point':
      return {
        ...e,
        x: substitute(e.x, name, replacement),
        y: substitute(e.y, name, replacement),
      };
    case 'list':
      return { ...e, items: e.items.map((i) => substitute(i, name, replacement)) };
  }
}

let keyCache = new WeakMap<Expr, string>();

/** Canonical structural key (memoized per node). */
function sexprKey(e: Expr): string {
  let k = keyCache.get(e);
  if (k === undefined) {
    k = JSON.stringify(strip(e));
    keyCache.set(e, k);
  }
  return k;
}

function strip(e: Expr): unknown {
  switch (e.kind) {
    case 'num':
      return e.value;
    case 'ident':
      return e.name;
    case 'unary':
      return [e.op, strip(e.operand)];
    case 'binary':
      return [e.op, strip(e.left), strip(e.right)];
    case 'postfix':
      return ['!', strip(e.operand)];
    case 'call':
      return [e.callee, ...e.args.map(strip)];
    case 'relation':
      return ['rel', e.ops, ...e.operands.map(strip)];
    case 'restriction':
      return ['where', strip(e.body), ...e.conditions.map(strip)];
    case 'piecewise':
      return [
        'cases',
        ...e.branches.map((b) => [strip(b.condition), strip(b.value)]),
        e.fallback ? strip(e.fallback) : null,
      ];
    case 'point':
      return ['pt', strip(e.x), strip(e.y)];
    case 'list':
      return ['list', ...e.items.map(strip)];
  }
}

/** Rule order matters mildly: folding first keeps collection inputs small. */
const RULES: Rule[] = [foldConstants, identities, callRules, collectProduct, collectSum];

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

function rewriteOnce(e: Expr): Expr {
  // Bottom-up: rebuild children first, then try rules at this node.
  let node = rebuildChildren(e);
  for (const rule of RULES) {
    const out = rule(node);
    if (out !== null && !equal(out, node)) {
      node = out;
    }
  }
  return node;
}

function rebuildChildren(e: Expr): Expr {
  switch (e.kind) {
    case 'num':
    case 'ident':
      return e;
    case 'unary': {
      const operand = rewriteOnce(e.operand);
      return operand === e.operand ? e : { ...e, operand };
    }
    case 'binary': {
      const left = rewriteOnce(e.left);
      const right = rewriteOnce(e.right);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case 'postfix': {
      const operand = rewriteOnce(e.operand);
      return operand === e.operand ? e : { ...e, operand };
    }
    case 'call': {
      const args = e.args.map(rewriteOnce);
      return args.every((a, i) => a === e.args[i]) ? e : { ...e, args };
    }
    case 'relation': {
      const operands = e.operands.map(rewriteOnce);
      return operands.every((o, i) => o === e.operands[i]) ? e : { ...e, operands };
    }
    case 'restriction': {
      const body = rewriteOnce(e.body);
      return body === e.body ? e : { ...e, body };
    }
    case 'piecewise': {
      const branches = e.branches.map((b) => ({ condition: b.condition, value: rewriteOnce(b.value) }));
      const fallback = e.fallback ? rewriteOnce(e.fallback) : undefined;
      return { ...e, branches, fallback };
    }
    case 'point': {
      const x = rewriteOnce(e.x);
      const y = rewriteOnce(e.y);
      return x === e.x && y === e.y ? e : { ...e, x, y };
    }
    case 'list': {
      const items = e.items.map(rewriteOnce);
      return items.every((it, i) => it === e.items[i]) ? e : { ...e, items };
    }
  }
}

const MAX_PASSES = 50;

export function simplify(expr: Expr): Expr {
  let current = expr;
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = rewriteOnce(current);
    if (equal(next, current)) return next;
    current = next;
  }
  return current; // cap reached — safe (every rule preserves value)
}
