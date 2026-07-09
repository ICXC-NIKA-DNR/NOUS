// Autocomplete engine (M9.1). The milestone accept: typing `si` offers
// `sin(`, accepting places the caret inside the parens, defined names from
// the document are offered, and nothing is offered where completion would be
// noise (mid-word carets, digit runs, no matches).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCompletion, complete } from '../autocomplete.ts';

const names = (r: ReturnType<typeof complete>): string[] => r?.items.map((i) => i.name) ?? [];

test('`si` offers sin( first, and accepting places the caret inside', () => {
  const src = 'y = si';
  const r = complete(src, src.length);
  assert.ok(r, 'expected completions');
  assert.equal(r.items[0].name, 'sin');
  assert.equal(r.items[0].label, 'sin(');
  const applied = applyCompletion(src, r, r.items[0]);
  assert.equal(applied.source, 'y = sin(');
  assert.equal(applied.caret, 'y = sin('.length); // inside the parens
});

test('prefix matches rank before substring matches', () => {
  const r = complete('ta', 2);
  const ns = names(r);
  assert.ok(ns.indexOf('tan') < ns.indexOf('atan'), `expected tan before atan in ${ns}`);
  assert.ok(ns.includes('tau'));
});

test('user-defined function names complete with a paren (M9.5)', () => {
  const src = 'y = myf';
  const r = complete(src, src.length, [], ['myfn']);
  assert.ok(r);
  assert.equal(r.items[0].name, 'myfn');
  assert.equal(r.items[0].label, 'myfn(');
  const applied = applyCompletion(src, r, r.items[0]);
  assert.equal(applied.source, 'y = myfn(');
  assert.equal(applied.caret, 'y = myfn('.length); // caret inside the parens
});

test('a single-letter f defined as a function autocompletes f(', () => {
  const r = complete('f', 1, [], ['f']);
  assert.equal(r?.items[0].label, 'f(');
});

test('defined document names are offered and win dedupe', () => {
  const r = complete('y = a', 5, ['aa', 'abc']);
  const ns = names(r);
  assert.ok(ns.includes('aa') && ns.includes('abc'));
  assert.equal(r?.items.find((i) => i.name === 'aa')?.kind, 'defined');
  // Defined names insert as plain names (no paren).
  assert.equal(r?.items.find((i) => i.name === 'aa')?.insert, 'aa');
});

test('implicit multiplication: prefix after digits completes the word part', () => {
  const src = 'y = 2si';
  const r = complete(src, src.length);
  assert.ok(r);
  assert.equal(r.from, 'y = 2'.length);
  assert.equal(applyCompletion(src, r, r.items[0]).source, 'y = 2sin(');
});

test('exact function name still offers the paren template', () => {
  const r = complete('sin', 3);
  assert.equal(r?.items[0].label, 'sin(');
});

test('exact constant match offers nothing (nothing to add)', () => {
  assert.equal(complete('pi', 2), null);
});

test('no completions mid-word, on digits, or without a prefix', () => {
  assert.equal(complete('sin', 1), null); // caret inside "sin"
  assert.equal(complete('y = 12', 6), null);
  assert.equal(complete('y = ', 4), null);
  assert.equal(complete('', 0), null);
});

test('no match → null, and results are capped', () => {
  assert.equal(complete('zzz', 3), null);
  const r = complete('a', 1);
  assert.ok(r && r.items.length <= 8);
});
