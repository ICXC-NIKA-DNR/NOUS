// M5.1 acceptance (CAS_SPEC.md): hand-verified derivatives + the numeric
// cross-check — central-difference approximation vs the symbolic result.
// The property test is the real correctness contract: it catches wrong rules
// even when the symbolic output is shaped differently than expected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { differentiate } from '../differentiate.ts';
import { simplify } from '../simplify.ts';
import { BUILTINS, evaluate, makeContext } from '../../core/evaluator.ts';
import { GcalcError } from '../../core/errors.ts';
import { parse } from '../../core/parser.ts';
import { sexpr, type Expr } from '../../core/ast.ts';

const dstr = (src: string, wrt = 'x'): string => sexpr(differentiate(parse(src), wrt));

const evalAt = (e: Expr, x: number): number =>
  evaluate(e, makeContext({ variables: new Map([['x', x], ['a', 1.7], ['b', -0.6]]) }));

/* ---------------- hand-verified shapes ---------------- */

test('polynomial and power rules', () => {
  assert.equal(dstr('x'), '1');
  assert.equal(dstr('7'), '0');
  assert.equal(dstr('pi'), '0');
  assert.equal(dstr('a'), '0'); // non-wrt identifier is a constant
  assert.equal(dstr('x^2'), '(* 2 x)');
  assert.equal(dstr('x^3'), '(* 3 (^ x 2))');
  assert.equal(dstr('3x^2 + 2x + 1'), '(+ (* 6 x) 2)');
  assert.equal(dstr('x^-2'), '(neg (/ 2 (^ x 3)))');
});

test('sum, difference, product, quotient', () => {
  assert.equal(dstr('x + sin(x)'), '(+ (cos x) 1)');
  assert.equal(dstr('x - ln(x)'), '(- 1 (/ 1 x))');
  assert.equal(dstr('x sin(x)'), '(+ (sin x) (* x (cos x)))');
  assert.equal(dstr('sin(x)/x'), '(/ (- (* (cos x) x) (sin x)) (^ x 2))');
});

test('chain rule', () => {
  assert.equal(dstr('sin(x^2)'), '(* 2 (* (cos (^ x 2)) x))');
  assert.equal(dstr('exp(3x)'), '(* 3 (exp (* 3 x)))');
  assert.equal(dstr('ln(sin(x))'), '(/ (cos x) (sin x))');
  assert.equal(dstr('sqrt(x^2 + 1)'), '(/ x (sqrt (+ (^ x 2) 1)))');
});

test('exponentials with constant base or exponent', () => {
  assert.equal(dstr('2^x'), '(* (^ 2 x) (ln 2))');
  assert.equal(dstr('e^x'), '(^ e x)'); // ln(e) folds to 1
  assert.equal(dstr('x^a', 'x'), '(* a (^ x (- a 1)))'); // non-integer constant exponent
});

test('general f^g uses logarithmic differentiation', () => {
  // d/dx x^x = x^x (ln x + 1); shape check via numeric agreement instead of
  // string matching (the exact tree layout is simplify-version dependent).
  const de = differentiate(parse('x^x'), 'x');
  for (const x of [0.5, 1, 2, 3]) {
    const expected = Math.pow(x, x) * (Math.log(x) + 1);
    assert.ok(Math.abs(evalAt(de, x) - expected) < 1e-9, `x=${x}`);
  }
});

test('piecewise and restrictions differentiate structurally', () => {
  assert.equal(dstr('{x < 0: -x, x}'), '(cases ((rel x < 0) (neg 1)) 1)');
  assert.equal(dstr('x^2 {x > 0}'), '(where (* 2 x) (rel x > 0))');
});

test('unsupported forms raise cas-unsupported', () => {
  for (const src of ['x!', 'min(x, 1)', 'mod(x, 2)', 'gcd(x, 2)', '(1, 2)']) {
    try {
      differentiate(parse(src), 'x');
      assert.fail(`${src} should not differentiate`);
    } catch (e) {
      assert.ok(e instanceof GcalcError, `${src}: ${e}`);
      assert.equal(e.info.kind, 'cas-unsupported');
    }
  }
});

/* ---------------- builtin coverage ---------------- */

const UNDIFFERENTIABLE = new Set(['min', 'max', 'mod', 'gcd', 'lcm']);

test('every BUILTINS entry either differentiates or is explicitly rejected', () => {
  for (const name of BUILTINS.keys()) {
    const src = `${name}(x)`;
    if (UNDIFFERENTIABLE.has(name)) {
      assert.throws(() => differentiate(parse(`${name}(x, 2)`), 'x'), GcalcError, name);
      continue;
    }
    const de = differentiate(parse(src), 'x');
    assert.ok(de !== undefined, name);
  }
});

/* ---------------- the numeric cross-check property ---------------- */

