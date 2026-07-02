import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTick, tickStep, tickValues } from '../ticks.ts';

test('tickStep follows the 1-2-5 progression', () => {
  // 20 world units over 800px, min 60px apart → rough 1.5 → step 2
  assert.equal(tickStep(20, 800), 2);
  assert.equal(tickStep(10, 800), 1);
  assert.equal(tickStep(100, 800), 10);
  assert.equal(tickStep(7, 800), 1);
  assert.equal(tickStep(0.05, 800), 0.005);
  assert.equal(tickStep(4e6, 800), 500000);
});

test('tickStep respects the minimum pixel gap', () => {
  for (const range of [0.03, 1, 17, 240, 9e5]) {
    const step = tickStep(range, 800);
    const pxPerTick = (step / range) * 800;
    assert.ok(pxPerTick >= 60, `range ${range}: ${pxPerTick}px`);
    assert.ok(pxPerTick < 300, `range ${range}: ${pxPerTick}px too sparse`);
  }
});

test('tickValues are clean multiples inside the range', () => {
  assert.deepEqual(tickValues(-1, 1, 0.5), [-1, -0.5, 0, 0.5, 1]);
  assert.deepEqual(tickValues(-4.2, 4.2, 2), [-4, -2, 0, 2, 4]);
  // No -0, no float drift.
  const vals = tickValues(-0.3, 0.3, 0.1);
  assert.ok(vals.every((v) => !Object.is(v, -0)));
  assert.ok(vals.includes(0));
});

test('formatTick uses just enough decimals for the step', () => {
  assert.equal(formatTick(2, 2), '2');
  assert.equal(formatTick(-4, 2), '-4');
  assert.equal(formatTick(0.5, 0.5), '0.5');
  assert.equal(formatTick(0.05, 0.005), '0.050');
  assert.equal(formatTick(0, 1), '0');
  assert.equal(formatTick(2500000, 500000), '2.5e+6');
});
