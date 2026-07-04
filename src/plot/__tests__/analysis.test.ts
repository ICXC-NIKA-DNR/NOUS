// Graph analysis layer (Addition_M6): mathematics decides features, not
// sampled pixels. These tests pin the three headline bugs the redesign fixes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCurves, type AnalyzedCurve } from '../analysis.ts';
import { compile } from '../../core/compile.ts';
import { parse } from '../../core/parser.ts';
import { sexpr } from '../../core/ast.ts';

function curve(id: number, body: string): AnalyzedCurve {
  const ast = parse(body);
  const f = compile(ast, { angleMode: 'radians' });
  return { id, body: ast, f: (x) => f({ x }) };
}

test('BUG: identical curves are coincident, not thousands of intersections', () => {
  const a = curve(1, 'x');
  const b = curve(2, 'x');
  const { features, coincidences } = analyzeCurves([a, b], -10, 10);
  assert.equal(coincidences.length, 1);
  assert.deepEqual(coincidences[0].curveIds, [1, 2]);
  // No intersection dots at all for identical curves.
  assert.equal(features.filter((ftr) => ftr.kind === 'intersection').length, 0);
});

test('BUG: y=x and y=-x intersect EXACTLY at (0,0), not ≈(0,0)', () => {
  const { features } = analyzeCurves([curve(1, 'x'), curve(2, '-x')], -10, 10);
  const hits = features.filter((f) => f.kind === 'intersection');
  assert.equal(hits.length, 1);
  const p = hits[0];
  assert.equal(p.x.exact, true);
  assert.equal(p.y.exact, true);
  assert.equal(p.x.value, 0);
  assert.equal(p.y.value, 0);
});

test('exact quadratic intersection keeps symbolic x = (1±√5)/2', () => {
  const { features } = analyzeCurves([curve(1, 'x^2'), curve(2, 'x + 1')], -10, 10);
  const hits = features.filter((f) => f.kind === 'intersection');
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.x.exact && h.y.exact));
  const phi = (1 + Math.sqrt(5)) / 2;
  assert.ok(hits.some((h) => Math.abs(h.x.value - phi) < 1e-9));
});

test('transcendental intersection falls back to approximate, honestly tagged', () => {
  // sin(x) = cos(x) has no exact CAS form → numeric, approx.
  const { features } = analyzeCurves([curve(1, 'sin(x)'), curve(2, 'cos(x)')], -1, 5);
  const hits = features.filter((f) => f.kind === 'intersection');
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.x.exact === false));
  // π/4 is a solution in range.
  assert.ok(hits.some((h) => Math.abs(h.x.value - Math.PI / 4) < 1e-6));
});

test('roots are exact when the CAS can solve them', () => {
  const { features } = analyzeCurves([curve(1, 'x^2 - 4')], -10, 10);
  const roots = features.filter((f) => f.kind === 'root');
  assert.equal(roots.length, 2);
  assert.ok(roots.every((r) => r.x.exact && r.y.exact && r.y.value === 0));
  assert.deepEqual(roots.map((r) => r.x.value).sort((a, b) => a - b), [-2, 2]);
});

test('extrema of a cubic are found and classified', () => {
  const { features } = analyzeCurves([curve(1, 'x^3 - 3x')], -5, 5);
  const min = features.find((f) => f.kind === 'min');
  const max = features.find((f) => f.kind === 'max');
  assert.ok(min && max);
  // f' = 3x²-3 = 0 → x = ±1; max at -1, min at +1.
  assert.ok(Math.abs(max!.x.value - -1) < 1e-9);
  assert.ok(Math.abs(min!.x.value - 1) < 1e-9);
  assert.ok(max!.x.exact && min!.x.exact);
});

test('exact feature exprs render as clean symbolic forms', () => {
  const { features } = analyzeCurves([curve(1, 'x^2 - 2')], -10, 10);
  const roots = features.filter((f) => f.kind === 'root');
  const forms = roots.map((r) => (r.x.exact ? sexpr(r.x.expr) : 'approx')).sort();
  assert.deepEqual(forms, ['(neg (sqrt 2))', '(sqrt 2)']);
});

test('features respect the visible range', () => {
  // sin(x) roots: only those within [-1, 4] (namely 0 and π).
  const { features } = analyzeCurves([curve(1, 'sin(x)')], -1, 4);
  const roots = features.filter((f) => f.kind === 'root');
  assert.ok(roots.every((r) => r.x.value >= -1 && r.x.value <= 4));
  assert.ok(roots.some((r) => Math.abs(r.x.value) < 1e-9));
  assert.ok(roots.some((r) => Math.abs(r.x.value - Math.PI) < 1e-6));
});
