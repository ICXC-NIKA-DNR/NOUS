// M5.5 wiring acceptance (CAS_SPEC.md): the inline derivative(...) syntax
// and a direct engine call are the SAME code path — asserted by structural
// identity of their outputs. Plus the toSource round-trip contract that CAS
// row insertion depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../engine.ts';
import { sexpr } from '../../core/ast.ts';
import { parse } from '../../core/parser.ts';
import { analyze } from '../../ui/analyze.ts';
import { toSource } from '../../ui/toSource.ts';
import { equal, simplify } from '../simplify.ts';

const NONE: ReadonlySet<string> = new Set();

test('inline derivative(...) and engine.differentiate are identical', () => {
  for (const src of ['x^3', 'sin(x^2)', 'x e^x', '{x < 0: -x, x}', 'sqrt(x^2 + 1)']) {
    const viaEngine = engine.differentiate(parse(src), 'x');
    const viaInline = analyze(`derivative(${src})`, 'radians', NONE);
    assert.equal(viaInline.kind, 'plot', `derivative(${src}) → ${viaInline.kind}`);
    if (viaInline.kind !== 'plot') continue;
    assert.equal(sexpr(viaInline.ast), sexpr(viaEngine), src);
  }
});

test('inline derivative with an explicit variable', () => {
  const direct = engine.differentiate(parse('t^2'), 't');
  assert.equal(sexpr(direct), '(* 2 t)');
  // In the sidebar, the expanded 2t has free variable t → the normal
  // undefined-variable flow (create-slider suggestion) applies. Correct.
  const a = analyze('derivative(t^2, t)', 'radians', NONE);
  assert.equal(a.kind, 'error');
  if (a.kind !== 'error') return;
  assert.equal(a.diagnostic.kind, 'undefined-variable');
  // …and defining t as a slider makes it a horizontal-axis… no: it plots
  // once t is defined (2t is then a constant in x → a horizontal line).
  const withT = analyze('derivative(t^2, t)', 'radians', new Set(['t']));
  assert.equal(withT.kind, 'plot');
});

test('inline integral(...) and engine.integrate are identical', () => {
  for (const src of ['x^2', 'sin(3x)', 'x e^x']) {
    const viaEngine = engine.integrate(parse(src), 'x');
    const viaInline = analyze(`integral(${src})`, 'radians', NONE);
    assert.notEqual(viaEngine, null);
    assert.equal(viaInline.kind, 'plot');
    if (viaInline.kind !== 'plot') continue;
    assert.equal(sexpr(viaInline.ast), sexpr(viaEngine!), src);
  }
});

test('inline integral with no closed form is a structured error', () => {
  const a = analyze('integral(e^(x^2))', 'radians', NONE);
  assert.equal(a.kind, 'error');
  if (a.kind !== 'error') return;
  assert.equal(a.diagnostic.kind, 'cas-unsupported');
});

test('nested inline calls expand', () => {
  // second derivative via nesting
  const a = analyze('derivative(derivative(x^4))', 'radians', NONE);
  assert.equal(a.kind, 'plot');
  if (a.kind !== 'plot') return;
  assert.equal(sexpr(a.ast), '(* 12 (^ x 2))');
});

test('engine.approximate pairs exact results with decimals', () => {
  const solveResult = engine.solve(parse('x^2 = 2') as never, 'x');
  assert.equal(solveResult.kind, 'exact');
  if (solveResult.kind !== 'exact') return;
  const approx = solveResult.solutions.map((s) => engine.approximate(s));
  assert.ok(Math.abs(approx[0] + Math.SQRT2) < 1e-12);
  assert.ok(Math.abs(approx[1] - Math.SQRT2) < 1e-12);
});

/* ---------------- toSource round-trip ---------------- */

test('toSource round-trips through the parser', () => {
  const battery = [
    'x^2 + 2x + 1',
    '-x^2',
    '(-x)^2',
    'sin(x) cos(x)',
    '1/(x^2 + 1)',
    'x^-2',
    '2^(x + 1)',
    'sqrt(x^2 + 1)',
    '{x < 0: -x, x}',
    'x^2 {0 < x < 5}',
    '(3, 4)',
    '[(1, 2), (3, 4)]',
    'abs(x) + pi',
    'x!',
    '0 < x < 5',
    'y = sin(2x)/x',
  ];
  for (const src of battery) {
    const ast = parse(src);
    const printed = toSource(ast);
    const reparsed = parse(printed);
    assert.ok(equal(ast, reparsed), `${src} → ${printed} → ${sexpr(reparsed)}`);
  }
});

test('toSource round-trips CAS outputs specifically', () => {
  for (const src of ['x^5', 'sin(x^2)', 'x ln(x)', '1/x', 'x e^x']) {
    const d = engine.differentiate(parse(src), 'x');
    const printed = toSource(d);
    const reparsed = simplify(parse(printed));
    assert.ok(equal(simplify(d), reparsed), `${src}: d → ${printed}`);
  }
});
