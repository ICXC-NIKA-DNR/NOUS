// Function-definition parsing (M9.5.1): the textual head pre-scan, and the
// lexer/parser changes that make `myfn(9)` parse as a call while a bare
// `abx` stays `a·b·x` (no silent capture — parens required at call sites).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Expr } from '../ast.ts';
import { GcalcError } from '../errors.ts';
import { scanFunctionHead } from '../funcdef.ts';
import { parse } from '../parser.ts';

/* ---- pre-scan ---- */

test('scans well-formed definition heads', () => {
  assert.deepEqual(scanFunctionHead('f(x) = x^2'), { name: 'f', params: ['x'] });
  assert.deepEqual(scanFunctionHead('myfn(a, b) = a b'), { name: 'myfn', params: ['a', 'b'] });
  assert.deepEqual(scanFunctionHead('  g(t)=t'), { name: 'g', params: ['t'] });
});

test('rejects non-definition heads (negative cases from the checkpoint)', () => {
  assert.equal(scanFunctionHead('f (x) = x'), null); // space before paren
  assert.equal(scanFunctionHead('2(x+1) = y'), null); // no name
  assert.equal(scanFunctionHead('y = f(x)'), null); // not head-anchored
  assert.equal(scanFunctionHead('f(x)'), null); // no '='
  assert.equal(scanFunctionHead('f(ab) = a'), null); // multi-letter param
  assert.equal(scanFunctionHead('f(x, x) = x'), null); // duplicate param
  assert.equal(scanFunctionHead('f() = 1'), null); // no params
  assert.equal(scanFunctionHead('f(x) == 1'), null); // comparison, not assign
  assert.equal(scanFunctionHead('f(x) >= 1'), null);
});

/* ---- parse-level call recognition ---- */

const callee = (e: Expr): string | null => (e.kind === 'call' ? e.callee : null);

function mulChainIdents(e: Expr): string[] {
  // Collect identifier names from a left-leaning implicit-product chain.
  const out: string[] = [];
  const walk = (n: Expr): void => {
    if (n.kind === 'binary' && n.op === '*') {
      walk(n.left);
      walk(n.right);
    } else if (n.kind === 'ident') {
      out.push(n.name);
    }
  };
  walk(e);
  return out;
}

test('multi-letter name with parens parses as a user-function call', () => {
  const e = parse('myfn(9)', { userFunctions: ['myfn'] });
  assert.equal(callee(e), 'myfn');
  assert.equal(e.kind === 'call' && e.args.length, 1);
});

test('bare multi-letter run stays a product — no silent capture', () => {
  // `abx` with ab defined: must remain a·b·x, never ab·x or a call.
  const e = parse('abx', { userFunctions: ['ab'] });
  assert.deepEqual(mulChainIdents(e), ['a', 'b', 'x']);
});

test('user function applied mid-run splits the prefix', () => {
  // `a·ab(x)` — leading `a`, then the applied `ab`.
  const e = parse('a ab(x)', { userFunctions: ['ab'] });
  assert.equal(e.kind, 'binary');
  if (e.kind === 'binary') assert.equal(callee(e.right), 'ab');
});

test('user functions require parentheses (single-letter too)', () => {
  assert.throws(() => parse('f 2x', { userFunctions: ['f'] }), (err: unknown) => {
    assert.ok(err instanceof GcalcError);
    assert.equal(err.info.kind, 'missing-argument');
    assert.match(err.info.message, /needs parentheses/);
    return true;
  });
});

test('built-in paren-less application is unaffected', () => {
  const e = parse('sin 2x', { userFunctions: ['f'] });
  assert.equal(callee(e), 'sin');
});

test('implicit multiplication regressions: xy, 2x, pixel', () => {
  assert.deepEqual(mulChainIdents(parse('xy')), ['x', 'y']);
  assert.deepEqual(mulChainIdents(parse('pixel')), ['pi', 'x', 'e', 'l']);
});
