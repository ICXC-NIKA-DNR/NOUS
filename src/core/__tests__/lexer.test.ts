import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lex } from '../lexer.ts';
import { GcalcError } from '../errors.ts';

const texts = (src: string, opts?: Parameters<typeof lex>[1]) =>
  lex(src, opts)
    .filter((t) => t.type !== 'eof')
    .map((t) => t.text);

test('greedy known-name segmentation', () => {
  assert.deepEqual(texts('pixel'), ['pi', 'x', 'e', 'l']);
  assert.deepEqual(texts('xy'), ['x', 'y']);
  assert.deepEqual(texts('costheta'), ['cos', 'theta']);
});

test('user-declared multi-letter names survive as one token', () => {
  assert.deepEqual(texts('speed', { extraNames: ['speed'] }), ['speed']);
  assert.deepEqual(texts('2speed', { extraNames: ['speed'] }), ['2', 'speed']);
});

test('subscripts attach to the final segment only', () => {
  assert.deepEqual(texts('R_oc'), ['R_oc']);
  assert.deepEqual(texts('xy_1'), ['x', 'y_1']);
  assert.throws(() => lex('a_'), GcalcError); // bare trailing underscore is an error
});

test('typo runs before "(" are kept whole and flagged', () => {
  const toks = lex('sni(x)');
  assert.equal(toks[0].text, 'sni');
  assert.equal(toks[0].unknownWord, true);
});

test('unknown runs before "(" with no close match split into letters', () => {
  assert.deepEqual(texts('ab(x)'), ['a', 'b', '(', 'x', ')']);
});

test('spans are correct byte offsets', () => {
  const toks = lex('2 + ab');
  assert.deepEqual(toks.map((t) => [t.text, t.span.start, t.span.end]), [
    ['2', 0, 1],
    ['+', 2, 3],
    ['a', 4, 5],
    ['b', 5, 6],
    ['', 6, 6],
  ]);
});

test('unicode relations and operators normalize', () => {
  assert.deepEqual(texts('x≤y'), ['x', '<=', 'y']);
  assert.deepEqual(texts('x≥y'), ['x', '>=', 'y']);
  assert.deepEqual(texts('x×y'), ['x', '*', 'y']);
});

test('invalid characters and malformed numbers throw structured errors', () => {
  assert.throws(() => lex('2 @ 3'), GcalcError);
  assert.throws(() => lex('1.'), GcalcError);
});
