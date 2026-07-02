// Input syntax spec of record. If a behavior isn't pinned here, it isn't spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../parser.ts';
import { sexpr } from '../ast.ts';
import { GcalcError } from '../errors.ts';

const p = (src: string, opts?: Parameters<typeof parse>[1]) => sexpr(parse(src, opts));

function err(src: string, opts?: Parameters<typeof parse>[1]): GcalcError {
  try {
    parse(src, opts);
  } catch (e) {
    if (e instanceof GcalcError) return e;
    throw e;
  }
  throw new Error(`expected "${src}" to fail`);
}

/* ------------------------------ precedence ------------------------------ */

test('additive and multiplicative precedence', () => {
  assert.equal(p('2+3*4'), '(+ 2 (* 3 4))');
  assert.equal(p('2*3+4'), '(+ (* 2 3) 4)');
  assert.equal(p('2-3-4'), '(- (- 2 3) 4)'); // left-assoc
  assert.equal(p('12/3/2'), '(/ (/ 12 3) 2)'); // left-assoc
});

test('power is right-associative and binds tighter than unary minus', () => {
  assert.equal(p('x^y^z'), '(^ x (^ y z))');
  assert.equal(p('-x^2'), '(neg (^ x 2))');
  assert.equal(p('x^-2'), '(^ x (neg 2))');
  assert.equal(p('(-x)^2'), '(^ (neg x) 2)');
});

test('factorial is postfix, tighter than power base', () => {
  assert.equal(p('3!'), '(! 3)');
  assert.equal(p('3!!'), '(! (! 3))');
  assert.equal(p('2^3!'), '(^ 2 (! 3))');
});

/* ------------------------ implicit multiplication ----------------------- */

test('implicit multiplication basics', () => {
  assert.equal(p('2x'), '(* 2 x)');
  assert.equal(p('2xy'), '(* (* 2 x) y)');
  assert.equal(p('2(x+1)'), '(* 2 (+ x 1))');
  assert.equal(p('(x+1)(x-1)'), '(* (+ x 1) (- x 1))');
  assert.equal(p('x y'), '(* x y)');
});

test('implicit multiplication has the same precedence as explicit', () => {
  assert.equal(p('2x^2'), '(* 2 (^ x 2))');
  assert.equal(p('1/2x'), '(* (/ 1 2) x)'); // (1/2)·x — document, do not "fix"
  assert.equal(p('2x+1'), '(+ (* 2 x) 1)');
});

test('multi-letter runs split into single-letter variables', () => {
  assert.equal(p('xy'), '(* x y)');
  assert.equal(p('abc'), '(* (* a b) c)');
});

test('known multi-letter names survive segmentation', () => {
  assert.equal(p('pix'), '(* pi x)');
  assert.equal(p('2pi'), '(* 2 pi)');
  assert.equal(p('xtheta'), '(* x theta)');
});

test('subscripted identifiers are single variables', () => {
  assert.equal(p('a_1'), 'a_1');
  assert.equal(p('R_oc'), 'R_oc');
  assert.equal(p('2a_1 x'), '(* (* 2 a_1) x)');
  assert.equal(p('a_1x'), 'a_1x'); // subscripts are greedy: use a space or · to multiply
});

/* ----------------------------- numbers ---------------------------------- */

test('number literals', () => {
  assert.equal(p('1.5'), '1.5');
  assert.equal(p('.5'), '0.5');
  assert.equal(p('2e3'), '2000');
  assert.equal(p('1e-3'), '0.001');
  assert.equal(p('2e'), '(* 2 e)'); // lone e is Euler's constant
});

/* ----------------------------- functions -------------------------------- */

test('function calls with parens', () => {
  assert.equal(p('sin(x)'), '(sin x)');
  assert.equal(p('min(1,2,3)'), '(min 1 2 3)');
  assert.equal(p('sin(x)^2'), '(^ (sin x) 2)');
});

test('paren-less application takes an implicit product', () => {
  assert.equal(p('sin x'), '(sin x)');
  assert.equal(p('sin 2x'), '(sin (* 2 x))');
  assert.equal(p('sin x + 1'), '(+ (sin x) 1)');
  assert.equal(p('sin x * 2'), '(* (sin x) 2)'); // explicit * ends the argument
});

