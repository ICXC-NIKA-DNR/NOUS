// Slider-Anim-M1: playback math in isolation. The rAF loop in App.tsx is a
// thin caller of these — triangle-wave position, phase resume, and the
// per-frame Euler integration step (variable multipliers arrive in M2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advancePhase,
  BASE_CYCLE_MS,
  clampSpeed,
  formatSliderValue,
  MAX_FRAME_DELTA_MS,
  phaseFromValue,
  sliderValueAt,
  trianglePosition,
} from '../sliderAnim.ts';

test('trianglePosition: min→max→min over one cycle', () => {
  assert.equal(trianglePosition(0), 0);
  assert.equal(trianglePosition(0.25), 0.5);
  assert.equal(trianglePosition(0.5), 1);
  assert.equal(trianglePosition(0.75), 0.5);
  assert.ok(Math.abs(trianglePosition(0.999) - 0.002) < 1e-12);
  // Out-of-range phases wrap.
  assert.equal(trianglePosition(1.25), 0.5);
  assert.equal(trianglePosition(-0.75), 0.5);
});

test('sliderValueAt maps the triangle into [min, max]', () => {
  assert.equal(sliderValueAt(0, -10, 10), -10);
  assert.equal(sliderValueAt(0.5, -10, 10), 10);
  assert.equal(sliderValueAt(0.25, 0, 4), 2);
  // Degenerate range holds at min instead of dividing by zero.
  assert.equal(sliderValueAt(0.3, 5, 5), 5);
});

test('phaseFromValue is the ascending-branch inverse of sliderValueAt', () => {
  for (const v of [-10, -3.5, 0, 7.25, 10]) {
    const phase = phaseFromValue(v, -10, 10);
    assert.ok(phase >= 0 && phase <= 0.5);
    assert.ok(Math.abs(sliderValueAt(phase, -10, 10) - v) < 1e-12);
  }
  // Out-of-range values clamp; degenerate range resumes at 0.
  assert.equal(phaseFromValue(99, -10, 10), 0.5);
  assert.equal(phaseFromValue(-99, -10, 10), 0);
  assert.equal(phaseFromValue(3, 5, 5), 0);
});

test('Euler integration: constant multiplier accumulates exactly', () => {
  // 60 frames of 16⅔ ms = 1000 ms at 1× → 1/8 of the 8000 ms cycle.
  let phase = 0;
  for (let i = 0; i < 60; i++) phase = advancePhase(phase, 1000 / 60, () => 1);
  assert.ok(Math.abs(phase - 1000 / BASE_CYCLE_MS) < 1e-9);
  // 2× covers twice the phase in the same time.
  phase = 0;
  for (let i = 0; i < 60; i++) phase = advancePhase(phase, 1000 / 60, () => 2);
  assert.ok(Math.abs(phase - 2000 / BASE_CYCLE_MS) < 1e-9);
});

test('Euler integration: synthetic variable multiplier matches analytic sum', () => {
  // multiplier = 1 in the first half-cycle, 3 in the second. Integrate in
  // small steps and check against the piecewise-analytic expectation.
  const mult = (p: number): number => (p < 0.5 ? 1 : 3);
  let phase = 0;
  let elapsed = 0;
  const step = 5; // ms
  while (phase < 0.5) {
    phase = advancePhase(phase, step, mult);
    elapsed += step;
  }
  // First half at 1×: 0.5 cycles ≈ 4000 ms (within one step of the boundary).
  assert.ok(Math.abs(elapsed - BASE_CYCLE_MS / 2) <= step + 1e-9);
  // Second half at 3× should take one third of the time.
  let elapsed2 = 0;
  while (phase >= 0.5) {
    phase = advancePhase(phase, step, mult);
    elapsed2 += step;
  }
  assert.ok(Math.abs(elapsed2 - BASE_CYCLE_MS / 6) <= step + 1e-9);
});

test('advancePhase wraps at 1.0 back onto the ascending sweep', () => {
  const phase = advancePhase(0.999, 100, () => 4); // + 0.05 → wraps
  assert.ok(phase >= 0 && phase < 0.1);
  // Position is continuous through the wrap: both sides sit near min.
  assert.ok(sliderValueAt(0.999, 0, 1) < 0.01);
  assert.ok(sliderValueAt(phase, 0, 1) < 0.1);
});

test('advancePhase clamps frame-delta spikes and negative deltas', () => {
  // A 5-second stall advances only MAX_FRAME_DELTA_MS worth of phase.
  const spiked = advancePhase(0, 5000, () => 1);
  assert.equal(spiked, MAX_FRAME_DELTA_MS / BASE_CYCLE_MS);
  assert.equal(advancePhase(0.3, -50, () => 1), 0.3);
});

test('advancePhase clamps the multiplier to the legal speed range', () => {
  assert.equal(advancePhase(0, 80, () => 100), (80 / BASE_CYCLE_MS) * 4);
  assert.equal(advancePhase(0, 80, () => 0), (80 / BASE_CYCLE_MS) * 0.25);
  assert.equal(clampSpeed(-3), 0.25);
  assert.equal(clampSpeed(1.5), 1.5);
});

test('formatSliderValue: decimals follow the step', () => {
  assert.equal(formatSliderValue(1.23456, 0.1), '1.2');
  assert.equal(formatSliderValue(1.23456, 0.01), '1.23');
  assert.equal(formatSliderValue(3.7, 1), '4');
  assert.equal(formatSliderValue(-0.4, 1), '0');
});
