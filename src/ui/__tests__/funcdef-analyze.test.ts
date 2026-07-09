// Function-definition analysis + scalar evaluation (M9.5.1). Definition rows
// classify as 'function-definition'; a call in another row evaluates through
// the recursive evaluator once the functions map is wired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, buildFunctionScope, functionDefinition, type Analysis } from '../analyze.ts';
import { parse } from '../../core/parser.ts';

const NONE: ReadonlySet<string> = new Set();

/** The document's function scope from a set of rows (as App builds it). */
const scopeOf = (...sources: string[]) => buildFunctionScope(sources);

test('f(x) = x^2 classifies as a function definition', () => {
  const a = analyze('f(x) = x^2', 'radians', NONE, scopeOf('f(x) = x^2'));
  assert.equal(a.kind, 'function-definition');
  if (a.kind === 'function-definition') {
    assert.equal(a.name, 'f');
    assert.deepEqual(a.params, ['x']);
  }
});

test('multi-letter name and multiple params', () => {
  const a = analyze('myfn(a, b) = a b', 'radians', NONE, scopeOf('myfn(a, b) = a b'));
  assert.equal(a.kind, 'function-definition');
  if (a.kind === 'function-definition') assert.deepEqual(a.params, ['a', 'b']);
});

test('f(9) evaluates to 81 with f defined', () => {
  const a = analyze('f(9)', 'radians', NONE, scopeOf('f(x) = x^2', 'f(9)'));
  assert.equal(a.kind, 'value');
  if (a.kind === 'value') assert.equal(a.value, 81);
});

test('nested user calls evaluate: g(x)=x+1, f(x)=x^2, f(g(2)) = 9', () => {
  const scope = scopeOf('g(x) = x + 1', 'f(x) = x^2', 'f(g(2))');
  const a = analyze('f(g(2))', 'radians', NONE, scope);
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
  const a = analyze('f(1, 2)', 'radians', NONE, scopeOf('f(x) = x^2', 'f(1, 2)'));
  assert.equal(a.kind, 'error');
  if (a.kind === 'error') assert.equal(a.diagnostic.kind, 'wrong-arity');
});

/* ---- M9.5.2: plotting via inlining, cycles, duplicates ---- */

test('y = f(x) plots as an explicit curve via inlining', () => {
  const scope = scopeOf('f(x) = x^2', 'y = f(x)');
  const a = analyze('y = f(x)', 'radians', NONE, scope);
  assert.equal(a.kind, 'plot');
  if (a.kind === 'plot' && a.spec.type === 'explicit') {
    assert.equal(a.spec.f(3, {}), 9);
    assert.equal(a.spec.f(-4, {}), 16);
  }
});

test('a function body may reference a slider; it plots and tracks the dep', () => {
  const scope = scopeOf('f(x) = a x^2', 'y = f(x)');
  const a = analyze('y = f(x)', 'radians', new Set(['a']), scope);
  assert.equal(a.kind, 'plot');
  if (a.kind === 'plot') {
    assert.deepEqual([...a.deps], ['a']);
    if (a.spec.type === 'explicit') assert.equal(a.spec.f(3, { a: 2 }), 18);
  }
});

test('recursive definition and its callers both error (no hang)', () => {
  const scope = scopeOf('f(x) = f(x - 1)', 'f(3)', 'y = f(x)');
  const def = analyze('f(x) = f(x - 1)', 'radians', NONE, scope);
  assert.equal(def.kind, 'error');
  if (def.kind === 'error') assert.match(def.diagnostic.message, /itself|recursion/);
  assert.equal(analyze('f(3)', 'radians', NONE, scope).kind, 'error');
  assert.equal(analyze('y = f(x)', 'radians', NONE, scope).kind, 'error');
});

test('mutual recursion is detected', () => {
  const scope = scopeOf('f(x) = g(x)', 'g(x) = f(x)');
  assert.equal(analyze('f(x) = g(x)', 'radians', NONE, scope).kind, 'error');
});

test('a name defined twice is rejected at both definitions', () => {
  const scope = scopeOf('f(x) = x', 'f(x) = x^2');
  const a = analyze('f(x) = x^2', 'radians', NONE, scope);
  assert.equal(a.kind, 'error');
  if (a.kind === 'error') assert.match(a.diagnostic.message, /more than once/);
});
