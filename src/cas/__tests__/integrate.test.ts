// M5.4 acceptance (CAS_SPEC.md). The headline check: EVERY pattern-table
// entry differentiates back to its integrand (reusing M5.1), compared
// numerically at sample points. Then: integrate() spot checks through every
// strategy (table, linear inner, u-substitution, by parts), honest nulls,
// and definite integration against known closed forms and quadrature.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_PATTERNS, integrate, integrateDefinite, U } from '../integrate.ts';
import { differentiate } from '../differentiate.ts';
import { substitute } from '../simplify.ts';
import { evaluate, makeContext } from '../../core/evaluator.ts';
import { parse } from '../../core/parser.ts';
import type { Expr } from '../../core/ast.ts';

const evalAt = (e: Expr, x: number): number => {
  try {
    return evaluate(e, makeContext({ variables: new Map([['x', x]]) }));
  } catch {
    return NaN;
  }
};

const agree = (a: number, b: number, tol: number): boolean =>
  (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= tol;

/** d/dx(F) ≈ f at several points — the round-trip contract. */
function checkRoundTrip(integrand: Expr, anti: Expr, label: string): void {
  const dAnti = differentiate(anti, 'x');
  let checked = 0;
  for (const x of [-2.7, -1.3, -0.6, 0.35, 0.8, 1.45, 2.6, 3.9]) {
    const expected = evalAt(integrand, x);
    const got = evalAt(dAnti, x);
    if (!Number.isFinite(expected) || Math.abs(expected) > 1e8) continue;
    const tol = 1e-8 * Math.max(1, Math.abs(expected));
    assert.ok(Number.isFinite(got), `${label} @ x=${x}: derivative of anti is ${got}`);
    assert.ok(agree(expected, got, tol), `${label} @ x=${x}: integrand=${expected} d(anti)=${got}`);
    checked++;
  }
  assert.ok(checked >= 3, `${label}: only ${checked} usable sample points`);
}

test('acceptance: every base-table entry differentiates back to its integrand', () => {
  for (const p of BASE_PATTERNS) {
    const integrand = substitute(p.integrand, U, parse('x'));
    const anti = substitute(p.anti, U, parse('x'));
    checkRoundTrip(integrand, anti, p.label);
  }
});

/** integrate() then differentiate back — end-to-end per strategy. */
function checkIntegrate(src: string): void {
  const integrand = parse(src);
  const anti = integrate(integrand, 'x');
  assert.notEqual(anti, null, `${src}: no antiderivative found`);
  checkRoundTrip(integrand, anti!, `∫${src}`);
}

test('polynomials and powers', () => {
  for (const src of ['x^2', 'x^5 - 3x^2 + 7', '1/x', '1/x^2', 'sqrt(x)', 'x^(1/3)', '(2x+1)^5']) {
    checkIntegrate(src);
  }
});

test('linear inner functions through the table', () => {
  for (const src of ['sin(3x)', 'cos(2x + 1)', 'e^(-2x)', 'exp(5x)', '1/(2x + 3)', 'sec(x/2)^2']) {
    checkIntegrate(src);
  }
});

test('trig, hyperbolic, inverse-trig shapes', () => {
  for (const src of [
    'sin(x)',
    'tan(x)',
    'sinh(x)',
    'tanh(x)',
    'sin(x)^2',
    'cos(x)^2',
    '1/(1 + x^2)',
    '1/sqrt(1 - x^2)',
  ]) {
    checkIntegrate(src);
  }
});

test('by-parts patterns', () => {
  for (const src of ['x sin(x)', 'x cos(x)', 'x e^x', 'x ln(x)', 'x^2 e^x', 'ln(x)', 'x^2 sin(x)']) {
    checkIntegrate(src);
  }
});

test('u-substitution: f\'(x)·g(f(x))', () => {
  for (const src of [
    '2x cos(x^2)',
    'x e^(x^2)',
    'cos(x) sin(x)^3',
    'x sqrt(x^2 + 1)',
    'x/(x^2 + 1)',
  ]) {
    checkIntegrate(src);
  }
});

test('linearity: sums and constant multiples', () => {
  for (const src of ['3sin(x) + 2cos(x)', 'x^2/2 - 4e^x + 1', '5/(1 + x^2) - sqrt(x)']) {
    checkIntegrate(src);
  }
});

test('honest null when no pattern matches', () => {
  for (const src of ['e^(x^2)', 'sin(x)/x', 'ln(ln(x))', 'x^x']) {
    assert.equal(integrate(parse(src), 'x'), null, `${src} should be an honest null`);
  }
});

/* ---------------- definite integration ---------------- */

test('definite: known closed-form values', () => {
  assert.ok(Math.abs(integrateDefinite(parse('x^2'), 'x', 0, 3) - 9) < 1e-9);
  assert.ok(Math.abs(integrateDefinite(parse('sin(x)'), 'x', 0, Math.PI) - 2) < 1e-9);
  assert.ok(Math.abs(integrateDefinite(parse('e^x'), 'x', 0, 1) - (Math.E - 1)) < 1e-9);
  assert.ok(Math.abs(integrateDefinite(parse('1/x'), 'x', 1, Math.E) - 1) < 1e-9);
  assert.ok(Math.abs(integrateDefinite(parse('1/(1+x^2)'), 'x', -1, 1) - Math.PI / 2) < 1e-9);
});

test('definite: quadrature fallback where no closed form exists', () => {
  // ∫₀¹ e^(x²) dx ≈ 1.4626517459 (no elementary antiderivative)
  const v = integrateDefinite(parse('e^(x^2)'), 'x', 0, 1);
  assert.ok(Math.abs(v - 1.4626517459071816) < 1e-8, `got ${v}`);
  // ∫₀^π sin(x)/x dx ≈ 1.851937052 (Si(π))
  const si = integrateDefinite(parse('sin(x)/x'), 'x', 1e-12, Math.PI);
  assert.ok(Math.abs(si - 1.8519370519824662) < 1e-6, `got ${si}`);
});

test('definite: reversed and equal bounds', () => {
  assert.equal(integrateDefinite(parse('x'), 'x', 2, 2), 0);
  const forward = integrateDefinite(parse('x^3'), 'x', 0, 2);
  const backward = integrateDefinite(parse('x^3'), 'x', 2, 0);
  assert.ok(Math.abs(forward + backward) < 1e-9);
});

test('definite: divergence reports NaN, not a made-up number', () => {
  const v = integrateDefinite(parse('1/x^2'), 'x', -1, 1); // diverges at 0
  assert.ok(Number.isNaN(v) || !Number.isFinite(v), `got ${v}`);
});
