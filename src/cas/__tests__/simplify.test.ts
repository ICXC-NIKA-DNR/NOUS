// M5.2 acceptance (CAS_SPEC.md). The property test is written BEFORE the
// rewrite rules and is the invariant no rule may violate:
//
//   evaluate(simplify(e)) ≈ evaluate(e)  at random points
//
// Directional caveat handling: simplify may EXTEND the domain by continuity
// (x/x is NaN at 0, simplifies to 1) — original-NaN/simplified-finite is
// allowed. The reverse (original finite, simplified NaN/different) is always
// a bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplify } from '../simplify.ts';
import { evaluate, makeContext } from '../../core/evaluator.ts';
import { parse } from '../../core/parser.ts';
import { sexpr, type Expr } from '../../core/ast.ts';

const s = (src: string): string => sexpr(simplify(parse(src)));

const evalAt = (e: Expr, vars: Record<string, number>): number => {
  try {
    return evaluate(e, makeContext({ variables: new Map(Object.entries(vars)) }));
  } catch {
    return NaN;
  }
};

/* ---------------- the invariant property ---------------- */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUNCS = ['sin', 'cos', 'tan', 'exp', 'ln', 'sqrt', 'abs', 'atan', 'sinh', 'cosh', 'cbrt'];
const ATOMS = ['x', 'y', 'x', 'pi', 'e', '2', '3', '1', '0', '0.5', '7', '1/3', '2/5'];

function genExpr(r: () => number, depth: number): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  if (depth <= 0) return pick(ATOMS);
  const roll = r();
  if (roll < 0.42) {
    const op = pick(['+', '-', '*', '/', '^']);
    const right = op === '^' ? pick(['2', '3', '0.5', '-1', 'x']) : genExpr(r, depth - 1);
    return `(${genExpr(r, depth - 1)}) ${op} (${right})`;
  }
  if (roll < 0.62) return `${pick(FUNCS)}(${genExpr(r, depth - 1)})`;
  if (roll < 0.72) return `-(${genExpr(r, depth - 1)})`;
  return genExpr(r, depth - 1);
}

test('property: evaluate(simplify(e)) ≈ evaluate(e) on 500 random expressions', () => {
  const r = rng(0x5eed);
  let comparisons = 0;
  for (let i = 0; i < 500; i++) {
    const src = genExpr(r, 4);
    let ast: Expr;
    try {
      ast = parse(src);
    } catch {
      continue; // generator produced something the grammar rejects — skip
    }
    const simplified = simplify(ast);
    for (let p = 0; p < 6; p++) {
      const vars = { x: (r() - 0.5) * 8, y: (r() - 0.5) * 8 };
      const orig = evalAt(ast, vars);
      const simp = evalAt(simplified, vars);
      if (!Number.isFinite(orig)) continue; // domain extension is allowed
      if (Math.abs(orig) > 1e9) continue; // overflow-adjacent: noise
      assert.ok(
        Number.isFinite(simp),
        `${src} @ ${JSON.stringify(vars)}: original=${orig} but simplified is ${simp}\n  simplified to: ${sexpr(simplified)}`,
      );
      const tol = 1e-7 * Math.max(1, Math.abs(orig));
      assert.ok(
        Math.abs(orig - simp) <= tol,
        `${src} @ ${JSON.stringify(vars)}: ${orig} vs ${simp}\n  simplified to: ${sexpr(simplified)}`,
      );
      comparisons++;
    }
  }
  assert.ok(comparisons > 1200, `only ${comparisons} finite comparisons — generator too degenerate`);
});

/* ---------------- curated known simplifications ---------------- */

test('like terms collect', () => {
  assert.equal(s('2x + 3x'), '(* 5 x)');
  assert.equal(s('x + x'), '(* 2 x)');
  assert.equal(s('2x + 3x - 5x'), '0');
  assert.equal(s('x + 2y + 3x - y'), '(+ (* 4 x) y)');
  assert.equal(s('sin(x) + sin(x)'), '(* 2 (sin x))');
  assert.equal(s('3 + x + 2'), '(+ x 5)'); // constants gather at the end
});

test('powers collect in products', () => {
  assert.equal(s('x x'), '(^ x 2)');
  assert.equal(s('x^2 x^3'), '(^ x 5)');
  assert.equal(s('x^3 / x'), '(^ x 2)');
  assert.equal(s('x / x^2'), '(/ 1 x)');
  assert.equal(s('2x * 3x'), '(* 6 (^ x 2))');
  assert.equal(s('(x y) / x'), 'y');
});

test('pythagorean identity', () => {
  assert.equal(s('sin(x)^2 + cos(x)^2'), '1');
  assert.equal(s('cos(x)^2 + sin(x)^2'), '1');
  assert.equal(s('2sin(x)^2 + 2cos(x)^2'), '2');
  assert.equal(s('sin(x^2 + 1)^2 + cos(x^2 + 1)^2'), '1');
  // different arguments must NOT collapse
  assert.equal(s('sin(x)^2 + cos(y)^2'), '(+ (^ (sin x) 2) (^ (cos y) 2))');
});

test('inverse compositions (a.e. caveats accepted)', () => {
  assert.equal(s('ln(exp(x))'), 'x');
  assert.equal(s('exp(ln(x))'), 'x');
  assert.equal(s('sqrt(x^2)'), '(abs x)');
  assert.equal(s('abs(x)^2'), '(^ x 2)');
});

test('special constant values fold', () => {
  assert.equal(s('sin(0)'), '0');
  assert.equal(s('cos(0)'), '1');
  assert.equal(s('ln(1)'), '0');
  assert.equal(s('exp(0)'), '1');
  assert.equal(s('sqrt(9)'), '3');
  assert.equal(s('sqrt(9/4)'), '1.5'); // 3/2 is a clean double
  assert.equal(s('abs(-7)'), '7');
  assert.equal(s('ln(e)'), '1');
});

test('x/x with the caveat, and division shapes', () => {
  assert.equal(s('x/x'), '1');
  assert.equal(s('(2x)/(4x)'), '0.5');
  assert.equal(s('(x^2 - 1)/(x^2 - 1)'), '1');
});

test('canonical negatives survive', () => {
  assert.equal(s('-x + x'), '0');
  assert.equal(s('0 - -x'), 'x');
  assert.equal(s('-(x - y)'), '(- y x)');
});
