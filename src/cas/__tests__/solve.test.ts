// M5.3 acceptance (CAS_SPEC.md): exact linear/quadratic vs hand-verified
// answers; the numeric tier finds all real roots of a battery including
// multi-root functions; 'no-solution-found' is distinguishable from a
// provably-empty exact solution set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factor, solve } from '../solve.ts';
import type { Relation } from '../../core/ast.ts';
import { GcalcError } from '../../core/errors.ts';
import { parse } from '../../core/parser.ts';
import { sexpr } from '../../core/ast.ts';
import { evaluate, makeContext } from '../../core/evaluator.ts';

const eq = (src: string): Relation => {
  const ast = parse(src);
  assert.equal(ast.kind, 'relation', src);
  return ast as Relation;
};

const roots = (src: string, wrt = 'x') => solve(eq(src), wrt);

const valueOf = (e: import('../../core/ast.ts').Expr): number =>
  evaluate(e, makeContext());

/* ---------------- exact: linear ---------------- */

test('linear equations solve exactly', () => {
  const r = roots('2x + 6 = 0');
  assert.equal(r.kind, 'exact');
  if (r.kind !== 'exact') return;
  assert.equal(sexpr(r.solutions[0]), '(neg 3)');
});

test('linear with terms on both sides', () => {
  const r = roots('5x - 3 = 2x + 9');
  assert.equal(r.kind, 'exact');
  if (r.kind !== 'exact') return;
  assert.equal(sexpr(r.solutions[0]), '4');
});

test('linear with symbolic (slider) coefficients', () => {
  const r = roots('a x + b = 0');
  assert.equal(r.kind, 'exact');
  if (r.kind !== 'exact') return;
  assert.equal(sexpr(r.solutions[0]), '(neg (/ b a))');
});

test('exact rational root stays exact: 3x = 1', () => {
  const r = roots('3x = 1');
  assert.equal(r.kind, 'exact');
  if (r.kind !== 'exact') return;
  assert.equal(sexpr(r.solutions[0]), '(/ 1 3)');
});

/* ---------------- exact: quadratic ---------------- */

test('x^2 = 2 returns ±√2 exactly (the CLAUDE.md acceptance case)', () => {
  const r = roots('x^2 = 2');
  assert.equal(r.kind, 'exact');
  if (r.kind !== 'exact') return;
  assert.equal(r.solutions.length, 2);
  assert.equal(sexpr(r.solutions[0]), '(neg (sqrt 2))');
  assert.equal(sexpr(r.solutions[1]), '(sqrt 2)');
});

test('rational-root quadratic: x^2 - 5x + 6 = 0', () => {
  const r = roots('x^2 - 5x + 6 = 0');
  assert.equal(r.kind, 'exact');
  if (r.kind !== 'exact') return;
  assert.deepEqual(r.solutions.map(sexpr), ['2', '3']);
});

test('double root: x^2 - 2x + 1 = 0', () => {
  const r = roots('x^2 - 2x + 1 = 0');
  assert.equal(r.kind, 'exact');
  if (r.kind !== 'exact') return;
  assert.deepEqual(r.solutions.map(sexpr), ['1']);
});

test('negative discriminant: exact-empty with an honest note, not a give-up', () => {
  const r = roots('x^2 + 1 = 0');
  assert.equal(r.kind, 'exact');
  if (r.kind !== 'exact') return;
  assert.equal(r.solutions.length, 0);
  assert.ok(r.note?.includes('complex'));
});

test('quadratic with fractional coefficients: x^2/2 - x/3 - 1/6 = 0', () => {
  const r = roots('x^2/2 - x/3 - 1/6 = 0');
  assert.equal(r.kind, 'exact');
  if (r.kind !== 'exact') return;
  const values = r.solutions.map(valueOf).sort((a, b) => a - b);
  // 3x² − 2x − 1 = 0 → x = −1/3, 1
  assert.ok(Math.abs(values[0] + 1 / 3) < 1e-12);
  assert.ok(Math.abs(values[1] - 1) < 1e-12);
});

