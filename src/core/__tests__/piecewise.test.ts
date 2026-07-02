// M4 parser extension: {cond: value, cond: value, fallback} piecewise.
// Trailing-brace restrictions must keep working unchanged alongside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sexpr } from '../ast.ts';
import { compile } from '../compile.ts';
import { evaluate, makeContext } from '../evaluator.ts';
import { GcalcError } from '../errors.ts';
import { parse } from '../parser.ts';

const ev = (src: string, vars: Record<string, number> = {}): number =>
  evaluate(parse(src), makeContext({ variables: new Map(Object.entries(vars)) }));

test('piecewise parses branches and fallback', () => {
  assert.equal(
    sexpr(parse('{x < 0: -x, x}')),
    '(cases ((rel x < 0) (neg x)) x)',
  );
  assert.equal(
    sexpr(parse('{x < 0: -1, x > 0: 1, 0}')),
    '(cases ((rel x < 0) (neg 1)) ((rel x > 0) 1) 0)',
  );
});

test('condition-only shorthand means 1-where-true', () => {
  assert.equal(sexpr(parse('{x > 0}')), '(cases ((rel x > 0) 1))');
  assert.equal(ev('{x > 0}', { x: 5 }), 1);
  assert.ok(Number.isNaN(ev('{x > 0}', { x: -5 })));
});

test('piecewise evaluates in order with fallback', () => {
  assert.equal(ev('{x < 0: -x, x}', { x: -3 }), 3);
  assert.equal(ev('{x < 0: -x, x}', { x: 4 }), 4);
  assert.equal(ev('{x < 0: -1, x > 0: 1, 0}', { x: 0 }), 0);
});

test('no fallback and no true branch is a NaN gap', () => {
  assert.ok(Number.isNaN(ev('{x < 0: -x}', { x: 2 })));
});

test('chained conditions work inside piecewise', () => {
  assert.equal(ev('{0 < x < 5: 10, -10}', { x: 3 }), 10);
  assert.equal(ev('{0 < x < 5: 10, -10}', { x: 7 }), -10);
});

test('piecewise nests as a value expression', () => {
  assert.equal(ev('2 * {x < 0: -1, 1} + 5', { x: -9 }), 3);
  assert.equal(ev('{x < 0: {x < -5: 2, 1}, 0}', { x: -7 }), 2);
});

test('compile agrees with the evaluator on piecewise', () => {
  const srcs = ['{x < 0: -x, x}', '{0 < x < 2: sin(x), x >= 2: 1, -1}', '{x > 0}'];
  for (const src of srcs) {
    const ast = parse(src);
    const f = compile(ast, { angleMode: 'radians' });
    for (const x of [-3, -0.5, 0, 0.5, 1.5, 2, 3]) {
      const oracle = evaluate(ast, makeContext({ variables: new Map([['x', x]]) }));
      const got = f({ x });
      assert.ok(
        (Number.isNaN(oracle) && Number.isNaN(got)) || Math.abs(oracle - got) < 1e-12,
        `${src} @ x=${x}: ${oracle} vs ${got}`,
      );
    }
  }
});

test('trailing restriction still parses as restriction, not piecewise', () => {
  assert.equal(sexpr(parse('x^2 {0 < x < 5}')), '(where (^ x 2) (rel 0 < x < 5))');
  // ...and a piecewise line can still take a trailing restriction.
  assert.equal(
    sexpr(parse('{x < 0: -x, x} {x > -9}')),
    '(where (cases ((rel x < 0) (neg x)) x) (rel x > (neg 9)))',
  );
});

test('fallback must be last', () => {
  assert.throws(() => parse('{5, x < 0: -x}'), GcalcError);
});

test('unclosed piecewise suggests the closing brace', () => {
  try {
    parse('{x < 0: -x');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof GcalcError);
    assert.equal(e.info.kind, 'unmatched-paren');
    assert.deepEqual(e.info.suggestion?.edit, { type: 'insert', at: 10, text: '}' });
  }
});
