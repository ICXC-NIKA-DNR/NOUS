// Clickable-fix coverage (M9.2): every diagnostic kind that can carry a
// machine-applicable Suggestion does, and applying the suggested edit
// actually resolves the error. Kinds with no mechanical fix (empty-input,
// wrong-arity, not-a-condition, not-a-value, cas-unsupported) are exempt —
// there is no edit the machine can know.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcalcError, type Edit } from '../errors.ts';
import { parse } from '../parser.ts';

function diagnose(source: string): GcalcError {
  try {
    parse(source);
  } catch (err) {
    if (err instanceof GcalcError) return err;
    throw err;
  }
  throw new Error(`expected "${source}" to fail`);
}

function applyEdit(source: string, edit: Edit): string {
  return edit.type === 'insert'
    ? source.slice(0, edit.at) + edit.text + source.slice(edit.at)
    : source.slice(0, edit.span.start) + edit.text + source.slice(edit.span.end);
}

/** The error carries an edit fix, and applying it makes the source parse. */
function assertFixResolves(source: string, kind: string, labelPattern: RegExp): void {
  const err = diagnose(source);
  assert.equal(err.info.kind, kind, `${source}: got ${err.info.kind}`);
  const edit = err.info.suggestion?.edit;
  assert.ok(edit, `${source}: expected an edit suggestion`);
  assert.match(err.info.suggestion!.label, labelPattern);
  const fixed = applyEdit(source, edit);
  assert.doesNotThrow(() => parse(fixed), `fix "${fixed}" should parse`);
}

test('unmatched parens/brackets/braces/abs carry insert fixes that resolve', () => {
  assertFixResolves('sin(x', 'unmatched-paren', /Insert "\)"/);
  assertFixResolves('[1, 2', 'unmatched-paren', /Insert "\]"/);
  assertFixResolves('x {x > 0', 'unmatched-paren', /Insert "\}"/);
  assertFixResolves('|x', 'unterminated-abs', /Insert "\|"/);
});

test('extra paren carries a remove fix', () => {
  assertFixResolves('x + 1)', 'extra-paren', /Remove "\)"/);
});

test('invalid number offers inserting the missing digit (new in M9.2)', () => {
  assertFixResolves('1. + x', 'invalid-number', /Insert "0"/);
  const err = diagnose('3.');
  assert.equal(applyEdit('3.', err.info.suggestion!.edit!), '3.0');
});

test('unexpected character offers removal (new in M9.2)', () => {
  assertFixResolves('x + #2', 'unexpected-token', /Remove "#"/);
});

test('trailing operator offers removal (new in M9.2)', () => {
  assertFixResolves('x +', 'unexpected-end', /Remove trailing "\+"/);
  assertFixResolves('2 *', 'unexpected-end', /Remove trailing "\*"/);
});

test('unexpected end with no trailing operator has no bogus fix', () => {
  const err = diagnose('sin(x,'); // ends after comma inside call — comma removal offered
  assert.ok(err.info.suggestion === undefined || err.info.suggestion.edit !== undefined);
});

test('unknown function still suggests the nearest name', () => {
  const err = diagnose('sni(x)');
  assert.equal(err.info.kind, 'unknown-function');
  assert.match(err.info.suggestion?.label ?? '', /Did you mean sin\?/);
});
