import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPois, findExtrema, findRoots, type PoiCurve } from '../poi.ts';

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

test('acceptance: y = x² and y = x + 1 intersect at (1±√5)/2', () => {
  const parabola: PoiCurve = { id: 1, f: (x) => x * x, fPrime: (x) => 2 * x };
  const line: PoiCurve = { id: 2, f: (x) => x + 1, fPrime: () => 1 };
  const pois = collectPois([parabola, line], -10, 10);
  const hits = pois.filter((p) => p.kind === 'intersection');
  assert.equal(hits.length, 2);
  const phi = (1 + Math.sqrt(5)) / 2;
  const psi = (1 - Math.sqrt(5)) / 2;
  assert.ok(close(hits[0].x, psi, 1e-8), `x0=${hits[0].x}`);
  assert.ok(close(hits[1].x, phi, 1e-8), `x1=${hits[1].x}`);
  // y agrees with both curves at the intersection.
  assert.ok(close(hits[1].y, phi * phi, 1e-6));
  assert.ok(close(hits[1].y, phi + 1, 1e-6));
});

test('collectPois includes roots and respects the cap', () => {
  const sine: PoiCurve = { id: 1, f: Math.sin, fPrime: Math.cos };
  const pois = collectPois([sine], -50, 50, 20);
  assert.equal(pois.length, 20); // capped
  const many = collectPois([sine], -8, 8);
  assert.ok(many.some((p) => p.kind === 'root' && close(p.x, 0, 1e-7)));
  assert.ok(many.some((p) => p.kind === 'max'));
  assert.ok(many.some((p) => p.kind === 'min'));
});
