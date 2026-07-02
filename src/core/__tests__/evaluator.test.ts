import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../parser.ts';
import {
  evaluate,
  evaluateCondition,
  makeContext,
  type EvalContext,
  type UserFunction,
} from '../evaluator.ts';
import { GcalcError } from '../errors.ts';
import type { Relation } from '../ast.ts';

function n(src: string, vars: Record<string, number> = {}, ctx?: Partial<EvalContext>): number {
  const functionNames = ctx?.functions ? [...ctx.functions.keys()] : [];
  return evaluate(
    parse(src, { functionNames }),
    makeContext({ ...ctx, variables: new Map(Object.entries(vars)) }),
  );
}

function evalErr(src: string, vars: Record<string, number> = {}): GcalcError {
  try {
    n(src, vars);
  } catch (e) {
    if (e instanceof GcalcError) return e;
    throw e;
  }
  throw new Error(`expected "${src}" to fail`);
}

const close = (a: number, b: number, eps = 1e-12) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

/* ------------------------------ arithmetic ------------------------------ */

test('basic arithmetic', () => {
  assert.equal(n('2+3*4'), 14);
  assert.equal(n('(2+3)*4'), 20);
  assert.equal(n('2^3^2'), 512); // right-assoc
  assert.equal(n('-3^2'), -9);
  assert.equal(n('x^-2', { x: 2 }), 0.25);
  assert.equal(n('7/2'), 3.5);
  assert.equal(n('5!'), 120);
  assert.equal(n('0!'), 1);
});

test('implicit multiplication evaluates', () => {
  assert.equal(n('2x', { x: 5 }), 10);
  assert.equal(n('2xy', { x: 3, y: 4 }), 24);
  assert.equal(n('1/2x', { x: 4 }), 2); // (1/2)·x
});

test('IEEE edge behavior is preserved for the plotter', () => {
  assert.equal(n('1/x', { x: 0 }), Infinity);
  assert.ok(Number.isNaN(n('0/0')));
  assert.ok(Number.isNaN(n('sqrt(0-1)')));
  assert.ok(Number.isNaN(n('2.5!'))); // gamma extension is future work
});

test('constants', () => {
  close(n('pi'), Math.PI);
  close(n('tau'), 2 * Math.PI);
  close(n('e^2'), Math.E ** 2);
  close(n('phi^2-phi-1'), 0); // for James
  close(n('2πr', { r: 3 }), 6 * Math.PI);
});

/* ------------------------------ functions ------------------------------- */

test('builtins', () => {
  close(n('sin(pi/2)'), 1);
  close(n('sqrt(2)^2'), 2, 1e-9);
  close(n('ln(e)'), 1);
  assert.equal(n('log(1000)'), 3);
  assert.equal(n('min(3,1,2)'), 1);
  assert.equal(n('max(3,1,2)'), 3);
  assert.equal(n('mod(0-7, 3)'), 2); // mathematician's mod
  assert.equal(n('gcd(12,18)'), 6);
  assert.equal(n('lcm(4,6)'), 12);
  assert.equal(n('abs(0-5)'), 5);
  assert.equal(n('|3-8|'), 5);
});

test('paren-less application evaluates like Desmos', () => {
  close(n('sin pi'), 0, 1e-12);
  close(n('sin 2x', { x: Math.PI / 4 }), 1);
  close(n('sin x + 1', { x: 0 }), 1);
});

test('user-defined functions, including shadowed variables', () => {
  const f: UserFunction = { params: ['x'], body: parse('x^2+1') };
  const ctx: Partial<EvalContext> = { functions: new Map([['f', f]]) };
  assert.equal(n('f(3)', {}, ctx), 10);
  assert.equal(n('f(x)', { x: 5 }, ctx), 26); // param binds over outer x
  assert.equal(n('2f(2)', { }, ctx), 10);
});

/* ------------------------------ angle mode ------------------------------ */

test('degrees mode converts trig inputs and inverse-trig outputs', () => {
  close(n('sin(90)', {}, { angleMode: 'degrees' }), 1);
  close(n('cos(180)', {}, { angleMode: 'degrees' }), -1);
  close(n('tan(45)', {}, { angleMode: 'degrees' }), 1);
  close(n('asin(1)', {}, { angleMode: 'degrees' }), 90);
  close(n('arctan(1)', {}, { angleMode: 'degrees' }), 45);
});

test('radians is the default and hyperbolics ignore angle mode', () => {
  close(n('sin(pi/2)'), 1);
  close(n('sinh(1)', {}, { angleMode: 'degrees' }), Math.sinh(1));
  close(n('tanh(2)', {}, { angleMode: 'degrees' }), Math.tanh(2));
});

/* --------------------------- restrictions ------------------------------- */

test('restrictions gate to NaN (a plot gap) outside the domain', () => {
  assert.equal(n('x^2{0<x<5}', { x: 2 }), 4);
  assert.ok(Number.isNaN(n('x^2{0<x<5}', { x: 7 })));
  assert.equal(n('x{x>0,x<5}', { x: 3 }), 3);
  assert.ok(Number.isNaN(n('x{x>0,x<5}', { x: 6 })));
});

test('chained condition evaluation', () => {
  const rel = parse('0<x<5') as Relation;
  assert.equal(evaluateCondition(rel, makeContext({ variables: new Map([['x', 3]]) })), true);
  assert.equal(evaluateCondition(rel, makeContext({ variables: new Map([['x', 9]]) })), false);
  assert.equal(evaluateCondition(rel, makeContext({ variables: new Map([['x', 0]]) })), false);
});

/* ------------------------- errors + suggestions ------------------------- */

test('undefined variable carries a create-slider suggestion', () => {
  const e = evalErr('a x^2', { x: 1 });
  assert.equal(e.info.kind, 'undefined-variable');
  assert.equal(e.info.suggestion?.action, 'create-slider');
  assert.equal(e.info.suggestion?.name, 'a');
});

test('wrong arity is a structured error', () => {
  assert.equal(evalErr('sin(1,2)').info.kind, 'wrong-arity');
  assert.equal(evalErr('mod(5)').info.kind, 'wrong-arity');
});

test('relations, points, and lists are not scalar values', () => {
  assert.equal(evalErr('y=x', { x: 1, y: 1 }).info.kind, 'not-a-value');
  assert.equal(evalErr('(1,2)').info.kind, 'not-a-value');
  assert.equal(evalErr('[1,2]').info.kind, 'not-a-value');
});
