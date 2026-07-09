// User-function inlining + cycle detection (M9.5.2). Inlining must agree with
// the recursive evaluator (the correctness oracle), substitute capture-safely,
// and terminate — cycles are detected up front, never inlined.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, type Env } from '../compile.ts';
import { evaluate, makeContext, type UserFunction } from '../evaluator.ts';
import { detectFunctionCycles, inlineFunctions } from '../inline.ts';
import { parse } from '../parser.ts';

function fn(source: string, names: string[]): UserFunction {
  const rel = parse(source, { userFunctions: names });
  assert.equal(rel.kind, 'relation');
  if (rel.kind !== 'relation' || rel.operands[0].kind !== 'call') throw new Error('bad def');
  return {
    params: rel.operands[0].args.map((a) => (a.kind === 'ident' ? a.name : '?')),
    body: rel.operands[1],
  };
}

test('inlining substitutes params and matches the evaluator', () => {
  const functions = new Map([['f', fn('f(x) = x^2 + 1', ['f'])]]);
  const expr = parse('f(3) + f(x)', { userFunctions: ['f'] });
  const inlined = inlineFunctions(expr, functions);
  // No user calls survive.
  assert.doesNotThrow(() => compile(inlined, { angleMode: 'radians' }));
  const env: Env = { x: 5 };
  const compiled = compile(inlined, { angleMode: 'radians' })(env);
  // Oracle: the recursive evaluator with the function in context.
  const oracle = evaluate(expr, makeContext({ variables: new Map([['x', 5]]), functions }));
  assert.ok(Math.abs(compiled - oracle) < 1e-12);
  assert.equal(compiled, 10 + 26); // 3^2+1 + 5^2+1
});

test('capture-safe simultaneous substitution: swapped args', () => {
  const functions = new Map([['f', fn('f(a, b) = a - b', ['f'])]]);
  const inlined = inlineFunctions(parse('f(b, a)', { userFunctions: ['f'] }), functions);
  // f(b, a) = b - a; at a=2,b=9 → 7.
  const v = compile(inlined, { angleMode: 'radians' })({ a: 2, b: 9 });
  assert.equal(v, 7);
});

test('nested user calls inline fully', () => {
  const functions = new Map([
    ['g', fn('g(x) = x + 1', ['g', 'f'])],
    ['f', fn('f(x) = x^2', ['g', 'f'])],
  ]);
  const inlined = inlineFunctions(parse('f(g(2))', { userFunctions: ['f', 'g'] }), functions);
  assert.equal(compile(inlined, { angleMode: 'radians' })({}), 9);
});

test('detects direct and mutual recursion', () => {
  const direct = new Map([['f', fn('f(x) = f(x - 1)', ['f'])]]);
  assert.deepEqual([...detectFunctionCycles(direct)], ['f']);

  const mutual = new Map([
    ['f', fn('f(x) = g(x)', ['f', 'g'])],
    ['g', fn('g(x) = f(x)', ['f', 'g'])],
  ]);
  assert.deepEqual([...detectFunctionCycles(mutual)].sort(), ['f', 'g']);

  const acyclic = new Map([
    ['f', fn('f(x) = g(x) + 1', ['f', 'g'])],
    ['g', fn('g(x) = x^2', ['f', 'g'])],
  ]);
  assert.equal(detectFunctionCycles(acyclic).size, 0);
});

test('inlining a call to an invalid name raises its structured reason', () => {
  const invalid = new Map([['f', '"f" is recursive.']]);
  assert.throws(
    () => inlineFunctions(parse('f(2)', { userFunctions: ['f'] }), new Map(), invalid),
    /recursive/,
  );
});

test('arity mismatch during inlining errors', () => {
  const functions = new Map([['f', fn('f(x) = x', ['f'])]]);
  assert.throws(() => inlineFunctions(parse('f(1, 2)', { userFunctions: ['f'] }), functions), /takes 1/);
});
