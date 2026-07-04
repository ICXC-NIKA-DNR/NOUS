// M6 acceptance: regressions on sample tables match known coefficients.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expFit, linearFit, polyFit, type Pt } from '../regress.ts';

const close = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) < tol;

test('linear fit recovers exact coefficients from exact data', () => {
  const pts: Pt[] = [-2, -1, 0, 1, 2, 3].map((x) => ({ x, y: 2 * x + 1 }));
  const fit = linearFit(pts)!;
  assert.ok(close(fit.m, 2));
  assert.ok(close(fit.b, 1));
  assert.ok(close(fit.r2, 1));
});

test('linear fit on noisy data: known least-squares answer', () => {
  // Hand-computable: pts (0,0), (1,2), (2,3) → m = 3/2, b = 1/6.
  const fit = linearFit([
    { x: 0, y: 0 },
    { x: 1, y: 2 },
    { x: 2, y: 3 },
  ])!;
  assert.ok(close(fit.m, 1.5));
  assert.ok(close(fit.b, 1 / 6));
  assert.ok(fit.r2 > 0.9 && fit.r2 < 1);
});

test('quadratic fit recovers exact coefficients', () => {
  const pts: Pt[] = [-3, -1, 0, 2, 4, 5].map((x) => ({ x, y: 3 * x * x - 2 * x + 5 }));
  const fit = polyFit(pts, 2)!;
  assert.ok(close(fit.coeffs[0], 5, 1e-6));
  assert.ok(close(fit.coeffs[1], -2, 1e-6));
  assert.ok(close(fit.coeffs[2], 3, 1e-6));
  assert.ok(close(fit.r2, 1, 1e-9));
});

test('cubic fit recovers exact coefficients', () => {
  const pts: Pt[] = [-2, -1, 0, 1, 2, 3, 4].map((x) => ({ x, y: x ** 3 - x }));
  const fit = polyFit(pts, 3)!;
  assert.ok(close(fit.coeffs[0], 0, 1e-6));
  assert.ok(close(fit.coeffs[1], -1, 1e-6));
  assert.ok(close(fit.coeffs[2], 0, 1e-6));
  assert.ok(close(fit.coeffs[3], 1, 1e-6));
});

test('exponential fit recovers a and b from exact data', () => {
  const pts: Pt[] = [0, 0.5, 1, 1.5, 2].map((x) => ({ x, y: 3 * Math.exp(0.7 * x) }));
  const fit = expFit(pts)!;
  assert.ok(close(fit.a, 3, 1e-9));
  assert.ok(close(fit.b, 0.7, 1e-9));
  assert.ok(close(fit.r2, 1, 1e-9));
});

test('degenerate inputs decline honestly', () => {
  assert.equal(linearFit([{ x: 1, y: 1 }]), null); // one point
  assert.equal(
    linearFit([
      { x: 2, y: 1 },
      { x: 2, y: 5 },
    ]),
    null,
  ); // vertical
  assert.equal(polyFit([{ x: 0, y: 1 }, { x: 1, y: 2 }], 2), null); // underdetermined
  assert.equal(
    expFit([
      { x: 0, y: -1 },
      { x: 1, y: 2 },
    ]),
    null,
  ); // non-positive y
});