/** Domain-aware sample points per outer function. */
const SAMPLE_POINTS: Record<string, number[]> = {
  default: [-2.3, -1.1, -0.4, 0.7, 1.9, 3.2],
  ln: [0.3, 0.9, 1.7, 4.2],
  log: [0.3, 0.9, 1.7, 4.2],
  log2: [0.3, 0.9, 1.7, 4.2],
  sqrt: [0.4, 1.3, 2.6, 5.1],
  asin: [-0.8, -0.3, 0.2, 0.7],
  acos: [-0.8, -0.3, 0.2, 0.7],
  arcsin: [-0.8, -0.3, 0.2, 0.7],
  arccos: [-0.8, -0.3, 0.2, 0.7],
  acosh: [1.4, 2.2, 3.7],
  atanh: [-0.7, -0.2, 0.4, 0.8],
  tan: [-1.2, -0.5, 0.4, 1.1],
  sec: [-1.2, -0.5, 0.4, 1.1],
  csc: [0.4, 1.1, 2.1],
  cot: [0.4, 1.1, 2.1],
};

function centralDiff(e: Expr, x: number): number {
  const h = 1e-6 * Math.max(1, Math.abs(x));
  return (evalAt(e, x + h) - evalAt(e, x - h)) / (2 * h);
}

function checkAgreement(src: string, points?: number[]): void {
  const ast = parse(src);
  const de = differentiate(ast, 'x');
  const xs = points ?? SAMPLE_POINTS.default;
  let checked = 0;
  for (const x of xs) {
    const numeric = centralDiff(ast, x);
    const symbolic = evalAt(de, x);
    if (!Number.isFinite(numeric) || !Number.isFinite(symbolic)) continue;
    if (Math.abs(numeric) > 1e6) continue; // near a pole: central diff is garbage
    const tol = 1e-4 * Math.max(1, Math.abs(numeric));
    assert.ok(
      Math.abs(numeric - symbolic) <= tol,
      `${src} @ x=${x}: numeric=${numeric} symbolic=${symbolic}`,
    );
    checked++;
  }
  assert.ok(checked >= 2, `${src}: too few finite sample points (${checked})`);
}

test('property: symbolic derivative matches central difference — builtins', () => {
  for (const name of BUILTINS.keys()) {
    if (UNDIFFERENTIABLE.has(name)) continue;
    if (['floor', 'ceil', 'round', 'sign', 'abs'].includes(name)) continue; // a.e. rules; steps break central diff
    checkAgreement(`${name}(x)`, SAMPLE_POINTS[name]);
  }
});

test('property: symbolic derivative matches central difference — composites', () => {
  const battery = [
    'x^4 - 3x^2 + 2',
    'x sin(x)',
    'sin(x) cos(x)',
    'sin(x^2 + 1)',
    'exp(-x^2)',
    'exp(x) sin(x)',
    '(x^2 + 1)/(x^2 + 2)',
    'x/(1 + x^2)',
    'sqrt(x^2 + 1)',
    'ln(x^2 + 1)',
    'atan(2x)',
    'sinh(x) cosh(x)',
    'tanh(x^2)',
    '1/(x^2 + 1)',
    '(x + 1)^5',
    'cbrt(x^2 + 1)',
    'a x^2 + b x',
    'sin(a x)',
    '2^(x^2)',
    'x^2 e^x',
    'cos(1/(x^2 + 1))',
    'ln(exp(x) + 1)',
    'sqrt(1 + sqrt(x^2 + 1))',
    '{x < 0: x^2, x^3}',
  ];
  for (const src of battery) checkAgreement(src);
});

test('property: x^x agreement on the positive axis', () => {
  checkAgreement('x^x', [0.4, 0.9, 1.6, 2.4]);
  checkAgreement('x^sin(x)', [0.5, 1.2, 2.1]);
});

test('second derivatives also agree (differentiate twice)', () => {
  for (const src of ['x^4', 'sin(x)', 'exp(-x^2)', 'x ln(x)']) {
    const first = differentiate(parse(src), 'x');
    const second = differentiate(first, 'x');
    const xs = src.includes('ln') ? [0.5, 1.3, 2.2] : [-1.4, -0.3, 0.8, 1.7];
    for (const x of xs) {
      const h = 1e-4 * Math.max(1, Math.abs(x));
      const numeric2 = (evalAt(parse(src), x + h) - 2 * evalAt(parse(src), x) + evalAt(parse(src), x - h)) / (h * h);
      const symbolic2 = evalAt(second, x);
      if (!Number.isFinite(numeric2) || !Number.isFinite(symbolic2)) continue;
      const tol = 1e-2 * Math.max(1, Math.abs(numeric2));
      assert.ok(Math.abs(numeric2 - symbolic2) <= tol, `${src}'' @ ${x}: ${numeric2} vs ${symbolic2}`);
    }
  }
});

/* ---------------- simplify seed sanity (full battery lands in M5.2) --- */

test('simplify folds constants exactly and kills identity noise', () => {
  const s = (src: string): string => sexpr(simplify(parse(src)));
  assert.equal(s('1/3 + 1/6'), '0.5'); // exact: 1/2 is a clean double
  assert.equal(s('1/3 + 1/3'), '(/ 2 3)'); // not a clean double: stays a ratio
  assert.equal(s('0 + x'), 'x');
  assert.equal(s('1 * x'), 'x');
  assert.equal(s('0 * sin(x)'), '0');
  assert.equal(s('x^1'), 'x');
  assert.equal(s('x^0'), '1');
  assert.equal(s('x - x'), '0');
  assert.equal(s('x/x'), '1');
  assert.equal(s('2 * 3 + 4'), '10');
  assert.equal(s('(x^2)^3'), '(^ x 6)');
});
