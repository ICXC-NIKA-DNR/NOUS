import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rational } from '../rational.ts';

test('arithmetic is exact: 1/3 + 1/6 = 1/2', () => {
  const r = Rational.of(1n, 3n).add(Rational.of(1n, 6n));
  assert.ok(r.eq(Rational.of(1n, 2n)));
  assert.equal(r.toString(), '1/2');
});

test('normalization: sign lives in the numerator, gcd reduced', () => {
  assert.equal(Rational.of(2n, -4n).toString(), '-1/2');
  assert.equal(Rational.of(-6n, -9n).toString(), '2/3');
  assert.equal(Rational.of(0n, -7n).toString(), '0');
});

test('mul, div, sub, pow', () => {
  const twoThirds = Rational.of(2n, 3n);
  assert.equal(twoThirds.mul(Rational.of(3n, 4n)).toString(), '1/2');
  assert.equal(twoThirds.div(Rational.of(2n)).toString(), '1/3');
  assert.equal(Rational.of(1n).sub(twoThirds).toString(), '1/3');
  assert.equal(twoThirds.pow(2n).toString(), '4/9');
  assert.equal(twoThirds.pow(-2n).toString(), '9/4');
  assert.equal(twoThirds.pow(0n).toString(), '1');
});

test('comparison and predicates', () => {
  assert.equal(Rational.of(1n, 3n).cmp(Rational.of(1n, 2n)), -1);
  assert.equal(Rational.of(5n, 5n).isOne, true);
  assert.equal(Rational.of(0n).isZero, true);
  assert.equal(Rational.of(7n).isInteger, true);
  assert.equal(Rational.of(7n, 2n).isInteger, false);
  assert.equal(Rational.of(-3n).sign, -1);
});

test('fromNumber is exact for doubles', () => {
  assert.equal(Rational.fromNumber(0.5)!.toString(), '1/2');
  assert.equal(Rational.fromNumber(0.75)!.toString(), '3/4');
  assert.equal(Rational.fromNumber(3)!.toString(), '3');
  // 0.1 is not 1/10 in binary — exactness means the TRUE value of the double.
  const tenth = Rational.fromNumber(0.1)!;
  assert.equal(tenth.toNumber(), 0.1);
  assert.notEqual(tenth.toString(), '1/10');
  assert.equal(Rational.fromNumber(Infinity), null);
  assert.equal(Rational.fromNumber(NaN), null);
});

test('toNumber round-trips through toExpr literals', () => {
  const vals = [Rational.of(1n, 2n), Rational.of(-7n, 4n), Rational.of(42n), Rational.of(1n, 3n)];
  for (const r of vals) {
    assert.ok(Math.abs(r.toNumber() - Number(r.n) / Number(r.d)) < 1e-15);
  }
});

test('division by zero throws', () => {
  assert.throws(() => Rational.of(1n).div(Rational.of(0n)));
  assert.throws(() => Rational.of(1n, 0n));
});
