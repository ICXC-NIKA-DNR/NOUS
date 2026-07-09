// Function-definition analysis + scalar evaluation (M9.5.1). Definition rows
// classify as 'function-definition'; a call in another row evaluates through
// the recursive evaluator once the functions map is wired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze,
  functionDefinition,
  parseUserFunction,
  type Analysis,
} from '../analyze.ts';
import type { UserFunction } from '../../core/evaluator.ts';
import { scanFunctionHead } from '../../core/funcdef.ts';
import { parse } from '../../core/parser.ts';

const NONE: ReadonlySet<string> = new Set();

/** Build the functions map the way App's pass-1b does: names textually first
 * (head pre-scan), then bodies parsed with those names known. */
function functionsOf(...sources: string[]): Map<string, UserFunction> {
  const names = new Set<string>();
  for (const s of sources) {
    const head = scanFunctionHead(s);
    if (head) names.add(head.name);
  }
  const map = new Map<string, UserFunction>();
  for (const s of sources) {
    const parsed = parseUserFunction(s, names);
    if (parsed && !map.has(parsed.name)) map.set(parsed.name, { params: parsed.params, body: parsed.body });
  }
  return map;
}

test('f(x) = x^2 classifies as a function definition', () => {
  const a = analyze('f(x) = x^2', 'radians', NONE, functionsOf('f(x) = x^2'));
  assert.equal(a.kind, 'function-definition');
  if (a.kind === 'function-definition') {
    assert.equal(a.name, 'f');
    assert.deepEqual(a.params, ['x']);
  }
});

test('multi-letter name and multiple params', () => {
  const a = analyze('myfn(a, b) = a b', 'radians', NONE, functionsOf('myfn(a, b) = a b'));
  assert.equal(a.kind, 'function-definition');
  if (a.kind === 'function-definition') assert.deepEqual(a.params, ['a', 'b']);
});

test('f(9) evaluates to 81 with f defined', () => {
  const fns = functionsOf('f(x) = x^2');
  const a = analyze('f(9)', 'radians', NONE, fns);
  assert.equal(a.kind, 'value');
  if (a.kind === 'value') assert.equal(a.value, 81);
});

test('nested user calls evaluate: g(x)=x+1, f(x)=x^2, f(g(2)) = 9', () => {
  const fns = functionsOf('g(x) = x + 1', 'f(x) = x^2');
  const a = analyze('f(g(2))', 'radians', NONE, fns);
  assert.equal(a.kind === 'value' && a.value, 9);
});

test('reserved-name head is NOT a definition — stays an implicit equation', () => {
  // sin(x) = 1: no regression; classifies as a plot, not a function def.
  const a: Analysis = analyze('sin(x) = 1', 'radians', NONE);
  assert.equal(a.kind, 'plot');
});

test('functionDefinition rejects y = f(x) (that is an explicit plot)', () => {
  const rel = parse('y = f(x)', { userFunctions: ['f'] });
  assert.equal(rel.kind, 'relation');
  if (rel.kind === 'relation') assert.equal(functionDefinition(rel), null);
});

test('wrong-arity user call errors', () => {
  const fns = functionsOf('f(x) = x^2');
  const a = analyze('f(1, 2)', 'radians', NONE, fns);
  assert.equal(a.kind, 'error');
  if (a.kind === 'error') assert.equal(a.diagnostic.kind, 'wrong-arity');
});

test('recursive definition fails safe (no crash) pending M9.5.2 cycle detection', () => {
  const fns = functionsOf('f(x) = f(x - 1)');
  const a = analyze('f(3)', 'radians', NONE, fns);
  assert.equal(a.kind, 'error');
});