test('degenerate cases: all-reals and provably-empty', () => {
  assert.equal(roots('x = x').kind, 'all-reals');
  assert.equal(roots('0 = 0').kind, 'all-reals');
  const empty = roots('x + 1 = x');
  assert.equal(empty.kind, 'exact');
  if (empty.kind !== 'exact') return;
  assert.equal(empty.solutions.length, 0);
});

/* ---------------- numeric tier ---------------- */

function assertNumericRoots(src: string, expected: number[], tol = 1e-8): void {
  const r = roots(src);
  assert.equal(r.kind, 'numeric', `${src} → ${r.kind}${'note' in r && r.note ? ` (${r.note})` : ''}`);
  if (r.kind !== 'numeric') return;
  assert.equal(
    r.solutions.length,
    expected.length,
    `${src}: got roots [${r.solutions.join(', ')}], expected [${expected.join(', ')}]`,
  );
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(r.solutions[i] - expected[i]) < tol,
      `${src}: root ${i} = ${r.solutions[i]}, expected ${expected[i]}`,
    );
  }
}

test('cubic with three real roots', () => {
  // x³ − x = 0 → −1, 0, 1
  assertNumericRoots('x^3 = x', [-1, 0, 1]);
});

test('transcendental: cos(x) = x', () => {
  assertNumericRoots('cos(x) = x', [0.7390851332151607]);
});

test('exp(x) = 3 finds ln 3', () => {
  assertNumericRoots('e^x = 3', [Math.log(3)]);
});

test('many roots: sin(x) = 0 finds every multiple of π in range', () => {
  const r = roots('sin(x) = 0');
  assert.equal(r.kind, 'numeric');
  if (r.kind !== 'numeric') return;
  // 31 multiples of π lie in [−50, 50] (k = −15…15).
  assert.equal(r.solutions.length, 31);
  for (const root of r.solutions) {
    assert.ok(Math.abs(Math.sin(root)) < 1e-9);
    assert.ok(Math.abs(root / Math.PI - Math.round(root / Math.PI)) < 1e-9);
  }
});

test('asymptote sign flips are not roots: 1/x = 0', () => {
  const r = roots('1/x = 0');
  assert.equal(r.kind, 'no-solution-found');
});

test('no real roots numerically: x^4 + 1 = 0 gives up honestly', () => {
  const r = roots('x^4 + 1 = 0');
  // quartic isn't exact-solved; numeric finds no sign change
  assert.equal(r.kind, 'no-solution-found');
});

test('leftover free variables are reported, not guessed', () => {
  const r = roots('sin(k x) = 0.5');
  assert.equal(r.kind, 'no-solution-found');
  if (r.kind !== 'no-solution-found') return;
  assert.ok(r.note?.includes('other variables'));
});

test('inequalities are rejected with a diagnostic', () => {
  assert.throws(() => solve(eq('x < 5'), 'x'), GcalcError);
});

/* ---------------- factoring ---------------- */

test('factor: quadratic with rational roots', () => {
  assert.equal(sexpr(factor(parse('x^2 - 5x + 6'), 'x')), '(* (- x 2) (- x 3))');
  assert.equal(sexpr(factor(parse('x^2 - 1'), 'x')), '(* (+ x 1) (- x 1))'); // ascending roots
});

test('factor: leading coefficient and common x^k', () => {
  assert.equal(sexpr(factor(parse('2x^2 + 2x - 12'), 'x')), '(* 2 (* (+ x 3) (- x 2)))');
  assert.equal(sexpr(factor(parse('x^3 - x'), 'x')), '(* (* x (+ x 1)) (- x 1))');
});

test('factor: difference of squares at higher even degree', () => {
  assert.equal(sexpr(factor(parse('x^4 - 9'), 'x')), '(* (- (^ x 2) 3) (+ (^ x 2) 3))');
});

test('factor declines gracefully', () => {
  assert.equal(sexpr(factor(parse('x^2 + x + 1'), 'x')), '(+ (+ (^ x 2) x) 1)');
  assert.equal(sexpr(factor(parse('sin(x) + 1'), 'x')), '(+ (sin x) 1)');
});
