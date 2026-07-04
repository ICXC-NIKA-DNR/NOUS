// Curve-trace classification + slope (M6 checkpoint Part 2). Includes the
// acceptance-required numeric-vs-CAS slope cross-check on representative
// functions, plus detection of a removable discontinuity and an asymptote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericSlope, traceAt } from '../trace.ts';
import { compile } from '../../core/compile.ts';
import { differentiate } from '../../cas/differentiate.ts';
import { parse } from '../../core/parser.ts';

const fn = (src: string): ((x: number) => number) => {
  const c = compile(parse(src), { angleMode: 'radians' });
  return (x) => c({ x });
};

test('continuous point: value and slope', () => {
  const t = traceAt(fn('sin(x)'), 1, 20);
  assert.equal(t.kind, 'point');
  assert.ok(Math.abs(t.y - Math.sin(1)) < 1e-9);
  assert.ok(Math.abs(t.slope - Math.cos(1)) < 1e-4);
});

test('removable discontinuity: sin(x)/x at 0 is a hole with limit 1', () => {
  const t = traceAt(fn('sin(x)/x'), 0, 20);
  assert.equal(t.kind, 'hole');
  assert.ok(t.limit !== undefined && Math.abs(t.limit - 1) < 1e-3, `limit=${t.limit}`);
});

test('vertical asymptote: 1/x at 0', () => {
  const t = traceAt(fn('1/x'), 0, 20);
  assert.equal(t.kind, 'asymptote');
  assert.ok(Number.isNaN(t.y));
});

test('vertical asymptote: tan(x) at π/2', () => {
  const t = traceAt(fn('tan(x)'), Math.PI / 2, 20);
  assert.equal(t.kind, 'asymptote');
});

test('domain boundary: sqrt(x) at 0 (defined only on the right)', () => {
  const t = traceAt(fn('sqrt(x)'), 0, 20);
  assert.equal(t.kind, 'boundary');
});

test('jump discontinuity: sign(x) at 0', () => {
  const t = traceAt(fn('sign(x)'), 0, 20);
  assert.equal(t.kind, 'jump');
});

test('restricted domain: gap reports as undefined / boundary, never a value', () => {
  // x with x > 2 only: at x = 0 there is nothing.
  const t = traceAt(fn('x {x > 2}'), 0, 20);
  assert.ok(t.kind === 'none' || t.kind === 'boundary');
  assert.ok(Number.isNaN(t.y));
  // Just inside the domain it's a normal point.
  const inside = traceAt(fn('x {x > 2}'), 5, 20);
  assert.equal(inside.kind, 'point');
  assert.ok(Math.abs(inside.y - 5) < 1e-9);
});

/* ---- acceptance: numeric slope agrees with the CAS symbolic derivative ---- */

test('numeric finite-difference slope agrees with CAS derivative', () => {
  const cases: Array<{ src: string; xs: number[] }> = [
    { src: 'x^3 - 2x', xs: [-2, -0.5, 1, 2.5] },
    { src: 'sin(x)', xs: [0.3, 1.2, 2.7] },
    { src: 'exp(x)', xs: [-1, 0, 1.5] },
    { src: 'ln(x)', xs: [0.5, 2, 4] },
    // removable discontinuity — checked away from the hole, where both agree
    { src: 'sin(x)/x', xs: [0.7, 1.5, 3] },
    // asymptote — checked away from the pole
    { src: '1/x', xs: [-2, -0.5, 0.5, 3] },
  ];
  for (const { src, xs } of cases) {
    const f = fn(src);
    const dExpr = differentiate(parse(src), 'x');
    const dCompiled = compile(dExpr, { angleMode: 'radians' });
    for (const x of xs) {
      const numeric = numericSlope(f, x, 20);
      const symbolic = dCompiled({ x });
      assert.ok(
        Math.abs(numeric - symbolic) <= 1e-3 * Math.max(1, Math.abs(symbolic)),
        `${src}' @ ${x}: numeric=${numeric} symbolic=${symbolic}`,
      );
    }
  }
});

test('slope near a domain edge falls back to a one-sided difference', () => {
  // sqrt(x) just inside its domain: derivative 1/(2√x).
  const f = fn('sqrt(x)');
  const s = numericSlope(f, 0.01, 20);
  assert.ok(Math.abs(s - 1 / (2 * Math.sqrt(0.01))) < 0.5, `slope=${s}`);
});