test('unknown single letter before parens is multiplication, not a call', () => {
  assert.equal(p('f(x)'), '(* f x)');
});

test('user-declared function names become calls', () => {
  assert.equal(p('f(x)', { functionNames: ['f'] }), '(f x)');
  assert.equal(p('g(1,2)', { functionNames: ['g'] }), '(g 1 2)');
});

test('unicode input', () => {
  assert.equal(p('2πr'), '(* (* 2 pi) r)');
  assert.equal(p('sin θ'), '(sin theta)');
  assert.equal(p('3·x'), '(* 3 x)');
  assert.equal(p('x−1'), '(- x 1)');
});

/* --------------------------- relations ---------------------------------- */

test('relations and chained inequalities', () => {
  assert.equal(p('y=x^2'), '(rel y = (^ x 2))');
  assert.equal(p('0<x<5'), '(rel 0 < x < 5)');
  assert.equal(p('y>=2x+1'), '(rel y >= (+ (* 2 x) 1))');
  assert.equal(p('0<=x<=1'), '(rel 0 <= x <= 1)');
});

/* --------------------------- restrictions ------------------------------- */

test('domain restrictions attach to the whole line', () => {
  assert.equal(p('x^2{0<x<5}'), '(where (^ x 2) (rel 0 < x < 5))');
  assert.equal(p('y=x^2{x>0}'), '(where (rel y = (^ x 2)) (rel x > 0))');
  assert.equal(p('x{x>0,x<5}'), '(where x (rel x > 0) (rel x < 5))');
});

test('restriction body must contain a condition', () => {
  assert.equal(err('x^2{5}').info.kind, 'not-a-condition');
});

/* ------------------------- points, lists, abs --------------------------- */

test('points and lists', () => {
  assert.equal(p('(1,2)'), '(pt 1 2)');
  assert.equal(p('(a, b^2)'), '(pt a (^ b 2))');
  assert.equal(p('[1,2,3]'), '(list 1 2 3)');
  assert.equal(p('[]'), '(list )');
});

test('absolute value bars desugar to abs()', () => {
  assert.equal(p('|x|'), '(abs x)');
  assert.equal(p('|x-1|+2'), '(+ (abs (- x 1)) 2)');
  assert.equal(p('2|x|'), '(* 2 (abs x))');
});

/* ------------------------- errors + suggestions ------------------------- */

test('unmatched open paren suggests inserting ")" at the end', () => {
  const e = err('2*(x+1');
  assert.equal(e.info.kind, 'unmatched-paren');
  assert.deepEqual(e.info.suggestion?.edit, { type: 'insert', at: 6, text: ')' });
});

test('stray close paren suggests removing it', () => {
  const e = err('x+1)');
  assert.equal(e.info.kind, 'extra-paren');
  assert.equal(e.info.suggestion?.edit?.type, 'replace');
});

test('misspelled function suggests the nearest name', () => {
  const e = err('sni(x)');
  assert.equal(e.info.kind, 'unknown-function');
  assert.equal(e.info.suggestion?.label, 'Did you mean sin?');
  assert.deepEqual(e.info.suggestion?.edit, { type: 'replace', span: { start: 0, end: 3 }, text: 'sin' });
});

test('misspelled longer function name', () => {
  const e = err('flor(x)');
  assert.equal(e.info.kind, 'unknown-function');
  assert.equal(e.info.suggestion?.label, 'Did you mean floor?');
});

test('function without an argument suggests inserting "("', () => {
  const e = err('sin');
  assert.equal(e.info.kind, 'missing-argument');
  assert.deepEqual(e.info.suggestion?.edit, { type: 'insert', at: 3, text: '(' });
});

test('empty input', () => {
  assert.equal(err('').info.kind, 'empty-input');
  assert.equal(err('   ').info.kind, 'empty-input');
});

test('trailing operator', () => {
  assert.equal(err('2+').info.kind, 'unexpected-end');
});

test('unterminated absolute value', () => {
  assert.equal(err('|x').info.kind, 'unterminated-abs');
});

test('unclosed restriction brace', () => {
  const e = err('x{x>0');
  assert.equal(e.info.kind, 'unmatched-paren');
  assert.deepEqual(e.info.suggestion?.edit, { type: 'insert', at: 5, text: '}' });
});
