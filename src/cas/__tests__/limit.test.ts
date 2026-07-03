// M5.5 limit battery (CAS_SPEC.md): classic indeterminate forms through
// L'Hôpital, one-sided limits, signed infinities, and honest 'dne'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limit } from '../limit.ts';
import { parse } from '../../core/parser.ts';

const lim = (src: string, a: number | 'inf' | '-inf', side?: 'left' | 'right') =>
  limit(parse(src), 'x', a, side);

const closeTo = (got: unknown, want: number, tol = 1e-4): void => {
  assert.equal(typeof got, 'number', `expected a number, got ${String(got)}`);
  assert.ok(Math.abs((got as number) - want) < tol, `expected ≈${want}, got ${got}`);
};

test('continuous functions: direct substitution', () => {
  closeTo(lim('x^2 + 1', 2), 5, 1e-9);
  closeTo(lim('sin(x)', Math.PI / 2), 1, 1e-9);
  closeTo(lim('{x < 0: -1, 1}', 3), 1, 1e-9); // piecewise away from the seam
});

test('classic 0/0 forms via L\'Hôpital', () => {
  closeTo(lim('sin(x)/x', 0), 1);
  closeTo(lim('(1 - cos(x))/x^2', 0), 0.5);
  closeTo(lim('(e^x - 1)/x', 0), 1);
  closeTo(lim('(x^2 - 1)/(x - 1)', 1), 2);
  closeTo(lim('tan(x)/x', 0), 1);
  closeTo(lim('(x^3 - 8)/(x - 2)', 2), 12);
});

test('∞/∞ and growth-rate forms', () => {
  closeTo(lim('ln(x)/x', 'inf'), 0);
  closeTo(lim('x^2/e^x', 'inf'), 0);
  closeTo(lim('(3x^2 + x)/(x^2 - 7)', 'inf'), 3);
  closeTo(lim('(2x + 1)/(x - 5)', '-inf'), 2);
});

test('limits at infinity without quotients', () => {
  closeTo(lim('1/x', 'inf'), 0);
  closeTo(lim('e^(-x)', 'inf'), 0);
  closeTo(lim('(1 + 1/x)^x', 'inf'), Math.E, 1e-3);
  closeTo(lim('atan(x)', 'inf'), Math.PI / 2);
});

test('one-sided limits and jumps', () => {
  closeTo(lim('abs(x)/x', 0, 'right'), 1, 1e-9);
  closeTo(lim('abs(x)/x', 0, 'left'), -1, 1e-9);
  assert.equal(lim('abs(x)/x', 0), 'dne');
  closeTo(lim('{x < 0: x - 1, x + 1}', 0, 'left'), -1, 1e-3);
  closeTo(lim('{x < 0: x - 1, x + 1}', 0, 'right'), 1, 1e-3);
  assert.equal(lim('{x < 0: x - 1, x + 1}', 0), 'dne');
});

test('signed infinities', () => {
  assert.equal(lim('1/x', 0, 'right'), Infinity);
  assert.equal(lim('1/x', 0, 'left'), -Infinity);
  assert.equal(lim('1/x', 0), 'dne'); // sides disagree
  assert.equal(lim('1/x^2', 0), Infinity); // sides agree
  assert.equal(lim('x^3', 'inf'), Infinity);
  assert.equal(lim('x^3', '-inf'), -Infinity);
  assert.equal(lim('ln(x)', 0, 'right'), -Infinity);
});

test('oscillation is dne; squeezed oscillation converges', () => {
  assert.equal(lim('sin(1/x)', 0), 'dne');
  closeTo(lim('x sin(1/x)', 0), 0, 1e-3);
});

test('the L\'Hôpital recursion cap prevents loops', () => {
  // Repeated L'Hôpital on e^x/e^x-ish forms stabilizes; on pathological
  // inputs the cap forces the numeric fallback rather than looping.
  closeTo(lim('e^x/e^x', 'inf'), 1, 1e-6);
  const r = lim('e^(-1/x^2)/x', 0); // classic pathological 0/0
  assert.ok(r === 0 || (typeof r === 'number' && Math.abs(r) < 1e-3) || r === 'dne', String(r));
});
