import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExtrema, findRoots, type PoiCurve } from '../poi.ts';

const close = (a: number, b: number, tol = 1e-8): boolean => Math.abs(a - b) < tol;

test('roots of a cubic in range', () => {
  const roots = findRoots((x) => x * x * x - x, -5, 5);
  assert.equal(roots.length, 3);
  assert.ok(close(roots[0], -1) && close(roots[1], 0) && close(roots[2], 1));
});

test('asymptote sign flips are not roots', () => {
  assert.deepEqual(findRoots((x) => 1 / x, -3, 3), []);
});

test('roots respect the window', () => {
  const roots = findRoots(Math.sin, -1, 7);
  assert.equal(roots.length, 3); // 0, π, 2π
  assert.ok(close(roots[1], Math.PI, 1e-7));
});

test('extrema with symbolic derivative and classification', () => {
  // f = x³ − x: max at −1/√3, min at 1/√3
  const curve: PoiCurve = {
    id: 1,
    f: (x) => x * x * x - x,
    fPrime: (x) => 3 * x * x - 1,
  };
  const ex = findExtrema(curve, -5, 5);
  assert.equal(ex.length, 2);
  const max = ex.find((e) => e.kind === 'max')!;
  const min = ex.find((e) => e.kind === 'min')!;
  assert.ok(close(max.x, -1 / Math.sqrt(3), 1e-6));
  assert.ok(close(min.x, 1 / Math.sqrt(3), 1e-6));
});

test('extrema fall back to numeric derivative', () => {
  const curve: PoiCurve = { id: 1, f: (x) => Math.sin(x) };
  const ex = findExtrema(curve, 0, 7);
  assert.equal(ex.length, 2); // max at π/2, min at 3π/2
  assert.ok(close(ex[0].x, Math.PI / 2, 1e-5));
  assert.equal(ex[0].kind, 'max');
});

// Intersection detection (incl. the y=x² ∩ y=x+1 acceptance case) now lives
// in the symbolic graph analysis layer — see analysis.test.ts.
